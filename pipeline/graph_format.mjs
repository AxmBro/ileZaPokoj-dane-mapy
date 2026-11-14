// Format pliku grafu `graph-<obszar>` (magia IZPG) i mapa zasiegu. Tylko dane OSM, licencja ODbL 1.0.
// Strumienie: coordLat, coordLon, deg, nb, len, spd, flg + coverage (RLE bitmapy) + portals.
// Kontrakt: dekoder nie uzywa Node API poza Buffer z kontenera, wiec przenosi sie do przegladarki po podmianie unpackFile.
import { ByteWriter, makeReader, packFile, unpackFile } from "./common.mjs";

export const COVER_DLAT = 0.005; // ok. 556 m
export const COVER_DLON = 0.0075; // ok. 500 m na szerokosci Polski

// Bitmapa w kolejnosci wierszy jako naprzemienne dlugosci serii 0 i 1 (zaczyna seria zer, moze miec dlugosc 0).
export function encodeCoverage(bits) {
  const w = new ByteWriter(256);
  let cur = 0;
  let run = 0;
  for (let i = 0; i < bits.length; i += 1) {
    if (bits[i] === cur) run += 1;
    else {
      w.varint(run);
      cur = bits[i];
      run = 1;
    }
  }
  w.varint(run);
  return Buffer.from(w.done());
}
export function decodeCoverage(buf, cells) {
  const bits = new Uint8Array(cells);
  const r = makeReader(buf);
  let p = 0;
  let cur = 0;
  while (p < cells) {
    const n = r.v();
    if (cur) bits.fill(1, p, p + n);
    p += n;
    cur ^= 1;
  }
  return bits;
}
// Zwraca funkcje (lat, lon) -> true, gdy punkt lezy w zasiegu pliku.
export function coverageTest(cov, bits) {
  return (lat, lon) => {
    const y = Math.floor((lat - cov.lat0) / cov.dLat);
    const x = Math.floor((lon - cov.lon0) / cov.dLon);
    if (y < 0 || x < 0 || y >= cov.ny || x >= cov.nx) return false;
    return bits[y * cov.nx + x] === 1;
  };
}

// edges: posortowane po (u, v), pola u, v, l (m), w (koszt s), t (czas s).
export function encodeGraph({ n, latE5, lonE5, eu, ev, el, ew, et, m }, header, coverage, portals) {
  const coordLat = new ByteWriter(n * 2);
  const coordLon = new ByteWriter(n * 2);
  let a = 0;
  let b = 0;
  for (let i = 0; i < n; i += 1) {
    coordLat.zigzag(latE5[i] - a);
    coordLon.zigzag(lonE5[i] - b);
    a = latE5[i];
    b = lonE5[i];
  }
  // Krawedz zwrotna o tych samych parametrach zapisana raz, przy mniejszym koncu.
  const off = new Int32Array(n + 1);
  for (let i = 0; i < m; i += 1) off[eu[i] + 1] += 1;
  for (let i = 0; i < n; i += 1) off[i + 1] += off[i];
  const findBack = (u, v) => {
    for (let lo = off[v], hi = off[v + 1] - 1; lo <= hi; ) {
      const mid = (lo + hi) >> 1;
      if (ev[mid] === u) return mid;
      if (ev[mid] < u) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  };
  const deg = new ByteWriter(n);
  const nb = new ByteWriter(m * 2);
  const len = new ByteWriter(m * 2);
  const spd = new ByteWriter(m);
  const flg = new ByteWriter(m);
  let oneway = 0;
  let both = 0;
  for (let u = 0; u < n; u += 1) {
    let count = 0;
    let prev = u;
    for (let e = off[u]; e < off[u + 1]; e += 1) {
      const v = ev[e];
      const back = findBack(u, v);
      const same = back >= 0 && Math.round(el[back]) === Math.round(el[e]) && Math.abs(ew[back] - ew[e]) < 0.5;
      if (same && v < u) continue;
      nb.zigzag(v - prev);
      prev = v;
      len.varint(Math.round(el[e]));
      spd.byte(et[e] > 0 ? Math.min(255, Math.max(1, Math.round((el[e] / et[e]) * 3.6))) : 1);
      flg.byte((same ? 1 : 0) | (ew[e] > et[e] * 1.2 ? 2 : 0));
      count += 1;
      if (same) both += 1;
      else oneway += 1;
    }
    deg.varint(count);
  }
  const portalW = new ByteWriter(256);
  if (portals) {
    let pa = 0;
    let pb = 0;
    for (let i = 0; i < portals.length; i += 2) {
      portalW.varint(portals[i] - pa);
      portalW.zigzag(portals[i + 1] - pb);
      pa = portals[i];
      pb = portals[i + 1];
    }
  }
  return {
    file: packFile(
      "IZPG",
      { ...header, nodes: n, edges: m, portals: portals ? portals.length / 2 : 0 },
      {
        coordLat: coordLat.done(), coordLon: coordLon.done(), deg: deg.done(), nb: nb.done(), len: len.done(), spd: spd.done(), flg: flg.done(),
        coverage: coverage || Buffer.alloc(0), portals: portalW.done(),
      },
    ),
    storedBoth: both,
    storedOneway: oneway,
  };
}

export function decodeGraph(buf) {
  const { header, streams: s } = unpackFile(buf, "IZPG");
  const n = header.nodes;
  const m = header.edges;
  const lat = new Float64Array(n);
  const lon = new Float64Array(n);
  const rLat = makeReader(s.coordLat);
  const rLon = makeReader(s.coordLon);
  let a = 0;
  let b = 0;
  for (let i = 0; i < n; i += 1) {
    a += rLat.z();
    b += rLon.z();
    lat[i] = a / 1e5;
    lon[i] = b / 1e5;
  }
  const rDeg = makeReader(s.deg);
  const rNb = makeReader(s.nb);
  const rLen = makeReader(s.len);
  let pSpd = 0;
  let pFlg = 0;
  const eu = new Int32Array(m);
  const ev = new Int32Array(m);
  const eW = new Float32Array(m);
  const eL = new Float32Array(m);
  const eT = new Float32Array(m);
  let c = 0;
  for (let u = 0; u < n; u += 1) {
    const d = rDeg.v();
    let prev = u;
    for (let i = 0; i < d; i += 1) {
      const v = prev + rNb.z();
      prev = v;
      const L = rLen.v();
      const spd = s.spd[pSpd++];
      const fl = s.flg[pFlg++];
      const t = L / (spd / 3.6);
      const w = fl & 2 ? t * 2 : t;
      eu[c] = u;
      ev[c] = v;
      eL[c] = L;
      eT[c] = t;
      eW[c] = w;
      c += 1;
      if (fl & 1) {
        eu[c] = v;
        ev[c] = u;
        eL[c] = L;
        eT[c] = t;
        eW[c] = w;
        c += 1;
      }
    }
  }
  if (c !== m) throw new Error(`liczba krawedzi po dekodowaniu ${c} != ${m}`);
  const off = new Int32Array(n + 1);
  for (let i = 0; i < m; i += 1) off[eu[i] + 1] += 1;
  for (let i = 0; i < n; i += 1) off[i + 1] += off[i];
  const pos = off.slice();
  const to = new Int32Array(m);
  const W = new Float32Array(m);
  const Ln = new Float32Array(m);
  const T = new Float32Array(m);
  for (let i = 0; i < m; i += 1) {
    const q = pos[eu[i]]++;
    to[q] = ev[i];
    W[q] = eW[i];
    Ln[q] = eL[i];
    T[q] = eT[i];
  }
  const portalCount = header.portals || 0;
  const portalA = new Int32Array(portalCount);
  const portalB = new Int32Array(portalCount);
  if (portalCount) {
    const r = makeReader(s.portals);
    let pa = 0;
    let pb = 0;
    for (let i = 0; i < portalCount; i += 1) {
      pa += r.v();
      pb += r.z();
      portalA[i] = pa;
      portalB[i] = pb;
    }
  }
  const covTest = header.coverage ? coverageTest(header.coverage, decodeCoverage(s.coverage, header.coverage.nx * header.coverage.ny)) : null;
  return { header, n, m, lat, lon, off, to, W, Ln, T, portalA, portalB, covers: covTest };
}
