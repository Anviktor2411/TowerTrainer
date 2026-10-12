"""Offline speech recognition for push-to-talk in browsers without SpeechRecognition (Firefox).

Engines (optional, tried in order):
  whisper  faster-whisper (pip install faster-whisper) -- model downloaded on first use into models/whisper/
  vosk     Vosk (pip install vosk) + a model in models/vosk/ (small English model ~40 MB, download in Settings)
Both are biased towards ATC phraseology: aviation words, the phonetic alphabet, digits and the callsigns
currently on frequency (sent by the browser with each request).
"""
import base64
import io
import os
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
import json
import threading
import time
import urllib.request
import wave
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
VOSK_MODEL_URL = "https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip"
ATC_WORDS = ("runway taxi holding point hold short cross line up and wait cleared for takeoff land go around contact tower "
             "ground delivery radar approach departure control squawk ident climb descend maintain feet flight level heading "
             "via stand gate push start approved facing north south east west continue position negative affirm correction "
             "roger wilco say again information current identified frequency change decimal point left right center "
             "behind expect vacate when ready to the of on monitor good day morning afternoon evening "
             "alpha bravo charlie delta echo foxtrot golf hotel india juliett kilo lima mike november oscar papa quebec "
             "romeo sierra tango uniform victor whiskey x-ray yankee zulu "
             "zero one two three four five six seven eight nine niner tree fife thousand hundred").split()


def wav_to_float(wav_bytes):
    import numpy as np
    w = wave.open(io.BytesIO(wav_bytes))
    if w.getsampwidth() != 2:
        raise ValueError("expected 16-bit PCM WAV")
    a = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").astype("float32") / 32768.0
    if w.getnchannels() > 1:
        a = a.reshape(-1, w.getnchannels()).mean(axis=1)
    rate = w.getframerate()
    if rate != 16000:                      # linear resample to 16 kHz
        n = int(len(a) * 16000 / rate)
        a = np.interp(np.linspace(0, len(a) - 1, n), np.arange(len(a)), a).astype("float32")
    return a


class STTManager:
    def __init__(self, root=ROOT):
        self.root = Path(root)
        self.models = self.root / "models"
        self.whisper_size = "base.en"
        self._whisper = None
        self._vosk = None
        self.lock = threading.Lock()
        self.progress = {}

    # ---- availability ----
    def has_whisper(self):
        try:
            import faster_whisper  # noqa: F401
            return True
        except ImportError:
            return False

    def vosk_model_dir(self):
        d = self.models / "vosk"
        return next((p for p in sorted(d.glob("vosk-model*")) if p.is_dir()), None) if d.is_dir() else None

    def has_vosk(self):
        try:
            import vosk  # noqa: F401
        except ImportError:
            return False
        return self.vosk_model_dir() is not None

    def status(self):
        eng = []
        if self.has_whisper():
            eng.append("whisper")
        if self.has_vosk():
            eng.append("vosk")
        help_ = None if eng else ("No local speech recognition engine. Install one:  pip install faster-whisper  "
                                  "(model ~145 MB downloads on first use)  or  pip install vosk  and download the small "
                                  "English model in Settings → Voices. Typing always works.")
        vosk_pkg = True
        try:
            import vosk  # noqa: F401
        except ImportError:
            vosk_pkg = False
        return {"engines": eng, "whisper_model": self.whisper_size, "vosk_model": self.vosk_model_dir().name if self.vosk_model_dir() else None,
                "vosk_package": vosk_pkg, "help": help_, "progress": self.progress}

    # ---- recognition ----
    def prompt(self, phrases):
        cs = ", ".join(p for p in phrases[:30] if p)
        return f"ATC radio phraseology. Callsigns: {cs}. Runway, taxi via alpha bravo, holding point, squawk, cleared for takeoff, niner."

    def transcribe(self, wav_bytes, phrases=(), engine="auto"):
        audio = wav_to_float(wav_bytes)
        order = [engine] if engine in ("whisper", "vosk") else ["whisper", "vosk"]
        t0 = time.time()
        for e in order:
            if e == "whisper" and self.has_whisper():
                return {"text": self._whisper_run(audio, phrases), "engine": "whisper", "ms": int((time.time() - t0) * 1000)}
            if e == "vosk" and self.has_vosk():
                return {"text": self._vosk_run(audio, phrases), "engine": "vosk", "ms": int((time.time() - t0) * 1000)}
        raise LookupError(self.status()["help"] or "no engine")

    def _whisper_run(self, audio, phrases):
        from faster_whisper import WhisperModel
        with self.lock:
            if self._whisper is None:
                self._whisper = WhisperModel(self.whisper_size, device="cpu", compute_type="int8",
                                             download_root=str(self.models / "whisper"))
            kw = dict(language="en", beam_size=3, vad_filter=False, initial_prompt=self.prompt(phrases), condition_on_previous_text=False)
            try:
                segs, _ = self._whisper.transcribe(audio, hotwords=" ".join(phrases[:20]) or None, **kw)
            except TypeError:                       # older faster-whisper without hotwords
                segs, _ = self._whisper.transcribe(audio, **kw)
            return " ".join(s.text.strip() for s in segs).strip()

    def _vosk_run(self, audio, phrases):
        import numpy as np
        import vosk
        with self.lock:
            if self._vosk is None:
                vosk.SetLogLevel(-1)
                self._vosk = vosk.Model(str(self.vosk_model_dir()))
            words = set(ATC_WORDS)
            for p in phrases:
                words.update(w for w in p.lower().split() if w.isalpha())
            rec = vosk.KaldiRecognizer(self._vosk, 16000, json.dumps(sorted(words) + ["[unk]"]))
            rec.AcceptWaveform((np.clip(audio, -1, 1) * 32767).astype("<i2").tobytes())
            return json.loads(rec.FinalResult()).get("text", "").replace("[unk]", "").strip()

    # ---- model downloads ----
    def download_vosk(self):
        dest = self.models / "vosk"
        dest.mkdir(parents=True, exist_ok=True)

        def run():
            try:
                buf = io.BytesIO()
                with urllib.request.urlopen(VOSK_MODEL_URL, timeout=60) as r:
                    total = int(r.headers.get("Content-Length") or 0)
                    while True:
                        b = r.read(1 << 16)
                        if not b:
                            break
                        buf.write(b)
                        if total:
                            self.progress["vosk"] = round(100 * buf.tell() / total)
                with zipfile.ZipFile(buf) as z:
                    for n in z.namelist():
                        if ".." in n or n.startswith("/"):
                            raise ValueError("bad zip entry")
                    z.extractall(dest)
                self.progress["vosk"] = 100
            except Exception as e:
                self.progress["vosk"] = f"error: {type(e).__name__}"
        self.progress["vosk"] = 0
        threading.Thread(target=run, daemon=True).start()
        return {"started": "vosk"}

    def warm_whisper(self):
        if not self.has_whisper():
            return {"error": "pip install faster-whisper"}

        def run():
            try:
                import numpy as np
                self._whisper_run(np.zeros(16000, dtype="float32"), [])
                self.progress["whisper"] = 100
            except Exception as e:
                self.progress["whisper"] = f"error: {type(e).__name__}"
        self.progress["whisper"] = 0
        threading.Thread(target=run, daemon=True).start()
        return {"started": "whisper"}


def decode_request(body):
    return base64.b64decode(body.get("wav", "")), [str(p)[:40] for p in (body.get("phrases") or [])][:60]
