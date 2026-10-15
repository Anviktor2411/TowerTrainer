"""EuroScope sector/profile generation (G6): generated .sct/.ese/.asr/.prf for cached airports parse back,
coordinates sit around the airport, the positions carry the trainer's frequencies, the profile points at the
files and has "Connect to VATSIM" off.
    python tests/sector_test.py      (uses cache/EETN.json and cache/EGSS.json when present; skips otherwise)
"""
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import sector  # noqa: E402

fails = 0


def check(cond, msg):
    global fails
    print(("PASS  " if cond else "FAIL  ") + msg)
    if not cond:
        fails += 1


# coordinate formatting round-trips
for lat, lon in ((59.413333, 24.8325), (51.885, 0.235), (-33.9461, 151.1772), (40.6413, -73.7781)):
    s = sector.fmt_coord(lat, lon)
    back = sector.parse_coord(s)
    check(back and abs(back[0] - lat) < 1e-5 and abs(back[1] - lon) < 1e-5, f"coordinate {lat},{lon} -> {s} -> back")

cache = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "cache")
for icao in ("EETN", "EGSS"):
    if not os.path.exists(os.path.join(cache, f"{icao}.json")):
        print(f"SKIP  {icao}: not cached (load it in the trainer once)")
        continue
    apt, procs, osm = sector.load_cached(cache, icao)
    with tempfile.TemporaryDirectory() as d:
        es_dir = r"C:\Users\someone\Documents\EuroScope\TowerTrainer"
        paths = sector.write_package(apt, d, procs, osm, callsign=f"{icao}_TWR", es_dir=es_dir)
        check(all(os.path.getsize(p) > 100 for p in paths.values()), f"{icao}: four files written")
        sct = sector.parse_sct(open(paths["sct"], encoding="utf-8").read())
        secs = sct["sections"]
        for name in ("INFO", "AIRPORT", "RUNWAY", "GEO", "REGIONS", "LABELS", "FIXES", "SID", "STAR"):
            check(name in secs, f"{icao}: [{name}] section present")
        check(len(secs["RUNWAY"]) == len(apt["runways"]), f"{icao}: one [RUNWAY] line per runway ({len(secs['RUNWAY'])})")
        check(len(sct["coords"]) > 500, f"{icao}: {len(sct['coords'])} coordinate pairs")
        lats = [c[0] for c in sct["coords"]]
        lons = [c[1] for c in sct["coords"]]
        check(max(lats) - min(lats) < 0.2 and max(lons) - min(lons) < 0.3 and min(lats) <= apt["lat"] <= max(lats) and min(lons) <= apt["lon"] <= max(lons),
              f"{icao}: all geometry within a few km of the airport")
        check(len(secs["GEO"]) > 100 and len(secs["REGIONS"]) > 10, f"{icao}: taxiways in [GEO], pavement in [REGIONS]")
        check(any(l.startswith('"') for l in secs["LABELS"]), f"{icao}: taxiway/stand labels")
        check(secs["AIRPORT"][0].startswith(icao), f"{icao}: [AIRPORT] line: {secs['AIRPORT'][0]}")
        check(all(k in sct["defines"] for k in ("TWY", "RWY", "APRON")), f"{icao}: colour #defines")
        ese = sector.parse_ese(open(paths["ese"], encoding="utf-8").read())
        pos = {p["cs"]: p["mhz"] for p in ese["positions"]}
        tp = sector.positions(apt)
        check(all(pos.get(tp[k]["cs"]) == tp[k]["mhz"] for k in sector.POSITION_KEYS), f"{icao}: [POSITIONS] carry the trainer's frequencies: {pos}")
        check(len(set(pos.values())) == 5, f"{icao}: five distinct frequencies")
        prf = sector.parse_prf(open(paths["prf"], encoding="utf-8").read())
        check(prf.get(("LastSession", "server")) == "127.0.0.1" and prf.get(("LastSession", "tovatsim")) == "0", f"{icao}: profile connects to 127.0.0.1 with Connect-to-VATSIM off")
        check(prf.get(("Settings", "m_SectorFile")) == es_dir + f"\\TowerTrainer_{icao}.sct" and prf.get(("LastSession", "callsign")) == f"{icao}_TWR", f"{icao}: profile points at the sector file, callsign {icao}_TWR")
        asr = open(paths["asr"], encoding="utf-8").read()
        check(asr.startswith("SECTORFILE:") and "WINDOWAREA:" in asr and f"Airports:{icao}" in asr, f"{icao}: ASR references the sector file and the airport")
        check("\r\n" in open(paths["sct"], "rb").read().decode("utf-8")[:2000], f"{icao}: Windows line endings (EuroScope reads CRLF)")

# a tiny synthetic airport: no cache needed, exercised on CI
apt = {"icao": "ZZZZ", "name": "Test Field", "lat": 10.0, "lon": 20.0, "freqs": [{"kind": "tower", "mhz": 118.5, "name": "Test Tower"}],
       "runways": [{"width": 45, "ends": [{"name": "09", "pos": [-1000, 0], "displaced": 0}, {"name": "27", "pos": [1000, 0], "displaced": 0}]}],
       "lines": [[[-500, 100], [500, 100]]], "holdLines": [[[-400, 80], [-400, 120]]], "pavement": [[[[-600, 50], [600, 50], [600, 150], [-600, 150]]]],
       "nodes": [[-500, 100], [500, 100]], "edges": [{"a": 0, "b": 1, "name": "A", "runway": False}], "stands": [{"name": "1", "pos": [0, 140], "hdg": 180}]}
procs = {"sids": [{"name": "TEST1A", "runways": ["09"], "rwy": {"09": [{"fix": "AAAAA", "lat": 10.1, "lon": 20.2}]}, "common": [{"fix": "BBBBB", "lat": 10.3, "lon": 20.4}]}], "stars": []}
sct = sector.parse_sct(sector.build_sct(apt, procs))
check(sct["sections"]["FIXES"] == ["AAAAA " + sector.fmt_coord(10.1, 20.2), "BBBBB " + sector.fmt_coord(10.3, 20.4)], "synthetic: procedure fixes listed")
check(len(sct["sections"]["SID"]) == 1 and sct["sections"]["SID"][0].startswith("ZZZZ TEST1A"), "synthetic: SID line")
ese = sector.parse_ese(sector.build_ese(apt, procs))
check(ese["positions"][2]["mhz"] == 118.5 and ese["positions"][2]["cs"] == "ZZZZ_TWR" and ese["positions"][0]["mhz"] != 118.5, "synthetic: tower frequency from the data, others distinct fallbacks")
check(any(l.startswith("SID:ZZZZ:09:TEST1A:AAAAA BBBBB") for l in ese["sidsstars"]), "synthetic: [SIDSSTARS] route")

print(f"\n{fails} FAILED" if fails else "\nALL PASSED")
sys.exit(1 if fails else 0)
