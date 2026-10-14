"""Airport buildings from OpenStreetMap (Overpass API), cached in cache/<ICAO>.osm.json.

Data © OpenStreetMap contributors, ODbL 1.0 (https://www.openstreetmap.org/copyright). The credit is shown on the
map whenever this data is drawn. Nothing is bundled: the first load of an airport asks Overpass once; after that
the cached file is used, and without network (or Overpass down) the map simply has no buildings.
"""
import json
import math
import time
import urllib.parse
import urllib.request
from pathlib import Path

OVERPASS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"]
UA = {"User-Agent": "TowerTrainer/0.2 (personal ATC practice tool; github.com/Anviktor2411/TowerTrainer)"}
CREDIT = "© OpenStreetMap contributors (ODbL)"
KINDS = ("terminal", "pier", "hangar", "tower", "apron", "parking", "building")


def bbox_for(lat, lon, radius_m):
    dlat = radius_m / 110540.0
    dlon = radius_m / (111320.0 * max(0.2, math.cos(math.radians(lat))))
    return lat - dlat, lon - dlon, lat + dlat, lon + dlon


def query(lat, lon, radius_m):
    """Aerodrome features in a wide box; plain buildings only in a tight box around the field (and the server
    keeps just those near the stands), so a city next to the airport does not come along."""
    s, w, n, e = bbox_for(lat, lon, radius_m)
    bbox = f"{s:.5f},{w:.5f},{n:.5f},{e:.5f}"
    s2, w2, n2, e2 = bbox_for(lat, lon, min(radius_m, 1200))
    bbox2 = f"{s2:.5f},{w2:.5f},{n2:.5f},{e2:.5f}"
    return (f"[out:json][timeout:60];"
            f"("
            f'way["aeroway"~"^(terminal|hangar|apron|control_tower|tower|helipad)$"]({bbox});'
            f'way["building"~"^(terminal|hangar|control_tower)$"]({bbox});'
            f'way["building"]({bbox2});'
            f'way["man_made"="tower"]({bbox});'
            f'node["aeroway"="control_tower"]({bbox});'
            f'node["man_made"="tower"]["tower:type"~"control|aviation"]({bbox});'
            f'relation["aeroway"="terminal"]({bbox});'
            f");out body geom;")


def classify(tags):
    a = tags.get("aeroway", "")
    b = tags.get("building", "")
    name = tags.get("name", "")
    if a == "control_tower" or tags.get("tower:type") == "control" or b == "control_tower":
        return "tower"
    if a == "terminal" or b == "terminal" or "terminal" in name.lower():
        return "pier" if "pier" in name.lower() or "satellite" in name.lower() else "terminal"
    if a == "hangar" or b == "hangar":
        return "hangar"
    if a == "apron":
        return "apron"
    if a in ("gate", "fuel", "helipad"):
        return None
    if tags.get("amenity") == "parking" or b == "parking":
        return "parking"
    if b:
        return "building"
    return None


def fetch(lat, lon, radius_m=2500):
    q = query(lat, lon, radius_m)
    last = None
    for url in OVERPASS:
        try:
            req = urllib.request.Request(url, data=urllib.parse.urlencode({"data": q}).encode(), headers=UA)
            with urllib.request.urlopen(req, timeout=90) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception as e:   # noqa: BLE001 - try the next mirror
            last = e
    raise RuntimeError(f"Overpass unavailable: {type(last).__name__}: {last}")


def to_local(raw, lat0, lon0, keep=None):
    """keep(cx, cy, kind) -> bool filters plain buildings (e.g. only those near the stands)."""
    kx = math.cos(math.radians(lat0)) * 111320.0
    ky = 110540.0
    out = []
    tower = None
    for el in raw.get("elements", []):
        tags = el.get("tags", {})
        kind = classify(tags)
        if not kind:
            continue
        name = tags.get("name") or tags.get("ref") or ""
        if el["type"] == "node":
            p = [round((el["lon"] - lon0) * kx, 1), round((el["lat"] - lat0) * ky, 1)]
            if kind == "tower":
                tower = p
            continue
        geoms = []
        if el["type"] == "way" and el.get("geometry"):
            geoms = [el["geometry"]]
        elif el["type"] == "relation":
            geoms = [m["geometry"] for m in el.get("members", []) if m.get("role") == "outer" and m.get("geometry")]
        for g in geoms:
            pts = [[round((q["lon"] - lon0) * kx, 1), round((q["lat"] - lat0) * ky, 1)] for q in g]
            if len(pts) < 3:
                continue
            if pts[0] == pts[-1]:
                pts.pop()
            cx = sum(p[0] for p in pts) / len(pts)
            cy = sum(p[1] for p in pts) / len(pts)
            if keep and kind in ("building", "parking") and not keep(cx, cy, kind):
                continue
            out.append({"kind": kind, "name": name[:40], "pts": pts, "c": [round(cx, 1), round(cy, 1)],
                        "levels": tags.get("building:levels"), "height": tags.get("height")})
            if kind == "tower" and tower is None:
                tower = [round(cx, 1), round(cy, 1)]
    out.sort(key=lambda b: KINDS.index(b["kind"]) if b["kind"] in KINDS else 99)
    return {"buildings": out, "tower": tower, "credit": CREDIT, "fetched": int(time.time())}


def near_points(points, radius_m):
    """keep() that accepts buildings within radius_m of any of the given local points (stands, runway ends)."""
    cells = {}
    for x, y in points:
        cells.setdefault((int(x // radius_m), int(y // radius_m)), []).append((x, y))

    def keep(cx, cy, kind):
        gx, gy = int(cx // radius_m), int(cy // radius_m)
        for i in (-1, 0, 1):
            for j in (-1, 0, 1):
                for x, y in cells.get((gx + i, gy + j), ()):
                    if math.hypot(cx - x, cy - y) < radius_m:
                        return True
        return False
    return keep


def load(icao, lat, lon, cache_dir, refresh=False, points=None):
    cache_dir = Path(cache_dir)
    cache_dir.mkdir(exist_ok=True)
    f = cache_dir / f"{icao.upper()}.osm.json"
    if f.is_file() and not refresh:
        try:
            return json.loads(f.read_text("utf-8"))
        except (OSError, ValueError):
            pass
    try:
        data = to_local(fetch(lat, lon), lat, lon, keep=near_points(points, 350.0) if points else None)
    except Exception as e:   # noqa: BLE001
        return {"buildings": [], "tower": None, "credit": CREDIT, "error": str(e), "offline": True}
    f.write_text(json.dumps(data, separators=(",", ":")), "utf-8")
    return data
