/**
 * Wyszukiwanie po krawedziach dla grafu w formacie 2: zakazy skretu, kary za skret, zawracanie. Czyste funkcje na tablicach
 * typowanych, bez importow. Ten sam plik jest we wtyczce i w automacie danych (bramki licza trase jak wtyczka), wiec
 * zmiana w jednym miejscu = ta sama zmiana w drugim.
 *
 * Stan to krawedz, nie wezel: koszt skretu i zakaz zaleza od tego, skad sie przyjechalo. `at[e]` to koszt wjazdu na
 * poczatek krawedzi `e` razem ze skretem w nia, wiec cel w ulamku `f` kosztuje `at[e] + W[e] * f`. Start w polowie
 * krawedzi jest osobnym wpisem kopca i nie wpisuje kosztu do `at`: inaczej cel za plecami na tej samej krawedzi
 * wygladalby na osiagalny bez objazdu.
 */

// Stawki `process_turn` z car.lua OSRM (commit 746c97c), ruch prawostronny, bez `oncoming_turn_penalty` (z nim czas
// odstaje od wzorca bardziej: pomiar na 40 parach).
const TURN_PENALTY_S = 7.5;
const TURN_BIAS = 1.075;
const U_TURN_S = 20;
// Krotszy odcinek nie miesci zawracajacego auta, a w OSM sa kikuty po 2-5 m (wjazd do bramy), ktorymi trasa obchodzila zakaz.
const MIN_U_TURN_M = 10;
const TURN_COST = new Float32Array(361);
for (let i = 0; i <= 360; i += 1) {
  const a = (i - 180) / 180;
  TURN_COST[i] = a >= 0
    ? TURN_PENALTY_S / (1 + Math.exp(-((13 / TURN_BIAS) * a - 6.5 * TURN_BIAS)))
    : TURN_PENALTY_S / (1 + Math.exp(-(13 * TURN_BIAS * -a - 6.5 / TURN_BIAS)));
}

/**
 * Uzupelnia graf CSR (`off`, `to`, `W`, `Ln`, `T`) o dane skretow. `triples` = zakazy `[u, v, w, ...]`: jadac u -> v nie
 * wolno dalej v -> w. Miedzy dwoma wezlami jest najwyzej jedna krawedz w danym kierunku, wiec trojka jest jednoznaczna.
 * `rev[e]` = ta sama droga w druga strone (rowna dlugosc), inaczej -1: dwie jezdnie miedzy tymi samymi wezlami maja rozne
 * dlugosci i przejazd miedzy nimi nie jest zawracaniem. Trojka bez krawedzi w grafie jest pomijana (`banCount` jej nie liczy).
 */
export function addTurns(g, triples) {
  const { n, m, off, to, lat, lon, Ln } = g;
  const edge = (u, v) => {
    for (let e = off[u]; e < off[u + 1]; e += 1) if (to[e] === v) return e;
    return -1;
  };
  const rev = new Int32Array(m).fill(-1);
  const bearing = new Int16Array(m);
  const roads = new Uint8Array(n);
  const twoWay = new Uint8Array(n);
  const inc = (arr, i) => {
    if (arr[i] < 255) arr[i] += 1;
  };
  const cos = Math.cos((((lat[0] + lat[n - 1]) / 2) * Math.PI) / 180);
  for (let u = 0; u < n; u += 1) {
    for (let e = off[u]; e < off[u + 1]; e += 1) {
      const v = to[e];
      bearing[e] = Math.round((Math.atan2((lon[v] - lon[u]) * cos, lat[v] - lat[u]) * 180) / Math.PI);
      const back = edge(v, u);
      inc(roads, u);
      if (back >= 0 && Ln[back] === Ln[e]) {
        rev[e] = back;
        inc(twoWay, u);
      } else inc(roads, v);
    }
  }
  const bans = new Map();
  const hasBan = new Uint8Array(m);
  let banCount = 0;
  for (let i = 0; i < triples.length; i += 3) {
    const e = edge(triples[i], triples[i + 1]);
    const o = edge(triples[i + 1], triples[i + 2]);
    if (e < 0 || o < 0) continue;
    const list = bans.get(e);
    if (list) list.push(o);
    else bans.set(e, [o]);
    hasBan[e] = 1;
    banCount += 1;
  }
  return Object.assign(g, { rev, bearing, roads, twoWay, bans, hasBan, banCount });
}

/** Koszt skretu z krawedzi `e` w `o` (wspolny wezel `v`), sekundy. Przejazd przez wezel dwoch drog jest bez kary. */
export function turnCost(g, e, o, v) {
  const uTurn = g.rev[e] === o;
  if (!uTurn && g.roads[v] <= 2) return 0;
  let a = g.bearing[o] - g.bearing[e];
  if (a > 180) a -= 360;
  else if (a < -180) a += 360;
  return TURN_COST[a + 180] + (uTurn ? U_TURN_S : 0);
}

/**
 * Dijkstra po krawedziach do calego grafu. `run({ snap, nodes })`: start w punkcie snapu (obie strony drogi dwukierunkowej)
 * albo w wezlach `[wezel, koszt, m, s]` (portale - skret z poprzedniego pliku jest nieznany, wiec bez kary i bez zakazu).
 * Ziarna `edges` (`[krawedz, koszt wjazdu, m, s]`) niosa stan skretu z innego pliku z ta sama krawedzia (`entry(e)`).
 * `limit` (s) konczy przebieg wczesniej: koszty do niego sa dokladne, powyzej sa tylko gornym oszacowaniem.
 * Odczyt: `read(snap)` -> `[koszt, m, s]` albo null, `node(i)` -> to samo dla wezla.
 */
export function createEdgeSearch(g) {
  const { n, m, off, to, W, Ln, T, rev, twoWay, bans, hasBan } = g;
  const at = new Float32Array(m);
  const lenAt = new Float32Array(m);
  const timeAt = new Float32Array(m);
  const done = new Uint8Array(m);
  const nodeW = new Float32Array(n);
  const nodeL = new Float32Array(n);
  const nodeT = new Float32Array(n);
  let heapK = new Float32Array(m + 1024);
  let heapV = new Int32Array(m + 1024);
  let size = 0;
  let starts = [];
  const push = (k, v) => {
    if (size === heapK.length) {
      const nk = new Float32Array(size * 2);
      nk.set(heapK);
      heapK = nk;
      const nv = new Int32Array(size * 2);
      nv.set(heapV);
      heapV = nv;
    }
    let i = size;
    size += 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heapK[p] <= k) break;
      heapK[i] = heapK[p];
      heapV[i] = heapV[p];
      i = p;
    }
    heapK[i] = k;
    heapV[i] = v;
  };
  const popSift = () => {
    size -= 1;
    const k = heapK[size];
    const v = heapV[size];
    let i = 0;
    const half = size >> 1;
    while (i < half) {
      let c = 2 * i + 1;
      if (c + 1 < size && heapK[c + 1] < heapK[c]) c += 1;
      if (heapK[c] >= k) break;
      heapK[i] = heapK[c];
      heapV[i] = heapV[c];
      i = c;
    }
    heapK[i] = k;
    heapV[i] = v;
  };
  const enter = (o, w, l, t) => {
    if (w >= at[o]) return;
    at[o] = w;
    lenAt[o] = l;
    timeAt[o] = t;
    push(w + W[o], o);
  };
  const reach = (v, w, l, t) => {
    if (w >= nodeW[v]) return;
    nodeW[v] = w;
    nodeL[v] = l;
    nodeT[v] = t;
  };
  // Wyjazd z konca krawedzi `e`. Zawracanie tylko, gdy nie ma innego legalnego wyjazdu albo przy tym wezle jest najwyzej
  // jedna droga dwukierunkowa (slepy koniec, wylot na ulice jednokierunkowa) - regula isTurnAllowed z OSRM.
  const leave = (e, w, l, t) => {
    const v = to[e];
    reach(v, w, l, t);
    const back = rev[e];
    const banned = hasBan[e] ? bans.get(e) : null;
    let exits = 0;
    for (let o = off[v], end = off[v + 1]; o < end; o += 1) {
      if (o === back || (banned && banned.includes(o))) continue;
      exits += 1;
      if (done[o]) continue;
      const c = turnCost(g, e, o, v);
      enter(o, w + c, l, t + c);
    }
    if (back >= 0 && !done[back] && Ln[e] >= MIN_U_TURN_M && (exits === 0 || twoWay[v] <= 1) && !(banned && banned.includes(back))) {
      const c = turnCost(g, e, back, v);
      enter(back, w + c, l, t + c);
    }
  };
  const run = ({ snap = null, nodes = null, edges = null, offset = [0, 0, 0], limit = Infinity }) => {
    at.fill(Infinity);
    nodeW.fill(Infinity);
    done.fill(0);
    size = 0;
    starts = [];
    if (snap) {
      const [w, l, t] = offset;
      starts.push({ e: snap.e, f: snap.f, w, l, t });
      if (snap.back >= 0) starts.push({ e: snap.back, f: 1 - snap.f, w, l, t });
      starts.forEach((s, i) => push(s.w + W[s.e] * (1 - s.f), m + i));
    }
    for (const [v, w, l, t] of nodes || []) {
      reach(v, w, l, t);
      for (let o = off[v]; o < off[v + 1]; o += 1) enter(o, w, l, t);
    }
    for (const [e, w, l, t] of edges || []) enter(e, w, l, t);
    while (size > 0 && heapK[0] <= limit) {
      const id = heapV[0];
      popSift();
      if (id >= m) {
        const s = starts[id - m];
        const rest = 1 - s.f;
        leave(s.e, s.w + W[s.e] * rest, s.l + Ln[s.e] * rest, s.t + T[s.e] * rest);
      } else if (!done[id]) {
        done[id] = 1;
        leave(id, at[id] + W[id], lenAt[id] + Ln[id], timeAt[id] + T[id]);
      }
    }
  };
  const read = (s) => {
    let best = null;
    const offer = (w, l, t) => {
      if (w < Infinity && (!best || w < best[0])) best = [w, l, t];
    };
    const target = (e, f) => {
      offer(at[e] + W[e] * f, lenAt[e] + Ln[e] * f, timeAt[e] + T[e] * f);
      for (const st of starts) {
        const d = f - st.f;
        if (st.e === e && d >= 0) offer(st.w + W[e] * d, st.l + Ln[e] * d, st.t + T[e] * d);
      }
    };
    target(s.e, s.f);
    if (s.back >= 0) target(s.back, 1 - s.f);
    return best;
  };
  const node = (i) => (nodeW[i] < Infinity ? [nodeW[i], nodeL[i], nodeT[i]] : null);
  const entry = (e) => (at[e] < Infinity ? [at[e], lenAt[e], timeAt[e]] : null);
  return { run, read, node, entry };
}
