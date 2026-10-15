"""Procedures (SID / STAR / approaches) and fixes for one airport, read from LOCAL data only:

  1) X-Plane 12 CIFP (ARINC 424 style, one file per airport):
       <X-Plane 12>/Custom Data/CIFP/<ICAO>.dat         (Navigraph / updated data)
       <X-Plane 12>/Resources/default data/CIFP/<ICAO>.dat
     plus fixes / navaids from earth_fix.dat / earth_nav.dat in the same data folder.
  2) EuroScope sector package: SID/STAR lines from the .ese, fix positions from the .sct.
  3) Fallback: generic name ("<fix> 1A" style) or "radar vectors", initial climb 4000 ft (US 5000).

Nothing here is bundled or redistributed: parsed results are cached in cache/<ICAO>.procs.json,
which is git-ignored because it may be built from Navigraph data.
"""
import datetime as dt
import json
import math
import os
import re
from pathlib import Path

XPLANE_GUESSES = [
    r"D:\SteamLibrary\steamapps\common\X-Plane 12",
    r"C:\Program Files (x86)\Steam\steamapps\common\X-Plane 12",
    r"C:\X-Plane 12", r"D:\X-Plane 12", r"E:\X-Plane 12",
]


# ---------------------------------------------------------------- AIRAC
AIRAC_EPOCH = dt.date(2020, 1, 2)   # AIRAC 2001


def airac_for(day=None):
    """Current AIRAC cycle ident (YYNN) for a date, from the 28-day calendar."""
    day = day or dt.date.today()
    n = (day - AIRAC_EPOCH).days // 28
    start = AIRAC_EPOCH + dt.timedelta(days=28 * n)
    first = AIRAC_EPOCH + dt.timedelta(days=28 * math.ceil((dt.date(start.year, 1, 1) - AIRAC_EPOCH).days / 28))
    idx = (start - first).days // 28 + 1
    return f"{start.year % 100:02d}{idx:02d}"


def read_cycle(folder):
    f = Path(folder) / "cycle_info.txt"
    if not f.is_file():
        return None
    t = f.read_text("utf-8", "replace")
    m = re.search(r"AIRAC cycle\s*:\s*(\d{4})", t, re.I) or re.search(r"\b(\d{4})\b", t)
    return m.group(1) if m else None


# ---------------------------------------------------------------- data source discovery
def find_xplane(hint=""):
    cands = [hint] if hint else []
    try:  # X-Plane writes its install path here
        for f in Path(os.environ.get("LOCALAPPDATA", "")).glob("x-plane_install_12.txt"):
            cands += [l.strip() for l in f.read_text("utf-8", "replace").splitlines() if l.strip()]
    except OSError:
        pass
    cands += XPLANE_GUESSES
    for c in cands:
        if c and Path(c).is_dir():
            return str(Path(c))
    return None


def data_folders(xplane="", mode="auto", custom=""):
    """Ordered list of (label, folder) that may contain CIFP/ + earth_*.dat."""
    out = []
    if custom and Path(custom).is_dir():
        out.append(("custom", str(Path(custom))))
    xp = find_xplane(xplane)
    if xp:
        nav = Path(xp) / "Custom Data"
        dflt = Path(xp) / "Resources" / "default data"
        if mode in ("auto", "navigraph") and (nav / "CIFP").is_dir():
            out.append(("navigraph", str(nav)))
        if mode in ("auto", "default") and (dflt / "CIFP").is_dir():
            out.append(("xplane", str(dflt)))
    return out


def navdata_info(xplane="", mode="auto", custom=""):
    folders = data_folders(xplane, mode, custom)
    cur = airac_for()
    if not folders:
        return {"source": "none", "label": "No navigation data found (fallback procedures)", "airac": None, "current": cur,
                "outdated": False, "xplane": find_xplane(xplane)}
    kind, folder = folders[0]
    cyc = read_cycle(folder)
    label = {"navigraph": "Navigraph", "xplane": "X-Plane default data", "custom": "Custom folder"}[kind]
    return {"source": kind, "folder": folder, "airac": cyc, "current": cur,
            "outdated": bool(cyc and cyc < cur), "xplane": find_xplane(xplane),
            "label": f"Nav data: {label}" + (f" AIRAC {cyc}" if cyc else "")}


# ---------------------------------------------------------------- CIFP parsing
ALT_DESC = set("+-B@ JHGIV")


def _alt(field):
    f = field.strip()
    if not f:
        return None
    if f.startswith("FL") and f[2:].isdigit():
        return int(f[2:]) * 100
    if f.isdigit() and len(f) == 5:
        return int(f)
    return None


def parse_cifp(text):
    """Return {sids, stars, apps}; each procedure {name, runways, legs:[{fix, region, alt, desc}]}."""
    procs = {"SID": {}, "STAR": {}, "APPCH": {}}
    for raw in text.splitlines():
        m = re.match(r"^(SID|STAR|APPCH):(.*?);?\s*$", raw.strip())
        if not m:
            continue
        kind, body = m.group(1), m.group(2)
        f = body.split(",")
        if len(f) < 12:
            continue
        name, trans, fix, region = f[2].strip(), f[3].strip(), f[4].strip(), f[5].strip()
        rtype = f[1].strip()
        # altitude: description char followed by altitude 1 (search from the constraint block)
        # X-Plane CIFP: field 22 = altitude description, 23 = altitude 1 (24 = altitude 2, 25 = transition alt)
        alt, desc = None, ""
        if len(f) > 23:
            alt, desc = _alt(f[23]), f[22].strip()
        else:  # short/odd line: first description char directly followed by an altitude
            for i in range(18, len(f) - 1):
                if f[i].strip() in ALT_DESC and f[i].strip():
                    alt, desc = _alt(f[i + 1]), f[i].strip()
                    break
        p = procs[kind].setdefault(name, {"name": name, "runways": set(), "common": [], "rwy": {}, "enroute": {}, "missed": []})
        leg = {"fix": fix, "region": region, "alt": alt, "desc": desc}
        if kind == "APPCH":
            # final approach legs end at the runway fix (RWxx); what follows is the missed approach
            m2 = re.match(r"^RW(\d{2}[LRC]?)", fix)
            if m2:
                p["runways"].add(m2.group(1))
                p["_at_rwy"] = True
                continue
            if p.get("_at_rwy"):
                p["missed"].append(leg)
                continue
            if fix:
                p["common"].append(leg)
            continue
        if trans.startswith("RW"):
            p["runways"].add(trans[2:])
            if fix:
                p["rwy"].setdefault(trans[2:], []).append(leg)
        elif trans in ("", "ALL") or rtype in ("2", "5", "8"):
            if fix:
                p["common"].append(leg)
        else:
            if fix:
                p["enroute"].setdefault(trans, []).append(leg)
    out = {}
    for kind, key in (("SID", "sids"), ("STAR", "stars"), ("APPCH", "apps")):
        lst = []
        for p in procs[kind].values():
            lst.append({"name": p["name"], "runways": sorted(p["runways"]), "common": p["common"],
                        "rwy": p["rwy"], "enroute": p["enroute"], "missed": p.get("missed", [])})
        out[key] = sorted(lst, key=lambda x: x["name"])
    return out


def runway_matches(rwy_tag, rwy):
    """CIFP 'RW26' / '08B' (both parallels) vs active runway '26' / '08L'."""
    t = rwy_tag.upper().lstrip("RW")
    r = rwy.upper()
    if t == r:
        return True
    if t.endswith("B") and r[:2] == t[:2]:
        return True
    return False


# ---------------------------------------------------------------- fixes
def load_fixes(folder, wanted):
    """Positions for the wanted fix idents from earth_fix.dat / earth_nav.dat (streamed)."""
    found = {}
    wanted = set(wanted)
    if not wanted:
        return found
    fp = Path(folder) / "earth_fix.dat"
    if fp.is_file():
        with fp.open("r", encoding="utf-8", errors="replace") as fh:
            for line in fh:
                p = line.split()
                if len(p) >= 3 and p[2] in wanted and p[2] not in found:
                    try:
                        found[p[2]] = (float(p[0]), float(p[1]))
                    except ValueError:
                        pass
    np_ = Path(folder) / "earth_nav.dat"
    if np_.is_file():
        with np_.open("r", encoding="utf-8", errors="replace") as fh:
            for line in fh:
                p = line.split()
                if len(p) >= 8 and p[0] in ("2", "3", "12", "13"):
                    ident = p[7]
                    if ident in wanted and ident not in found:
                        try:
                            found[ident] = (float(p[1]), float(p[2]))
                        except ValueError:
                            pass
    return found


# ---------------------------------------------------------------- EuroScope sector files
def _sct_coord(s):
    m = re.match(r"([NSEW])(\d{3})\.(\d{2})\.(\d{2})\.(\d{3})", s.strip())
    if not m:
        return None
    v = int(m.group(2)) + int(m.group(3)) / 60 + (int(m.group(4)) + int(m.group(5)) / 1000) / 3600
    return -v if m.group(1) in "SW" else v


def parse_sct_fixes(text):
    fixes, section = {}, ""
    for line in text.splitlines():
        line = line.split(";")[0].rstrip()
        if not line.strip():
            continue
        if line.startswith("["):
            section = line.strip().upper()
            continue
        p = line.split()
        if section == "[FIXES]" and len(p) >= 3:
            la, lo = _sct_coord(p[1]), _sct_coord(p[2])
            if la is not None and lo is not None:
                fixes[p[0]] = (la, lo)
        elif section in ("[VOR]", "[NDB]") and len(p) >= 4:
            la, lo = _sct_coord(p[2]), _sct_coord(p[3])
            if la is not None and lo is not None:
                fixes[p[0]] = (la, lo)
    return fixes


def parse_ese(text, icao):
    """SID:<ICAO>:<RWY>:<NAME>:<fix fix fix> lines -> {sids, stars}."""
    sids, stars = {}, {}
    for line in text.splitlines():
        line = line.split(";")[0].strip()
        m = re.match(r"^(SID|STAR):([A-Z0-9]{3,4}):([0-9]{2}[LRC]?):([A-Z0-9]+):(.*)$", line)
        if not m or m.group(2) != icao:
            continue
        kind, rwy, name, route = m.group(1), m.group(3), m.group(4), m.group(5).split()
        d = sids if kind == "SID" else stars
        p = d.setdefault(name, {"name": name, "runways": [], "common": [{"fix": f, "region": "", "alt": None, "desc": ""} for f in route],
                                "rwy": {}, "enroute": {}})
        if rwy not in p["runways"]:
            p["runways"].append(rwy)
    return {"sids": sorted(sids.values(), key=lambda x: x["name"]), "stars": sorted(stars.values(), key=lambda x: x["name"]), "apps": []}


def find_sector_files(folder):
    f = Path(folder)
    if not f.is_dir():
        return [], []
    return sorted(f.rglob("*.ese")), sorted(f.rglob("*.sct"))


# ---------------------------------------------------------------- assembly
def _legs(p, rwy=None):
    legs = list(p["rwy"].get(rwy, [])) if rwy else []
    if rwy and not legs:
        for k, v in p["rwy"].items():
            if runway_matches("RW" + k, rwy):
                legs = list(v)
                break
    return legs + list(p["common"])


def finish(procs, fixes, source, apt_lat, apt_lon):
    """Attach fix positions; compute per-SID exit fix bearing and the initial climb suggestion."""
    def pos(f):
        return fixes.get(f)

    for key in ("sids", "stars", "apps"):
        for p in procs[key]:
            all_legs = _legs(p)
            for lst in [p["common"], *p["rwy"].values(), *p["enroute"].values(), p.get("missed", [])]:
                for leg in lst:
                    ll = pos(leg["fix"])
                    if ll:
                        leg["lat"], leg["lon"] = ll
            if key == "sids":
                legs = [l for l in ([*sum(p["rwy"].values(), []), *p["common"]]) if l.get("lat") is not None]
                exit_leg = legs[-1] if legs else None
                p["exit"] = exit_leg["fix"] if exit_leg else (all_legs[-1]["fix"] if all_legs else None)
                if exit_leg:
                    p["bearing"] = bearing(apt_lat, apt_lon, exit_leg["lat"], exit_leg["lon"])
                alts = [l["alt"] for l in [*sum(p["rwy"].values(), []), *p["common"]] if l.get("alt")]
                p["climb"] = max(alts) if alts else None
    procs["source"] = source
    return procs


def bearing(lat1, lon1, lat2, lon2):
    p1, p2, dl = math.radians(lat1), math.radians(lat2), math.radians(lon2 - lon1)
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def load_procedures(icao, apt_lat, apt_lon, cache_dir, xplane="", mode="auto", custom="", sector="", use_cache=True):
    icao = icao.upper()
    key = json.dumps([xplane, mode, custom, sector])
    cache = Path(cache_dir) / f"{icao}.procs.json"
    if use_cache and cache.is_file():
        try:
            d = json.loads(cache.read_text("utf-8"))
            if d.get("_key") == key:
                return d
        except (OSError, ValueError):
            pass
    result = None
    for kind, folder in data_folders(xplane, mode, custom):
        f = Path(folder) / "CIFP" / f"{icao}.dat"
        if f.is_file():
            procs = parse_cifp(f.read_text("utf-8", "replace"))
            wanted = {l["fix"] for k in ("sids", "stars", "apps") for p in procs[k]
                      for l in [*p["common"], *sum(p["rwy"].values(), []), *sum(p["enroute"].values(), []), *p.get("missed", [])]}
            fixes = load_fixes(folder, wanted)
            info = navdata_info(xplane, mode, custom)
            result = finish(procs, fixes, {"kind": kind, "label": info["label"], "airac": read_cycle(folder)}, apt_lat, apt_lon)
            break
    if result is None and sector:
        eses, scts = find_sector_files(sector)
        for e in eses:
            procs = parse_ese(e.read_text("utf-8", "replace"), icao)
            if procs["sids"] or procs["stars"]:
                fixes = {}
                for s in scts:
                    fixes.update(parse_sct_fixes(s.read_text("utf-8", "replace")))
                result = finish(procs, fixes, {"kind": "euroscope", "label": f"EuroScope sector file {e.name}", "airac": None}, apt_lat, apt_lon)
                break
    if result is None:
        result = {"sids": [], "stars": [], "apps": [], "source": {"kind": "fallback", "label": "No procedures found — generic suggestions", "airac": None}}
    result["_key"] = key
    try:
        cache.parent.mkdir(exist_ok=True)
        cache.write_text(json.dumps(result), "utf-8")
    except OSError:
        pass
    return result
