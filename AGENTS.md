# AGENTS - ileZaPokoj-dane-mapy

Zasady dla agentów AI i osób, które zmieniają to repo. Repo jest **publiczne**: wszystko, co trafi do gita, jest widoczne na zawsze, także po usunięciu.

## Co wolno opublikować

| Tak | Nie |
|---|---|
| kod automatu, bramki, testy falsyfikujące | adresy z ofert OLX (ulica + numer domu wynajmującego) - tylko sekret `PRIVATE_FIXTURES` |
| adresy z PRG i OSM bez związku z ofertami (np. losowa próbka do bramki `known-addr`) | ścieżki z dysku, nazwy kont, adresy serwera, e-maile, tokeny |
| liczby z pomiarów potrzebne kodowi (progi, mnożniki) z jednym zdaniem skąd | odnośniki do prywatnych repo i notatek (`src/...` wtyczki, notatki z researchu, nazwy prób) |

Plik z adresami z ofert idzie wyłącznie do `pipeline/fixtures/private/` (w `.gitignore`), a na runner przez sekret: `node pipeline/private_fixtures.mjs` zapisuje go z `PRIVATE_FIXTURES` (JSON `{ "nazwa_pliku.json": [...] }`). Zmiana tych plików = nowa wartość sekretu (`gh secret set PRIVATE_FIXTURES`), nie commit.

## Sprawdzenie przed push

```bash
git ls-files | grep -iE "private/|offer_addr"          # musi być pusto
git grep -nIE "Users|AppData|NOTATKI|src/|@gmail" -- ':!AGENTS.md'      # musi być pusto
git grep -nIP "[\x{2013}\x{2014}\x{2026}\x{201E}\x{201D}]" -- ':!pipeline/normalize.mjs' ':!AGENTS.md'   # musi być pusto
```

`pipeline/normalize.mjs` celowo ma półpauzę i cudzysłowy w regexach - czyta nimi nazwy z danych; `AGENTS.md` zawiera same wzorce.

## Forma

- Teksty dla ludzi po polsku, identyfikatory po angielsku. Myślnik wyłącznie ASCII `-`, strzałka `->`.
- Komentarz w kodzie = kontrakt: wejście, wyjście, pułapka, skąd liczba. Bez historii zmian, dat poprawek i opowieści - to jest w git.
- README opisuje stan obecny dla osoby z zewnątrz: co powstaje, jak użyć, jak zbudować, licencje.
- Commity: `type(scope): konkret` po polsku, opis "dlaczego" przy nietrywialnej zmianie.

## Zmiana kodu

- Klucz ulicy (`keyOf` w `pipeline/normalize.mjs`) musi dawać ten sam wynik co odczyt we wtyczce; zmiana = nowa para w `pipeline/fixtures/street_keys.json` i zielona bramka `street-key`.
- Format plików (`addr_format.mjs`, `graph_format.mjs`, `manifest.mjs`) to kontrakt z wtyczką: zmiana bez zmiany dekodera po stronie wtyczki zepsuje mapę u użytkowników.
- Nowa bramka w `gates.mjs` ma test w `falsify.mjs` (wejście, które ją oblewa).
- Pełny przebieg: `workflow_dispatch` na GitHubie (ok. 40 min), nie lokalnie.
