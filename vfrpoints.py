"""VFR reporting points for one airport, from the first source that has any:

  a) a EuroScope sector package (Settings): .sct [FIXES] / [VOR] / [NDB] entries and [FREETEXT] labels that are
     VFR points near the airport (names like "VFR_BRAVO", "EETN_B", or a FREETEXT group with "VFR" in it),
  b) the user's own file vfr_points/<ICAO>.json (edited in the app: click on the map to add a point),
  c) OpenAIP reporting points, only with the user's own OpenAIP API key (cached in cache/vfr/, never committed;
     OpenAIP data is CC BY-NC 4.0 -- attribution "© openAIP" is shown with it),
  d) nothing: the simulator's generic placeholders (shown grey and marked "(generic)").

A point: {"name": "Bravo", "lat": .., "lon": .., "alt": 1500, "type": "compulsory" | "on-request"}.
"""
import json
import math
import re
import time
import urllib.parse
import urllib.request
from pathlib import Path

import navdata

OPENAIP = "https://api.core.openaip.net/api/reporting-points"
PHONETIC = {"A": "Alfa", "B": "Bravo", "C": "Charlie", "D": "Delta", "E": "Echo", "F": "Foxtrot", "G": "Golf", "H": "Hotel",
            "I": "India", "J": "Juliett", "K": "Kilo", "L": "Lima", "M": "Mike", "N": "November", "O": "Oscar", "P": "Papa",
            "Q": "Quebec", "R": "Romeo", "S": "Sierra", "T": "Tango", "U": "Uniform", "V": "Victor", "W": "Whiskey",
            "X": "X-ray", "Y": "Yankee", "Z": "Zulu"}


def nm(lat1, lon1, lat2, lon2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2
    return 2 * 3440.065 * math.asin(min(1.0, math.sqrt(a)))


def point_name(raw, icao):
    """'VFR_B' / 'EETN_B' / 'EETN-VFR-B' / 'B' -> 'Bravo'; 'VFR_HARKU' -> 'Harku'."""
    s = re.sub(rf"^(?:{icao}|VFR|RP)[_\-\s:]*|[_\-\s:]*(?:{icao}|VFR)$", "", raw.strip(), flags=re.I)
    s = re.sub(rf"^(?:{icao}|VFR)[_\-\s:]*", "", s, flags=re.I).strip("_- ")
    if len(s) == 1 and s.upper() in PHONETIC:
        return PHONETIC[s.upper()]
    if re.fullmatch(r"[A-Z]\d", s.upper()) and s[0].upper() in PHONETIC:
        return PHONETIC[s[0].upper()] + " " + s[1]
    return s.replace("_", " ").title() if s.isupper() or "_" in s else s


def from_sector(folder, icao, lat, lon, radius_nm=30):
    """VFR points near the airport from a EuroScope sector package."""
    _eses, scts = navdata.find_sector_files(folder)
    out = []
    for f in scts:
        try:
            text = f.read_text("utf-8", "replace")
        except OSError:
            continue
        section = ""
        for line in text.splitlines():
            raw = line.split(";")[0].rstrip()
            if raw.startswith("["):
                section = raw.strip().upper()
                continue
            p = raw.split()
            if section == "[FIXES]" and len(p) >= 3:
                name, la, lo = p[0], navdata._sct_coord(p[1]), navdata._sct_coord(p[2])
                vfr = re.match(rf"^(VFR|{icao})[_\-]", name, re.I) or "VFR" in line.upper()
            elif section == "[FREETEXT]" and ":" in raw:
                parts = raw.split(":")
                if len(parts) < 4:
                    continue
                la, lo = navdata._sct_coord(parts[0]), navdata._sct_coord(parts[1])
                group, name = parts[2], parts[3]
                vfr = "VFR" in group.upper() and (icao in group.upper() or not re.search(r"[A-Z]{4}", group.upper().replace("VFR", "")))
            else:
                continue
            if not vfr or la is None or lo is None or nm(lat, lon, la, lo) > radius_nm:
                continue
            alt = re.search(r"(\d{3,4})\s*(?:FT|')", line.upper())
            out.append({"name": point_name(name, icao), "ident": name, "lat": la, "lon": lo, "alt": int(alt.group(1)) if alt else 1500,
                        "type": "compulsory"})
    seen, uniq = set(), []
    for p in out:
        if p["name"] not in seen:
            seen.add(p["name"])
            uniq.append(p)
    return uniq


def user_file(base, icao):
    return Path(base) / "vfr_points" / f"{icao.upper()}.json"


def from_user(base, icao):
    f = user_file(base, icao)
    try:
        d = json.loads(f.read_text("utf-8"))
    except (OSError, ValueError):
        return []
    pts = d.get("points", d) if isinstance(d, dict) else d
    return [clean(p) for p in pts if isinstance(p, dict) and p.get("name") and p.get("lat") is not None and p.get("lon") is not None]


def clean(p):
    t = str(p.get("type", "compulsory")).lower()
    return {"name": str(p["name"]).strip()[:40], "lat": float(p["lat"]), "lon": float(p["lon"]),
            "alt": int(p.get("alt") or 1500), "type": "on-request" if "request" in t else "compulsory"}


def save_user(base, icao, points):
    f = user_file(base, icao)
    f.parent.mkdir(parents=True, exist_ok=True)
    pts = [clean(p) for p in points if p.get("name") and p.get("lat") is not None]
    f.write_text(json.dumps({"icao": icao.upper(), "note": "VFR reporting points (edit in TowerTrainer: Settings -> VFR points)", "points": pts}, indent=1), "utf-8")
    return pts


def from_openaip(cache_dir, icao, lat, lon, key, refresh=False, fetch=None, radius_nm=25):
    """OpenAIP reporting points (needs the user's own API key; cached 30 days in cache/vfr/<ICAO>.openaip.json)."""
    if not key:
        return []
    cf = Path(cache_dir) / "vfr" / f"{icao.upper()}.openaip.json"
    if not refresh and cf.is_file() and time.time() - cf.stat().st_mtime < 30 * 86400:
        try:
            return json.loads(cf.read_text("utf-8"))
        except ValueError:
            pass
    q = urllib.parse.urlencode({"pos": f"{lat},{lon}", "dist": int(radius_nm * 1852), "limit": 100})
    try:
        if fetch:
            data = fetch(f"{OPENAIP}?{q}", key)
        else:
            req = urllib.request.Request(f"{OPENAIP}?{q}", headers={"x-openaip-api-key": key, "User-Agent": "TowerTrainer (personal ATC practice)"})
            with urllib.request.urlopen(req, timeout=20) as r:
                data = json.loads(r.read())
    except Exception:  # noqa: BLE001 -- no network / bad key: no points
        return []
    out = []
    for it in data.get("items", []):
        try:
            lo, la = it["geometry"]["coordinates"][:2]
        except (KeyError, TypeError, ValueError):
            continue
        out.append({"name": point_name(it.get("name", ""), icao), "lat": la, "lon": lo, "alt": 1500,
                    "type": "compulsory" if it.get("compulsory", True) else "on-request"})
    cf.parent.mkdir(parents=True, exist_ok=True)
    cf.write_text(json.dumps(out), "utf-8")
    return out


def load(icao, lat, lon, base, cache_dir, sector="", openaip_key="", fetch=None):
    """{source: sector|user|openaip|generic, label, points, attribution}"""
    icao = icao.upper()
    if sector:
        pts = from_sector(sector, icao, lat, lon)
        if pts:
            return {"source": "sector", "label": "VFR points: sector file", "points": pts}
    pts = from_user(base, icao)
    if pts:
        return {"source": "user", "label": "VFR points: user file", "points": pts, "file": str(user_file(base, icao))}
    pts = from_openaip(cache_dir, icao, lat, lon, openaip_key, fetch=fetch)
    if pts:
        return {"source": "openaip", "label": "VFR points: OpenAIP", "points": pts, "attribution": "© openAIP (CC BY-NC 4.0)"}
    return {"source": "generic", "label": "VFR points: generic", "points": [], "file": str(user_file(base, icao))}
