"""WebSocket (RFC 6455) on top of http.server, stdlib only, and the multiplayer relay built on it.

The relay is deliberately dumb: the host's browser runs the simulation and sends state; guests send what they
would have sent over BroadcastChannel in a pop-out window (transmissions, strip moves, selections) plus claims,
chat, coordination requests and WebRTC signalling for the intercom. The host decides everything; the relay only
forwards, enforces kicks/bans and tells everyone who is here.

    ws = WebSocket.upgrade(handler)        # inside an http.server handler's do_GET, after seeing the Upgrade header
    RELAY.attach(ws, query, client_ip)     # runs until the connection closes
"""
import base64
import hashlib
import json
import secrets
import socket
import struct
import threading
import time

GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
OP_CONT, OP_TEXT, OP_BIN, OP_CLOSE, OP_PING, OP_PONG = 0, 1, 2, 8, 9, 10
MAX_FRAME = 4 * 1024 * 1024


def accept_key(key):
    return base64.b64encode(hashlib.sha1((key + GUID).encode()).digest()).decode()


class WebSocket:
    """One server-side connection. recv() blocks (in one-second slices, so a close() from another thread is
    noticed on every platform); send_* may be called from any thread."""

    def __init__(self, handler):
        self.sock = handler.connection
        self.lock = threading.Lock()
        self.open = True
        self.buf = b""
        try:
            self.sock.settimeout(1.0)
        except OSError:
            pass

    @staticmethod
    def wants_upgrade(handler):
        return "websocket" in handler.headers.get("Upgrade", "").lower() and bool(handler.headers.get("Sec-WebSocket-Key"))

    @staticmethod
    def upgrade(handler):
        """Answer the handshake. Returns the WebSocket, or None when the request is not an upgrade."""
        if not WebSocket.wants_upgrade(handler):
            return None
        key = handler.headers["Sec-WebSocket-Key"]
        handler.protocol_version = "HTTP/1.1"       # Firefox refuses a "101 Switching Protocols" announced as HTTP/1.0
        handler.send_response(101)
        handler.send_header("Upgrade", "websocket")
        handler.send_header("Connection", "Upgrade")
        handler.send_header("Sec-WebSocket-Accept", accept_key(key))
        handler.end_headers()
        handler.wfile.flush()
        handler.close_connection = True
        return WebSocket(handler)

    # ---------- frames ----------
    def _read(self, n):
        while len(self.buf) < n:
            try:
                chunk = self.sock.recv(65536)
            except socket.timeout:
                if not self.open:
                    raise ConnectionError("closed")
                continue
            if not chunk:
                raise ConnectionError("closed")
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def recv(self):
        """(opcode, payload) of the next text/binary message; None when the peer closed. Pings are answered."""
        parts, kind = [], None
        while True:
            try:
                b1, b2 = self._read(2)
            except (ConnectionError, OSError, ValueError):
                self.open = False
                return None
            fin, opcode, masked, length = b1 & 0x80, b1 & 0x0F, b2 & 0x80, b2 & 0x7F
            if length == 126:
                length = struct.unpack("!H", self._read(2))[0]
            elif length == 127:
                length = struct.unpack("!Q", self._read(8))[0]
            if length > MAX_FRAME:
                self.close(1009)
                return None
            mask = self._read(4) if masked else None
            data = self._read(length) if length else b""
            if mask:
                data = bytes(c ^ mask[i & 3] for i, c in enumerate(data))
            if opcode == OP_PING:
                self._send(OP_PONG, data)
                continue
            if opcode == OP_PONG:
                continue
            if opcode == OP_CLOSE:
                self.close(1000)
                return None
            if opcode in (OP_TEXT, OP_BIN):
                kind = opcode
                parts = [data]
            elif opcode == OP_CONT:
                parts.append(data)
            else:
                continue
            if fin:
                return kind, b"".join(parts)

    def _send(self, opcode, data):
        header = bytes([0x80 | opcode])
        n = len(data)
        if n < 126:
            header += bytes([n])
        elif n < 65536:
            header += bytes([126]) + struct.pack("!H", n)
        else:
            header += bytes([127]) + struct.pack("!Q", n)
        with self.lock:
            if not self.open:
                return False
            try:
                self.sock.sendall(header + data)
                return True
            except (OSError, ValueError):
                self.open = False
                return False

    def send_text(self, s):
        return self._send(OP_TEXT, s.encode("utf-8") if isinstance(s, str) else s)

    def send_json(self, obj):
        return self.send_text(json.dumps(obj, separators=(",", ":")))

    def send_bytes(self, b):
        return self._send(OP_BIN, b)

    def close(self, code=1000):
        if self.open:
            self._send(OP_CLOSE, struct.pack("!H", code))
        self.open = False
        try:
            self.sock.shutdown(2)
        except OSError:
            pass


# ---------- the multiplayer relay ----------
STATE_MIN_INTERVAL = 0.2        # state from the host is forwarded at most 5 times a second
SESSION_LINGER_S = 120.0        # a session whose host dropped waits this long for the host to come back


def new_code():
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    return "".join(secrets.choice(alphabet) for _ in range(6))


class Peer:
    def __init__(self, ws, pid, name, role, ip):
        self.ws, self.id, self.name, self.role, self.ip = ws, pid, name, role, ip
        self.joined = time.time()
        self.pos = ""            # the position this guest works, as the host last said


class Session:
    def __init__(self, code, name, public):
        self.code, self.name, self.public = code, name, public
        self.host = None
        self.guests = {}         # id -> Peer
        self.banned = set()      # ips and names
        self.created = time.time()
        self.host_left_at = None
        self.last_state = None
        self.last_state_sent = 0.0
        self.lock = threading.RLock()
        self.chat = []           # last 50 lines, for latecomers

    def roster(self):
        return [{"id": g.id, "name": g.name, "role": g.role, "pos": g.pos, "since": int(time.time() - g.joined)}
                for g in self.guests.values()]

    def everyone(self):
        return ([self.host] if self.host else []) + list(self.guests.values())


class Relay:
    def __init__(self):
        self.sessions = {}
        self.lock = threading.RLock()

    # ---------- HTTP side ----------
    def create(self, name="", public=False, host_name=""):
        with self.lock:
            code = new_code()
            while code in self.sessions:
                code = new_code()
            self.sessions[code] = Session(code, name or f"TowerTrainer {code}", bool(public))
            return {"code": code, "name": self.sessions[code].name}

    def list(self):
        with self.lock:
            self._reap()
            return [{"code": s.code, "name": s.name, "public": s.public, "host": bool(s.host and s.host.ws.open),
                     "guests": len(s.guests), "created": int(time.time() - s.created),
                     "positions": {g.pos: g.name for g in s.guests.values() if g.pos}}
                    for s in self.sessions.values() if s.public or True]

    def _reap(self):
        now = time.time()
        for code in [c for c, s in self.sessions.items() if s.host is None and (s.host_left_at or s.created) + SESSION_LINGER_S < now]:
            del self.sessions[code]

    # ---------- WebSocket side ----------
    def attach(self, ws, q, ip):
        """Serve one connection until it closes. q: {code, role: host|guest|spectator|board, name, pos}."""
        code = str(q.get("code", "")).upper()
        role = str(q.get("role", "guest"))
        name = str(q.get("name", "") or ("host" if role == "host" else "guest"))[:24]
        with self.lock:
            self._reap()
            s = self.sessions.get(code)
            if s is None:
                if role == "host":
                    s = self.sessions[code or new_code()] = Session(code or new_code(), str(q.get("sname", "") or "TowerTrainer"), q.get("public") == "1")
                    code = s.code
                else:
                    ws.send_json({"type": "error", "error": "no such session"})
                    ws.close()
                    return
        with s.lock:
            if ip in s.banned or name.lower() in s.banned:
                ws.send_json({"type": "error", "error": "you are banned from this session"})
                ws.close()
                return
            if role == "host":
                if s.host and s.host.ws.open:
                    s.host.ws.send_json({"type": "error", "error": "another host took over this session"})
                    s.host.ws.close()
                peer = s.host = Peer(ws, "host", name, "host", ip)
                s.host_left_at = None
                ws.send_json({"type": "welcome", "code": s.code, "id": "host", "roster": s.roster(), "name": s.name})
                self._broadcast(s, {"type": "hostBack"}, skip="host")
            else:
                pid = secrets.token_hex(3)
                peer = s.guests[pid] = Peer(ws, pid, name, role, ip)
                ws.send_json({"type": "welcome", "code": s.code, "id": pid, "name": s.name, "roster": s.roster(),
                              "host": bool(s.host and s.host.ws.open), "chat": s.chat[-30:]})
                if s.last_state:
                    ws.send_text(s.last_state)
                self._to_host(s, {"type": "joined", "id": pid, "name": name, "role": role})
                self._broadcast(s, {"type": "roster", "roster": s.roster()})
        try:
            self._loop(s, peer)
        finally:
            with s.lock:
                if peer.role == "host":
                    if s.host is peer:
                        s.host = None
                        s.host_left_at = time.time()
                        self._broadcast(s, {"type": "hostLeft"})
                else:
                    s.guests.pop(peer.id, None)
                    self._to_host(s, {"type": "left", "id": peer.id, "name": peer.name, "pos": peer.pos})
                    self._broadcast(s, {"type": "roster", "roster": s.roster()})
            try:
                ws.close()
            except Exception:
                pass

    def _loop(self, s, peer):
        while True:
            msg = peer.ws.recv()
            if msg is None:
                return
            kind, data = msg
            if kind != OP_TEXT:
                continue
            try:
                m = json.loads(data.decode("utf-8"))
            except ValueError:
                continue
            if not isinstance(m, dict):
                continue
            t = m.get("type")
            with s.lock:
                if peer.role == "host":
                    self._from_host(s, peer, m, t, data)
                else:
                    self._from_guest(s, peer, m, t)

    def _from_host(self, s, host, m, t, raw):
        if t == "state":
            # The host already paces its state (about four a second); every one is forwarded, the last one
            # is kept for whoever joins next.
            s.last_state = raw.decode("utf-8")
            s.last_state_sent = time.time()
            for g in list(s.guests.values()):
                g.ws.send_text(raw)
            return
        if t == "to":                                   # a message for one guest
            g = s.guests.get(m.get("id"))
            if g:
                g.ws.send_json(m.get("msg") or {})
            return
        if t in ("kick", "ban"):
            g = s.guests.get(m.get("id"))
            if g:
                if t == "ban":
                    # by address and by name; a loopback address is everybody on this machine, so name only there
                    if g.ip not in ("127.0.0.1", "::1"):
                        s.banned.add(g.ip)
                    s.banned.add(g.name.lower())
                g.ws.send_json({"type": "kicked", "reason": m.get("reason", "removed by the host"), "ban": t == "ban"})
                g.ws.close()
            return
        if t == "claims":                               # who works what, the host's decision
            for g in s.guests.values():
                g.pos = str((m.get("claims") or {}).get(g.id, "") or "")
            self._broadcast(s, {"type": "claims", "claims": m.get("claims") or {}, "roster": s.roster()})
            return
        if t == "chat":
            self._chat(s, host, m)
            return
        if t == "rtc":
            g = s.guests.get(m.get("to"))
            if g:
                g.ws.send_json({**m, "from": "host"})
            return
        # anything else from the host goes to everyone (radio relays, coordination answers, alerts)
        self._broadcast(s, m, skip="host")

    def _from_guest(self, s, g, m, t):
        if t == "chat":
            self._chat(s, g, m)
            return
        if t == "rtc":
            target = s.host if m.get("to") == "host" else s.guests.get(m.get("to"))
            if target:
                target.ws.send_json({**m, "from": g.id, "name": g.name})
            return
        if t == "ping":
            g.ws.send_json({"type": "pong", "t": m.get("t")})
            return
        # everything else is the guest's input for the host: tx, strip, select, claim, coord, fp...
        self._to_host(s, {**m, "from": g.id, "name": g.name, "role": g.role})

    def _chat(self, s, who, m):
        line = {"type": "chat", "from": who.id, "name": who.name, "text": str(m.get("text", ""))[:400], "t": int(time.time())}
        s.chat.append(line)
        s.chat = s.chat[-50:]
        self._broadcast(s, line)

    def _to_host(self, s, m):
        if s.host and s.host.ws.open:
            s.host.ws.send_json(m)

    def _broadcast(self, s, m, skip=None):
        data = json.dumps(m, separators=(",", ":"))
        for p in s.everyone():
            if p.id == skip:
                continue
            p.ws.send_text(data)


RELAY = Relay()
