// Hook falsyfikacji: graf zgrubny z innej wersji, czyli hash w plikach miast nie pasuje.
import fs from "node:fs";
import path from "node:path";
const sp = path.join(process.argv[2], "graph", "graph_stats.json");
const s = JSON.parse(fs.readFileSync(sp, "utf8"));
s.results.find((r) => r.kind === "coarse").sha256 = "0".repeat(64);
fs.writeFileSync(sp, JSON.stringify(s));
