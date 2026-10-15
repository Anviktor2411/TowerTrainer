"""The tower link (Phase H): the X-Plane plugin's TCP door into the multiplayer relay.
A fake host (raw WebSocket) hosts session TOWER; a TCP client says hello and must get the welcome, the
"airport" line before the first state (datum, runways, stop bars), the states themselves, and its claim /
transmission must reach the host like any remote controller's.
    python tests/towerlink_test.py
"""
import base64
import http.server
import json
import os
import socket
import struct
import sys
import threading
import time
from urllib.parse import parse_qs, urlparse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import towerlink  # noqa: E402
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


class WsClient:
    """A raw WebSocket client (masked frames out, unmasked in)."""

    def __init__(self, port, code, role, name):
        self.sock = socket.create_connection(("127.0.0.1", port))
        key = base64.b64encode(os.urandom(16)).decode()
        self.sock.sendall((f"GET /ws?code={code}&role={role}&name={name} HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                           f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
        self.buf = b""
        while b"\r\n\r\n" not in self.buf:
            self.buf += self.sock.recv(4096)
        self.buf = self.buf.split(b"\r\n\r\n", 1)[1]
        self.sock.settimeout(0.2)

    def send(self, obj):
        data = json.dumps(obj).encode()
        mask = os.urandom(4)
        n = len(data)
        head = bytes([0x81]) + (bytes([0x80 | n]) if n < 126 else bytes([0x80 | 126]) + struct.pack("!H", n) if n < 65536 else bytes([0x80 | 127]) + struct.pack("!Q", n))
        self.sock.sendall(head + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))

    def _read(self, n):
        while len(self.buf) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise ConnectionError
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def recv_json(self, want=None, timeout=3.0):
        end = time.time() + timeout
        while time.time() < end:
            try:
                h = self._read(2)
            except (socket.timeout, ConnectionError):
                continue
            op, n = h[0] & 0x0F, h[1] & 0x7F
            if n == 126:
                n = struct.unpack("!H", self._read(2))[0]
            elif n == 127:
                n = struct.unpack("!Q", self._read(8))[0]
            payload = self._read(n)
            if op != 1:
                continue
            m = json.loads(payload.decode())
            if want is None or m.get("type") == want:
                return m
        return None

    def close(self):
        try:
            self.sock.close()
        except OSError:
            pass


def airport_info(icao):
    return towerlink.airport_line({"icao": icao, "name": "Test " + icao, "lat": 59.413333, "lon": 24.8325, "elevation": 131,
                                  "runways": [{"width": 45, "ends": [{"name": "08", "pos": [-1515.9, 0.08], "displaced": 248}, {"name": "26", "pos": [1965.6, -17.8], "displaced": 0}]}],
                                  "holdLines": [[[300, 100], [300, 140]]], "stands": [{"name": "K1", "pos": [981.6, -325.0], "hdg": 180}]},
                                 {"tower": [600.0, -250.0]})


srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
srv.daemon_threads = True
port = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()
link = towerlink.TowerLink("127.0.0.1", 0, airport_info).start()
check(link.port > 0, f"tower link listens on a port ({link.port})")

print("hello and the airport line")
host = WsClient(port, "TOWER", "host", "viktor")
check(host.recv_json("welcome") is not None, "the trainer's window hosts session TOWER")
c = socket.create_connection(("127.0.0.1", link.port))
c.settimeout(0.2)
rxbuf = b""
seen = []        # every message type the plugin side received, in order


def say(obj):
    c.sendall((json.dumps(obj) + "\n").encode())


def hear(want=None, timeout=3.0):
    global rxbuf
    end = time.time() + timeout
    while time.time() < end:
        if b"\n" in rxbuf:
            line, rxbuf = rxbuf.split(b"\n", 1)
            m = json.loads(line.decode())
            seen.append(m.get("type"))
            if want is None or m.get("type") == want:
                return m
            continue
        try:
            chunk = c.recv(65536)
        except socket.timeout:
            continue
        if not chunk:
            return None
        rxbuf += chunk
    return None


say({"type": "hello", "code": "TOWER", "name": "X-Plane", "pos": "TWR", "version": "0.6.0"})
m = hear("link")
check(m and m["protocol"] == towerlink.PROTOCOL, "the link answers with its protocol version")
w = hear("welcome")
check(w and w["code"] == "TOWER" and w["id"] and w["host"] is True, "the relay's welcome arrives as a line: " + str(w and w.get("name")))
guest_id = w["id"] if w else ""
j = host.recv_json("joined")
check(j and j["name"] == "X-Plane" and j["role"] == "guest", "the host learns a guest named X-Plane joined")
host.send({"type": "state", "icao": "EETN", "t": "0:10", "ac": [{"id": 1, "cs": "FIN321", "pos": [1900, -40], "alt": 131, "hdg": 260}], "split": True, "logs": {}})
m = hear("airport")
check(m and m["icao"] == "EETN" and abs(m["lat"] - 59.413333) < 1e-6 and m["runways"][0]["name"] == "08/26" and m["tower"] == [600.0, -250.0] and len(m["holdLines"]) == 1 and m["stands"][0]["name"] == "K1",
      "the airport line comes before the first state: datum, runway 08/26, OSM tower, stop bars, stands")
m = hear("state")
check(m and m["icao"] == "EETN" and m["ac"][0]["cs"] == "FIN321", "the state follows as a line")
host.send({"type": "state", "icao": "EETN", "t": "0:11", "ac": [], "split": True, "logs": {}})
m = hear("state", 3.0)
check(m and m["t"] == "0:11" and seen.count("airport") == 1, "the same airport again: no second airport line, just the state (" + ",".join(str(x) for x in seen) + ")")
host.send({"type": "state", "icao": "EGSS", "t": "0:12", "ac": [], "split": True, "logs": {}})
m = hear("airport")
check(m and m["icao"] == "EGSS", "a new airport in the state brings a new airport line")

print("the plugin acts like a remote controller")
say({"type": "claim", "pos": "TWR"})
m = host.recv_json("claim")
check(m and m["pos"] == "TWR" and m["from"] == guest_id and m["name"] == "X-Plane", "a claim reaches the host with the guest's id and name")
host.send({"type": "claims", "claims": {guest_id: "TWR"}})
m = hear("claims")
check(m and m["claims"].get(guest_id) == "TWR", "the host's claims come back")
say({"type": "tx", "pos": "TWR", "text": "FIN321 runway 26 cleared for takeoff"})
m = host.recv_json("tx")
check(m and m["text"].startswith("FIN321") and m["role"] == "guest", "a transmission reaches the host")
say({"type": "ops", "what": "lvp", "value": True})
m = host.recv_json("ops")
check(m and m["what"] == "lvp" and m["value"] is True, "an ops request (LVP) reaches the host")
host.send({"type": "to", "id": guest_id, "msg": {"type": "alert", "msg": "hello tower"}})
m = hear("alert")
check(m and m["msg"] == "hello tower", "a private message from the host arrives")
host.send({"type": "radio", "m": {"from": "atc", "text": "FIN321 line up", "pos": "TWR"}})
m = hear("radio")
check(m and m["m"]["text"] == "FIN321 line up", "relayed radio calls arrive")
say({"type": "ping", "t": 5})
m = hear("pong")
check(m and m["t"] == 5, "ping / pong")
st = link.status()
check(st["clients"] and st["clients"][0]["name"] == "X-Plane" and st["clients"][0]["version"] == "0.6.0", "status lists the plugin")

print("bad hellos and leaving")
c2 = socket.create_connection(("127.0.0.1", link.port)); c2.settimeout(3)
c2.sendall(b"not json\n")
line = c2.makefile("rb").readline()
check(line and b"error" in line, "a non-JSON first line is answered with an error and closed")
c2.close()
c3 = socket.create_connection(("127.0.0.1", link.port)); c3.settimeout(3)
c3.sendall(json.dumps({"type": "hello", "code": "NOPE"}).encode() + b"\n")
f3 = c3.makefile("rb")
lines = [f3.readline() for _ in range(2)]
check(any(b"no such session" in l for l in lines), "an unknown session code is refused with the relay's error")
c3.close()
c.close()
m = host.recv_json("left")
check(m and m["name"] == "X-Plane", "closing the TCP connection tells the host the guest left")
time.sleep(0.3)
check(not link.status()["clients"], "status no longer lists it")
host.close()
srv.shutdown()
link.stop()
print(f"\n{fails} FAILED" if fails else "\nALL PASSED")
sys.exit(1 if fails else 0)
