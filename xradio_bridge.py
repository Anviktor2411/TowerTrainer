"""Optional bridge between TowerTrainer and an XRadio server (X-Plane multiplayer + VHF radio).

Protocol v6 (XRadio 0.6.0, vendored in xradio/protocol.py), with a fallback to a v0.5.x server:

  * ATC stations: one session per staffed position (EETN_TWR, EETN_GND...) logged in with LF_ATC, parked at the
    tower, tuned to the position's frequency on COM1 and to guard (121.500) on COM2. Not an aircraft to anyone.
  * AI traffic into X-Plane: ONE injector session (LF_INJECTOR) sends every TowerTrainer aircraft within ~20 nm
    as PT_AI_TRAFFIC at 5 Hz; the server relays them as ordinary traffic (CSL models, TCAS) under their own
    callsigns. On a v5 server every aircraft logs in as a session of its own instead (the old way).
  * Real pilots: PT_TRAFFIC / PT_ROSTER entries that are not ours become "human" aircraft for the browser;
    their PT_FLIGHTPLAN fills their strip, and the controller's clearance goes back as PT_FLIGHTPLAN with the
    assigned squawk.
  * Text: AI pilot calls go out through the injector in the aircraft's callsign, controller text from the ATC
    session; real pilots' text (frequency, guard or direct @message) comes back to the browser.
  * Voice both ways: real pilots' Opus frames are relayed to the browser (WebCodecs) or decoded here (PyAV /
    opuslib, optional) for browsers without WebCodecs; the controller's push-to-talk frames go out from the ATC
    session; AI pilots' calls are rendered with the neural TTS, encoded to Opus here (optional) and sent in the
    aircraft's callsign so X-Plane pilots hear the traffic. Optional local speech recognition (stt.py) turns real
    pilots' voice into transcript lines -- never into instructions.
  * Weather: publish TowerTrainer's weather to the flight (PT_WEATHER, the ATC session claims the sky) or follow
    the flight's weather into TowerTrainer. ATIS: PT_ATIS text, optionally a looped voice on the ATIS frequency.
"""
import base64
import logging
import math
import os
import re
import selectors
import socket
import struct
import threading
import time
from collections import deque

from xradio import protocol as P

try:
    import opus_codec
except Exception:        # pragma: no cover
    opus_codec = None

LOG = logging.getLogger("xradio")
AI_RANGE_NM = 20.0
MAX_AI_V6 = 60             # one injector may drive this many (the server's cap)
MAX_AI_V5 = 40             # per-aircraft sessions: stay inside the server's 60-entry traffic cap
POS_HZ = 5.0
AI_HZ = 5.0
WEATHER_EVERY_S = 10.0
ATIS_EVERY_S = 60.0
LT_NAV, LT_BEACON, LT_STROBE, LT_LANDING, LT_TAXI = 1, 2, 4, 8, 16
XPDR = {"S": P.XPDR_STANDBY, "C": P.XPDR_ALT, "A": P.XPDR_ON, "O": P.XPDR_OFF}
GUARD = P.GUARD_KHZ

DEFAULTS = {"enabled": False, "host": "127.0.0.1", "port": 49100, "password": "", "atc_cs": "", "freq_khz": 0,
            "ai_traffic": True, "real_pilots": True, "text": True, "voice": False,
            "weather": "off",          # off | publish | follow
            "transcribe": False,       # real pilots' voice -> transcript lines (local Whisper/Vosk)
            "ai_voice": True,          # AI pilots' TTS as Opus into the flight (needs av / opuslib)
            "atis_voice": False,       # the ATIS as a looped voice on the ATIS frequency
            "icao": ""}


def nm_between(lat1, lon1, lat2, lon2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    h = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2
    return 2 * 3440.065 * math.asin(min(1.0, math.sqrt(h)))


def disable_udp_reset(sock):
    """Windows: a datagram to a port nobody listens on any more must not cost us the next receive."""
    if os.name != "nt":
        return
    try:
        import ctypes
        ws2 = ctypes.windll.ws2_32
        ws2.WSAIoctl.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_void_p, ctypes.c_ulong, ctypes.c_void_p,
                                 ctypes.c_ulong, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p]
        off, ret = ctypes.c_ulong(0), ctypes.c_ulong(0)
        ws2.WSAIoctl(sock.fileno(), 0x9800000C, ctypes.byref(off), 4, None, 0, ctypes.byref(ret), None, None)
    except Exception:
        pass


def decode_join_code(code):
    """XRadio join code (K7M2Q-X4PB9) -> (ip, port) or None; the same alphabet and check bits as joincode.h."""
    alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
    sym = ""
    for c in code.upper():
        if c in "- ":
            continue
        c = {"O": "0", "I": "1", "L": "1"}.get(c, c)
        if c not in alphabet:
            return None
        sym += c
    if len(sym) != 10:
        return None
    full = 0
    for c in sym:
        full = (full << 5) | alphabet.index(c)
    v = full >> 2
    check = sum((v >> (8 * i)) & 255 for i in range(6)) & 3
    if (full & 3) != check:
        return None
    port, ip = v & 0xFFFF, v >> 16
    return (f"{(ip >> 24) & 255}.{(ip >> 16) & 255}.{(ip >> 8) & 255}.{ip & 255}", port)


class Session:
    """One XRadio login on its own UDP socket."""

    def __init__(self, bridge, callsign, ac_icao, kind, flags=0):
        self.bridge, self.callsign, self.ac_icao, self.kind = bridge, callsign[:15], (ac_icao or "ZZZZ")[:7], kind
        self.flags = flags
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.sock.bind(("0.0.0.0", 0))
        self.sock.setblocking(False)
        disable_udp_reset(self.sock)
        self.sid = 0
        self.state = "connecting"
        self.login_sent = 0.0
        self.state_msg = ""
        self.pos = None          # dict for PT_POSITION
        self.voice_seq = 0
        self.keyed_until = 0.0

    def send(self, ptype, payload=b""):
        try:
            self.sock.sendto(P.pack(ptype, self.sid, payload, version=self.bridge.proto), self.bridge.addr)
        except OSError as e:
            self.state_msg = str(e)

    def login(self):
        self.login_sent = time.monotonic()
        flags = self.flags if self.bridge.proto >= 6 else (self.flags & P.LF_WEATHER_SOURCE)
        try:
            self.sock.sendto(P.pack(P.PT_LOGIN, 0, P.login(self.callsign, self.ac_icao, password=self.bridge.cfg["password"],
                                                           flags=flags, version=self.bridge.proto), version=self.bridge.proto),
                             self.bridge.addr)
        except OSError as e:
            self.state_msg = str(e)

    def send_position(self):
        p = self.pos
        if not p or not self.sid:
            return
        keyed = time.monotonic() < self.keyed_until
        com2 = int(p.get("com2") or 0)
        fields = (
            p["lat"], p["lon"], p["alt_m"], p["hdg"], 0.0, 0.0, p["gs"], 1.0 if p["on_ground"] else 0.0, 0.0,
            p["com1"], com2, p.get("lights", 0), 1 if p["on_ground"] else 0,
            P.TX_COM1 if keyed else P.TX_NONE, P.RX_COM1 | (P.RX_COM2 if com2 else 0),
            int(time.monotonic() * 1000) & 0xFFFFFFFF, p["hdg"], p.get("vs", 0.0),
            int(p.get("squawk") or 0), p.get("xpdr", P.XPDR_OFF), 1 if p.get("ident") else 0)
        if self.bridge.proto >= 6:
            # XRadio's radio model (its docs/radio.md): a station sends 0 -- its facility's antenna height
            # and service volume (a tower 25 nm / 4000 ft, approach 60 nm, a centre its area)
            payload = P.POSITION.pack(*fields, p.get("agl_m", 0.0), 0, 0)
        else:
            payload = P.POSITION_V5.pack(*fields)
        self.send(P.PT_POSITION, payload)

    def text(self, khz, msg, to="", from_sid=None, from_cs=None):
        data = msg.encode("utf-8")[:200]
        self.send(P.PT_TEXT, P.TEXT_HDR.pack(khz, from_sid if from_sid is not None else self.sid,
                                             P.pad(from_cs or self.callsign, 16), len(data), P.pad(to or "", 16)) + data)

    def voice(self, khz, opus, from_sid=None):
        self.voice_seq = (self.voice_seq + 1) & 0xFFFF
        if from_sid is None:
            self.keyed_until = time.monotonic() + 0.4
        self.send(P.PT_VOICE, P.VOICE_HDR.pack(khz, from_sid if from_sid is not None else self.sid, self.voice_seq,
                                               len(opus)) + opus)

    def close(self):
        if self.sid:
            self.send(P.PT_LOGOUT)
        try:
            self.sock.close()
        except OSError:
            pass


class XRadioBridge:
    def __init__(self, cfg=None, tts=None, stt=None):
        self.cfg = dict(DEFAULTS)
        self.cfg.update(cfg or {})
        self.tts, self.stt = tts, stt     # callables returning the managers (server.py's tts() / stt()), optional
        self.lock = threading.RLock()
        self.sel = selectors.DefaultSelector()
        self.proto = P.PROTO_VERSION      # 6; drops to 5 when the server says so
        self.compat_tried = False
        self.atc = {}            # position cs -> Session
        self.injector = None     # Session (v6)
        self.ai = {}             # v5: aircraft cs -> Session
        self.ai_local = {}       # v6: aircraft cs -> local id
        self.ai_last = {}        # aircraft cs -> (sync dict, monotonic time)
        self.ai_gone = {}        # v6: local id -> callsign, removal pending
        self.next_local = 1
        self.humans = {}         # sid -> traffic dict
        self.roster = {}         # sid -> (callsign, icao)
        self.atc_list = []       # [{cs, icao, khz, kind}] the server's list
        self.fps = {}            # sid -> flight plan dict (real pilots)
        self.aircraft = {}       # sid -> PT_AIRCRAFT dict (detected type, tail, span, MTOW) of real pilots
        self.tcas = {}           # sid -> PT_TCAS dict of real pilots (+ "_t"), their own X-Plane TCAS
        self.texts = deque(maxlen=200)
        self.voice_q = deque(maxlen=2000)
        self.events = deque(maxlen=100)
        self.error = ""
        self.running = False
        self.thread = None
        self.center = None       # (lat, lon, elev_m)
        self.wx_out = None       # weather dict from the browser (publish)
        self.wx_in = None        # weather dict from the flight (follow)
        self.wx_sent = 0.0
        self.atis = None         # {icao, khz, letter, text}
        self.atis_sent = (None, 0.0)
        self.atis_session = None
        self.atis_frames = []
        self.atis_next = 0.0
        self.atis_i = 0
        self.tx_voice_q = deque()   # (from_sid, khz, frames, label)
        self.voice_thread = None
        self.encoder = None
        self.decoders = {}       # sid -> Decoder (server-side decode)
        self.speech = {}         # sid -> {"pcm": bytearray, "last": t, "cs": cs, "khz": k}
        self.cast_cache = {}     # cs -> voice id
        self.caps = opus_codec.capabilities() if opus_codec else {"encode": None, "decode": None, "mp3": False, "help": "opus_codec missing"}

    @property
    def addr(self):
        return (self.cfg["host"], int(self.cfg["port"]))

    # ---------- control ----------
    def configure(self, cfg):
        with self.lock:
            cfg = dict(cfg or {})
            code = decode_join_code(str(cfg.get("host", "")))
            if code:
                cfg["host"], cfg["port"] = code
            restart = any(cfg.get(k, self.cfg[k]) != self.cfg[k] for k in ("host", "port", "password", "atc_cs", "enabled", "weather"))
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
        if self.voice_thread is None:
            self.voice_thread = threading.Thread(target=self._voice_tx_loop, daemon=True, name="xradio-voice")
            self.voice_thread.start()

    def stop(self):
        self.running = False
        if self.thread:
            self.thread.join(timeout=2)
            self.thread = None
        with self.lock:
            for s in self._sessions():
                self._unregister(s)
                s.close()
            self.atc.clear(); self.ai.clear(); self.humans.clear(); self.roster.clear(); self.fps.clear()
            self.injector = None; self.atis_session = None; self.ai_local.clear(); self.ai_gone.clear()
            self.atc_list = []; self.wx_in = None

    def _sessions(self):
        out = list(self.atc.values()) + list(self.ai.values())
        if self.injector:
            out.append(self.injector)
        if self.atis_session:
            out.append(self.atis_session)
        return out

    def _register(self, s):
        self.sel.register(s.sock, selectors.EVENT_READ, s)

    def _unregister(self, s):
        try:
            self.sel.unregister(s.sock)
        except (KeyError, ValueError):
            pass

    def _new_session(self, cs, icao, kind, flags=0):
        s = Session(self, cs, icao, kind, flags)
        self._register(s)
        s.login()
        return s

    def _ours(self):
        return {x.sid for x in self._sessions() if x.sid}

    def _ai_sid(self, cs):
        if self.proto >= 6 and self.injector and self.injector.sid and cs in self.ai_local:
            return P.ai_sid(self.injector.sid, self.ai_local[cs])
        return None

    # ---------- browser sync ----------
    def sync(self, data):
        """data: {center, positions:[{cs,khz}], aircraft:[...], tx:[{cs,khz,text,kind,to,voice...}], weather, atis, fp_acks}"""
        if not self.running:
            return self.status()
        now = time.monotonic()
        with self.lock:
            c = data.get("center")
            if c:
                self.center = (c["lat"], c["lon"], c.get("elev_m", 0))
            if data.get("weather") and self.cfg["weather"] == "publish":
                if self.wx_out is None:
                    self.wx_sent = 0.0          # the first sky goes out at once, the rest every 10 s
                self.wx_out = data["weather"]
            if data.get("atis"):
                self.atis = data["atis"]
            atc_flags = (P.LF_ATC if self.proto >= 6 else 0) | (P.LF_WEATHER_SOURCE if self.cfg["weather"] == "publish" else 0)
            # ATC sessions: one per staffed position
            want = {p["cs"]: p for p in data.get("positions", []) if p.get("cs")}
            if not want and self.cfg["atc_cs"]:
                want = {self.cfg["atc_cs"]: {"cs": self.cfg["atc_cs"], "khz": int(self.cfg["freq_khz"] or 0)}}
            for cs in [x for x in self.atc if x not in want]:
                s = self.atc.pop(cs); self._unregister(s); s.close()
            for cs, p in want.items():
                s = self.atc.get(cs) or self.atc.setdefault(cs, self._new_session(cs, "ATC", "atc", atc_flags))
                if self.center:
                    s.pos = {"lat": self.center[0], "lon": self.center[1], "alt_m": self.center[2] + 30, "hdg": 0.0,
                             "gs": 0.0, "on_ground": True, "com1": int(p.get("khz") or 0), "com2": GUARD, "xpdr": P.XPDR_OFF}
            # AI traffic
            seen = set()
            if self.cfg["ai_traffic"] and self.center:
                cands = []
                for a in data.get("aircraft", []):
                    d = nm_between(self.center[0], self.center[1], a["lat"], a["lon"])
                    if d <= AI_RANGE_NM:
                        cands.append((d, a))
                cands.sort(key=lambda x: x[0])
                limit = MAX_AI_V6 if self.proto >= 6 else MAX_AI_V5
                for _, a in cands[:limit]:
                    cs = a["cs"]
                    seen.add(cs)
                    self.ai_last[cs] = (a, now)
                    if self.proto >= 6:
                        if self.injector is None:
                            self.injector = self._new_session("TTRAIN_AI", "ZZZZ", "injector", P.LF_INJECTOR)
                        if cs not in self.ai_local:
                            self.ai_local[cs] = self.next_local
                            self.next_local = self.next_local % 65535 + 1
                    elif cs not in self.ai:
                        self.ai[cs] = self._new_session(cs, a.get("type", "A320"), "ai")
            for cs in [x for x in self.ai if x not in seen]:
                s = self.ai.pop(cs); self._unregister(s); s.close(); self.ai_last.pop(cs, None)
            for cs in [x for x in self.ai_local if x not in seen]:
                self.ai_gone[self.ai_local.pop(cs)] = cs
                self.ai_last.pop(cs, None)
            # outgoing text and AI voice
            if self.cfg["text"]:
                for t in data.get("tx", []):
                    self._transmit(t)
            for ack in data.get("fp_acks", []) or []:
                self.fp_ack(ack)
            texts = list(self.texts); self.texts.clear()
            events = list(self.events); self.events.clear()
        st = self.status()
        st["texts"] = texts
        st["events"] = events
        now = time.monotonic()
        humans = []
        for sid, h in self.humans.items():
            h = dict(h)
            if sid in self.aircraft:
                h["acft"] = self.aircraft[sid]
                h["type"] = self.aircraft[sid]["ac_icao"] or h["type"]
            t = self.tcas.get(sid)
            if t and now - t["_t"] < 4:
                h["tcas"] = {k: v for k, v in t.items() if k != "_t"}
            humans.append(h)
        st["humans"] = humans if self.cfg["real_pilots"] else []
        st["fps"] = list(self.fps.values())
        st["weather"] = self.wx_in if self.cfg["weather"] == "follow" else None
        return st

    def _transmit(self, t):
        """One transmission from the browser: controller text (optionally direct), or an AI pilot's call."""
        khz = int(t.get("khz") or 0)
        to = (t.get("to") or "").upper()[:15]
        if not khz and not to:
            return
        if t.get("kind") == "pilot":
            cs = t.get("cs") or ""
            if self.proto >= 6:
                sid = self._ai_sid(cs)
                if sid is None or not self.injector or not self.injector.sid:
                    return
                self.injector.text(khz, t["text"], from_sid=sid, from_cs=cs)
                if self.cfg["ai_voice"] and self.caps["encode"] and self.tts and t.get("say"):
                    self._queue_ai_voice(cs, sid, khz, t)
            else:
                s = self.ai.get(cs)
                if s and s.sid:
                    if s.pos:
                        s.pos["com1"] = khz
                        s.send_position()   # the server only relays text on a tuned frequency
                    s.text(khz, t["text"])
        else:
            s = next((x for x in self.atc.values() if x.pos and x.pos["com1"] == khz), None) or next(iter(self.atc.values()), None)
            if s and s.sid:
                s.text(0 if to else khz, t["text"], to=to)
                if t.get("say") and not to and self.cfg["ai_voice"] and self.caps["encode"] and self.tts:
                    # S4: an AI controller's call to a real pilot is voiced into the flight with a controller voice
                    self._queue_ai_voice("ATC:" + str(t.get("pos") or s.callsign), s.sid, khz, dict(t, role="atc", voice=None))
                # a clearance to a real pilot carries their squawk: answer the flight plan with it
                m = re.search(r"\bsquawk (\d{4})\b", t.get("text", ""), re.I)
                if m:
                    for sid, fp in self.fps.items():
                        if fp["callsign"] and t["text"].upper().startswith(fp["callsign"]) and fp["status"] != "ack":
                            self.fp_ack({"cs": fp["callsign"], "squawk": int(m.group(1)), "status": "ack", "remarks": t["text"][:63]})

    # ---------- flight plans (real pilots) ----------
    def fp_ack(self, d):
        """ATC answers a real pilot's flight plan: {cs, squawk, status: ack|cleared|cancel, remarks}."""
        with self.lock:
            cs = (d.get("cs") or "").upper()
            fp = next((f for f in self.fps.values() if f["callsign"] == cs), None)
            s = next(iter(self.atc.values()), None)
            if not fp or not s or not s.sid or self.proto < 6:
                return False
            status = {"ack": P.FP_ACK, "cleared": P.FP_CLEARED, "cancel": P.FP_CANCELLED}.get(d.get("status", "ack"), P.FP_ACK)
            squawk = int(d.get("squawk") or 0)
            s.send(P.PT_FLIGHTPLAN, P.flightplan(cs, fp["ac_icao"], fp["dep"], fp["dest"], fp["route"], rules=fp["rules"],
                                                 cruise_ft=fp["cruise_ft"], altn=fp["altn"], remarks=str(d.get("remarks", ""))[:63],
                                                 status=status, squawk=squawk, session_id=fp["session_id"]))
            fp["status"] = {P.FP_ACK: "ack", P.FP_CLEARED: "cleared", P.FP_CANCELLED: "cancelled"}[status]
            fp["squawk"] = squawk or fp.get("squawk", 0)
            self.events.append({"type": "fp", "cs": cs, "status": fp["status"], "squawk": fp["squawk"]})
            return True

    # ---------- voice ----------
    def send_voice(self, khz, frames):
        """Browser push-to-talk: list of base64 Opus frames, sent from the ATC session on khz."""
        with self.lock:
            s = next((x for x in self.atc.values() if x.pos and x.pos["com1"] == int(khz)), None) or next(iter(self.atc.values()), None)
            if not s or not s.sid or not self.cfg["voice"]:
                return False
            for f in frames:
                s.voice(int(khz), base64.b64decode(f))
            return True

    def send_voice_pcm(self, khz, pcm_b64):
        """Push-to-talk from a browser without WebCodecs: 16-bit 48 kHz mono PCM, encoded here."""
        if not self.caps["encode"]:
            return False
        try:
            import array
            a = array.array("h")
            a.frombytes(base64.b64decode(pcm_b64))
            if self.encoder is None:
                self.encoder = opus_codec.Encoder()
            frames = self.encoder.frames(a)
        except Exception as e:
            LOG.warning("voice encode failed: %s", e)
            return False
        return self.send_voice(khz, [base64.b64encode(f).decode() for f in frames])

    def take_voice(self, max_n=200, pcm=False):
        out = []
        with self.lock:
            while self.voice_q and len(out) < max_n:
                f = self.voice_q.popleft()
                if pcm:
                    if not self.caps["decode"]:
                        continue
                    try:
                        dec = self.decoders.get(f["sid"]) or self.decoders.setdefault(f["sid"], opus_codec.Decoder())
                        f = dict(f, pcm=base64.b64encode(dec.pcm(base64.b64decode(f["opus"]))).decode())
                        f.pop("opus", None)
                    except Exception as e:
                        LOG.debug("decode: %s", e)
                        continue
                out.append(f)
        return out

    def _queue_ai_voice(self, cs, sid, khz, t):
        """Render the AI pilot's call with the neural TTS and queue it as Opus frames (worker thread)."""
        def work():
            try:
                mgr = self.tts()
                voice = t.get("voice") or self.cast_cache.get(cs)
                if not voice:
                    v = mgr.cast(str(t.get("nat") or "GB")[:3], int(t.get("seed") or 0), t.get("gender"), [], str(t.get("role") or "pilot"))
                    voice = v["id"] if isinstance(v, dict) else v
                    self.cast_cache[cs] = voice
                data, mime = mgr.render(voice, str(t.get("say") or t.get("text"))[:600], t.get("prosody") or {})
                if self.encoder is None:
                    self.encoder = opus_codec.Encoder()
                frames = opus_codec.frames_from_audio(data, mime, self.encoder)
                with self.lock:
                    self.tx_voice_q.append((sid, khz, frames, cs))
            except Exception as e:
                LOG.info("AI voice for %s not sent: %s", cs, e)
        threading.Thread(target=work, daemon=True).start()

    def _voice_tx_loop(self):
        """Sends queued AI voice (and the ATIS loop) at 50 frames a second, one transmission at a time."""
        while True:
            item = None
            with self.lock:
                if self.tx_voice_q:
                    item = self.tx_voice_q.popleft()
            if item is None:
                time.sleep(0.05)
                continue
            sid, khz, frames, label = item
            t0 = time.monotonic()
            for i, f in enumerate(frames):
                with self.lock:
                    ai = isinstance(sid, int) and P.is_ai_sid(sid)
                    # an AI pilot speaks through the injector; a controller through its own ATC session (S4)
                    s = self.injector if ai else (next((x for x in self.atc.values() if x.sid == sid), None) or next(iter(self.atc.values()), None))
                    if sid == "atis":
                        s = self.atis_session
                    if not self.running or not s or not s.sid:
                        break
                    s.voice(khz, f, from_sid=sid if ai else None)
                time.sleep(max(0.0, t0 + (i + 1) * 0.02 - time.monotonic()))

    def _transcribe_tick(self, now):
        """Real pilots' voice, decoded here, becomes a transcript line once they stop talking."""
        for sid, sp in list(self.speech.items()):
            if now - sp["last"] < 0.6 or len(sp["pcm"]) < 48000:     # at least half a second of audio
                if now - sp["last"] >= 0.6:
                    del self.speech[sid]
                continue
            pcm = bytes(sp["pcm"])
            del self.speech[sid]
            phrases = [v[0] for v in self.roster.values()] + [x.callsign for x in self.atc.values()]

            def work(pcm=pcm, sp=sp, phrases=phrases):
                try:
                    r = self.stt().transcribe(opus_codec.pcm_to_wav(pcm), phrases)
                    if r.get("text"):
                        with self.lock:
                            self.texts.append({"from": sp["cs"], "khz": sp["khz"], "text": r["text"], "to": "", "voice": True,
                                               "engine": r.get("engine", "")})
                except Exception as e:
                    LOG.debug("transcript: %s", e)
            threading.Thread(target=work, daemon=True).start()

    # ---------- weather / ATIS ----------
    def _send_weather(self):
        """TowerTrainer's sky to the flight (we claimed it at login). Returns True when a packet went out."""
        w = self.wx_out
        s = next(iter(self.atc.values()), None)
        if not w or not s or not s.sid:
            return False
        wind_dir, wind_kt = float(w.get("wind_dir") or 0), float(w.get("wind_kt") or 0)
        vis_sm = max(0.1, float(w.get("vis_m") or 10000) / 1609.34)
        clouds = (w.get("clouds") or [])[:P.CLOUD_LAYERS]
        ctype = [3.0 if c.get("cover") in ("BKN", "OVC") else 1.0 for c in clouds] + [0.0] * (P.CLOUD_LAYERS - len(clouds))
        ccov = [{"FEW": 0.2, "SCT": 0.4, "BKN": 0.7, "OVC": 0.95}.get(c.get("cover"), 0.3) for c in clouds] + [0.0] * (P.CLOUD_LAYERS - len(clouds))
        cbase = [float(c.get("base_ft") or 3000) * 0.3048 for c in clouds] + [0.0] * (P.CLOUD_LAYERS - len(clouds))
        ctops = [b + 600.0 for b in cbase]
        alts = [0.0, 300.0, 600.0, 900.0, 1500.0, 2000.0, 3000.0, 4000.0, 5000.0, 6000.0, 8000.0, 10000.0, 12000.0]
        spd = [wind_kt * 0.514444 * (1 + i * 0.05) for i in range(P.AIR_LAYERS)]
        dirs = [wind_dir] * P.AIR_LAYERS
        turb = [0.0] * P.AIR_LAYERS
        temp = float(w.get("temp_c") if w.get("temp_c") is not None else 12.0)
        dew = float(w.get("dew_c") if w.get("dew_c") is not None else temp - 3)
        temps = [temp - a / 1000.0 * 6.5 for a in alts]
        dews = [dew - a / 1000.0 * 2.0 for a in alts]
        payload = P.WEATHER.pack(int(time.monotonic() * 1000) & 0xFFFFFFFF, float(w.get("zulu_s") or 0), int(w.get("date_days") or 0),
                                 vis_sm, float(w.get("qnh_hpa") or 1013.25) * 100.0, temp,
                                 float(w.get("rain") or 0), float(w.get("snow") or 0), 0.0, 0,
                                 *ctype, *ccov, *cbase, *ctops, *alts, *spd, *dirs, *turb, *alts, *temps, *dews)
        s.send(P.PT_WEATHER, payload)
        return True

    def _send_atis(self, now):
        a = self.atis
        s = next(iter(self.atc.values()), None)
        if not a or not s or not s.sid or self.proto < 6:
            return
        key = (a.get("letter"), a.get("text"), a.get("khz"))
        if key != self.atis_sent[0] or now - self.atis_sent[1] > ATIS_EVERY_S:
            self.atis_sent = (key, now)
            s.send(P.PT_ATIS, P.atis(int(a.get("khz") or 0), str(a.get("icao") or self.cfg["icao"] or "ZZZZ"),
                                     str(a.get("letter") or "A"), str(a.get("text") or "")))
            if self.cfg["atis_voice"] and self.caps["encode"] and self.tts and key[1]:
                self._render_atis(a)

    def _render_atis(self, a):
        def work():
            try:
                mgr = self.tts()
                v = mgr.cast("GB", 7, None, [], "controller")
                voice = v["id"] if isinstance(v, dict) else v
                data, mime = mgr.render(voice, str(a.get("text"))[:600], {"rate": 0.95})
                if self.encoder is None:
                    self.encoder = opus_codec.Encoder()
                frames = opus_codec.frames_from_audio(data, mime, self.encoder)
                with self.lock:
                    self.atis_frames = frames
                    if self.atis_session is None:
                        icao = str(a.get("icao") or self.cfg["icao"] or "ZZZZ")
                        self.atis_session = self._new_session(f"{icao}_ATIS", "ATC", "atis", P.LF_ATC)
                    self.atis_session.pos = {"lat": self.center[0], "lon": self.center[1], "alt_m": self.center[2] + 30, "hdg": 0.0,
                                             "gs": 0.0, "on_ground": True, "com1": int(a.get("khz") or 0), "xpdr": P.XPDR_OFF}
            except Exception as e:
                LOG.info("ATIS voice not rendered: %s", e)
        threading.Thread(target=work, daemon=True).start()

    def status(self):
        with self.lock:
            atc = [{"cs": s.callsign, "state": s.state, "msg": s.state_msg, "khz": s.pos["com1"] if s.pos else 0} for s in self.atc.values()]
            ours = self._ours()
            pilots = [v for k, v in self.roster.items() if k not in ours]
            ai_count = len(self.ai_local) if self.proto >= 6 else sum(1 for s in self.ai.values() if s.sid)
            return {"enabled": self.cfg["enabled"], "running": self.running, "error": self.error, "atc": atc, "proto": self.proto,
                    "ai_sessions": (1 if self.injector and self.injector.sid else 0) if self.proto >= 6 else ai_count,
                    "ai_count": ai_count, "pilots": len(pilots),
                    "roster": [{"cs": v[0], "type": v[1], "atc": v[1] == "ATC"} for v in pilots],
                    "atc_list": list(self.atc_list), "fps_count": len(self.fps), "atis": self.atis_sent[0][0] if self.atis_sent[0] else None,
                    "voice": {"server_encode": bool(self.caps["encode"]), "server_decode": bool(self.caps["decode"]),
                              "help": self.caps["help"], "stt": bool(self.stt and self._stt_ok())},
                    "weather": self.cfg["weather"], "weather_in": bool(self.wx_in),
                    "config": {k: v for k, v in self.cfg.items() if k != "password"}}

    def _stt_ok(self):
        try:
            st = self.stt().status()
            return bool(st.get("whisper") or st.get("vosk") or st.get("engine"))
        except Exception:
            return False

    # ---------- network loop ----------
    def _loop(self):
        period = 1.0 / POS_HZ
        next_pos = 0.0
        while self.running:
            try:
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
                for s in self._sessions():
                    if not s.sid and s.state == "connecting" and now - s.login_sent > 3:
                        s.state_msg = f"no answer from {self.cfg['host']}:{self.cfg['port']}"
                        if s.kind == "atc":
                            self.error = s.state_msg
                        s.login()
                if now >= next_pos:
                    next_pos = now + period
                    for s in self.atc.values():
                        s.send_position()
                    if self.atis_session:
                        self.atis_session.send_position()
                    if self.proto >= 6:
                        self._send_ai_traffic(now)
                    else:
                        for cs, s in self.ai.items():
                            self._dead_reckon(s, cs, now)
                            s.send_position()
                    for sid in [k for k, v in self.humans.items() if now - v["_t"] > 5]:
                        del self.humans[sid]
                    if self.cfg["weather"] == "publish" and now - self.wx_sent > WEATHER_EVERY_S and self._send_weather():
                        self.wx_sent = now
                    self._send_atis(now)
                    if self.atis_frames and self.atis_session and self.atis_session.sid and now >= self.atis_next and not self.tx_voice_q:
                        self.tx_voice_q.append(("atis", self.atis_session.pos["com1"], list(self.atis_frames), "ATIS"))
                        self.atis_next = now + len(self.atis_frames) * 0.02 + 3.0
                if self.cfg["transcribe"] and self.stt:
                    self._transcribe_tick(now)

    def _send_ai_traffic(self, now):
        inj = self.injector
        if not inj or not inj.sid:
            return
        entries = []
        for local, cs in list(self.ai_gone.items()):
            entries.append(P.TRAFFIC_ENTRY.pack(local, P.pad(cs, 16), P.pad("ZZZZ", 8), 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
                                                0, 1, 0, P.XPDR_OFF, 0, 0.0, 0.0, P.pad("", 16), 0, 0, P.AI_REMOVE, 0.0))
        self.ai_gone.clear()
        for cs, local in self.ai_local.items():
            last = self.ai_last.get(cs)
            if not last:
                continue
            a, t0 = last
            p = self._reckoned(a, now - t0)
            entries.append(P.TRAFFIC_ENTRY.pack(
                local, P.pad(cs, 16), P.pad(str(a.get("type") or "A320"), 8), p["lat"], p["lon"], p["alt_m"], p["hdg"], 0.0, 0.0,
                p["gs"], 1.0 if p["on_ground"] else 0.0, 0.0, p["lights"], 1 if p["on_ground"] else 0, 0, p["xpdr"],
                int(time.monotonic() * 1000) & 0xFFFFFFFF, p["hdg"], p["vs"], P.pad("", 16), p["squawk"], 1 if p["ident"] else 0, 0,
                # its height above the ground: 0 on it, above the airport in the air (XRadio's radio model)
                0.0 if p["on_ground"] else max(0.0, p["alt_m"] - (self.center[2] if self.center else 0.0))))
        for i in range(0, len(entries), P.MAX_TRAFFIC_ENTRIES):
            chunk = entries[i:i + P.MAX_TRAFFIC_ENTRIES]
            inj.send(P.PT_AI_TRAFFIC, P.TRAFFIC_HDR.pack(len(chunk), 0) + b"".join(chunk))

    def _reckoned(self, a, dt):
        dt = min(2.0, dt)
        gs = a.get("gs_ms", 0.0)
        d = gs * dt / 6371000.0
        h = math.radians(a.get("hdg", 0.0))
        lat = a["lat"] + math.degrees(d * math.cos(h))
        lon = a["lon"] + math.degrees(d * math.sin(h) / max(0.01, math.cos(math.radians(a["lat"]))))
        on_ground = bool(a.get("on_ground"))
        lights = LT_NAV | LT_BEACON | (LT_TAXI if on_ground and gs > 0.5 else 0) | (0 if on_ground else LT_STROBE | LT_LANDING)
        sq = a.get("squawk")
        return {"lat": lat, "lon": lon, "alt_m": a.get("alt_m", 0.0), "hdg": a.get("hdg", 0.0), "gs": gs, "on_ground": on_ground,
                "lights": lights, "squawk": int(sq) if str(sq or "0").isdigit() else 0, "xpdr": XPDR.get(a.get("xpdr", "C"), P.XPDR_ALT),
                "ident": a.get("ident", False), "vs": a.get("vs", 0.0)}

    def _dead_reckon(self, s, cs, now):
        """v5: the per-aircraft session's own position."""
        last = self.ai_last.get(cs)
        if not last:
            return
        a, t0 = last
        p = self._reckoned(a, now - t0)
        com1 = s.pos["com1"] if s.pos else int(a.get("khz") or 0)
        p["com1"] = int(a.get("khz") or com1)
        s.pos = p

    # ---------- packets ----------
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
            LOG.info("XRadio login %s sid=%d (protocol %d)", s.callsign, s.sid, self.proto)
            s.send_position()
            return
        if ptype == P.PT_LOGIN_REJECT:
            reason, _ = P.LOGIN_REJECT.unpack_from(payload, 0)
            if reason == P.RJ_VERSION and self.proto >= 6 and not self.compat_tried:
                # an older server (XRadio 0.5.x): talk v5 -- one session per aircraft, no flight plans or ATIS
                self.compat_tried = True
                LOG.info("XRadio server speaks protocol 5: falling back (no injector, flight plans or ATIS)")
                with self.lock:
                    self.proto = 5
                    for x in self._sessions():
                        self._unregister(x); x.close()
                    self.atc.clear(); self.ai.clear(); self.injector = None; self.ai_local.clear(); self.ai_gone.clear()
                    self.atis_session = None
                return
            msg = ("XRadio server refused the login: wrong or missing flight password" if reason == P.RJ_PASSWORD else
                   f"XRadio server refused the login: protocol version mismatch (TowerTrainer speaks v{P.PROTO_VERSION} and v5; "
                   "update the server or TowerTrainer's xradio/protocol.py)" if reason == P.RJ_VERSION else
                   f"XRadio server refused the login (reason {reason})")
            s.state, s.state_msg = "rejected", msg
            self.error = msg
            self.running = False   # don't hammer the server
            return
        if s.kind not in ("atc",):
            return               # AI / injector / ATIS sessions only transmit; the ATC sessions listen for everyone
        ours = self._ours()
        now = time.monotonic()
        if ptype == P.PT_TRAFFIC:
            count, _ = P.TRAFFIC_HDR.unpack_from(payload, 0)
            off = P.TRAFFIC_HDR.size
            entry = P.TRAFFIC_ENTRY if len(payload) - off >= count * P.TRAFFIC_ENTRY.size else P.TRAFFIC_ENTRY_V5
            for _ in range(count):
                if off + entry.size > len(payload):
                    break
                e = entry.unpack_from(payload, off)
                off += entry.size
                tsid = e[0]
                if tsid in ours or P.is_ai_sid(tsid) and self.injector and P.ai_owner(tsid) == (self.injector.sid & 0x7FFF):
                    continue
                self.humans[tsid] = {"hid": tsid, "cs": P.cstr(e[1]), "type": P.cstr(e[2]), "lat": e[3], "lon": e[4],
                                     "alt_m": e[5], "hdg": e[6], "gs_ms": e[9], "on_ground": bool(e[13]),
                                     "tx": bool(e[14]), "xpdr": e[15], "squawk": f"{e[20]:04d}", "ai": P.is_ai_sid(tsid), "_t": now,
                                     "vs_ms": e[18]}
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
                for sid in [k for k in self.fps if k not in self.roster]:
                    del self.fps[sid]
        elif ptype == P.PT_TEXT:
            freq, from_sid, frm, tlen, to = P.TEXT_HDR.unpack_from(payload, 0)
            if from_sid in ours or (P.is_ai_sid(from_sid) and self.injector and P.ai_owner(from_sid) == (self.injector.sid & 0x7FFF)):
                return
            text = payload[P.TEXT_HDR.size:P.TEXT_HDR.size + tlen].decode("utf-8", "replace")
            self.texts.append({"from": P.cstr(frm), "khz": freq, "text": text, "to": P.cstr(to), "guard": freq == GUARD})
        elif ptype == P.PT_VOICE:
            freq, from_sid, seq, olen = P.VOICE_HDR.unpack_from(payload, 0)
            if from_sid in ours:
                return
            opus = payload[P.VOICE_HDR.size:P.VOICE_HDR.size + olen]
            who = self.roster.get(from_sid, (str(from_sid), ""))[0]
            if self.cfg["voice"]:
                self.voice_q.append({"sid": from_sid, "from": who, "khz": freq, "seq": seq, "opus": base64.b64encode(opus).decode()})
            if self.cfg["transcribe"] and self.stt and self.caps["decode"]:
                try:
                    dec = self.decoders.get(from_sid) or self.decoders.setdefault(from_sid, opus_codec.Decoder())
                    sp = self.speech.get(from_sid) or self.speech.setdefault(from_sid, {"pcm": bytearray(), "last": now, "cs": who, "khz": freq})
                    sp["pcm"] += dec.pcm(opus)
                    sp["last"] = now
                except Exception as e:
                    LOG.debug("decode for transcript: %s", e)
        elif ptype == P.PT_FLIGHTPLAN:
            d = P.unpack_flightplan(payload)
            if d and d["session_id"] and d["session_id"] not in ours:
                d["status"] = {P.FP_FILED: "filed", P.FP_ACK: "ack", P.FP_CLEARED: "cleared", P.FP_CANCELLED: "cancelled"}.get(d["status"], "filed")
                if d["status"] == "cancelled":
                    self.fps.pop(d["session_id"], None)
                else:
                    self.fps[d["session_id"]] = d
                self.events.append({"type": "fp", "cs": d["callsign"], "status": d["status"], "squawk": d["squawk"], "dep": d["dep"], "dest": d["dest"]})
        elif ptype == P.PT_AIRCRAFT:
            d = P.unpack_aircraft(payload)
            if d and sid not in ours:            # the header names the pilot's session
                old = self.aircraft.get(sid)
                self.aircraft[sid] = d
                if not old or old["ac_icao"] != d["ac_icao"]:
                    self.events.append({"type": "aircraft", "hid": sid, "cs": (self.roster.get(sid) or ("",))[0], "ac_icao": d["ac_icao"], "source": d["source"]})
        elif ptype == P.PT_TCAS:
            d = P.unpack_tcas(payload)
            if d and sid not in ours:
                d["_t"] = time.monotonic()
                self.tcas[sid] = d
        elif ptype == P.PT_ATC_LIST:
            count, _flags = P.ATC_LIST_HDR.unpack_from(payload, 0)
            off, lst = P.ATC_LIST_HDR.size, []
            for _ in range(count):
                if off + P.ATC_ENTRY.size > len(payload):
                    break
                e = P.ATC_ENTRY.unpack_from(payload, off)
                off += P.ATC_ENTRY.size
                lst.append({"cs": P.cstr(e[1]), "icao": P.cstr(e[2]), "khz": e[3], "kind": e[4], "mine": e[0] in ours})
            self.atc_list = lst
        elif ptype == P.PT_WEATHER and len(payload) == P.WEATHER.size and self.cfg["weather"] == "follow":
            w = P.WEATHER.unpack_from(payload, 0)
            n_cloud = 4 * P.CLOUD_LAYERS
            base = 10 + n_cloud
            self.wx_in = {"vis_m": w[3] * 1609.34, "qnh_hpa": w[4] / 100.0, "temp_c": w[5], "rain": w[6], "snow": w[7],
                          "wind_dir": w[base + 2 * P.AIR_LAYERS], "wind_kt": w[base + P.AIR_LAYERS] * 1.94384,
                          "clouds": [{"cover": "BKN" if w[10 + P.CLOUD_LAYERS + i] > 0.5 else "SCT" if w[10 + P.CLOUD_LAYERS + i] > 0.2 else "FEW",
                                      "base_ft": w[10 + 2 * P.CLOUD_LAYERS + i] / 0.3048} for i in range(P.CLOUD_LAYERS)
                                     if w[10 + P.CLOUD_LAYERS + i] > 0.05],
                          "zulu_s": w[1], "date_days": w[2], "_t": now}
