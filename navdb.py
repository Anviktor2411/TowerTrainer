"""One indexed navigation database for search, the map, the command parser and the traffic generator.

Built once in a background thread from local files only and cached in cache/navdb.sqlite (git-ignored, it may hold
Navigraph data). Rebuilt only when the sources change: the folders, their files' mtimes and AIRAC cycles are the key.

Sources, in priority order (the first one that has an item wins):
  1) Navigraph Custom Data (<X-Plane>/Custom Data)
  2) X-Plane default data (<X-Plane>/Resources/default data) + the global apt.dat
  3) EuroScope sector files (.sct fixes / VOR / NDB / airports)
  4) user files (nav_user/*.json) and the OpenFlights airport list (IATA codes, city names) when it is cached

Files read: apt.dat / earth_aptmeta.dat (airports, runways, frequencies), earth_fix.dat, earth_nav.dat (VOR, NDB, DME,
ILS), earth_awy.dat (airways with levels), earth_hold.dat, earth_msa.dat, earth_mora.dat, airspaces/ (OpenAir) and
the CIFP folder (procedure names and the fixes they use; legs are parsed lazily per airport by navdata.py).
"""
import csv
import io
import json
import math
import os
import re
import sqlite3
import threading
import time
from pathlib import Path

import navdata

SCHEMA = """
CREATE TABLE meta(k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE airports(icao TEXT PRIMARY KEY, iata TEXT, name TEXT, city TEXT, country TEXT, lat REAL, lon REAL,
  elev INTEGER, runways TEXT, freqs TEXT, src TEXT);
CREATE TABLE fixes(ident TEXT, region TEXT, lat REAL, lon REAL, area TEXT, spoken TEXT, src TEXT);
CREATE TABLE navaids(ident TEXT, region TEXT, type TEXT, lat REAL, lon REAL, freq REAL, name TEXT, area TEXT, src TEXT);
CREATE TABLE airways(name TEXT, f1 TEXT, f2 TEXT, lat1 REAL, lon1 REAL, lat2 REAL, lon2 REAL, level TEXT, base INTEGER, top INTEGER, dir TEXT);
CREATE TABLE holds(fix TEXT, region TEXT, area TEXT, inbound REAL, turn TEXT, legtime REAL, legdist REAL, minalt INTEGER, maxalt INTEGER, speed INTEGER, lat REAL, lon REAL);
CREATE TABLE msa(ident TEXT, airport TEXT, lat REAL, lon REAL, sectors TEXT);
CREATE TABLE mora(lat REAL, lon REAL, ft INTEGER);
CREATE TABLE airspaces(name TEXT, cls TEXT, low TEXT, high TEXT, poly TEXT, minlat REAL, maxlat REAL, minlon REAL, maxlon REAL);
CREATE TABLE procs(icao TEXT, name TEXT, kind TEXT, runways TEXT, fixes TEXT);
"""
INDEXES = """
CREATE INDEX i_apt_iata ON airports(iata);
CREATE INDEX i_apt_ll ON airports(lat, lon);
CREATE INDEX i_fix_id ON fixes(ident);
CREATE INDEX i_fix_ll ON fixes(lat, lon);
CREATE INDEX i_nav_id ON navaids(ident);
CREATE INDEX i_nav_ll ON navaids(lat, lon);
CREATE INDEX i_awy ON airways(name);
CREATE INDEX i_awy_ll ON airways(lat1, lon1);
CREATE INDEX i_awy_f ON airways(f1);
CREATE INDEX i_hold ON holds(fix);
CREATE INDEX i_proc ON procs(name);
CREATE INDEX i_proc_apt ON procs(icao);
"""
NAV_TYPES = {"2": "NDB", "3": "VOR", "4": "ILS", "5": "LOC", "6": "GS", "7": "OM", "8": "MM", "9": "IM", "12": "DME", "13": "DME"}
VERSION = "1"


# ---------------------------------------------------------------- geometry
def nm_between(lat1, lon1, lat2, lon2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2
    return 2 * 3440.065 * math.asin(min(1.0, math.sqrt(a)))


def spoken(ident, name="", kind="fix"):
    """How a controller says it: a five-letter fix as a word ("Lakut"), a navaid by its name ("Tallinn VOR")."""
    if kind in ("VOR", "NDB", "DME") and name:
        n = re.sub(r"\b(VOR[-/]DME|VORTAC|TACAN|VOR|DME|NDB)\b", "", name, flags=re.I).strip(" /-")
        return f"{n.title()} {kind}" if n else ident
    if kind == "fix" and re.fullmatch(r"[A-Z]{5}", ident or ""):
        return ident.title()
    return ident


def norm(s):
    return re.sub(r"[^a-z0-9]", "", str(s).lower())


def edit_distance(a, b, limit=3):
    """Damerau-Levenshtein (optimal string alignment) with an early exit above `limit`."""
    if abs(len(a) - len(b)) > limit:
        return limit + 1
    prev2, prev = None, list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i] + [0] * len(b)
        best = cur[0]
        for j, cb in enumerate(b, 1):
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb))
            if prev2 is not None and i > 1 and j > 1 and ca == b[j - 2] and a[i - 2] == cb:
                cur[j] = min(cur[j], prev2[j - 2] + 1)
            best = min(best, cur[j])
        if best > limit:
            return limit + 1
        prev2, prev = prev, cur
    return prev[-1]


# ---------------------------------------------------------------- parsers (each yields rows, tolerant of odd lines)
def _f(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


def parse_fix_lines(lines, src):
    for line in lines:
        p = line.split()
        if len(p) < 3 or p[0] in ("I", "A") or p[0].startswith("99"):
            continue
        lat, lon = _f(p[0]), _f(p[1])
        if lat is None or lon is None or abs(lat) > 90:
            continue
        name = " ".join(p[6:]) if len(p) > 6 else ""
        yield (p[2], p[4] if len(p) > 4 else "", lat, lon, p[3] if len(p) > 3 else "", name or spoken(p[2]), src)


def parse_nav_lines(lines, src):
    for line in lines:
        p = line.split()
        if len(p) < 9 or p[0] not in NAV_TYPES:
            continue
        lat, lon = _f(p[1]), _f(p[2])
        if lat is None or lon is None:
            continue
        t = NAV_TYPES[p[0]]
        freq = _f(p[4])
        if freq is not None:
            freq = freq / 100 if t not in ("NDB",) else freq
        ident, area, region = p[7], p[8], p[9] if len(p) > 9 else ""
        name = " ".join(p[10:]) if len(p) > 10 else ""
        yield (ident, region, t, lat, lon, freq, name, area, src)


def parse_awy_lines(lines):
    """earth_awy.dat: fix1 region1 type1 fix2 region2 type2 direction level base top names(a-b-c)."""
    for line in lines:
        p = line.split()
        if len(p) < 11 or not p[1].isalnum():
            continue
        lvl = {"1": "L", "2": "H"}.get(p[7], p[7])
        for name in p[10].split("-"):
            yield (name, p[0], p[1], p[3], p[4], lvl, int(_f(p[8]) or 0), int(_f(p[9]) or 0), p[6])


def parse_hold_lines(lines):
    """earth_hold.dat: fix region airport type inbound legtime legdist turn minalt maxalt speed."""
    for line in lines:
        p = line.split()
        if len(p) < 11 or _f(p[4]) is None:
            continue
        yield (p[0], p[1], p[2], _f(p[4]), p[7], _f(p[5]), _f(p[6]), int(_f(p[8]) or 0), int(_f(p[9]) or 0), int(_f(p[10]) or 0))


def parse_msa_lines(lines):
    """earth_msa.dat (tolerant): the centre ident, the airport, then (bearing, altitude, radius) triples."""
    for line in lines:
        p = line.split()
        if len(p) < 5 or p[0] in ("I", "A") or p[0].startswith("99"):
            continue
        words = [x for x in p if not re.fullmatch(r"-?\d+(?:\.\d+)?", x)]
        nums = [float(x) for x in p if re.fullmatch(r"-?\d+(?:\.\d+)?", x)]
        apt = next((x for x in words if re.fullmatch(r"[A-Z]{4}", x)), "")
        ident = next((x for x in words if re.fullmatch(r"[A-Z0-9]{2,5}", x) and x != apt and len(x) != 1), "")
        if not ident or len(nums) < 3:
            continue
        nums = nums[len(nums) % 3:]
        yield (ident, apt, [{"brg": nums[i], "alt": nums[i + 1], "nm": nums[i + 2]} for i in range(0, len(nums), 3)])


def parse_mora_lines(lines):
    for line in lines:
        p = line.split()
        if len(p) == 3 and all(_f(x) is not None for x in p):
            v = _f(p[2])
            yield (_f(p[0]), _f(p[1]), int(v * 100 if v < 500 else v))


def parse_openair(text):
    """OpenAir airspace text -> [{name, cls, low, high, poly:[[lat,lon],...]}] (DP points and circles DC)."""
    out, cur, centre = [], None, None

    def coord(s):
        m = re.match(r"\s*(\d+):(\d+)(?::(\d+(?:\.\d+)?))?\s*([NS])\s*(\d+):(\d+)(?::(\d+(?:\.\d+)?))?\s*([EW])", s)
        if not m:
            return None
        la = int(m.group(1)) + int(m.group(2)) / 60 + float(m.group(3) or 0) / 3600
        lo = int(m.group(5)) + int(m.group(6)) / 60 + float(m.group(7) or 0) / 3600
        return [-la if m.group(4) == "S" else la, -lo if m.group(8) == "W" else lo]

    for raw in text.splitlines():
        line = raw.split("*")[0].strip()
        if not line:
            continue
        tag, _, rest = line.partition(" ")
        if tag == "AC":
            cur = {"name": "", "cls": rest.strip(), "low": "", "high": "", "poly": []}
            out.append(cur)
        elif cur is None:
            continue
        elif tag == "AN":
            cur["name"] = rest.strip()
        elif tag == "AL":
            cur["low"] = rest.strip()
        elif tag == "AH":
            cur["high"] = rest.strip()
        elif tag == "DP":
            c = coord(rest)
            if c:
                cur["poly"].append(c)
        elif tag == "V" and rest.strip().upper().startswith("X="):
            centre = coord(rest.strip()[2:])
        elif tag == "DC" and centre:
            r = (_f(rest) or 0) / 60.0
            for k in range(0, 360, 10):
                a = math.radians(k)
                cur["poly"].append([centre[0] + r * math.cos(a), centre[1] + r * math.sin(a) / max(0.2, math.cos(math.radians(centre[0])))])
    return [a for a in out if len(a["poly"]) >= 3]


def parse_apt_lines(lines):
    """apt.dat airports: header (1/16/17), 1302 metadata, 100 runways, 50-56 / 1050-1056 frequencies."""
    FREQ = {"50": "ATIS", "51": "UNICOM", "52": "DEL", "53": "GND", "54": "TWR", "55": "APP", "56": "DEP",
            "1050": "ATIS", "1051": "UNICOM", "1052": "DEL", "1053": "GND", "1054": "TWR", "1055": "APP", "1056": "DEP"}
    cur = None
    for line in lines:
        code = line[:5].split(" ", 1)[0]
        if code in ("1", "16", "17"):
            if cur:
                yield cur
            p = line.split(None, 5)
            if len(p) < 5:
                cur = None
                continue
            cur = {"icao": p[4], "name": p[5].strip() if len(p) > 5 else "", "elev": int(_f(p[1]) or 0), "iata": "", "city": "",
                   "country": "", "lat": None, "lon": None, "runways": [], "freqs": []}
        elif cur is None:
            continue
        elif code == "1302":
            p = line.split(None, 2)
            if len(p) == 3:
                k, v = p[1], p[2].strip()
                if k == "iata_code":
                    cur["iata"] = v
                elif k == "city":
                    cur["city"] = v
                elif k == "country":
                    cur["country"] = v
                elif k == "icao_code" and v:
                    cur["icao_real"] = v
                elif k == "datum_lat":
                    cur["lat"] = _f(v)
                elif k == "datum_lon":
                    cur["lon"] = _f(v)
        elif code == "100":
            p = line.split()
            if len(p) >= 20:
                la1, lo1, la2, lo2 = _f(p[9]), _f(p[10]), _f(p[18]), _f(p[19])
                if None not in (la1, lo1, la2, lo2):
                    cur["runways"].append({"ends": [p[8], p[17]], "lat": (la1 + la2) / 2, "lon": (lo1 + lo2) / 2,
                                           "len_m": round(nm_between(la1, lo1, la2, lo2) * 1852), "width_m": _f(p[1])})
                    if cur["lat"] is None:
                        cur["_ll"] = ((la1 + la2) / 2, (lo1 + lo2) / 2)
        elif code in FREQ:
            p = line.split(None, 2)
            if len(p) >= 2 and _f(p[1]):
                f = _f(p[1])
                f = f / 1000 if code.startswith("10") else f / 100
                cur["freqs"].append({"kind": FREQ[code], "mhz": round(f, 3), "name": p[2].strip() if len(p) > 2 else ""})
    if cur:
        yield cur


def parse_aptmeta_lines(lines):
    """earth_aptmeta.dat (tolerant): ICAO first, then a plausible latitude / longitude pair."""
    for line in lines:
        p = line.split()
        if len(p) < 3 or not re.fullmatch(r"[A-Z0-9]{3,4}", p[0]):
            continue
        nums = [_f(x) for x in p[1:8]]
        for i in range(len(nums) - 1):
            if nums[i] is not None and nums[i + 1] is not None and abs(nums[i]) <= 90 and abs(nums[i + 1]) <= 180 and ("." in p[1 + i]):
                yield {"icao": p[0], "lat": nums[i], "lon": nums[i + 1]}
                break


def scan_cifp_names(text):
    """Procedure names + runways + the fixes they use, from one CIFP file (no leg details)."""
    procs = {}
    for line in text.splitlines():
        m = re.match(r"^(SID|STAR|APPCH):", line)
        if not m:
            continue
        f = line[m.end():].split(",")
        if len(f) < 6:
            continue
        name, trans, fix = f[2].strip(), f[3].strip(), f[4].strip()
        p = procs.setdefault((m.group(1), name), [set(), set()])
        if trans.startswith("RW"):
            p[0].add(trans[2:])
        rw = re.match(r"^RW(\d{2}[LRC]?)", fix)
        if rw:
            p[0].add(rw.group(1))
        elif fix:
            p[1].add(fix)
    return [(k, n, sorted(v[0]), sorted(v[1])) for (k, n), v in procs.items()]


def approach_title(name):
    """CIFP approach id -> what a pilot says: I26 -> ILS 26, R08-Y -> RNAV 08 Y, L.. LOC, V.. VOR, N.. NDB."""
    m = re.match(r"^([IRLVNDBGHJPQSTUX])(\d{2}[LRC]?)-?([A-Z])?$", name)
    if not m:
        return name
    kind = {"I": "ILS", "R": "RNAV", "L": "LOC", "V": "VOR", "N": "NDB", "D": "VOR/DME", "B": "LOC BC", "G": "IGS",
            "H": "RNAV(RNP)", "J": "GLS", "P": "GPS", "Q": "NDB/DME", "S": "VOR", "T": "TACAN", "X": "LDA", "U": "SDF"}[m.group(1)]
    return f"{kind} {m.group(2)}" + (f" {m.group(3)}" if m.group(3) else "")


def _lines(path):
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            for line in fh:
                yield line
    except OSError:
        return


# ---------------------------------------------------------------- the database
class NavDB:
    def __init__(self, cache_dir, settings=None, user_dir=None):
        self.cache_dir = Path(cache_dir)
        self.path = self.cache_dir / "navdb.sqlite"
        self.user_dir = Path(user_dir) if user_dir else self.cache_dir.parent / "nav_user"
        self.settings = settings or {}
        self.state = "idle"            # idle | building | ready | none | error
        self.progress = 0.0
        self.step = ""
        self.error = ""
        self.counts = {}
        self.key = None
        self._lock = threading.Lock()
        self._names = None              # in-memory fuzzy list [(token, kind, id, label)]
        self._thread = None

    # ---- sources
    def sources(self):
        """[(kind, folder)] in priority order + the apt.dat files + sector files + user files."""
        s = self.settings
        folders = navdata.data_folders(s.get("xplane", ""), s.get("mode", "auto"), s.get("custom", ""))
        xp = navdata.find_xplane(s.get("xplane", ""))
        apts = []
        if xp:
            for rel in ("Global Scenery/Global Airports/Earth nav data/apt.dat", "Resources/default scenery/default apt dat/Earth nav data/apt.dat"):
                if (Path(xp) / rel).is_file():
                    apts.append(str(Path(xp) / rel))
                    break
        sector = s.get("sector", "")
        scts = [str(x) for x in navdata.find_sector_files(sector)[1]] if sector else []
        users = sorted(str(x) for x in self.user_dir.glob("*.json")) if self.user_dir.is_dir() else []
        of = self.cache_dir / "openflights" / "airports.dat"
        return {"folders": folders, "apt": apts, "sct": scts, "user": users, "openflights": [str(of)] if of.is_file() else []}

    def signature(self):
        src = self.sources()
        parts = [VERSION]
        for kind, folder in src["folders"]:
            f = Path(folder)
            parts.append([kind, folder, navdata.read_cycle(folder)] + [navdata._mtime(f / n) for n in
                         ("earth_fix.dat", "earth_nav.dat", "earth_awy.dat", "earth_hold.dat", "earth_msa.dat", "earth_mora.dat", "CIFP", "airspaces")])
        for k in ("apt", "sct", "user", "openflights"):
            parts.append([[x, navdata._mtime(x)] for x in src[k]])
        return json.dumps(parts), src

    # ---- lifecycle
    def start(self, force=False):
        """Open the cached index when it matches the sources, else build it in the background. Never blocks."""
        with self._lock:
            if self._thread and self._thread.is_alive():
                return self
            key, src = self.signature()
            if not force and self.path.is_file():
                try:
                    con = sqlite3.connect(self.path)
                    k = con.execute("SELECT v FROM meta WHERE k='key'").fetchone()
                    counts = con.execute("SELECT v FROM meta WHERE k='counts'").fetchone()
                    con.close()
                    if k and k[0] == key:
                        self.key, self.state, self.progress = key, "ready", 1.0
                        self.counts = json.loads(counts[0]) if counts else {}
                        self._names = None
                        return self
                except sqlite3.Error:
                    pass
            if not any(src[k] for k in ("folders", "apt", "sct", "user", "openflights")):
                self.state, self.progress, self.step = "none", 1.0, "no nav data found"
                return self
            self.state, self.progress, self.step, self.error = "building", 0.0, "starting", ""
            self._thread = threading.Thread(target=self._build, args=(key, src), daemon=True)
            self._thread.start()
            return self

    def wait(self, timeout=600):
        t = self._thread
        if t:
            t.join(timeout)
        return self

    def status(self):
        s = self.settings
        info = navdata.navdata_info(s.get("xplane", ""), s.get("mode", "auto"), s.get("custom", ""))
        return {"state": self.state, "progress": round(self.progress, 3), "step": self.step, "error": self.error,
                "counts": self.counts, "folder": info.get("folder"), "airac": info.get("airac"), "current": info.get("current"),
                "outdated": info.get("outdated"), "label": info.get("label"), "installs": info.get("installs", []),
                "xplane": info.get("xplane"), "sources": self.counts.get("_sources", [])}

    def _build(self, key, src):
        tmp = self.path.with_suffix(".building")
        try:
            self.cache_dir.mkdir(parents=True, exist_ok=True)
            if tmp.exists():
                tmp.unlink()
            con = sqlite3.connect(tmp)
            con.executescript(SCHEMA)
            counts, used = {}, []
            steps = len(src["folders"]) * 8 + len(src["apt"]) + 3
            done = [0]

            def tick(name):
                done[0] += 1
                self.step = name
                self.progress = min(0.99, done[0] / steps)

            seen_fix, seen_nav = set(), set()
            for kind, folder in src["folders"]:          # best first: later folders only add what is missing
                f = Path(folder)
                used.append(f"{navdata.SOURCE_LABEL.get(kind, kind)}: {folder}")
                tick(f"fixes ({kind})")
                rows = [r for r in parse_fix_lines(_lines(f / "earth_fix.dat"), kind) if (r[0], r[1]) not in seen_fix]
                seen_fix.update((r[0], r[1]) for r in rows)
                con.executemany("INSERT INTO fixes VALUES(?,?,?,?,?,?,?)", rows)
                tick(f"navaids ({kind})")
                rows = [r for r in parse_nav_lines(_lines(f / "earth_nav.dat"), kind) if (r[0], r[1], r[2]) not in seen_nav]
                seen_nav.update((r[0], r[1], r[2]) for r in rows)
                con.executemany("INSERT INTO navaids VALUES(?,?,?,?,?,?,?,?,?)", rows)
                tick(f"airways ({kind})")
                if not con.execute("SELECT 1 FROM airways LIMIT 1").fetchone():
                    self._airways(con, f / "earth_awy.dat")
                tick(f"holdings ({kind})")
                if not con.execute("SELECT 1 FROM holds LIMIT 1").fetchone():
                    self._holds(con, f / "earth_hold.dat")
                tick(f"MSA ({kind})")
                if not con.execute("SELECT 1 FROM msa LIMIT 1").fetchone():
                    self._msa(con, f / "earth_msa.dat")
                tick(f"MORA ({kind})")
                if not con.execute("SELECT 1 FROM mora LIMIT 1").fetchone():
                    con.executemany("INSERT INTO mora VALUES(?,?,?)", parse_mora_lines(_lines(f / "earth_mora.dat")))
                tick(f"airspaces ({kind})")
                if not con.execute("SELECT 1 FROM airspaces LIMIT 1").fetchone():
                    self._airspaces(con, f / "airspaces")
                tick(f"procedures ({kind})")
                self._procs(con, f / "CIFP")
                tick(f"airport list ({kind})")
                self._aptmeta(con, f / "earth_aptmeta.dat", kind)
            for a in src["apt"]:
                tick("apt.dat airports")
                self._aptdat(con, a)
            tick("sector files / user files")
            for sct in src["sct"]:
                self._sector(con, sct, seen_fix, seen_nav)
                used.append(f"EuroScope: {sct}")
            for u in src["user"]:
                self._user(con, u)
                used.append(f"user: {u}")
            tick("OpenFlights airports")
            for of in src["openflights"]:
                self._openflights(con, of)
                used.append("OpenFlights airport list (IATA / city)")
            tick("indexes")
            con.executescript(INDEXES)
            for t in ("airports", "fixes", "navaids", "airways", "holds", "msa", "mora", "airspaces", "procs"):
                counts[t] = con.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
            counts["_sources"] = used
            con.executemany("INSERT INTO meta VALUES(?,?)", [("key", key), ("counts", json.dumps(counts)), ("built", str(time.time()))])
            con.commit()
            con.close()
            os.replace(tmp, self.path)
            self.counts, self.key, self._names = counts, key, None
            self.state, self.progress, self.step = "ready", 1.0, "ready"
        except Exception as e:  # noqa: BLE001 -- the trainer runs without the index
            self.state, self.error, self.step = "error", f"{type(e).__name__}: {e}", "failed"
            try:
                tmp.unlink()
            except OSError:
                pass

    # ---- builders
    def _pos_lookup(self, con):
        pos = {}
        for ident, region, lat, lon in con.execute("SELECT ident, region, lat, lon FROM navaids WHERE type IN ('VOR','NDB','DME')"):
            pos.setdefault((ident, region), (lat, lon))
        for ident, region, lat, lon in con.execute("SELECT ident, region, lat, lon FROM fixes"):
            pos.setdefault((ident, region), (lat, lon))
        return pos

    def _airways(self, con, path):
        if not Path(path).is_file():
            return
        pos = self._pos_lookup(con)
        rows = []
        for name, f1, r1, f2, r2, lvl, base, top, d in parse_awy_lines(_lines(path)):
            a, b = pos.get((f1, r1)), pos.get((f2, r2))
            if a and b:
                rows.append((name, f1, f2, a[0], a[1], b[0], b[1], lvl, base, top, d))
        con.executemany("INSERT INTO airways VALUES(?,?,?,?,?,?,?,?,?,?,?)", rows)

    def _holds(self, con, path):
        if not Path(path).is_file():
            return
        pos = self._pos_lookup(con)
        rows = [(*h, *(pos.get((h[0], h[1])) or (None, None))) for h in parse_hold_lines(_lines(path))]
        con.executemany("INSERT INTO holds VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", rows)

    def _msa(self, con, path):
        if not Path(path).is_file():
            return
        pos = self._pos_lookup(con)
        by_ident = {}
        for (i, _r), v in pos.items():
            by_ident.setdefault(i, v)
        rows = []
        for ident, airport, sectors in parse_msa_lines(_lines(path)):
            ll = by_ident.get(ident)
            rows.append((ident, airport, ll[0] if ll else None, ll[1] if ll else None, json.dumps(sectors)))
        con.executemany("INSERT INTO msa VALUES(?,?,?,?,?)", rows)

    def _airspaces(self, con, folder):
        folder = Path(folder)
        if not folder.is_dir():
            return
        rows = []
        for f in sorted(folder.glob("*.txt")) + sorted(folder.glob("*.air")):
            for a in parse_openair(f.read_text("utf-8", "replace")):
                la = [p[0] for p in a["poly"]]
                lo = [p[1] for p in a["poly"]]
                rows.append((a["name"], a["cls"], a["low"], a["high"], json.dumps(a["poly"]), min(la), max(la), min(lo), max(lo)))
        con.executemany("INSERT INTO airspaces VALUES(?,?,?,?,?,?,?,?,?)", rows)

    def _procs(self, con, folder):
        folder = Path(folder)
        if not folder.is_dir():
            return
        have = {r[0] for r in con.execute("SELECT DISTINCT icao FROM procs")}
        rows = []
        for f in folder.glob("*.dat"):
            icao = f.stem.upper()
            if icao in have:
                continue
            try:
                for kind, name, rwys, fixes in scan_cifp_names(f.read_text("utf-8", "replace")):
                    rows.append((icao, name, kind, " ".join(rwys), " ".join(fixes)))
            except OSError:
                continue
            if len(rows) > 50000:
                con.executemany("INSERT INTO procs VALUES(?,?,?,?,?)", rows)
                rows = []
        con.executemany("INSERT INTO procs VALUES(?,?,?,?,?)", rows)

    def _upsert_airport(self, con, a, src):
        old = con.execute("SELECT iata, name, city, country, lat, lon, elev, runways, freqs FROM airports WHERE icao=?", (a["icao"],)).fetchone()
        if old:
            # an earlier (better) source keeps its values; this one only fills the gaps
            iata, name, city, country, lat, lon, elev, rw, fr = old
            con.execute("UPDATE airports SET iata=?, name=?, city=?, country=?, lat=?, lon=?, elev=?, runways=?, freqs=? WHERE icao=?",
                        (iata or a.get("iata", ""), name or a.get("name", ""), city or a.get("city", ""), country or a.get("country", ""),
                         lat if lat is not None else a.get("lat"), lon if lon is not None else a.get("lon"), elev or a.get("elev") or 0,
                         rw if rw and rw != "[]" else json.dumps(a.get("runways", [])), fr if fr and fr != "[]" else json.dumps(a.get("freqs", [])), a["icao"]))
        else:
            con.execute("INSERT INTO airports VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                        (a["icao"], a.get("iata", ""), a.get("name", ""), a.get("city", ""), a.get("country", ""), a.get("lat"), a.get("lon"),
                         a.get("elev") or 0, json.dumps(a.get("runways", [])), json.dumps(a.get("freqs", [])), src))

    def _aptmeta(self, con, path, src):
        if Path(path).is_file():
            for a in parse_aptmeta_lines(_lines(path)):
                self._upsert_airport(con, a, src)

    def _aptdat(self, con, path):
        for a in parse_apt_lines(_lines(path)):
            if a.get("icao_real"):
                a["icao"] = a["icao_real"]
            if a["lat"] is None and a.get("_ll"):
                a["lat"], a["lon"] = a["_ll"]
            if a["lat"] is None or not re.fullmatch(r"[A-Z0-9]{3,7}", a["icao"]):
                continue
            self._upsert_airport(con, a, "apt.dat")

    def _sector(self, con, path, seen_fix, seen_nav):
        try:
            text = Path(path).read_text("utf-8", "replace")
        except OSError:
            return
        section, rows_f, rows_n = "", [], []
        for line in text.splitlines():
            line = line.split(";")[0].rstrip()
            if line.startswith("["):
                section = line.strip().upper()
                continue
            p = line.split()
            if section == "[FIXES]" and len(p) >= 3 and (p[0], "") not in seen_fix:
                la, lo = navdata._sct_coord(p[1]), navdata._sct_coord(p[2])
                if la is not None and lo is not None and not con.execute("SELECT 1 FROM fixes WHERE ident=? LIMIT 1", (p[0],)).fetchone():
                    rows_f.append((p[0], "", la, lo, "", spoken(p[0]), "euroscope"))
            elif section in ("[VOR]", "[NDB]") and len(p) >= 4:
                la, lo = navdata._sct_coord(p[2]), navdata._sct_coord(p[3])
                if la is not None and lo is not None and not con.execute("SELECT 1 FROM navaids WHERE ident=? LIMIT 1", (p[0],)).fetchone():
                    rows_n.append((p[0], "", section[1:4], la, lo, _f(p[1]), "", "", "euroscope"))
            elif section == "[AIRPORT]" and len(p) >= 4 and re.fullmatch(r"[A-Z]{4}", p[0]):
                la, lo = navdata._sct_coord(p[2]), navdata._sct_coord(p[3])
                if la is not None:
                    self._upsert_airport(con, {"icao": p[0], "lat": la, "lon": lo}, "euroscope")
        con.executemany("INSERT INTO fixes VALUES(?,?,?,?,?,?,?)", rows_f)
        con.executemany("INSERT INTO navaids VALUES(?,?,?,?,?,?,?,?,?)", rows_n)

    def _user(self, con, path):
        """nav_user/*.json: {"fixes": [{ident, lat, lon, name}], "airports": [{icao, iata, name, city, lat, lon}]}"""
        try:
            d = json.loads(Path(path).read_text("utf-8"))
        except (OSError, ValueError):
            return
        for f in d.get("fixes", []):
            if f.get("ident") and f.get("lat") is not None and not con.execute("SELECT 1 FROM fixes WHERE ident=? LIMIT 1", (f["ident"],)).fetchone():
                con.execute("INSERT INTO fixes VALUES(?,?,?,?,?,?,?)", (f["ident"], f.get("region", ""), f["lat"], f["lon"], "", f.get("name") or spoken(f["ident"]), "user"))
        for a in d.get("airports", []):
            if a.get("icao"):
                self._upsert_airport(con, a, "user")

    def _openflights(self, con, path):
        """OpenFlights airports.dat fills IATA codes and city names (it never overrides X-Plane / Navigraph data)."""
        try:
            text = Path(path).read_text("utf-8", "replace")
        except OSError:
            return
        for r in csv.reader(io.StringIO(text)):
            if len(r) < 8 or not re.fullmatch(r"[A-Z0-9]{4}", r[5] or ""):
                continue
            iata = r[4] if re.fullmatch(r"[A-Z0-9]{3}", r[4] or "") else ""
            self._upsert_airport(con, {"icao": r[5], "iata": iata, "name": r[1], "city": r[2], "country": r[3],
                                       "lat": _f(r[6]), "lon": _f(r[7]), "elev": int(_f(r[8]) or 0) if len(r) > 8 else 0}, "openflights")

    # ---- queries
    def _con(self):
        if self.state != "ready" or not self.path.is_file():
            return None
        con = sqlite3.connect(f"file:{self.path}?mode=ro", uri=True, check_same_thread=False)
        return con

    def _fuzzy_names(self, con):
        if self._names is None:
            names = []
            for icao, iata, name, city in con.execute("SELECT icao, iata, name, city FROM airports"):
                for tok in set(re.findall(r"[a-z0-9]{3,}", f"{name} {city}".lower())):
                    names.append((tok, icao))
            self._names = names
        return self._names

    def search(self, q, lat=None, lon=None, limit=20):
        """Airports (ICAO, IATA, name, city), fixes, navaids (ident, name), airways, procedures, frequencies.
        Exact > prefix > contains > typo-tolerant; ties ranked by distance from (lat, lon)."""
        con = self._con()
        q = (q or "").strip()
        if not con or not q:
            return []
        Q = q.upper()
        n = norm(q)
        out = {}

        def add(item, score):
            k = (item["kind"], item["id"])
            if lat is not None and item.get("lat") is not None:
                item["nm"] = round(nm_between(lat, lon, item["lat"], item["lon"]), 1)
                score -= min(30.0, item["nm"] / 100.0)       # nearer first among equals
            if k not in out or out[k]["score"] < score:
                item["score"] = score
                out[k] = item

        def apt(r, score):
            icao, iata, name, city, country, la, lo = r
            # among equal matches: an airport with airline service (IATA code) before heliports and strips
            score += (4 if iata else 0) - (15 if re.search(r"heli|seaplane|balloon", name or "", re.I) else 0)
            add({"kind": "airport", "id": icao, "ident": icao, "iata": iata, "name": name, "city": city, "country": country, "lat": la, "lon": lo,
                 "label": f"{icao}{'/' + iata if iata else ''} {name}" + (f", {city}" if city and city.lower() not in (name or '').lower() else "")}, score)

        cols = "icao, iata, name, city, country, lat, lon"
        freq = re.fullmatch(r"1[1-3]\d(?:\.\d{1,3})?", q)
        if freq:
            f = float(q)
            for kind, mhz, icao, la, lo in self._freq_rows(con, f):
                add({"kind": "freq", "id": f"{icao}:{kind}:{mhz}", "ident": f"{mhz:.3f}", "name": f"{icao} {kind}", "lat": la, "lon": lo,
                     "label": f"{mhz:.3f} {icao} {kind}", "airport": icao}, 90)
            for r in con.execute("SELECT ident, type, lat, lon, freq, name FROM navaids WHERE freq BETWEEN ? AND ? AND type IN ('VOR','ILS','LOC','DME')", (f - 0.0001, f + 0.0999)):
                add({"kind": "navaid", "id": f"{r[0]}:{r[1]}:{r[2]:.3f}", "ident": r[0], "type": r[1], "lat": r[2], "lon": r[3], "freq": r[4], "name": r[5],
                     "label": f"{r[0]} {r[1]} {r[4]:.2f} {r[5]}"}, 85)
        if 3 <= len(Q) <= 4 and Q.isalnum():
            for r in con.execute(f"SELECT {cols} FROM airports WHERE icao=?", (Q,)):
                apt(r, 100)
            for r in con.execute(f"SELECT {cols} FROM airports WHERE iata=?", (Q,)):
                apt(r, 98)
        if Q.isalnum() and len(Q) >= 2:
            for r in con.execute(f"SELECT {cols} FROM airports WHERE icao LIKE ? LIMIT 30", (Q + "%",)):
                apt(r, 70)
            for r in con.execute("SELECT ident, region, lat, lon, spoken FROM fixes WHERE ident LIKE ? LIMIT 60", (Q + "%",)):
                add({"kind": "fix", "id": f"{r[0]}:{r[1]}:{r[2]:.3f}", "ident": r[0], "region": r[1], "lat": r[2], "lon": r[3], "name": r[4],
                     "label": f"{r[0]} fix ({r[1]})"}, 95 if r[0] == Q else 60)
            for r in con.execute("SELECT ident, type, lat, lon, freq, name FROM navaids WHERE ident LIKE ? AND type IN ('VOR','NDB','DME','ILS','LOC') LIMIT 60", (Q + "%",)):
                add({"kind": "navaid", "id": f"{r[0]}:{r[1]}:{r[2]:.3f}", "ident": r[0], "type": r[1], "lat": r[2], "lon": r[3], "freq": r[4], "name": r[5],
                     "label": f"{r[0]} {r[1]} {r[4] or ''} {r[5]}".strip()}, 97 if r[0] == Q else 62)
            for r in con.execute("SELECT DISTINCT name FROM airways WHERE name LIKE ? LIMIT 10", (Q + "%",)):
                seg = con.execute("SELECT AVG(lat1), AVG(lon1), MIN(base), MAX(top), GROUP_CONCAT(DISTINCT level) FROM airways WHERE name=?", (r[0],)).fetchone()
                add({"kind": "airway", "id": r[0], "ident": r[0], "lat": seg[0], "lon": seg[1], "levels": seg[4], "label": f"Airway {r[0]} ({'high' if seg[4] == 'H' else 'low' if seg[4] == 'L' else seg[4] or ''}, FL{seg[2] or 0:03d}-FL{seg[3] or 0:03d})"},
                    96 if r[0] == Q else 64)
            for r in con.execute("SELECT p.icao, p.name, p.kind, p.runways, a.lat, a.lon FROM procs p LEFT JOIN airports a ON a.icao=p.icao WHERE p.name LIKE ? LIMIT 30", (Q + "%",)):
                add(self._proc_item(r), 94 if r[1] == Q else 66)
            # "LAKUT": every procedure that uses the fix
            if len(Q) >= 3:
                for r in con.execute("SELECT p.icao, p.name, p.kind, p.runways, a.lat, a.lon FROM procs p LEFT JOIN airports a ON a.icao=p.icao WHERE (' ' || p.fixes || ' ') LIKE ? LIMIT 30", (f"% {Q} %",)):
                    add(self._proc_item(r), 58)
        # "ILS 26" / "RNAV 08": approaches by their spoken title, near the loaded airport first
        m = re.fullmatch(r"(ILS|LOC|RNAV|RNP|VOR|NDB|GLS)\s*(\d{1,2}[LRC]?)\s*([A-Z])?", Q)
        if m:
            letter = {"ILS": "I", "LOC": "L", "RNAV": "R", "RNP": "H", "VOR": "V", "NDB": "N", "GLS": "J"}[m.group(1)]
            rw = m.group(2).zfill(2) if m.group(2)[:2].isdigit() else m.group(2)
            for r in con.execute("SELECT p.icao, p.name, p.kind, p.runways, a.lat, a.lon FROM procs p LEFT JOIN airports a ON a.icao=p.icao WHERE p.kind='APPCH' AND p.name LIKE ? LIMIT 200", (f"{letter}{rw}%",)):
                add(self._proc_item(r), 80)
        # names and cities ("tallinn", "heathrow"), navaid names, then typo tolerance
        if len(n) >= 3:
            like = f"%{q.lower()}%"
            for r in con.execute(f"SELECT {cols} FROM airports WHERE lower(name) LIKE ? OR lower(city) LIKE ? LIMIT 40", (like, like)):
                exact = norm(r[3]) == n or norm(r[2]) == n
                apt(r, 92 if exact else 78 if norm(r[3]).startswith(n) or norm(r[2]).startswith(n) else 68)
            for r in con.execute("SELECT ident, type, lat, lon, freq, name FROM navaids WHERE lower(name) LIKE ? AND type IN ('VOR','NDB','DME') LIMIT 20", (like,)):
                add({"kind": "navaid", "id": f"{r[0]}:{r[1]}:{r[2]:.3f}", "ident": r[0], "type": r[1], "lat": r[2], "lon": r[3], "freq": r[4], "name": r[5],
                     "label": f"{r[0]} {r[1]} {r[4] or ''} {r[5]}".strip()}, 74)
            if len([x for x in out.values() if x["kind"] == "airport"]) < 3 and len(n) >= 4:
                lim = 1 if len(n) <= 5 else 2
                hits = {}
                for tok, icao in self._fuzzy_names(con):
                    if abs(len(tok) - len(n)) <= lim and tok[0] == n[0] or (len(n) > 5 and abs(len(tok) - len(n)) <= lim):
                        d = edit_distance(n, tok, lim)
                        if d <= lim and d < hits.get(icao, 99):
                            hits[icao] = d
                for icao, d in sorted(hits.items(), key=lambda x: x[1])[:20]:
                    for r in con.execute(f"SELECT {cols} FROM airports WHERE icao=?", (icao,)):
                        apt(r, 56 - d * 4)
        con.close()
        # equal scores: a result with a known position before one without, then nearer, then by id --
        # the same order on every OS, whatever order SQLite handed the rows back in
        return sorted(out.values(), key=lambda x: (-x["score"], "nm" not in x, x.get("nm", 0), x["kind"], x["id"]))[:limit]

    @staticmethod
    def _proc_item(r):
        icao, name, kind, rwys, la, lo = r
        title = approach_title(name) if kind == "APPCH" else name
        k = {"SID": "SID", "STAR": "STAR", "APPCH": "approach"}[kind]
        return {"kind": "procedure", "id": f"{icao}:{kind}:{name}", "ident": name, "title": title, "proc": kind, "airport": icao,
                "runways": rwys.split() if rwys else [], "lat": la, "lon": lo, "label": f"{title} {k} {icao}" + (f" (RWY {rwys})" if rwys else "")}

    def _freq_rows(self, con, f):
        out = []
        for icao, fr, la, lo in con.execute("SELECT icao, freqs, lat, lon FROM airports WHERE freqs LIKE ?", (f"%{str(f)[:5]}%",)):
            for x in json.loads(fr or "[]"):
                if abs(x["mhz"] - f) < 0.0001 or (len(str(f)) <= 5 and 0 <= x["mhz"] - f < 0.1):
                    out.append((x["kind"], x["mhz"], icao, la, lo))
        return out[:40]

    def nearest_airports(self, lat, lon, n=10, radius_nm=150):
        con = self._con()
        if not con:
            return []
        d = radius_nm / 60.0
        rows = con.execute("SELECT icao, iata, name, city, lat, lon, runways FROM airports WHERE lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?",
                           (lat - d, lat + d, lon - d / max(0.1, math.cos(math.radians(lat))), lon + d / max(0.1, math.cos(math.radians(lat))))).fetchall()
        con.close()
        out = [{"kind": "airport", "id": r[0], "ident": r[0], "iata": r[1], "name": r[2], "city": r[3], "lat": r[4], "lon": r[5],
                "nm": round(nm_between(lat, lon, r[4], r[5]), 1), "label": f"{r[0]} {r[2]}"} for r in rows if r[4] is not None]
        return sorted(out, key=lambda x: x["nm"])[:n]

    def item(self, kind, ident, near=None):
        con = self._con()
        if not con:
            return None
        try:
            if kind == "airport":
                r = con.execute("SELECT icao, iata, name, city, country, lat, lon, elev, runways, freqs FROM airports WHERE icao=?", (ident,)).fetchone()
                if not r:
                    return None
                procs = con.execute("SELECT name, kind, runways FROM procs WHERE icao=? ORDER BY kind, name", (ident,)).fetchall()
                return {"kind": "airport", "id": r[0], "ident": r[0], "iata": r[1], "name": r[2], "city": r[3], "country": r[4], "lat": r[5], "lon": r[6],
                        "elev": r[7], "runways": json.loads(r[8] or "[]"), "freqs": json.loads(r[9] or "[]"),
                        "procedures": [{"name": p[0], "kind": p[1], "title": approach_title(p[0]) if p[1] == "APPCH" else p[0], "runways": p[2]} for p in procs]}
            if kind in ("fix", "navaid"):
                ident = ident.split(":")[0]
                rows = con.execute("SELECT ident, region, lat, lon, spoken, 'fix', NULL FROM fixes WHERE ident=?" if kind == "fix" else
                                   "SELECT ident, region, lat, lon, name, type, freq FROM navaids WHERE ident=?", (ident,)).fetchall()
                if not rows:
                    return None
                if near:
                    rows.sort(key=lambda r: nm_between(near[0], near[1], r[2], r[3]))
                r = rows[0]
                awys = con.execute("SELECT DISTINCT name, level, base, top FROM airways WHERE f1=? OR f2=?", (ident, ident)).fetchall()
                holds = con.execute("SELECT area, inbound, turn, legtime, legdist, minalt, maxalt, speed FROM holds WHERE fix=?", (ident,)).fetchall()
                procs = con.execute("SELECT p.icao, p.name, p.kind, p.runways FROM procs p WHERE (' ' || p.fixes || ' ') LIKE ? OR p.name LIKE ? LIMIT 40", (f"% {ident} %", ident[:5] + "%")).fetchall()
                return {"kind": kind, "id": ident, "ident": r[0], "region": r[1], "lat": r[2], "lon": r[3], "name": r[4], "type": r[5], "freq": r[6],
                        "spoken": spoken(r[0], r[4] or "", r[5] if kind == "navaid" else "fix"),
                        "airways": [{"name": a[0], "level": a[1], "base": a[2], "top": a[3]} for a in awys],
                        "holds": [{"area": h[0], "inbound": h[1], "turn": h[2], "legtime": h[3], "legdist": h[4], "min": h[5], "max": h[6], "speed": h[7]} for h in holds],
                        "procedures": [{"airport": p[0], "name": p[1], "kind": p[2], "title": approach_title(p[1]) if p[2] == "APPCH" else p[1], "runways": p[3]} for p in procs]}
            if kind == "airway":
                segs = con.execute("SELECT f1, f2, lat1, lon1, lat2, lon2, level, base, top, dir FROM airways WHERE name=?", (ident,)).fetchall()
                return {"kind": "airway", "id": ident, "ident": ident,
                        "segments": [{"from": s[0], "to": s[1], "a": [s[2], s[3]], "b": [s[4], s[5]], "level": s[6], "base": s[7], "top": s[8], "dir": s[9]} for s in segs]}
        finally:
            con.close()
        return None

    def area(self, lat, lon, radius_nm=60, kinds=("airways", "navaids", "holds", "msa", "airspaces", "fixes")):
        """Everything to draw on the map around (lat, lon)."""
        con = self._con()
        if not con:
            return {}
        d = radius_nm / 60.0
        dl = d / max(0.1, math.cos(math.radians(lat)))
        box = (lat - d, lat + d, lon - dl, lon + dl)
        out = {}
        try:
            if "airways" in kinds:
                out["airways"] = [{"name": r[0], "a": [r[1], r[2]], "b": [r[3], r[4]], "level": r[5], "base": r[6], "top": r[7], "f1": r[8], "f2": r[9]} for r in con.execute(
                    "SELECT name, lat1, lon1, lat2, lon2, level, base, top, f1, f2 FROM airways WHERE (lat1 BETWEEN ? AND ? AND lon1 BETWEEN ? AND ?) OR (lat2 BETWEEN ? AND ? AND lon2 BETWEEN ? AND ?) LIMIT 3000", box + box)]
            if "navaids" in kinds:
                out["navaids"] = [{"ident": r[0], "type": r[1], "lat": r[2], "lon": r[3], "freq": r[4], "name": r[5]} for r in con.execute(
                    "SELECT ident, type, lat, lon, freq, name FROM navaids WHERE type IN ('VOR','NDB','DME') AND lat BETWEEN ? AND ? AND lon BETWEEN ? AND ? LIMIT 800", box)]
            if "fixes" in kinds:
                out["fixes"] = [{"ident": r[0], "lat": r[1], "lon": r[2], "area": r[3]} for r in con.execute(
                    "SELECT ident, lat, lon, area FROM fixes WHERE lat BETWEEN ? AND ? AND lon BETWEEN ? AND ? LIMIT 3000", box)]
            if "holds" in kinds:
                out["holds"] = [{"fix": r[0], "lat": r[1], "lon": r[2], "inbound": r[3], "turn": r[4], "legtime": r[5], "legdist": r[6], "min": r[7], "max": r[8]} for r in con.execute(
                    "SELECT fix, lat, lon, inbound, turn, legtime, legdist, minalt, maxalt FROM holds WHERE lat BETWEEN ? AND ? AND lon BETWEEN ? AND ? LIMIT 300", box)]
            if "msa" in kinds:
                out["msa"] = [{"ident": r[0], "airport": r[1], "lat": r[2], "lon": r[3], "sectors": json.loads(r[4])} for r in con.execute(
                    "SELECT ident, airport, lat, lon, sectors FROM msa WHERE lat BETWEEN ? AND ? AND lon BETWEEN ? AND ? LIMIT 50", box)]
            if "airspaces" in kinds:
                out["airspaces"] = [{"name": r[0], "cls": r[1], "low": r[2], "high": r[3], "poly": json.loads(r[4])} for r in con.execute(
                    "SELECT name, cls, low, high, poly FROM airspaces WHERE maxlat >= ? AND minlat <= ? AND maxlon >= ? AND minlon <= ? LIMIT 400", (box[0], box[1], box[2], box[3]))]
        finally:
            con.close()
        return out

    def vocab(self, lat, lon, radius_nm=120, icao=""):
        """Spoken names of the fixes / navaids / procedures near the airport, for speech recognition and the parser."""
        con = self._con()
        if not con:
            return []
        d = radius_nm / 60.0
        dl = d / max(0.1, math.cos(math.radians(lat)))
        out = []
        try:
            for ident, sp, la, lo in con.execute("SELECT ident, spoken, lat, lon FROM fixes WHERE lat BETWEEN ? AND ? AND lon BETWEEN ? AND ? AND length(ident)=5 LIMIT 4000",
                                                 (lat - d, lat + d, lon - dl, lon + dl)):
                out.append({"ident": ident, "kind": "fix", "spoken": sp if sp and not sp.isupper() else spoken(ident), "lat": la, "lon": lo})
            for ident, t, name, la, lo in con.execute("SELECT ident, type, name, lat, lon FROM navaids WHERE type IN ('VOR','NDB','DME') AND lat BETWEEN ? AND ? AND lon BETWEEN ? AND ? LIMIT 400",
                                                      (lat - d, lat + d, lon - dl, lon + dl)):
                out.append({"ident": ident, "kind": t, "spoken": spoken(ident, name, t), "lat": la, "lon": lo})
            if icao:
                for name, kind in con.execute("SELECT name, kind FROM procs WHERE icao=?", (icao,)):
                    out.append({"ident": name, "kind": kind, "spoken": approach_title(name) if kind == "APPCH" else name})
        finally:
            con.close()
        return out

    def exists(self, ident, near=None):
        """[(kind, lat, lon)] for a fix / navaid ident, nearest to `near` first."""
        con = self._con()
        if not con:
            return []
        rows = [("fix", r[0], r[1]) for r in con.execute("SELECT lat, lon FROM fixes WHERE ident=?", (ident,))]
        rows += [(r[0], r[1], r[2]) for r in con.execute("SELECT type, lat, lon FROM navaids WHERE ident=? AND type IN ('VOR','NDB','DME')", (ident,))]
        rows += [("airport", r[0], r[1]) for r in con.execute("SELECT lat, lon FROM airports WHERE icao=?", (ident,))]
        con.close()
        if near:
            rows.sort(key=lambda r: nm_between(near[0], near[1], r[1], r[2]))
        return rows

    def validate_route(self, route, dep=None, dest=None):
        """A route string ("LAKUT1A LAKUT UL602 SUGOL DCT ROXOG") -> points + problems.
        Airways are expanded between their entry and exit fix; unknown idents and airways that do not join are flagged."""
        toks = [t for t in re.split(r"\s+", (route or "").strip().upper()) if t]
        con = self._con()
        pts, problems, out_toks = [], [], []
        if not con:
            return {"ok": False, "points": [], "tokens": [], "problems": ["nav database not ready"]}
        dep_ll = None
        if dep:
            r = con.execute("SELECT lat, lon FROM airports WHERE icao=?", (dep,)).fetchone()
            dep_ll = r if r else None
        last = dep_ll
        try:
            i = 0
            while i < len(toks):
                t = re.sub(r"/.*$", "", toks[i])          # LAKUT/N0450F350 speed/level groups
                if t in ("DCT", "SID", "STAR", "IFR", "VFR") or re.fullmatch(r"[NMK]\d{3,4}[FAS]\d{3,4}", t):
                    out_toks.append({"t": toks[i], "kind": "keyword"})
                    i += 1
                    continue
                if (dep and t == dep) or (dest and t == dest):
                    out_toks.append({"t": t, "kind": "airport"})
                    i += 1
                    continue
                proc = con.execute("SELECT icao, kind, fixes FROM procs WHERE name=? AND (icao=? OR icao=?)", (t, dep or "", dest or "")).fetchone()
                if proc:
                    out_toks.append({"t": t, "kind": proc[1], "airport": proc[0]})
                    i += 1
                    continue
                awy = con.execute("SELECT 1 FROM airways WHERE name=? LIMIT 1", (t,)).fetchone()
                if awy and pts:
                    entry = pts[-1]["id"]
                    exit_ = re.sub(r"/.*$", "", toks[i + 1]) if i + 1 < len(toks) else None
                    seq = self._airway_path(con, t, entry, exit_)
                    if seq is None:
                        problems.append(f"{t}: {entry} → {exit_ or '?'} is not on the airway")
                        out_toks.append({"t": t, "kind": "airway", "ok": False})
                    else:
                        out_toks.append({"t": t, "kind": "airway", "ok": True})
                        for f, la, lo in seq[1:-1]:
                            pts.append({"id": f, "lat": la, "lon": lo, "via": t})
                    i += 1
                    continue
                cands = self.exists(t, last)
                if cands:
                    k, la, lo = cands[0]
                    last = (la, lo)
                    pts.append({"id": t, "lat": la, "lon": lo, "kind": k})
                    out_toks.append({"t": t, "kind": k})
                else:
                    m = re.fullmatch(r"(\d{2})(\d{2})?([NS])(\d{3})(\d{2})?([EW])", t)
                    if m:
                        la = int(m.group(1)) + int(m.group(2) or 0) / 60
                        lo = int(m.group(4)) + int(m.group(5) or 0) / 60
                        la, lo = (-la if m.group(3) == "S" else la), (-lo if m.group(6) == "W" else lo)
                        pts.append({"id": t, "lat": la, "lon": lo, "kind": "coord"})
                        out_toks.append({"t": t, "kind": "coord"})
                    else:
                        problems.append(f"{t}: unknown fix / airway")
                        out_toks.append({"t": t, "kind": "unknown"})
                i += 1
        finally:
            con.close()
        return {"ok": not problems, "points": pts, "tokens": out_toks, "problems": problems}

    @staticmethod
    def _airway_path(con, name, entry, exit_):
        segs = con.execute("SELECT f1, f2, lat1, lon1, lat2, lon2 FROM airways WHERE name=?", (name,)).fetchall()
        adj = {}
        for f1, f2, la1, lo1, la2, lo2 in segs:
            adj.setdefault(f1, []).append((f2, la2, lo2))
            adj.setdefault(f2, []).append((f1, la1, lo1))
        if entry not in adj or (exit_ and exit_ not in adj):
            return None
        prev = {entry: None}
        pos = {entry: None}
        queue = [entry]
        while queue:
            cur = queue.pop(0)
            if cur == exit_:
                break
            for nx, la, lo in adj.get(cur, []):
                if nx not in prev:
                    prev[nx] = cur
                    pos[nx] = (la, lo)
                    queue.append(nx)
        if exit_ not in prev:
            return None
        seq, cur = [], exit_
        while cur is not None:
            p = pos.get(cur)
            seq.append((cur, p[0] if p else None, p[1] if p else None))
            cur = prev[cur]
        return list(reversed(seq))


DB = None


def get(cache_dir, settings=None):
    """The shared database (created and started on first use; settings changes restart the detection)."""
    global DB
    if DB is None:
        DB = NavDB(cache_dir, settings)
        DB.start()
    elif settings is not None and settings != DB.settings:
        DB.settings = settings
        DB.start()
    return DB
