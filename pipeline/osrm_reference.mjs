// Wzorzec tras: pliki ze stage wobec lokalnego OSRM na tym samym wycinku OSM. Tylko na runnerze (docker, osmium-tool).
// Uzycie: node osrm_reference.mjs <stageDir> <areas.json> <poland.osm.pbf> <tmpDir> <out.json> [--areas=N] [--month=RRRRMM]
// Obszary losuje miesiac (ziarno), po tyle samo z kazdego rodzaju, wiec z czasem przechodzi caly kraj bez listy miast.
// Wynik to alarm, nie blokada: OSRM ma inny profil (nawierzchnia, szerokosc, dojazdy) i te same dane OSM, wiec mierzy
// zgodnosc modeli, a nie prawde o jezdzie. Progi sa z pomiaru 2026-11 i maja zlapac skok, nie ocenic pojedyncza trase.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { execFileSync, spawn } from "node:child_process";
import { createAddrIndex, decodeAddr } from "./addr_format.mjs";
import { decodeGraph } from "./graph_format.mjs";
import { dist, hav, readJson, rng, writeJson } from "./common.mjs";
import { loadGraphRuntime } from "./router.mjs";

const [stage, areasFile, pbf, tmpArg, out, ...opts] = process.argv.slice(2);
const opt = (k, d) => opts.find((o) => o.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const IMAGE = "ghcr.io/project-osrm/osrm-backend:v26.11.0-debian";
const PORT = 5000;
const SOURCES = 30;
const TARGETS = 10;
const MAX_P50 = 1;
const MAX_P90 = 6;
const perKind = Number(opt("areas", "2"));
const month = Number(opt("month", new Date().toISOString().slice(0, 7).replace("-", "")));
const tmp = path.resolve(tmpArg);
fs.mkdirSync(tmp, { recursive: true });
const gunzip = (f) => zlib.gunzipSync(fs.readFileSync(path.join(stage, f)));
const index = JSON.parse(gunzip("graph-index.json.gz"));
const areas = readJson(areasFile).areas;
const rand = rng(month);
const kinds = new Map();
for (const a of index.areas) {
  const list = kinds.get(a.kind) || [];
  list.push(a);
  kinds.set(a.kind, list);
}
const picked = [];
for (const list of kinds.values()) {
  const pool = [...list].sort((a, b) => (a.area < b.area ? -1 : 1));
  for (let i = 0; i < perKind && pool.length; i += 1) picked.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]);
}
const bounds = (geo) => {
  const polys = geo.type === "Polygon" ? [geo.coordinates] : geo.coordinates;
  const b = [180, 90, -180, -90];
  for (const p of polys) for (const [x, y] of p[0]) {
    b[0] = Math.min(b[0], x);
    b[1] = Math.min(b[1], y);
    b[2] = Math.max(b[2], x);
    b[3] = Math.max(b[3], y);
  }
  return b.map((v) => +v.toFixed(5));
};
// Jeden przebieg po pliku kraju dla wszystkich wycinkow.
const cfg = { directory: tmp, extracts: picked.map((a) => ({ output: `${a.area}.osm.pbf`, bbox: bounds(areas.find((x) => x.slug === a.area).buffer) })) };
writeJson(path.join(tmp, "extracts.json"), cfg);
execFileSync("osmium", ["extract", "--overwrite", "-s", "complete_ways", "-c", path.join(tmp, "extracts.json"), pbf], { stdio: "inherit" });

const docker = (...a) => execFileSync("docker", ["run", "--rm", "-v", `${tmp}:/data`, IMAGE, ...a], { stdio: ["ignore", "ignore", "inherit"] });
const ask = async (a, b) => {
  const r = await fetch(`http://127.0.0.1:${PORT}/route/v1/driving/${a[1]},${a[0]};${b[1]},${b[0]}?overview=false`);
  const j = await r.json();
  return j.code === "Ok" ? { km: j.routes[0].distance / 1000, min: j.routes[0].duration / 60 } : null;
};
const ready = async () => {
  for (let i = 0; i < 60; i += 1) {
    try {
      await fetch(`http://127.0.0.1:${PORT}/nearest/v1/driving/19,52`);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error("osrm-routed nie wstal");
};
const results = [];
const errAll = [];
for (const a of picked) {
  const base = `/data/${a.area}.osrm`;
  docker("osrm-extract", "-p", "/opt/car.lua", `/data/${a.area}.osm.pbf`);
  docker("osrm-partition", base);
  docker("osrm-customize", base);
  const name = `osrm-${a.area}`;
  const server = spawn("docker", ["run", "--rm", "--name", name, "-p", `${PORT}:5000`, "-v", `${tmp}:/data`, IMAGE, "osrm-routed", "--algorithm", "mld", base], { stdio: "ignore" });
  try {
    await ready();
    const rt = loadGraphRuntime(decodeGraph(gunzip(a.file)));
    const pts = [];
    for (const pw of new Set(a.terc.map((t) => t.slice(0, 4)))) {
      const d = createAddrIndex(decodeAddr(gunzip(`addr-${pw}.bin.gz`))).d;
      for (let k = 0; k < 400; k += 1) {
        const i = Math.floor(rand() * d.header.points);
        if (rt.g.covers(d.lat[i], d.lon[i])) pts.push([d.lat[i], d.lon[i]]);
      }
    }
    const rows = [];
    for (let s = 0; s < SOURCES && pts.length; s += 1) {
      const from = pts[Math.floor(rand() * pts.length)];
      const sa = rt.snapper.snap(from[0], from[1]);
      if (!sa) continue;
      rt.search.run({ snap: sa });
      for (let t = 0; t < TARGETS; t += 1) {
        const to = pts[Math.floor(rand() * pts.length)];
        if (hav(from[0], from[1], to[0], to[1]) < 500) continue;
        const sb = rt.snapper.snap(to[0], to[1]);
        const r = sb && rt.search.read(sb);
        const o = await ask(from, to);
        if (r && o && o.km > 0.5) rows.push({ from, to, km: r[1] / 1000, min: r[2] / 60, osrmKm: o.km, osrmMin: o.min });
      }
    }
    const err = rows.map((r) => (100 * Math.abs(r.km - r.osrmKm)) / r.osrmKm);
    const min = rows.map((r) => (100 * (r.min - r.osrmMin)) / r.osrmMin);
    errAll.push(...err);
    // Wszystkie pary w raporcie: kolejny wariant algorytmu liczy sie na nich bez nowego przebiegu OSRM.
    const pairs = rows.map((r) => [...r.from, ...r.to, +r.km.toFixed(3), +r.min.toFixed(2), +r.osrmKm.toFixed(3), +r.osrmMin.toFixed(2)]);
    const rec = { area: a.area, kind: a.kind, km: dist(err, 2), minSigned: dist(min, 2), over5: +((100 * err.filter((e) => e > 5).length) / err.length).toFixed(1), pairs };
    results.push(rec);
    console.log(`${a.area} (${a.kind}): pary ${rec.km.n}, km p50 ${rec.km.p50}% p90 ${rec.km.p90}% max ${rec.km.max}%, ponad 5%: ${rec.over5}%, czas p50 ${rec.minSigned.p50}%`);
  } finally {
    try {
      execFileSync("docker", ["stop", name], { stdio: "ignore" });
    } catch {
      server.kill();
    }
    await new Promise((r) => setTimeout(r, 2000));
    for (const f of fs.readdirSync(tmp)) if (f.startsWith(`${a.area}.`)) fs.rmSync(path.join(tmp, f), { force: true });
  }
}
const all = dist(errAll, 2);
const alarm = all.p50 > MAX_P50 || all.p90 > MAX_P90;
fs.writeFileSync(out, JSON.stringify({ image: IMAGE, month, all, alarm, results }));
console.log(`${alarm ? "ALARM" : "OK"} wzorzec OSRM: pary ${all.n}, km p50 ${all.p50}% (prog ${MAX_P50}), p90 ${all.p90}% (prog ${MAX_P90}), p99 ${all.p99}%, max ${all.max}%`);
if (alarm && process.env.GITHUB_ACTIONS) console.log(`::warning title=Wzorzec tras::km p50 ${all.p50}%, p90 ${all.p90}%`);
