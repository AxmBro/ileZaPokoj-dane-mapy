// Test falsyfikujacy bramek grafu: psuje kopie plikow udanego przebiegu i sprawdza, ze pada oczekiwana bramka, a bez psucia
// ta sama bramka przechodzi. Bez pobierania i budowy adresow, wiec idzie tez na wycinku kraju.
// Uzycie: node falsify_graph.mjs <work udanego przebiegu> <counts.json tego przebiegu> <tmpDir>
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { gzip, packFile, readJson, rng, sha256, unpackFile, writeJson } from "./common.mjs";
import { decodeBans, decodeGraph, encodeBans, encodeCoverage } from "./graph_format.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const [good, counts, tmp] = process.argv.slice(2);
const stats0 = readJson(path.join(good, "graph", "graph_stats.json"));
const biggest = [...stats0.results].filter((r) => r.kind !== "coarse").sort((a, b) => b.nodes - a.nodes)[0];

function fresh(name) {
  const dir = path.join(tmp, name);
  fs.rmSync(dir, { recursive: true, force: true });
  for (const d of ["stage", "graph", "addr", "prg"]) if (fs.existsSync(path.join(good, d))) fs.cpSync(path.join(good, d), path.join(dir, d), { recursive: true, filter: (f) => !f.endsWith(".tsv") });
  fs.mkdirSync(path.join(dir, "osm"), { recursive: true });
  fs.copyFileSync(path.join(good, "osm", "boundaries.json"), path.join(dir, "osm", "boundaries.json"));
  return dir;
}
// Przepisuje strumienie pliku grafu w stage (i hash w manifescie).
function rewriteStreams(dir, rec, change) {
  const p = path.join(dir, "stage", rec.file);
  const raw = zlib.gunzipSync(fs.readFileSync(p));
  const { header, streams } = unpackFile(raw, "IZPG");
  const changed = change(streams, header, raw);
  delete header.streams;
  const buf = gzip(packFile("IZPG", header, { ...streams, ...changed }));
  fs.writeFileSync(p, buf);
  const mf = path.join(dir, "stage", "manifest.json");
  const m = readJson(mf);
  Object.assign(m.files.find((f) => f.name === rec.file), { size: buf.length, sha256: sha256(buf) });
  writeJson(mf, m);
}
function rewriteBans(dir, rec, change) {
  let triples;
  rewriteStreams(dir, rec, (streams, header, raw) => {
    triples = change(Array.from(decodeBans(streams.bans)), decodeGraph(raw));
    return { bans: encodeBans(triples) };
  });
  return triples.length / 3;
}
const editStats = (dir, fn) => {
  const p = path.join(dir, "graph", "graph_stats.json");
  const s = readJson(p);
  fn(s);
  writeJson(p, s);
};
const SCENARIOS = {
  "pusty-strumien": { gate: "turn-count", make: (dir) => rewriteBans(dir, biggest, () => []) },
  "zle-numery-wezlow": { gate: "turn-count", make: (dir) => rewriteBans(dir, biggest, (t) => t.map((x, i) => (i % 3 === 1 ? x + 1 : x))) },
  "ucieta-lista-relacji": { gate: "turn-count", make: (dir) => editStats(dir, (s) => { s.restrictions.input = 9000; s.restrictions.usable = 8800; }) },
  "relacje-bez-drog": { gate: "turn-count", make: (dir) => editStats(dir, (s) => { s.restrictions.usable = Math.round(s.restrictions.input * 0.5); }) },
  "spadek-zakazow": { gate: "turn-count", make: (dir) => {
    for (const r of stats0.results) {
      const left = rewriteBans(dir, r, (t) => t.slice(0, 3 * Math.floor(t.length / 3 * 0.9)));
      editStats(dir, (s) => { s.results.find((x) => x.area === r.area).bans = left; });
    }
  } },
  "wyszukiwarka-bez-zakazow": { gate: "turn-legal", env: { FALSIFY_IGNORE_BANS: "1" }, make: () => {} },
  "zakazy-odcinaja-miasto": { gate: "turn-reach", make: (dir) => {
    const rand = rng(5);
    const left = rewriteBans(dir, biggest, (t, g) => {
      const ins = Array.from({ length: g.n }, () => []);
      for (let u = 0; u < g.n; u += 1) for (let e = g.off[u]; e < g.off[u + 1]; e += 1) ins[g.to[e]].push(u);
      const seen = new Set();
      for (let i = 0; i < t.length; i += 3) seen.add(`${t[i]},${t[i + 1]},${t[i + 2]}`);
      for (let k = 0; k < g.n * 0.2; k += 1) {
        const v = Math.floor(rand() * g.n);
        for (const u of ins[v]) for (let e = g.off[v]; e < g.off[v + 1]; e += 1) {
          const key = `${u},${v},${g.to[e]}`;
          if (!seen.has(key)) t.push(u, v, g.to[e]);
          seen.add(key);
        }
      }
      return t;
    });
    editStats(dir, (s) => { s.results.find((x) => x.area === biggest.area).bans = left; });
  } },
  "zasieg-za-rzeka": { gate: "snap-side", make: (dir) => {
    for (const r of stats0.results) if (r.coverageCut) rewriteStreams(dir, r, (streams, h) => ({ coverage: encodeCoverage(new Uint8Array(h.coverage.nx * h.coverage.ny).fill(1)) }));
  } },
  "ubytek-mostow": { gate: "bridges", make: (dir) => editStats(dir, (s) => { s.bridges = s.bridges.filter((b, i) => i % 25); }) },
  "jeden-most-ostrzega": { gate: "bridges", expectOk: true, expectText: "ALARM", make: (dir) => editStats(dir, (s) => {
    const [la, lo] = s.bridges[100];
    s.bridges = s.bridges.filter(([a, b]) => Math.abs(a - la) > 12 || Math.abs(b - lo) > 18);
  }) },
  "inny-bufor-nie-psuje-delty": { gate: "graph-sanity", expectOk: true, prev: (c) => {
    c.bufferM = 3000;
    for (const k of Object.keys(c.graphs)) c.graphs[k] = Math.round(c.graphs[k] / 1.4);
  } },
  "ubytek-wezlow-przy-tym-samym-buforze": { gate: "graph-sanity", prev: (c) => {
    for (const k of Object.keys(c.graphs)) c.graphs[k] = Math.round(c.graphs[k] * 1.2);
  } },
};

function runGate(dir, gate, prevFile, env = {}) {
  const r = spawnSync("node", ["--max-old-space-size=5000", path.join(here, "gates.mjs"), dir, prevFile, path.join(here, "fixtures"), `--only=${gate}`], { encoding: "utf8", env: { ...process.env, ...env } });
  const line = r.stdout.split("\n").find((l) => l.includes(` ${gate} (`)) || r.stderr.slice(-300);
  return { ok: r.status === 0, line };
}
let bad = 0;
for (const gate of new Set(Object.values(SCENARIOS).map((s) => s.gate))) {
  const dir = fresh("kontrola");
  const r = runGate(dir, gate, counts);
  if (!r.ok) bad += 1;
  console.log(`${r.ok ? "ok  " : "BLAD"} kontrola ${gate}: ${r.line.slice(0, 220)}`);
}
for (const [name, sc] of Object.entries(SCENARIOS)) {
  const dir = fresh("scenariusz");
  const prevFile = path.join(tmp, "prev.json");
  const prev = readJson(counts);
  sc.prev?.(prev);
  writeJson(prevFile, prev);
  sc.make?.(dir);
  const r = runGate(dir, sc.gate, prevFile, sc.env);
  const pass = (sc.expectOk ? r.ok : !r.ok) && (!sc.expectText || r.line.includes(sc.expectText));
  if (!pass) bad += 1;
  console.log(`${pass ? "ok  " : "BLAD"} ${name} -> ${sc.gate} ${sc.expectOk ? "przechodzi" : "pada"}: ${r.line.slice(0, 220)}`);
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log(bad ? `FALSYFIKACJA: ${bad} nie zadzialalo` : "FALSYFIKACJA: wszystkie zgodnie z oczekiwaniem");
process.exit(bad ? 1 : 0);
