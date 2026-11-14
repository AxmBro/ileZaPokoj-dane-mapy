// Krok 6: zlozenie katalogu stage i manifestu z hashami. manifest.json nie niesie danych, tylko liste plikow.
// Mapy zasiegu OSM ida do graph-index, a bbox powiatow PRG do addr-index, zeby zaden plik nie laczyl obu licencji.
// Uzycie: node manifest.mjs <addrDir> <graphDir> <stageDir> <sources.json> <snapshot>
import fs from "node:fs";
import path from "node:path";
import { gzip, sha256, readJson, writeJson } from "./common.mjs";

const [addrDir, graphDir, stage, sourcesFile, snapshot] = process.argv.slice(2);
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
const addr = readJson(path.join(addrDir, "addr_stats.json"));
const graph = readJson(path.join(graphDir, "graph_stats.json"));
const files = [];
const add = (name, dir, group) => {
  const buf = fs.readFileSync(path.join(dir, name));
  fs.writeFileSync(path.join(stage, name), buf);
  files.push({ name, group, size: buf.length, sha256: sha256(buf) });
};
for (const r of addr.results) add(r.file, addrDir, "prg");
add(addr.index.file, addrDir, "prg");
for (const r of graph.results) add(r.file, graphDir, "osm");
const coarse = graph.results.find((r) => r.kind === "coarse");
const gi = {
  format: 1,
  snapshot: graph.snapshot,
  attribution: "OpenStreetMap contributors, ODbL 1.0",
  coarse: { file: coarse.file, sha256: coarse.sha256, nodes: coarse.nodes },
  areas: graph.results.filter((r) => r.kind !== "coarse").map((r) => ({ area: r.area, kind: r.kind, file: r.file, terc: r.terc, nodes: r.nodes, coverage: r.coverage })),
};
const giGz = gzip(Buffer.from(JSON.stringify(gi)));
fs.writeFileSync(path.join(stage, "graph-index.json.gz"), giGz);
files.push({ name: "graph-index.json.gz", group: "osm", size: giGz.length, sha256: sha256(giGz) });
const sources = fs.existsSync(sourcesFile) ? readJson(sourcesFile) : {};
writeJson(path.join(stage, "manifest.json"), {
  format: 1,
  snapshot,
  sources,
  licences: { prg: "Państwowy Rejestr Granic, GUGiK, CC BY 4.0", osm: "OpenStreetMap contributors, ODbL 1.0" },
  totals: { files: files.length + 1, bytes: files.reduce((a, f) => a + f.size, 0) },
  files,
});
console.log(`pliki ${files.length + 1}, bajty ${files.reduce((a, f) => a + f.size, 0)}`);
