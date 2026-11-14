// Hook falsyfikacji: wydanie PRG sprzed pol roku, reszta bez zmian.
import fs from "node:fs";
import path from "node:path";
const p = path.join(process.argv[2], "prg", "prg_stats.json");
const s = JSON.parse(fs.readFileSync(p, "utf8"));
s.dbfDate = "2026-05-01";
fs.writeFileSync(p, JSON.stringify(s));
