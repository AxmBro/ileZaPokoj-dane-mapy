# Krok 3: wydzielenie z PBF kraju tego, czego potrzebuje budowa grafow i bramki.
# Uzycie: python -I osm_extract.py <pylib> <pbf> <outdir>
# Wynik w <outdir>:
#   ways.bin        drogi dla aut, rekord binarny (format nizej, czyta graph_build.mjs)
#   node_flags.bin  wezly z bariera lub sygnalizacja: float64 id + uint8 flaga (1 blokada, 2 sygnalizacja)
#   boundaries.json granice administracyjne PL z teryt:terc (kraj, powiaty, gminy), uproszczone
#   osm_addr_sample.ndjson  co N-ty adres OSM, tylko material kontrolny bramek, nigdy nie trafia do plikow addr
#   osm_extract_stats.json  liczniki wejscia do bramek
# Pulapka: pyosmium filtruje dopiero po dolozeniu lokalizacji, wiec indeks musi widziec wszystkie wezly.
# Indeks plikowy (sparse_file_array) trzyma RAM nisko kosztem ok. 16 B na wezel na dysku.
import array, json, math, os, re, struct, sys, time, zlib

sys.path.insert(0, sys.argv[1])
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pyres
import osmium, osmium.filter, shapely
from shapely.geometry import LineString, mapping
from shapely.ops import polygonize, unary_union

pbf, outdir = sys.argv[2], sys.argv[3]
os.makedirs(outdir, exist_ok=True)
t0 = time.time()


def log(*a):
    print(f'[{time.time() - t0:7.1f}s]', *a, flush=True)


# Klasy drog w kolejnosci znaczenia. Indeks klasy zapisany w ways.bin decyduje o grafie zgrubnym.
CLASSES = ['motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link', 'secondary', 'secondary_link',
           'tertiary', 'tertiary_link', 'unclassified', 'residential', 'living_street', 'service']
CLASS_ID = {c: i for i, c in enumerate(CLASSES)}
# Predkosci i wykluczenia wzorowane na profilu car.lua OSRM; zgodnosc tylko empiryczna (porownanie tras).
CAR_SPEED = {'motorway': 90, 'motorway_link': 45, 'trunk': 85, 'trunk_link': 40, 'primary': 65, 'primary_link': 30,
             'secondary': 55, 'secondary_link': 25, 'tertiary': 40, 'tertiary_link': 20, 'unclassified': 25,
             'residential': 25, 'living_street': 10, 'service': 15}
NO_ACCESS = {'no', 'private', 'agricultural', 'forestry', 'emergency', 'psv', 'delivery', 'customers', 'military', 'permit'}
YES_ACCESS = {'yes', 'permissive', 'designated', 'destination', 'public'}
SPEED_MAP = {'PL:urban': 50, 'PL:rural': 90, 'PL:living_street': 20, 'PL:motorway': 140, 'PL:expressway': 120, 'PL:zone30': 30, 'PL:zone:30': 30}
BARRIER_PASS = {'cattle_grid', 'border_control', 'toll_booth', 'sally_port', 'gate', 'lift_gate', 'no', 'entrance', 'height_restrictor', 'arch'}
SERVICE_MINOR = {'driveway', 'parking_aisle', 'alley', 'parking'}
ADDR_SAMPLE_EVERY = 37  # liczba pierwsza, zeby nie rezonowac z kolejnoscia importow


def car_access(t):
    for k in ('motorcar', 'motor_vehicle', 'vehicle', 'access'):
        v = t.get(k)
        if not v:
            continue
        if v in NO_ACCESS:
            return False
        if v in YES_ACCESS:
            return True
    return True


def parse_speed(v):
    if not v:
        return 0
    if v in SPEED_MAP:
        return SPEED_MAP[v]
    m = re.match(r'^(\d+)', v)
    return int(m[1]) if m else 0


def edge_props(t, hw):
    """Zwraca (fw, bw, predkosc km/h, pen, svcMinor) albo None, gdy droga nie jest dla aut."""
    base = CAR_SPEED.get(hw)
    if not base or t.get('area') == 'yes' or not car_access(t):
        return None
    ow = t.get('oneway')
    if ow in ('reversible', 'alternating'):
        return None
    junction = t.get('junction')
    fw = bw = True
    if ow in ('yes', '1', 'true'):
        bw = False
    elif ow in ('-1', 'reverse'):
        fw = False
    elif ow == 'no':
        pass
    elif junction in ('roundabout', 'circular') or hw == 'motorway':
        bw = False
    ms = parse_speed(t.get('maxspeed'))
    spd = ms * 0.8 if ms > 0 else base
    svc = t.get('service')
    pen = 0.5 if hw == 'service' and svc else 1
    return fw, bw, spd, pen, bool(hw == 'service' and svc in SERVICE_MINOR)


# Przebieg 1: relacje granic. Tylko relacje, czytane z pominieciem blokow wezlow.
rels = []
wayset = set()
for o in osmium.FileProcessor(pbf, osmium.osm.RELATION).with_filter(osmium.filter.TagFilter(('boundary', 'administrative'))):
    t = o.tags
    lvl = t.get('admin_level')
    terc = t.get('teryt:terc')
    country = lvl == '2' and t.get('ISO3166-1') == 'PL'
    if not country and not (lvl in ('6', '7') and terc):
        continue
    outer = [m.ref for m in o.members if m.type == 'w' and m.role in ('outer', '')]
    inner = [m.ref for m in o.members if m.type == 'w' and m.role == 'inner']
    rels.append({'id': o.id, 'lvl': lvl, 'name': t.get('name'), 'terc': terc or '', 'outer': outer, 'inner': inner})
    wayset.update(outer)
    wayset.update(inner)
log('relacje granic', len(rels), 'drog granic', len(wayset))

# Przebieg 2: geometria drog, granice, adresy kontrolne, bariery. Jeden przebieg, indeks na dysku.
geom = {}
wout = open(os.path.join(outdir, 'ways.bin'), 'wb')
nout = open(os.path.join(outdir, 'node_flags.bin'), 'wb')
aout = open(os.path.join(outdir, 'osm_addr_sample.ndjson'), 'w', encoding='utf8')
stats = {'ways': 0, 'wayRefs': 0, 'waysSkippedBadLoc': 0, 'nodesFlagged': 0, 'addrSeen': 0, 'addrSample': 0, 'classCount': {c: 0 for c in CLASSES}}
idx_path = os.path.join(outdir, '_nodes.idx')
HDR = struct.Struct('<dBBfI')  # way id, klasa, flagi (1 fw, 2 bw, 4 kara service, 8 service drobny), predkosc, liczba wezlow


def sample_addr(kind, oid, lon, lat, t):
    stats['addrSeen'] += 1
    # Probka po id, a nie po kolejnosci: ten sam snapshot daje te sama probke.
    if (zlib.crc32(struct.pack('<q', oid)) % ADDR_SAMPLE_EVERY) != 0:
        return
    stats['addrSample'] += 1
    rec = {'k': kind, 'id': oid, 'lon': round(lon, 6), 'lat': round(lat, 6), 'num': t.get('addr:housenumber'),
           'street': t.get('addr:street') or '', 'city': t.get('addr:city') or '', 'place': t.get('addr:place') or ''}
    aout.write(json.dumps(rec, ensure_ascii=False) + '\n')


if os.path.getsize(pbf) < 1000:
    print('GATE:osm-input plik PBF pusty', flush=True)
    sys.exit(3)
fp = osmium.FileProcessor(pbf).with_locations(f'sparse_file_array,{idx_path}').with_filter(
    osmium.filter.KeyFilter('highway', 'barrier', 'addr:housenumber').enable_for(osmium.osm.NODE))
last = time.time()
for o in fp:
    if o.is_node():
        t = o.tags
        if not o.location.valid():
            continue
        hn = t.get('addr:housenumber')
        if hn:
            sample_addr('n', o.id, o.location.lon, o.location.lat, t)
        hw = t.get('highway')
        ba = t.get('barrier')
        fl = 0
        if hw == 'traffic_signals':
            fl |= 2
        if ba and ba not in BARRIER_PASS and t.get('access') not in ('yes', 'permissive') and t.get('motor_vehicle') != 'yes':
            fl |= 1
        if fl:
            nout.write(struct.pack('<dB', o.id, fl))
            stats['nodesFlagged'] += 1
    elif o.is_way():
        t = o.tags
        oid = o.id
        if oid in wayset:
            try:
                geom[oid] = [(n.lon, n.lat) for n in o.nodes]
            except osmium.InvalidLocationError:
                pass
        hw = t.get('highway')
        hn = t.get('addr:housenumber')
        if not hw and not hn:
            continue
        p = edge_props(t, hw) if hw else None
        if p is None and not hn:
            continue
        try:
            nodes = o.nodes
            ids = array.array('d', [n.ref for n in nodes])
            coords = array.array('i', [v for n in nodes for v in (n.x, n.y)])
        except osmium.InvalidLocationError:
            stats['waysSkippedBadLoc'] += 1
            continue
        if hn:
            k = len(ids)
            sample_addr('w', oid, sum(coords[0::2]) / k / 1e7, sum(coords[1::2]) / k / 1e7, t)
        if p is not None and len(ids) >= 2:
            fw, bw, spd, pen, minor = p
            flags = (1 if fw else 0) | (2 if bw else 0) | (4 if pen != 1 else 0) | (8 if minor else 0)
            wout.write(HDR.pack(oid, CLASS_ID[hw], flags, spd, len(ids)))
            wout.write(ids.tobytes())
            wout.write(coords.tobytes())
            stats['ways'] += 1
            stats['wayRefs'] += len(ids)
            stats['classCount'][hw] += 1
            if time.time() - last > 60:
                last = time.time()
                log('drogi', stats['ways'])
wout.close()
nout.close()
aout.close()
stats['indexBytes'] = os.path.getsize(idx_path)
del fp  # na Windows plik indeksu jest zmapowany, dopoki zyje procesor
try:
    os.remove(idx_path)
except OSError:
    pass
log('po drogach', json.dumps(stats))

# Poligony granic. Polygonize z linii zamiast ladowania Area: nie wymaga drugiego indeksu.
boundaries = []
failed = []
for r in rels:
    lines = [LineString(geom[w]) for w in r['outer'] if w in geom and len(geom[w]) > 1]
    missing = sum(1 for w in r['outer'] if w not in geom)
    polys = list(polygonize(unary_union(lines))) if lines else []
    if not polys:
        failed.append(r['id'])
        continue
    poly = unary_union(polys)
    inner = [LineString(geom[w]) for w in r['inner'] if w in geom and len(geom[w]) > 1]
    if inner:
        holes = list(polygonize(unary_union(inner)))
        # Enklawy bywaja osobnymi poligonami z polygonize; roznica usuwa je tylko, gdy sa dziurami relacji.
        if holes:
            poly = poly.difference(unary_union(holes))
    tol = 0.0002 if r['lvl'] != '2' else 0.0005
    simp = poly.simplify(tol, preserve_topology=True)
    boundaries.append({'id': r['id'], 'lvl': r['lvl'], 'name': r['name'], 'terc': r['terc'], 'missingWays': missing,
                       'bbox': [round(v, 5) for v in poly.bounds], 'geo': json.loads(shapely.to_geojson(shapely.set_precision(simp, 1e-5)))})
stats['boundaries'] = len(boundaries)
# Polska ma 380 powiatow; wyraznie mniej granic albo drog oznacza obciety wyciag, nawet gdy czytnik nie rzucil bledu.
if stats['ways'] < 500000 or sum(1 for b in boundaries if b['lvl'] == '6') < 370 or not any(b['lvl'] == '2' for b in boundaries):
    print(f"GATE:osm-input drog {stats['ways']}, powiatow {sum(1 for b in boundaries if b['lvl'] == '6')}", flush=True)
    sys.exit(3)
stats['boundariesFailed'] = failed
stats['seconds'] = round(time.time() - t0)
json.dump(boundaries, open(os.path.join(outdir, 'boundaries.json'), 'w', encoding='utf8'), ensure_ascii=False)
json.dump(stats, open(os.path.join(outdir, 'osm_extract_stats.json'), 'w', encoding='utf8'), indent=1)
pyres.write_res(os.path.join(outdir, 'res.json'), seconds=stats['seconds'], indexBytes=stats['indexBytes'])
log('gotowe', json.dumps({k: stats[k] for k in ('ways', 'wayRefs', 'boundaries', 'addrSeen', 'addrSample')}), 'bez poligonu', len(failed))
