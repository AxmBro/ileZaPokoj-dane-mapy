# ileZaPokoj - dane mapy

Raz w miesiącu automat buduje pliki mapy dla wtyczki [ileZaPokoj](https://www.ilezapokoj.pl): punkty adresowe z PRG i grafy dróg z OpenStreetMap dla całej Polski. Wtyczka liczy z nich adres oferty i trasę do wybranego punktu w przeglądarce użytkownika, bez zapytań do zewnętrznych serwerów geokodowania i tras.

Repo jest publiczne celowo: udostępnia metodę budowy bazy pochodnej z OpenStreetMap (ODbL 1.0, art. 4.6).

## Wydanie

Każde wydanie to [GitHub Release](../../releases) `dane-RRRRMMDD-GGMMSS` z trzema plikami:

| Plik | Co to |
|---|---|
| `dane-RRRRMMDD-GGMMSS.tar` | katalog `RRRRMMDD-GGMMSS/` z plikami danych (niżej) |
| `dane-RRRRMMDD-GGMMSS.tar.sha256` | suma SHA-256 archiwum |
| `counts.json` | liczniki punktów i węzłów - odniesienie bramek następnego wydania |

Zawartość katalogu:

| Plik | Zawartość | Źródło |
|---|---|---|
| `addr-<TERYT powiatu>.bin.gz` | punkty adresowe powiatu: miejscowość, ulica, numer, współrzędne | PRG |
| `addr-index.json.gz` | miejscowość -> powiaty, bbox powiatów | PRG |
| `graph-<obszar>.bin.gz` | graf dróg samochodowych obszaru z buforem | OSM |
| `graph-coarse.bin.gz` | graf krajowy do tras między obszarami | OSM |
| `graph-index.json.gz` | obszary i mapa zasięgu plików grafu | OSM |
| `manifest.json` | format, źródła z datami, licencje, rozmiar i SHA-256 każdego pliku | - |

Adresy i grafy leżą w osobnych plikach, więc licencje się nie mieszają: adresy to wyłącznie PRG, grafy wyłącznie OSM.

## Użycie

Pobranie i sprawdzenie najnowszego wydania:

```bash
gh release download --repo AxmBro/ileZaPokoj-dane-mapy --pattern 'dane-*'
sha256sum -c dane-*.tar.sha256
tar -xf dane-*.tar
```

Serwowanie bez przestoju (tak robi serwer wtyczki):

1. Rozpakuj nowy katalog obok poprzedniego, np. `static/data/20261208-031700/`.
2. Na końcu podmień wskaźnik `static/data/manifest.json` na `{"dir": "20261208-031700"}`.
3. Wskaźnik serwuj z `Cache-Control: no-cache`, katalogi z datą z `Cache-Control: public, max-age=31536000, immutable`, wszystko z `Access-Control-Allow-Origin: *`.
4. Trzymaj dwie ostatnie wersje. Cofnięcie = wskaźnik na poprzedni katalog.

Pliki `.gz` serwuj bez `Content-Encoding` - klient rozpakowuje je sam.

## Jak powstaje

1. Workflow [`dane-mapy.yml`](.github/workflows/dane-mapy.yml) rusza 8. dnia miesiąca, zapasowo 11. (tylko gdy wydania z tego miesiąca jeszcze nie ma), albo ręcznie.
2. [`fetch.py`](pipeline/fetch.py) pobiera `POLSKA.zip` z PRG i miesięczny plik `poland-RRMM01.osm.pbf` z Geofabrik ze sprawdzeniem md5.
3. [`run_pipeline.mjs`](pipeline/run_pipeline.mjs) buduje adresy i grafy, liczy manifest i uruchamia bramki jakości ([`gates.mjs`](pipeline/gates.mjs)): kompletność powiatów, zmiana liczby punktów względem poprzedniego wydania, znane adresy, zgodność klucza ulicy z wtyczką, trasy kontrolne, rozmiary plików, rozdział licencji.
4. Wydanie powstaje tylko przy wszystkich zielonych bramkach. Czerwona bramka nie publikuje nic, a użytkownicy zostają na poprzednich danych.

[`falsify.mjs`](pipeline/falsify.mjs) celowo psuje wejście albo gotowe pliki ([`falsify_hooks/`](pipeline/falsify_hooks)) i sprawdza, że bramki zatrzymują publikację.

## Budowa lokalna

Wymaga Node 22+, Pythona 3.13, ok. 4,1 GB RAM i 7,7 GB dysku; pełny przebieg trwa ok. 40 min.

```bash
python -m pip install --target pylib -r pipeline/requirements.txt
node pipeline/run_pipeline.mjs --pylib=pylib --publish=out
```

Wynik trafia do `out/current`. Bramki z adresami z prawdziwych ofert czytają `pipeline/fixtures/private/`, którego nie ma w repo: lokalnie są pomijane, na runnerze dostarcza je sekret `PRIVATE_FIXTURES`.

## Licencje

- Kod: MIT ([`LICENSE`](LICENSE)).
- Adresy: Państwowy Rejestr Granic, Główny Urząd Geodezji i Kartografii, [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Przetworzenie: wybór pól, normalizacja nazw, podział na powiaty, kompresja.
- Grafy dróg: © OpenStreetMap contributors, [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/), pobrane z [Geofabrik](https://download.geofabrik.de/europe/poland.html).
