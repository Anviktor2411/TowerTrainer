"""Tower Trainer local server.

  python server.py [--port 8780]

Serves web/ and:
  /api/airport/<ICAO>  -> parsed layout (downloaded from the X-Plane Scenery Gateway, cached in cache/)
  /api/metar/<ICAO>    -> latest METAR from aviationweather.gov (cached 10 min)
  /api/es/sync         -> POST: browser state <-> EuroScope (legacy FSD server, fsd.py, TCP 6809)
  /api/xradio/*        -> optional XRadio bridge (xradio_bridge.py): config, sync, voice, events (SSE)
"""
import argparse
import base64
import io
import json
import mimetypes
import re
import time
import urllib.error
import urllib.request
import zipfile
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from socketserver import ThreadingMixIn

import aptdat
import fsd

FSD = None       # fsd.FSDServer
XR = None        # xradio_bridge.XRadioBridge (created on first use)

ROOT = Path(__file__).resolve().parent
WEB = ROOT / "web"
CACHE = ROOT / "cache"
GATEWAY = "https://gateway.x-plane.com/apiv1"
UA = {"User-Agent": "TowerTrainer/0.1 (personal ATC practice tool)"}
_metar_cache = {}


def http_json(url, timeout=30):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def find_dat(zbytes, icao):
    """Return apt.dat text from a gateway zip (may contain nested zips)."""
    with zipfile.ZipFile(io.BytesIO(zbytes)) as z:
        names = z.namelist()
        for n in names:
            if n.lower().endswith(".dat") and icao.lower() in n.lower():
                return z.read(n).decode("utf-8", "replace")
        for n in names:
            if n.lower().endswith("apt.dat") or n.lower().endswith(".dat"):
                return z.read(n).decode("utf-8", "replace")
        for n in names:
            if n.lower().endswith(".zip"):
                t = find_dat(z.read(n), icao)
                if t:
                    return t
    return None


def load_airport(icao):
    icao = icao.upper()
    CACHE.mkdir(exist_ok=True)
    cached = CACHE / f"{icao}.json"
    if cached.exists():
        return json.loads(cached.read_text("utf-8"))
    info = http_json(f"{GATEWAY}/airport/{icao}")["airport"]
    sid = info.get("recommendedSceneryId")
    if not sid:
        raise LookupError(f"{icao}: no recommended scenery on the Gateway")
    sc = http_json(f"{GATEWAY}/scenery/{sid}", timeout=60)["scenery"]
    text = find_dat(base64.b64decode(sc["masterZipBlob"]), icao)
    if not text:
        raise LookupError(f"{icao}: no apt.dat in Gateway scenery {sid}")
    (CACHE / f"{icao}.dat").write_text(text, "utf-8")
    data = aptdat.parse(text)
    data["source"] = {"gatewaySceneryId": sid, "author": sc.get("userName")}
    cached.write_text(json.dumps(data, separators=(",", ":")), "utf-8")
    return data


def load_metar(icao):
    icao = icao.upper()
    hit = _metar_cache.get(icao)
    if hit and time.time() - hit[0] < 600:
        return hit[1]
    data = http_json(f"https://aviationweather.gov/api/data/metar?ids={icao}&format=json", timeout=15)
    m = data[0] if data else None
    _metar_cache[icao] = (time.time(), m)
    return m


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def send(self, code, body, ctype="application/json"):
        if isinstance(body, (dict, list)) or body is None:
            body = json.dumps(body).encode()
        elif isinstance(body, str):
            body = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n > 2_000_000:
            raise ValueError("request too large")
        return json.loads(self.rfile.read(n) or b"{}")

    def do_POST(self):
        path = self.path.split("?")[0]
        try:
            body = self.read_json()
            if path == "/api/es/sync":
                if not FSD:
                    return self.send(200, {"messages": [], "status": None})
                msgs = FSD.sync(body.get("aircraft", []), body.get("tx", []))
                return self.send(200, {"messages": msgs, "status": FSD.status()})
            if path == "/api/xradio/config":
                return self.send(200, xradio().configure(body))
            if path == "/api/xradio/sync":
                return self.send(200, xradio().sync(body))
            if path == "/api/xradio/voice":
                return self.send(200, {"ok": xradio().send_voice(body.get("khz", 0), body.get("frames", []))})
            return self.send(404, {"error": "unknown endpoint"})
        except Exception as e:
            return self.send(500, {"error": f"{type(e).__name__}: {e}"})

    def sse_voice(self):
        """Server-sent events: XRadio voice frames for the browser (WebCodecs Opus decoder)."""
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            while True:
                frames = XR.take_voice() if XR else []
                if frames:
                    self.wfile.write(b"data: " + json.dumps(frames).encode() + b"\n\n")
                else:
                    self.wfile.write(b": keepalive\n\n")
                self.wfile.flush()
                time.sleep(0.04 if frames else 0.25)
        except OSError:
            return

    def do_GET(self):
        path = self.path.split("?")[0]
        try:
            if path == "/api/es/status":
                return self.send(200, FSD.status() if FSD else None)
            if path == "/api/xradio/status":
                return self.send(200, xradio().status())
            if path == "/api/xradio/events":
                return self.sse_voice()
            m = re.fullmatch(r"/api/airport/([A-Za-z0-9]{3,7})", path)
            if m:
                return self.send(200, load_airport(m.group(1)))
            m = re.fullmatch(r"/api/metar/([A-Za-z0-9]{3,7})", path)
            if m:
                try:
                    return self.send(200, load_metar(m.group(1)))
                except Exception:
                    return self.send(200, None)
        except LookupError as e:
            return self.send(404, {"error": str(e)})
        except urllib.error.HTTPError as e:
            return self.send(404 if e.code == 404 else 502, {"error": f"Gateway: HTTP {e.code}"})
        except Exception as e:
            return self.send(500, {"error": f"{type(e).__name__}: {e}"})

        rel = "index.html" if path == "/" else path.lstrip("/")
        f = (WEB / rel).resolve()
        if WEB not in f.parents or not f.is_file():
            return self.send(404, "not found", "text/plain")
        ctype = mimetypes.guess_type(str(f))[0] or "application/octet-stream"
        if f.suffix == ".js":
            ctype = "text/javascript"
        self.send(200, f.read_bytes(), ctype)


class Server(ThreadingMixIn, HTTPServer):
    daemon_threads = True


def xradio():
    """The XRadio bridge, created on first use (the feature is optional and off by default)."""
    global XR
    if XR is None:
        import xradio_bridge
        XR = xradio_bridge.XRadioBridge()
    return XR


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8780)
    ap.add_argument("--fsd-port", type=int, default=6809, help="EuroScope (legacy FSD) port, 0 = off")
    ap.add_argument("--fsd-host", default="127.0.0.1", help="FSD bind address (127.0.0.1 = this PC only)")
    ap.add_argument("--xradio", default="", help="host:port of an XRadio server to bridge to (off by default)")
    ap.add_argument("--xradio-password", default="")
    ap.add_argument("--xradio-callsign", default="", help="ATC login callsign, e.g. EETN_TWR")
    a = ap.parse_args()
    if a.fsd_port:
        try:
            FSD = fsd.FSDServer(a.fsd_host, a.fsd_port, metar=load_metar).start()
            print(f"EuroScope / FSD: {a.fsd_host}:{FSD.port}")
        except OSError as e:
            print(f"FSD server not started ({e}); EuroScope bridge disabled")
    if a.xradio:
        host, _, port = a.xradio.rpartition(":")
        xradio().configure({"enabled": True, "host": host or a.xradio, "port": int(port or 49100),
                            "password": a.xradio_password, "atc_cs": a.xradio_callsign})
        print(f"XRadio bridge -> {a.xradio}")
    print(f"Tower Trainer: http://localhost:{a.port}")
    Server(("127.0.0.1", a.port), Handler).serve_forever()
