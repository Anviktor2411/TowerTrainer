"""Server-side neural text-to-speech for pilot and controller voices.

Engines, tried in a configurable order (default below); each is optional:
  azure      Azure AI Speech (official API, your key + region; free monthly tier). SSML prosody.
  edge       edge-tts (pip install edge-tts) -- free but UNOFFICIAL Microsoft endpoint; may break any time.
  piper      Piper (pip install piper-tts) -- fully offline; voices downloaded into models/piper/.
  kokoro     Kokoro (pip install kokoro soundfile) -- offline, high quality US/UK English.
  elevenlabs ElevenLabs API (your key) -- premium, off unless a key is entered.
The browser's Web Speech voices are the last fallback (client side).

Keys come only from secrets.json (local, git-ignored) or environment variables
(AZURE_SPEECH_KEY / AZURE_SPEECH_REGION / ELEVENLABS_API_KEY) and are never logged.
Rendered audio is cached in cache/tts/<sha1>.<ext>.
"""
import asyncio
import hashlib
import io
import json
import logging
import os
import re
import threading
import time
import urllib.request
import wave
from pathlib import Path

LOG = logging.getLogger("tts")
ROOT = Path(__file__).resolve().parent
DEFAULT_ORDER = ["azure", "edge", "piper", "kokoro", "elevenlabs"]
PIPER_CATALOG_URL = "https://huggingface.co/rhasspy/piper-voices/resolve/main/voices.json"
PIPER_BASE_URL = "https://huggingface.co/rhasspy/piper-voices/resolve/main/"

# nationality -> language of the voice (accent source); native English speakers use their English
ENGLISH_NATIVE = {"GB": "en-GB", "US": "en-US", "IE": "en-IE", "AU": "en-AU", "CA": "en-CA", "ZA": "en-ZA",
                  "NZ": "en-NZ", "SG": "en-SG", "IN": "en-IN"}
NAT_LANG = {"EE": "et-EE", "FI": "fi-FI", "LV": "lv-LV", "LT": "lt-LT", "DE": "de-DE", "AT": "de-AT", "CH": "de-CH",
            "FR": "fr-FR", "BE": "fr-BE", "NL": "nl-NL", "DK": "da-DK", "SE": "sv-SE", "NO": "nb-NO", "PL": "pl-PL",
            "ES": "es-ES", "IT": "it-IT", "PT": "pt-PT", "HU": "hu-HU", "RO": "ro-RO", "TR": "tr-TR", "CZ": "cs-CZ",
            "AE": "ar-AE", "CN": "zh-CN"}
RESPELL_LANGS = {"et", "fi", "lv", "lt", "de"}
# Piper voices whose gender is known (the catalogue does not say)
PIPER_GENDER = {"alan": "M", "alba": "F", "cori": "F", "jenny_dioco": "F", "northern_english_male": "M",
                "southern_english_female": "F", "amy": "F", "bryce": "M", "danny": "M", "hfc_female": "F", "hfc_male": "M",
                "joe": "M", "john": "M", "kathleen": "F", "kristin": "F", "kusal": "M", "lessac": "F", "ljspeech": "F",
                "mike": "M", "norman": "M", "reza_ibrahim": "M", "ryan": "M", "sam": "M", "news": "F", "harri": "M",
                "aivars": "M", "reginute1": "F", "thorsten": "M", "kerstin": "F", "eva_k": "F", "karlsson": "M",
                "ramona": "F", "pavoque": "M", "gilles": "M", "siwis": "F", "tom": "M", "paola": "F", "riccardo": "M",
                "serena": "F", "ronnie": "M", "pim": "M", "alex": "M", "gosia": "F", "darkman": "M", "bass": "M",
                "davefx": "M", "carlfm": "M", "talesyntese": "M", "nst": "M", "lisa": "F", "bryce_x": "M"}


def norm_lang(tag):
    """'et_EE' / 'ET-ee' / 'et' -> 'et-EE' / 'et'."""
    t = str(tag or "").replace("_", "-").strip()
    if not t:
        return ""
    p = t.split("-")
    return p[0].lower() + ("-" + p[1].upper() if len(p) > 1 and p[1] else "")


def lang_match(voice_lang, want):
    v, w = norm_lang(voice_lang), norm_lang(want)
    return v == w or (len(w) == 2 and v.split("-")[0] == w)


# ======================================================================= engines
class Engine:
    name = "base"
    neural = True

    def __init__(self, mgr):
        self.mgr = mgr
        self.down_until = 0.0
        self.last_error = ""

    def available(self):
        return False, "not implemented"

    def voices(self):
        return []

    def render(self, voice, text, prosody):
        raise NotImplementedError

    def usable(self):
        if time.time() < self.down_until:
            return False, f"temporarily disabled after an error: {self.last_error}"
        return self.available()


def _pct(x):
    return f"{'+' if x >= 0 else ''}{int(round(x))}%"


class AzureEngine(Engine):
    name = "azure"

    def creds(self):
        k = self.mgr.secret("azure_key") or os.environ.get("AZURE_SPEECH_KEY", "")
        r = self.mgr.secret("azure_region") or os.environ.get("AZURE_SPEECH_REGION", "")
        return k, r

    def available(self):
        k, r = self.creds()
        return (True, "") if k and r else (False, "no Azure key/region (Settings → Voices or AZURE_SPEECH_KEY)")

    def voices(self):
        k, r = self.creds()
        cache = self.mgr.cache_dir / "azure_voices.json"
        try:
            if cache.is_file() and time.time() - cache.stat().st_mtime < 86400:
                raw = json.loads(cache.read_text("utf-8"))
            else:
                req = urllib.request.Request(f"https://{r}.tts.speech.microsoft.com/cognitiveservices/voices/list",
                                             headers={"Ocp-Apim-Subscription-Key": k})
                raw = json.loads(urllib.request.urlopen(req, timeout=15).read())
                cache.write_text(json.dumps(raw), "utf-8")
        except Exception as e:
            self.last_error = type(e).__name__
            return []
        return [{"id": f"azure:{v['ShortName']}", "engine": "azure", "name": v["ShortName"], "lang": norm_lang(v["Locale"]),
                 "gender": "F" if v.get("Gender") == "Female" else "M", "styles": v.get("StyleList", [])} for v in raw]

    def render(self, voice, text, prosody):
        k, r = self.creds()
        ssml = self.ssml(voice, text, prosody)
        req = urllib.request.Request(f"https://{r}.tts.speech.microsoft.com/cognitiveservices/v1", data=ssml.encode("utf-8"),
                                     headers={"Ocp-Apim-Subscription-Key": k, "Content-Type": "application/ssml+xml",
                                              "X-Microsoft-OutputFormat": "audio-24khz-48kbitrate-mono-mp3",
                                              "User-Agent": "TowerTrainer"})
        return urllib.request.urlopen(req, timeout=20).read(), "audio/mpeg"

    @staticmethod
    def ssml(voice, text, prosody):
        esc = text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        esc = re.sub(r",\s*", ', <break time="120ms"/>', esc)          # short pauses at commas
        lang = voice.get("lang", "en-US")
        body = f'<prosody rate="{_pct((prosody.get("rate", 1) - 1) * 100)}" pitch="{_pct(prosody.get("pitch", 0))}">{esc}</prosody>'
        style = prosody.get("style")
        if style and style in voice.get("styles", []):
            body = f'<mstts:express-as style="{style}">{body}</mstts:express-as>'
        return (f'<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" '
                f'xml:lang="{lang}"><voice name="{voice["name"]}">{body}</voice></speak>')


class EdgeEngine(Engine):
    name = "edge"

    def available(self):
        try:
            import edge_tts  # noqa: F401
            return True, "unofficial endpoint — may stop working"
        except ImportError:
            return False, "pip install edge-tts"

    def voices(self):
        cache = self.mgr.cache_dir / "edge_voices.json"
        try:
            if cache.is_file() and time.time() - cache.stat().st_mtime < 86400:
                raw = json.loads(cache.read_text("utf-8"))
            else:
                import edge_tts
                raw = asyncio.run(edge_tts.list_voices())
                cache.write_text(json.dumps(raw), "utf-8")
        except Exception as e:
            self.last_error = type(e).__name__
            return []
        return [{"id": f"edge:{v['ShortName']}", "engine": "edge", "name": v["ShortName"], "lang": norm_lang(v["Locale"]),
                 "gender": "F" if v.get("Gender") == "Female" else "M"} for v in raw]

    def render(self, voice, text, prosody):
        import edge_tts

        async def go():
            c = edge_tts.Communicate(text, voice["name"], rate=_pct((prosody.get("rate", 1) - 1) * 100),
                                     pitch=f"{int(round(prosody.get('pitch', 0) * 1.5)):+d}Hz")
            buf = bytearray()
            async for ch in c.stream():
                if ch["type"] == "audio":
                    buf += ch["data"]
            return bytes(buf)
        data = asyncio.run(go())
        if not data:
            raise RuntimeError("edge-tts returned no audio")
        return data, "audio/mpeg"


class PiperEngine(Engine):
    name = "piper"

    def __init__(self, mgr):
        super().__init__(mgr)
        self.loaded = {}

    @property
    def dir(self):
        return self.mgr.models_dir / "piper"

    def models(self):
        return sorted(self.dir.glob("*.onnx")) if self.dir.is_dir() else []

    def available(self):
        try:
            import piper  # noqa: F401
        except ImportError:
            return False, "pip install piper-tts"
        return (True, "") if self.models() else (False, "no Piper voice downloaded (Settings → Voices)")

    def voices(self):
        out = []
        for m in self.models():
            base = m.name[:-5]                       # en_GB-alan-medium
            parts = base.split("-")
            lang, who = norm_lang(parts[0]), parts[1] if len(parts) > 1 else base
            speakers = 1
            cfg = m.with_suffix(".onnx.json")
            if cfg.is_file():
                try:
                    speakers = int(json.loads(cfg.read_text("utf-8")).get("num_speakers", 1)) or 1
                except (ValueError, OSError):
                    pass
            for s in range(min(speakers, 12)):       # multi-speaker models give several distinct voices
                out.append({"id": f"piper:{base}" + (f"#{s}" if speakers > 1 else ""), "engine": "piper", "name": base,
                            "speaker": s if speakers > 1 else None, "lang": lang, "gender": PIPER_GENDER.get(who, "U")})
        return out

    def render(self, voice, text, prosody):
        from piper import PiperVoice
        path = self.dir / f"{voice['name']}.onnx"
        if voice["name"] not in self.loaded:
            self.loaded[voice["name"]] = PiperVoice.load(path)
        pv = self.loaded[voice["name"]]
        kwargs = {"length_scale": 1.0 / max(0.6, min(1.6, prosody.get("rate", 1.0)))}
        if voice.get("speaker") is not None:
            kwargs["speaker_id"] = voice["speaker"]
        buf = io.BytesIO()
        with wave.open(buf, "wb") as wf:
            try:
                from piper import SynthesisConfig
                pv.synthesize_wav(text, wf, syn_config=SynthesisConfig(**kwargs))
            except ImportError:
                pv.synthesize(text, wf, **kwargs)     # piper-tts < 1.3
        return buf.getvalue(), "audio/wav"


class KokoroEngine(Engine):
    name = "kokoro"
    VOICES = [("af_heart", "en-US", "F"), ("af_bella", "en-US", "F"), ("af_nicole", "en-US", "F"), ("am_michael", "en-US", "M"),
              ("am_fenrir", "en-US", "M"), ("am_puck", "en-US", "M"), ("am_echo", "en-US", "M"), ("bf_emma", "en-GB", "F"),
              ("bf_isabella", "en-GB", "F"), ("bm_george", "en-GB", "M"), ("bm_lewis", "en-GB", "M"), ("bm_fable", "en-GB", "M")]

    def __init__(self, mgr):
        super().__init__(mgr)
        self.pipes = {}

    def available(self):
        try:
            import kokoro  # noqa: F401
            import soundfile  # noqa: F401
            return True, ""
        except ImportError:
            return False, "pip install kokoro soundfile"

    def voices(self):
        return [{"id": f"kokoro:{n}", "engine": "kokoro", "name": n, "lang": l, "gender": g} for n, l, g in self.VOICES]

    def render(self, voice, text, prosody):
        from kokoro import KPipeline
        import numpy as np
        import soundfile as sf
        code = "b" if voice["lang"] == "en-GB" else "a"
        if code not in self.pipes:
            self.pipes[code] = KPipeline(lang_code=code)
        chunks = [a for _, _, a in self.pipes[code](text, voice=voice["name"], speed=prosody.get("rate", 1.0))]
        buf = io.BytesIO()
        sf.write(buf, np.concatenate(chunks), 24000, format="WAV")
        return buf.getvalue(), "audio/wav"


class ElevenLabsEngine(Engine):
    name = "elevenlabs"
    ACCENT_LANG = {"british": "en-GB", "american": "en-US", "irish": "en-IE", "australian": "en-AU", "indian": "en-IN",
                   "german": "de-DE", "swedish": "sv-SE", "finnish": "fi-FI", "polish": "pl-PL", "french": "fr-FR"}

    def key(self):
        return self.mgr.secret("eleven_key") or os.environ.get("ELEVENLABS_API_KEY", "")

    def available(self):
        return (True, "") if self.key() else (False, "no ElevenLabs key (premium, optional)")

    def voices(self):
        try:
            req = urllib.request.Request("https://api.elevenlabs.io/v1/voices", headers={"xi-api-key": self.key()})
            raw = json.loads(urllib.request.urlopen(req, timeout=15).read()).get("voices", [])
        except Exception as e:
            self.last_error = type(e).__name__
            return []
        out = []
        for v in raw:
            lab = v.get("labels", {})
            lang = self.ACCENT_LANG.get(str(lab.get("accent", "")).lower(), "en-US")
            out.append({"id": f"elevenlabs:{v['voice_id']}", "engine": "elevenlabs", "name": v["voice_id"], "label": v.get("name"),
                        "lang": lang, "gender": "F" if lab.get("gender") == "female" else "M"})
        return out

    def render(self, voice, text, prosody):
        body = json.dumps({"text": text, "model_id": "eleven_multilingual_v2",
                           "voice_settings": {"stability": 0.45, "similarity_boost": 0.8, "speed": max(0.7, min(1.2, prosody.get("rate", 1.0)))}})
        req = urllib.request.Request(f"https://api.elevenlabs.io/v1/text-to-speech/{voice['name']}?output_format=mp3_44100_64",
                                     data=body.encode(), headers={"xi-api-key": self.key(), "Content-Type": "application/json"})
        return urllib.request.urlopen(req, timeout=30).read(), "audio/mpeg"


ENGINES = {"azure": AzureEngine, "edge": EdgeEngine, "piper": PiperEngine, "kokoro": KokoroEngine, "elevenlabs": ElevenLabsEngine}


# ======================================================================= manager
class TTSManager:
    def __init__(self, root=ROOT, secrets_path=None, engines=None):
        self.root = Path(root)
        self.cache_dir = self.root / "cache" / "tts"
        self.models_dir = self.root / "models"
        self.secrets_path = Path(secrets_path) if secrets_path else self.root / "secrets.json"
        self.lock = threading.RLock()
        self.cfg = {"order": list(DEFAULT_ORDER), "disabled": []}
        self._secrets = {}
        self.load()
        self.engines = engines if engines is not None else {n: cls(self) for n, cls in ENGINES.items()}
        self._catalog = None
        self._catalog_t = 0
        self.downloads = {}
        self.stats = {"hits": 0, "misses": 0}

    # ---- config / secrets (local file only, never logged) ----
    def load(self):
        try:
            d = json.loads(self.secrets_path.read_text("utf-8"))
            self.cfg.update({k: d[k] for k in ("order", "disabled") if k in d})
            self._secrets = {k: d[k] for k in ("azure_key", "azure_region", "eleven_key") if d.get(k)}
        except (OSError, ValueError):
            pass

    def secret(self, k):
        return self._secrets.get(k, "")

    def configure(self, d):
        with self.lock:
            if isinstance(d.get("order"), list):
                self.cfg["order"] = [e for e in d["order"] if e in ENGINES] or list(DEFAULT_ORDER)
            if isinstance(d.get("disabled"), list):
                self.cfg["disabled"] = [str(x)[:120] for x in d["disabled"]][:500]
            for k in ("azure_key", "azure_region", "eleven_key"):
                if k in d:
                    v = str(d[k] or "").strip()
                    if v:
                        self._secrets[k] = v
                    else:
                        self._secrets.pop(k, None)
            self.secrets_path.write_text(json.dumps({**self.cfg, **self._secrets}, indent=1), "utf-8")
            self._catalog = None
        return self.status()

    def public_config(self):
        return {"order": self.cfg["order"], "disabled": self.cfg["disabled"],
                "azure_key": bool(self.secret("azure_key") or os.environ.get("AZURE_SPEECH_KEY")),
                "azure_region": self.secret("azure_region") or os.environ.get("AZURE_SPEECH_REGION", ""),
                "eleven_key": bool(self.secret("eleven_key") or os.environ.get("ELEVENLABS_API_KEY"))}

    # ---- engines & catalogue ----
    def ordered(self):
        return [self.engines[n] for n in self.cfg["order"] if n in self.engines]

    def status(self):
        out = []
        for e in self.ordered():
            ok, why = e.usable()
            out.append({"name": e.name, "available": ok, "reason": why, "error": e.last_error})
        neural = any(x["available"] for x in out)
        return {"engines": out, "neural": neural, "config": self.public_config(), "cache": self.stats,
                "banner": None if neural else "No neural voice engine — pilots would sound robotic. One-minute setup: "
                          "`pip install piper-tts` and download a voice in Settings → Voices (offline), or enter an Azure "
                          "Speech key (free tier), or `pip install edge-tts` (unofficial)."}

    def catalog(self, refresh=False):
        with self.lock:
            if self._catalog is not None and not refresh and time.time() - self._catalog_t < 600:
                return self._catalog
            vs = []
            for e in self.ordered():
                ok, _ = e.usable()
                if ok:
                    try:
                        vs += e.voices()
                    except Exception as ex:
                        e.last_error = type(ex).__name__
            self._catalog, self._catalog_t = vs, time.time()
            return vs

    # ---- casting ----
    def cast(self, nat, seed=0, gender=None, exclude=(), role="pilot"):
        """Pick a voice for a crew member / controller: own-language voice first (accent), engine order respected,
        no voice that's already on the frequency (exclude), stable for the same seed."""
        disabled = set(self.cfg["disabled"]) | set(exclude or ())
        own = ENGLISH_NATIVE.get(nat) or NAT_LANG.get(nat)
        native_english = nat in ENGLISH_NATIVE
        wants = [own] if own else []
        if not native_english:
            wants.append("en-GB")              # fallback: English voice (no accent)
        wants.append("en")
        cat = [v for v in self.catalog() if v["id"] not in set(self.cfg["disabled"])]
        for want in wants:
            for e in self.ordered():
                cands = sorted([v for v in cat if v["engine"] == e.name and lang_match(v["lang"], want)], key=lambda v: v["id"])
                if not cands:
                    continue
                free = [v for v in cands if v["id"] not in disabled] or cands
                if gender:
                    g = [v for v in free if v["gender"] == gender]
                    free = g or free
                v = dict(free[abs(int(seed)) % len(free)])
                lang2 = norm_lang(v["lang"]).split("-")[0]
                v["native"] = bool(own) and lang_match(v["lang"], own)
                v["respell"] = v["native"] and not native_english and lang2 in RESPELL_LANGS
                v["fallback"] = not v["native"]
                return v
        return None

    # ---- rendering with disk cache ----
    def key(self, voice_id, text, prosody):
        return hashlib.sha1(json.dumps([voice_id, text, prosody], sort_keys=True).encode("utf-8")).hexdigest()

    def find_voice(self, voice_id):
        return next((v for v in self.catalog() if v["id"] == voice_id), None)

    def render(self, voice_id, text, prosody=None):
        """Returns (bytes, mime). Raises LookupError if the voice/engine is not usable."""
        prosody = {k: prosody[k] for k in ("rate", "pitch", "style") if prosody and k in prosody} if prosody else {}
        text = text.strip()[:600]
        h = self.key(voice_id, text, prosody)
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        for ext, mime in (("mp3", "audio/mpeg"), ("wav", "audio/wav")):
            f = self.cache_dir / f"{h}.{ext}"
            if f.is_file():
                self.stats["hits"] += 1
                return f.read_bytes(), mime
        voice = self.find_voice(voice_id)
        engine = self.engines.get(voice_id.split(":", 1)[0])
        if not voice or not engine:
            raise LookupError(f"voice {voice_id} not available")
        ok, why = engine.usable()
        if not ok:
            raise LookupError(why)
        self.stats["misses"] += 1
        try:
            data, mime = engine.render(voice, text, prosody)
        except Exception as e:
            engine.last_error = f"{type(e).__name__}: {str(e)[:120]}"
            engine.down_until = time.time() + 120          # fall back to the next engine for a while
            self._catalog = None
            LOG.warning("TTS engine %s failed: %s", engine.name, type(e).__name__)
            raise LookupError(engine.last_error)
        (self.cache_dir / f"{h}.{'mp3' if mime == 'audio/mpeg' else 'wav'}").write_bytes(data)
        return data, mime

    # ---- Piper voice downloads ----
    def piper_catalog(self):
        cache = self.cache_dir / "piper_voices.json"
        try:
            if cache.is_file() and time.time() - cache.stat().st_mtime < 7 * 86400:
                raw = json.loads(cache.read_text("utf-8"))
            else:
                raw = json.loads(urllib.request.urlopen(PIPER_CATALOG_URL, timeout=20).read())
                self.cache_dir.mkdir(parents=True, exist_ok=True)
                cache.write_text(json.dumps(raw), "utf-8")
        except Exception as e:
            return {"error": f"cannot load the Piper catalogue: {type(e).__name__}", "voices": []}
        want = {"en", "et", "fi", "lv", "lt", "de", "fr", "sv", "nb", "da", "pl", "es", "it", "nl", "tr", "cs", "hu", "ro", "pt"}
        out = []
        have = {m.name[:-5] for m in (self.models_dir / "piper").glob("*.onnx")} if (self.models_dir / "piper").is_dir() else set()
        for name, v in raw.items():
            if name.split("_")[0] not in want:
                continue
            onnx = next((p for p in v.get("files", {}) if p.endswith(".onnx")), None)
            size = v["files"][onnx]["size_bytes"] if onnx else 0
            out.append({"name": name, "lang": norm_lang(name.split("-")[0]), "quality": v.get("quality"), "size_mb": round(size / 1e6),
                        "speakers": v.get("num_speakers", 1), "installed": name in have, "progress": self.downloads.get(name)})
        return {"voices": sorted(out, key=lambda x: x["name"])}

    def piper_download(self, name):
        if not re.fullmatch(r"[a-z]{2}_[A-Z]{2}-[A-Za-z0-9_]+-(x_low|low|medium|high)", name):
            raise ValueError("bad voice name")
        raw = json.loads((self.cache_dir / "piper_voices.json").read_text("utf-8"))
        files = [p for p in raw[name]["files"] if p.endswith((".onnx", ".onnx.json"))]
        dest = self.models_dir / "piper"
        dest.mkdir(parents=True, exist_ok=True)

        def run():
            try:
                for p in files:
                    tmp = dest / (Path(p).name + ".part")
                    with urllib.request.urlopen(PIPER_BASE_URL + p, timeout=60) as r, tmp.open("wb") as fh:
                        total = int(r.headers.get("Content-Length") or 0)
                        done = 0
                        while True:
                            b = r.read(1 << 16)
                            if not b:
                                break
                            fh.write(b)
                            done += len(b)
                            if p.endswith(".onnx") and total:
                                self.downloads[name] = round(100 * done / total)
                    tmp.replace(dest / Path(p).name)
                self.downloads[name] = 100
                self._catalog = None
            except Exception as e:
                self.downloads[name] = f"error: {type(e).__name__}"
        threading.Thread(target=run, daemon=True).start()
        self.downloads[name] = 0
        return {"started": name}

    def kokoro_warmup(self):
        e = self.engines.get("kokoro")
        ok, why = e.available() if e else (False, "missing")
        if not ok:
            return {"error": why}

        def run():
            try:
                e.render({"name": "bm_george", "lang": "en-GB"}, "Radio check", {})
                self.downloads["kokoro"] = 100
            except Exception as ex:
                self.downloads["kokoro"] = f"error: {type(ex).__name__}"
        self.downloads["kokoro"] = 0
        threading.Thread(target=run, daemon=True).start()
        return {"started": "kokoro"}
