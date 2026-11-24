// Krok 5: budowa grafow `graph-<obszar>` i grafu krajowego `graph-coarse` z ways.bin. Wejscie wylacznie z OSM.
// Uzycie: node --max-old-space-size=6000 graph_build.mjs <osmDir> <areas.json> <outDir> [--variants]
//   --variants liczy dodatkowo rozmiary wariantow (bez dojazdow service, zgrubny z tertiary), bez zapisu do publikacji.
// Kolejnosc jest kontraktem: najpierw graf zgrubny, bo jego wezly sa punktami przesiadki (portalami) w grafach miast
// i nie moga zniknac przy skracaniu wezlow stopnia 2.
import fs from "node:fs";
import path from "node:path";
import { gzip, sha256, writeJson, readJson, reportResources } from "./common.mjs";
import { COVER_DLAT, COVER_DLON, encodeCoverage, encodeGraph } from "./graph_format.mjs";

const [osmDir, areasFile, outDir, ...opts] = process.argv.slice(2);
const variants = opts.includes("--variants");
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
fs.mkdirSync(outDir, { recursive: true });

// Indeksy klas sa ustalone przez osm_extract.py (lista CLASSES). 0-7: motorway..secondary_link.
const COARSE_MAX_CLASS = 7;
const COARSE_TERTIARY_MAX_CLASS = 9;
const SIGNAL_S = 2;
const NO_SNAP_MAX_CLASS = 1; // motorway, motorway_link: dom nie ma z nich wjazdu
const BUFFER_RASTER = 0.002; // stopnie, ok. 140-220 m; rozdzielczosc wyboru drog do obszaru

// 1. Wczytanie drog do tablic typowanych. Rekord: <d way id><B klasa><B flagi><f predkosc><I n><d id * n><i lon, lat * n>.
const raw = fs.readFileSync(path.join(osmDir, "ways.bin"));
let nw = 0;
let refs = 0;
for (let p = 0; p < raw.length; ) {
  const k = raw.readUInt32LE(p + 14);
  nw += 1;
  refs += k;
  p += 18 + k * 16;
}
if (nw === 0) {
  console.log("GATE:osm-input ways.bin pusty");
  process.exit(3);
}
const wayClass = new Uint8Array(nw);
const wayFlags = new Uint8Array(nw);
const waySpeed = new Float32Array(nw);
const wayStart = new Uint32Array(nw + 1);
const wayIdx = new Map();
const refId = new Float64Array(refs);
const refLon = new Int32Array(refs);
const refLat = new Int32Array(refs);
{
  let p = 0;
  let r = 0;
  for (let w = 0; w < nw; w += 1) {
    wayIdx.set(raw.readDoubleLE(p), w);
    wayClass[w] = raw[p + 8];
    wayFlags[w] = raw[p + 9];
    waySpeed[w] = raw.readFloatLE(p + 10);
    const k = raw.readUInt32LE(p + 14);
    wayStart[w] = r;
    p += 18;
    for (let i = 0; i < k; i += 1) refId[r + i] = raw.readDoubleLE(p + i * 8);
    p += k * 8;
    for (let i = 0; i < k; i += 1) {
      refLon[r + i] = raw.readInt32LE(p + i * 8);
      refLat[r + i] = raw.readInt32LE(p + i * 8 + 4);
    }
    p += k * 8;
    r += k;
  }
  wayStart[nw] = r;
}
log(`drogi ${nw}, odwolania ${refs}`);

// 2. Indeks krajowy wezlow: posortowane unikalne id, wspolrzedne po indeksie.
const sortedIds = Float64Array.from(refId).sort();
let nodeCount = 0;
for (let i = 0; i < refs; i += 1) if (i === 0 || sortedIds[i] !== sortedIds[i - 1]) sortedIds[nodeCount++] = sortedIds[i];
const nodeIds = sortedIds.subarray(0, nodeCount);
const findNode = (id) => {
  let lo = 0;
  let hi = nodeCount - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const v = nodeIds[mid];
    if (v === id) return mid;
    if (v < id) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
};
const refNode = new Int32Array(refs);
const nodeLat = new Int32Array(nodeCount);
const nodeLon = new Int32Array(nodeCount);
for (let i = 0; i < refs; i += 1) {
  const n = findNode(refId[i]);
  refNode[i] = n;
  nodeLat[n] = refLat[i];
  nodeLon[n] = refLon[i];
}
const nodeFlag = new Uint8Array(nodeCount);
{
  const f = fs.readFileSync(path.join(osmDir, "node_flags.bin"));
  for (let p = 0; p < f.length; p += 9) {
    const n = findNode(f.readDoubleLE(p));
    if (n >= 0) nodeFlag[n] |= f[p + 8];
  }
}
const wMinLat = new Int32Array(nw);
const wMaxLat = new Int32Array(nw);
const wMinLon = new Int32Array(nw);
const wMaxLon = new Int32Array(nw);
for (let w = 0; w < nw; w += 1) {
  let a = Infinity;
  let b = -Infinity;
  let c = Infinity;
  let d = -Infinity;
  for (let r = wayStart[w]; r < wayStart[w + 1]; r += 1) {
    const la = refLat[r];
    const lo = refLon[r];
    if (la < a) a = la;
    if (la > b) b = la;
    if (lo < c) c = lo;
    if (lo > d) d = lo;
  }
  wMinLat[w] = a;
  wMaxLat[w] = b;
  wMinLon[w] = c;
  wMaxLon[w] = d;
}
log(`wezly ${nodeCount}`);

// Zakazy skretu po wezle krajowym: [only, droga wjazdu, droga wyjazdu] (indeksy drog). Droga nie dla aut = zakaz bez znaczenia.
const restrictionsAt = new Map();
const restrictionCount = { input: 0, usable: 0 };
for (const r of readJson(path.join(osmDir, "restrictions.json"))) {
  restrictionCount.input += 1;
  const from = wayIdx.get(r.from);
  const to = wayIdx.get(r.to);
  const via = findNode(r.via);
  if (from === undefined || to === undefined || via < 0) continue;
  restrictionCount.usable += 1;
  const list = restrictionsAt.get(via);
  if (list) list.push([r.only, from, to]);
  else restrictionsAt.set(via, [[r.only, from, to]]);
}
log(`zakazy ${restrictionCount.usable} z ${restrictionCount.input}`);

// Zakazy na krawedziach grafu skroconego: trojki (u, v, w). Niejednoznaczne (droga przechodzi przez wezel via na wylot,
// wiec nie wiadomo, ktora strona) sa pomijane i liczone. only_* bez drogi docelowej w pliku (granica obszaru) nie blokuje
// reszty wyjazdow. from = to oznacza zakaz zawracania: tylko powrot ta sama droga.
function bansOf(n, m, eu, ev, first, last, globalIdx) {
  const st = { mapped: 0, ambiguous: 0, missing: 0 };
  const seen = new Set();
  const triples = [];
  const add = (u, v, w) => {
    const k = `${u},${v},${w}`;
    if (seen.has(k)) return;
    seen.add(k);
    triples.push(u, v, w);
  };
  const off = new Int32Array(n + 1);
  for (let e = 0; e < m; e += 1) off[eu[e] + 1] += 1;
  for (let i = 0; i < n; i += 1) off[i + 1] += off[i];
  const inOff = new Int32Array(n + 1);
  for (let e = 0; e < m; e += 1) inOff[ev[e] + 1] += 1;
  for (let i = 0; i < n; i += 1) inOff[i + 1] += inOff[i];
  const pos = inOff.slice();
  const inE = new Int32Array(m);
  for (let e = 0; e < m; e += 1) inE[pos[ev[e]]++] = e;
  for (let v = 0; v < n; v += 1) {
    const list = restrictionsAt.get(globalIdx[v]);
    if (!list) continue;
    const ins = Array.from(inE.subarray(inOff[v], inOff[v + 1]));
    const outs = [];
    for (let e = off[v]; e < off[v + 1]; e += 1) outs.push(e);
    for (const [only, from, to] of list) {
      const a = ins.filter((e) => last[e] === from);
      const b = outs.filter((e) => first[e] === to);
      if (!a.length || !b.length) {
        st.missing += 1;
      } else if (from === to) {
        if (only) st.ambiguous += 1;
        else {
          st.mapped += 1;
          for (const e of a) if (b.some((o) => ev[o] === eu[e])) add(eu[e], v, eu[e]);
        }
      } else if (a.length > 1 || b.length > 1) {
        st.ambiguous += 1;
      } else {
        st.mapped += 1;
        if (!only) add(eu[a[0]], v, ev[b[0]]);
        else for (const o of outs) if (o !== b[0]) add(eu[a[0]], v, ev[o]);
      }
    }
  }
  return { triples: Int32Array.from(triples), stats: st };
}

const morton = (x, y) => {
  let r = 0;
  let p = 1;
  for (let i = 0; i < 26; i += 1) {
    r += ((x >>> i) & 1) * p;
    p *= 2;
    r += ((y >>> i) & 1) * p;
    p *= 2;
  }
  return r;
};
function csr(n, count, fromOf, toOf, refOf) {
  const off = new Int32Array(n + 1);
  for (let i = 0; i < count; i += 1) off[fromOf(i) + 1] += 1;
  for (let i = 0; i < n; i += 1) off[i + 1] += off[i];
  const pos = off.slice();
  const to = new Int32Array(count);
  const ref = new Int32Array(count);
  for (let i = 0; i < count; i += 1) {
    const q = pos[fromOf(i)]++;
    to[q] = toOf(i);
    ref[q] = refOf(i);
  }
  return { off, to, ref };
}

const localOf = new Int32Array(nodeCount).fill(-1);
// Buduje graf z wybranych drog. keepMask: wezly krajowe, ktorych nie wolno skrocic (portale).
function buildGraph(wayList, keepMask) {
  let refSum = 0;
  for (const w of wayList) refSum += wayStart[w + 1] - wayStart[w];
  const toGlobal = new Int32Array(refSum);
  let N0 = 0;
  const segU = new Int32Array(refSum);
  const segV = new Int32Array(refSum);
  const segL = new Float32Array(refSum);
  const segT = new Float32Array(refSum);
  const segW = new Float32Array(refSum);
  const segFlag = new Uint8Array(refSum);
  const segWay = new Int32Array(refSum);
  let S = 0;
  let droppedBarrier = 0;
  const local = (g) => {
    let i = localOf[g];
    if (i < 0) {
      i = N0++;
      localOf[g] = i;
      toGlobal[i] = g;
    }
    return i;
  };
  for (const w of wayList) {
    const fw = wayFlags[w] & 1;
    const bw = wayFlags[w] & 2;
    const pen = wayFlags[w] & 4 ? 0.5 : 1;
    const ms = (waySpeed[w] * 1000) / 3600;
    let prevG = refNode[wayStart[w]];
    let prev = local(prevG);
    for (let r = wayStart[w] + 1; r < wayStart[w + 1]; r += 1) {
      const curG = refNode[r];
      const cur = local(curG);
      if (cur === prev) continue;
      if (nodeFlag[curG] & 1 || nodeFlag[prevG] & 1) {
        droppedBarrier += 1;
        prev = cur;
        prevG = curG;
        continue;
      }
      const la1 = nodeLat[prevG] / 1e7;
      const la2 = nodeLat[curG] / 1e7;
      const c = Math.cos((((la1 + la2) / 2) * Math.PI) / 180);
      const dx = (((nodeLon[curG] - nodeLon[prevG]) / 1e7) * Math.PI) / 180 * c * 6371008.8;
      const dy = (((la2 - la1) * Math.PI) / 180) * 6371008.8;
      const L = Math.hypot(dx, dy);
      const tt = L / ms;
      segU[S] = prev;
      segV[S] = cur;
      segL[S] = L;
      segT[S] = tt;
      segW[S] = tt / pen;
      segFlag[S] = (fw ? 1 : 0) | (bw ? 2 : 0);
      segWay[S] = w;
      S += 1;
      prev = cur;
      prevG = curG;
    }
  }
  for (let i = 0; i < N0; i += 1) localOf[toGlobal[i]] = -1;

  // Skierowana lista krawedzi surowych.
  let D = 0;
  for (let s = 0; s < S; s += 1) D += (segFlag[s] & 1) + ((segFlag[s] >> 1) & 1);
  const dU = new Int32Array(D);
  const dV = new Int32Array(D);
  const dS = new Int32Array(D);
  {
    let q = 0;
    for (let s = 0; s < S; s += 1) {
      if (segFlag[s] & 1) {
        dU[q] = segU[s];
        dV[q] = segV[s];
        dS[q] = s;
        q += 1;
      }
      if (segFlag[s] & 2) {
        dU[q] = segV[s];
        dV[q] = segU[s];
        dS[q] = s;
        q += 1;
      }
    }
  }
  const G = csr(N0, D, (i) => dU[i], (i) => dV[i], (i) => dS[i]);

  // Najwieksza silnie spojna skladowa (Tarjan iteracyjny).
  const index = new Int32Array(N0).fill(-1);
  const low = new Int32Array(N0);
  const onStack = new Uint8Array(N0);
  const comp = new Int32Array(N0).fill(-1);
  const stack = new Int32Array(N0);
  const cs = new Int32Array(N0);
  const ci = new Int32Array(N0);
  let sp = 0;
  let counter = 0;
  let compCount = 0;
  let main = 0;
  let mainSize = 0;
  for (let r = 0; r < N0; r += 1) {
    if (index[r] !== -1) continue;
    let cp = 0;
    cs[0] = r;
    ci[0] = G.off[r];
    index[r] = low[r] = counter++;
    stack[sp++] = r;
    onStack[r] = 1;
    while (cp >= 0) {
      const v = cs[cp];
      if (ci[cp] < G.off[v + 1]) {
        const w = G.to[ci[cp]++];
        if (index[w] === -1) {
          index[w] = low[w] = counter++;
          stack[sp++] = w;
          onStack[w] = 1;
          cp += 1;
          cs[cp] = w;
          ci[cp] = G.off[w];
        } else if (onStack[w] && index[w] < low[v]) low[v] = index[w];
      } else {
        if (low[v] === index[v]) {
          let size = 0;
          let w;
          do {
            w = stack[--sp];
            onStack[w] = 0;
            comp[w] = compCount;
            size += 1;
          } while (w !== v);
          if (size > mainSize) {
            mainSize = size;
            main = compCount;
          }
          compCount += 1;
        }
        cp -= 1;
        if (cp >= 0) {
          const parent = cs[cp];
          if (low[v] < low[parent]) low[parent] = low[v];
        }
      }
    }
  }

  // Skrocenie stopnia 2 na skladowej glownej.
  let D2 = 0;
  for (let i = 0; i < D; i += 1) if (comp[dU[i]] === main && comp[dV[i]] === main) D2 += 1;
  const mU = new Int32Array(D2);
  const mV = new Int32Array(D2);
  const mS = new Int32Array(D2);
  {
    let q = 0;
    for (let i = 0; i < D; i += 1) {
      if (comp[dU[i]] === main && comp[dV[i]] === main) {
        mU[q] = dU[i];
        mV[q] = dV[i];
        mS[q] = dS[i];
        q += 1;
      }
    }
  }
  const out = csr(N0, D2, (i) => mU[i], (i) => mV[i], (i) => mS[i]);
  const inn = csr(N0, D2, (i) => mV[i], (i) => mU[i], (i) => mS[i]);
  const removable = new Uint8Array(N0);
  const hasIn = (list, n, x) => {
    for (let e = list.off[n]; e < list.off[n + 1]; e += 1) if (list.to[e] === x) return true;
    return false;
  };
  for (let n = 0; n < N0; n += 1) {
    if (comp[n] !== main) continue;
    if (keepMask && keepMask[toGlobal[n]]) continue;
    let a = -1;
    let b = -1;
    let many = false;
    const see = (x) => {
      if (x === a || x === b) return;
      if (a < 0) a = x;
      else if (b < 0) b = x;
      else many = true;
    };
    for (let e = out.off[n]; e < out.off[n + 1] && !many; e += 1) see(out.to[e]);
    for (let e = inn.off[n]; e < inn.off[n + 1] && !many; e += 1) see(inn.to[e]);
    if (many || b < 0) continue;
    if (hasIn(inn, n, a) === hasIn(out, n, b) && hasIn(inn, n, b) === hasIn(out, n, a)) removable[n] = 1;
  }
  const isSignal = (n) => nodeFlag[toGlobal[n]] & 2;
  let eCap = D2 + 16;
  let eU = new Int32Array(eCap);
  let eV = new Int32Array(eCap);
  let eL = new Float32Array(eCap);
  let eW = new Float32Array(eCap);
  let eT = new Float32Array(eCap);
  const eFirst = new Int32Array(eCap);
  const eLast = new Int32Array(eCap);
  const eNs = new Uint8Array(eCap);
  let E = 0;
  for (let n = 0; n < N0; n += 1) {
    if (comp[n] !== main || removable[n]) continue;
    for (let e = out.off[n]; e < out.off[n + 1]; e += 1) {
      let prev = n;
      let cur = out.to[e];
      let s = out.ref[e];
      let l = segL[s];
      let w = segW[s];
      let t = segT[s];
      const firstWay = segWay[s];
      let noSnap = wayClass[firstWay] <= NO_SNAP_MAX_CLASS;
      if (isSignal(cur)) {
        w += SIGNAL_S;
        t += SIGNAL_S;
      }
      let steps = 0;
      while (removable[cur] && steps < 1000000) {
        let nextE = -1;
        for (let x = out.off[cur]; x < out.off[cur + 1]; x += 1) if (out.to[x] !== prev) nextE = x;
        if (nextE < 0) break;
        s = out.ref[nextE];
        l += segL[s];
        w += segW[s];
        t += segT[s];
        if (wayClass[segWay[s]] <= NO_SNAP_MAX_CLASS) noSnap = true;
        prev = cur;
        cur = out.to[nextE];
        if (isSignal(cur)) {
          w += SIGNAL_S;
          t += SIGNAL_S;
        }
        steps += 1;
      }
      if (removable[cur] || cur === n) continue;
      eU[E] = n;
      eV[E] = cur;
      eL[E] = l;
      eW[E] = w;
      eT[E] = t;
      eFirst[E] = firstWay;
      eLast[E] = segWay[s];
      eNs[E] = noSnap ? 1 : 0;
      E += 1;
    }
  }
  // Numeracja Mortona i usuniecie rownoleglych krawedzi (zostaje najtansza).
  const used = new Uint8Array(N0);
  for (let i = 0; i < E; i += 1) {
    used[eU[i]] = 1;
    used[eV[i]] = 1;
  }
  let n = 0;
  for (let i = 0; i < N0; i += 1) if (used[i]) n += 1;
  const keep = new Int32Array(n);
  {
    let q = 0;
    for (let i = 0; i < N0; i += 1) if (used[i]) keep[q++] = i;
  }
  let minLat = Infinity;
  let minLon = Infinity;
  for (let i = 0; i < n; i += 1) {
    const g = toGlobal[keep[i]];
    if (nodeLat[g] < minLat) minLat = nodeLat[g];
    if (nodeLon[g] < minLon) minLon = nodeLon[g];
  }
  const mk = new Float64Array(N0);
  for (let i = 0; i < n; i += 1) {
    const g = toGlobal[keep[i]];
    mk[keep[i]] = morton(Math.round((nodeLat[g] - minLat) / 100), Math.round((nodeLon[g] - minLon) / 100));
  }
  keep.sort((a, b) => mk[a] - mk[b]);
  const newId = new Int32Array(N0).fill(-1);
  for (let i = 0; i < n; i += 1) newId[keep[i]] = i;
  const ek = new Float64Array(E);
  for (let i = 0; i < E; i += 1) ek[i] = newId[eU[i]] * 4294967296 + newId[eV[i]];
  const order = new Uint32Array(E);
  for (let i = 0; i < E; i += 1) order[i] = i;
  order.sort((a, b) => ek[a] - ek[b] || eW[a] - eW[b]);
  const fu = new Int32Array(E);
  const fv = new Int32Array(E);
  const fl = new Float32Array(E);
  const fw = new Float32Array(E);
  const ft = new Float32Array(E);
  const first = new Int32Array(E);
  const last = new Int32Array(E);
  const ns = new Uint8Array(E);
  let m = 0;
  for (let i = 0; i < E; i += 1) {
    const o = order[i];
    if (i > 0 && ek[o] === ek[order[i - 1]]) continue;
    fu[m] = newId[eU[o]];
    fv[m] = newId[eV[o]];
    fl[m] = eL[o];
    fw[m] = eW[o];
    ft[m] = eT[o];
    first[m] = eFirst[o];
    last[m] = eLast[o];
    ns[m] = eNs[o];
    m += 1;
  }
  const latE5 = new Int32Array(n);
  const lonE5 = new Int32Array(n);
  const globalIdx = new Int32Array(n);
  for (let i = 0; i < n; i += 1) {
    const g = toGlobal[keep[i]];
    globalIdx[i] = g;
    latE5[i] = Math.round(nodeLat[g] / 100);
    lonE5[i] = Math.round(nodeLon[g] / 100);
  }
  const bans = bansOf(n, m, fu, fv, first, last, globalIdx);
  return {
    n, m, latE5, lonE5, eu: fu, ev: fv, el: fl, ew: fw, et: ft, ens: ns, bans: bans.triples, banStats: bans.stats, globalIdx,
    rawNodes: N0, rawSegments: S, droppedBarrier, sccCount: compCount, sccMainPct: Math.round((1e4 * mainSize) / N0) / 100,
  };
}

// Rasteryzacja (Multi)Polygonu GeoJSON na siatke: linia skanu po srodkach wierszy, regula parzystosci.
function rasterize(geo, lat0, lon0, dLat, dLon, nx, ny) {
  const bits = new Uint8Array(nx * ny);
  const polys = geo.type === "Polygon" ? [geo.coordinates] : geo.coordinates;
  for (const poly of polys) {
    const single = new Uint8Array(nx * ny);
    for (const ring of poly) {
      for (let y = 0; y < ny; y += 1) {
        const yc = lat0 + (y + 0.5) * dLat;
        const xs = [];
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
          const [x1, y1] = ring[i];
          const [x2, y2] = ring[j];
          if (y1 > yc !== y2 > yc) xs.push(x1 + ((yc - y1) / (y2 - y1)) * (x2 - x1));
        }
        xs.sort((a, b) => a - b);
        for (let k = 0; k + 1 < xs.length; k += 2) {
          const a = Math.max(0, Math.ceil((xs[k] - lon0) / dLon - 0.5));
          const b = Math.min(nx - 1, Math.floor((xs[k + 1] - lon0) / dLon - 0.5));
          for (let x = a; x <= b; x += 1) single[y * nx + x] ^= 1;
        }
      }
    }
    for (let i = 0; i < bits.length; i += 1) bits[i] |= single[i];
  }
  return bits;
}
function polygonBounds(geo) {
  const polys = geo.type === "Polygon" ? [geo.coordinates] : geo.coordinates;
  let a = Infinity;
  let b = Infinity;
  let c = -Infinity;
  let d = -Infinity;
  for (const poly of polys) for (const [x, y] of poly[0]) {
    if (x < a) a = x;
    if (y < b) b = y;
    if (x > c) c = x;
    if (y > d) d = y;
  }
  return [a, b, c, d];
}
function selectWays(geo) {
  const [x0, y0, x1, y1] = polygonBounds(geo);
  const nx = Math.ceil((x1 - x0) / BUFFER_RASTER) + 1;
  const ny = Math.ceil((y1 - y0) / BUFFER_RASTER) + 1;
  const bits = rasterize(geo, y0, x0, BUFFER_RASTER, BUFFER_RASTER, nx, ny);
  const inRaster = (lat, lon) => {
    const y = Math.floor((lat / 1e7 - y0) / BUFFER_RASTER);
    const x = Math.floor((lon / 1e7 - x0) / BUFFER_RASTER);
    return y >= 0 && x >= 0 && y < ny && x < nx && bits[y * nx + x] === 1;
  };
  const a = Math.floor(y0 * 1e7);
  const b = Math.ceil(y1 * 1e7);
  const c = Math.floor(x0 * 1e7);
  const d = Math.ceil(x1 * 1e7);
  const list = [];
  for (let w = 0; w < nw; w += 1) {
    if (wMaxLat[w] < a || wMinLat[w] > b || wMaxLon[w] < c || wMinLon[w] > d) continue;
    for (let r = wayStart[w]; r < wayStart[w + 1]; r += 1) {
      if (inRaster(refLat[r], refLon[r])) {
        list.push(w);
        break;
      }
    }
  }
  return list;
}
function coverageOf(geo) {
  const [x0, y0, x1, y1] = polygonBounds(geo);
  const lat0 = Math.floor(y0 / COVER_DLAT) * COVER_DLAT;
  const lon0 = Math.floor(x0 / COVER_DLON) * COVER_DLON;
  const nx = Math.ceil((x1 - lon0) / COVER_DLON);
  const ny = Math.ceil((y1 - lat0) / COVER_DLAT);
  const bits = rasterize(geo, lat0, lon0, COVER_DLAT, COVER_DLON, nx, ny);
  let set = 0;
  for (let i = 0; i < bits.length; i += 1) set += bits[i];
  return { meta: { lat0: +lat0.toFixed(4), lon0: +lon0.toFixed(4), dLat: COVER_DLAT, dLon: COVER_DLON, nx, ny, cellsSet: set }, encoded: encodeCoverage(bits) };
}

const areas = readJson(areasFile);
const snapshot = areas.snapshot || "";
const results = [];
// Dlugie mosty glownych drog (do tertiary_link): srodek w 1e-4 stopnia, do bramki `bridges`.
const BRIDGE_FLAG = 16;
const BRIDGE_MAX_CLASS = 9;
const BRIDGE_MIN_M = 80;
const bridges = [];
for (let w = 0; w < nw; w += 1) {
  if (!(wayFlags[w] & BRIDGE_FLAG) || wayClass[w] > BRIDGE_MAX_CLASS) continue;
  const cos = Math.cos((refLat[wayStart[w]] / 1e7) * (Math.PI / 180));
  let m = 0;
  for (let r = wayStart[w] + 1; r < wayStart[w + 1]; r += 1) m += Math.hypot((refLat[r] - refLat[r - 1]) * 0.011132, (refLon[r] - refLon[r - 1]) * 0.011132 * cos);
  if (m < BRIDGE_MIN_M) continue;
  const mid = (wayStart[w] + wayStart[w + 1]) >> 1;
  bridges.push([Math.round(refLat[mid] / 1000), Math.round(refLon[mid] / 1000)]);
}
const attribution = "OpenStreetMap contributors, ODbL 1.0";

function finish(slug, kind, g, cover, portals, extra = {}) {
  const header = { format: 2, area: slug, kind, snapshot, attribution, ...(cover ? { coverage: cover.meta } : {}), ...extra };
  const { file, storedBoth, storedOneway } = encodeGraph(g, header, cover?.encoded, portals);
  const gz = gzip(file);
  const name = `graph-${slug}.bin.gz`;
  fs.writeFileSync(path.join(outDir, name), gz);
  const rec = {
    file: name, area: slug, kind, nodes: g.n, edges: g.m, rawNodes: g.rawNodes, rawSegments: g.rawSegments, droppedBarrier: g.droppedBarrier,
    bans: g.bans.length / 3, banStats: g.banStats, sccCount: g.sccCount, sccMainPct: g.sccMainPct, raw: file.length, gzip: gz.length, sha256: sha256(gz), storedBoth, storedOneway,
    portals: portals ? portals.length / 2 : 0, coverageBytes: cover ? cover.encoded.length : 0, coverageCells: cover ? cover.meta.cellsSet : 0,
    coverage: cover ? { ...cover.meta, rle: cover.encoded.toString("base64") } : null,
  };
  results.push(rec);
  return rec;
}

// Graf zgrubny.
const coarseWays = [];
const tertiaryWays = [];
for (let w = 0; w < nw; w += 1) {
  if (wayClass[w] <= COARSE_MAX_CLASS) coarseWays.push(w);
  if (wayClass[w] <= COARSE_TERTIARY_MAX_CLASS) tertiaryWays.push(w);
}
const coarse = buildGraph(coarseWays, null);
const coarseRec = finish("coarse", "coarse", coarse, null, null);
log(`zgrubny: wezly ${coarse.n}, krawedzie ${coarse.m}, gzip ${coarseRec.gzip}, SCC ${coarse.sccMainPct}%`);
const keepMask = new Uint8Array(nodeCount);
const coarseIdxOf = new Int32Array(nodeCount).fill(-1);
for (let i = 0; i < coarse.n; i += 1) {
  keepMask[coarse.globalIdx[i]] = 1;
  coarseIdxOf[coarse.globalIdx[i]] = i;
}
const variantsOut = {};
if (variants) {
  const v = buildGraph(tertiaryWays, null);
  const { file } = encodeGraph(v, { format: 2, area: "coarse-tertiary" }, null, null);
  variantsOut.coarseTertiary = { nodes: v.n, edges: v.m, raw: file.length, gzip: gzip(file).length, sccMainPct: v.sccMainPct };
  log("zgrubny z tertiary", JSON.stringify(variantsOut.coarseTertiary));
}

variantsOut.noServiceMinor = {};
for (const a of areas.areas) {
  const t1 = Date.now();
  const list = selectWays(a.buffer);
  const g = buildGraph(list, keepMask);
  const portals = [];
  for (let i = 0; i < g.n; i += 1) {
    const c = coarseIdxOf[g.globalIdx[i]];
    if (c >= 0) portals.push(i, c);
  }
  const cover = coverageOf(a.coverage);
  const rec = finish(a.slug, a.kind, g, cover, Int32Array.from(portals), { coarseSha: coarseRec.sha256, terc: a.terc });
  rec.buildMs = Date.now() - t1;
  rec.terc = a.terc;
  if (variants) {
    const g2 = buildGraph(list.filter((w) => !(wayFlags[w] & 8)), keepMask);
    const { file } = encodeGraph(g2, { format: 2, area: a.slug }, cover.encoded, null);
    variantsOut.noServiceMinor[a.slug] = { nodes: g2.n, edges: g2.m, raw: file.length, gzip: gzip(file).length };
  }
  log(`${a.slug}: drogi ${list.length}, wezly ${g.n}, krawedzie ${g.m}, gzip ${rec.gzip}, portale ${rec.portals}, SCC ${g.sccMainPct}%, ${rec.buildMs} ms`);
}
// Pomiar odniesienia, bez zapisu do publikacji: siec aut calego kraju jako jeden plik i jako 380 plikow powiatowych.
const powiatsArg = opts.find((o) => o.startsWith("--powiats="))?.slice(10);
if (powiatsArg) {
  const all = [];
  for (let w = 0; w < nw; w += 1) all.push(w);
  const g = buildGraph(all, null);
  const { file } = encodeGraph(g, { format: 2, area: "polska" }, null, null);
  variantsOut.nationalFull = { nodes: g.n, edges: g.m, raw: file.length, gzip: gzip(file).length, sccMainPct: g.sccMainPct, rawNodes: g.rawNodes };
  log("caly kraj", JSON.stringify(variantsOut.nationalFull));
  const rows = [];
  for (const a of readJson(powiatsArg).areas) {
    const gp = buildGraph(selectWays(a.buffer), keepMask);
    const e = encodeGraph(gp, { format: 2, area: a.slug }, null, null);
    rows.push({ area: a.slug, nodes: gp.n, raw: e.file.length, gzip: gzip(e.file).length, sccMainPct: gp.sccMainPct });
  }
  rows.sort((x, y) => y.gzip - x.gzip);
  variantsOut.perPowiat = { files: rows.length, gzip: rows.reduce((s, r) => s + r.gzip, 0), raw: rows.reduce((s, r) => s + r.raw, 0), max: rows[0], median: rows[rows.length >> 1], min: rows[rows.length - 1] };
  log("powiaty", JSON.stringify(variantsOut.perPowiat));
}
writeJson(path.join(outDir, "graph_stats.json"), { snapshot, bufferM: areas.bufferM, restrictions: restrictionCount, bridges, nodesNational: nodeCount, waysNational: nw, results, variants: variantsOut });
reportResources(path.join(outDir, "graph_build.res.json"), { seconds: Math.round((Date.now() - t0) / 1000) });
log("gotowe");
