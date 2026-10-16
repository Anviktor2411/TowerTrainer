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
import socket
import time
import urllib.error
import urllib.request
import zipfile
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from socketserver import ThreadingMixIn

import aptdat
import fsd
import navdata
import navdb
import vfrpoints
import setup as setupwiz
import towerlink
import simbrief
import openflights
import osm
import ws
from urllib.parse import parse_qs, urlparse

FSD = None       # fsd.FSDServer
TOWER = None     # towerlink.TowerLink (X-Plane Tower mode)
SB = None        # simbrief.Store (created below, after CACHE)
TTS = None       # tts.TTSManager (created on first use)
STT = None       # stt.STTManager (created on first use)
_rate = {}       # ip -> [window start, count] for TTS/STT requests from remote players


def tts():
    global TTS
    if TTS is None:
        import tts as _tts
        TTS = _tts.TTSManager()
    return TTS


def stt():
    global STT
    if STT is None:
        import stt as _stt
        STT = _stt.STTManager()
    return STT


def rate_ok(ip, per_10s=40):
    if ip in ("127.0.0.1", "::1"):
        return True
    w = _rate.setdefault(ip, [time.time(), 0])
    if time.time() - w[0] > 10:
        w[0], w[1] = time.time(), 0
    w[1] += 1
    return w[1] <= per_10s
XR = None        # xradio_bridge.XRadioBridge (created on first use)

ROOT = Path(__file__).resolve().parent
WEB = ROOT / "web"
CACHE = ROOT / "cache"
GATEWAY = "https://gateway.x-plane.com/apiv1"
UA = {"User-Agent": "TowerTrainer/0.1 (personal ATC practice tool)"}
_metar_cache = {}
NAV_SETTINGS = CACHE / "nav_settings.json"   # X-Plane choice, data mode, sector package, OpenAIP key (never committed)


def nav_settings():
    try:
        return {"xplane": "", "mode": "auto", "custom": "", "sector": "", **json.loads(NAV_SETTINGS.read_text("utf-8"))}
    except (OSError, ValueError):
        return {"xplane": "", "mode": "auto", "custom": "", "sector": ""}


def navdb_():
    """The indexed nav database (navdb.py), built in the background on first use."""
    s = nav_settings()
    return navdb.get(CACHE, {k: s.get(k, "") for k in ("xplane", "mode", "custom", "sector")})


def _ll(q):
    try:
        return float(q.get("lat")), float(q.get("lon"))
    except (TypeError, ValueError):
        return None, None


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
    dat = CACHE / f"{icao}.dat"
    if cached.exists():
        data = json.loads(cached.read_text("utf-8"))
        if data.get("v") == aptdat.VERSION or not dat.exists():
            return data
        # parser changed since this airport was cached: re-parse the kept apt.dat
        src = data.get("source")
        data = aptdat.parse(dat.read_text("utf-8", "replace"))
        if src:
            data["source"] = src
        cached.write_text(json.dumps(data, separators=(",", ":")), "utf-8")
        return data
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
            if path.startswith("/api/setup/"):
                return self.setup_post(path, body)
            if path.startswith("/api/nav/") or path.startswith("/api/vfr/"):
                return self.nav_post(path, body)
            if path == "/api/simbrief/import":          # an OFP JSON the pilot downloaded by hand
                if not self.is_local():
                    return self.send(403, {"error": "local only"})
                try:
                    return self.send(200, {"plan": sb().save("import", body)})
                except (RuntimeError, ValueError) as e:
                    return self.send(400, {"error": f"not a SimBrief OFP: {e}"})
            if path == "/api/simbrief/plan":            # the official API form flow, needs the pilot's own API key
                if not self.is_local():
                    return self.send(403, {"error": "local only"})
                try:
                    return self.send(200, {"url": simbrief.api_form_url(body.get("params") or {}, str(body.get("api_key", "")), f"http://localhost:{PORT}/")})
                except ValueError as e:
                    return self.send(400, {"error": str(e)})
            if path == "/api/stt":
                if not rate_ok(self.client_address[0], 20):
                    return self.send(429, {"error": "too many requests"})
                import stt as _stt
                wav, phrases = _stt.decode_request(body)
                try:
                    return self.send(200, stt().transcribe(wav, phrases, body.get("engine", "auto")))
                except LookupError as e:
                    return self.send(503, {"error": str(e)})
            if path in ("/api/stt/vosk/download", "/api/stt/whisper/warmup"):
                if not self.is_local():
                    return self.send(403, {"error": "local only"})
                return self.send(200, stt().download_vosk() if "vosk" in path else stt().warm_whisper())
            if path.startswith("/api/tts/"):
                return self.tts_post(path, body)
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
            if path == "/api/xradio/voice_pcm":     # a browser without WebCodecs: PCM in, Opus made here
                return self.send(200, {"ok": xradio().send_voice_pcm(body.get("khz", 0), body.get("pcm", ""))})
            if path == "/api/xradio/fp":            # the controller answers a real pilot's flight plan
                return self.send(200, {"ok": xradio().fp_ack(body)})
            if path == "/api/mp/create":            # a multiplayer session code for this host
                return self.send(200, ws.RELAY.create(str(body.get("name", ""))[:40], bool(body.get("public"))))
            return self.send(404, {"error": "unknown endpoint"})
        except Exception as e:
            return self.send(500, {"error": f"{type(e).__name__}: {e}"})

    def setup_post(self, path, body):
        """Setup wizard actions (G6): every one takes dry_run and only touches folders the page showed first."""
        if not self.is_local():
            return self.send(403, {"error": "the setup wizard is only available on this PC"})
        dry = bool(body.get("dry_run"))
        a = path[len("/api/setup/"):]
        if a == "upload":                                   # a sector package the user chose in the browser
            name = re.sub(r"\.{2,}", ".", re.sub(r"[^A-Za-z0-9_.-]+", "_", str(body.get("name", "package.zip")))).lstrip("._")[:80] or "package.zip"
            data = base64.b64decode(body.get("data", ""))
            if len(data) > 400 * 1024 * 1024:
                return self.send(413, {"error": "too large"})
            up = CACHE / "setup-upload"
            up.mkdir(parents=True, exist_ok=True)
            p = up / name
            p.write_bytes(data)
            return self.send(200, {"ok": True, "path": str(p), "bytes": len(data)})
        if a == "pip":
            return self.send(200, setupwiz.pip_install(str(body.get("name", "")), dry))
        if a == "unpack":
            return self.send(200, setupwiz.unpack_sector_package(str(body.get("zip", "")), str(body.get("docs", "")), str(body.get("name", "")), bool(body.get("overwrite")), dry))
        if a == "generate":
            return self.send(200, setupwiz.generate_sector(str(body.get("icao", "")), str(body.get("docs", "")), CACHE, str(body.get("callsign", "")), bool(body.get("overwrite")), dry))
        if a == "shortcut":
            return self.send(200, setupwiz.desktop_shortcut(str(body.get("target", "")), str(body.get("label", "TowerTrainer"))[:60], str(body.get("args", "")), dry))
        if a == "xradio_latest":
            return self.send(200, setupwiz.xradio_latest())
        if a == "xradio_install":
            return self.send(200, setupwiz.install_xradio(str(body.get("xplane", "")), str(body.get("source", "")), str(body.get("tag", "")), body.get("backup", True), dry))
        if a == "xradio_settings":
            return self.send(200, setupwiz.xradio_settings(str(body.get("xplane", "")), body.get("values") or {}, dry))
        if a == "xplane_info":
            return self.send(200, setupwiz.xplane_folder_info(str(body.get("path", ""))))
        if a == "tests":                                    # what the server can check itself; the microphone is tested in the page
            out = {}
            try:
                out["voices"] = tts().status()
            except Exception as e:  # noqa: BLE001
                out["voices"] = {"error": str(e)}
            try:
                out["euroscope"] = {"running": FSD is not None, "port": getattr(FSD, "port", None), **(FSD.status() if FSD is not None and hasattr(FSD, "status") else {})}
            except Exception as e:  # noqa: BLE001
                out["euroscope"] = {"running": FSD is not None, "error": str(e)}
            try:
                out["xradio"] = xradio().status()
            except Exception as e:  # noqa: BLE001
                out["xradio"] = {"error": str(e)}
            try:
                out["stt"] = stt().status()
            except Exception as e:  # noqa: BLE001
                out["stt"] = {"error": str(e)}
            return self.send(200, out)
        return self.send(404, {"error": "unknown setup action"})

    def tts_post(self, path, body):
        local = self.is_local()
        if path == "/api/tts/cast":
            v = tts().cast(str(body.get("nat", "GB"))[:3], int(body.get("seed", 0) or 0), body.get("gender"),
                           [str(x) for x in (body.get("exclude") or [])][:50], body.get("role", "pilot"))
            return self.send(200, {"voice": v})
        if path == "/api/tts/speak":
            if not rate_ok(self.client_address[0]):
                return self.send(429, {"error": "too many requests"})
            try:
                data, mime = tts().render(str(body.get("voice", "")), str(body.get("text", ""))[:600], body.get("prosody") or {})
            except LookupError as e:
                return self.send(503, {"error": str(e), "fallback": True})
            return self.send(200, data, mime)
        if not local:
            return self.send(403, {"error": "voice settings are only available on the host PC"})
        if path == "/api/tts/config":
            return self.send(200, tts().configure(body))
        if path == "/api/tts/piper/download":
            return self.send(200, tts().piper_download(str(body.get("name", ""))))
        if path == "/api/tts/kokoro/warmup":
            return self.send(200, tts().kokoro_warmup())
        return self.send(404, {"error": "unknown endpoint"})

    def sse_voice(self, pcm=False):
        """Server-sent events: XRadio voice frames for the browser (WebCodecs Opus decoder), or -- with
        ?pcm=1 for a browser without WebCodecs -- decoded here to 16-bit 48 kHz PCM (needs av / opuslib)."""
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            while True:
                frames = XR.take_voice(pcm=pcm) if XR else []
                if frames:
                    self.wfile.write(b"data: " + json.dumps(frames).encode() + b"\n\n")
                else:
                    self.wfile.write(b": keepalive\n\n")
                self.wfile.flush()
                time.sleep(0.04 if frames else 0.25)
        except OSError:
            return

    def is_local(self):
        return self.client_address[0] in ("127.0.0.1", "::1")

    def nav_get(self, path, q):
        """F2/F3: nav database status, search, details, map layers, speech vocabulary; B2: VFR points."""
        lat, lon = _ll(q)
        near = (lat, lon) if lat is not None else None
        db = navdb_()
        if path == "/api/nav/status":
            return self.send(200, {**db.status(), "settings": {k: v for k, v in nav_settings().items() if k != "openaip_key"},
                                   "openaip": bool(nav_settings().get("openaip_key"))})
        if path == "/api/nav/search":
            return self.send(200, db.search(q.get("q", ""), lat, lon, int(q.get("limit", 20))))
        if path == "/api/nav/nearest":
            return self.send(200, db.nearest_airports(lat, lon, int(q.get("n", 10))) if near else [])
        if path == "/api/nav/item":
            return self.send(200, db.item(q.get("kind", ""), q.get("id", ""), near))
        if path == "/api/nav/area":
            return self.send(200, db.area(lat, lon, float(q.get("r", 60))) if near else {})
        if path == "/api/nav/vocab":
            return self.send(200, db.vocab(lat, lon, float(q.get("r", 120)), q.get("icao", "")) if near else [])
        m = re.fullmatch(r"/api/vfr/([A-Za-z0-9]{3,7})", path)
        if m:
            apt = load_airport(m.group(1))
            s = nav_settings()
            return self.send(200, vfrpoints.load(m.group(1), apt["lat"], apt["lon"], ROOT, CACHE, s.get("sector", ""), s.get("openaip_key", "")))
        return self.send(404, {"error": "unknown nav request"})

    def nav_post(self, path, body):
        if not self.is_local():
            return self.send(403, {"error": "nav data is only available on the host PC"})
        if path == "/api/nav/reload":                 # "Reload nav data": detect installs again, rebuild when anything changed
            db = navdb_()
            db.start(force=bool(body.get("force")))
            return self.send(200, db.status())
        if path == "/api/nav/settings":
            s = nav_settings()
            for k in ("xplane", "mode", "custom", "sector", "openaip_key"):
                if k in body:
                    s[k] = str(body[k] or "").strip()
            CACHE.mkdir(exist_ok=True)
            NAV_SETTINGS.write_text(json.dumps(s), "utf-8")
            return self.send(200, navdb_().status())
        if path == "/api/nav/route":
            return self.send(200, navdb_().validate_route(str(body.get("route", "")), body.get("dep"), body.get("dest")))
        m = re.fullmatch(r"/api/vfr/([A-Za-z0-9]{3,7})", path)
        if m:
            pts = vfrpoints.save_user(ROOT, m.group(1), body.get("points", []))
            return self.send(200, {"source": "user", "points": pts, "label": "VFR points: user file"})
        return self.send(404, {"error": "unknown nav request"})

    def do_GET(self):
        path = self.path.split("?")[0]
        q = {k: v[0] for k, v in parse_qs(urlparse(self.path).query).items()}
        try:
            m = re.fullmatch(r"/api/procedures/([A-Za-z0-9]{3,7})", path)
            if m:
                # reads local X-Plane / Navigraph / sector files: only for this PC, never for remote players
                if not self.is_local():
                    return self.send(403, {"error": "procedures are only available on the host PC"})
                apt = load_airport(m.group(1))
                s = nav_settings()
                return self.send(200, navdata.load_procedures(
                    m.group(1), apt["lat"], apt["lon"], CACHE, xplane=q.get("xplane", s["xplane"]), mode=q.get("mode", s["mode"]),
                    custom=q.get("custom", s["custom"]), sector=q.get("sector", s["sector"]), use_cache=q.get("refresh") != "1"))
            if path == "/api/setup/status":             # the setup wizard (G6): detection only, local PC only
                if not self.is_local():
                    return self.send(403, {"error": "the setup wizard is only available on this PC"})
                return self.send(200, setupwiz.status(q.get("xplane", ""), q.get("docs", ""), CACHE))
            if path == "/api/setup/log":
                if not self.is_local():
                    return self.send(403, {"error": "local only"})
                try:
                    lines = setupwiz.LOG.read_text("utf-8", "replace").splitlines()[-80:]
                except OSError:
                    lines = []
                return self.send(200, {"log": lines, "path": str(setupwiz.LOG)})
            if path == "/api/navdata":
                if not self.is_local():
                    return self.send(403, {"error": "local only"})
                s = nav_settings()
                return self.send(200, navdata.navdata_info(q.get("xplane", s["xplane"]), q.get("mode", s["mode"]), q.get("custom", s["custom"])))
            if path.startswith("/api/nav/") or path.startswith("/api/vfr/"):
                # local X-Plane / Navigraph / sector data: only for this PC, never for remote players
                if not self.is_local():
                    return self.send(403, {"error": "nav data is only available on the host PC"})
                return self.nav_get(path, q)
            if path == "/api/stt/status":
                return self.send(200, stt().status())
            if path == "/api/tts/status":
                return self.send(200, tts().status())
            if path == "/api/tts/voices":
                return self.send(200, {"voices": tts().catalog(refresh=q.get("refresh") == "1")})
            if path == "/api/tts/piper/catalog":
                return self.send(200, tts().piper_catalog())
            if path == "/api/es/status":
                return self.send(200, FSD.status() if FSD else None)
            if path == "/api/xradio/status":
                return self.send(200, xradio().status())
            if path == "/api/xradio/events":
                return self.sse_voice(pcm=q.get("pcm") == "1")
            if path == "/ws":                       # multiplayer relay / remote strip boards (ws.py)
                sock = ws.WebSocket.upgrade(self)
                if sock is None:
                    return self.send(400, {"error": "expected a WebSocket upgrade"})
                ws.RELAY.attach(sock, q, self.client_address[0])
                return None
            if path == "/api/mp/sessions":
                return self.send(200, {"sessions": ws.RELAY.list(), "lan": lan_address(), "port": PORT})
            if path == "/api/simbrief/latest":          # the pilot's latest OFP: cached, or fetched when asked (local PC only)
                if not self.is_local():
                    return self.send(403, {"error": "SimBrief is only available on the host PC"})
                user = q.get("user", "").strip()
                try:
                    if q.get("refresh") == "1":
                        if not user:
                            return self.send(400, {"error": "SimBrief: enter your username or pilot ID (Settings → SimBrief)"})
                        plan = sb().save(user, simbrief.fetch_latest(user))
                    else:
                        plan = sb().last()
                    return self.send(200, {"plan": plan, "plan_url": simbrief.plan_url()})
                except (RuntimeError, ValueError) as e:
                    return self.send(400, {"error": str(e)})
            if path == "/api/tower/status":             # X-Plane Tower mode link (towerlink.py)
                return self.send(200, {"enabled": TOWER is not None, **(TOWER.status() if TOWER else {})})
            if path == "/api/mp/info":
                return self.send(200, {"lan": lan_address(), "port": PORT, "bind": BIND, "stt": stt().status()})
            m = re.fullmatch(r"/api/airport/([A-Za-z0-9]{3,7})", path)
            if m:
                return self.send(200, load_airport(m.group(1)))
            m = re.fullmatch(r"/api/osm/([A-Za-z0-9]{3,7})", path)
            if m:   # buildings from OpenStreetMap (cached; empty when offline)
                apt = load_airport(m.group(1))
                pts = [s["pos"] for s in apt["stands"]] + [e["pos"] for r in apt["runways"] for e in r["ends"]]
                return self.send(200, osm.load(m.group(1), apt["lat"], apt["lon"], CACHE, refresh=q.get("refresh") == "1", points=pts))
            m = re.fullmatch(r"/api/traffic/([A-Za-z0-9]{3,7})", path)
            if m:   # airlines and destinations that really serve the airport (OpenFlights, cached; empty when offline)
                return self.send(200, openflights.load(m.group(1), CACHE, refresh=q.get("refresh") == "1"))
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

        rel = "index.html" if path == "/" else "setup.html" if path == "/setup" else path.lstrip("/")
        f = (WEB / rel).resolve()
        if WEB not in f.parents or not f.is_file():
            return self.send(404, "not found", "text/plain")
        ctype = mimetypes.guess_type(str(f))[0] or "application/octet-stream"
        if f.suffix == ".js":
            ctype = "text/javascript"
        self.send(200, f.read_bytes(), ctype)


class Server(ThreadingMixIn, HTTPServer):
    daemon_threads = True


PORT = 8780
BIND = "127.0.0.1"


def sb():
    global SB
    if SB is None:
        SB = simbrief.Store(CACHE)
    return SB


def tower_airport(icao):
    """The 'airport' line of the tower link: datum, runways, stop bars, stands and the OSM tower of a cached airport."""
    apt = load_airport(icao)
    osm = None
    p = CACHE / f"{icao}.osm.json"
    if p.exists():
        try:
            osm = json.loads(p.read_text("utf-8"))
        except ValueError:
            osm = None
    return towerlink.airport_line(apt, osm)


def lan_address():
    """This machine's address on the local network, for the join link shown to other controllers."""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except OSError:
        return "127.0.0.1"


def xradio():
    """The XRadio bridge, created on first use (the feature is optional and off by default)."""
    global XR
    if XR is None:
        import xradio_bridge
        XR = xradio_bridge.XRadioBridge(tts=tts, stt=stt)   # the managers, for AI pilot voice and transcripts
    return XR


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8780)
    ap.add_argument("--host", default="127.0.0.1", help="bind address; 0.0.0.0 lets other controllers on the LAN join (multiplayer, phone strip board)")
    ap.add_argument("--fsd-port", type=int, default=6809, help="EuroScope (legacy FSD) port, 0 = off")
    ap.add_argument("--tower-port", type=int, default=8781, help="X-Plane Tower mode link (XRadio plugin), 0 = off; binds the --host address")
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
    PORT, BIND = a.port, a.host
    navdb_()      # F5: the nav index loads (or builds in the background) while the server already answers
    if a.tower_port:
        try:
            TOWER = towerlink.TowerLink(a.host, a.tower_port, tower_airport).start()
            print(f"X-Plane tower link: {a.host}:{TOWER.port}")
        except OSError as e:
            print(f"tower link not started ({e})")
    print(f"Tower Trainer: http://localhost:{a.port}" + (f"  (LAN: http://{lan_address()}:{a.port})" if a.host != "127.0.0.1" else "  (--host 0.0.0.0 to let others join)"))
    Server((a.host, a.port), Handler).serve_forever()
