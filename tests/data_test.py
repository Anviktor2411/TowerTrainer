"""OpenFlights traffic mix and OpenStreetMap building parsing on small synthetic inputs (no network).

    python tests/data_test.py
"""
import json
import sys
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import openflights as OF  # noqa: E402
import osm as OSM         # noqa: E402

fails = 0


def check(c, m):
    global fails
    print(("PASS  " if c else "FAIL  ") + m)
    if not c:
        fails += 1


AIRLINES = '''1,"airBaltic",\\N,"BT","BTI","AIRBALTIC","Latvia","Y"
2,"Finnair",\\N,"AY","FIN","FINNAIR","Finland","Y"
3,"Ryanair",\\N,"FR","RYR","RYANAIR","Ireland","Y"
4,"DHL Air",\\N,"D0","DHK","WORLD EXPRESS","United Kingdom","Y"
5,"Nowhere",\\N,"","\\N","","Mars","N"
'''
AIRPORTS = '''10,"Lennart Meri Tallinn Airport","Tallinn","Estonia","TLL","EETN",59.4133,24.8328,131,2,"E","Europe/Tallinn","airport","OurAirports"
11,"Helsinki Vantaa Airport","Helsinki","Finland","HEL","EFHK",60.3172,24.9633,179,2,"E","Europe/Helsinki","airport","OurAirports"
12,"Riga International Airport","Riga","Latvia","RIX","EVRA",56.9236,23.9711,36,2,"E","Europe/Riga","airport","OurAirports"
13,"London Stansted Airport","London","United Kingdom","STN","EGSS",51.885,0.235,348,0,"E","Europe/London","airport","OurAirports"
14,"Leipzig Halle Airport","Leipzig","Germany","LEJ","EDDP",51.4324,12.2416,465,1,"E","Europe/Berlin","airport","OurAirports"
'''
ROUTES = '''BT,1,TLL,10,RIX,12,,0,CS3
BT,1,TLL,10,HEL,11,,0,CS3
AY,2,TLL,10,HEL,11,,0,320
AY,2,TLL,10,HEL,11,,0,E90
FR,3,TLL,10,STN,13,,0,738
D0,4,TLL,10,LEJ,14,,0,752
AY,2,HEL,11,TLL,10,,0,320
'''

with tempfile.TemporaryDirectory() as tmp:
    d = Path(tmp) / "openflights"
    d.mkdir()
    (d / "airlines.dat").write_text(AIRLINES, "utf-8")
    (d / "airports.dat").write_text(AIRPORTS, "utf-8")
    (d / "routes.dat").write_text(ROUTES, "utf-8")
    # make the files look fresh and big enough to be used instead of downloaded
    for f in d.glob("*.dat"):
        f.write_text(f.read_text("utf-8") + "#" * 1200, "utf-8")
    t = OF.build("EETN", tmp)
    check(t["iata"] == "TLL" and not t.get("error"), "airport resolved by ICAO -> IATA")
    al = {a["icao"]: a for a in t["airlines"]}
    check(list(al) == ["FIN", "BTI", "RYR", "DHK"] or set(al) == {"FIN", "BTI", "RYR", "DHK"}, f"airlines serving EETN: {list(al)}")
    check(al["FIN"]["routes"] == 2 and al["BTI"]["routes"] == 2 and al["RYR"]["routes"] == 1, "route counts per airline (only departures from EETN)")
    check(al["BTI"]["callsign"] == "Airbaltic" and al["BTI"]["nat"] == "LV" and al["FIN"]["nat"] == "FI" and al["RYR"]["nat"] == "IE", "telephony and crew nationality from the country")
    ds = {x["icao"]: x for x in t["dests"]}
    check(ds["EFHK"]["routes"] == 3 and ds["EVRA"]["routes"] == 1 and abs(ds["EFHK"]["lat"] - 60.3172) < 1e-6, f"destinations with coordinates: {sorted(ds)}")
    check(["FIN", "EFHK", 2] in t["pairs"] and ["RYR", "EGSS", 1] in t["pairs"], "airline/destination pairs")
    check(t["cargo"] == ["DHK"], f"cargo airlines detected: {t['cargo']}")
    out = OF.load("EETN", tmp)
    check((Path(tmp) / "EETN.traffic.json").is_file() and out["iata"] == "TLL", "result cached as EETN.traffic.json")
    nope = OF.build("ZZZZ", tmp)
    check(nope["airlines"] == [] and "not in OpenFlights" in nope["error"], "unknown airport -> empty mix with a reason")

# ---- OSM ----
raw = {"elements": [
    {"type": "way", "id": 1, "tags": {"aeroway": "terminal", "name": "Terminal 1"}, "geometry": [{"lat": 59.4140, "lon": 24.8300}, {"lat": 59.4140, "lon": 24.8320}, {"lat": 59.4150, "lon": 24.8320}, {"lat": 59.4150, "lon": 24.8300}, {"lat": 59.4140, "lon": 24.8300}]},
    {"type": "way", "id": 2, "tags": {"building": "hangar"}, "geometry": [{"lat": 59.4100, "lon": 24.8400}, {"lat": 59.4100, "lon": 24.8410}, {"lat": 59.4110, "lon": 24.8410}]},
    {"type": "node", "id": 3, "lat": 59.4135, "lon": 24.8330, "tags": {"aeroway": "control_tower"}},
    {"type": "way", "id": 4, "tags": {"aeroway": "gate", "ref": "12"}, "geometry": [{"lat": 59.414, "lon": 24.83}, {"lat": 59.414, "lon": 24.831}, {"lat": 59.4141, "lon": 24.831}]},
    {"type": "way", "id": 5, "tags": {"building": "yes"}, "geometry": [{"lat": 59.4200, "lon": 24.8500}, {"lat": 59.4200, "lon": 24.8510}, {"lat": 59.4210, "lon": 24.8510}]},
]}
loc = OSM.to_local(raw, 59.4133, 24.8328)
kinds = [b["kind"] for b in loc["buildings"]]
check(kinds == ["terminal", "hangar", "building"], f"kinds classified and ordered: {kinds}")
check(loc["tower"] is not None and abs(loc["tower"][0] - 11.3) < 1 and abs(loc["tower"][1] - 22.1) < 1, f"tower position in local metres: {loc['tower']}")
t1 = loc["buildings"][0]
check(t1["name"] == "Terminal 1" and len(t1["pts"]) == 4 and all(len(p) == 2 for p in t1["pts"]), "terminal polygon closed ring trimmed to 4 points")
check(loc["credit"].startswith("© OpenStreetMap"), "ODbL credit carried with the data")
q = OSM.query(59.4133, 24.8328, 2500)
check("aeroway" in q and "building" in q and "control_tower" in q and "out body geom" in q, "Overpass query asks for terminals, hangars, buildings and the tower")
print(f"\n{fails} FAILED" if fails else "\nALL PASSED")
sys.exit(1 if fails else 0)
