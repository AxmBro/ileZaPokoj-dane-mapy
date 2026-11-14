// Runtime tras: Dijkstra one-to-many, snap z progiem i kontrola zasiegu pliku, trasa miedzy plikami przez graf zgrubny.
// Kontrakt `locate`: nigdy nie zwraca cichego wyniku spoza pliku. Status: ok | out_of_file | no_road_nearby.
import { hav } from "./common.mjs";

// Prog z pomiaru odleglosci punktow PRG od grafu; nadpisywalny, zeby bramka mogla sprawdzic czulosc.
export const SNAP_MAX_M = 1500;
// Mnoznik linii prostej z pomiaru tras (Krakow 1,33, Warszawa 1,31) dla odcinkow bez grafu.
export const LINE_FACTOR = 1.33;
export const LINE_SPEED_MS = 30 / 3.6;

export function createSearch(g) {
  const dist = new Float32Array(g.n);
  const lenD = new Float32Array(g.n);
  const timeD = new Float32Array(g.n);
  const heapK = new Float32Array(g.m + g.n + 16);
  const heapV = new Int32Array(g.m + g.n + 16);
  let size = 0;
  const push = (k, v) => {
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
  // seeds: [[wezel, koszt, dlugosc, czas], ...]
  const run = (seeds) => {
    dist.fill(Infinity);
    size = 0;
    for (const [node, w, l, t] of seeds) {
      if (w < dist[node]) {
        dist[node] = w;
        lenD[node] = l;
        timeD[node] = t;
        push(w, node);
      }
    }
    const { off, to, W, Ln, T } = g;
    let settled = 0;
    while (size > 0) {
      const k = heapK[0];
      const u = heapV[0];
      popSift();
      if (k > dist[u]) continue;
      settled += 1;
      const du = dist[u];
      for (let e = off[u], end = off[u + 1]; e < end; e += 1) {
        const v = to[e];
        const nd = du + W[e];
        if (nd < dist[v]) {
          dist[v] = nd;
          lenD[v] = lenD[u] + Ln[e];
          timeD[v] = timeD[u] + T[e];
          push(nd, v);
        }
      }
    }
    return settled;
  };
  return { dist, lenD, timeD, run };
}

// Siatka po cieciwach krawedzi, kazda para wezlow raz. Zwraca najblizsza cieciwe i ulamek wzdluz niej.
export function buildSnap(g, cellM = 250) {
  const cos = Math.cos((((g.lat[0] + g.lat[g.n - 1]) / 2) * Math.PI) / 180);
  let minLat = Infinity;
  let minLon = Infinity;
  let maxLat = -Infinity;
  let maxLon = -Infinity;
  for (let i = 0; i < g.n; i += 1) {
    if (g.lat[i] < minLat) minLat = g.lat[i];
    if (g.lat[i] > maxLat) maxLat = g.lat[i];
    if (g.lon[i] < minLon) minLon = g.lon[i];
    if (g.lon[i] > maxLon) maxLon = g.lon[i];
  }
  const dy = cellM / 111320;
  const dx = dy / cos;
  const nx = Math.ceil((maxLon - minLon) / dx) + 1;
  const ny = Math.ceil((maxLat - minLat) / dy) + 1;
  const cells = nx * ny;
  const cellOf = (lat, lon) => Math.floor((lat - minLat) / dy) * nx + Math.floor((lon - minLon) / dx);
  const hasEdge = (a, b) => {
    for (let e = g.off[a]; e < g.off[a + 1]; e += 1) if (g.to[e] === b) return true;
    return false;
  };
  const count = new Int32Array(cells + 1);
  const forEachEdgeCell = (cb) => {
    for (let u = 0; u < g.n; u += 1) {
      for (let e = g.off[u]; e < g.off[u + 1]; e += 1) {
        const v = g.to[e];
        if (u > v && hasEdge(v, u)) continue;
        const L = Math.max(Math.abs(g.lat[u] - g.lat[v]) / dy, Math.abs(g.lon[u] - g.lon[v]) / dx);
        const steps = Math.ceil(L * 2) + 1;
        let last = -1;
        for (let s = 0; s <= steps; s += 1) {
          const f = s / steps;
          const c = cellOf(g.lat[u] + (g.lat[v] - g.lat[u]) * f, g.lon[u] + (g.lon[v] - g.lon[u]) * f);
          if (c !== last) {
            cb(c, e);
            last = c;
          }
        }
      }
    }
  };
  forEachEdgeCell((c) => {
    count[c + 1] += 1;
  });
  for (let i = 0; i < cells; i += 1) count[i + 1] += count[i];
  const pos = count.slice();
  const items = new Int32Array(count[cells]);
  forEachEdgeCell((c, e) => {
    items[pos[c]++] = e;
  });
  const edgeFrom = new Int32Array(g.m);
  for (let u = 0; u < g.n; u += 1) for (let e = g.off[u]; e < g.off[u + 1]; e += 1) edgeFrom[e] = u;
  const backEdge = (u, v) => {
    for (let e = g.off[v]; e < g.off[v + 1]; e += 1) if (g.to[e] === u) return e;
    return -1;
  };
  const maxRings = Math.ceil(30000 / cellM);
  const snap = (lat, lon) => {
    const cy = Math.floor((lat - minLat) / dy);
    const cx = Math.floor((lon - minLon) / dx);
    let best = Infinity;
    let bestE = -1;
    let bestF = 0;
    for (let r = 0; r < maxRings; r += 1) {
      for (let y = cy - r; y <= cy + r; y += 1) {
        if (y < 0 || y >= ny) continue;
        const onEdgeRow = Math.abs(y - cy) === r;
        for (let x = onEdgeRow ? cx - r : cx - r; x <= cx + r; x += onEdgeRow ? 1 : 2 * r || 1) {
          if (x < 0 || x >= nx) continue;
          const c = y * nx + x;
          for (let i = count[c]; i < count[c + 1]; i += 1) {
            const e = items[i];
            const u = edgeFrom[e];
            const v = g.to[e];
            const ax = (g.lon[u] - lon) * cos;
            const ay = g.lat[u] - lat;
            const bx = (g.lon[v] - lon) * cos;
            const by = g.lat[v] - lat;
            const dxx = bx - ax;
            const dyy = by - ay;
            const den = dxx * dxx + dyy * dyy;
            let f = den > 0 ? -(ax * dxx + ay * dyy) / den : 0;
            f = f < 0 ? 0 : f > 1 ? 1 : f;
            const px = ax + dxx * f;
            const py = ay + dyy * f;
            const d = px * px + py * py;
            if (d < best) {
              best = d;
              bestE = e;
              bestF = f;
            }
          }
        }
      }
      if (bestE >= 0 && Math.sqrt(best) * 111320 < r * cellM) break;
    }
    if (bestE < 0) return null;
    const u = edgeFrom[bestE];
    const v = g.to[bestE];
    return { e: bestE, u, v, f: bestF, back: backEdge(u, v), distM: Math.sqrt(best) * 111320 };
  };
  return { snap, cells, items: items.length };
}

// Naprawa cichego wyjscia poza plik: najpierw mapa zasiegu, potem prog odleglosci. Gdy punkt jest poza plikiem,
// wynik mowi to wprost, a wolajacy przechodzi na inny plik albo linie prosta z mnoznikiem.
export function locate(g, snapper, lat, lon, snapMaxM = SNAP_MAX_M) {
  if (g.covers && !g.covers(lat, lon)) return { status: "out_of_file", area: g.header.area };
  const s = snapper.snap(lat, lon);
  if (!s) return { status: "no_road_nearby", area: g.header.area, distM: null };
  if (s.distM > snapMaxM) return { status: "no_road_nearby", area: g.header.area, distM: s.distM };
  return { status: "ok", area: g.header.area, distM: s.distM, snap: s };
}

export function seedsFrom(g, s) {
  const out = [[s.v, g.W[s.e] * (1 - s.f), g.Ln[s.e] * (1 - s.f), g.T[s.e] * (1 - s.f)]];
  if (s.back >= 0) out.push([s.u, g.W[s.back] * s.f, g.Ln[s.back] * s.f, g.T[s.back] * s.f]);
  return out;
}
export function readTarget(g, search, s) {
  let best = null;
  const du = search.dist[s.u];
  if (du < Infinity) best = [du + g.W[s.e] * s.f, search.lenD[s.u] + g.Ln[s.e] * s.f, search.timeD[s.u] + g.T[s.e] * s.f];
  if (s.back >= 0 && search.dist[s.v] < Infinity) {
    const w = search.dist[s.v] + g.W[s.back] * (1 - s.f);
    if (!best || w < best[0]) best = [w, search.lenD[s.v] + g.Ln[s.back] * (1 - s.f), search.timeD[s.v] + g.T[s.back] * (1 - s.f)];
  }
  return best;
}

export function loadGraphRuntime(g, cellM = 250) {
  return { g, snapper: buildSnap(g, cellM), search: createSearch(g) };
}

// Trasa w jednym pliku. Zwraca km i min albo null, gdy punkt jest poza plikiem.
export function routeWithin(rt, from, to) {
  const a = locate(rt.g, rt.snapper, from.lat, from.lon);
  const b = locate(rt.g, rt.snapper, to.lat, to.lon);
  if (a.status !== "ok" || b.status !== "ok") return { status: "out_of_file", from: a.status, to: b.status };
  rt.search.run(seedsFrom(rt.g, a.snap));
  const r = readTarget(rt.g, rt.search, b.snap);
  if (!r) return { status: "unreachable" };
  return { status: "ok", km: r[1] / 1000, min: r[2] / 60, snapA: a.distM, snapB: b.distM };
}

// Punkt koncowy trasy miedzyplikowej: miasto (gdy plik go obejmuje) albo bezposrednio graf zgrubny plus odcinek prosty.
// Trzy fazy: Dijkstra w pliku A do portali, Dijkstra w grafie zgrubnym od portali, Dijkstra w pliku B od portali.
export function routeOverlay(coarse, from, to, rtA, rtB) {
  const startIn = rtA ? locate(rtA.g, rtA.snapper, from.lat, from.lon) : null;
  const endIn = rtB ? locate(rtB.g, rtB.snapper, to.lat, to.lon) : null;
  const usedA = startIn?.status === "ok";
  const usedB = endIn?.status === "ok";
  const seeds = [];
  let connA = 0;
  let connB = 0;
  if (usedA) {
    rtA.search.run(seedsFrom(rtA.g, startIn.snap));
    const { portalA, portalB } = rtA.g;
    for (let i = 0; i < portalA.length; i += 1) {
      const p = portalA[i];
      if (rtA.search.dist[p] < Infinity) seeds.push([portalB[i], rtA.search.dist[p], rtA.search.lenD[p], rtA.search.timeD[p]]);
    }
  } else {
    const s = coarse.snapper.snap(from.lat, from.lon);
    connA = s.distM * LINE_FACTOR;
    const t0 = connA / LINE_SPEED_MS;
    for (const [node, w, l, t] of seedsFrom(coarse.g, s)) seeds.push([node, w + t0, l + connA, t + t0]);
  }
  coarse.search.run(seeds);
  let best = null;
  if (usedB) {
    const { portalA, portalB } = rtB.g;
    const seedsB = [];
    for (let i = 0; i < portalA.length; i += 1) {
      const c = portalB[i];
      if (coarse.search.dist[c] < Infinity) seedsB.push([portalA[i], coarse.search.dist[c], coarse.search.lenD[c], coarse.search.timeD[c]]);
    }
    rtB.search.run(seedsB);
    best = readTarget(rtB.g, rtB.search, endIn.snap);
  } else {
    const s = coarse.snapper.snap(to.lat, to.lon);
    connB = s.distM * LINE_FACTOR;
    best = readTarget(coarse.g, coarse.search, s);
    if (best) best = [best[0], best[1] + connB, best[2] + connB / LINE_SPEED_MS];
  }
  if (!best) return { status: "unreachable", portalsA: seeds.length };
  return {
    status: "ok", km: best[1] / 1000, min: best[2] / 60, usedA, usedB, connectorM: Math.round(connA + connB),
    straightKm: hav(from.lat, from.lon, to.lat, to.lon) / 1000,
  };
}
