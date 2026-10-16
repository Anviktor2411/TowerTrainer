"""VFR reporting points: sector file -> user file -> OpenAIP (own key) -> generic.   python tests/vfrpoints_test.py"""
import json
import sys
import tempfile
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import vfrpoints as V  # noqa: E402

fails = 0


def check(c, m):
    global fails
    print(("PASS  " if c else "FAIL  ") + m)
    if not c:
        fails += 1


LAT, LON = 59.4133, 24.8325
SECTOR = str(ROOT / "tests" / "fixtures" / "sector_vfr")
check(V.point_name("VFR_BRAVO", "EETN") == "Bravo" and V.point_name("EETN_K", "EETN") == "Kilo" and V.point_name("VFR_HARKU", "EETN") == "Harku", "names: VFR_BRAVO -> Bravo, EETN_K -> Kilo")
with tempfile.TemporaryDirectory() as tmp:
    base, cache = Path(tmp), Path(tmp) / "cache"
    r = V.load("EETN", LAT, LON, base, cache, sector=SECTOR)
    names = sorted(p["name"] for p in r["points"])
    check(r["source"] == "sector" and names == ["Bravo", "Harku", "Kilo"], f"sector file: {names} (LAKUT is not VFR, VFR_FAR is outside the zone)")
    check(next(p for p in r["points"] if p["name"] == "Harku")["alt"] == 1500, "altitude from the FREETEXT label")
    # user file when there is no sector package
    check(V.load("EETN", LAT, LON, base, cache)["source"] == "generic", "nothing configured -> generic placeholders")
    V.save_user(base, "EETN", [{"name": "Bravo", "lat": 59.5, "lon": 24.83, "alt": 1500, "type": "compulsory"}, {"name": "Tango", "lat": 59.3, "lon": 24.9, "alt": 1000, "type": "on request"}])
    r = V.load("EETN", LAT, LON, base, cache)
    check(r["source"] == "user" and [p["name"] for p in r["points"]] == ["Bravo", "Tango"] and r["points"][1]["type"] == "on-request", "user file vfr_points/EETN.json")
    check(V.load("EETN", LAT, LON, base, cache, sector=SECTOR)["source"] == "sector", "a sector package wins over the user file")
    # OpenAIP only with a key, cached locally
    fake = lambda url, key: {"items": [{"name": "EETN-VFR-D", "geometry": {"coordinates": [24.7, 59.35]}, "compulsory": False}]}
    (base / "vfr_points" / "EETN.json").unlink()
    check(V.load("EETN", LAT, LON, base, cache, fetch=fake)["source"] == "generic", "no OpenAIP key -> OpenAIP is never asked")
    r = V.load("EETN", LAT, LON, base, cache, openaip_key="k", fetch=fake)
    check(r["source"] == "openaip" and r["points"][0]["name"] == "Delta" and "openAIP" in r["attribution"], f"OpenAIP with the user's key: {r['points']}")
    check((cache / "vfr" / "EETN.openaip.json").is_file(), "OpenAIP result cached in cache/vfr/ (git-ignored)")
    boom = lambda url, key: (_ for _ in ()).throw(OSError("offline"))
    check(V.load("EETN", LAT, LON, base, cache, openaip_key="k", fetch=boom)["source"] == "openaip", "cached OpenAIP points work offline")
print(f"\n{fails} FAILED" if fails else "\nALL PASSED")
sys.exit(1 if fails else 0)
