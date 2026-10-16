"""Nav data detection, cache invalidation and the indexed nav database (search, routes) on synthetic fixtures.

    python tests/navdb_test.py
"""
import json
import os
import shutil
import sys
import tempfile
import time
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import navdata as N  # noqa: E402
import navdb as D  # noqa: E402

FX = ROOT / "tests" / "fixtures"
XP = str(FX / "xplane")
fails = 0


def check(c, m):
    global fails
    print(("PASS  " if c else "FAIL  ") + m)
    if not c:
        fails += 1


def make_install(root, name, airac=None, binary=True, resources=True, navigraph=True):
    p = Path(root) / name
    (p / "Custom Scenery").mkdir(parents=True)
    if resources:
        (p / "Resources" / "default data" / "CIFP").mkdir(parents=True)
    if binary:
        (p / "X-Plane.exe").write_text("")
    if navigraph and airac:
        (p / "Custom Data" / "CIFP").mkdir(parents=True)
        (p / "Custom Data" / "cycle_info.txt").write_text(f"AIRAC cycle    : {airac}\n")
    return str(p)


# ---------------------------------------------------------------- F1 install detection
orig = N.xplane_candidates
with tempfile.TemporaryDirectory() as tmp:
    leftover = make_install(tmp, "leftover", binary=False, resources=False)       # C:\X-Plane 12 with Custom Scenery only
    real = make_install(tmp, "real", airac="2509")
    newer = make_install(tmp, "newer", airac="2511")
    plain = make_install(tmp, "plain", navigraph=False)
    N.xplane_candidates = lambda hint="": ([hint] if hint else []) + [leftover, real]
    check(N.find_xplane() == real, "the real install wins over a leftover folder with only Custom Scenery")
    check(N.find_xplane(leftover) == real, "a hint pointing at the leftover folder is not used")
    info = N.install_info(leftover)
    check(not info["valid"] and "Resources" in info["why"], f"leftover folder explained: {info['why']}")
    N.xplane_candidates = lambda hint="": [plain, real, newer]
    check(N.find_xplane() == newer, "two Navigraph installs: the newest AIRAC (2511) is picked")
    check([i["path"] for i in N.find_installs()] == [newer, real, plain], "ranking: Navigraph + newest cycle first, plain X-Plane last")
    check(N.find_xplane(plain) == plain, "an explicit (valid) choice in Settings is respected")
    allf = N.find_installs(include_invalid=True)
    check(any(not i["valid"] for i in allf) is False, "invalid folders only listed when they are candidates")
    N.xplane_candidates = lambda hint="": [leftover]
    check(N.find_xplane() is None, "nothing valid -> None (fallback, no crash)")
    check(N.navdata_info()["source"] == "none" and any(not i["valid"] for i in N.navdata_info()["installs"]), "navdata_info lists the invalid folder with the reason")
N.xplane_candidates = orig

# cycle readers
with tempfile.TemporaryDirectory() as tmp:
    (Path(tmp) / "cycle.json").write_text(json.dumps({"cycle": "2512", "revision": "1"}))
    check(N.read_cycle(tmp) == "2512", "cycle.json (Navigraph) read")
with tempfile.TemporaryDirectory() as tmp:
    (Path(tmp) / "earth_nav.dat").write_text("I\n1150 Version - data cycle 2508, build 20250801\n")
    check(N.read_cycle(tmp) == "2508", "AIRAC from the earth_nav.dat header")

# ---------------------------------------------------------------- F1 procedure cache
with tempfile.TemporaryDirectory() as tmp:
    xp = Path(tmp) / "xp"
    shutil.copytree(XP, xp)
    cache = Path(tmp) / "cache"
    p1 = N.load_procedures("TEST", 59.0, 24.0, cache, xplane=str(xp))
    check(p1["source"]["kind"] == "navigraph", "procedures loaded from the copied install")
    k1 = json.loads(json.loads((cache / "TEST.procs.json").read_text())["_key"])
    check(any(os.path.normcase(str((xp / "Custom Data").resolve())) == part[1] and part[2] == "2511" for part in k1[1:]), "cache key holds the resolved folder and the AIRAC cycle")
    # a Navigraph update: new cycle and a changed CIFP file
    (xp / "Custom Data" / "cycle_info.txt").write_text("AIRAC cycle    : 2512\n")
    f = xp / "Custom Data" / "CIFP" / "TEST.dat"
    f.write_text(f.read_text().replace("ALPHA1A", "ALPHA2A"))
    os.utime(f, (time.time() + 5, time.time() + 5))
    p2 = N.load_procedures("TEST", 59.0, 24.0, cache, xplane=str(xp))
    check(p2["source"]["airac"] == "2512" and "ALPHA2A" in [s["name"] for s in p2["sids"]], "a new cycle / changed file invalidates the cache")
    # fallback is never cached
    nf = N.load_procedures("ZZZZ", 59.0, 24.0, cache, xplane=str(xp))
    check(nf["source"]["kind"] == "fallback" and not (cache / "ZZZZ.procs.json").exists(), "fallback result is not written to the cache")
    (cache / "ZZZZ.procs.json").write_text(json.dumps({"sids": [], "stars": [], "apps": [], "source": {"kind": "fallback"}, "_key": N.procedures_key("ZZZZ", str(xp))}))
    (xp / "Custom Data" / "CIFP" / "ZZZZ.dat").write_text((xp / "Custom Data" / "CIFP" / "TEST.dat").read_text())
    again = N.load_procedures("ZZZZ", 59.0, 24.0, cache, xplane=str(xp))
    check(again["source"]["kind"] == "navigraph", "an old cached fallback (183-byte file) is ignored once real data exists")

# ---------------------------------------------------------------- F2 the database
with tempfile.TemporaryDirectory() as tmp:
    db = D.NavDB(tmp, {"xplane": XP}, user_dir=Path(tmp) / "nav_user")
    t0 = time.time()
    db.start()
    check(db.state in ("building", "ready"), "start() returns at once with a background build")
    db.wait()
    check(db.state == "ready", f"index built: {db.state} {db.error}")
    c = db.counts
    check(c["airports"] >= 5 and c["fixes"] >= 8 and c["navaids"] >= 3 and c["airways"] == 4 and c["holds"] == 1 and c["msa"] == 1 and c["airspaces"] == 1,
          f"counts: { {k: v for k, v in c.items() if not k.startswith('_')} }")
    check(c["procs"] >= 7, f"procedure names indexed from CIFP: {c['procs']}")
    db2 = D.NavDB(tmp, {"xplane": XP}, user_dir=Path(tmp) / "nav_user")
    t1 = time.time()
    db2.start()
    check(db2.state == "ready" and time.time() - t1 < 2, f"second start loads the cached index in {time.time() - t1:.2f} s")

    near = (59.4133, 24.8325)

    def first(q, kind=None):
        r = db2.search(q, *near)
        r = [x for x in r if not kind or x["kind"] == kind]
        return r[0] if r else None

    r = first("tallinn")
    check(r and r["kind"] == "airport" and r["id"] == "EETN", f"'tallinn' -> EETN ({r and r['label']})")
    res = db2.search("TLL", *near)
    kinds = {(x["kind"], x["ident"]) for x in res[:3]}
    check(("airport", "EETN") in kinds and ("navaid", "TLL") in kinds, f"'TLL' -> EETN and TLL VOR: {kinds}")
    r = first("Heathorw")
    check(r and r["id"] == "EGLL", f"typo 'Heathorw' -> EGLL ({r and r['id']})")
    r = first("heathrow")
    check(r and r["id"] == "EGLL", "'heathrow' -> EGLL")
    res = db2.search("EGL", *near)
    check({"EGLL", "EGLC"} <= {x["id"] for x in res}, "'EGL' prefix -> EGLL, EGLC")
    res = db2.search("LAKUT", *near)
    check(res and res[0]["kind"] == "fix" and res[0]["ident"] == "LAKUT", "'LAKUT' -> the fix first")
    procs = {x["ident"] for x in res if x["kind"] == "procedure"}
    check({"LAKUT1A", "LAKUT1T"} <= procs, f"'LAKUT' -> its procedures {sorted(procs)}")
    r = first("UL602")
    check(r and r["kind"] == "airway", "'UL602' -> the airway")
    r = first("ILS 26", "procedure")
    check(r and r["airport"] == "EETN" and r["title"] == "ILS 26", f"'ILS 26' -> the EETN approach ({r and r['label']})")
    r = first("118.1")
    check(r and r["kind"] == "freq" and r["airport"] == "EETN", f"'118.1' -> Tallinn Tower ({r and r['label']})")
    r = first("riga")
    check(r and r["id"] == "EVRA", "'riga' -> EVRA (city)")
    nearest = db2.nearest_airports(*near, n=3, radius_nm=400)
    check(nearest and nearest[0]["id"] == "EETN" and nearest[1]["id"] == "EVRA", f"nearest airports: {[x['id'] for x in nearest]}")
    it = db2.item("airport", "EETN")
    check(it and it["iata"] == "TLL" and any(f["mhz"] == 118.1 for f in it["freqs"]) and it["runways"][0]["ends"] == ["08", "26"], "airport details: IATA, frequencies, runways")
    it = db2.item("fix", "LAKUT", near)
    check(it and it["spoken"] == "Lakut" and any(a["name"] == "UL602" for a in it["airways"]), "fix details: spoken name, airways")
    it = db2.item("navaid", "TLL", near)
    check(it and it["spoken"] == "Tallinn VOR" and it["holds"] and it["holds"][0]["inbound"] == 260.0, f"navaid: 'Tallinn VOR' with its hold ({it and it['spoken']})")
    it = db2.item("airway", "UL602")
    check(it and len(it["segments"]) == 2 and it["segments"][0]["base"] == 95, "airway segments with levels")
    area = db2.area(*near, radius_nm=60)
    check(area["airspaces"] and area["airspaces"][0]["name"] == "TALLINN CTR" and area["msa"] and area["holds"], "map area: CTR, MSA, holdings")
    v = {x["ident"]: x["spoken"] for x in db2.vocab(*near, icao="EETN")}
    check(v.get("LAKUT") == "Lakut" and v.get("TLL") == "Tallinn VOR" and v.get("I26") == "ILS 26", "vocabulary for speech: fixes, navaids, approaches")

    # F4 route strings
    rt = db2.validate_route("LAKUT1A LAKUT UL602 SUGOL DCT ROXOG", "EETN", "EVRA")
    check(rt["ok"] and [p["id"] for p in rt["points"]] == ["LAKUT", "TLL", "SUGOL", "ROXOG"], f"route parsed and airway expanded: {[p['id'] for p in rt['points']]}")
    bad = db2.validate_route("LAKUT UL602 ROXOG XXXXX", "EETN")
    check(not bad["ok"] and any("ROXOG" in p for p in bad["problems"]) and any("XXXXX" in p for p in bad["problems"]), f"route problems flagged: {bad['problems']}")

    # cache invalidates when sources change
    xp2 = Path(tmp) / "xp2"
    shutil.copytree(XP, xp2)
    db3 = D.NavDB(Path(tmp) / "c3", {"xplane": str(xp2)})
    db3.start().wait()
    k = db3.key
    (xp2 / "Custom Data" / "cycle_info.txt").write_text("AIRAC cycle    : 2601\n")
    db4 = D.NavDB(Path(tmp) / "c3", {"xplane": str(xp2)})
    db4.start()
    check(db4.state == "building", "a new AIRAC rebuilds the index")
    db4.wait()
    check(db4.key != k and db4.state == "ready", "rebuilt with a new key")

check(D.edit_distance("heathorw", "heathrow") == 1 and D.edit_distance("tallin", "tallinn") == 1, "edit distance with transpositions")
check(D.approach_title("R08-Y") == "RNAV 08 Y" and D.approach_title("I26") == "ILS 26", "approach titles")
print(f"\n{fails} FAILED" if fails else "\nALL PASSED")
sys.exit(1 if fails else 0)
