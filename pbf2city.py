# Cuts the areas around Israeli city centres out of the OpenStreetMap extract for Israel (Geofabrik, .osm.pbf) and
# writes each as Overpass-style JSON (raw/<id>.json) for tools/osm2city.py: the ways with their tags, node ids and
# geometry, and the nodes with tags. One pass over the file for all the cities.
# Map data © OpenStreetMap contributors, ODbL.   Usage: python3 tools/pbf2city.py israel.osm.pbf cities.txt raw/
import json, math, os, sys
import osmium
pbf, listf, outd = sys.argv[1], sys.argv[2], sys.argv[3]
R, RW = 1050, 3000
cities = []
for line in open(listf, encoding='utf8'):
    p = line.strip().split('|')
    if len(p) < 4 or not p[0]: continue
    cities.append({'id': p[0], 'he': p[1], 'lat': float(p[2]) if p[2] else None, 'lon': float(p[3]) if p[3] else None})
# 1) the centres: the place=city/town node of that name, for the cities without one given
class Places(osmium.SimpleHandler):
    def node(self, n):
        t = n.tags
        if t.get('place') in ('city', 'town'):
            for c in cities:
                if c['lat'] is None and (t.get('name') == c['he'] or t.get('name:he') == c['he']):
                    c['lat'], c['lon'] = n.location.lat, n.location.lon
Places().apply_file(pbf)
def box(c, r):
    a = r / 110540; b = r / (111320 * math.cos(math.radians(c['lat'])))
    return (c['lat'] - a, c['lon'] - b, c['lat'] + a, c['lon'] + b)
for c in cities:
    if c['lat'] is None: print('R no centre', c['id']); continue
    c['b'], c['bw'], c['el'] = box(c, R), box(c, RW), []
live = [c for c in cities if c['lat'] is not None]
inb = lambda b, la, lo: b[0] <= la <= b[2] and b[1] <= lo <= b[3]
NODE_HW = {'traffic_signals', 'stop', 'give_way', 'crossing', 'bus_stop', 'street_lamp'}
NODE_AM = {'hospital', 'fire_station', 'fuel', 'cafe', 'restaurant', 'fast_food', 'pharmacy', 'school', 'kindergarten', 'post_office', 'bank'}
class Cut(osmium.SimpleHandler):
    def node(self, n):
        t = n.tags
        if not (t.get('highway') in NODE_HW or t.get('natural') == 'tree' or t.get('amenity') in NODE_AM or 'shop' in t): return
        la, lo = n.location.lat, n.location.lon
        for c in live:
            if inb(c['b'], la, lo): c['el'].append({'type': 'node', 'id': n.id, 'lat': la, 'lon': lo, 'tags': dict(t)})
    def way(self, w):
        t = w.tags
        # shops and places drawn as an outline: their middle, as a point
        if 'shop' in t or t.get('amenity') in NODE_AM:
            try:
                ps = [(nd.location.lat, nd.location.lon) for nd in w.nodes]
                if ps:
                    la, lo = sum(p[0] for p in ps) / len(ps), sum(p[1] for p in ps) / len(ps)
                    for c in live:
                        if inb(c['b'], la, lo): c['el'].append({'type': 'node', 'id': -w.id, 'lat': la, 'lon': lo, 'tags': dict(t)})
            except osmium.InvalidLocationError: pass
        wide = 'natural' in t
        if not ('highway' in t or 'building' in t or 'leisure' in t or 'landuse' in t or wide or t.get('amenity') == 'parking' or t.get('place') == 'square'): return
        try: pts = [(nd.location.lat, nd.location.lon, nd.ref) for nd in w.nodes]
        except osmium.InvalidLocationError: return
        if not pts: return
        for c in live:
            b = c['bw'] if wide else c['b']
            if any(inb(b, p[0], p[1]) for p in pts):
                c['el'].append({'type': 'way', 'id': w.id, 'tags': dict(t), 'nodes': [p[2] for p in pts], 'geometry': [{'lat': p[0], 'lon': p[1]} for p in pts]})
Cut().apply_file(pbf, locations=True, idx='flex_mem')
os.makedirs(outd, exist_ok=True)
for c in live:
    json.dump({'elements': c['el']}, open(os.path.join(outd, c['id'] + '.json'), 'w', encoding='utf8'), ensure_ascii=False)
    open(os.path.join(outd, c['id'] + '.center'), 'w').write('%.6f %.6f' % (c['lat'], c['lon']))
    print('R', c['id'], len(c['el']), 'elements', '%.5f,%.5f' % (c['lat'], c['lon']))
