# Krok 3b: rozwiazanie listy obszarow grafu na poligony granic OSM. Wejscie wylacznie z OSM.
# Uzycie: python -I areas.py <pylib> <boundaries.json> <areas_config.json> <areas.json> <snapshot>
# Wynik: dla kazdego obszaru buffer (rdzen + bufferM, tu wybierane sa drogi) i coverage (rdzen + coverageM, mapa zasiegu).
# Kontrakt: zasieg jest wezszy niz bufor, wiec punkt w zasiegu ma pod soba co najmniej roznice buforow sieci drog.
import json, math, sys, unicodedata

sys.path.insert(0, sys.argv[1])
import shapely
from shapely import affinity
from shapely.geometry import mapping, shape
from shapely.ops import unary_union

bound_file, cfg_file, out_file, snapshot = sys.argv[2:6]
bounds = json.load(open(bound_file, encoding='utf8'))
cfg = json.load(open(cfg_file, encoding='utf8'))
by_name = {}
for b in bounds:
    by_name.setdefault((b['lvl'], b['name']), []).append(b)


def resolve(name):
    """Kolejnosc: powiat o tej nazwie, gmina miejska o tej nazwie, gmina z przedrostkiem w nazwie."""
    for key in (('6', name), ('7', name), ('7', f'gmina {name}')):
        hit = by_name.get(key)
        if hit:
            if key[0] == '7' and len(hit) > 1:
                hit = sorted(hit, key=lambda b: b['terc'][-1])
            return hit[0]
    return None


def slug(s):
    s = s.replace('ł', 'l').replace('Ł', 'L')
    s = unicodedata.normalize('NFD', s)
    s = ''.join(c for c in s if not unicodedata.combining(c)).lower()
    return s.replace(' ', '-')


def grow(poly, metres):
    lat0 = poly.centroid.y
    sx = 1 / math.cos(math.radians(lat0))
    origin = (poly.centroid.x, lat0)
    scaled = affinity.scale(poly, xfact=1 / sx, yfact=1, origin=origin)
    return affinity.scale(scaled.buffer(metres / 111320.0), xfact=sx, yfact=1, origin=origin)


def geo(poly):
    return json.loads(shapely.to_geojson(shapely.set_precision(poly.simplify(0.0005), 1e-5)))


areas = []
missing = []


def add(slug_, kind, names):
    parts = []
    for n in names:
        b = resolve(n)
        if b is None:
            missing.append(f'{slug_}: {n}')
            continue
        parts.append(b)
    if not parts:
        return
    core = unary_union([shape(p['geo']) for p in parts]).buffer(0)
    areas.append({'slug': slug_, 'kind': kind, 'names': names, 'terc': [p['terc'] for p in parts],
                  'coreBbox': [round(v, 4) for v in core.bounds],
                  'buffer': geo(grow(core, cfg['bufferM'])), 'coverage': geo(grow(core, cfg['coverageM']))})


# Wariant pomiarowy: wszystkie powiaty kraju, bez listy nazw.
if cfg.get('allPowiats'):
    for b in bounds:
        if b['lvl'] == '6' and len(b['terc']) == 4:
            core = shape(b['geo']).buffer(0)
            areas.append({'slug': b['terc'], 'kind': 'powiat', 'names': [b['name']], 'terc': [b['terc']],
                          'coreBbox': [round(v, 4) for v in core.bounds], 'buffer': geo(grow(core, cfg['bufferM'])), 'coverage': geo(grow(core, cfg['coverageM']))})
for kind, names in cfg['cities'].items():
    for n in names:
        add(slug(n), kind, [n])
for name, names in cfg['agglomerations'].items():
    add(name, 'agglomeration', names)
json.dump({'snapshot': snapshot, 'areas': areas, 'missing': missing}, open(out_file, 'w', encoding='utf8'), ensure_ascii=False)
print('obszary', len(areas), 'nierozwiazane', missing, flush=True)
if missing:
    print('GATE:area-resolve', '; '.join(missing), flush=True)
    sys.exit(3)
