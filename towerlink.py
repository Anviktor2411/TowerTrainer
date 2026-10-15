"""Tower link (Phase H): a TCP door into the multiplayer relay for the X-Plane plugin's Tower mode.

The XRadio plugin connects here (default 127.0.0.1:8781), sends one line
    {"type":"hello","code":"TOWER","name":"X-Plane","pos":"TWR","version":"0.6.0"}
and from then on it is an ordinary guest of that session (ws.py Relay): it receives what the host sends
(state snapshots, claims, radio calls, alerts) as one JSON object per line and sends what a remote controller
sends (claim, tx, strip, ops, chat). The only addition is an "airport" line -- the datum, runways, stands and
stop bars from the cached airport data -- so the plugin can turn the trainer's local metres into latitude and
longitude. Stdlib only; one thread per connection; nothing but JSON text travels.
"""
from __future__ import annotations

import json
import re
import socket
import threading
import time

import ws

ICAO_RE = re.compile(rb'"icao"\s*:\s*"([A-Za-z0-9]{3,7})"')
STATE_RE = re.compile(rb'^\s*\{\s*"type"\s*:\s*"state"')
PROTOCOL = 1


class LineSocket:
    """The slice of ws.WebSocket's interface the relay uses, over newline-separated JSON on a TCP socket."""

    def __init__(self, sock, airport_info=None):
        self.sock = sock
        self.open = True
        self.lock = threading.Lock()
        self.buf = b""
        self.airport_info = airport_info
        self.icao = ""
        self.sent = 0
        self.received = 0
        try:
            self.sock.settimeout(1.0)
        except OSError:
            pass

    def recv_line(self, timeout=None):
        """One line (bytes, without the newline) or None when the peer closed."""
        deadline = time.time() + timeout if timeout else None
        while b"\n" not in self.buf:
            if not self.open:
                return None
            if deadline and time.time() > deadline:
                return None
            try:
                chunk = self.sock.recv(65536)
            except socket.timeout:
                continue
            except OSError:
                return None
            if not chunk:
                return None
            self.buf += chunk
            if len(self.buf) > 4 * 1024 * 1024:
                return None
        line, self.buf = self.buf.split(b"\n", 1)
        self.received += 1
        return line.rstrip(b"\r")

    def recv(self):
        line = self.recv_line()
        if line is None:
            return None
        return ws.OP_TEXT, line

    def send_text(self, s):
        data = s if isinstance(s, bytes) else s.encode("utf-8")
        # a state for a new airport: the plugin gets the airport first (datum, runways, stop bars)
        if self.airport_info and STATE_RE.match(data):
            m = ICAO_RE.search(data[:300])
            if m and m.group(1).decode("ascii", "replace").upper() != self.icao:
                self.icao = m.group(1).decode("ascii", "replace").upper()
                info = None
                try:
                    info = self.airport_info(self.icao)
                except Exception as e:  # noqa: BLE001
                    info = {"type": "airport", "icao": self.icao, "error": str(e)}
                if info:
                    self._write(json.dumps(info, separators=(",", ":")).encode("utf-8"))
        return self._write(data)

    def _write(self, data):
        with self.lock:
            if not self.open:
                return False
            try:
                self.sock.sendall(data + b"\n")
                self.sent += 1
                return True
            except OSError:
                self.open = False
                return False

    def send_json(self, obj):
        return self.send_text(json.dumps(obj, separators=(",", ":")))

    def send_bytes(self, b):
        return True

    def close(self, code=1000):
        self.open = False
        try:
            self.sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        try:
            self.sock.close()
        except OSError:
            pass


def airport_line(apt, osm=None):
    """The "airport" message from a cached airport (aptdat.py output) and its OSM data."""
    rws = []
    for r in apt.get("runways", []):
        ends = [{"name": e["name"], "x": e["pos"][0], "y": e["pos"][1], "displaced": e.get("displaced", 0)} for e in r["ends"]]
        rws.append({"name": "/".join(e["name"] for e in ends), "width": r.get("width", 45), "ends": ends})
    bars = []
    for i, line in enumerate(apt.get("holdLines", [])[:400]):
        if len(line) >= 2:
            bars.append({"id": i, "x": (line[0][0] + line[-1][0]) / 2, "y": (line[0][1] + line[-1][1]) / 2})
    return {"type": "airport", "protocol": PROTOCOL, "icao": apt["icao"], "name": apt.get("name", ""), "lat": apt["lat"], "lon": apt["lon"],
            "elev_ft": apt.get("elevation"), "tower": (osm or {}).get("tower"), "runways": rws, "holdLines": bars,
            "stands": [{"name": s.get("name", ""), "x": s["pos"][0], "y": s["pos"][1], "hdg": s.get("hdg", 0)} for s in apt.get("stands", [])[:300]]}


class TowerLink:
    def __init__(self, bind="127.0.0.1", port=8781, airport_info=None):
        self.bind, self.port, self.airport_info = bind, port, airport_info
        self.clients = {}
        self.lock = threading.Lock()
        self.sock = None

    def start(self):
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        s.bind((self.bind, self.port))
        s.listen(8)
        self.port = s.getsockname()[1]
        self.sock = s
        threading.Thread(target=self._accept, daemon=True, name="towerlink").start()
        return self

    def _accept(self):
        while True:
            try:
                conn, addr = self.sock.accept()
            except OSError:
                return
            threading.Thread(target=self._serve, args=(conn, addr), daemon=True).start()

    def _serve(self, conn, addr):
        ls = LineSocket(conn, self.airport_info)
        key = f"{addr[0]}:{addr[1]}"
        try:
            first = ls.recv_line(timeout=15)
            if not first:
                return
            try:
                hello = json.loads(first.decode("utf-8"))
            except ValueError:
                ls.send_json({"type": "error", "error": "the first line must be a JSON hello"})
                return
            if not isinstance(hello, dict) or hello.get("type") != "hello":
                ls.send_json({"type": "error", "error": "expected {\"type\":\"hello\",...}"})
                return
            q = {"code": str(hello.get("code") or "TOWER").upper(), "role": "guest", "name": str(hello.get("name") or "X-Plane")[:24], "pos": str(hello.get("pos") or "")}
            with self.lock:
                self.clients[key] = {"name": q["name"], "code": q["code"], "version": str(hello.get("version", "")), "since": int(time.time())}
            ls.send_json({"type": "link", "protocol": PROTOCOL, "server": "TowerTrainer"})
            ws.RELAY.attach(ls, q, addr[0])
        finally:
            with self.lock:
                self.clients.pop(key, None)
            ls.close()

    def status(self):
        with self.lock:
            return {"port": self.port, "bind": self.bind, "clients": list(self.clients.values())}

    def stop(self):
        try:
            self.sock.close()
        except OSError:
            pass
