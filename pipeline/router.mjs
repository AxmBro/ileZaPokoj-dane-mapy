// Trasa w jednym pliku grafu do bramek: snap z progiem, kontrola zasiegu i wyszukiwanie po krawedziach (edge_search.mjs).
// Kontrakt `locate`: nigdy nie zwraca cichego wyniku spoza pliku. Status: ok | out_of_file | no_road_nearby.
import { createEdgeSearch } from "./edge_search.mjs";

// Prog z pomiaru odleglosci punktow PRG od grafu; nadpisywalny, zeby bramka mogla sprawdzic czulosc.
export const SNAP_MAX_M = 1500;
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
        if (g.noSnap[e] || (u > v && hasEdge(v, u))) continue;
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

export function loadGraphRuntime(g, cellM = 250) {
  return { g, snapper: buildSnap(g, cellM), search: createEdgeSearch(g) };
}
