# Turns OpenStreetMap data (Overpass JSON, "out body geom") around a city centre into the compact map HaniaRace's
# city mode draws: local metres (x east, z south, in decimetres), roads on a shared vertex list (so junctions are
# known), buildings with heights, green/sand/water areas, the coast, signals, stop signs, crossings and a few
# places for missions. Map data © OpenStreetMap contributors, ODbL.
import json, math, sys
src, out, name, lat0, lon0, R = sys.argv[1], sys.argv[2], sys.argv[3], float(sys.argv[4]), float(sys.argv[5]), float(sys.argv[6])
d = json.load(open(src, encoding='utf8'))
KX = math.cos(math.radians(lat0)) * 111320.0; KZ = 110540.0
def P(lat, lon): return (round((lon - lon0) * KX * 10), round(-(lat - lat0) * KZ * 10))
LIM = (R + 120) * 10
inb = lambda p: abs(p[0]) <= LIM and abs(p[1]) <= LIM
ROAD = {'motorway': 1, 'trunk': 1, 'primary': 2, 'secondary': 3, 'tertiary': 4, 'unclassified': 5, 'residential': 5, 'living_street': 6, 'service': 7,
        'motorway_link': 2, 'trunk_link': 2, 'primary_link': 3, 'secondary_link': 4, 'tertiary_link': 5}
WALK = {'pedestrian', 'footway', 'path', 'steps', 'cycleway'}
names, nidx = [], {}
def N(s):
    if not s: return -1
    if s not in nidx: nidx[s] = len(names); names.append(s)
    return nidx[s]
verts, vidx = [], {}
def V(nid, p):
    if nid not in vidx: vidx[nid] = len(verts) // 2; verts.extend(p)
    return vidx[nid]
roads, walks, bld, areas, coast = [], [], [], [], []
def num(s, dflt):
    try: return float(str(s).split(';')[0].split()[0])
    except Exception: return dflt
for e in d['elements']:
    if e['type'] != 'way' or 'geometry' not in e: continue
    t, g = e.get('tags', {}), e['geometry']
    if any(x is None for x in g): continue
    pts = [P(x['lat'], x['lon']) for x in g]
    hw = t.get('highway')
    if hw in ROAD and t.get('area') != 'yes' and t.get('access') not in ('private', 'no') and t.get('tunnel') not in ('yes', 'building_passage') and t.get('service') not in ('parking_aisle', 'drive-through'):
        nm = t.get('name:he') or t.get('name') or ''
        lanes = int(num(t.get('lanes'), 0)) if t.get('lanes') else 0
        ow = 1 if t.get('oneway') in ('yes', '1', 'true') or t.get('junction') == 'roundabout' or hw in ('motorway', 'motorway_link') else (-1 if t.get('oneway') == '-1' else 0)
        ms = int(num(t.get('maxspeed'), 0)) if t.get('maxspeed') else 0
        ids = e.get('nodes', [])
        run = []
        for i, p in enumerate(pts):
            if inb(p): run.append(V(ids[i] if i < len(ids) else ('w%d_%d' % (e['id'], i)), p))
            else:
                if len(run) >= 2: roads.append([ROAD[hw], N(nm), lanes, ow, ms, 1 if t.get('junction') == 'roundabout' else 0, run])
                run = []
        if len(run) >= 2: roads.append([ROAD[hw], N(nm), lanes, ow, ms, 1 if t.get('junction') == 'roundabout' else 0, run])
        continue
    if hw in WALK and t.get('area') != 'yes':
        q = [c for p in pts if inb(p) for c in p]
        if len(q) >= 4: walks.append(q)
        continue
    closed = len(pts) > 3 and g[0]['lat'] == g[-1]['lat'] and g[0]['lon'] == g[-1]['lon']
    if 'building' in t and closed and t.get('building') not in ('roof', 'construction'):
        cx = sum(p[0] for p in pts) / len(pts); cz = sum(p[1] for p in pts) / len(pts)
        if abs(cx) > R * 10 + 60 or abs(cz) > R * 10 + 60: continue
        a = 0
        for i in range(len(pts) - 1): a += pts[i][0] * pts[i + 1][1] - pts[i + 1][0] * pts[i][1]
        a = abs(a) / 200.0  # m²
        if a < 12: continue
        h = num(t.get('height'), 0) or num(t.get('building:levels'), 0) * 3.2
        if not h: h = 3.6 if t.get('building') in ('garage', 'shed', 'kiosk', 'service', 'hut') else 0
        kind = {'apartments': 1, 'residential': 1, 'house': 2, 'detached': 2, 'commercial': 3, 'retail': 3, 'office': 3, 'hotel': 3, 'industrial': 4, 'warehouse': 4,
                'school': 5, 'university': 5, 'hospital': 6, 'synagogue': 7, 'religious': 7, 'mosque': 7, 'church': 7}.get(t.get('building'), 0)
        bld.append([round(min(h, 220) * 10), kind] + [c for p in pts[:-1] for c in p])
        continue
    if closed:
        k = None
        le, lu, na, am = t.get('leisure'), t.get('landuse'), t.get('natural'), t.get('amenity')
        if le in ('park', 'garden', 'playground', 'pitch', 'dog_park') or lu in ('grass', 'recreation_ground', 'village_green', 'meadow', 'forest', 'orchard', 'cemetery') or na in ('wood', 'scrub', 'grassland'): k = 'g'
        elif na in ('beach', 'sand') or lu == 'sand': k = 's'
        elif na == 'water' or lu in ('reservoir', 'basin') or t.get('water'): k = 'w'
        elif am == 'parking' and t.get('parking') not in ('underground', 'multi-storey'): k = 'p'
        elif t.get('place') == 'square' or (hw == 'pedestrian' and t.get('area') == 'yes'): k = 'l'
        if k:
            q = [c for p in pts[:-1] for c in p]
            if any(inb((q[i], q[i + 1])) for i in range(0, len(q), 2)): areas.append([k] + q)
        continue
    if t.get('natural') == 'coastline':
        coast.append([c for p in pts for c in p])
nodes = {k: [] for k in ('sig', 'stop', 'give', 'cross', 'bus', 'lamp', 'tree')}
poi = []
PK = {'hospital': 'h', 'fire_station': 'f', 'fuel': 'u', 'cafe': 'c', 'restaurant': 'c', 'fast_food': 'c', 'pharmacy': 'm', 'school': 'k', 'kindergarten': 'k', 'post_office': 'o', 'bank': 'b'}
for e in d['elements']:
    if e['type'] != 'node': continue
    t = e.get('tags', {}); p = P(e['lat'], e['lon'])
    if not inb(p): continue
    hw = t.get('highway')
    k = {'traffic_signals': 'sig', 'stop': 'stop', 'give_way': 'give', 'crossing': 'cross', 'bus_stop': 'bus', 'street_lamp': 'lamp'}.get(hw)
    if t.get('natural') == 'tree': k = 'tree'
    if k and (k != 'tree' or len(nodes['tree']) < 9000): nodes[k].extend(p)
    am = t.get('amenity')
    if am in PK:
        # names only for public places (hospital, fire station, school); shops and cafés stay unnamed
        nm = (t.get('name:he') or t.get('name') or '') if PK[am] in ('h', 'f', 'k') else ''
        poi.append([PK[am], N(nm), p[0], p[1]])
    elif 'shop' in t and len(poi) < 4000:
        poi.append(['s', -1, p[0], p[1]])
o = {'v': 1, 'name': name, 'lat0': lat0, 'lon0': lon0, 'r': R, 'credit': '© OpenStreetMap contributors (ODbL)', 'names': names, 'verts': verts, 'roads': roads,
     'walks': walks, 'bld': bld, 'areas': areas, 'coast': coast, 'nodes': nodes, 'poi': poi}
s = json.dumps(o, ensure_ascii=False, separators=(',', ':'))
open(out, 'w', encoding='utf8').write(s)
print('R city', name, 'KB', len(s.encode()) // 1024, 'roads', len(roads), 'names', len(names), 'bld', len(bld), 'areas', len(areas), 'coast', len(coast), {k: len(v) // 2 for k, v in nodes.items()}, 'poi', len(poi))
