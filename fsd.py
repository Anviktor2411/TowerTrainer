"""Minimal legacy FSD server so EuroScope can be the radar / controller client for TowerTrainer.

EuroScope connects over TCP (default 127.0.0.1:6809) with "Direct to VATSIM" and "Connect to VATSIM"
unticked. The browser sim POSTs its aircraft to the HTTP server every second (see server.py); they are
sent to EuroScope as pilot position (@N) and flight-plan ($FP) packets. Controller text messages
(#TM) come back to the browser and are handled exactly like typed transmissions.

Packets are ':'-separated lines ending in \\r\\n.
"""
import logging
import random
import socket
import threading
import time

LOG = logging.getLogger("fsd")
SERVER = "SERVER"


def fsd_freq(mhz):
    """135.905 -> '35905' (FSD drops the leading 1 and the decimal point)."""
    return str(int(round((float(mhz) - 100.0) * 1000)))


def mhz_from_fsd(f):
    try:
        return round(100.0 + int(f) / 1000.0, 3)
    except (TypeError, ValueError):
        return None


def pbh(pitch, bank, hdg, on_ground):
    """Pitch/bank/heading word of the @ packet."""
    p = int(round(pitch * 1024 / 360)) & 0x3FF
    b = int(round(bank * 1024 / 360)) & 0x3FF
    h = int(round((hdg % 360) * 1024 / 360)) & 0x3FF
    return (p << 22) | (b << 12) | (h << 2) | ((1 if on_ground else 0) << 1)


class Client:
    def __init__(self, sock, addr):
        self.sock, self.addr = sock, addr
        self.cs = None
        self.freq = None   # primary frequency in MHz
        self.lock = threading.Lock()
        self.alive = True

    def send(self, line):
        try:
            with self.lock:
                self.sock.sendall((line + "\r\n").encode("utf-8", "replace"))
        except OSError:
            self.alive = False


class FSDServer:
    def __init__(self, host="127.0.0.1", port=6809, metar=None):
        self.host, self.port = host, port
        self.metar = metar           # callable icao -> dict | None
        self.clients = []
        self.lock = threading.RLock()
        self.aircraft = {}           # cs -> last sync dict
        self.fp_sent = {}            # cs -> fp line already sent
        self.inbox = []              # messages for the browser
        self.last_sync = 0.0
        self.sock = None

    # ---------- lifecycle ----------
    def start(self):
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.sock.bind((self.host, self.port))
        self.port = self.sock.getsockname()[1]
        self.sock.listen(8)
        threading.Thread(target=self._accept, daemon=True, name="fsd-accept").start()
        threading.Thread(target=self._watchdog, daemon=True, name="fsd-watchdog").start()
        LOG.info("FSD server on %s:%d", self.host, self.port)
        return self

    def stop(self):
        try:
            self.sock.close()
        except OSError:
            pass
        for c in list(self.clients):
            try:
                c.sock.close()
            except OSError:
                pass

    def _accept(self):
        while True:
            try:
                s, addr = self.sock.accept()
            except OSError:
                return
            c = Client(s, addr)
            with self.lock:
                self.clients.append(c)
            c.send(f"$DI{SERVER}:CLIENT:TowerTrainer:{random.getrandbits(32):08x}")
            threading.Thread(target=self._read, args=(c,), daemon=True, name=f"fsd-{addr}").start()

    def _watchdog(self):
        # browser gone for a while: tell EuroScope the pilots left
        while True:
            time.sleep(2)
            if self.aircraft and time.time() - self.last_sync > 10:
                with self.lock:
                    for cs in list(self.aircraft):
                        self._broadcast(f"#DP{cs}:0")
                    self.aircraft.clear()
                    self.fp_sent.clear()

    def _read(self, c):
        buf = b""
        while c.alive:
            try:
                data = c.sock.recv(4096)
            except OSError:
                break
            if not data:
                break
            buf += data
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                line = line.decode("utf-8", "replace").strip("\r")
                if line:
                    try:
                        self._handle(c, line)
                    except Exception:
                        LOG.exception("bad FSD line %r", line)
        self._drop(c)

    def _drop(self, c):
        with self.lock:
            if c in self.clients:
                self.clients.remove(c)
                if c.cs:
                    self._broadcast(f"#DA{c.cs}:{SERVER}", exclude=c)
                    self.inbox.append({"type": "status", "text": f"{c.cs} disconnected"})
        try:
            c.sock.close()
        except OSError:
            pass

    def _broadcast(self, line, exclude=None):
        for o in list(self.clients):
            if o is not exclude and o.cs:
                o.send(line)

    def _client(self, cs):
        return next((o for o in self.clients if o.cs and o.cs.upper() == cs.upper()), None)

    # ---------- incoming packets ----------
    def _handle(self, c, line):
        if line.startswith("#AA"):
            f = line[3:].split(":")
            c.cs = f[0]
            LOG.info("controller login %s", c.cs)
            self.inbox.append({"type": "status", "text": f"{c.cs} connected"})
            c.send(f"#TM{SERVER}:{c.cs}:Welcome to TowerTrainer. Pilots on frequency answer your text messages.")
            self._broadcast(line, exclude=c)
            with self.lock:
                for a in self.aircraft.values():
                    c.send(self._at_line(a))
                    c.send(self._fp_line(a))
            return
        if line.startswith("#DA"):
            self._drop(c)
            return
        if line.startswith("%"):
            f = line[1:].split(":")
            if len(f) > 1:
                m = mhz_from_fsd(f[1])
                if m and 117.9 < m < 137.0:
                    c.freq = m
            self._broadcast(line, exclude=c)
            return
        if line.startswith("#TM"):
            frm, to, text = (line[3:].split(":", 2) + ["", ""])[:3]
            if to.startswith("@"):
                for part in to.split("&"):
                    m = mhz_from_fsd(part.lstrip("@"))
                    if m:
                        self.inbox.append({"type": "tx", "from": frm, "freq": m, "text": text})
                        break
                self._broadcast(line, exclude=c)
            elif to.upper() in self.aircraft:
                self.inbox.append({"type": "tx", "from": frm, "freq": c.freq, "text": f"{to} {text}", "private": to})
            else:
                o = self._client(to)
                if o:
                    o.send(line)
            return
        if line.startswith("$CQ"):
            f = line[3:].split(":")
            frm, to, what = (f + ["", "", ""])[:3]
            arg = f[3] if len(f) > 3 else ""
            if to == SERVER:
                if what == "ATC":
                    is_atc = "Y" if self._client(arg) else "N"
                    c.send(f"$CR{SERVER}:{frm}:ATC:{is_atc}:{arg}")
                elif what == "FP":
                    a = self.aircraft.get(arg.upper())
                    if a:
                        c.send(self._fp_line(a))
                elif what == "IP":
                    c.send(f"$CR{SERVER}:{frm}:IP:{c.addr[0]}")
            elif to.upper() in self.aircraft:
                a = self.aircraft[to.upper()]
                if what == "RN":
                    c.send(f"$CR{a['cs']}:{frm}:RN:TowerTrainer {a.get('nat', '')} crew::1")
                elif what == "CAPS":
                    c.send(f"$CR{a['cs']}:{frm}:CAPS:")
                elif what == "INF":
                    c.send(f"#TM{a['cs']}:{frm}:TowerTrainer AI pilot")
            else:
                o = self._client(to)
                if o:
                    o.send(line)
                elif to.startswith("@"):
                    self._broadcast(line, exclude=c)
            return
        if line.startswith("$AX"):
            f = line[3:].split(":")
            if len(f) >= 4 and f[2] == "METAR":
                raw = None
                try:
                    m = self.metar(f[3]) if self.metar else None
                    raw = m.get("rawOb") if m else None
                except Exception:
                    raw = None
                if raw:
                    c.send(f"$AR{SERVER}:{f[0]}:METAR:{raw}")
            return
        if line.startswith("$PI"):
            f = line[3:].split(":", 2)
            frm, to, data = (f + ["", "", ""])[:3]
            if to == SERVER or to.upper() in self.aircraft:
                c.send(f"$PO{to}:{frm}:{data}")
            else:
                o = self._client(to)
                if o:
                    o.send(line)
            return
        if line.startswith(("$ID", "$DI")):
            return
        # anything else (coordination, $CR replies, #PC, ...) goes to the other controllers
        if line.startswith(("$CR", "#PC", "$HO", "#SB", "$FP", "$AM", "#WX")):
            parts = line[3:].split(":")
            o = self._client(parts[1]) if len(parts) > 1 else None
            if o:
                o.send(line)
            else:
                self._broadcast(line, exclude=c)

    # ---------- outgoing: pilots ----------
    def _at_line(self, a):
        mode = "Y" if a.get("ident") else ("N" if a.get("mode", "C") == "C" else "S")
        return (f"@{mode}:{a['cs']}:{a.get('squawk') or '2000'}:1:{a['lat']:.6f}:{a['lon']:.6f}:"
                f"{int(a.get('alt', 0))}:{int(a.get('gs', 0))}:{pbh(0, 0, a.get('hdg', 0), a.get('onGround'))}:0")

    def _fp_line(self, a):
        typ = f"{a.get('type', 'ZZZZ')}/{a.get('wtc', 'M')}-SDE2E3FGHIJ1RWY/LB1"
        rules = "V" if a.get("vfr") else "I"
        alt = int(a.get("cfl") or 5000)
        return (f"$FP{a['cs']}:*A:{rules}:{typ}:{int(a.get('tas', 250))}:{a.get('dep', '')}:0000:0000:{alt}:"
                f"{a.get('dest', '')}:01:30:03:00:{a.get('altn', '')}:/V/ TowerTrainer:{a.get('route', '')}")

    def sync(self, aircraft, transmissions=()):
        """Called by the HTTP server with the browser's state. Returns messages for the browser."""
        now = time.time()
        with self.lock:
            self.last_sync = now
            seen = set()
            for a in aircraft:
                cs = a["cs"].upper()
                seen.add(cs)
                self.aircraft[cs] = a
                self._broadcast(self._at_line(a))
                fp = self._fp_line(a)
                if self.fp_sent.get(cs) != fp:
                    self.fp_sent[cs] = fp
                    self._broadcast(fp)
            for cs in [x for x in self.aircraft if x not in seen]:
                del self.aircraft[cs]
                self.fp_sent.pop(cs, None)
                self._broadcast(f"#DP{cs}:0")
            for t in transmissions:
                cs = t.get("cs", "")
                if cs.upper() in self.aircraft and t.get("freq"):
                    self._broadcast(f"#TM{cs}:@{fsd_freq(t['freq'])}:{t.get('text', '')}")
            out, self.inbox = self.inbox, []
        return out

    def status(self):
        with self.lock:
            return {"port": self.port, "host": self.host,
                    "controllers": [{"cs": c.cs, "freq": c.freq} for c in self.clients if c.cs]}
