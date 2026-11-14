// Hook falsyfikacji: plik ponad limit 25 MiB w stage, manifest zaktualizowany, wiec tylko limit moze to zlapac.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
const stage = path.join(process.argv[2], "stage");
const m = JSON.parse(fs.readFileSync(path.join(stage, "manifest.json"), "utf8"));
const f = m.files.find((x) => x.name === "graph-aglo-warszawa.bin.gz");
const buf = Buffer.concat([fs.readFileSync(path.join(stage, f.name)), crypto.randomBytes(26 * 1024 * 1024)]);
fs.writeFileSync(path.join(stage, f.name), buf);
f.size = buf.length;
f.sha256 = crypto.createHash("sha256").update(buf).digest("hex");
fs.writeFileSync(path.join(stage, "manifest.json"), JSON.stringify(m));
