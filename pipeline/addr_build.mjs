// Krok 4: budowa plikow `addr-<powiat>` i indeksu miejscowosci z TSV PRG. Wejscie wylacznie z PRG.
// Uzycie: node addr_build.mjs <prgDir> <outDir> <snapshot> [--variants]
// Wynik: addr-<TERYT>.bin.gz, addr-index.json.gz (miejscowosc -> powiaty), addr_stats.json.
import fs from "node:fs";
import path from "node:path";
import { gzip, sha256, writeJson, reportResources } from "./common.mjs";
import { encodeAddr } from "./addr_format.mjs";
import { fold } from "./normalize.mjs";

const [prgDir, outDir, snapshot, ...opts] = process.argv.slice(2);
const variants = opts.includes("--variants");
const t0 = Date.now();
fs.mkdirSync(outDir, { recursive: true });
const attribution = "Państwowy Rejestr Granic, Główny Urząd Geodezji i Kartografii, CC BY 4.0";
const files = fs.readdirSync(prgDir).filter((f) => /^\d{4}\.tsv$/.test(f)).sort();
const results = [];
const placeIndex = new Map();
let variantGzip = 0;
for (const f of files) {
  const area = f.slice(0, 4);
  const records = [];
  let minLat = 90;
  let maxLat = -90;
  let minLon = 180;
  let maxLon = -180;
  for (const line of fs.readFileSync(path.join(prgDir, f), "utf8").split("\n")) {
    if (!line) continue;
    const c = line.split("\t");
    const lat = Number(c[7]);
    const lon = Number(c[8]);
    records.push({ gmina: c[0], gminaName: c[1], simc: c[2], place: c[3], street: c[5], num: c[6], lat, lon });
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
  }
  const bbox = [minLon, minLat, maxLon, maxLat];
  const enc = encodeAddr(records, { format: 1, area, snapshot, attribution, bbox });
  const gz = gzip(enc.file);
  const name = `addr-${area}.bin.gz`;
  fs.writeFileSync(path.join(outDir, name), gz);
  results.push({ file: name, area, inputPoints: records.length, points: enc.points, dedup: enc.dedup, places: enc.places, streets: enc.streets, groups: enc.groups, raw: enc.file.length, gzip: gz.length, sha256: sha256(gz), bbox });
  for (const r of records) {
    const k = fold(r.place);
    let s = placeIndex.get(k);
    if (!s) placeIndex.set(k, (s = { name: r.place, pw: new Map() }));
    s.pw.set(area, (s.pw.get(area) || 0) + 1);
  }
  if (variants) variantGzip += gzip(encodeAddr(records, { format: 1, area, snapshot, attribution, bbox }, 1e4).file).length;
}
// Nazwa miejscowosci nie jest unikalna w kraju ("Krakow" to tez wies), wiec powiaty ida od najwiekszej liczby punktow.
const index = [...placeIndex.values()].map((v) => [v.name, ...[...v.pw].sort((a, b) => b[1] - a[1]).map(([pw, n]) => `${pw}:${n}`)]).sort((a, b) => (a[0] < b[0] ? -1 : 1));
// bbox powiatu z punktow PRG: klient wybiera plik po pinie OLX bez pobierania adresow.
const powiats = Object.fromEntries(results.map((r) => [r.area, { bbox: r.bbox.map((v) => Math.round(v * 1e4) / 1e4), points: r.points }]));
const idxGz = gzip(Buffer.from(JSON.stringify({ format: 1, snapshot, attribution, places: index, powiats })));
fs.writeFileSync(path.join(outDir, "addr-index.json.gz"), idxGz);
writeJson(path.join(outDir, "addr_stats.json"), {
  snapshot, results, index: { places: index.length, gzip: idxGz.length, sha256: sha256(idxGz), file: "addr-index.json.gz" }, variantPrecision1e4Gzip: variants ? variantGzip : null,
});
reportResources(path.join(outDir, "addr_build.res.json"), { seconds: Math.round((Date.now() - t0) / 1000) });
console.log(`powiaty ${results.length}, punkty ${results.reduce((a, r) => a + r.points, 0)}, gzip ${results.reduce((a, r) => a + r.gzip, 0)}, indeks ${idxGz.length}, ${Date.now() - t0} ms`);
