// Test falsyfikujacy: psuje wejscie albo gotowe pliki i sprawdza, ze deploy sie zatrzymuje, a publikacja zostaje nietknieta.
// Uzycie: node falsify.mjs <root> <work udanego przebiegu> [--only=id,id]
// Kazdy scenariusz idzie przez prawdziwy run_pipeline.mjs. Wynik: results/falsify.json.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { sha256 } from "./common.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const [root, good, ...opts] = process.argv.slice(2);
const only = opts.find((o) => o.startsWith("--only="))?.slice(7).split(",");
const base = path.join(root, "build", "falsify");
const dl = path.join(root, "dl");
const publish = path.join(root, "build", "published");
const pylib = path.join(root, "pylib");
const prev = path.join(publish, "current", "counts.json");
fs.mkdirSync(base, { recursive: true });
const python = process.env.PYTHON || "python";
const out = path.join(root, "results", "falsify.json");
const results = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, "utf8")) : {};

const fingerprint = () => {
  const d = path.join(publish, "current");
  return sha256(Buffer.from(fs.readdirSync(d).sort().map((f) => `${f}:${fs.statSync(path.join(d, f)).size}:${fs.statSync(path.join(d, f)).mtimeMs}`).join("\n") + fs.readFileSync(path.join(d, "manifest.json"))));
};
function cutFile(src, dst, frac) {
  const size = fs.statSync(src).size;
  const fd = fs.openSync(src, "r");
  const w = fs.openSync(dst, "w");
  const buf = Buffer.allocUnsafe(1 << 22);
  let left = Math.floor(size * frac);
  while (left > 0) {
    const n = fs.readSync(fd, buf, 0, Math.min(left, buf.length));
    fs.writeSync(w, buf, 0, n);
    left -= n;
  }
  fs.closeSync(fd);
  fs.closeSync(w);
}
function flipMiddle(src, dst) {
  fs.copyFileSync(src, dst);
  const fd = fs.openSync(dst, "r+");
  fs.writeSync(fd, Buffer.alloc(4096, 0x5a), 0, 4096, 200 * 1024 * 1024);
  fs.closeSync(fd);
}
const prgMut = (name) => (dir) => {
  const dst = path.join(dir, "bad.zip");
  const r = spawnSync(python, ["-I", path.join(here, "falsify_prg.py"), pylib, path.join(dl, "POLSKA.zip"), dst, name], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`mutacja ${name}: ${r.stderr}`);
  return ["--prg=" + dst, "--reuse-osm=" + good];
};
const hook = (name) => () => ["--stage-hook=" + path.join(here, "falsify_hooks", `${name}.mjs`), "--reuse-osm=" + good, "--reuse-prg=" + good];

const SCENARIOS = {
  "zip-truncated": { expect: ["zip-integrity"], make: (dir) => {
    cutFile(path.join(dl, "POLSKA.zip"), path.join(dir, "bad.zip"), 0.6);
    return ["--prg=" + path.join(dir, "bad.zip"), "--reuse-osm=" + good];
  } },
  "zip-corrupt-middle": { expect: ["zip-integrity", "crash:prg_read"], make: (dir) => {
    flipMiddle(path.join(dl, "POLSKA.zip"), path.join(dir, "bad.zip"));
    return ["--prg=" + path.join(dir, "bad.zip"), "--reuse-osm=" + good];
  } },
  "col-renamed": { expect: ["prg-schema"], make: prgMut("rename-col") },
  "empty-city": { expect: ["powiat-complete"], make: prgMut("empty-city") },
  "partial-loss": { expect: ["powiat-delta"], make: prgMut("partial-loss") },
  "swap-axes": { expect: ["no-outside"], make: prgMut("swap-axes") },
  "shift-city-300m": { expect: ["osm-control"], make: prgMut("shift-city") },
  "shuffle-numbers": { expect: ["osm-control"], make: prgMut("shuffle-numbers") },
  "shuffle-streets": { expect: ["osm-control"], make: prgMut("shuffle-streets") },
  "pbf-truncated": { expect: ["osm-input", "crash:osm_extract"], make: (dir) => {
    cutFile(path.join(dl, "poland-latest.osm.pbf"), path.join(dir, "bad.pbf"), 0.6);
    return ["--pbf=" + path.join(dir, "bad.pbf"), "--reuse-prg=" + good];
  } },
  "oversize-file": { expect: ["file-limits"], make: hook("oversize") },
  "bitflip-after-build": { expect: ["manifest-integrity"], make: hook("bitflip") },
  "empty-graph-city": { expect: ["graph-sanity"], make: hook("empty_graph") },
  "wrong-coarse": { expect: ["coarse-portals"], make: hook("wrong_coarse") },
  "mixed-licence": { expect: ["licence-separation"], make: hook("mixed_licence") },
  "stale-input": { expect: ["input-fresh"], make: hook("stale") },
  // Spodziewane dziury: tu oczekiwany wynik to PRZESZLO, wiec bez deployu.
  "hole-loss-1pct": { hole: true, expect: [], make: prgMut("partial-loss-1pct") },
  "hole-shift-gmina": { hole: true, expect: [], make: prgMut("shift-gmina") },
  "hole-osm-lost-ways": { hole: true, expect: [], make: lostWays(7, 25) },
  "hole-osm-lost-residential": { hole: true, expect: [], make: lostWays(11, 50, 11) },
};
function lostWays(maxClass, every, minClass = 0) {
  return (dir) => {
    const src = path.join(good, "osm");
    const dst = path.join(dir, "osm");
    fs.cpSync(src, dst, { recursive: true });
    const raw = fs.readFileSync(path.join(dst, "ways.bin"));
    const parts = [];
    let cut = 0;
    let total = 0;
    // Usuwa co n-ta droge z zakresu klas (indeksy CLASSES z osm_extract.py), bez zmiany reszty wejscia.
    for (let p = 0, i = 0; p < raw.length; i += 1) {
      const k = raw.readUInt32LE(p + 14);
      const len = 18 + k * 16;
      total += 1;
      if (raw[p + 8] <= maxClass && raw[p + 8] >= minClass && i % every === 0) cut += 1;
      else parts.push(raw.subarray(p, p + len));
      p += len;
    }
    fs.writeFileSync(path.join(dst, "ways.bin"), Buffer.concat(parts));
    fs.writeFileSync(path.join(dir, "cut.txt"), `${cut}/${total}`);
    return ["--reuse-extract=" + dst, "--reuse-prg=" + good];
  };
}

for (const [id, sc] of Object.entries(SCENARIOS)) {
  if (only && !only.includes(id)) continue;
  const dir = path.join(base, id);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const t0 = Date.now();
  const before = fingerprint();
  let rec;
  try {
    const args = sc.make(dir);
    const r = spawnSync("node", [path.join(here, "run_pipeline.mjs"), `--root=${root}`, `--work=${path.join(dir, "work")}`, `--publish=${publish}`, `--pylib=${pylib}`, "--skip-fetch", `--prev=${prev}`, `--tag=${id}`, ...(sc.hole ? ["--no-deploy"] : []), ...args], { encoding: "utf8" });
    const st = JSON.parse(fs.readFileSync(path.join(dir, "work", "run_status.json"), "utf8"));
    const after = fingerprint();
    const stopped = !st.deployed && r.status !== 0;
    if (fs.existsSync(path.join(dir, "cut.txt"))) console.log("usuniete drogi", fs.readFileSync(path.join(dir, "cut.txt"), "utf8"));
    rec = {
      expect: sc.expect, exit: r.status, deployed: st.deployed, failedStep: st.failedStep, failedGates: st.failedGates, publicationUntouched: before === after,
      caughtByExpected: st.failedGates.some((g) => sc.expect.includes(g)), verdict: stopped && before === after ? "ZATRZYMANY" : "PRZESZLO", seconds: Math.round((Date.now() - t0) / 1000),
    };
    const rep = path.join(dir, "work", "gates_report.json");
    if (fs.existsSync(rep)) rec.gateLines = JSON.parse(fs.readFileSync(rep, "utf8")).gates.filter((g) => !g.ok).map((g) => `${g.name}: ${g.info}`.slice(0, 260));
    if (st.tail) rec.tail = st.tail.slice(-300);
  } catch (e) {
    rec = { expect: sc.expect, verdict: "BLAD_TESTU", error: String(e.message).slice(0, 400) };
  }
  results[id] = rec;
  fs.writeFileSync(out, JSON.stringify(results, null, 1));
  console.log(id, rec.verdict, rec.failedGates ?? rec.error, `${rec.seconds}s`);
  // Duze pliki scenariusza nie sa potrzebne po tescie; raport zostaje w results.
  fs.rmSync(dir, { recursive: true, force: true });
}
