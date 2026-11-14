// Hook falsyfikacji: plik adresow podmieniony na graf pod nazwa addr, czyli OSM w grupie PRG.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
const stage = path.join(process.argv[2], "stage");
const m = JSON.parse(fs.readFileSync(path.join(stage, "manifest.json"), "utf8"));
const f = m.files.find((x) => x.name === "addr-2264.bin.gz");
const buf = fs.readFileSync(path.join(stage, "graph-koszalin.bin.gz"));
fs.writeFileSync(path.join(stage, f.name), buf);
f.sha256 = crypto.createHash("sha256").update(buf).digest("hex");
f.size = buf.length;
fs.writeFileSync(path.join(stage, "manifest.json"), JSON.stringify(m));
