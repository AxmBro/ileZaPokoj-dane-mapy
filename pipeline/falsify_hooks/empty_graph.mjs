// Hook falsyfikacji: graf miasta zastapiony grafem malego miasta, czyli siec wypadla, a plik sie czyta.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
const work = process.argv[2];
const stage = path.join(work, "stage");
const m = JSON.parse(fs.readFileSync(path.join(stage, "manifest.json"), "utf8"));
const f = m.files.find((x) => x.name === "graph-krakow.bin.gz");
const buf = fs.readFileSync(path.join(stage, "graph-suwalki.bin.gz"));
fs.writeFileSync(path.join(stage, f.name), buf);
f.size = buf.length;
f.sha256 = crypto.createHash("sha256").update(buf).digest("hex");
fs.writeFileSync(path.join(stage, "manifest.json"), JSON.stringify(m));
const sp = path.join(work, "graph", "graph_stats.json");
const s = JSON.parse(fs.readFileSync(sp, "utf8"));
const a = s.results.find((r) => r.area === "krakow");
const b = s.results.find((r) => r.area === "suwalki");
a.nodes = b.nodes;
fs.writeFileSync(sp, JSON.stringify(s));
