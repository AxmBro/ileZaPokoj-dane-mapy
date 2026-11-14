# Krok 2: strumieniowy odczyt punktow adresowych PRG z POLSKA.zip, bez rozpakowywania na dysk.
# Uzycie: python -I prg_read.py <pylib z inflate64> <POLSKA.zip> <outdir>
# Wynik: <outdir>/<TERYT powiatu>.tsv (gmina, nazwa gminy, SIMC, miejscowosc, ID_ULIC, ulica, numer, lat, lon)
#        <outdir>/prg_stats.json (liczniki i kontrole wejscia)
# Pulapka: wpisy DBF i SHP punktow sa w metodzie ZIP 9 (Deflate64). zipfile ze stdlib rzuca NotImplementedError,
# dlatego lokalny naglowek jest czytany recznie, a strumien idzie przez inflate64. CRC liczone po drodze.
# Blad struktury wejscia konczy proces kodem 3 i linia GATE:<nazwa>, orkiestrator traktuje to jak padnieta bramke.
import json, math, os, re, struct, sys, time, zipfile, zlib

sys.path.insert(0, sys.argv[1])
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import inflate64
import pyres

zip_path, outdir = sys.argv[2], sys.argv[3]
os.makedirs(outdir, exist_ok=True)
t0 = time.time()
BASE = 'PRG_PunktyAdresowe_POLSKA'
REQUIRED = ['NUMER_PORZ', 'NAZWA_ULC', 'ID_ULIC', 'NAZWA_GMI', 'TERYT_GMI', 'NAZWA_MSC', 'ID_SIMC']
TERYT_RE = re.compile(rb'^\d{7}$')


def fail(gate, msg):
    print(f'GATE:{gate} {msg}', flush=True)
    sys.exit(3)


def log(*a):
    print(f'[{time.time() - t0:7.1f}s]', *a, flush=True)


class EntryStream:
    """Czytanie wpisu ZIP kawalkami z kontrola CRC i dlugosci. Metoda 8 i 9."""

    def __init__(self, path, info):
        self.f = open(path, 'rb')
        self.f.seek(info.header_offset)
        lh = self.f.read(30)
        if lh[:4] != b'PK\x03\x04':
            fail('zip-integrity', f'zly naglowek lokalny {info.filename}')
        nl, el = struct.unpack('<HH', lh[26:30])
        self.f.seek(nl + el, 1)
        self.left = info.compress_size
        self.expect_size = info.file_size
        self.expect_crc = info.CRC
        self.crc = 0
        self.size = 0
        self.name = info.filename
        if info.compress_type not in (8, 9):
            fail('zip-integrity', f'{info.filename}: nieobslugiwana metoda ZIP {info.compress_type}')
        self.d = inflate64.Inflater() if info.compress_type == 9 else zlib.decompressobj(-15)
        self.method = info.compress_type
        self.pending = b''

    def _more(self):
        while self.left > 0:
            raw = self.f.read(min(self.left, 1 << 20))
            if not raw:
                fail('zip-integrity', f'obciety wpis {self.name}')
            self.left -= len(raw)
            out = self.d.inflate(raw) if self.method == 9 else self.d.decompress(raw)
            if out:
                self.crc = zlib.crc32(out, self.crc)
                self.size += len(out)
                return out
        return b''

    def read_exact(self, n):
        while len(self.pending) < n:
            b = self._more()
            if not b:
                break
            self.pending += b
        out, self.pending = self.pending[:n], self.pending[n:]
        return out

    def chunks(self):
        if self.pending:
            b, self.pending = self.pending, b''
            yield b
        while True:
            b = self._more()
            if not b:
                return
            yield b

    def verify(self):
        for _ in self.chunks():
            pass
        if self.size != self.expect_size or self.crc != self.expect_crc:
            fail('zip-integrity', f'{self.name}: rozmiar {self.size} vs {self.expect_size}, crc {self.crc:08x} vs {self.expect_crc:08x}')


def dbf_header(s):
    h = s.read_exact(32)
    if len(h) < 32:
        fail('zip-integrity', f'pusty DBF {s.name}')
    _, yy, mm, dd, n, hl, rl = struct.unpack('<BBBBIHH', h[:12])
    s.date = f'{1900 + yy:04d}-{mm:02d}-{dd:02d}'
    raw = s.read_exact(hl - 32)
    fields = {}
    o = 1
    for k in range(0, len(raw) - 1, 32):
        x = raw[k:k + 32]
        if x[0] == 13:
            break
        name = x[:11].split(b'\0')[0].decode('latin1')
        fields[name] = (o, x[16])
        o += x[16]
    return n, rl, fields


# PUWG 1992 (EPSG:2180) -> WGS84: odwrotne Transverse Mercator (GRS80, seria Krugera do n^4).
a = 6378137.0
fl = 1 / 298.257222101
n_ = fl / (2 - fl)
k0 = 0.9993
lon0 = math.radians(19)
FE, FN = 500000, -5300000
A = a / (1 + n_) * (1 + n_ ** 2 / 4 + n_ ** 4 / 64)
BS = (n_ / 2 - 2 * n_ ** 2 / 3 + 37 * n_ ** 3 / 96 - n_ ** 4 / 360, n_ ** 2 / 48 + n_ ** 3 / 15 - 437 * n_ ** 4 / 1440,
      17 * n_ ** 3 / 480 - 37 * n_ ** 4 / 840, 4397 * n_ ** 4 / 161280)
DS = (2 * n_ - 2 * n_ ** 2 / 3 - 2 * n_ ** 3 + 116 * n_ ** 4 / 45, 7 * n_ ** 2 / 3 - 8 * n_ ** 3 / 5 - 227 * n_ ** 4 / 45,
      56 * n_ ** 3 / 15 - 136 * n_ ** 4 / 35, 4279 * n_ ** 4 / 630)


def inv(north, east):
    xi = (north - FN) / (k0 * A)
    eta = (east - FE) / (k0 * A)
    x1, y1 = xi, eta
    for j, b in enumerate(BS, 1):
        x1 -= b * math.sin(2 * j * xi) * math.cosh(2 * j * eta)
        y1 -= b * math.cos(2 * j * xi) * math.sinh(2 * j * eta)
    chi = math.asin(math.sin(x1) / math.cosh(y1))
    lat = chi + sum(d * math.sin(2 * j * chi) for j, d in enumerate(DS, 1))
    lon = lon0 + math.atan2(math.sinh(y1), math.cos(x1))
    return math.degrees(lat), math.degrees(lon)


try:
    z = zipfile.ZipFile(zip_path)
except (zipfile.BadZipFile, OSError) as e:
    fail('zip-integrity', f'{zip_path}: {e}')
names = {i.filename: i for i in z.infolist()}
for ext in ('.dbf', '.shp'):
    if BASE + ext not in names:
        fail('prg-schema', f'brak wpisu {BASE + ext}')

dbf = EntryStream(zip_path, names[BASE + '.dbf'])
shp = EntryStream(zip_path, names[BASE + '.shp'])
count, reclen, fields = dbf_header(dbf)
for col in REQUIRED:
    if col not in fields:
        fail('prg-schema', f'brak kolumny {col}; sa: {sorted(fields)}')
shp_head = shp.read_exact(100)
if len(shp_head) < 100 or struct.unpack('>i', shp_head[:4])[0] != 9994:
    fail('zip-integrity', 'zly naglowek SHP')
log('DBF rekordow', count, 'dlugosc rekordu', reclen, 'rozmiar', dbf.expect_size, 'metoda', dbf.method)

out = {}
stats = {'declared': count, 'records': 0, 'written': 0, 'deleted': 0, 'badTeryt': 0, 'emptyNumber': 0, 'nullShape': 0, 'badUtf8': 0, 'outOfBox': 0,
         'noStreet': 0, 'perPowiat': {}, 'perGmina': {}, 'dbfBytes': dbf.expect_size, 'shpBytes': shp.expect_size}
oN, lN = fields['NUMER_PORZ']
oU, lU = fields['NAZWA_ULC']
oI, lI = fields['ID_ULIC']
oG, lG = fields['NAZWA_GMI']
oT, lT = fields['TERYT_GMI']
oM, lM = fields['NAZWA_MSC']
oS, lS = fields['ID_SIMC']
cache = {}


def text(b):
    v = cache.get(b)
    if v is None:
        try:
            v = b.strip().decode('utf8')
        except UnicodeDecodeError:
            stats['badUtf8'] += 1
            v = b.strip().decode('cp1250', 'replace')
        v = v.replace('\t', ' ')
        cache[b] = v
    return v


shp_buf = b''
shp_pos = 0
shp_iter = shp.chunks()


def next_point():
    global shp_buf, shp_pos
    while len(shp_buf) - shp_pos < 8:
        c = next(shp_iter, None)
        if c is None:
            return None
        shp_buf = shp_buf[shp_pos:] + c
        shp_pos = 0
    length = int.from_bytes(shp_buf[shp_pos + 4:shp_pos + 8], 'big') * 2
    while len(shp_buf) - shp_pos < 8 + length:
        c = next(shp_iter, None)
        if c is None:
            return None
        shp_buf = shp_buf[shp_pos:] + c
        shp_pos = 0
    p = shp_pos + 8
    shp_pos = p + length
    if length < 20:
        return ()
    return struct.unpack_from('<dd', shp_buf, p + 4)


# SHP trzyma x=wschod, y=polnoc (potwierdza bramka znanych adresow; zamiana osi daje punkty poza Polska).
buf = b''
last = time.time()
for chunk in dbf.chunks():
    buf = buf + chunk if buf else chunk
    k = len(buf) // reclen
    for i in range(k):
        p = i * reclen
        pt = next_point()
        if pt is None:
            fail('prg-count', f'SHP krotszy niz DBF przy rekordzie {stats["records"]}')
        stats['records'] += 1
        if buf[p] == 0x2A:
            stats['deleted'] += 1
            continue
        if not pt:
            stats['nullShape'] += 1
            continue
        t = buf[p + oT:p + oT + lT].strip()
        if not TERYT_RE.match(t):
            stats['badTeryt'] += 1
            continue
        num = buf[p + oN:p + oN + lN].strip()
        if not num:
            stats['emptyNumber'] += 1
            continue
        x, y = pt
        if not (100000 < x < 900000 and 100000 < y < 800000):
            stats['outOfBox'] += 1
            continue
        lat, lon = inv(y, x)
        tt = t.decode('ascii')
        pw = tt[:4]
        f = out.get(pw)
        if f is None:
            f = out[pw] = open(os.path.join(outdir, pw + '.tsv'), 'w', encoding='utf8', newline='\n')
        uid = buf[p + oI:p + oI + lI].strip()
        street = text(buf[p + oU:p + oU + lU])
        if not street:
            stats['noStreet'] += 1
        f.write(f"{tt}\t{text(buf[p + oG:p + oG + lG])}\t{text(buf[p + oS:p + oS + lS])}\t{text(buf[p + oM:p + oM + lM])}\t"
                f"{uid.decode('ascii', 'replace')}\t{street}\t{text(num)}\t{lat:.6f}\t{lon:.6f}\n")
        stats['written'] += 1
        stats['perPowiat'][pw] = stats['perPowiat'].get(pw, 0) + 1
        stats['perGmina'][tt] = stats['perGmina'].get(tt, 0) + 1
    buf = buf[k * reclen:]
    if time.time() - last > 60:
        last = time.time()
        log('rekordy', stats['records'])

for f in out.values():
    f.close()
if buf.strip(b'\x1a'):
    fail('prg-count', f'DBF konczy sie niepelnym rekordem, zostalo {len(buf)} B')
dbf.verify()
shp.verify()
if stats['records'] != count:
    fail('prg-count', f'DBF deklaruje {count}, odczytano {stats["records"]}')
if next_point() is not None:
    fail('prg-count', 'SHP dluzszy niz DBF')
stats['seconds'] = round(time.time() - t0)
stats['crcOk'] = True
stats['dbfDate'] = dbf.date
stats['powiats'] = len(stats['perPowiat'])
stats['gminas'] = len(stats['perGmina'])
json.dump(stats, open(os.path.join(outdir, 'prg_stats.json'), 'w', encoding='utf8'), indent=1)
log({k: v for k, v in stats.items() if k not in ('perPowiat', 'perGmina')})
pyres.write_res(os.path.join(outdir, 'res.json'), seconds=stats['seconds'])
