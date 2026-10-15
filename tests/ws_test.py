"""WebSocket server and multiplayer relay (ws.py) tests: handshake, framing, host/guest forwarding, chat,
claims, kick/ban, host reconnect. Starts a real http.server with the relay on a free port and talks raw RFC 6455."""
import base64
import hashlib
import http.server
import json
import os
import socket
import struct
import sys
import threading
import time
from urllib.parse import urlparse, parse_qs

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import ws  # noqa: E402

fails = 0


def check(cond, msg):
    global fails
    print(("PASS  " if cond else "FAIL  ") + msg)
    if not cond:
        fails += 1


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        u = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        if u.path == "/ws":
            sock = ws.WebSocket.upgrade(self)
            if sock:
                ws.RELAY.attach(sock, q, self.client_address[0])
            return
        self.send_response(404)
        self.end_headers()


class Server(http.server.ThreadingHTTPServer):
    daemon_threads = True


class Client:
    """A raw WebSocket client: masked frames out, unmasked in."""

    def __init__(self, port, code, role, name, extra=""):
        self.sock = socket.create_connection(("127.0.0.1", port))
        key = base64.b64encode(os.urandom(16)).decode()
        req = (f"GET /ws?code={code}&role={role}&name={name}{extra} HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\n"
               f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n")
        self.sock.sendall(req.encode())
        self.buf = b""
        while b"\r\n\r\n" not in self.buf:
            self.buf += self.sock.recv(4096)
        head, _, self.buf = self.buf.partition(b"\r\n\r\n")
        self.status = head.split(b"\r\n")[0].decode()
        want = base64.b64encode(hashlib.sha1((key + ws.GUID).encode()).digest()).decode()
        self.ok = "101" in self.status and want.encode() in head
        self.sock.settimeout(3)

    def send(self, obj):
        data = json.dumps(obj).encode()
        mask = os.urandom(4)
        n = len(data)
        if n < 126:
            head = bytes([0x81, 0x80 | n])
        elif n < 65536:
            head = bytes([0x81, 0x80 | 126]) + struct.pack("!H", n)
        else:
            head = bytes([0x81, 0x80 | 127]) + struct.pack("!Q", n)
        self.sock.sendall(head + mask + bytes(c ^ mask[i & 3] for i, c in enumerate(data)))

    def ping(self):
        self.sock.sendall(bytes([0x89, 0x80]) + os.urandom(4))

    def _read(self, n):
        while len(self.buf) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise ConnectionError
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def recv(self, timeout=3):
        """Next message as (opcode, text-or-bytes), or None on timeout."""
        self.sock.settimeout(timeout)
        try:
            b1, b2 = self._read(2)
            op, n = b1 & 0x0F, b2 & 0x7F
            if n == 126:
                n = struct.unpack("!H", self._read(2))[0]
            elif n == 127:
                n = struct.unpack("!Q", self._read(8))[0]
            data = self._read(n)
            return op, (data.decode() if op == 1 else data)
        except (socket.timeout, ConnectionError, OSError):
            return None

    def recv_json(self, want=None, timeout=3):
        end = time.time() + timeout
        while time.time() < end:
            m = self.recv(max(0.05, end - time.time()))
            if m is None:
                return None
            if m[0] != 1:
                if m[0] == 10:
                    continue
                return None
            d = json.loads(m[1])
            if want is None or d.get("type") == want:
                return d
        return None

    def close(self):
        try:
            self.sock.close()
        except OSError:
            pass


srv = Server(("127.0.0.1", 0), Handler)
port = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()

print("handshake and framing")
h = Client(port, "TEST01", "host", "viktor")
check(h.ok, "a host upgrades to a WebSocket (101 + correct Sec-WebSocket-Accept)")
w = h.recv_json("welcome")
check(w and w["id"] == "host" and w["code"] == "TEST01", "the host is welcomed into its session")
h.ping()
pong = h.recv(2)
check(pong is not None and pong[0] == 10, "a ping is answered with a pong")
big = {"type": "state", "ac": ["x" * 200] * 400}
h.send(big)
g = Client(port, "TEST01", "guest", "liisa")
check(g.ok, "a guest connects to the same code")
wg = g.recv_json("welcome")
check(wg and wg["id"] != "host" and wg["host"] is True, "the guest is welcomed and sees the host present")
st = g.recv_json("state")
check(st is not None and len(st["ac"]) == 400, "the host's last state (an 80 KB frame) is replayed to a latecomer")
j = h.recv_json("joined")
check(j and j["name"] == "liisa", "the host learns who joined")
gid = wg["id"]

print("forwarding")
g.send({"type": "tx", "text": "FIN321 runway 26 cleared for takeoff", "pos": "TWR"})
m = h.recv_json("tx")
check(m and m["text"].startswith("FIN321") and m["from"] == gid and m["name"] == "liisa", "a guest's transmission reaches the host with its sender")
h.send({"type": "state", "ac": [], "t": "12:00"})
m = g.recv_json("state")
check(m and m["t"] == "12:00", "the host's state reaches the guest")
h.send({"type": "to", "id": gid, "msg": {"type": "radio", "text": "hello"}})
m = g.recv_json("radio")
check(m and m["text"] == "hello", "the host can address one guest")
h.send({"type": "claims", "claims": {gid: "GND"}})
m = g.recv_json("claims")
check(m and m["claims"][gid] == "GND" and any(r["pos"] == "GND" for r in m["roster"]), "claims go out with the roster")
g.send({"type": "chat", "text": "hi all"})
m = h.recv_json("chat")
check(m and m["text"] == "hi all" and m["name"] == "liisa", "chat from a guest reaches the host")
m = g.recv_json("chat")
check(m and m["text"] == "hi all", "and comes back to the guest too")
g.send({"type": "rtc", "to": "host", "sdp": "offer"})
m = h.recv_json("rtc")
check(m and m["sdp"] == "offer" and m["from"] == gid, "WebRTC signalling guest -> host")
h.send({"type": "rtc", "to": gid, "sdp": "answer"})
m = g.recv_json("rtc")
check(m and m["sdp"] == "answer" and m["from"] == "host", "WebRTC signalling host -> guest")

print("lobby, kick and ban")
lst = ws.RELAY.list()
check(any(s["code"] == "TEST01" and s["guests"] == 1 and s["positions"].get("GND") == "liisa" for s in lst), "the session list shows the session, its guests and positions")
h.send({"type": "kick", "id": gid, "reason": "bye"})
m = g.recv_json("kicked")
check(m and m["reason"] == "bye", "a kicked guest is told why")
left = h.recv_json("left")
check(left and left["id"] == gid, "the host learns the guest left")
g2 = Client(port, "TEST01", "guest", "liisa")
wg2 = g2.recv_json("welcome")
check(wg2 is not None, "kicked is not banned: the guest can come back")
h.recv_json("joined")
h.send({"type": "ban", "id": wg2["id"]})
m = g2.recv_json("kicked")
check(m and m["ban"] is True, "a banned guest is told it is a ban")
h.recv_json("left")
g3 = Client(port, "TEST01", "guest", "liisa")
m = g3.recv_json()
check(m and m.get("type") == "error" and "banned" in m["error"], "and cannot come back: " + str(m and m.get("error")))

print("host comes and goes")
h.close()
time.sleep(0.3)
g4 = Client(port, "TEST01", "guest", "mart")
wg4 = g4.recv_json("welcome")
check(wg4 is not None and wg4["host"] is False, "a session whose host dropped still takes guests (host absent)")
h2 = Client(port, "TEST01", "host", "viktor")
h2.recv_json("welcome")
m = g4.recv_json("hostBack")
check(m is not None, "guests are told when the host is back")
n = Client(port, "NOSUCH", "guest", "x")
m = n.recv_json()
check(m and m.get("type") == "error", "joining an unknown code is refused")
for c in (g2, g3, g4, h2, n):
    c.close()

print("HTTP: session codes and the lobby (server.py's handler, same relay)")
import urllib.request
import server as tt_server  # noqa: E402
srv2 = Server(("127.0.0.1", 0), tt_server.Handler)
hport = srv2.server_address[1]
threading.Thread(target=srv2.serve_forever, daemon=True).start()
req = urllib.request.Request(f"http://127.0.0.1:{hport}/api/mp/create", data=json.dumps({"name": "EETN viktor", "public": True}).encode(),
                             headers={"Content-Type": "application/json"}, method="POST")
j = json.loads(urllib.request.urlopen(req, timeout=5).read())
check(len(j.get("code", "")) == 6, "POST /api/mp/create gives a six-character code: " + str(j))
h3 = Client(port, j["code"], "host", "viktor")
check(h3.recv_json("welcome") is not None, "the host attaches to the created code")
lst = json.loads(urllib.request.urlopen(f"http://127.0.0.1:{hport}/api/mp/sessions", timeout=5).read())
check(any(s["code"] == j["code"] and s["name"] == "EETN viktor" for s in lst["sessions"]), "GET /api/mp/sessions lists it")
h3.close()

print(f"\n{fails} FAILED" if fails else "\nALL PASSED")
sys.exit(1 if fails else 0)
