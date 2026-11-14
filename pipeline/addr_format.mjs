// Format pliku `addr-<powiat>` (magia IZPA) i odczyt adresu. Tylko dane PRG (GUGiK), nigdy OSM.
// Hierarchia: miejscowosc -> ulica (lub brak ulicy) -> numery posortowane po czesci liczbowej i sufiksie.
// Klucz (miejscowosc, ulica, numer) NIE jest unikalny: Warszawa ma te same pary w dwoch dzielnicach pod jednym
// ID_ULIC i bez kodu dzielnicy w PRG. Dlatego punkt z duplikatem zostaje, a odczyt zwraca wszystkich kandydatow.
import { ByteWriter, makeReader, packFile, unpackFile, hav } from "./common.mjs";
import { fold, keyOf, parseNumber, compositeOf } from "./normalize.mjs";

// records: [{ gmina, gminaName, simc, place, street, num, lat, lon }]
export function encodeAddr(records, header, precision = 1e5) {
  const gminas = [...new Map(records.map((r) => [r.gmina, r.gminaName])).entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const gmIdx = new Map(gminas.map((g, i) => [g[0], i]));
  const placeKey = (r) => `${r.place}\t${r.gmina}\t${r.simc}`;
  const placeList = [...new Set(records.map(placeKey))].sort((a, b) => (a < b ? -1 : 1));
  const placeIdx = new Map(placeList.map((p, i) => [p, i]));
  const streetList = [...new Set(records.map((r) => r.street))].sort((a, b) => (a < b ? -1 : 1));
  const streetIdx = new Map(streetList.map((s, i) => [s, i]));
  const groups = new Map();
  for (const r of records) {
    const k = placeIdx.get(placeKey(r)) * 2097152 + streetIdx.get(r.street);
    let g = groups.get(k);
    if (!g) groups.set(k, (g = []));
    const p = parseNumber(r.num);
    g.push({ n: p.n, sfx: p.sfx, lat: Math.round(r.lat * precision), lon: Math.round(r.lon * precision) });
  }
  const sfxCount = new Map();
  for (const g of groups.values()) for (const v of g) sfxCount.set(v.sfx, (sfxCount.get(v.sfx) || 0) + 1);
  sfxCount.delete("");
  const sfxList = [...sfxCount.keys()].sort((a, b) => sfxCount.get(b) - sfxCount.get(a) || (a < b ? -1 : 1));
  const sfxIdx = new Map(sfxList.map((s, i) => [s, i]));
  const placeGm = new ByteWriter();
  for (const p of placeList) placeGm.varint(gmIdx.get(p.split("\t")[1]));
  const grp = new ByteWriter();
  const nums = new ByteWriter();
  const sfx = new ByteWriter();
  const lat = new ByteWriter();
  const lon = new ByteWriter();
  let pPlace = 0;
  let pLat = 0;
  let pLon = 0;
  let dedup = 0;
  let points = 0;
  // Ten sam numer w odleglosci do ok. 2 m to duplikat zapisu, nie drugi budynek.
  const near = 2e-5 * precision;
  for (const k of [...groups.keys()].sort((a, b) => a - b)) {
    const place = Math.floor(k / 2097152);
    const street = k % 2097152;
    const list = groups.get(k);
    list.sort((a, b) => a.n - b.n || (a.sfx < b.sfx ? -1 : a.sfx > b.sfx ? 1 : 0) || a.lat - b.lat || a.lon - b.lon);
    const uniq = [];
    for (const v of list) {
      const u = uniq[uniq.length - 1];
      if (u && u.n === v.n && u.sfx === v.sfx && Math.abs(u.lat - v.lat) <= near && Math.abs(u.lon - v.lon) <= near * 1.5) dedup += 1;
      else uniq.push(v);
    }
    grp.varint(place - pPlace);
    pPlace = place;
    grp.varint(street);
    grp.varint(uniq.length);
    let prev = 0;
    for (const v of uniq) {
      const hasSfx = v.sfx !== "";
      nums.varint((v.n - prev) * 2 + (hasSfx ? 1 : 0));
      prev = v.n;
      if (hasSfx) sfx.varint(sfxIdx.get(v.sfx));
      lat.zigzag(v.lat - pLat);
      lon.zigzag(v.lon - pLon);
      pLat = v.lat;
      pLon = v.lon;
      points += 1;
    }
  }
  const text = (a) => Buffer.from(a.join("\n"), "utf8");
  const file = packFile(
    "IZPA",
    { ...header, precision, gminas, places: placeList.length, streetNames: streetList.length, sfx: sfxList.length, groups: groups.size, points },
    {
      placeNames: text(placeList.map((p) => p.split("\t")[0])), placeSimc: text(placeList.map((p) => p.split("\t")[2])), placeGm: placeGm.done(),
      streetNames: text(streetList), sfxNames: text(sfxList), grp: grp.done(), nums: nums.done(), sfx: sfx.done(), lat: lat.done(), lon: lon.done(),
    },
  );
  return { file, points, dedup, groups: groups.size, places: placeList.length, streets: streetList.length };
}

export function decodeAddr(buf) {
  const { header, streams: s } = unpackFile(buf, "IZPA");
  // Lista ulic zawsze zawiera pusta nazwe (miejscowosc bez ulic) tylko, gdy taka jest w danych; split zachowuje pusty wpis.
  const lines = (b) => b.toString("utf8").split("\n");
  const placeNames = lines(s.placeNames);
  const streetNames = lines(s.streetNames);
  const sfxNames = lines(s.sfxNames);
  const rg = makeReader(s.placeGm);
  const placeGm = placeNames.map(() => rg.v());
  const g = makeReader(s.grp);
  const rn = makeReader(s.nums);
  const rs = makeReader(s.sfx);
  const rla = makeReader(s.lat);
  const rlo = makeReader(s.lon);
  const P = header.points;
  const num = new Int32Array(P);
  const sfxI = new Int32Array(P);
  const lat = new Float64Array(P);
  const lon = new Float64Array(P);
  const groups = [];
  let place = 0;
  let a = 0;
  let b = 0;
  let p = 0;
  for (let i = 0; i < header.groups; i += 1) {
    place += g.v();
    const street = g.v();
    const count = g.v();
    groups.push({ place, street, start: p, count });
    let prev = 0;
    for (let k = 0; k < count; k += 1) {
      const v = rn.v();
      const n = prev + Math.floor(v / 2);
      prev = n;
      num[p] = n;
      sfxI[p] = v & 1 ? rs.v() : -1;
      a += rla.z();
      b += rlo.z();
      lat[p] = a / header.precision;
      lon[p] = b / header.precision;
      p += 1;
    }
  }
  if (p !== P) throw new Error(`liczba punktow po dekodowaniu ${p} != ${P}`);
  return { header, placeNames, streetNames, sfxNames, placeGm, groups, num, sfxI, lat, lon };
}

// Indeks odczytu: miejscowosc -> klucz ulicy -> grupy. Pusty klucz ulicy = miejscowosc bez ulic.
export function createAddrIndex(d) {
  const byPlace = new Map();
  for (const g of d.groups) {
    const pk = fold(d.placeNames[g.place]);
    let m = byPlace.get(pk);
    if (!m) byPlace.set(pk, (m = new Map()));
    const sk = keyOf(d.streetNames[g.street]);
    let list = m.get(sk);
    if (!list) m.set(sk, (list = []));
    list.push(g);
  }
  return { d, byPlace };
}

function pointOf(d, g, i, status) {
  return { status, lat: d.lat[i], lon: d.lon[i], num: `${d.num[i] || ""}${d.sfxI[i] >= 0 ? d.sfxNames[d.sfxI[i]] : ""}`, street: d.streetNames[g.street], place: d.placeNames[g.place] };
}
// Skupiska punktow ulicy: dwie Szklarniowe w Warszawie to dwa fragmenty o kilkanascie km od siebie.
function clusters(points, gapM = 1500) {
  const out = [];
  for (const p of points) {
    const c = out.find((x) => hav(x.lat, x.lon, p.lat, p.lon) < gapM);
    if (c) {
      c.count += 1;
      c.lat += (p.lat - c.lat) / c.count;
      c.lon += (p.lon - c.lon) / c.count;
    } else out.push({ lat: p.lat, lon: p.lon, count: 1 });
  }
  return out;
}
function streetGroups(m, street) {
  const key = keyOf(street);
  const hit = m.get(key);
  if (hit) return { groups: hit, match: "exact" };
  if (key.length >= 4) {
    // Nazwisko bez imienia: "Mickiewicza" -> "Adama Mickiewicza"; dwa rozne pelne klucze = niejednoznaczne.
    const suffix = ` ${key}`;
    const found = [...m.keys()].filter((k) => k.endsWith(suffix));
    if (found.length === 1) return { groups: m.get(found[0]), match: "suffix" };
    if (found.length > 1) return { groups: found.flatMap((k) => m.get(k)), match: "suffix_ambiguous" };
  }
  return null;
}
// Kolejnosc wyboru jak `exact_number` UUG: numer dokladny, potem budynek zlozony, potem podstawa numeru z lokalem.
// Nigdy nie zwraca innego numeru na podstawie wspolnego poczatku: "Dluga 999" to nie "Dluga 9".
function findNumber(d, groups, query) {
  const q = parseNumber(query);
  const comp = compositeOf(q);
  const exact = [];
  const composite = [];
  const base = [];
  for (const g of groups) {
    for (let i = g.start; i < g.start + g.count; i += 1) {
      const n = d.num[i];
      const sfx = d.sfxI[i] >= 0 ? d.sfxNames[d.sfxI[i]] : "";
      if (n === q.n && sfx === q.sfx) {
        exact.push([g, i]);
        continue;
      }
      const c = compositeOf({ n, sfx });
      if (c && !q.sfx) {
        // Zapytanie 84, 92 lub 86 przy budynku 84/92: oba konce, a miedzy nimi ta sama parzystosc i rozpietosc do 10.
        const span = c.b - c.a;
        if (q.n === c.a || q.n === c.b) composite.push([g, i]);
        else if (span > 0 && span <= 10 && q.n > c.a && q.n < c.b && (q.n - c.a) % 2 === 0) composite.push([g, i]);
      }
      if (comp && n === comp.a && sfx === comp.aSfx) base.push([g, i]);
    }
  }
  if (exact.length) return { list: exact, status: "exact" };
  if (composite.length) return { list: composite, status: "composite" };
  if (base.length) return { list: base, status: "base" };
  return null;
}

// query: { place, street?, number?, near?: {lat, lon} }. Wynik: { status, candidates, ambiguous, chosen }.
// status: exact | composite | base | street | place | none. `near` (np. pin OLX) rozstrzyga kandydatow z duplikatu klucza.
export function lookup(index, query) {
  const { d, byPlace } = index;
  const m = byPlace.get(fold(query.place));
  if (!m) return { status: "none", reason: "place", candidates: [] };
  const byNear = (list) => [...list].sort((a, b) => hav(a.lat, a.lon, query.near.lat, query.near.lon) - hav(b.lat, b.lon, query.near.lat, query.near.lon))[0];
  const finish = (status, candidates, extra = {}) => {
    const spread = candidates.length > 1 && clusters(candidates).length > 1;
    let chosen = candidates.length === 1 || !spread ? candidates[0] : null;
    if (spread && query.near) chosen = byNear(candidates);
    return { status, candidates, ambiguous: spread, chosen, ...extra };
  };
  const pointsOf = (groups) => groups.flatMap((g) => Array.from({ length: g.count }, (_, k) => ({ lat: d.lat[g.start + k], lon: d.lon[g.start + k] })));
  if (!query.street) {
    const noStreet = m.get("");
    if (query.number && noStreet) {
      const hit = findNumber(d, noStreet, query.number);
      if (hit) return finish(hit.status, hit.list.map(([g, i]) => pointOf(d, g, i, hit.status)), { streetless: true });
    }
    const cl = clusters(pointsOf([...m.values()].flat()), 3000).sort((a, b) => b.count - a.count);
    return { status: "place", candidates: cl, ambiguous: false, chosen: cl[0], numberMissing: Boolean(query.number) };
  }
  const sg = streetGroups(m, query.street);
  if (!sg) return { status: "none", reason: "street", candidates: [] };
  if (query.number) {
    const hit = findNumber(d, sg.groups, query.number);
    if (hit) return finish(hit.status, hit.list.map(([g, i]) => pointOf(d, g, i, hit.status)), { match: sg.match });
  }
  const cl = clusters(pointsOf(sg.groups)).sort((a, b) => b.count - a.count);
  const chosen = query.near ? byNear(cl) : cl.length === 1 ? cl[0] : null;
  return { status: "street", candidates: cl, ambiguous: cl.length > 1, chosen, numberMissing: Boolean(query.number), match: sg.match };
}
