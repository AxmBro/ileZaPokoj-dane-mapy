// Krok 7: bramki jakosci. Dzialaja na plikach ze stage (tych, ktore poszlyby do publikacji), nie na danych posrednich.
// Uzycie: node --max-old-space-size=5000 gates.mjs <workDir> <prevCounts.json> <fixturesDir> [--only=a,b]
// Wyjscie: kod 0 = wszystkie zielone, 3 = cos padlo. Na stdout po jednej linii GATE:<nazwa> dla kazdej padnietej.
// Bramki czytaja adresy i grafy razem tylko do kontroli; nic stad nie trafia do plikow publikowanych.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { dist, hav, readJson, reportResources, rng, sha256, writeJson } from "./common.mjs";
import { createAddrIndex, decodeAddr, lookup } from "./addr_format.mjs";
import { decodeGraph } from "./graph_format.mjs";
import { keyOf, fold } from "./normalize.mjs";
import { createEdgeSearch } from "./edge_search.mjs";
import { buildSnap, locate, SNAP_MAX_M } from "./router.mjs";

const [work, prevFile, fixDir, ...opts] = process.argv.slice(2);
const only = opts.find((o) => o.startsWith("--only="))?.slice(7).split(",");
const stage = path.join(work, "stage");
const t0 = Date.now();
const LIMIT_FILE = 25 * 1024 * 1024;
const LIMIT_COUNT = 20000;
const EXPECTED_POWIATS = 380;
const MIN_POWIAT_RATE = 0.5;
const MAX_INPUT_AGE_DAYS = 45;
// Relacji restriction dla aut w Polsce jest ok. 43 tys. (2026-11); polowa tego = obciete wejscie.
const MIN_RESTRICTIONS = 20000;
// Bufor powiatu nad woda (Zalew Szczecinski) obejmuje drugi brzeg bez mostu w pliku; drogi samego powiatu pilnuje coverage-snap.
const MIN_SCC_POWIAT = 70;
// Nawrot kosztuje 20 s i skret o 180 stopni; legalne obejscie przez wezly tego samego skrzyzowania (3-metrowe laczniki) ok. 16 s.
const U_TURN_EXTRA_S = 25;
const TURN_SAMPLE = 500;
// Pomiar 387 obszarow (2026-11): najwiecej 0,31% - przejscie graniczne, gdzie jedyny wjazd z polskiej strony jest zakazany.
const MAX_LOST_SHARE = 0.01;
// Promien mniejszy niz odstep sasiednich mostow tej samej rzeki, wiekszy niz odstep dwoch jezdni i przesuniecie srodka po podziale drogi.
const BRIDGE_NEAR_M = 60;
const MAX_BRIDGES_LOST = 0.02;
const MIN_BRIDGES = 1000;
const rand = rng(20261107);

const prg = readJson(path.join(work, "prg", "prg_stats.json"));
const prev = readJson(prevFile);
const manifest = readJson(path.join(stage, "manifest.json"));
const boundaries = readJson(path.join(work, "osm", "boundaries.json"));
const addrStats = readJson(path.join(work, "addr", "addr_stats.json"));
const graphStats = readJson(path.join(work, "graph", "graph_stats.json"));
const gunzipFile = (name) => zlib.gunzipSync(fs.readFileSync(path.join(stage, name)));
const addrIndexFile = JSON.parse(gunzipFile("addr-index.json.gz"));
const placePowiats = new Map(addrIndexFile.places.map(([name, ...pw]) => [fold(name), pw.map((x) => x.split(":")[0])]));

// Wszystkie powiaty zdekodowane raz, z plikow stage. To tez jest kontrola, ze kazdy plik sie czyta.
let addrAll = null;
function loadAddr() {
  if (addrAll) return addrAll;
  addrAll = new Map();
  for (const r of addrStats.results) addrAll.set(r.area, createAddrIndex(decodeAddr(gunzipFile(r.file))));
  return addrAll;
}
const near = (r, lat, lon) => Math.min(...r.candidates.map((c) => hav(c.lat, c.lon, lat, lon)));
const RANK = { exact: 5, composite: 4, base: 3, street: 2, place: 1, none: 0 };
const queryAll = (q) => {
  const list = placePowiats.get(fold(q.place)) || [];
  let best = { status: "none", candidates: [] };
  // Ta sama nazwa miejscowosci w wielu powiatach: przy tym samym statusie wygrywa kandydat najblizszy `near`.
  const score = (r) => (q.near && r.candidates?.length ? near(r, q.near.lat, q.near.lon) : Infinity);
  for (const pw of list) {
    const r = lookup(loadAddr().get(pw), q);
    if (RANK[r.status] > RANK[best.status] || (RANK[r.status] === RANK[best.status] && RANK[r.status] > 0 && score(r) < score(best))) best = { ...r, powiat: pw };
  }
  return best;
};

function polygonTools(geo) {
  const polys = geo.type === "Polygon" ? [geo.coordinates] : geo.coordinates;
  const rings = polys.map((p) =>
    p.map((ring) => {
      let y0 = Infinity;
      let y1 = -Infinity;
      let x0 = Infinity;
      let x1 = -Infinity;
      for (const [x, y] of ring) {
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
      }
      return { ring, y0, y1, x0, x1 };
    }),
  );
  const inRing = (r, x, y) => {
    if (x < r.x0 || x > r.x1 || y < r.y0 || y > r.y1) return false;
    let c = false;
    const p = r.ring;
    for (let i = 0, j = p.length - 1; i < p.length; j = i, i += 1) {
      if (p[i][1] > y !== p[j][1] > y && x < ((p[j][0] - p[i][0]) * (y - p[i][1])) / (p[j][1] - p[i][1]) + p[i][0]) c = !c;
    }
    return c;
  };
  const test = (x, y) => {
    for (const poly of rings) {
      if (!inRing(poly[0], x, y)) continue;
      let hole = false;
      for (let i = 1; i < poly.length; i += 1) if (inRing(poly[i], x, y)) hole = true;
      if (!hole) return true;
    }
    return false;
  };
  // Odleglosc do pierscieni w metrach, lokalnie; tylko dla nielicznych punktow granicznych.
  const distM = (x, y) => {
    let best = Infinity;
    const c = Math.cos((y * Math.PI) / 180);
    for (const poly of rings) {
      for (const r of poly) {
        const p = r.ring;
        for (let i = 1; i < p.length; i += 1) {
          const ax = (p[i - 1][0] - x) * c;
          const ay = p[i - 1][1] - y;
          const bx = (p[i][0] - x) * c;
          const by = p[i][1] - y;
          const dx = bx - ax;
          const dy = by - ay;
          const den = dx * dx + dy * dy;
          let f = den > 0 ? -(ax * dx + ay * dy) / den : 0;
          f = f < 0 ? 0 : f > 1 ? 1 : f;
          const d = (ax + dx * f) ** 2 + (ay + dy * f) ** 2;
          if (d < best) best = d;
        }
      }
    }
    return Math.sqrt(best) * 111320;
  };
  return { test, distM };
}

// Adresy z prawdziwych ofert OLX (ulica + numer domu wynajmujacego) nie leza w publicznym repo: workflow zapisuje je
// z sekretu do `fixtures/private/`. Brak pliku na runnerze (CI) zatrzymuje publikacje, lokalnie bramka mowi, ze pominieta.
const PRIVATE_DIR = path.join(fixDir, "private");
const readPrivate = (name) => (fs.existsSync(path.join(PRIVATE_DIR, name)) ? readJson(path.join(PRIVATE_DIR, name)) : null);
const missingPrivate = (name) => ({ ok: !process.env.CI, info: `brak fixtures/private/${name} (sekret PRIVATE_FIXTURES)${process.env.CI ? "" : " - pominieta lokalnie"}` });

const gates = {};
const detail = {};
const gate = (name, catches, misses, fn) => {
  gates[name] = { catches, misses, fn };
};

gate("prg-total", "obciete albo podmienione wydanie krajowe", "zmiany mniejsze niz prog", () => {
  const keys = Object.keys(prev.perPowiat);
  const a = keys.reduce((s, k) => s + (prev.perPowiat[k] || 0), 0);
  const b = keys.reduce((s, k) => s + (prg.perPowiat[k] || 0), 0);
  const ratio = b / a;
  return { ok: ratio >= 0.98 && ratio <= 1.05, info: `${b} / ${a} = ${ratio.toFixed(5)} (powiaty w odniesieniu: ${keys.length})` };
});
gate("input-fresh", "stary snapshot PRG lub OSM, ponowna publikacja tych samych danych", "zrodlo zaktualizowane, ale z tresci starej", () => {
  const now = Date.now();
  const age = (d) => (now - new Date(d).getTime()) / 864e5;
  const prgAge = age(prg.dbfDate);
  const osmDate = manifest.sources?.osm?.lastModified;
  const osmAge = osmDate ? age(osmDate) : Infinity;
  return { ok: prgAge <= MAX_INPUT_AGE_DAYS && osmAge <= MAX_INPUT_AGE_DAYS, info: `PRG ${prg.dbfDate}: ${prgAge.toFixed(1)} dni, OSM ${osmDate}: ${osmAge.toFixed(1)} dni, limit ${MAX_INPUT_AGE_DAYS}` };
});
gate("powiat-complete", "brak powiatu lub gminy, puste miasto", "ubytek czesci punktow miasta przy zachowanej gminie", () => {
  const miss = Object.keys(prev.perPowiat).filter((k) => !prg.perPowiat[k]);
  const missG = Object.keys(prev.perGmina || {}).filter((k) => !prg.perGmina[k]);
  const n = Object.keys(prg.perPowiat).length;
  return { ok: n === EXPECTED_POWIATS && !miss.length && !missG.length, info: `powiaty ${n}/${EXPECTED_POWIATS}, brakujace ${miss.join(",") || "-"}, gminy brakujace ${missG.slice(0, 10).join(",") || "-"}` };
});
gate("powiat-delta", "nagly ubytek lub przyrost punktow w powiecie", "podmiana punktow przy tej samej liczbie, zmiana mniejsza niz -2%/+5%", () => {
  const bad = [];
  let worst = 0;
  for (const [k, v] of Object.entries(prev.perPowiat)) {
    const r = (prg.perPowiat[k] || 0) / v;
    if (Math.abs(r - 1) > Math.abs(worst)) worst = r - 1;
    if (r < 0.98 || r > 1.05) bad.push(`${k}:${r.toFixed(3)}`);
  }
  return { ok: !bad.length, info: `najwieksze odchylenie ${(worst * 100).toFixed(3)}%, poza progiem ${bad.length}: ${bad.slice(0, 8).join(" ")}` };
});
gate("prg-quality", "przesuniete kolumny, zepsute kodowanie, puste pola", "bledy w pojedynczych rekordach przy poprawnym formacie", () => {
  const share = prg.noStreet / prg.written;
  const bad = prg.badTeryt + prg.emptyNumber + prg.nullShape + prg.badUtf8 + prg.outOfBox;
  return { ok: bad / prg.declared < 0.0005 && share > 0.3 && share < 0.42 && prg.crcOk === true, info: `odrzucone ${bad}, bez ulicy ${(share * 100).toFixed(2)}%, CRC ${prg.crcOk}` };
});
gate("known-addr", "przesuniecie ukladu, zepsuty klucz, zgubione miasto", "blad pojedynczego adresu spoza fixture", () => {
  const list = [...readJson(path.join(fixDir, "known_addresses.json")), ...(readPrivate("known_addresses.json") || [])];
  const rows = list.map((a) => {
    const r = queryAll({ place: a.place, street: a.street, number: a.number });
    return { ...a, status: r.status, m: r.candidates?.length ? Math.round(near(r, a.lat, a.lon)) : null };
  });
  detail.knownAddresses = rows;
  const bad = rows.filter((r) => !["exact", "composite"].includes(r.status) || r.m === null || r.m > 100);
  return { ok: bad.length <= Math.floor(rows.length * 0.05), info: `${rows.length - bad.length}/${rows.length} w 100 m, max ${Math.max(...rows.map((r) => r.m ?? 0))} m; zle: ${bad.map((b) => `${b.street} ${b.number}:${b.status}:${b.m}`).join("; ") || "-"}` };
});
gate("offer-addr", "spadek trafien na realnym popycie", "precyzji: trafiony numer nie musi byc adresem oferty", () => {
  const list = readPrivate("offer_addresses.json");
  if (!list) return missingPrivate("offer_addresses.json");
  const c = {};
  for (const a of list) {
    const s = queryAll(a).status;
    c[s] = (c[s] || 0) + 1;
  }
  const hit = (c.exact || 0) + (c.composite || 0) + (c.base || 0);
  detail.offerAddresses = { total: list.length, ...c };
  return { ok: hit / list.length >= 0.85, info: `${hit}/${list.length} = ${((100 * hit) / list.length).toFixed(1)}% ${JSON.stringify(c)}` };
});
gate("osm-control", "przesuniecie punktow calego powiatu, utrata klucza ulicy", "OSM w Polsce jest czesciowo importem PRG, wiec bledy wspolne nie wyjda", () => {
  const rows = fs.readFileSync(path.join(work, "osm", "osm_addr_sample.ndjson"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const ds = [];
  const perPowiat = new Map();
  const rate = new Map();
  const c = { total: 0, noPlace: 0, exact: 0, composite: 0, base: 0, street: 0, place: 0, none: 0 };
  for (const a of rows) {
    const placeName = a.city || a.place;
    if (!placeName) {
      c.noPlace += 1;
      continue;
    }
    c.total += 1;
    const r = queryAll({ place: placeName, street: a.street || undefined, number: a.num, near: { lat: a.lat, lon: a.lon } });
    c[r.status] += 1;
    // Trafnosc per powiat tylko dla nazw miejscowosci jednoznacznych w kraju, inaczej nie wiadomo, kogo obciazyc.
    const only = placePowiats.get(fold(placeName));
    if (only?.length === 1) {
      const t = rate.get(only[0]) || [0, 0];
      t[0] += 1;
      if (r.status === "exact") t[1] += 1;
      rate.set(only[0], t);
    }
    if (r.status === "exact") {
      const m = near(r, a.lat, a.lon);
      ds.push(m);
      // Dalej niz 20 km to homonim miejscowosci, nie przesuniecie danych; duze przesuniecia lapia no-outside i powiat-contain.
      let list = perPowiat.get(r.powiat);
      if (!list) perPowiat.set(r.powiat, (list = []));
      if (m < 20000) list.push(m);
    }
  }
  const bad = [];
  for (const [k, list] of perPowiat) {
    if (list.length < 40) continue;
    const s = Float64Array.from(list).sort();
    const p50 = s[Math.floor(s.length * 0.5)];
    if (p50 > 40) bad.push(`${k}:${Math.round(p50)}`);
  }
  const d = dist(ds);
  const rates = [...rate.entries()].filter(([, t]) => t[0] >= 40).map(([k, t]) => [k, t[1] / t[0], t[0]]).sort((a, b) => a[1] - b[1]);
  const lowRate = rates.filter(([, r]) => r < MIN_POWIAT_RATE).map(([k, r]) => `${k}:${r.toFixed(2)}`);
  detail.osmControl = { counts: c, distanceM: d, powiatsChecked: [...perPowiat.values()].filter((l) => l.length >= 40).length, lowestRates: rates.slice(0, 15) };
  return { ok: c.exact / c.total >= 0.7 && d.p50 <= 20 && !bad.length && !lowRate.length, info: `exact ${c.exact}/${c.total} = ${((100 * c.exact) / c.total).toFixed(1)}%, p50 ${d.p50} m, p90 ${d.p90} m, p99 ${d.p99} m, powiaty z mediana > 40 m: ${bad.join(" ") || "-"}, najnizsza trafnosc powiatu ${rates[0]?.[0]} ${rates[0]?.[1]?.toFixed(2)}, ponizej progu: ${lowRate.slice(0, 6).join(" ") || "-"}` };
});
gate("no-outside", "zamiana osi, zly uklad wspolrzednych, punkty poza krajem", "przesuniecia mieszczace sie w granicach kraju", () => {
  const pl = boundaries.find((b) => b.lvl === "2");
  const pip = polygonTools(pl.geo);
  // Szybka akceptacja po siatce 0,05 stopnia: komorka w calosci w kraju nie wymaga testu punktu.
  const cell = 0.05;
  const [x0, y0, x1, y1] = pl.bbox;
  const nx = Math.ceil((x1 - x0) / cell);
  const ny = Math.ceil((y1 - y0) / cell);
  const inner = new Int8Array(nx * ny);
  const cellState = (cx, cy) => {
    const k = cy * nx + cx;
    if (inner[k]) return inner[k];
    const xa = x0 + cx * cell;
    const ya = y0 + cy * cell;
    let all = true;
    for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1], [0.5, 0.5], [0.5, 0], [0, 0.5], [1, 0.5], [0.5, 1]]) {
      if (!pip.test(xa + dx * cell, ya + dy * cell)) all = false;
    }
    inner[k] = all ? 1 : 2;
    return inner[k];
  };
  let outside = 0;
  let far = 0;
  let farMax = 0;
  let boxOut = 0;
  for (const idx of loadAddr().values()) {
    const { lat, lon, header } = idx.d;
    for (let i = 0; i < header.points; i += 1) {
      const cx = Math.floor((lon[i] - x0) / cell);
      const cy = Math.floor((lat[i] - y0) / cell);
      if (cx < 0 || cy < 0 || cx >= nx || cy >= ny) {
        boxOut += 1;
        far += 1;
        continue;
      }
      if (cellState(cx, cy) === 1 || pip.test(lon[i], lat[i])) continue;
      outside += 1;
      if (far > 1000) continue;
      const m = pip.distM(lon[i], lat[i]);
      if (m > farMax) farMax = m;
      if (m > 500) far += 1;
    }
  }
  detail.noOutside = { outsidePolygon: outside, farOver500m: far, boxOut, maxM: Math.round(farMax) };
  return { ok: far === 0, info: `punkty za uproszczona granica ${outside}, dalej niz 500 m: ${far}, poza bbox ${boxOut}, max ${Math.round(farMax)} m` };
});
gate("powiat-contain", "punkty przypisane do zlego powiatu, pomieszane wspolrzedne miedzy powiatami", "bledy wewnatrz powiatu", () => {
  const polys = new Map(boundaries.filter((b) => b.lvl === "6" && b.terc.length === 4).map((b) => [b.terc, polygonTools(b.geo)]));
  const bad = [];
  let tested = 0;
  let worst = 1;
  let worstPw = "";
  for (const [pw, idx] of loadAddr()) {
    const pip = polys.get(pw);
    if (!pip) {
      bad.push(`${pw}:brak granicy`);
      continue;
    }
    const { lat, lon, header } = idx.d;
    let inP = 0;
    let n = 0;
    for (let i = 0; i < header.points; i += 11) {
      n += 1;
      if (pip.test(lon[i], lat[i])) inP += 1;
    }
    tested += n;
    const r = inP / n;
    if (r < worst) {
      worst = r;
      worstPw = pw;
    }
    if (r < 0.97) bad.push(`${pw}:${r.toFixed(3)}`);
  }
  return { ok: !bad.length, info: `sprawdzone ${tested}, najgorszy powiat ${worstPw} ${(worst * 100).toFixed(2)}%, ponizej 97%: ${bad.slice(0, 8).join(" ") || "-"}` };
});
gate("roundtrip", "blad kodera, utrata punktow miedzy TSV a plikiem", "bledy juz obecne w TSV", () => {
  let inPts = 0;
  let outPts = 0;
  let miss = 0;
  let far = 0;
  let tested = 0;
  const examples = [];
  for (const r of addrStats.results) {
    inPts += r.inputPoints;
    outPts += loadAddr().get(r.area).d.header.points + r.dedup;
    const lines = fs.readFileSync(path.join(work, "prg", `${r.area}.tsv`), "utf8").split("\n").filter(Boolean);
    for (let k = 0; k < 60; k += 1) {
      const c = lines[Math.floor(rand() * lines.length)].split("\t");
      tested += 1;
      const q = { place: c[3], street: c[5] || undefined, number: c[6] };
      const res = lookup(loadAddr().get(r.area), q);
      if (res.status !== "exact") {
        miss += 1;
        if (examples.length < 5) examples.push(`${c[3]}|${c[5]}|${c[6]}:${res.status}`);
      } else if (near(res, Number(c[7]), Number(c[8])) > 5) far += 1;
    }
  }
  return { ok: inPts === outPts && miss === 0 && far === 0, info: `punkty ${outPts}/${inPts}, proba ${tested}, nietrafione ${miss}, dalej niz 5 m ${far}; ${examples.join("; ")}` };
});
gate("traps", "regresje obslugi pulapek formatu", "przypadkow spoza listy", () => {
  const w = loadAddr().get("1465");
  const k = loadAddr().get("1261");
  const results = [];
  const t = (name, ok, got) => results.push({ name, ok: Boolean(ok), got });
  const dup = lookup(w, { place: "Warszawa", street: "Szklarniowa", number: "16" });
  t("duplikat klucza zwraca 2 kandydatow i brak wyboru", dup.candidates.length === 2 && dup.ambiguous && !dup.chosen, `${dup.candidates.length}, ambiguous ${dup.ambiguous}`);
  const dupN = lookup(w, { place: "Warszawa", street: "Szklarniowa", number: "16", near: { lat: 52.33, lon: 21.02 } });
  t("pin OLX rozstrzyga duplikat", dupN.chosen && dupN.chosen.lat > 52.3, dupN.chosen?.lat);
  for (const form of ["ulica Marszałkowska", "ul. Marszałkowska", "Marszałkowska"]) {
    const r = lookup(w, { place: "Warszawa", street: form, number: "84/92" });
    t(`prefiks: ${form}`, r.status === "exact", r.status);
  }
  const c1 = lookup(w, { place: "Warszawa", street: "Marszałkowska", number: "84" });
  t("numer zlozony: pierwszy czlon 84 -> 84/92", c1.status === "composite" && c1.chosen?.num === "84/92", `${c1.status} ${c1.chosen?.num}`);
  const c2 = lookup(w, { place: "Warszawa", street: "Marszałkowska", number: "92" });
  t("numer zlozony: drugi czlon 92 -> 84/92", c2.status === "composite" && c2.chosen?.num === "84/92", `${c2.status} ${c2.chosen?.num}`);
  const c3 = lookup(w, { place: "Warszawa", street: "Marszałkowska", number: "86" });
  t("numer zlozony: srodek zakresu 86", c3.status === "composite", c3.status);
  const c4 = lookup(w, { place: "Warszawa", street: "Marszałkowska", number: "999" });
  t("zly numer nie daje innego numeru", c4.status === "street" && c4.numberMissing, c4.status);
  const b = lookup(k, { place: "Kraków", street: "Szewska", number: "10/3" });
  t("numer z lokalem 10/3 -> podstawa 10", b.status === "base" && b.chosen?.num === "10", `${b.status} ${b.chosen?.num}`);
  const os = ["Osiedle Piastów", "os. Piastów"].map((f) => lookup(k, { place: "Kraków", street: f, number: "1" }));
  t("osiedle: obie formy ten sam wynik", os[0].status === "exact" && os[1].status === "exact" && os[0].chosen?.lat === os[1].chosen?.lat, `${os[0].status}/${os[1].status}`);
  let letter = null;
  for (const g of k.d.groups) {
    if (letter || !k.d.streetNames[g.street]) continue;
    for (let i = g.start; i < g.start + g.count; i += 1) {
      const sf = k.d.sfxI[i] >= 0 ? k.d.sfxNames[k.d.sfxI[i]] : "";
      if (/^[a-z]$/.test(sf)) {
        letter = { street: k.d.streetNames[g.street], n: k.d.num[i], sf };
        break;
      }
    }
  }
  const l1 = lookup(k, { place: "Kraków", street: letter.street, number: `${letter.n}${letter.sf.toUpperCase()}` });
  const l2 = lookup(k, { place: "Kraków", street: letter.street, number: `${letter.n} ${letter.sf}` });
  t("numer z litera: 12A = 12 a", l1.status === "exact" && l2.status === "exact", `${letter.street} ${letter.n}${letter.sf}: ${l1.status}/${l2.status}`);
  // Ulica o tej samej nazwie w dwoch miejscowosciach gminy: klucz zawiera miejscowosc.
  let samePair = null;
  for (const [pw, ix] of loadAddr()) {
    const seen = new Map();
    for (const [pk, m] of ix.byPlace) {
      for (const sk of m.keys()) {
        if (!sk || samePair) continue;
        const key = `${ix.d.placeGm[m.get(sk)[0].place]}|${sk}`;
        if (seen.has(key) && seen.get(key) !== pk) samePair = { pw, sk, a: seen.get(key), b: pk };
        else seen.set(key, pk);
      }
    }
    if (samePair) break;
  }
  const sa = lookup(loadAddr().get(samePair.pw), { place: samePair.a, street: samePair.sk });
  const sb = lookup(loadAddr().get(samePair.pw), { place: samePair.b, street: samePair.sk });
  t("ta sama ulica w dwoch miejscowosciach gminy rozlaczona", sa.chosen && sb.chosen && hav(sa.chosen.lat, sa.chosen.lon, sb.chosen.lat, sb.chosen.lon) > 100, `${samePair.sk}: ${samePair.a} / ${samePair.b}`);
  // Miejscowosc bez ulic: numer pod sama nazwa miejscowosci.
  let noStreet = null;
  const ix = loadAddr().get("1206");
  for (const m of ix.byPlace.values()) {
    if (m.size === 1 && m.has("")) {
      const g = m.get("")[0];
      const i = g.start + Math.floor(g.count / 2);
      noStreet = { place: ix.d.placeNames[g.place], number: `${ix.d.num[i]}${ix.d.sfxI[i] >= 0 ? ix.d.sfxNames[ix.d.sfxI[i]] : ""}` };
      break;
    }
  }
  const ns = lookup(ix, noStreet);
  t("miejscowosc bez ulic: numer trafia", ns.status === "exact" && ns.streetless === true, `${noStreet.place} ${noStreet.number}: ${ns.status}`);
  const dl = lookup(k, { place: "Kraków", street: "Długa", number: "999" });
  t("Dluga 999 nie jest Dluga 9", dl.status === "street", dl.status);
  detail.traps = results;
  const bad = results.filter((r) => !r.ok);
  return { ok: !bad.length, info: `${results.length - bad.length}/${results.length}; zle: ${bad.map((x) => `${x.name} [${x.got}]`).join("; ") || "-"}` };
});
gate("street-key", "rozjazd normalizacji z kluczem produkcyjnym", "nazw spoza listy", () => {
  const pairs = readJson(path.join(fixDir, "street_keys.json"));
  const bad = pairs.filter(([a, b]) => keyOf(a) !== keyOf(b));
  return { ok: !bad.length, info: `${pairs.length - bad.length}/${pairs.length}` };
});

const GRAPH_LIST = graphStats.results.filter((r) => r.kind !== "coarse");
const prevGraph = prev.graphs || {};
gate("graph-sanity", "puste lub rozsypane miasto, ucieta siec, skok rozmiaru", "brak pojedynczej ulicy, zle kierunki, bledne limity predkosci", () => {
  const bad = [];
  // Inny bufor = inny wybor drog, wiec liczba wezlow nie mowi nic o ubytku; delta wraca od nastepnego wydania.
  const sameBuffer = (prev.bufferM ?? 3000) === graphStats.bufferM;
  for (const r of GRAPH_LIST) {
    if (r.nodes < 500 || r.sccMainPct < (r.kind === "powiat" ? MIN_SCC_POWIAT : 80) || !r.portals) bad.push(`${r.area}:nodes=${r.nodes},scc=${r.sccMainPct},portale=${r.portals}`);
    const p = prevGraph[r.area];
    if (p && sameBuffer && (r.nodes / p < 0.9 || r.nodes / p > 1.15)) bad.push(`${r.area}:wezly ${r.nodes} wobec ${p}`);
  }
  const worst = Math.min(...GRAPH_LIST.map((r) => r.sccMainPct));
  return { ok: !bad.length, info: `obszary ${GRAPH_LIST.length}, najnizszy SCC ${worst}%, bufor ${graphStats.bufferM} m${sameBuffer ? "" : " (zmieniony, delta wezlow pominieta)"}, zle: ${bad.slice(0, 8).join(" ") || "-"}` };
});

// Punkty kontrolne zasiegu; wspolrzedne reczne, orientacyjne, jak w weryfikacji sekcja D.
const COVER_POINTS = [
  { name: "Legionowo", lat: 52.4017, lon: 20.9264, area: "warszawa", expect: "out_of_file", alt: "aglo-warszawa" },
  { name: "Otwock", lat: 52.1059, lon: 21.2618, area: "warszawa", expect: "out_of_file", alt: "aglo-warszawa" },
  { name: "Lesznowola", lat: 52.0875, lon: 20.9503, area: "warszawa", expect: "out_of_file", alt: "aglo-warszawa" },
  { name: "Pruszków", lat: 52.1686, lon: 20.8036, area: "warszawa", expect: "out_of_file", alt: "aglo-warszawa" },
  { name: "Rynek Główny, Kraków", lat: 50.0617, lon: 19.9373, area: "krakow", expect: "ok", alt: null },
];
const runtime = new Map();
function rt(area) {
  if (!runtime.has(area)) {
    const g = decodeGraph(gunzipFile(`graph-${area}.bin.gz`));
    // Mutant dla falsify_graph.mjs: wyszukiwarka, ktora nie widzi zakazow.
    if (process.env.FALSIFY_IGNORE_BANS) g.hasBan?.fill(0);
    runtime.set(area, { g, snapper: buildSnap(g, area === "coarse" ? 1000 : 250), search: createEdgeSearch(g) });
    if (runtime.size > 3) runtime.delete(runtime.keys().next().value);
  }
  return runtime.get(area);
}
gate("coverage-snap", "ciche wyjscie poza plik, przesuniety graf wobec adresow", "punkty w zasiegu z dojazdem przez inna gmine", () => {
  const rows = [];
  for (const p of COVER_POINTS) {
    if (!GRAPH_LIST.some((r) => r.area === p.area)) continue;
    const a = rt(p.area);
    const loc = locate(a.g, a.snapper, p.lat, p.lon);
    const rawSnap = a.snapper.snap(p.lat, p.lon);
    const row = { name: p.name, file: p.area, status: loc.status, expect: p.expect, snapRawM: Math.round(rawSnap?.distM ?? -1) };
    if (p.alt && GRAPH_LIST.some((r) => r.area === p.alt)) {
      const b = rt(p.alt);
      const l2 = locate(b.g, b.snapper, p.lat, p.lon);
      row.altFile = p.alt;
      row.altStatus = l2.status;
      row.altSnapM = Math.round(l2.distM ?? -1);
    }
    rows.push(row);
  }
  detail.coverPoints = rows;
  const perArea = [];
  const allD = [];
  let inCov = 0;
  let inCovFar = 0;
  for (const r of GRAPH_LIST) {
    const a = rt(r.area);
    const ds = [];
    for (const pw of new Set(r.terc.map((t) => t.slice(0, 4)))) {
      const ix = loadAddr().get(pw);
      if (!ix) continue;
      const { lat, lon, header } = ix.d;
      const step = Math.max(1, Math.floor(header.points / 2000));
      for (let i = 0; i < header.points; i += step) {
        if (!a.g.covers(lat[i], lon[i])) continue;
        const s = a.snapper.snap(lat[i], lon[i]);
        inCov += 1;
        ds.push(s.distM);
        allD.push(s.distM);
        if (s.distM > SNAP_MAX_M) inCovFar += 1;
      }
    }
    const d = dist(ds);
    perArea.push({ area: r.area, n: d.n, p50: d.p50, p99: d.p99, max: d.max });
  }
  detail.snap = { all: dist(allD), perArea, snapMaxM: SNAP_MAX_M };
  const bad = rows.filter((x) => x.status !== x.expect);
  const farShare = inCovFar / (inCov || 1);
  return { ok: !bad.length && farShare <= 0.002, info: `punkty kontrolne ${rows.length - bad.length}/${rows.length}, adresy w zasiegu ${inCov}, snap p50 ${detail.snap.all.p50} m, p99 ${detail.snap.all.p99} m, p99.9 ${detail.snap.all.p999} m, ponad ${SNAP_MAX_M} m: ${inCovFar}` };
});
gate("graph-route", "rozspojnienie sieci po skroceniu, zly dekoder dlugosci", "dokladnosci trasy; to kontrola spojnosci, nie zgodnosc z routerem", () => {
  const ratios = [];
  let pairs = 0;
  let unreachable = 0;
  const bad = [];
  for (const r of GRAPH_LIST) {
    const a = rt(r.area);
    const pts = [];
    for (const pw of new Set(r.terc.map((t) => t.slice(0, 4)))) {
      const ix = loadAddr().get(pw);
      if (!ix) continue;
      const { lat, lon, header } = ix.d;
      for (let k = 0; k < 40; k += 1) {
        const i = Math.floor(rand() * header.points);
        if (a.g.covers(lat[i], lon[i])) pts.push([lat[i], lon[i]]);
      }
    }
    if (pts.length < 6) {
      bad.push(`${r.area}:za malo punktow`);
      continue;
    }
    for (let k = 0; k + 1 < pts.length && k < 40; k += 2) {
      const sa = a.snapper.snap(pts[k][0], pts[k][1]);
      const sb = a.snapper.snap(pts[k + 1][0], pts[k + 1][1]);
      a.search.run({ snap: sa });
      const res = a.search.read(sb);
      pairs += 1;
      if (!res) {
        unreachable += 1;
        continue;
      }
      const line = hav(pts[k][0], pts[k][1], pts[k + 1][0], pts[k + 1][1]);
      if (line > 500) ratios.push(res[1] / line);
    }
  }
  const d = dist(ratios, 3);
  detail.graphRoute = { pairs, unreachable, ratio: d };
  return { ok: unreachable === 0 && d.p50 >= 1.1 && d.p50 <= 1.8 && d.p99 < 6 && !bad.length, info: `pary ${pairs}, nieosiagalne ${unreachable}, trasa/linia p50 ${d.p50}, p99 ${d.p99}, max ${d.max}; ${bad.join(" ")}` };
});
// Zakazy skretu: liczba w pliku = liczba z budowy (zakaz z krawedzia spoza grafu wypada w dekoderze) i bez spadku m/m.
gate("turn-count", "zgubione zakazy: brak relacji w wejsciu, zle numery wezlow w pliku, pusty strumien", "pojedynczego zakazu usunietego z OSM", () => {
  const bad = [];
  const files = {};
  for (const r of graphStats.results) {
    const g = decodeGraph(gunzipFile(r.file));
    files[r.area] = g.banCount ?? 0;
    if (!g.bans || g.banCount !== r.bans) bad.push(`${r.area}:${g.banCount ?? "brak"} z ${r.bans}`);
  }
  const total = Object.values(files).reduce((a, b) => a + b, 0);
  const prevTotal = prev.bans && prev.bufferM === graphStats.bufferM ? Object.entries(prev.bans).reduce((a, [k, n]) => a + (k in files ? n : 0), 0) : 0;
  const compared = prevTotal ? Object.keys(prev.bans).reduce((a, k) => a + (files[k] ?? 0), 0) : 0;
  const { input, usable } = graphStats.restrictions;
  const share = usable / input;
  detail.turnCount = { total, prevTotal, compared, input, usable };
  return { ok: !bad.length && input >= MIN_RESTRICTIONS && share >= 0.8 && (!prevTotal || compared / prevTotal >= 0.95), info: `zakazy w plikach ${total}, wobec poprzednich ${prevTotal ? (compared / prevTotal).toFixed(3) : "-"}, relacje uzyte ${usable}/${input}, zle pliki: ${bad.slice(0, 6).join(" ") || "-"}` };
});
// Metoda Grasera (2014): trasa od srodka drogi wjazdu do srodka drogi wyjazdu nie moze byc zakazanym manewrem.
// Liczona wyszukiwarka wtyczki na pliku ze stage, wiec lapie tez blad algorytmu. 100%, bo to test kodu, nie danych.
gate("turn-legal", "zakazany manewr w trasie", "zakazu, ktorego nie ma w OSM", () => {
  let tested = 0;
  const bad = [];
  for (const r of graphStats.results) {
    const { g, search } = rt(r.area);
    const list = [...(g.bans || [])].flatMap(([e, outs]) => outs.filter((o) => g.rev[e] !== o).map((o) => [e, o]));
    const step = Math.max(1, Math.floor(list.length / TURN_SAMPLE));
    for (let i = 0; i < list.length; i += step) {
      const [e, o] = list[i];
      const half = (g.W[e] + g.W[o]) / 2;
      search.run({ snap: { e, f: 0.5, back: -1 }, limit: half + 30 });
      const res = search.read({ e: o, f: 0.5, back: -1 });
      tested += 1;
      const extra = res ? res[1] - (g.Ln[e] + g.Ln[o]) / 2 : Infinity;
      // Wprost = dlugosc manewru co do metra; do 10 m wiecej tylko nawrotem w kikucie. Reszta to legalne obejscie.
      if (extra < 1 || (extra <= 10 && res[2] - (g.T[e] + g.T[o]) / 2 >= U_TURN_EXTRA_S)) bad.push(`${r.area}:${e}-${o}`);
    }
  }
  return { ok: tested >= 1000 && !bad.length, info: `manewry ${tested}, zlamane ${bad.length} ${bad.slice(0, 6).join(" ")}` };
});
// Zakazy i brak zawracania nie moga odcinac drog, ktore bez nich byly osiagalne. Tylko zasieg pliku: przy krawedzi bufora
// jedyny legalny dojazd bywa poza plikiem, a user tam punktu nie ma.
gate("turn-reach", "zakazy odcinajace czesc miasta", "gorszej trasy przy zachowanej osiagalnosci", () => {
  const bad = [];
  let lost = 0;
  let all = 0;
  for (const r of GRAPH_LIST) {
    const { g, search } = rt(r.area);
    // Start z wezla o srodkowym numerze: skladowa glowna jest silnie spojna, wiec bez zakazow dochodzi wszedzie.
    search.run({ nodes: [[g.n >> 1, 0, 0, 0]] });
    let n = 0;
    let inside = 0;
    for (let u = 0; u < g.n; u += 1) {
      if (!g.covers(g.lat[u], g.lon[u])) continue;
      inside += 1;
      if (!search.node(u)) n += 1;
    }
    lost += n;
    all += inside;
    if (n / inside > MAX_LOST_SHARE) bad.push(`${r.area}:${((100 * n) / inside).toFixed(2)}%`);
  }
  return { ok: !bad.length, info: `wezly nieosiagalne ${lost}/${all} = ${((100 * lost) / all).toFixed(3)}%, ponad prog: ${bad.slice(0, 6).join(" ") || "-"}` };
});
// Most zgubiony = w poprzednim wydaniu byl, teraz zadnego dlugiego mostu w promieniu BRIDGE_NEAR_M. Pojedynczy bywa prawdziwy
// (remont, przebudowa), wiec tylko ostrzega miejscem; ubytek ponad MAX_BRIDGES_LOST to zepsute wejscie albo wandalizm.
gate("bridges", "utrata mostow: ucieta siec, wandalizm", "mostu krotszego niz 80 m i drogi lokalnej", () => {
  const cell = (la, lo) => `${Math.floor(la / 20)},${Math.floor(lo / 20)}`;
  const grid = new Map();
  for (const [la, lo] of graphStats.bridges) {
    const k = cell(la, lo);
    grid.set(k, [...(grid.get(k) || []), [la, lo]]);
  }
  const lost = (prev.bridges || []).filter(([la, lo]) => {
    for (let y = -1; y <= 1; y += 1) for (let x = -1; x <= 1; x += 1) {
      for (const [a, b] of grid.get(cell(la + y * 20, lo + x * 20)) || []) if (hav(la / 1e4, lo / 1e4, a / 1e4, b / 1e4) < BRIDGE_NEAR_M) return false;
    }
    return true;
  });
  const n = graphStats.bridges.length;
  const info = `mosty ${n}, poprzednio ${prev.bridges?.length ?? "-"}, zgubione ${lost.length}: ${lost.slice(0, 8).map(([a, b]) => `${a / 1e4},${b / 1e4}`).join(" ") || "-"}`;
  return { ok: n >= MIN_BRIDGES && lost.length <= MAX_BRIDGES_LOST * (prev.bridges?.length || 0), info: lost.length ? `ALARM ${info}` : info };
});
gate("coarse-portals", "rozjazd grafu zgrubnego z grafem miasta, siec krajowa w kawalkach", "gorsza trasa w kraju przy zachowanej spojnosci", () => {
  const rec = graphStats.results.find((r) => r.kind === "coarse");
  const c = rt("coarse");
  const bad = [];
  let portals = 0;
  let maxM = 0;
  for (const r of GRAPH_LIST) {
    const g = decodeGraph(gunzipFile(r.file));
    if (g.header.coarseSha !== rec.sha256) bad.push(`${r.area}:zly hash`);
    for (let i = 0; i < g.portalA.length; i += 1) {
      const u = g.portalA[i];
      const v = g.portalB[i];
      const m = hav(g.lat[u], g.lon[u], c.g.lat[v], c.g.lon[v]);
      if (m > maxM) maxM = m;
      portals += 1;
    }
  }
  const CHECK = [
    ["Warszawa-Kraków", 52.2297, 21.0122, 50.0647, 19.945, 295],
    ["Gdańsk-Rzeszów", 54.352, 18.6466, 50.0413, 21.999, 660],
    ["Szczecin-Białystok", 53.4285, 14.5528, 53.1325, 23.1688, 690],
  ];
  const rows = [];
  for (const [name, la, lo, lb, lp, km] of CHECK) {
    const sa = c.snapper.snap(la, lo);
    const sb = c.snapper.snap(lb, lp);
    let res = null;
    if (sa && sb) {
      c.search.run({ snap: sa });
      res = c.search.read(sb);
    }
    rows.push({ name, km: res ? Math.round(res[1] / 1000) : null, expectKm: km });
  }
  detail.coarseRoutes = rows;
  const badKm = rows.filter((r) => !r.km || r.km < r.expectKm * 0.8 || r.km > r.expectKm * 1.25);
  return { ok: rec.sccMainPct >= 90 && !bad.length && maxM < 2 && !badKm.length, info: `SCC ${rec.sccMainPct}%, portale ${portals}, maks. rozjazd ${maxM.toFixed(2)} m, trasy ${rows.map((r) => `${r.name} ${r.km} km`).join(", ")}; ${bad.slice(0, 5).join(" ")}` };
});
gate("file-limits", "plik ponad 25 MiB, ponad 20 000 plikow", "wzrost ponizej limitu", () => {
  const files = fs.readdirSync(stage);
  const sizes = files.map((f) => [f, fs.statSync(path.join(stage, f)).size]);
  const over = sizes.filter(([, s]) => s > LIMIT_FILE);
  const max = sizes.reduce((a, b) => (b[1] > a[1] ? b : a), ["", 0]);
  return { ok: !over.length && files.length <= LIMIT_COUNT, info: `plikow ${files.length}/${LIMIT_COUNT}, najwiekszy ${max[0]} ${max[1]} B, suma ${sizes.reduce((a, b) => a + b[1], 0)} B, ponad limit ${over.length}` };
});
gate("licence-separation", "plik z oboma zrodlami, zla atrybucja, skrypt budowy czytajacy drugie zrodlo", "wyciek przez reczna edycje poza skryptami", () => {
  const bad = [];
  const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  const src = (f) => fs.readFileSync(path.join(decodeURIComponent(here), f), "utf8");
  if (/ways\.bin|boundaries|osm_addr|node_flags/.test(src("addr_build.mjs") + src("addr_format.mjs"))) bad.push("kod budowy adresow czyta OSM");
  if (/\.tsv|prg_stats|addr_format/.test(src("graph_build.mjs") + src("graph_format.mjs"))) bad.push("kod budowy grafu czyta PRG");
  for (const f of manifest.files) {
    if (!f.name.endsWith(".bin.gz")) continue;
    const head = gunzipFile(f.name).subarray(0, 4).toString("latin1");
    if (f.name.startsWith("addr-") && (head !== "IZPA" || f.group !== "prg")) bad.push(f.name);
    if (f.name.startsWith("graph-") && (head !== "IZPG" || f.group !== "osm")) bad.push(f.name);
  }
  const a = decodeAddr(gunzipFile(addrStats.results[0].file)).header;
  const g = decodeGraph(gunzipFile(GRAPH_LIST[0].file)).header;
  if (/OpenStreetMap/.test(a.attribution) || !/Główny Urząd/.test(a.attribution)) bad.push("atrybucja addr");
  if (!/OpenStreetMap/.test(g.attribution) || /Rejestr/.test(g.attribution)) bad.push("atrybucja graph");
  return { ok: !bad.length, info: `pliki ${manifest.files.length}, zle: ${bad.slice(0, 5).join(", ") || "-"}` };
});
gate("manifest-integrity", "uszkodzony lub podmieniony plik po budowie", "bledy sprzed policzenia hasha", () => {
  const bad = manifest.files.filter((f) => {
    const p = path.join(stage, f.name);
    return !fs.existsSync(p) || sha256(fs.readFileSync(p)) !== f.sha256;
  });
  const extra = fs.readdirSync(stage).filter((f) => f !== "manifest.json" && !manifest.files.some((x) => x.name === f));
  return { ok: !bad.length && !extra.length, info: `pliki ${manifest.files.length}, niezgodne ${bad.length}, nadmiarowe ${extra.length}` };
});

const report = { startedAt: new Date().toISOString(), gates: [] };
let failed = 0;
for (const [name, g] of Object.entries(gates)) {
  if (only && !only.includes(name)) continue;
  const t1 = Date.now();
  let res;
  try {
    res = g.fn();
  } catch (e) {
    res = { ok: false, info: `wyjatek: ${e.message}` };
  }
  report.gates.push({ name, ok: res.ok, info: res.info, ms: Date.now() - t1, catches: g.catches, misses: g.misses });
  console.log(`${res.ok ? "OK  " : "FAIL"} ${name} (${Date.now() - t1} ms): ${res.info}`);
  if (!res.ok) {
    failed += 1;
    console.log(`GATE:${name}`);
  }
}
report.failed = failed;
report.detail = detail;
writeJson(path.join(work, "gates_report.json"), report);
reportResources(path.join(work, "gates.res.json"), { seconds: Math.round((Date.now() - t0) / 1000) });
process.exit(failed ? 3 : 0);
