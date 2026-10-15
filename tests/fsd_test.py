"""EuroScope bridge test: a TCP client plays EuroScope against fsd.FSDServer.

    python tests/fsd_test.py
"""
import socket
import sys
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")   # Windows consoles default to cp1252
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import fsd  # noqa: E402

fails = 0


def check(cond, msg):
    global fails
    print(("PASS  " if cond else "FAIL  ") + msg)
    if not cond:
        fails += 1


class ES:
    def __init__(self, port):
        self.s = socket.create_connection(("127.0.0.1", port), timeout=2)
        self.buf = b""
        self.lines = []

    def send(self, line):
        self.s.sendall((line + "\r\n").encode())

    def pump(self, secs=0.5):
        end = time.time() + secs
        self.s.settimeout(0.05)
        while time.time() < end:
            try:
                d = self.s.recv(65536)
                if not d:
                    break
                self.buf += d
            except socket.timeout:
                pass
            while b"\r\n" in self.buf:
                ln, self.buf = self.buf.split(b"\r\n", 1)
                self.lines.append(ln.decode())
        return self.lines

    def find(self, prefix):
        return [l for l in self.lines if l.startswith(prefix)]


srv = fsd.FSDServer("127.0.0.1", 0, metar=lambda icao: {"rawOb": f"METAR {icao} 121020Z 07009KT 9999 OVC040 10/08 Q1009"}).start()
es = ES(srv.port)
es.pump(0.3)
check(any(l.startswith("$DISERVER:CLIENT:TowerTrainer:") for l in es.lines), "server identifies itself with $DI")
es.send("#AAEETN_TWR:SERVER:Test Controller:1234567:pw:5:100")
es.send("%EETN_TWR:35905:4:100:5:59.41333:24.83250:0")
es.pump(0.3)
st = srv.status()
check(st["controllers"] and st["controllers"][0]["cs"] == "EETN_TWR", "controller login registered")
check(abs((st["controllers"][0]["freq"] or 0) - 135.905) < 1e-6, "primary frequency from % packet = 135.905")

ac = {"cs": "FIN321", "squawk": "4521", "mode": "C", "lat": 59.4133, "lon": 24.8325, "alt": 132, "gs": 0, "hdg": 263,
      "onGround": True, "type": "A320", "wtc": "M", "dep": "EETN", "dest": "EFHK", "route": "DCT", "cfl": 5000, "tas": 250}
msgs = srv.sync([ac], [{"cs": "FIN321", "freq": 135.905, "text": "Tallinn Tower, Finnair 321, ready for departure"}])
es.pump(0.4)
at = es.find("@N:FIN321:4521:1:")
check(bool(at), "pilot position @N packet: " + (at[0] if at else "none"))
f = at[0].split(":") if at else []
check(len(f) == 10 and abs(float(f[4]) - 59.4133) < 1e-4 and abs(float(f[5]) - 24.8325) < 1e-4, "lat/lon in @ packet")
if f:
    word = int(f[8])
    check(word & 2 == 2, "on-ground bit set in pbh")
    check(abs(((word >> 2) & 0x3FF) * 360 / 1024 - 263) < 1, "heading encoded in pbh")
fp = es.find("$FPFIN321:*A:I:A320/M-")
check(bool(fp) and ":EETN:" in fp[0] and ":EFHK:" in fp[0] and fp[0].endswith(":DCT"), "flight plan $FP: " + (fp[0] if fp else "none"))
sb = srv._fp_line({"cs": "TTR123", "type": "A320", "wtc": "M", "dep": "EETN", "dest": "EVRA", "cfl": 5000, "simbrief": True, "equip": "SDE2E3FGHIRWXY/LB1D1", "rfl": 36000, "altn": "EYVI", "eobt": "0730", "tas_plan": 447, "remarks": "PBN/A1B1 REG/ESTTR", "route": "ULGOT1G ULGOT N746 ABETI ABETI2A"})
check(sb.startswith("$FPTTR123:*A:I:A320/M-SDE2E3FGHIRWXY/LB1D1:447:EETN:0730:0730:36000:EVRA:") and ":EYVI:/V/ SIMBRIEF PBN/A1B1 REG/ESTTR:ULGOT1G ULGOT N746 ABETI ABETI2A" in sb, "a SimBrief flight files its OFP equipment, level, alternate, EOBT and remarks: " + sb)
tm = es.find("#TMFIN321:@35905:")
check(bool(tm) and "ready for departure" in tm[0], "pilot transmission as #TM on @35905")

# controller text back to the browser
es.send("#TMEETN_TWR:@35905:FIN321 runway 26 cleared for takeoff")
es.send("#TMEETN_TWR:FIN321:contact Tallinn Radar 127.905")
es.pump(0.3)
msgs = srv.sync([ac], [])
tx = [m for m in msgs if m.get("type") == "tx"]
check(any(m["text"] == "FIN321 runway 26 cleared for takeoff" and abs(m["freq"] - 135.905) < 1e-6 for m in tx), "frequency message reaches the browser")
check(any(m["text"] == "FIN321 contact Tallinn Radar 127.905" and m.get("private") == "FIN321" for m in tx), "private message gets the callsign prepended")

# queries
es.lines.clear()
es.send("$CQEETN_TWR:SERVER:ATC:EETN_TWR")
es.send("$CQEETN_TWR:SERVER:FP:FIN321")
es.send("$CQEETN_TWR:FIN321:RN")
es.send("$AXEETN_TWR:SERVER:METAR:EETN")
es.send("$PIEETN_TWR:SERVER:12345")
es.pump(0.4)
check(any(l == "$CRSERVER:EETN_TWR:ATC:Y:EETN_TWR" for l in es.lines), "$CQ ATC answered")
check(bool(es.find("$FPFIN321")), "$CQ FP answered with the flight plan")
check(bool(es.find("$CRFIN321:EETN_TWR:RN:")), "$CQ RN answered on the pilot's behalf")
check(any(l.startswith("$ARSERVER:EETN_TWR:METAR:METAR EETN") for l in es.lines), "METAR request answered")
check(any(l == "$POSERVER:EETN_TWR:12345" for l in es.lines), "ping answered")

# second controller: messages are relayed between EuroScope clients
es2 = ES(srv.port); es2.pump(0.2)
es2.send("#AAEETN_GND:SERVER:Second:7654321:pw:3:100"); es2.pump(0.3)
es.send("#TMEETN_TWR:EETN_GND:hello ground"); es2.pump(0.3)
check(any(l == "#TMEETN_TWR:EETN_GND:hello ground" for l in es2.lines), "controller-to-controller chat relayed")
check(any(l.startswith("@N:FIN321") for l in es2.lines), "late joiner gets current pilots")

# aircraft leaves
es.lines.clear()
srv.sync([], [])
es.pump(0.3)
check(any(l.startswith("#DPFIN321") for l in es.lines), "#DP when the aircraft leaves")
srv.stop()
print(f"\n{fails} FAILED" if fails else "\nALL PASSED")
sys.exit(1 if fails else 0)
