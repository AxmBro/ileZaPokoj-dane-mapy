# Krok 1: pobranie wejsc do katalogu dl z wznawianiem i zapisem metadanych zrodla.
# Uzycie: python -I fetch.py <dl> [--only=prg|osm]. Zero zaleznosci poza stdlib.
# Kontrakt: plik docelowy pojawia sie tylko po pelnym pobraniu (rozmiar == Content-Length) i, gdy zrodlo podaje sume
# (Geofabrik `.md5`), po zgodnosci sumy. Pobrane pliki to dane niezaufane: tylko dl, nic stamtad nie jest wykonywane.
# Bez petli ponowien poza `fetch_once` - Geofabrik blokuje zakresy IP za agresywne pobieranie.
import hashlib, json, os, sys, time, urllib.error, urllib.request

# Geofabrik przenosi kraje do wlasnych folderow (2026-11): nowy adres pierwszy, stary zapasowo. Suma `.md5` spod adresu po
# przekierowaniach, bo stary `.md5` bywal z innego pliku.
GEOFABRIK = ('https://download.geofabrik.de/europe/poland/', 'https://download.geofabrik.de/europe/')
# Geofabrik bywa przeciazony minutami: 6 prob to ok. 7,5 min czekania, a nie utrata pobranych 2,1 GB przez plik 60 B.
ATTEMPTS = 6
UA = {'User-Agent': 'ileZaPokoj-data-pipeline/1.0 (monthly data build)'}


def with_retry(fn, url):
    """Krotkie zapytanie kontrolne (HEAD, `.md5`) z ATTEMPTS probami: chwilowy blad sieci runnera (np. `Network is
    unreachable`) ani przeciazenie Geofabrik (HTTP 5xx, 429) nie moze przerwac budowy po kilkunastu minutach pobierania.
    Pozostale HTTP 4xx (np. 403 = blokada, 404 = zly adres) przechodza od razu."""
    for attempt in range(1, ATTEMPTS + 1):
        try:
            return fn()
        except urllib.error.HTTPError as e:
            if (e.code < 500 and e.code != 429) or attempt == ATTEMPTS:
                raise
            print(f'{url}: proba {attempt}: {e}', flush=True)
            time.sleep(30 * attempt)
        except OSError as e:
            if attempt == ATTEMPTS:
                raise
            # Natychmiastowa odmowa we wszystkich probach = siec runnera na liscie blokad Geofabrik; pomaga tylko nowy runner.
            print(f'{url}: proba {attempt}: {e}', flush=True)
            time.sleep(30 * attempt)


def head(url):
    def once():
        req = urllib.request.Request(url, method='HEAD', headers=UA)
        with urllib.request.urlopen(req, timeout=60) as r:
            return int(r.headers.get('Content-Length') or 0), r.headers.get('Last-Modified') or '', r.headers.get('ETag') or '', r.geturl()
    return with_retry(once, url)


def osm_month_url():
    """Plik miesieczny `poland-RRMM01.osm.pbf` (Geofabrik trzyma je latami): ponowiony przebieg bierze te same dane,
    a `-latest` jest podmieniany w ciagu dnia. Pliku z 1. dnia biezacego miesiaca jeszcze nie ma -> poprzedni miesiac."""
    t = time.gmtime()
    for back in (0, 1):
        y, m = t.tm_year, t.tm_mon - back
        if m < 1:
            y, m = y - 1, 12
        for base in GEOFABRIK:
            try:
                return head(f'{base}poland-{y % 100:02d}{m:02d}01.osm.pbf')[3], True
            except urllib.error.HTTPError as e:
                if e.code != 404:
                    raise
    raise SystemExit('brak miesiecznego pliku Polski na Geofabrik (biezacy i poprzedni miesiac)')


def prg_url():
    return 'https://opendata.geoportal.gov.pl/prg/adresy/PunktyAdresowe/POLSKA.zip', False


# klucz -> (nazwa w dl, funkcja zwracajaca (url, czy zrodlo ma plik `.md5`))
# OSM pierwszy: Geofabrik bywa nieosiagalny z runnera, a taki przebieg ma pasc od razu, nie po pobraniu PRG.
SOURCES = {
    'osm': ('poland.osm.pbf', osm_month_url),
    'prg': ('POLSKA.zip', prg_url),
}


def md5_of(url):
    """Suma z pliku `.md5` obok danych Geofabrik (format `md5  nazwa`)."""
    def once():
        with urllib.request.urlopen(urllib.request.Request(url + '.md5', headers=UA), timeout=60) as r:
            return r.read().decode('ascii').split()[0].lower()
    return with_retry(once, url)


def fetch_once(url, part, etag, size):
    """Jedna proba pobrania od miejsca przerwania. If-Range: gdy plik na serwerze sie zmienil, serwer daje caly nowy."""
    have = os.path.getsize(part) if os.path.exists(part) else 0
    hdr = dict(UA)
    if have:
        hdr['Range'] = f'bytes={have}-'
        if etag:
            hdr['If-Range'] = etag
    req = urllib.request.Request(url, headers=hdr)
    with urllib.request.urlopen(req, timeout=120) as r:
        keep = have and r.status == 206
        with open(part, 'ab' if keep else 'wb') as f:
            done = have if keep else 0
            last = time.time()
            while True:
                b = r.read(1 << 20)
                if not b:
                    break
                f.write(b)
                done += len(b)
                if time.time() - last > 30:
                    print(f'{done / 1e6:.0f}/{size / 1e6:.0f} MB', flush=True)
                    last = time.time()


def get(url, dst, has_md5):
    size, modified, etag, _ = head(url)
    meta = {'url': url, 'size': size, 'lastModified': modified, 'etag': etag}
    # Plik w dl z innego zrodla (inny miesiac) o tym samym rozmiarze nie moze przejsc jako "jest".
    stamp = dst + '.url'
    same_source = os.path.exists(stamp) and open(stamp, encoding='utf8').read() == url
    if os.path.exists(dst) and os.path.getsize(dst) == size and same_source:
        print('jest', dst, size, flush=True)
    else:
        part = dst + '.part'
        # Etag zapisany przy pierwszej probie: wznowienie po nocnej podmianie pliku nie moze skleic dwoch snapshotow.
        tag_file = part + '.etag'
        if os.path.exists(part) and os.path.exists(tag_file) and open(tag_file, encoding='utf8').read() != etag + url:
            os.remove(part)
        with open(tag_file, 'w', encoding='utf8') as f:
            f.write(etag + url)
        t0 = time.time()
        for attempt in range(1, 21):
            try:
                fetch_once(url, part, etag, size)
            except OSError as e:
                print(f'proba {attempt}: {e}', flush=True)
                time.sleep(min(60, 5 * attempt))
            if size and os.path.exists(part) and os.path.getsize(part) >= size:
                break
        if size and os.path.getsize(part) != size:
            raise SystemExit(f'niepelne pobranie {url}: {os.path.getsize(part)} != {size}')
        os.replace(part, dst)
        os.remove(tag_file)
        with open(stamp, 'w', encoding='utf8') as f:
            f.write(url)
        meta['seconds'] = round(time.time() - t0)
    h = hashlib.sha256()
    m = hashlib.md5()
    with open(dst, 'rb') as f:
        for b in iter(lambda: f.read(1 << 22), b''):
            h.update(b)
            m.update(b)
    meta['sha256'] = h.hexdigest()
    if has_md5:
        want = md5_of(url)
        if m.hexdigest() != want:
            os.remove(dst)
            raise SystemExit(f'zla suma md5 {url}: {m.hexdigest()} != {want} (plik usuniety)')
        meta['md5'] = want
    meta['fetchedAt'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
    return meta


def main():
    dl = sys.argv[1]
    only = next((a.split('=')[1] for a in sys.argv[2:] if a.startswith('--only=')), None)
    os.makedirs(dl, exist_ok=True)
    path = os.path.join(dl, 'sources.json')
    meta = json.load(open(path, encoding='utf8')) if os.path.exists(path) else {}
    for key, (name, resolve) in SOURCES.items():
        if only and key != only:
            continue
        url, has_md5 = resolve()
        meta[key] = get(url, os.path.join(dl, name), has_md5)
        json.dump(meta, open(path, 'w', encoding='utf8'), indent=1)
        print(key, json.dumps(meta[key]), flush=True)


main()
