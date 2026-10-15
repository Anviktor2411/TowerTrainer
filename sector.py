"""EuroScope files generated from the trainer's own airport data (G6).

From a cached airport (cache/<ICAO>.json, the parsed X-Plane Gateway apt.dat) plus, when present, the
procedures (cache/<ICAO>.procs.json) and OpenStreetMap buildings (cache/<ICAO>.osm.json):

  TowerTrainer_<ICAO>.sct   [INFO] [AIRPORT] [RUNWAY] [FIXES] [SID] [STAR] [GEO] [REGIONS] [LABELS]
  TowerTrainer_<ICAO>.ese   [POSITIONS] (the trainer's DEL/GND/TWR/APP/CTR frequencies) [SIDSSTARS]
  TowerTrainer_<ICAO>.asr   a ground display for EuroScope's radar screen
  TowerTrainer <ICAO>.prf   a profile: sector file + ASR, server 127.0.0.1, "Connect to VATSIM" off

Nothing here is copied from any published sector package: every line is derived from the airport data the
trainer already uses. Stdlib only. parse_sct()/parse_ese()/parse_prf() read the files back for the tests.
"""
from __future__ import annotations

import json
import math
import re
from pathlib import Path

POSITION_KEYS = ["DEL", "GND", "TWR", "APP", "CTR"]
POSITION_UNIT = {"DEL": "Delivery", "GND": "Ground", "TWR": "Tower", "APP": "Approach", "CTR": "Control"}
POSITION_FALLBACK_MHZ = {"DEL": 121.805, "GND": 121.905, "TWR": 118.105, "APP": 119.105, "CTR": 132.805}
KIND = {"DEL": "delivery", "GND": "ground", "TWR": "tower", "APP": "approach", "CTR": None}
FACILITY = {"DEL": 2, "GND": 3, "TWR": 4, "APP": 5, "CTR": 6}        # EuroScope facility codes
COLORS = {"TWY": 7566195, "RWY": 8421504, "APRON": 4210752, "BUILDING": 5921370, "SID": 32768, "STAR": 128, "LABEL": 10526880, "BOUNDARY": 2105376}


# ---------------------------------------------------------------- coordinates
def fmt_coord(lat: float, lon: float) -> str:
    """Sector-file coordinate pair: N059.24.48.000 E024.49.57.000."""
    def one(v, pos, neg):
        h = pos if v >= 0 else neg
        v = abs(v)
        d = int(v)
        m = int((v - d) * 60)
        s = ((v - d) * 60 - m) * 60
        if s >= 59.9995:
            s = 0.0
            m += 1
        if m >= 60:
            m = 0
            d += 1
        return f"{h}{d:03d}.{m:02d}.{s:06.3f}"
    return f"{one(lat, 'N', 'S')} {one(lon, 'E', 'W')}"


COORD_RE = re.compile(r"([NS])(\d{3})\.(\d{2})\.(\d{2}\.\d{3})\s+([EW])(\d{3})\.(\d{2})\.(\d{2}\.\d{3})")


def parse_coord(s: str):
    m = COORD_RE.search(s)
    if not m:
        return None
    lat = int(m.group(2)) + int(m.group(3)) / 60 + float(m.group(4)) / 3600
    lon = int(m.group(6)) + int(m.group(7)) / 60 + float(m.group(8)) / 3600
    return (lat if m.group(1) == "N" else -lat, lon if m.group(5) == "E" else -lon)


class Proj:
    """Local metres (x east, y north, as aptdat.py writes them) <-> lat/lon."""

    def __init__(self, lat0: float, lon0: float):
        self.lat0, self.lon0 = lat0, lon0
        self.kx = math.cos(math.radians(lat0)) * 111320.0
        self.ky = 110540.0

    def ll(self, p):
        return self.lat0 + p[1] / self.ky, self.lon0 + p[0] / self.kx

    def c(self, p):
        return fmt_coord(*self.ll(p))


# ---------------------------------------------------------------- the trainer's positions (mirrors positions.js)
def unit_name(apt: dict) -> str:
    for f in apt.get("freqs", []):
        if f.get("kind") == "tower" and f.get("name"):
            return re.sub(r"\s+(tower|twr)\s*$", "", f["name"], flags=re.I)
    return apt.get("name", apt["icao"]).split()[0]


def positions(apt: dict) -> dict:
    freq = {}
    for f in apt.get("freqs", []):
        freq.setdefault(f["kind"], f)
    used = []
    out = {}
    call = unit_name(apt)
    icao = apt["icao"]
    for k in POSITION_KEYS:
        mhz = None
        kind = KIND[k]
        f = freq.get(kind) if kind else None
        if f and f["mhz"] not in used:
            mhz = f["mhz"]
        if k == "APP" and not mhz and freq.get("departure"):
            mhz = freq["departure"]["mhz"]
        if not mhz or mhz in used:
            mhz = POSITION_FALLBACK_MHZ[k]
            while any(abs(u - mhz) < 0.004 for u in used):
                mhz += 0.025
        used.append(mhz)
        name = f"{call} {POSITION_UNIT[k]}" if k != "APP" else ((f or freq.get("departure") or {}).get("name") or f"{call} Approach")
        out[k] = {"key": k, "mhz": round(mhz, 3), "name": name, "cs": f"{icao[:2]}_CTR" if k == "CTR" else f"{icao}_{k}"}
    return out


# ---------------------------------------------------------------- builders
def _runway_ends(apt: dict, pr: Proj):
    rows = []
    for r in apt["runways"]:
        e0, e1 = r["ends"]
        dx, dy = e1["pos"][0] - e0["pos"][0], e1["pos"][1] - e0["pos"][1]
        hdg = (math.degrees(math.atan2(dx, dy)) + 360) % 360
        rows.append((e0, e1, hdg, (hdg + 180) % 360))
    return rows


def build_sct(apt: dict, procs: dict | None = None, osm: dict | None = None) -> str:
    pr = Proj(apt["lat"], apt["lon"])
    icao = apt["icao"]
    name = apt.get("name", icao)
    L = []
    for k, v in COLORS.items():
        L.append(f"#define {k} {v}")
    L += ["", "[INFO]", f"TowerTrainer {icao}", f"{icao}_TWR", icao, fmt_coord(apt["lat"], apt["lon"]).split()[0], fmt_coord(apt["lat"], apt["lon"]).split()[1],
          "60", f"{60 * math.cos(math.radians(apt['lat'])):.3f}", "0", "1", ""]
    L += ["[AIRPORT]", f"{icao} 000.000 {fmt_coord(apt['lat'], apt['lon'])} D", ""]
    L.append("[RUNWAY]")
    for e0, e1, h0, h1 in _runway_ends(apt, pr):
        L.append(f"{e0['name']:<4}{e1['name']:<4}{round(h0):03d} {round(h1):03d} {pr.c(e0['pos'])} {pr.c(e1['pos'])} {icao} {name}")
    L.append("")
    # procedure fixes and lines
    fixes = {}
    sids, stars = [], []
    for kind, lst in (("sid", (procs or {}).get("sids") or []), ("star", (procs or {}).get("stars") or [])):
        for p in lst:
            legs = []
            for rw, rl in (p.get("rwy") or {}).items():
                legs = (rl + p.get("common", [])) if kind == "sid" else (p.get("common", []) + rl)
                break
            if not legs:
                legs = p.get("common", [])
            pts = [(l["fix"], l["lat"], l["lon"]) for l in legs if l.get("lat") is not None and l.get("fix")]
            for fx, la, lo in pts:
                fixes.setdefault(fx, (la, lo))
            if len(pts) >= 2:
                (sids if kind == "sid" else stars).append((p["name"], pts))
    L.append("[FIXES]")
    for fx, (la, lo) in sorted(fixes.items()):
        L.append(f"{fx} {fmt_coord(la, lo)}")
    L.append("")
    for title, lst in (("[SID]", sids), ("[STAR]", stars)):
        L.append(title)
        for nm, pts in lst:
            label = f"{icao} {nm}"
            for i in range(len(pts) - 1):
                a, b = pts[i], pts[i + 1]
                L.append(f"{label if i == 0 else '':<26} {fmt_coord(a[1], a[2])} {fmt_coord(b[1], b[2])}")
        L.append("")
    # ground geometry
    L.append("[GEO]")
    first = True
    for line in apt.get("lines", []):
        for i in range(len(line) - 1):
            L.append(f"{(icao + ' Taxiways') if first else '':<16} {pr.c(line[i])} {pr.c(line[i + 1])} TWY")
            first = False
    first = True
    for line in apt.get("holdLines", []):
        for i in range(len(line) - 1):
            L.append(f"{(icao + ' Holding points') if first else '':<16} {pr.c(line[i])} {pr.c(line[i + 1])} RWY")
            first = False
    for b in (osm or {}).get("buildings", []):
        pts = b.get("pts") or []
        if len(pts) < 3 or b.get("kind") in ("apron", "parking"):
            continue
        tag = f"{icao} Buildings"
        for i in range(len(pts)):
            L.append(f"{tag if i == 0 else '':<16} {pr.c(pts[i])} {pr.c(pts[(i + 1) % len(pts)])} BUILDING")
    L.append("")
    L.append("[REGIONS]")
    for rings in apt.get("pavement", []):
        ring = rings[0] if rings else []
        if len(ring) < 3:
            continue
        L.append(f"REGIONNAME {icao} Apron")
        L.append(f"APRON {pr.c(ring[0])}")
        for p in ring[1:]:
            L.append(f"{'':<5} {pr.c(p)}")
    for e0, e1, h0, h1 in _runway_ends(apt, pr):
        pass
    for r in apt["runways"]:
        e0, e1 = r["ends"]
        dx, dy = e1["pos"][0] - e0["pos"][0], e1["pos"][1] - e0["pos"][1]
        ln = math.hypot(dx, dy) or 1
        nx, ny = -dy / ln * r["width"] / 2, dx / ln * r["width"] / 2
        quad = [(e0["pos"][0] + nx, e0["pos"][1] + ny), (e1["pos"][0] + nx, e1["pos"][1] + ny), (e1["pos"][0] - nx, e1["pos"][1] - ny), (e0["pos"][0] - nx, e0["pos"][1] - ny)]
        L.append(f"REGIONNAME {icao} Runway {e0['name']}/{e1['name']}")
        L.append(f"RWY {pr.c(quad[0])}")
        for p in quad[1:]:
            L.append(f"{'':<3} {pr.c(p)}")
    L.append("")
    L.append("[LABELS]")
    seen = set()
    nodes = apt.get("nodes", [])
    for e in apt.get("edges", []):
        nm = (e.get("name") or "").upper()
        if not nm or e.get("runway") or nm in seen or e["a"] >= len(nodes) or e["b"] >= len(nodes):
            continue
        seen.add(nm)
        a, b = nodes[e["a"]], nodes[e["b"]]
        L.append(f'"{nm}" {pr.c(((a[0] + b[0]) / 2, (a[1] + b[1]) / 2))} LABEL')
    for st in apt.get("stands", []):
        if st.get("name"):
            L.append(f'"{st["name"]}" {pr.c(st["pos"])} LABEL')
    L.append("")
    return "\n".join(L)


def build_ese(apt: dict, procs: dict | None = None) -> str:
    icao = apt["icao"]
    pos = positions(apt)
    L = ["[POSITIONS]"]
    # name:callsign:frequency:identifier:middle letter:prefix:suffix:-:-:squawk start:squawk end
    sq = {"DEL": ("4201", "4277"), "GND": ("4201", "4277"), "TWR": ("4201", "4277"), "APP": ("4301", "4377"), "CTR": ("4401", "4477")}
    for k in POSITION_KEYS:
        p = pos[k]
        ident = {"DEL": "D", "GND": "G", "TWR": "T", "APP": "A", "CTR": "C"}[k]
        L.append(f"{p['name']}:{p['cs']}:{p['mhz']:.3f}:{ident}{icao[-2:]}:{ident}:{p['cs'].split('_')[0]}:{k}:-:-:{sq[k][0]}:{sq[k][1]}")
    L += ["", "[SIDSSTARS]"]
    for kind, lst in (("SID", (procs or {}).get("sids") or []), ("STAR", (procs or {}).get("stars") or [])):
        for p in lst:
            rws = list((p.get("rwy") or {}).keys()) or p.get("runways") or [""]
            for rw in rws:
                legs = (p.get("rwy", {}).get(rw, []) + p.get("common", [])) if kind == "SID" else (p.get("common", []) + p.get("rwy", {}).get(rw, []))
                route = " ".join(l["fix"] for l in legs if l.get("fix"))
                if route:
                    L.append(f"{kind}:{icao}:{str(rw).replace('RW', '')}:{p['name']}:{route}")
    L.append("")
    return "\n".join(L)


def build_asr(apt: dict, sct_path: str) -> str:
    icao = apt["icao"]
    pr = Proj(apt["lat"], apt["lon"])
    xs = [p[0] for r in apt["runways"] for e in r["ends"] for p in [e["pos"]]]
    ys = [p[1] for r in apt["runways"] for e in r["ends"] for p in [e["pos"]]]
    for st in apt.get("stands", []):
        xs.append(st["pos"][0]); ys.append(st["pos"][1])
    m = 600
    lat1, lon1 = pr.ll((min(xs) - m, min(ys) - m))
    lat2, lon2 = pr.ll((max(xs) + m, max(ys) + m))
    L = [f"SECTORFILE:{sct_path}", f"SECTORTITLE:TowerTrainer {icao}", "DisplayTypeName:Standard ES radar screen", "DisplayTypeNeedRadarContent:1", "DisplayTypeGeoReferenced:1",
         f"WINDOWAREA:{lat1:.6f}:{lon1:.6f}:{lat2:.6f}:{lon2:.6f}", f"Airports:{icao}:name", f"Geo:{icao} Taxiways:1", f"Geo:{icao} Holding points:1", f"Geo:{icao} Buildings:1",
         f"Regions:{icao} Apron:1"]
    for r in apt["runways"]:
        e0, e1 = r["ends"]
        L.append(f"Regions:{icao} Runway {e0['name']}/{e1['name']}:1")
        L.append(f"Runways:{icao} {e0['name']}-{e1['name']}:name")
        L.append(f"Runways:{icao} {e0['name']}-{e1['name']}:centerline")
    L += ["Free Text:TowerTrainer:1", "Labels:Standard:1", "ShowLeader:1", "LeaderLength:1", "HistoryDots:5", "StandbyCode:1", "RadarRange:30", "ListsPosition:1"]
    return "\n".join(L) + "\n"


def build_prf(icao: str, sct_path: str, asr_path: str, callsign: str = "", server: str = "127.0.0.1", realname: str = "Tower Trainer") -> str:
    cs = callsign or f"{icao}_TWR"
    fac = FACILITY.get(cs.rsplit("_", 1)[-1], 4)
    rows = [("Settings", "m_SectorFile", sct_path), ("Settings", "m_Asr", asr_path), ("LastSession", "callsign", cs), ("LastSession", "realname", realname),
            ("LastSession", "certificate", "1000000"), ("LastSession", "password", ""), ("LastSession", "rating", "3"), ("LastSession", "server", server),
            ("LastSession", "tovatsim", "0"), ("LastSession", "facility", str(fac)), ("LastSession", "range", "30"), ("LastSession", "flightplanrange", "30"),
            ("RecentFiles", "Recent1", asr_path)]
    return "\n".join("\t".join(r) for r in rows) + "\n"


def write_package(apt: dict, out_dir: str | Path, procs: dict | None = None, osm: dict | None = None, callsign: str = "", es_dir: str | Path | None = None) -> dict:
    """Write all four files into out_dir; es_dir is where EuroScope will see them (for the absolute paths in .prf/.asr)."""
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    icao = apt["icao"]
    base = Path(es_dir) if es_dir else out
    sct = out / f"TowerTrainer_{icao}.sct"
    ese = out / f"TowerTrainer_{icao}.ese"
    asr = out / f"TowerTrainer_{icao}.asr"
    prf = out / f"TowerTrainer {icao}.prf"
    sct.write_text(build_sct(apt, procs, osm), "utf-8", newline="\r\n")
    ese.write_text(build_ese(apt, procs), "utf-8", newline="\r\n")
    asr.write_text(build_asr(apt, str(base / sct.name)), "utf-8", newline="\r\n")
    prf.write_text(build_prf(icao, str(base / sct.name), str(base / asr.name), callsign), "utf-8", newline="\r\n")
    return {"sct": str(sct), "ese": str(ese), "asr": str(asr), "prf": str(prf)}


# ---------------------------------------------------------------- readers (for tests and the wizard's checks)
def parse_sct(text: str) -> dict:
    """Sections -> list of non-empty lines; also counts coordinates and the defines."""
    sections, cur = {}, None
    defines = {}
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith(";"):
            continue
        if line.startswith("#define"):
            parts = line.split()
            if len(parts) == 3:
                defines[parts[1]] = int(parts[2])
            continue
        m = re.fullmatch(r"\[([A-Z ]+)\]", line)
        if m:
            cur = m.group(1)
            sections[cur] = []
            continue
        if cur is not None:
            sections[cur].append(line)
    coords = [parse_coord(l) for sec in sections.values() for l in sec if COORD_RE.search(l)]
    return {"sections": sections, "defines": defines, "coords": [c for c in coords if c]}


def parse_ese(text: str) -> dict:
    sec = parse_sct(text)["sections"]
    pos = []
    for l in sec.get("POSITIONS", []):
        f = l.split(":")
        if len(f) >= 3:
            pos.append({"name": f[0], "cs": f[1], "mhz": float(f[2])})
    return {"positions": pos, "sidsstars": sec.get("SIDSSTARS", [])}


def parse_prf(text: str) -> dict:
    out = {}
    for l in text.splitlines():
        f = l.rstrip("\r\n").split("\t")
        if len(f) >= 2:
            out[(f[0], f[1])] = f[2] if len(f) > 2 else ""
    return out


def load_cached(cache_dir: str | Path, icao: str):
    """(apt, procs, osm) from the trainer's cache; procs/osm may be None."""
    c = Path(cache_dir)
    apt = json.loads((c / f"{icao}.json").read_text("utf-8"))
    procs = osm = None
    if (c / f"{icao}.procs.json").exists():
        try:
            procs = json.loads((c / f"{icao}.procs.json").read_text("utf-8"))
        except ValueError:
            procs = None
    if (c / f"{icao}.osm.json").exists():
        try:
            osm = json.loads((c / f"{icao}.osm.json").read_text("utf-8"))
        except ValueError:
            osm = None
    return apt, procs, osm
