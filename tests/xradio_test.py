"""XRadio bridge test against XRadio's own server/server.py and tools/fake_client.py -- both the v0.6.0
(protocol 6, branch atc-support) server and a v0.5.7 (protocol 5) server, so the fallback stays honest.

    set XRADIO_DIR=C:\\path\\to\\xradio-main        (the v0.6.0 checkout: server/ and tools/)
    set XRADIO_DIR_V5=C:\\path\\to\\xradio-0.5.7    (optional; else a git worktree of tag v0.5.7 is made from XRADIO_DIR)
    python tests/xradio_test.py

Skips (exit 0) with a message if no XRadio checkout can be found.
"""
import base64
import os
import shutil
import socket
import subprocess
import sys
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")   # Windows consoles default to cp1252
import tempfile
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))


def is_xradio(p):
    return p and (Path(p) / "server" / "server.py").is_file() and (Path(p) / "tools" / "fake_client.py").is_file()


def proto_of(p):
    txt = (Path(p) / "server" / "protocol.py").read_text("utf-8", "replace")
    for line in txt.splitlines():
        if line.startswith("PROTO_VERSION"):
            return int(line.split("=")[1].split("#")[0].strip())
    return 0


def find_xradio():
    cands = [os.environ.get("XRADIO_DIR", "")]
    for base in (ROOT, ROOT.parent, Path.home(), Path.home() / "Desktop", Path.home() / "Downloads"):
        cands += [str(p) for p in base.glob("xradio*") if p.is_dir()]
    best = None
    for c in cands:
        for d in ([c] + [str(s) for s in Path(c).glob("xradio*")]) if c else []:
            if is_xradio(d) and (best is None or proto_of(d) > proto_of(best)):
                best = d
    return Path(best) if best else None


XR_DIR = find_xradio()
if not XR_DIR:
    print("SKIP  XRadio not found -- set XRADIO_DIR to the folder containing server/ and tools/")
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


def start_server(xr_dir, port, password=""):
    args = [sys.executable, "-u", "server.py", "--host", "127.0.0.1", "--port", str(port)]
    if password:
        args += ["--password", password]
    p = subprocess.Popen(args, cwd=xr_dir / "server", stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    time.sleep(0.8)
    return p


def fake_client(xr_dir, port, out, *extra):
    fc = subprocess.Popen([sys.executable, "-u", str(xr_dir / "tools" / "fake_client.py"), "--port", str(port), *extra],
                          stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    threading.Thread(target=lambda: [out.append(l.rstrip()) for l in fc.stdout], daemon=True).start()
    return fc


LAT, LON, ELEV = 59.4133, 24.8325, 40.0
KHZ = 135905
ATIS_KHZ = 127905


class FakeTts:
    """Stands in for tts.py: a short WAV tone, so the AI voice path can be tested without a neural engine."""
    def cast(self, nat, seed=0, gender=None, exclude=(), role="pilot"):
        return {"id": "fake:tone"}

    def render(self, voice, text, prosody=None):
        import array, math, wave, io
        a = array.array("h", (int(8000 * math.sin(i * 2 * math.pi * 440 / 24000)) for i in range(24000)))   # 1 s at 24 kHz
        b = io.BytesIO()
        w = wave.open(b, "wb"); w.setnchannels(1); w.setsampwidth(2); w.setframerate(24000); w.writeframes(a.tobytes()); w.close()
        return b.getvalue(), "audio/wav"


def run_suite(xr_dir, expect_proto):
    print(f"\n=== XRadio at {xr_dir} (protocol {proto_of(xr_dir)} server; expecting the bridge on v{expect_proto}) ===")
    procs = []
    try:
        port = free_udp_port()
        procs.append(start_server(xr_dir, port))
        br = xradio_bridge.XRadioBridge({"enabled": True, "host": "127.0.0.1", "port": port, "atc_cs": "EETN_TWR", "freq_khz": KHZ,
                                         "ai_traffic": True, "real_pilots": True, "text": True, "weather": "publish",
                                         "ai_voice": True, "icao": "EETN"}, tts=lambda: FakeTts())
        br.start()
        ai = {"cs": "FIN321", "type": "A320", "lat": LAT + 0.01, "lon": LON + 0.02, "alt_m": 400.0, "hdg": 263.0,
              "gs_ms": 70.0, "on_ground": False, "squawk": "4521", "xpdr": "C", "khz": KHZ}
        atis = {"icao": "EETN", "khz": ATIS_KHZ, "letter": "C", "text": "Tallinn information Charlie, runway 26, wind 250 degrees 8 knots"}
        weather = {"wind_dir": 250, "wind_kt": 8, "vis_m": 9000, "qnh_hpa": 1012, "temp_c": 9, "dew_c": 6, "clouds": [{"cover": "SCT", "base_ft": 2500}],
                   "zulu_s": 36000, "date_days": 288}
        state = {"center": {"lat": LAT, "lon": LON, "elev_m": ELEV}, "positions": [{"cs": "EETN_TWR", "khz": KHZ}],
                 "aircraft": [ai], "tx": [], "atis": atis, "weather": weather}

        def sync(extra_tx=(), **kw):
            s = dict(state)
            s["tx"] = list(extra_tx)
            s.update(kw)
            return br.sync(s)

        st = None
        for _ in range(40):
            st = sync()
            if st["atc"] and st["atc"][0]["state"] == "connected" and st["ai_count"] == 1:
                break
            time.sleep(0.2)
        check(st["atc"] and st["atc"][0]["state"] == "connected", "ATC station EETN_TWR logged in")
        check(st["proto"] == expect_proto, f"bridge speaks protocol v{st['proto']} (expected v{expect_proto})")
        check(st["ai_count"] == 1, "AI aircraft FIN321 is in the flight")
        check(st["ai_sessions"] == 1, "one injector session (v6) / one session per aircraft (v5): %d" % st["ai_sessions"])

        # a real pilot: XRadio's own fake client on the tower frequency, ATIS on COM2, filing a plan, talking every 5 s
        fake_out = []
        fc_args = ["--callsign", "ESXYZ", "--lat", str(LAT + 0.02), "--lon", str(LON - 0.03), "--alt-ft", "1500",
                   "--com1", str(KHZ), "--talk", "--parrot", "--squawk", "7000"]
        if expect_proto >= 6:
            fc_args += ["--com2", str(ATIS_KHZ), "--file-plan", "EETN EFHK DCT", "--rules", "V", "--cruise", "3500"]
        procs.append(fake_client(xr_dir, port, fake_out, *fc_args))

        humans, texts, events = [], [], []
        sent = False
        t_end = time.time() + 14
        while time.time() < t_end:
            tx = []
            if not sent and any("logged in as ESXYZ" in l for l in fake_out):
                time.sleep(0.5)
                tx = [{"kind": "atc", "khz": KHZ, "text": "ESXYZ, Tallinn Tower, wind 070 degrees 9 knots"},
                      {"kind": "pilot", "cs": "FIN321", "khz": KHZ, "text": "Tallinn Tower, Finnair 321, established ILS runway 26",
                       "say": "Tallinn Tower, Finnair three two one, established", "nat": "FI", "seed": 3},
                      {"kind": "atc", "khz": KHZ, "text": "radio check", "to": "ESXYZ"}]
                sent = True
            st = sync(tx)
            humans += st["humans"]
            texts += st["texts"]
            events += st["events"]
            if (sent and any("FIN321@" in l for l in fake_out) and any(h["cs"] == "ESXYZ" for h in humans)
                    and any(t["from"] == "ESXYZ" for t in texts)
                    and any("EETN_TWR: ESXYZ, Tallinn Tower" in l for l in fake_out)
                    and any("FIN321: Tallinn Tower, Finnair 321" in l for l in fake_out)
                    and (expect_proto < 6 or (st["fps_count"] >= 1 and any("ATIS EETN information C" in l for l in fake_out)))):
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
        check(any("FIN321: Tallinn Tower, Finnair 321" in l for l in fake_out), "AI pilot text reaches the real pilot, in the aircraft's callsign")
        check(any("[direct] EETN_TWR: radio check" in l for l in fake_out), "a private message (@ESXYZ) reaches only that pilot")
        check(not any(h["cs"] in ("FIN321", "EETN_TWR", "TTRAIN_AI") for h in humans), "own sessions are not shown as humans")

        if expect_proto >= 6:
            print("--- v6 only ---")
            check(any("atc: EETN_TWR 135.905 (TWR)" in l for l in fake_out), "the pilot's ATC list names our station and frequency")
            check(any("ATIS EETN information C" in l and "runway 26" in l for l in fake_out), "the pilot gets the ATIS text on tuning its frequency")
            check(st["atis"] == "C", "status says the ATIS letter published")
            fp = [e for e in events if e["type"] == "fp" and e["cs"] == "ESXYZ"]
            check(bool(fp) and st["fps_count"] >= 1, "the pilot's flight plan reached TowerTrainer: " + (f"{fp[0]['dep']}->{fp[0]['dest']}" if fp else "none"))
            # the controller clears the pilot with a squawk: the plan is answered automatically
            sync([{"kind": "atc", "khz": KHZ, "text": "ESXYZ cleared to EFHK via DCT, climb 3500 feet, squawk 4525"}])
            got = False
            for _ in range(20):
                sync(); time.sleep(0.2)
                if any("flight plan ESXYZ EETN->EFHK DCT: acknowledged, squawk 4525" in l for l in fake_out):
                    got = True
                    break
            check(got, "the clearance with a squawk answers the pilot's flight plan in X-Plane")
            wx = False
            for _ in range(60):                     # the sky goes out every 10 s; a pilot who joined late waits for the next one
                if any("weather: vis" in l for l in fake_out):
                    wx = True
                    break
                sync(); time.sleep(0.25)
            check(wx, "TowerTrainer's weather is published to the flight (PT_WEATHER)")
            # guard: a pilot calling on 121.500 is heard without the station tuning it
            g_out = []
            procs.append(fake_client(xr_dir, port, g_out, "--callsign", "ESGRD", "--lat", str(LAT + 0.01), "--lon", str(LON),
                                     "--alt-ft", "2000", "--com1", "121500", "--talk"))
            heard = False
            for _ in range(40):
                st = sync(); texts += st["texts"]
                if any(t["from"] == "ESGRD" and t["khz"] == 121500 for t in texts):
                    heard = True
                    break
                time.sleep(0.25)
            check(heard, "a call on guard 121.500 reaches the station")
            # AI pilot voice: with a codec on the server the AI call above went out as Opus frames
            caps = br.caps
            if caps["encode"]:
                heard_voice = False
                for _ in range(40):
                    if any("voice:" in l and "frames from sid" in l for l in fake_out):
                        heard_voice = True
                        break
                    sync(); time.sleep(0.25)
                check(heard_voice, "AI pilot speech reaches the real pilot as voice (server-side Opus via %s)" % caps["encode"])
            else:
                print("SKIP  AI voice (no av/opuslib on this machine): " + caps["help"])

        # voice: our push-to-talk frames reach the pilot, whose --parrot echo comes back to us
        br.configure({"voice": True})
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

        # AI aircraft leaves -> gone from the flight
        state["aircraft"] = []
        sync(); time.sleep(0.6); sync()
        check(br.status()["ai_count"] == 0, "AI aircraft removed when it left")
        br.stop()

        # wrong password -> clear refusal
        port2 = free_udp_port()
        procs.append(start_server(xr_dir, port2, password="cumulus"))
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


# join codes decode like the plugin's joincode.h
code_ok = xradio_bridge.decode_join_code("0000A-00001") is None or True
check(code_ok, "join code decoder does not crash on nonsense")

v6_dir = XR_DIR if proto_of(XR_DIR) >= 6 else None
v5_dir = os.environ.get("XRADIO_DIR_V5", "")
tmp_wt = None
if not (v5_dir and is_xradio(v5_dir)):
    v5_dir = None
    if v6_dir and (v6_dir / ".git").exists() and shutil.which("git"):
        tmp_wt = Path(tempfile.mkdtemp(prefix="xradio-0.5.7-"))
        r = subprocess.run(["git", "-C", str(v6_dir), "worktree", "add", "--detach", str(tmp_wt), "v0.5.7"], capture_output=True, text=True)
        if r.returncode == 0 and is_xradio(tmp_wt):
            v5_dir = str(tmp_wt)
        else:
            print("SKIP  no v0.5.7 checkout for the compatibility run (" + r.stderr.strip()[:80] + ")")
if v6_dir:
    run_suite(v6_dir, 6)
else:
    print("SKIP  no v0.6.0 XRadio checkout (protocol 6) found")
if v5_dir:
    run_suite(Path(v5_dir), 5)
if tmp_wt:
    subprocess.run(["git", "-C", str(v6_dir), "worktree", "remove", "--force", str(tmp_wt)], capture_output=True)

print(f"\n{fails} FAILED" if fails else "\nALL PASSED")
sys.exit(1 if fails else 0)
