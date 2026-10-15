"""Parse an X-Plane apt.dat (single airport) into a JSON-friendly dict.

Coordinates are converted to local metres (x east, y north) around the airport datum.

Output (all point lists in local metres):
  runways, pavement (+ pavementSurf: surface code per polygon), boundary
  lines          taxiway / taxilane centrelines (types 1, 2, 51, 52, 60, 61 + anything that follows a taxi route)
  leadLines      stand lead-in lines (types 7, 57, 8, 10, 32, 82 + anything that ends at a stand)
  edgeLines      taxiway edge / shoulder markings (3, 53, 19, 24 ...), drawn faintly
  whiteLines     white runway / road markings (20-22)
  holdLines      runway holding positions (4, 5, 54, 55)   ilsHoldLines: CAT II/III positions (6, 56)
  nodes, edges   the 1201/1202 taxi network (every edge, named or not; width class in "width")
  roads          the 1206 ground-vehicle network on the same nodes
  stands, freqs, meta
"""
import math

CENTERLINE_TYPES = {1, 2, 51, 60, 61}
LEAD_TYPES = {7, 57, 8, 10, 32, 82}
# runway holding positions: classic 4/5 (+50 lit), X-Plane 12 draws them with 52 (intermediate) and 62 (runway);
# the JS side keeps only those within 150 m of a runway as stop bars, so intermediate ones are harmless here
HOLD_TYPES = {4, 5, 54, 55, 62, 63}
ILS_HOLD_TYPES = {6, 56, 64}
WHITE_TYPES = {20, 21, 22, 70, 71}
FREQ_KIND = {0: "atis", 1: "unicom", 2: "delivery", 3: "ground", 4: "tower", 5: "approach", 6: "departure"}
VERSION = 3          # bump when the output changes; server.py re-parses cached .dat files on a mismatch


class Proj:
    def __init__(self, lat0, lon0):
        self.lat0, self.lon0 = lat0, lon0
        self.kx = math.cos(math.radians(lat0)) * 111320.0
        self.ky = 110540.0

    def __call__(self, lat, lon):
        return [round((lon - self.lon0) * self.kx, 2), round((lat - self.lat0) * self.ky, 2)]


def _bezier(p0, c0, c1, p1, steps=8):
    out = []
    for i in range(1, steps + 1):
        t = i / steps
        u = 1 - t
        out.append([
            u * u * u * p0[0] + 3 * u * u * t * c0[0] + 3 * u * t * t * c1[0] + t * t * t * p1[0],
            u * u * u * p0[1] + 3 * u * u * t * c0[1] + 3 * u * t * t * c1[1] + t * t * t * p1[1],
        ])
    return out


def _length(pts):
    """Length of a polyline in local metres."""
    return sum(((pts[i + 1][0] - pts[i][0]) ** 2 + (pts[i + 1][1] - pts[i][1]) ** 2) ** 0.5 for i in range(len(pts) - 1))


def _expand(nodes, closed):
    """nodes: list of (pt, ctrl_or_None, attr). Returns sampled polyline points."""
    if not nodes:
        return []
    pts = [nodes[0][0]]
    n = len(nodes)
    rng = range(n) if closed else range(n - 1)
    for i in rng:
        a, b = nodes[i], nodes[(i + 1) % n]
        if a[1] is None and b[1] is None:
            pts.append(b[0])
            continue
        c0 = a[1] if a[1] is not None else a[0]
        c1 = [2 * b[0][0] - b[1][0], 2 * b[0][1] - b[1][1]] if b[1] is not None else b[0]
        pts.extend(_bezier(a[0], c0, c1, b[0]))
    if closed and len(pts) > 1:
        pts.pop()  # last == first
    return [[round(p[0], 1), round(p[1], 1)] for p in pts]


class _Grid:
    """Coarse spatial grid for 'is this point near a segment / a stand' questions."""

    def __init__(self, cell=100.0):
        self.cell = cell
        self.segs = {}
        self.pts = {}

    def _key(self, p):
        return (int(p[0] // self.cell), int(p[1] // self.cell))

    def add_seg(self, a, b):
        for k in {self._key(a), self._key(b)}:
            self.segs.setdefault(k, []).append((a, b))

    def add_pt(self, p):
        self.pts.setdefault(self._key(p), []).append(p)

    @staticmethod
    def _dseg(p, a, b):
        dx, dy = b[0] - a[0], b[1] - a[1]
        l2 = dx * dx + dy * dy
        t = 0.0 if l2 == 0 else max(0.0, min(1.0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2))
        return math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy))

    def near_seg(self, p, r):
        kx, ky = self._key(p)
        for i in (-1, 0, 1):
            for j in (-1, 0, 1):
                for a, b in self.segs.get((kx + i, ky + j), ()):
                    if self._dseg(p, a, b) < r:
                        return True
        return False

    def near_pt(self, p, r):
        kx, ky = self._key(p)
        for i in (-1, 0, 1):
            for j in (-1, 0, 1):
                for q in self.pts.get((kx + i, ky + j), ()):
                    if math.hypot(p[0] - q[0], p[1] - q[1]) < r:
                        return True
        return False


def parse(text):
    lines = [l.split() for l in text.splitlines()]
    lines = [l for l in lines if l]

    meta = {}
    header = None
    for l in lines:
        if l[0] in ("1", "16", "17") and header is None and len(l) >= 5:
            header = l
        elif l[0] == "1302" and len(l) >= 3:
            meta[l[1]] = " ".join(l[2:])

    raw_rwys = [l for l in lines if l[0] == "100" and len(l) >= 26]
    if "datum_lat" in meta and "datum_lon" in meta:
        lat0, lon0 = float(meta["datum_lat"]), float(meta["datum_lon"])
    elif raw_rwys:
        lat0 = sum(float(r[9]) + float(r[18]) for r in raw_rwys) / (2 * len(raw_rwys))
        lon0 = sum(float(r[10]) + float(r[19]) for r in raw_rwys) / (2 * len(raw_rwys))
    else:
        raise ValueError("airport has no datum and no runways")
    P = Proj(lat0, lon0)

    out = {
        "v": VERSION,
        "icao": header[4] if header else "",
        "name": " ".join(header[5:]) if header else "",
        "elevation": int(float(header[1])) if header else 0,
        "lat": lat0, "lon": lon0, "meta": meta,
        "runways": [], "pavement": [], "pavementSurf": [], "boundary": [],
        "lines": [], "leadLines": [], "edgeLines": [], "whiteLines": [], "holdLines": [], "ilsHoldLines": [],
        "nodes": [], "edges": [], "roads": [], "stands": [], "freqs": [],
    }

    for r in raw_rwys:
        ends = []
        for off in (8, 17):
            ends.append({"name": r[off], "pos": P(float(r[off + 1]), float(r[off + 2])),
                         "displaced": float(r[off + 3]), "blastpad": float(r[off + 4])})
        out["runways"].append({"width": float(r[1]), "surface": int(r[2]) if r[2].isdigit() else 0, "ends": ends})

    # --- taxi network first: the line classifier needs it ---
    idmap = {}
    last_edge = None
    for l in lines:
        c = l[0]
        if c == "1201" and len(l) >= 5:
            idmap[l[4]] = len(out["nodes"])
            out["nodes"].append(P(float(l[1]), float(l[2])))
        elif c in ("1202", "1206") and len(l) >= 4:
            if l[1] not in idmap or l[2] not in idmap:
                last_edge = None
                continue
            typ = l[4] if len(l) > 4 else "taxiway"
            name = " ".join(l[5:]) if len(l) > 5 else ""
            if c == "1202":
                last_edge = {"a": idmap[l[1]], "b": idmap[l[2]], "oneway": l[3] == "oneway",
                             "runway": typ == "runway", "width": typ.split("_")[-1] if typ.startswith("taxiway_") else "",
                             "name": name, "zones": {}}
                out["edges"].append(last_edge)
            else:
                last_edge = {"a": idmap[l[1]], "b": idmap[l[2]], "oneway": l[3] == "oneway", "name": name, "zones": {}}
                out["roads"].append(last_edge)
        elif c == "1204" and len(l) >= 3 and last_edge is not None:
            z = last_edge["zones"].setdefault(l[1], [])
            for rw in l[2].split(","):
                if rw and rw not in z:
                    z.append(rw)
        elif c in ("1201", "1300", "1301", "1302", "100", "110", "120", "130"):
            last_edge = None

    # --- stands ---
    for idx, l in enumerate(lines):
        if l[0] == "1300" and len(l) >= 6:
            stand = {"pos": P(float(l[1]), float(l[2])), "hdg": float(l[3]), "kind": l[4],
                     "types": l[5].split("|"), "name": " ".join(l[6:]) or f"S{idx}"}
            nxt = lines[idx + 1] if idx + 1 < len(lines) else None
            if nxt and nxt[0] == "1301" and len(nxt) >= 3:
                stand["size"] = nxt[1]
                stand["op"] = nxt[2]
                if len(nxt) > 3:
                    stand["airlines"] = nxt[3].split(",")
            out["stands"].append(stand)

    grid = _Grid()
    for e in out["edges"]:
        if not e["runway"]:
            grid.add_seg(out["nodes"][e["a"]], out["nodes"][e["b"]])
    for s in out["stands"]:
        grid.add_pt(s["pos"])

    def classify(pts, t):
        if t in HOLD_TYPES:
            return "holdLines"
        if t in ILS_HOLD_TYPES:
            return "ilsHoldLines"
        # X-Plane 12 airports draw intermediate holding positions with the broken yellow line (black border, 52);
        # only short ones (across a taxiway) are holding positions, long ones are apron boundaries
        if t == 52 and pts and _length(pts) < 60:
            return "holdLines"
        if t in WHITE_TYPES:
            return "whiteLines"
        if t in CENTERLINE_TYPES:
            return "lines"
        if t in LEAD_TYPES:
            return "leadLines"
        if not pts:
            return None
        sample = pts[::max(1, len(pts) // 12)]
        on_route = sum(1 for p in sample if grid.near_seg(p, 4.0)) / len(sample)
        near_stand = sum(1 for p in sample if grid.near_pt(p, 25.0)) / len(sample)
        if on_route >= 0.5:
            return "lines"
        if near_stand >= 0.5:
            return "leadLines"
        return "edgeLines"

    # --- pavement (110), linear features (120), boundary (130) ---
    i = 0
    while i < len(lines):
        code = lines[i][0]
        if code in ("110", "120", "130"):
            kind = code
            surf = int(lines[i][1]) if kind == "110" and len(lines[i]) > 1 and lines[i][1].isdigit() else 0
            i += 1
            rings, ring = [], []
            features = []  # for 120: list of (points, type)
            while i < len(lines) and lines[i][0] in ("111", "112", "113", "114", "115", "116"):
                l = lines[i]
                c = l[0]
                pt = P(float(l[1]), float(l[2]))
                ctrl = P(float(l[3]), float(l[4])) if c in ("112", "114", "116") else None
                attr_i = 5 if ctrl is not None else 3
                attr = int(l[attr_i]) if len(l) > attr_i and l[attr_i].lstrip("-").isdigit() else 0
                ring.append((pt, ctrl, attr))
                if c in ("113", "114"):
                    rings.append(_expand(ring, True))
                    features.append((_expand(ring, True) + [ring[0][0]], ring[0][2]))
                    ring = []
                elif c in ("115", "116"):
                    features.append((_expand(ring, False), ring[0][2]))
                    ring = []
                i += 1
            if kind == "110" and rings:
                out["pavement"].append(rings)
                out["pavementSurf"].append(surf)
            elif kind == "130" and rings:
                out["boundary"].extend(rings)
            elif kind == "120":
                for pts, t in features:
                    key = classify(pts, t)
                    if key:
                        out[key].append(pts)
            continue
        i += 1

    # --- frequencies (50-56 legacy, 1050-1056 MHz*1000) ---
    for l in lines:
        c = l[0]
        if len(l) >= 3 and c.isdigit():
            n = int(c)
            if 50 <= n <= 56:
                out["freqs"].append({"kind": FREQ_KIND[n - 50], "mhz": int(l[1]) / 100, "name": " ".join(l[2:])})
            elif 1050 <= n <= 1056:
                out["freqs"].append({"kind": FREQ_KIND[n - 1050], "mhz": int(l[1]) / 1000, "name": " ".join(l[2:])})

    return out
