# Heights for HaniaRace's city maps: samples the open terrain tiles (Mapzen "Terrarium" on AWS Open Data: SRTM and
# other public sources) every 15 m over each map, and stores them in race/city/<id>.json as "elev": the step, the
# size, the lowest point in metres and the heights above it in decimetres (little-endian 16-bit, base64).
# Usage: python3 tools/elev.py race/city/*.json
import base64, io, json, math, struct, sys, urllib.request
from PIL import Image
Z, STEP = 14, 15
tiles = {}
def tile(x, y):
    k = (x, y)
    if k not in tiles:
        url = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/%d/%d/%d.png' % (Z, x, y)
        for t in range(4):
            try:
                tiles[k] = Image.open(io.BytesIO(urllib.request.urlopen(url, timeout=60).read())).convert('RGB').load(); break
            except Exception as e:
                if t == 3: raise
    return tiles[k]
def pix(gx, gy):
    p = tile(gx // 256, gy // 256)[gx % 256, gy % 256]
    return p[0] * 256 + p[1] + p[2] / 256 - 32768
def height(lat, lon):
    n = 2 ** Z
    fx = (lon + 180) / 360 * n * 256
    la = math.radians(lat); fy = (1 - math.log(math.tan(la) + 1 / math.cos(la)) / math.pi) / 2 * n * 256
    x0, y0 = int(math.floor(fx - 0.5)), int(math.floor(fy - 0.5)); tx, ty = fx - 0.5 - x0, fy - 0.5 - y0
    return (pix(x0, y0) * (1 - tx) * (1 - ty) + pix(x0 + 1, y0) * tx * (1 - ty) + pix(x0, y0 + 1) * (1 - tx) * ty + pix(x0 + 1, y0 + 1) * tx * ty)
for f in sys.argv[1:]:
    d = json.load(open(f, encoding='utf8'))
    lat0, lon0, R = d['lat0'], d['lon0'], d['r']
    L = math.ceil(R + 130); n = int(2 * L // STEP) + 1
    KX = math.cos(math.radians(lat0)) * 111320.0; KZ = 110540.0
    H = [[height(lat0 - (-L + j * STEP) / KZ, lon0 + (-L + i * STEP) / KX) for i in range(n)] for j in range(n)]
    # a light smoothing: the tiles carry some noise from roofs and trees
    S = [[sum(H[min(n - 1, max(0, j + dj))][min(n - 1, max(0, i + di))] * w for dj, di, w in ((0, 0, 4), (1, 0, 1), (-1, 0, 1), (0, 1, 1), (0, -1, 1))) / 8 for i in range(n)] for j in range(n)]
    lo = min(min(r) for r in S); lo = max(lo, -5)
    vals = [max(0, min(32767, round((S[j][i] - lo) * 10))) for j in range(n) for i in range(n)]
    d['elev'] = {'step': STEP, 'n': n, 'L': L, 'min': round(lo, 1), 'h': base64.b64encode(struct.pack('<%dh' % len(vals), *vals)).decode()}
    open(f, 'w', encoding='utf8').write(json.dumps(d, ensure_ascii=False, separators=(',', ':')))
    print('R elev', f, 'n', n, 'min %.1f max %.1f' % (lo, lo + max(vals) / 10), 'tiles', len(tiles))
