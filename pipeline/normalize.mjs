// Normalizacja nazw i numerow wspolna dla budowy i odczytu. keyOf musi dawac ten sam klucz co odczyt we wtyczce,
// inaczej adres nie trafia w zapisany wiersz; zgodnosc pilnuje bramka street-key (fixtures/street_keys.json).
const MARKS = /[̀-ͯ]/g;
export const fold = (text) =>
  String(text || "")
    .toLocaleLowerCase("pl")
    .normalize("NFD")
    .replace(MARKS, "")
    .replace(/ł/g, "l")
    .replace(/[„”"'«»()]/g, "")
    .replace(/[.\-–]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
const TYPE_WORD = /^(?:ulica|ul|aleja|aleje|al|plac|pl|rondo|osiedle|os|skwer|bulwar|wybrzeze)\s+/;
const TITLE_WORDS = [
  [/\b(?:swietego|swietej|sw)\b/g, "sw"],
  [/\b(?:ksiedza|ks)\b/g, "ks"],
  [/\b(?:generala|gen)\b/g, "gen"],
  [/\b(?:doktora|dr)\b/g, "dr"],
];
export const keyOf = (name) => {
  let key = fold(name).replace(TYPE_WORD, "");
  for (const [pattern, short] of TITLE_WORDS) key = key.replace(pattern, short);
  return key;
};

// Numer PRG -> czesc liczbowa + sufiks tekstowy. "12 A" = "12a", "84/92" = 84 + "/92", "BN" = 0 + "bn".
export function parseNumber(raw) {
  const s = String(raw || "").toLowerCase().replace(/\s+/g, "");
  const m = s.match(/^(\d{1,7})(.*)$/);
  return m ? { n: Number(m[1]), sfx: m[2], norm: s } : { n: 0, sfx: s, norm: s };
}
// Rozklad numeru zlozonego: "84/92" i "17-19" to budynek pod dwoma numerami (a, b), "84/2" to numer z lokalem.
// Zwraca { a, aSfx, b, bSfx } albo null.
export function compositeOf(p) {
  const m = p.sfx.match(/^([a-z]?)[/-](\d{1,5})([a-z]?)$/);
  if (!m) return null;
  return { a: p.n, aSfx: m[1], b: Number(m[2]), bSfx: m[3] };
}
