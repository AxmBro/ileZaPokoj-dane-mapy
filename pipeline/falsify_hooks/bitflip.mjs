// Hook falsyfikacji: uszkodzenie bajtu po policzeniu hasha.
import fs from "node:fs";
import path from "node:path";
const p = path.join(process.argv[2], "stage", "graph-koszalin.bin.gz");
const b = fs.readFileSync(p);
b[Math.floor(b.length / 2)] ^= 0xff;
fs.writeFileSync(p, b);
