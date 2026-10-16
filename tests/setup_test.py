"""Setup wizard (G6) on a temporary folder: package detection, sector package unpacking with path checks,
generated EuroScope files, X-Plane / Navigraph / XRadio detection, plugin install with backup, the DLL check
that refuses an XRadio build X-Plane cannot load, what X-Plane's Log.txt says about XRadio, xradio.cfg editing,
dry runs that change nothing, and the wizard's HTTP API through server.py's own handler.
    python tests/setup_test.py
"""
import http.server
import io
import json
import os
import struct
import sys
import tempfile
import threading
import time
import urllib.request
import zipfile
from pathlib import Path

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import setup as wiz  # noqa: E402

fails = 0


def check(cond, msg):
    global fails
    print(("PASS  " if cond else "FAIL  ") + msg)
    if not cond:
        fails += 1


def snapshot(d):
    return sorted(str(p.relative_to(d)) for p in Path(d).rglob("*"))


def pe(dlls):
    """A minimal 64-bit Windows DLL whose import table names these DLLs -- all the wizard reads of an XRadio.xpl."""
    rva, off = 0x1000, 0x200                       # one section, at this address and this file offset
    size = (len(dlls) + 1) * 20                    # the import descriptors and the all-zero one that ends them
    thunks = rva + size                            # one empty address table, shared
    names, at = b"", []
    for d in dlls:
        at.append(thunks + 8 + len(names))
        names += d.encode() + b"\0"
    body = b"".join(struct.pack("<IIIII", 0, 0, 0, a, thunks) for a in at) + bytes(20 + 8) + names
    raw = (len(body) + 0x1FF) & ~0x1FF
    opt = bytearray(112 + 16 * 8)                  # PE32+ optional header with 16 data directories
    struct.pack_into("<H", opt, 0, 0x20B)
    struct.pack_into("<I", opt, 108, 16)
    struct.pack_into("<II", opt, 112 + 8, rva, size)    # directory 1: imports
    head = bytearray(b"MZ".ljust(0x3C, b"\0") + struct.pack("<I", 0x40))
    head += b"PE\0\0" + struct.pack("<HHIIIHH", 0x8664, 1, 0, 0, 0, len(opt), 0x2022) + opt
    head += struct.pack("<8sIIIIIIHHI", b".idata", len(body), rva, raw, off, 0, 0, 0, 0, 0xC0000040)
    return bytes(head.ljust(off, b"\0")) + body.ljust(raw, b"\0")


# what XRadio.xpl imports when it is built right: Windows and X-Plane, nothing else
GOOD_XPL = pe(["KERNEL32.dll", "USER32.dll", "OPENGL32.dll", "WS2_32.dll", "api-ms-win-crt-runtime-l1-1-0.dll", "XPLM_64.dll"])


print("python and packages")
pi = wiz.python_info()
check(pi["ok"] and pi["version"].count(".") == 2, f"python {pi['version']} reported as ok")
pk = wiz.packages()
check(len(pk) == len(wiz.OPTIONAL) and all("size" in p and "what" in p for p in pk), "optional packages listed with purpose and size")
r = wiz.pip_install("edge-tts", dry_run=True)
check(r["ok"] and r["dry_run"] and "pip install" in r["command"] and sys.executable in r["command"], "pip dry run shows the command with this interpreter")
check(not wiz.pip_install("requests", dry_run=True)["ok"], "a package outside the optional list is refused")

with tempfile.TemporaryDirectory() as tmp:
    tmp = Path(tmp)
    docs = tmp / "Documents" / "EuroScope"
    print("sector packages")
    zp = tmp / "pkg.zip"
    with zipfile.ZipFile(zp, "w") as z:
        z.writestr("MyVACC/Data/sector.sct", "[INFO]\nTest\n")
        z.writestr("MyVACC/MyVACC.prf", "Settings\tm_SectorFile\tx\n")
    r = wiz.unpack_sector_package(str(zp), str(docs), dry_run=True)
    check(r["ok"] and r["dry_run"] and r["files"] == 2 and not docs.exists(), "unpack dry run reports the files and creates nothing")
    r = wiz.unpack_sector_package(str(zp), str(docs))
    check(r["ok"] and (docs / "pkg" / "MyVACC" / "Data" / "sector.sct").exists() and r["sct"] and r["prf"], "unpacked into Documents/EuroScope/pkg with .sct/.prf found")
    r2 = wiz.unpack_sector_package(str(zp), str(docs))
    check(not r2["ok"] and r2.get("exists"), "a second unpack refuses to overwrite unless allowed")
    check(wiz.unpack_sector_package(str(zp), str(docs), overwrite=True)["ok"], "overwrite allowed -> ok")
    bad = tmp / "bad.zip"
    with zipfile.ZipFile(bad, "w") as z:
        z.writestr("../evil.txt", "x")
    check(not wiz.unpack_sector_package(str(bad), str(docs))["ok"], "a zip with ../ paths is refused")
    check(not wiz.unpack_sector_package(str(tmp / "nothere.zip"), str(docs))["ok"], "missing zip -> error")
    es = wiz.euroscope_status(docs)
    check(es["docs_exists"] and any(p["name"] == "pkg" for p in es["packages"]), "EuroScope status lists the unpacked package")

    print("generated sector files")
    cache = Path(ROOT) / "cache"
    if (cache / "EETN.json").exists():
        r = wiz.generate_sector("EETN", str(docs), cache, "EETN_TWR", dry_run=True)
        check(r["ok"] and r["dry_run"] and not (docs / "TowerTrainer").exists(), "generate dry run writes nothing")
        r = wiz.generate_sector("EETN", str(docs), cache, "EETN_TWR")
        check(r["ok"] and all(Path(r[k]).exists() for k in ("sct", "ese", "asr", "prf")), "EETN files generated into Documents/EuroScope/TowerTrainer")
        check(not wiz.generate_sector("EETN", str(docs), cache)["ok"], "generating again without overwrite is refused")
        check(wiz.generate_sector("EETN", str(docs), cache, overwrite=True)["ok"], "overwrite allowed")
    else:
        print("SKIP  EETN not cached")
    check(not wiz.generate_sector("XXXX", str(docs), cache)["ok"], "an airport that is not cached is refused")
    r = wiz.desktop_shortcut(r"C:\Program Files (x86)\EuroScope\EuroScope.exe", "TowerTrainer EuroScope", "x.prf", dry_run=True)
    check(r["ok"] and r["dry_run"] and r["link"].endswith("TowerTrainer EuroScope.lnk"), "shortcut dry run names the .lnk")

    print("X-Plane, Navigraph, XRadio")
    xp = tmp / "X-Plane 12"
    (xp / "Resources" / "plugins").mkdir(parents=True)
    (xp / "Custom Data").mkdir()
    (xp / "Custom Data" / "cycle_info.txt").write_text("AIRAC cycle    : 2410\nVersion        : 1\nValid (from/to): 03/OCT/2024 - 30/OCT/2024\n", "utf-8")
    (xp / "Custom Data" / "earth_fix.dat").write_text("", "utf-8")
    info = wiz.xplane_folder_info(str(xp))
    check(info["valid"] and info["navigraph"]["cycle"] == "2410" and info["navigraph"]["valid_to"] == "30/OCT/2024" and info["navigraph"]["outdated"] is True, "AIRAC cycle read from cycle_info.txt and flagged outdated")
    check(not info["xradio"]["installed"], "XRadio not installed yet")
    xs = wiz.xplane_status(str(xp))
    check(any(i["path"] == str(xp) and i["source"] == "typed" for i in xs["installs"]), "a typed X-Plane folder is listed")
    # a fake release zip with an XRadio/ folder like the real ones
    rel = tmp / "XRadio-all.zip"
    with zipfile.ZipFile(rel, "w") as z:
        z.writestr("XRadio/win_x64/XRadio.xpl", GOOD_XPL)
        z.writestr("XRadio/README.md", "readme")
    r = wiz.install_xradio(str(xp), str(rel), "v0.6.0", dry_run=True)
    check(r["ok"] and r["dry_run"] and not (xp / "Resources" / "plugins" / "XRadio").exists(), "install dry run changes nothing")
    r = wiz.install_xradio(str(xp), str(rel), "v0.6.0")
    tgt = xp / "Resources" / "plugins" / "XRadio"
    check(r["ok"] and (tgt / "win_x64" / "XRadio.xpl").read_bytes() == GOOD_XPL and (tgt / "TowerTrainer-installed.txt").read_text().strip() == "v0.6.0", "plugin installed with a version marker")
    (tgt / "win_x64" / "XRadio.xpl").write_text("old")
    r = wiz.install_xradio(str(xp), str(rel), "v0.6.1")
    backups = [p for p in (xp / "Resources" / "plugins").iterdir() if p.name.startswith("XRadio.backup-")]
    check(r["ok"] and r["backup"] and len(backups) == 1 and (backups[0] / "win_x64" / "XRadio.xpl").read_text() == "old" and (tgt / "win_x64" / "XRadio.xpl").read_bytes() == GOOD_XPL, "update keeps a backup of the old plugin")
    info = wiz.xplane_folder_info(str(xp))
    check(info["xradio"]["installed"] and info["xradio"]["version"] == "v0.6.1" and "XRadio.xpl" in info["xradio"]["xpl"], "status shows the installed version")
    check(not wiz.install_xradio(str(tmp / "nowhere"), str(rel))["ok"], "a folder without Resources/plugins is refused")
    nox = tmp / "nox.zip"
    with zipfile.ZipFile(nox, "w") as z:
        z.writestr("readme.txt", "x")
    check(not wiz.install_xradio(str(xp), str(nox))["ok"], "a zip without the plugin is refused")

    print("XRadio builds X-Plane cannot load are refused (the DLL check XRadio's own build runs)")

    def release(name, files):
        zp = tmp / name
        with zipfile.ZipFile(zp, "w") as z:
            for n, data in files.items():
                z.writestr(n, data)
        return str(zp)

    def plugins_now():
        return sorted(p.name for p in (xp / "Resources" / "plugins").iterdir())

    before, listed = (tgt / "win_x64" / "XRadio.xpl").read_bytes(), plugins_now()
    mingw_dlls = ["libstdc++-6.dll", "libgcc_s_seh-1.dll", "libwinpthread-1.dll", "libssp-0.dll"]
    r = wiz.install_xradio(str(xp), release("XRadio-mingw.zip", {"XRadio/win_x64/XRadio.xpl": pe(["KERNEL32.dll"] + mingw_dlls + ["XPLM_64.dll"])}), "v0.6.2")
    check(not r["ok"] and r.get("refused") and r["mingw"] == mingw_dlls and r["missing"] == [], "a build linked against the MinGW runtime is refused, naming its four DLLs")
    check("MinGW runtime" in r["error"] and "libstdc++-6.dll" in r["error"] and "Error Code = 126" in r["error"] and "left as it was" in r["error"], "the refusal says why in words: MinGW runtime, Error Code = 126, current XRadio untouched")
    check((tgt / "win_x64" / "XRadio.xpl").read_bytes() == before and plugins_now() == listed and wiz.xplane_folder_info(str(xp))["xradio"]["version"] == "v0.6.1", "the installed plugin is left as it was, and no backup is made")
    r = wiz.install_xradio(str(xp), release("XRadio-mingw-dlls.zip", {"XRadio/win_x64/XRadio.xpl": pe(["KERNEL32.dll", "libstdc++-6.dll"]), "XRadio/win_x64/libstdc++-6.dll": "x"}))
    check(not r["ok"] and r["mingw"] == ["libstdc++-6.dll"], "the MinGW runtime is refused even when it is shipped next to the plugin")
    r = wiz.install_xradio(str(xp), release("XRadio-curl.zip", {"XRadio/win_x64/XRadio.xpl": pe(["KERNEL32.dll", "libcurl.dll", "XPLM_64.dll"])}))
    check(not r["ok"] and r["missing"] == ["libcurl.dll"] and "libcurl.dll" in r["error"], "a DLL that neither Windows nor X-Plane provides is refused")
    r = wiz.install_xradio(str(xp), release("XRadio-curl-shipped.zip", {"XRadio/win_x64/XRadio.xpl": pe(["KERNEL32.dll", "libcurl.dll", "XPLM_64.dll"]), "XRadio/win_x64/libcurl.dll": "x"}), "v0.6.3")
    check(r["ok"], "... unless it is shipped next to the plugin, where X-Plane finds it")
    msvc = pe(["KERNEL32.dll", "IMM32.dll", "MSVCP140.dll", "VCRUNTIME140.dll", "VCRUNTIME140_1.dll", "api-ms-win-crt-heap-l1-1-0.dll", "XPLM_64.dll"])
    r = wiz.install_xradio(str(xp), release("XRadio-msvc.zip", {"XRadio/win_x64/XRadio.xpl": msvc}), "v0.6.4")
    check(r["ok"] and (tgt / "win_x64" / "XRadio.xpl").read_bytes() == msvc, "an MSVC build like the GitHub release is installed: the Visual C++ runtime is allowed")
    nbak = sum(1 for p in (xp / "Resources" / "plugins").iterdir() if p.name.startswith("XRadio.backup-"))
    r1, r2 = wiz.install_xradio(str(xp), str(rel), "v0.6.5"), wiz.install_xradio(str(xp), str(rel), "v0.6.6")
    baks = [p for p in (xp / "Resources" / "plugins").iterdir() if p.name.startswith("XRadio.backup-")]
    check(r1["ok"] and r2["ok"] and r1["backup"] != r2["backup"] and len(baks) == nbak + 2 and not any((b / "XRadio").exists() for b in baks), "two updates within a second keep two separate backups, none nested in another")
    r = wiz.install_xradio(str(xp), release("XRadio-debug.zip", {"XRadio/win_x64/XRadio.xpl": pe(["KERNEL32.dll", "MSVCP140D.dll", "VCRUNTIME140D.dll", "ucrtbased.dll"])}))
    check(not r["ok"] and r["missing"] == ["MSVCP140D.dll", "VCRUNTIME140D.dll", "ucrtbased.dll"], "a Debug MSVC build is refused: its runtime is on no pilot's PC")
    check(not wiz.install_xradio(str(xp), release("XRadio-junk.zip", {"XRadio/win_x64/XRadio.xpl": "not a DLL"}))["ok"], "an XRadio.xpl that is not a Windows binary is refused")
    check(wiz.xplane_folder_info(str(xp))["xradio"]["check"]["ok"], "the X-Plane status runs the same check on the installed plugin")

    print("what X-Plane's Log.txt says about XRadio")
    check(wiz.xradio_log(xp)["state"] == "none", "no Log.txt: X-Plane has not run yet")

    def xplane_ran(at, *lines):
        stamp = time.strftime("%a %b %d %H:%M:%S %Y", time.localtime(at))
        (xp / "Log.txt").write_text(f"Log.txt for X-Plane 12.4.4-b4 (build 124414 Intel 64-bit, Vulkan)\nCompiled on Oct  6 2026 15:01:15\n"
                                    f"X-Plane Started on {stamp}\n\n" + "\n".join(lines) + "\n", "utf-8")

    plugin = r"D:\SteamLibrary/steamapps/common/X-Plane 12/Resources/plugins/XRadio/win_x64/XRadio.xpl"
    xplane_ran(time.time() - 3600, f"{plugin} : Error Code = 126 : The specified module could not be found.")
    check(wiz.xradio_log(xp)["state"] == "stale", "a run from before XRadio was installed is not held against the new install")
    xplane_ran(time.time() + 60, f"{plugin} : Error Code = 126 : The specified module could not be found.")
    g = wiz.xradio_log(xp)
    check(g["state"] == "failed" and g["reason"] == "Error Code = 126 : The specified module could not be found.", "Error Code = 126 after the install: failed, in X-Plane's own words")
    xplane_ran(time.time() + 60, f"Loaded: {plugin} (xradio.anviktor).")
    check(wiz.xradio_log(xp)["state"] == "loaded", "a Loaded: line for XRadio.xpl: loaded")
    xplane_ran(time.time() + 60, r"Loaded: D:\X-Plane 12/Resources/plugins/xPilot/win_x64/xPilot.xpl (org.vatsim.xpilot).",
               r"0:00:01.000 XRadio/XPMP2 ERROR  D:\X-Plane 12\Resources\plugins\XRadio\Resources\related.txt not found",
               r"D:\X-Plane 12/Resources/plugins/XRadio.backup-20261015-191129/win_x64/XRadio.xpl : Error Code = 126 : x")
    check(wiz.xradio_log(xp)["state"] == "absent", "errors about XRadio's resources or a backup folder are not the plugin failing; with no line about it: absent")
    info = wiz.xplane_folder_info(str(xp))
    check(info["xradio"]["log"]["state"] == "absent", "the X-Plane status carries the Log.txt verdict")
    cfg = xp / "Output" / "preferences" / "xradio.cfg"
    r = wiz.xradio_settings(str(xp), {"host": "192.168.1.5", "port": "49100", "bogus": "x"}, dry_run=True)
    check(r["ok"] and r["dry_run"] and not cfg.exists() and "bogus" not in r["set"], "settings dry run: nothing written, unknown keys dropped")
    r = wiz.xradio_settings(str(xp), {"host": "192.168.1.5", "port": "49100", "callsign": "ESXYZ"})
    txt = cfg.read_text("utf-8")
    check(r["ok"] and "host = 192.168.1.5" in txt and "callsign = ESXYZ" in txt, "xradio.cfg created with the keys")
    cfg.write_text("# XRadio configuration\nhost = old\nvolume = 0.5\n", "utf-8")
    wiz.xradio_settings(str(xp), {"host": "new", "password": "pw"})
    r = wiz.xradio_settings(str(xp), {"simbriefuser": "tester"})
    check(r["ok"] and "simbriefuser = tester" in (xp / "Output" / "preferences" / "xradio.cfg").read_text("utf-8"), "the SimBrief username goes into xradio.cfg (S5)")
    txt = cfg.read_text("utf-8")
    check("host = new" in txt and "volume = 0.5" in txt and "password = pw" in txt and txt.count("host =") == 1, "existing keys replaced in place, others kept")

    print("the wizard's HTTP API (server.py handler)")
    import server as tt_server
    tt_server.CACHE = cache

    class Srv(http.server.ThreadingHTTPServer):
        daemon_threads = True

    srv = Srv(("127.0.0.1", 0), tt_server.Handler)
    port = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()

    def get(path):
        with urllib.request.urlopen(f"http://127.0.0.1:{port}{path}", timeout=10) as r:
            return json.loads(r.read())

    def post(path, body):
        req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=json.dumps(body).encode(), headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read())

    s = get(f"/api/setup/status?xplane={urllib.request.quote(str(xp))}&docs={urllib.request.quote(str(docs))}")
    check(s["python"]["ok"] and isinstance(s["packages"], list) and s["euroscope"]["docs"] == str(docs) and any(i["path"] == str(xp) for i in s["xplane"]["installs"]), "GET /api/setup/status: python, packages, EuroScope folder, X-Plane install")
    xi = next(i["xradio"] for i in s["xplane"]["installs"] if i["path"] == str(xp))
    check(xi["check"]["ok"] and xi["log"]["state"] == "absent", "GET /api/setup/status: XRadio's DLL check and its Log.txt verdict")
    with urllib.request.urlopen(f"http://127.0.0.1:{port}/setup", timeout=10) as r:
        html = r.read().decode("utf-8")
    check("TOWER TRAINER" in html and "js/setup.js" in html, "GET /setup serves the wizard page")
    before = snapshot(tmp)
    r = post("/api/setup/unpack", {"zip": str(zp), "docs": str(docs), "name": "dryrun", "dry_run": True})
    r2 = post("/api/setup/xradio_install", {"xplane": str(xp), "source": str(rel), "dry_run": True})
    r3 = post("/api/setup/xradio_settings", {"xplane": str(xp), "values": {"host": "zzz"}, "dry_run": True})
    check(r["ok"] and r["dry_run"] and r2["ok"] and r2["dry_run"] and r3["ok"] and r3["dry_run"] and snapshot(tmp) == before, "dry-run actions over HTTP change nothing on disk")
    import base64
    up = post("/api/setup/upload", {"name": "../../evil.zip", "data": base64.b64encode(zp.read_bytes()).decode()})
    check(up["ok"] and ".." not in Path(up["path"]).name and Path(up["path"]).parent == cache / "setup-upload", "uploaded package lands in cache/setup-upload with a safe name")
    try:
        Path(up["path"]).unlink()
    except OSError:
        pass
    t = post("/api/setup/tests", {})
    check("voices" in t and "euroscope" in t and "xradio" in t, "POST /api/setup/tests reports voices, EuroScope and XRadio")
    lg = get("/api/setup/log")
    check(isinstance(lg["log"], list), "GET /api/setup/log returns the log tail")
    srv.shutdown()

print(f"\n{fails} FAILED" if fails else "\nALL PASSED")
sys.exit(1 if fails else 0)
