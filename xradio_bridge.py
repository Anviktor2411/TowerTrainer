"""Optional bridge between TowerTrainer and an XRadio server (X-Plane 12 multiplayer + VHF radio).

  * ATC station: one session per staffed position (e.g. EETN_TWR), parked at the tower, transponder off,
    tuned to that position's frequency.
  * AI traffic into X-Plane: every TowerTrainer aircraft within ~20 nm logs in as its own session
    (one UDP socket each -- the XRadio server keys sessions by address) and reports its position at 5 Hz.
  * Real pilots into TowerTrainer: PT_TRAFFIC / PT_ROSTER entries that are not ours become "human" aircraft.
  * Text: AI pilot calls go out as PT_TEXT from the aircraft's session, controller text from the ATC
    session; real pilots' PT_TEXT comes back to the browser.
  * Voice: PT_VOICE frames (one raw 20 ms Opus frame, 48 kHz mono) are relayed to the browser, which
    decodes them with WebCodecs; the browser's push-to-talk frames go out from the ATC session.
Wire protocol: xradio/protocol.py, vendored from XRadio v0.5.7 (protocol v5).
"""
import base64
import logging
import math
import selectors
import socket
import threading
import time
from collections import deque

from xradio import protocol as P

LOG = logging.getLogger("xradio")
AI_RANGE_NM = 20.0
MAX_AI_SESSIONS = 40       # stay well inside the server's 60-entry traffic cap
POS_HZ = 5.0
LT_NAV, LT_BEACON, LT_STROBE, LT_LANDING, LT_TAXI = 1, 2, 4, 8, 16
XPDR = {"S": P.XPDR_STANDBY, "C": P.XPDR_ALT, "A": P.XPDR_ON, "O": P.XPDR_OFF}

DEFAULTS = {"enabled": False, "host": "127.0.0.1", "port": 49100, "password": "", "atc_cs": "",
            "freq_khz": 0, "ai_traffic": True, "real_pilots": True, "text": True, "voice": False}


def nm_between(lat1, lon1, lat2, lon2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    h = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2
    return 2 * 3440.065 * math.asin(min(1.0, math.sqrt(h)))


class Session:
    """One XRadio login on its own UDP socket."""

    def __init__(self, bridge, callsign, ac_icao, kind):
        self.bridge, self.callsign, self.ac_icao, self.kind = bridge, callsign[:15], (ac_icao or "ZZZZ")[:7], kind
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.sock.bind(("0.0.0.0", 0))
        self.sock.setblocking(False)
        self.sid = 0
        self.state = "connecting"
        self.login_sent = 0.0
        self.state_msg = ""
        self.pos = None          # dict for PT_POSITION
        self.voice_seq = 0
        self.keyed_until = 0.0

    def send(self, ptype, payload=b""):
        try:
            self.sock.sendto(P.pack(ptype, self.sid, payload), self.bridge.addr)
        except OSError as e:
            self.state_msg = str(e)

    def login(self):
        self.login_sent = time.monotonic()
        self.sock.sendto(P.pack(P.PT_LOGIN, 0, P.login(self.callsign, self.ac_icao, password=self.bridge.cfg["password"])),
                         self.bridge.addr)

    def send_position(self):
        p = self.pos
        if not p or not self.sid:
            return
        keyed = time.monotonic() < self.keyed_until
        payload = P.POSITION.pack(
            p["lat"], p["lon"], p["alt_m"], p["hdg"], 0.0, 0.0, p["gs"], 1.0 if p["on_ground"] else 0.0, 0.0,
            p["com1"], 0, p.get("lights", 0), 1 if p["on_ground"] else 0,
            P.TX_COM1 if keyed else P.TX_NONE, P.RX_COM1,
            int(time.monotonic() * 1000) & 0xFFFFFFFF, p["hdg"], p.get("vs", 0.0),
            int(p.get("squawk") or 0), p.get("xpdr", P.XPDR_OFF), 1 if p.get("ident") else 0)
        self.send(P.PT_POSITION, payload)

    def text(self, khz, msg):
        data = msg.encode("utf-8")[:200]
        self.send(P.PT_TEXT, P.TEXT_HDR.pack(khz, self.sid, P.pad(self.callsign, 16), len(data), P.pad("", 16)) + data)

    def voice(self, khz, opus):
        self.voice_seq = (self.voice_seq + 1) & 0xFFFF
        self.keyed_until = time.monotonic() + 0.4
        self.send(P.PT_VOICE, P.VOICE_HDR.pack(khz, self.sid, self.voice_seq, len(opus)) + opus)

    def close(self):
        if self.sid:
            self.send(P.PT_LOGOUT)
        try:
            self.sock.close()
        except OSError:
            pass


class XRadioBridge:
    def __init__(self, cfg=None):
        self.cfg = dict(DEFAULTS)
        self.cfg.update(cfg or {})
        self.lock = threading.RLock()
        self.sel = selectors.DefaultSelector()
        self.atc = {}            # position cs -> Session
        self.ai = {}             # aircraft cs -> Session
        self.ai_last = {}        # aircraft cs -> (sync dict, monotonic time)
        self.humans = {}         # sid -> traffic dict
        self.roster = {}         # sid -> (callsign, icao)
        self.texts = deque(maxlen=200)
        self.voice_q = deque(maxlen=2000)
        self.voice_seq = 0
        self.error = ""
        self.running = False
        self.thread = None
        self.center = None       # (lat, lon, elev_m)

    @property
    def addr(self):
        return (self.cfg["host"], int(self.cfg["port"]))

    # ---------- control ----------
    def configure(self, cfg):
        with self.lock:
            restart = any(cfg.get(k, self.cfg[k]) != self.cfg[k] for k in ("host", "port", "password", "atc_cs", "enabled"))
            self.cfg.update({k: v for k, v in cfg.items() if k in DEFAULTS})
        if restart:
            self.stop()
            if self.cfg["enabled"]:
                self.start()
        return self.status()

    def start(self):
        if self.running:
            return
        try:
            socket.getaddrinfo(self.cfg["host"], int(self.cfg["port"]), socket.AF_INET, socket.SOCK_DGRAM)
        except OSError as e:
            self.error = f"cannot resolve {self.cfg['host']}: {e}"
            return
        self.error = ""
        self.running = True
        self.thread = threading.Thread(target=self._loop, daemon=True, name="xradio")
        self.thread.start()

    def stop(self):
        self.running = False
        if self.thread:
            self.thread.join(timeout=2)
        with self.lock:
            for s in list(self.atc.values()) + list(self.ai.values()):
                self._unregister(s)
                s.close()
            self.atc.clear(); self.ai.clear(); self.humans.clear(); self.roster.clear()

    def _register(self, s):
        self.sel.register(s.sock, selectors.EVENT_READ, s)

    def _unregister(self, s):
        try:
            self.sel.unregister(s.sock)
        except (KeyError, ValueError):
            pass

    def _new_session(self, cs, icao, kind):
        s = Session(self, cs, icao, kind)
        self._register(s)
        s.login()
        return s

    # ---------- browser sync ----------
    def sync(self, data):
        """data: {center:{lat,lon,elev_m}, positions:[{cs,khz}], aircraft:[...], tx:[{cs,khz,text,kind}]}"""
        if not self.running:
            return self.status()
        now = time.monotonic()
        with self.lock:
            c = data.get("center")
            if c:
                self.center = (c["lat"], c["lon"], c.get("elev_m", 0))
            # ATC sessions: one per staffed position
            want = {p["cs"]: p for p in data.get("positions", []) if p.get("cs")}
            if not want and self.cfg["atc_cs"]:
                want = {self.cfg["atc_cs"]: {"cs": self.cfg["atc_cs"], "khz": int(self.cfg["freq_khz"] or 0)}}
            for cs in [x for x in self.atc if x not in want]:
                s = self.atc.pop(cs); self._unregister(s); s.close()
            for cs, p in want.items():
                s = self.atc.get(cs) or self.atc.setdefault(cs, self._new_session(cs, "ZZZZ", "atc"))
                if self.center:
                    s.pos = {"lat": self.center[0], "lon": self.center[1], "alt_m": self.center[2] + 30, "hdg": 0.0,
                             "gs": 0.0, "on_ground": True, "com1": int(p.get("khz") or 0), "xpdr": P.XPDR_OFF}
            # AI traffic sessions
            seen = set()
            if self.cfg["ai_traffic"] and self.center:
                cands = []
                for a in data.get("aircraft", []):
                    d = nm_between(self.center[0], self.center[1], a["lat"], a["lon"])
                    if d <= AI_RANGE_NM:
                        cands.append((d, a))
                cands.sort(key=lambda x: x[0])
                for _, a in cands[:MAX_AI_SESSIONS]:
                    cs = a["cs"]
                    seen.add(cs)
                    self.ai_last[cs] = (a, now)
                    if cs not in self.ai:
                        self.ai[cs] = self._new_session(cs, a.get("type", "A320"), "ai")
            for cs in [x for x in self.ai if x not in seen]:
                s = self.ai.pop(cs); self._unregister(s); s.close(); self.ai_last.pop(cs, None)
            # outgoing text
            if self.cfg["text"]:
                for t in data.get("tx", []):
                    khz = int(t.get("khz") or 0)
                    if not khz:
                        continue
                    if t.get("kind") == "pilot":
                        s = self.ai.get(t.get("cs"))
                        if s and s.sid:
                            if s.pos:
                                s.pos["com1"] = khz
                                s.send_position()   # the server only relays text on a tuned frequency
                            s.text(khz, t["text"])
                    else:
                        s = next((x for x in self.atc.values() if x.pos and x.pos["com1"] == khz), None) or \
                            next(iter(self.atc.values()), None)
                        if s and s.sid:
                            s.text(khz, t["text"])
            texts = list(self.texts); self.texts.clear()
        st = self.status()
        st["texts"] = texts
        st["humans"] = list(self.humans.values()) if self.cfg["real_pilots"] else []
        return st

    def send_voice(self, khz, frames):
        """Browser push-to-talk: list of base64 Opus frames, sent from the ATC session on khz."""
        with self.lock:
            s = next((x for x in self.atc.values() if x.pos and x.pos["com1"] == int(khz)), None) or next(iter(self.atc.values()), None)
            if not s or not s.sid or not self.cfg["voice"]:
                return False
            for f in frames:
                s.voice(int(khz), base64.b64decode(f))
            return True

    def take_voice(self, max_n=200):
        out = []
        with self.lock:
            while self.voice_q and len(out) < max_n:
                out.append(self.voice_q.popleft())
        return out

    def status(self):
        with self.lock:
            atc = [{"cs": s.callsign, "state": s.state, "msg": s.state_msg, "khz": s.pos["com1"] if s.pos else 0} for s in self.atc.values()]
            ours = {s.sid for s in list(self.atc.values()) + list(self.ai.values()) if s.sid}
            pilots = [v for k, v in self.roster.items() if k not in ours]
            return {"enabled": self.cfg["enabled"], "running": self.running, "error": self.error, "atc": atc,
                    "ai_sessions": sum(1 for s in self.ai.values() if s.sid), "pilots": len(pilots),
                    "roster": [{"cs": v[0], "type": v[1]} for v in pilots], "config": {k: v for k, v in self.cfg.items() if k != "password"}}

    # ---------- network loop ----------
    def _loop(self):
        period = 1.0 / POS_HZ
        next_pos = 0.0
        while self.running:
            try:
                # Windows select() refuses an empty socket set
                events = self.sel.select(timeout=0.05) if self.sel.get_map() else (time.sleep(0.05) or [])
            except OSError:
                events = []
                time.sleep(0.02)
            for key, _ in events:
                s = key.data
                while True:
                    try:
                        data, _ = s.sock.recvfrom(P.MAX_PACKET + 16)
                    except (BlockingIOError, OSError):
                        break
                    try:
                        self._on_packet(s, data)
                    except Exception:
                        LOG.exception("bad XRadio packet")
            now = time.monotonic()
            with self.lock:
                for s in list(self.atc.values()) + list(self.ai.values()):
                    if not s.sid and s.state == "connecting" and now - s.login_sent > 3:
                        s.state_msg = f"no answer from {self.cfg['host']}:{self.cfg['port']}"
                        if s.kind == "atc":
                            self.error = s.state_msg
                        s.login()
                if now >= next_pos:
                    next_pos = now + period
                    for s in self.atc.values():
                        s.send_position()
                    for cs, s in self.ai.items():
                        self._dead_reckon(s, cs, now)
                        s.send_position()
                    for sid in [k for k, v in self.humans.items() if now - v["_t"] > 5]:
                        del self.humans[sid]

    def _dead_reckon(self, s, cs, now):
        last = self.ai_last.get(cs)
        if not last:
            return
        a, t0 = last
        dt = min(2.0, now - t0)
        gs = a.get("gs_ms", 0.0)
        d = gs * dt / 6371000.0
        h = math.radians(a.get("hdg", 0.0))
        lat = a["lat"] + math.degrees(d * math.cos(h))
        lon = a["lon"] + math.degrees(d * math.sin(h) / max(0.01, math.cos(math.radians(a["lat"]))))
        on_ground = bool(a.get("on_ground"))
        lights = LT_NAV | LT_BEACON | (LT_TAXI if on_ground and gs > 0.5 else 0) | (0 if on_ground else LT_STROBE | LT_LANDING)
        com1 = s.pos["com1"] if s.pos else int(a.get("khz") or 0)
        s.pos = {"lat": lat, "lon": lon, "alt_m": a.get("alt_m", 0.0), "hdg": a.get("hdg", 0.0), "gs": gs,
                 "on_ground": on_ground, "com1": int(a.get("khz") or com1), "lights": lights,
                 "squawk": int(a.get("squawk") or 0) if str(a.get("squawk") or "0").isdigit() else 0,
                 "xpdr": XPDR.get(a.get("xpdr", "C"), P.XPDR_ALT), "ident": a.get("ident", False),
                 "vs": a.get("vs", 0.0)}

    def _on_packet(self, s, data):
        parsed = P.unpack_header(data)
        if not parsed:
            return
        ptype, version, _plen, sid, payload = parsed
        if ptype == P.PT_LOGIN_ACK:
            s.sid, _t = P.LOGIN_ACK.unpack_from(payload, 0)
            s.state, s.state_msg = "connected", ""
            if s.kind == "atc":
                self.error = ""
            LOG.info("XRadio login %s sid=%d", s.callsign, s.sid)
            s.send_position()
            return
        if ptype == P.PT_LOGIN_REJECT:
            reason, _ = P.LOGIN_REJECT.unpack_from(payload, 0)
            msg = ("XRadio server refused the login: wrong or missing flight password" if reason == P.RJ_PASSWORD else
                   f"XRadio server refused the login: protocol version mismatch (TowerTrainer speaks v{P.PROTO_VERSION}, "
                   f"from XRadio v0.5.7; update the server or TowerTrainer's xradio/protocol.py)" if reason == P.RJ_VERSION else
                   f"XRadio server refused the login (reason {reason})")
            s.state, s.state_msg = "rejected", msg
            self.error = msg
            self.running = False   # don't hammer the server
            return
        if s.kind != "atc":
            return               # AI sessions only transmit; the ATC session listens for everyone
        ours = {x.sid for x in list(self.atc.values()) + list(self.ai.values()) if x.sid}
        if ptype == P.PT_TRAFFIC:
            count, _ = P.TRAFFIC_HDR.unpack_from(payload, 0)
            off = P.TRAFFIC_HDR.size
            now = time.monotonic()
            for _ in range(count):
                e = P.TRAFFIC_ENTRY.unpack_from(payload, off)
                off += P.TRAFFIC_ENTRY.size
                tsid = e[0]
                if tsid in ours:
                    continue
                self.humans[tsid] = {"hid": tsid, "cs": P.cstr(e[1]), "type": P.cstr(e[2]), "lat": e[3], "lon": e[4],
                                     "alt_m": e[5], "hdg": e[6], "gs_ms": e[9], "on_ground": bool(e[13]),
                                     "tx": bool(e[14]), "xpdr": e[15], "squawk": f"{e[20]:04d}", "_t": now}
        elif ptype == P.PT_ROSTER:
            _epoch, part, parts, count, _ = P.ROSTER_HDR.unpack_from(payload, 0)
            if part == 0:
                self._roster_new = {}
            off = P.ROSTER_HDR.size
            for _ in range(count):
                rsid, cs, icao = P.ROSTER_ENTRY.unpack_from(payload, off)
                off += P.ROSTER_ENTRY.size
                getattr(self, "_roster_new", {})[rsid] = (P.cstr(cs), P.cstr(icao))
            if part + 1 >= parts:
                self.roster = getattr(self, "_roster_new", {})
        elif ptype == P.PT_TEXT:
            freq, from_sid, frm, tlen, to = P.TEXT_HDR.unpack_from(payload, 0)
            if from_sid in ours:
                return
            text = payload[P.TEXT_HDR.size:P.TEXT_HDR.size + tlen].decode("utf-8", "replace")
            self.texts.append({"from": P.cstr(frm), "khz": freq, "text": text, "to": P.cstr(to)})
        elif ptype == P.PT_VOICE:
            if not self.cfg["voice"]:
                return
            freq, from_sid, seq, olen = P.VOICE_HDR.unpack_from(payload, 0)
            if from_sid in ours:
                return
            opus = payload[P.VOICE_HDR.size:P.VOICE_HDR.size + olen]
            who = self.roster.get(from_sid, (str(from_sid), ""))[0]
            self.voice_q.append({"sid": from_sid, "from": who, "khz": freq, "seq": seq, "opus": base64.b64encode(opus).decode()})
