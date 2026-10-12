"""XRadio bridge test against XRadio v0.5.7's own server/server.py and tools/fake_client.py.

    set XRADIO_DIR=C:\\path\\to\\xradio-0.5.7   (the folder with server/ and tools/)
    python tests/xradio_test.py

Skips (exit 0) with a message if the XRadio files can't be found.
"""
import os
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))


def find_xradio():
    cands = [os.environ.get("XRADIO_DIR", "")]
    for base in (ROOT, ROOT.parent, Path.home(), Path.home() / "Desktop", Path.home() / "Downloads"):
        cands += [str(p) for p in base.glob("xradio*") if p.is_dir()]
    for c in cands:
        if c and (Path(c) / "server" / "server.py").is_file() and (Path(c) / "tools" / "fake_client.py").is_file():
            return Path(c)
        if c:  # zip extracted one level deeper
            for sub in Path(c).glob("xradio*"):
                if (sub / "server" / "server.py").is_file() and (sub / "tools" / "fake_client.py").is_file():
                    return sub
    return None


XR_DIR = find_xradio()
if not XR_DIR:
    print("SKIP  XRadio v0.5.7 not found -- set XRADIO_DIR to the folder containing server/ and tools/")
    sys.exit(0)

import xradio_bridge  # noqa: E402

fails = 0


def check(cond, msg):
    global fails
    print(("PASS  " if cond else "FAIL  ") + msg)
    if not cond:
        fails += 1


def free_udp_port():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def start_server(port, password=""):
    args = [sys.executable, "-u", "server.py", "--host", "127.0.0.1", "--port", str(port)]
    if password:
        args += ["--password", password]
    p = subprocess.Popen(args, cwd=XR_DIR / "server", stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    time.sleep(0.8)
    return p


LAT, LON, ELEV = 59.4133, 24.8325, 40.0
KHZ = 135905
procs = []
try:
    port = free_udp_port()
    procs.append(start_server(port))
    br = xradio_bridge.XRadioBridge({"enabled": True, "host": "127.0.0.1", "port": port, "atc_cs": "EETN_TWR",
                                     "freq_khz": KHZ, "ai_traffic": True, "real_pilots": True, "text": True})
    br.start()
    ai = {"cs": "FIN321", "type": "A320", "lat": LAT + 0.01, "lon": LON + 0.02, "alt_m": 400.0, "hdg": 263.0,
          "gs_ms": 70.0, "on_ground": False, "squawk": "4521", "xpdr": "C", "khz": KHZ}
    state = {"center": {"lat": LAT, "lon": LON, "elev_m": ELEV}, "positions": [{"cs": "EETN_TWR", "khz": KHZ}],
             "aircraft": [ai], "tx": []}

    def sync(extra_tx=()):
        s = dict(state)
        s["tx"] = list(extra_tx)
        return br.sync(s)

    st = None
    for _ in range(30):
        st = sync()
        if st["atc"] and st["atc"][0]["state"] == "connected" and st["ai_sessions"] == 1:
            break
        time.sleep(0.2)
    check(st["atc"] and st["atc"][0]["state"] == "connected", "ATC station EETN_TWR logged in")
    check(st["ai_sessions"] == 1, "AI aircraft FIN321 logged in as its own session")

    # a real pilot: XRadio's own fake client, tuned to the tower frequency, talking every 5 s
    fake_out = []
    fc = subprocess.Popen([sys.executable, "-u", str(XR_DIR / "tools" / "fake_client.py"), "--port", str(port),
                           "--callsign", "ESXYZ", "--lat", str(LAT + 0.02), "--lon", str(LON - 0.03), "--alt-ft", "1500",
                           "--com1", str(KHZ), "--talk", "--parrot", "--squawk", "7000"],
                          stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    procs.append(fc)
    threading.Thread(target=lambda: [fake_out.append(l.rstrip()) for l in fc.stdout], daemon=True).start()

    humans, texts = [], []
    sent = False
    t_end = time.time() + 12
    while time.time() < t_end:
        tx = []
        if not sent and any("logged in as ESXYZ" in l for l in fake_out):
            time.sleep(0.5)
            tx = [{"kind": "atc", "khz": KHZ, "text": "ESXYZ, Tallinn Tower, wind 070 degrees 9 knots"},
                  {"kind": "pilot", "cs": "FIN321", "khz": KHZ, "text": "Tallinn Tower, Finnair 321, established ILS runway 26"}]
            sent = True
        st = sync(tx)
        humans += st["humans"]
        texts += st["texts"]
        if (sent and any("FIN321@" in l for l in fake_out) and any(h["cs"] == "ESXYZ" for h in humans)
                and any(t["from"] == "ESXYZ" for t in texts)
                and any("EETN_TWR: ESXYZ, Tallinn Tower" in l for l in fake_out)
                and any("FIN321: Tallinn Tower, Finnair 321" in l for l in fake_out)):
            break
        time.sleep(0.25)

    check(any(l.startswith("logged in as ESXYZ") for l in fake_out), "fake client logged in")
    check(any("FIN321@" in l for l in fake_out), "fake client sees the injected AI traffic FIN321")
    hh = [h for h in humans if h["cs"] == "ESXYZ"]
    check(bool(hh), "fake client appears in TowerTrainer as a human aircraft")
    if hh:
        check(abs(hh[-1]["lat"] - (LAT + 0.02)) < 0.01 and hh[-1]["squawk"] == "7000", "human position and squawk")
    check(st["pilots"] >= 1 and any(r["cs"] == "ESXYZ" for r in st["roster"]), "roster counts real pilots only: %d" % st["pilots"])
    check(any(t["from"] == "ESXYZ" and "position report" in t["text"] and t["khz"] == KHZ for t in texts), "text from the real pilot reaches TowerTrainer")
    check(any("EETN_TWR: ESXYZ, Tallinn Tower" in l for l in fake_out), "controller text reaches the real pilot")
    check(any("FIN321: Tallinn Tower, Finnair 321" in l for l in fake_out), "AI pilot text reaches the real pilot")
    check(not any(h["cs"] in ("FIN321", "EETN_TWR") for h in humans), "own sessions are not shown as humans")

    # voice: our push-to-talk frames reach the pilot, whose --parrot echo comes back to us
    br.configure({"voice": True})
    import base64
    frames = [base64.b64encode(bytes([0xF8, 0xFF, 0xFE]) + bytes(40)).decode() for _ in range(5)]
    ok_sent = br.send_voice(KHZ, frames)
    got = []
    for _ in range(20):
        sync(); got += br.take_voice()
        if got:
            break
        time.sleep(0.15)
    check(ok_sent, "push-to-talk frames sent from the ATC station")
    check(any(g["from"] == "ESXYZ" and g["khz"] == KHZ for g in got), "voice frames from the real pilot reach TowerTrainer (%d)" % len(got))
    check(any("voice:" in l for l in fake_out), "real pilot received our voice frames")

    # AI aircraft leaves -> logout
    state["aircraft"] = []
    sync(); time.sleep(0.6); sync()
    check(br.status()["ai_sessions"] == 0, "AI session logged out when the aircraft left")
    br.stop()

    # wrong password -> clear refusal
    port2 = free_udp_port()
    procs.append(start_server(port2, password="cumulus"))
    br2 = xradio_bridge.XRadioBridge({"enabled": True, "host": "127.0.0.1", "port": port2, "atc_cs": "EETN_TWR",
                                      "password": "wrong", "freq_khz": KHZ})
    br2.start()
    for _ in range(20):
        st2 = br2.sync({"center": {"lat": LAT, "lon": LON}, "positions": [{"cs": "EETN_TWR", "khz": KHZ}], "aircraft": [], "tx": []})
        if br2.error:
            break
        time.sleep(0.2)
    check("password" in br2.error, "wrong password refused with a clear message: " + br2.error)
    br2.stop()
finally:
    for p in procs:
        p.terminate()
        try:
            p.wait(timeout=3)
        except subprocess.TimeoutExpired:
            p.kill()

print(f"\n{fails} FAILED" if fails else "\nALL PASSED")
sys.exit(1 if fails else 0)
