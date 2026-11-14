// Zapis prywatnych fixture bramek z sekretu `PRIVATE_FIXTURES` (JSON: { nazwa_pliku: zawartosc }) do fixtures/private/.
// To adresy z prawdziwych ofert OLX (ulica + numer domu wynajmujacego) - nie leza w publicznym repo.
// Brak sekretu = nic nie zapisuje; bramki `offer-addr` na runnerze (CI) wtedy padaja i publikacja zostaje stara.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "private");
const raw = process.env.PRIVATE_FIXTURES || "";
if (!raw) {
  console.log("brak sekretu PRIVATE_FIXTURES - bramki z prywatnymi adresami nie przejda na runnerze");
  process.exit(0);
}
const files = JSON.parse(raw);
fs.mkdirSync(dir, { recursive: true });
for (const [name, content] of Object.entries(files)) {
  if (!/^[a-z_]+\.json$/.test(name)) throw new Error(`niedozwolona nazwa pliku w sekrecie: ${name}`);
  fs.writeFileSync(path.join(dir, name), JSON.stringify(content));
  console.log(`fixtures/private/${name}: ${Array.isArray(content) ? content.length : "?"} wpisow`);
}
