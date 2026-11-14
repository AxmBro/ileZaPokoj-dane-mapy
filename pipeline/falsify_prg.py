# Celowe psucie wejscia PRG do testu falsyfikujacego bramek. Nie jest czescia budowy.
# Uzycie: python -I falsify_prg.py <pylib> <POLSKA.zip> <wyjscie.zip> <mutacja>
# Mutacje: rename-col, empty-city, partial-loss, partial-loss-1pct, swap-axes, shift-city, shift-gmina, shuffle-streets, shuffle-numbers
# Wynik to ZIP z samymi wpisami punktow w zwyklym deflate; czytnik obsluguje obie metody.
import itertools, random, struct, sys, zipfile, zlib

sys.path.insert(0, sys.argv[1])
import inflate64

src, dst, mutation = sys.argv[2], sys.argv[3], sys.argv[4]
BASE = 'PRG_PunktyAdresowe_POLSKA'
z = zipfile.ZipFile(src)
rnd = random.Random(20261107)


def stream(info):
    f = open(src, 'rb')
    f.seek(info.header_offset)
    lh = f.read(30)
    nl, el = struct.unpack('<HH', lh[26:30])
    f.seek(nl + el, 1)
    d = inflate64.Inflater() if info.compress_type == 9 else zlib.decompressobj(-15)
    left = info.compress_size
    while left > 0:
        raw = f.read(min(left, 1 << 20))
        left -= len(raw)
        out = d.inflate(raw) if info.compress_type == 9 else d.decompress(raw)
        if out:
            yield out


dbf_info = z.getinfo(BASE + '.dbf')
shp_info = z.getinfo(BASE + '.shp')
dbf = stream(dbf_info)
head = next(dbf)
_, _, _, _, count, hl, rl = struct.unpack('<BBBBIHH', head[:12])
fields = {}
o = 1
for k in range(32, hl - 1, 32):
    x = head[k:k + 32]
    if x[0] == 13:
        break
    fields[x[:11].split(b'\0')[0].decode('latin1')] = (o, x[16], k)
    o += x[16]
oT, lT, _ = fields['TERYT_GMI']
oU, lU, _ = fields['NAZWA_ULC']
oN, lN, _ = fields['NUMER_PORZ']
TARGET = {'empty-city': b'1261', 'partial-loss': b'1465', 'partial-loss-1pct': b'1465', 'shift-city': b'1061', 'shift-gmina': b'1206', 'shuffle-streets': b'1061', 'shuffle-numbers': b'1061'}.get(mutation)
if mutation == 'rename-col':
    head = bytearray(head)
    k = fields['NUMER_PORZ'][2]
    head[k:k + 11] = b'NR_PORZ\0\0\0\0'
    head = bytes(head)
# Mutacje SHP potrzebuja znacznika powiatu dla kolejnych rekordow, wiec przebieg DBF zapamietuje go w tablicy.
need_mask = mutation in ('shift-city', 'shift-gmina')
mask = bytearray(count) if need_mask else None
out = zipfile.ZipFile(dst, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=1, allowZip64=True)
pool = []
idx = 0


def entry(name):
    # ZipInfo nie dziedziczy metody po ZipFile; bez tego wpis laduje jako STORED.
    info = zipfile.ZipInfo(name)
    info.compress_type = zipfile.ZIP_DEFLATED
    info._compresslevel = 1
    return info


with out.open(entry(BASE + '.dbf'), 'w', force_zip64=True) as w:
    w.write(head[:hl])
    buf = head[hl:]
    for chunk in itertools.chain([None], dbf):
        if chunk is not None:
            buf += chunk
        k = len(buf) // rl
        if k:
            b = bytearray(buf[:k * rl])
            for i in range(k):
                p = i * rl
                hit = TARGET is not None and b[p + oT:p + oT + 4] == TARGET
                if hit and mutation == 'empty-city':
                    b[p] = 0x2A
                elif hit and mutation == 'partial-loss' and rnd.random() < 0.05:
                    b[p] = 0x2A
                elif hit and mutation == 'partial-loss-1pct' and rnd.random() < 0.01:
                    b[p] = 0x2A
                elif hit and mutation == 'shuffle-streets':
                    pool.append(bytes(b[p + oU:p + oU + lU]))
                    b[p + oU:p + oU + lU] = pool[rnd.randrange(len(pool))]
                elif hit and mutation == 'shuffle-numbers':
                    pool.append(bytes(b[p + oN:p + oN + lN]))
                    b[p + oN:p + oN + lN] = pool[rnd.randrange(len(pool))]
                elif hit and mutation == 'shift-gmina':
                    # Jedna gmina w duzym powiecie: mediana powiatu nie drgnie, tak wyglada lokalne uszkodzenie.
                    if b[p + oT:p + oT + 7] == b'1206162':
                        mask[idx + i] = 1
                elif hit and need_mask:
                    mask[idx + i] = 1
            idx += k
            w.write(b)
            buf = buf[k * rl:]
    if buf:
        w.write(buf)
rec = 0
with out.open(entry(BASE + '.shp'), 'w', force_zip64=True) as w:
    buf = b''
    first = True
    for chunk in stream(shp_info):
        buf += chunk
        if first:
            w.write(buf[:100])
            buf = buf[100:]
            first = False
        if mutation not in ('swap-axes', 'shift-city', 'shift-gmina'):
            w.write(buf)
            buf = b''
            continue
        k = len(buf) // 28
        b = bytearray(buf[:k * 28])
        for i in range(k):
            p = i * 28
            x, y = struct.unpack_from('<dd', b, p + 12)
            if mutation == 'swap-axes':
                struct.pack_into('<dd', b, p + 12, y, x)
            elif mask[rec + i]:
                struct.pack_into('<dd', b, p + 12, x + 300, y + 300)
        rec += k
        w.write(b)
        buf = buf[k * 28:]
    if buf:
        w.write(buf)
out.close()
print('zrobione', mutation, dst, flush=True)
