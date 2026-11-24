// Etap 1 jednym poleceniem: pobranie, odczyt PRG, adresy, OSM, obszary, grafy, manifest, bramki, deploy do katalogu.
// Uzycie: node run_pipeline.mjs [--root=<katalog pipeline>] [--pylib=<dir>] [--work=<dir>] [--publish=<dir>]
//   [--prg=<zip>] [--pbf=<pbf>] [--skip-fetch] [--reuse-osm=<work z gotowym osm,graph>] [--reuse-prg=<work z gotowym prg,addr>]
//   [--prev=<liczniki>] [--stage-hook=<skrypt mjs dostajacy katalog work>] [--variants] [--tag=<nazwa>] [--no-deploy]
// Kontrakt deployu: `current` podmieniany przez rename dopiero po zielonych bramkach; padniety krok zostawia stare pliki.
// Jeden proces naraz. Priorytet i rdzenie ustawia run_low.ps1 albo runner; potomkowie je dziedzicza.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => {
  const a = process.argv.find((x) => x === `--${k}` || x.startsWith(`--${k}=`));
  if (!a) return d;
  return a.includes("=") ? a.slice(a.indexOf("=") + 1) : true;
};
const root = path.resolve(arg("root", path.join(here, "..")));
const tag = arg("tag", new Date().toISOString().slice(0, 10));
const dl = path.join(root, "dl");
const pylib = path.resolve(arg("pylib", path.join(root, "pylib")));
const work = path.resolve(arg("work", path.join(root, "build", `run-${tag}`)));
const publish = path.resolve(arg("publish", path.join(root, "build", "published")));
const prgZip = path.resolve(arg("prg", path.join(dl, "POLSKA.zip")));
const pbf = path.resolve(arg("pbf", path.join(dl, "poland.osm.pbf")));
const reuseOsm = arg("reuse-osm");
const reusePrg = arg("reuse-prg");
const stageHook = arg("stage-hook");
const python = process.env.PYTHON || "python";
const variants = arg("variants") ? ["--variants"] : [];
fs.mkdirSync(work, { recursive: true });
fs.mkdirSync(publish, { recursive: true });
const logDir = path.join(work, "logs");
fs.mkdirSync(logDir, { recursive: true });
const currentDir = path.join(publish, "current");
const prevDefault = fs.existsSync(path.join(currentDir, "counts.json")) ? path.join(currentDir, "counts.json") : path.join(here, "fixtures", "prev_counts_gml.json");
const prevFile = path.resolve(arg("prev", prevDefault));
const snapshot = (() => {
  const s = path.join(dl, "sources.json");
  if (!fs.existsSync(s)) return tag;
  const j = JSON.parse(fs.readFileSync(s, "utf8"));
  return `osm:${j.osm?.lastModified || "?"};prg:${j.prg?.fetchedAt || "?"}`;
})();

const timings = [];
const status = { tag, startedAt: new Date().toISOString(), steps: timings, deployed: false, failedStep: null, failedGates: [], prev: prevFile };
const statusFile = path.join(work, "run_status.json");
const save = () => fs.writeFileSync(statusFile, JSON.stringify(status, null, 1));

function step(name, cmd, args, resFile) {
  const t0 = Date.now();
  const log = fs.openSync(path.join(logDir, `${name}.log`), "w");
  const r = spawnSync(cmd, args, { stdio: ["ignore", log, log], env: { ...process.env, PYTHONIOENCODING: "utf8" }, windowsHide: true });
  fs.closeSync(log);
  const rec = { name, seconds: Math.round((Date.now() - t0) / 100) / 10, exit: r.status };
  if (resFile && fs.existsSync(resFile)) Object.assign(rec, JSON.parse(fs.readFileSync(resFile, "utf8")), { seconds: rec.seconds });
  timings.push(rec);
  save();
  console.log(`${r.status === 0 ? "ok  " : "FAIL"} ${name} ${rec.seconds} s${rec.peakRssMB ? `, RSS ${rec.peakRssMB} MB` : ""}`);
  if (r.status === 0) return;
  const text = fs.readFileSync(path.join(logDir, `${name}.log`), "utf8");
  status.failedStep = name;
  status.failedGates = [...text.matchAll(/^GATE:(\S+)/gm)].map((m) => m[1]);
  if (!status.failedGates.length) status.failedGates = [`crash:${name}`];
  status.tail = text.split("\n").slice(-6).join("\n").slice(-800);
  status.finishedAt = new Date().toISOString();
  save();
  console.log(`ZATRZYMANO: ${name}, bramki ${status.failedGates.join(",")}. Poprzednia publikacja bez zmian.`);
  process.exit(4);
}
const py = (script, ...a) => ["-I", path.join(here, script), ...a];
const node = (heap, script, ...a) => [`--max-old-space-size=${heap}`, path.join(here, script), ...a];

if (!arg("skip-fetch")) step("fetch", python, py("fetch.py", dl));
const dPrg = path.join(work, "prg");
const dAddr = path.join(work, "addr");
const dOsm = path.join(work, "osm");
const dGraph = path.join(work, "graph");
if (reusePrg) {
  for (const d of ["prg", "addr"]) fs.cpSync(path.join(reusePrg, d), path.join(work, d), { recursive: true });
} else {
  step("prg_read", python, py("prg_read.py", pylib, prgZip, dPrg), path.join(dPrg, "res.json"));
  step("addr_build", "node", node(3000, "addr_build.mjs", dPrg, dAddr, snapshot, ...variants), path.join(dAddr, "addr_build.res.json"));
}
if (arg("reuse-extract")) {
  // Gotowe wydzielenie OSM, ale grafy budowane od nowa (test uszkodzenia ways.bin).
  fs.cpSync(arg("reuse-extract"), dOsm, { recursive: true });
  step("graph_build", "node", node(6000, "graph_build.mjs", dOsm, path.join(dOsm, "areas.json"), dGraph), path.join(dGraph, "graph_build.res.json"));
} else if (reuseOsm) {
  for (const d of ["osm", "graph"]) fs.cpSync(path.join(reuseOsm, d), path.join(work, d), { recursive: true });
} else {
  step("osm_extract", python, py("osm_extract.py", pylib, pbf, dOsm), path.join(dOsm, "res.json"));
  // Plik indeksu zostaje zmapowany do konca procesu Python, wiec kasuje go dopiero krok nadrzedny.
  fs.rmSync(path.join(dOsm, "_nodes.idx"), { force: true });
  step("areas", python, py("areas.py", pylib, path.join(dOsm, "boundaries.json"), path.join(here, "areas_config.json"), path.join(dOsm, "areas.json"), snapshot));
  step("graph_build", "node", node(6000, "graph_build.mjs", dOsm, path.join(dOsm, "areas.json"), dGraph, ...variants), path.join(dGraph, "graph_build.res.json"));
}
step("manifest", "node", node(2000, "manifest.mjs", dAddr, dGraph, path.join(work, "stage"), path.join(dl, "sources.json"), snapshot));
if (stageHook) step("stage_hook", "node", [path.resolve(stageHook), work]);
step("gates", "node", node(5000, "gates.mjs", work, prevFile, path.join(here, "fixtures")), path.join(work, "gates.res.json"));

if (!arg("no-deploy")) {
  // Liczniki tej wersji staja sie odniesieniem nastepnej.
  const prg = JSON.parse(fs.readFileSync(path.join(dPrg, "prg_stats.json"), "utf8"));
  const graph = JSON.parse(fs.readFileSync(path.join(dGraph, "graph_stats.json"), "utf8"));
  const counts = { perPowiat: prg.perPowiat, perGmina: prg.perGmina, graphs: Object.fromEntries(graph.results.map((r) => [r.area, r.nodes])),
    bans: Object.fromEntries(graph.results.map((r) => [r.area, r.bans])), bufferM: graph.bufferM, bridges: graph.bridges, pairs: JSON.parse(fs.readFileSync(path.join(work, "pairs.json"), "utf8")) };
  const next = path.join(publish, "next");
  fs.rmSync(next, { recursive: true, force: true });
  fs.cpSync(path.join(work, "stage"), next, { recursive: true });
  fs.writeFileSync(path.join(next, "counts.json"), JSON.stringify(counts));
  const old = path.join(publish, "previous");
  fs.rmSync(old, { recursive: true, force: true });
  if (fs.existsSync(currentDir)) fs.renameSync(currentDir, old);
  fs.renameSync(next, currentDir);
  status.deployed = true;
}
status.finishedAt = new Date().toISOString();
save();
console.log(status.deployed ? `DEPLOY ok: ${currentDir}` : "koniec bez deployu");
