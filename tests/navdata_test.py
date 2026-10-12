"""Procedure parsing on synthetic fixtures (tests/fixtures -- not real Navigraph/X-Plane data).

    python tests/navdata_test.py
"""
import datetime as dt
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import navdata as N  # noqa: E402

FX = ROOT / "tests" / "fixtures"
XP = str(FX / "xplane")
fails = 0


def check(c, m):
    global fails
    print(("PASS  " if c else "FAIL  ") + m)
    if not c:
        fails += 1


# AIRAC calendar
check(N.airac_for(dt.date(2020, 1, 2)) == "2001", "AIRAC 2001 starts 2020-01-02")
check(N.airac_for(dt.date(2025, 1, 23)) == "2501", "AIRAC 2501 = 2025-01-23: " + N.airac_for(dt.date(2025, 1, 23)))
check(N.airac_for(dt.date(2025, 1, 22)) == "2413", "2025-01-22 is still 2413: " + N.airac_for(dt.date(2025, 1, 22)))
check(N.airac_for(dt.date(2025, 10, 30)) == "2511", "AIRAC 2511 = 2025-10-30: " + N.airac_for(dt.date(2025, 10, 30)))

# data source discovery
info = N.navdata_info(XP)
check(info["source"] == "navigraph" and info["airac"] == "2511", "Custom Data detected as Navigraph AIRAC 2511: " + info["label"])
check(info["outdated"], "2511 flagged as outdated against today's cycle " + info["current"])
check(N.navdata_info(XP, mode="default")["source"] == "xplane", "mode=default uses X-Plane default data")
check(N.navdata_info("Z:/nope", mode="navigraph")["source"] in ("none", "navigraph", "xplane"), "missing X-Plane path handled")

# CIFP
procs = N.parse_cifp((FX / "xplane" / "Custom Data" / "CIFP" / "TEST.dat").read_text())
names = [p["name"] for p in procs["sids"]]
check(names == ["ALPHA1A", "BRAVO1B", "CHARL1A"], f"SIDs parsed: {names}")
a = next(p for p in procs["sids"] if p["name"] == "ALPHA1A")
check(a["runways"] == ["26"] and [l["fix"] for l in a["rwy"]["26"]] == ["TSTA1"] and a["common"][0]["fix"] == "ALPHA", "ALPHA1A runway + common legs")
check(a["common"][0]["alt"] == 4000 and a["common"][0]["desc"] == "+", "altitude constraint +4000")
check([p["name"] for p in procs["stars"]] == ["DELTA1T"] and procs["stars"][0]["common"][0]["alt"] == 10000, "STAR with FL100 constraint")
check(len(procs["apps"]) == 1, "approach parsed")
check(N.runway_matches("RW08B", "08L") and N.runway_matches("RW26", "26") and not N.runway_matches("RW26", "08"), "runway matching incl. B (both parallels)")

with tempfile.TemporaryDirectory() as tmp:
    full = N.load_procedures("TEST", 59.0, 24.0, tmp, xplane=XP)
    check(full["source"]["kind"] == "navigraph" and full["source"]["airac"] == "2511", "load_procedures prefers Custom Data")
    a = next(p for p in full["sids"] if p["name"] == "ALPHA1A")
    check(a["exit"] == "ALPHA" and abs(a["common"][0]["lat"] - 59.5) < 1e-9, "fix positions from earth_fix.dat")
    check(a["climb"] == 4000 and 40 < a["bearing"] < 60, f"initial climb 4000 and exit bearing NE ({a['bearing']:.0f})")
    st = full["stars"][0]
    check(abs(st["common"][0]["lat"] - 59.8) < 1e-9, "navaid position from earth_nav.dat")
    check((Path(tmp) / "TEST.procs.json").is_file(), "parsed procedures cached as TEST.procs.json")
    again = N.load_procedures("TEST", 59.0, 24.0, tmp, xplane=XP)
    check(again["sids"][0]["name"] == "ALPHA1A", "cache hit")
    dflt = N.load_procedures("TEST", 59.0, 24.0, tmp, xplane=XP, mode="default", use_cache=False)
    check([p["name"] for p in dflt["sids"]] == ["OLDSID1A"], "X-Plane default data when asked")
    ese = N.load_procedures("TEST", 59.0, 24.0, tmp, xplane="Z:/none", mode="navigraph", sector=str(FX / "sector"), use_cache=False)
    if ese["source"]["kind"] == "euroscope":
        names = [p["name"] for p in ese["sids"]]
        check(names == ["ECHO1A", "ECHO1B"], f"ESE SIDs: {names}")
        e1 = ese["sids"][0]
        check(e1["runways"] == ["26"] and e1["exit"] == "ECHO" and abs(e1["common"][1]["lat"] - 60.0) < 1e-9, "ESE route + SCT fix coordinates")
        check(ese["stars"][0]["common"][0]["lat"] and abs(ese["stars"][0]["common"][0]["lon"] - 25.9) < 1e-6, "SCT VOR coordinates")
    else:
        print("SKIP  ESE test: a real X-Plane install with CIFP data was found first")
    none = N.load_procedures("NONE", 59.0, 24.0, tmp, xplane="Z:/none", mode="navigraph", use_cache=False)
    check(none["source"]["kind"] in ("fallback", "navigraph", "xplane") and (none["sids"] == [] or none["source"]["kind"] != "fallback"), "fallback when nothing found")

check(N._sct_coord("N059.30.00.000") == 59.5 and N._sct_coord("W001.15.00.000") == -1.25, "SCT coordinate parsing")
print(f"\n{fails} FAILED" if fails else "\nALL PASSED")
sys.exit(1 if fails else 0)
