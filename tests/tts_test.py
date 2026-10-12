"""tts.py tests: engine order + fallback (mocked engines), voice casting, cache, secrets hygiene,
and a real render per installed engine (skipped when not installed).

    python tests/tts_test.py
"""
import io
import logging
import subprocess
import sys
import tempfile
import time
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import tts as T  # noqa: E402

fails = 0


def check(c, m):
    global fails
    print(("PASS  " if c else "FAIL  ") + m)
    if not c:
        fails += 1


class Fake(T.Engine):
    def __init__(self, mgr, name, voices, ok=True, broken=False):
        super().__init__(mgr)
        self.name, self._voices, self.ok, self.broken, self.calls = name, voices, ok, broken, 0

    def available(self):
        return (True, "") if self.ok else (False, "not installed")

    def voices(self):
        return [{"id": f"{self.name}:{n}", "engine": self.name, "name": n, "lang": l, "gender": g} for n, l, g in self._voices]

    def render(self, voice, text, prosody):
        self.calls += 1
        if self.broken:
            raise RuntimeError("service down")
        return b"RIFF" + text.encode(), "audio/wav"


with tempfile.TemporaryDirectory() as tmp:
    sec = Path(tmp) / "secrets.json"
    m = T.TTSManager(root=tmp, secrets_path=sec, engines={})
    a = Fake(m, "azure", [("en-GB-RyanNeural", "en-GB", "M"), ("en-GB-SoniaNeural", "en-GB", "F"), ("et-EE-KertNeural", "et-EE", "M")], ok=False)
    e = Fake(m, "edge", [("en-GB-RyanNeural", "en-GB", "M"), ("en-GB-ThomasNeural", "en-GB", "M"), ("en-GB-LibbyNeural", "en-GB", "F"),
                         ("en-US-GuyNeural", "en-US", "M"), ("et-EE-KertNeural", "et-EE", "M"), ("et-EE-AnuNeural", "et-EE", "F"),
                         ("de-DE-ConradNeural", "de-DE", "M")])
    p = Fake(m, "piper", [("en_GB-alan-medium", "en-GB", "M"), ("fi_FI-harri-medium", "fi-FI", "M"), ("lv_LV-aivars-medium", "lv-LV", "M")])
    m.engines = {"azure": a, "edge": e, "piper": p}
    m.cfg["order"] = ["azure", "edge", "piper"]

    # order: azure unavailable -> edge first
    v = m.cast("GB", 0)
    check(v["engine"] == "edge" and v["lang"] == "en-GB", f"engine order: unavailable azure skipped -> {v['id']}")
    v = m.cast("FI", 0)
    check(v["engine"] == "piper" and v["lang"] == "fi-FI" and v["native"] and v["respell"], f"Finnish pilot cast from the engine that has fi-FI: {v['id']}")
    v = m.cast("FR", 0)
    check(v["lang"] == "en-GB" and v["fallback"] and not v["respell"], f"no French voice anywhere -> English fallback: {v['id']}")
    v = m.cast("EE", 1, gender="F")
    check(v["id"] == "edge:et-EE-AnuNeural", f"gender preference honoured: {v['id']}")
    check(m.cast("EE", 5)["id"] == m.cast("EE", 5)["id"], "casting is stable for the same seed")
    # no duplicate voice on the frequency
    on_freq = []
    for i in range(3):
        v = m.cast("GB", 0, exclude=on_freq)
        on_freq.append(v["id"])
    check(len(set(on_freq)) == 3, f"three British pilots on one frequency get three different voices: {on_freq}")
    # disabled voice list
    m.cfg["disabled"] = ["edge:en-GB-RyanNeural", "edge:en-GB-ThomasNeural", "edge:en-GB-LibbyNeural"]
    m._catalog = None
    v = m.cast("GB", 0)
    check(v["id"] == "piper:en_GB-alan-medium", f"disabled (robotic) voices are never cast: {v['id']}")
    m.cfg["disabled"] = []
    m._catalog = None

    # cache hit / miss
    vid = m.cast("GB", 0)["id"]
    d1, _ = m.render(vid, "Cleared to land runway two six", {"rate": 1.05})
    d2, _ = m.render(vid, "Cleared to land runway two six", {"rate": 1.05})
    check(d1 == d2 and m.stats["hits"] == 1 and m.stats["misses"] == 1, f"cache miss then hit {m.stats}")
    m.render(vid, "Cleared to land runway two six", {"rate": 1.10})
    check(m.stats["misses"] == 2, "different prosody is a different cache entry")
    check(len(list((Path(tmp) / "cache" / "tts").glob("*.wav"))) == 2, "rendered audio cached in cache/tts/")

    # failing engine -> marked down, next engine used for the next cast
    e.broken = True
    try:
        m.render("edge:en-US-GuyNeural", "Speedbird 92 going around", {})
        check(False, "broken engine raises")
    except LookupError as ex:
        check("service down" in str(ex), "broken engine raises a LookupError for the client fallback")
    check(not e.usable()[0], "broken engine is temporarily disabled")
    v = m.cast("GB", 0)
    check(v["engine"] == "piper", f"after the failure casting falls back to the next engine: {v['id']}")
    e.broken = False
    e.down_until = 0
    m._catalog = None

    # status banner when nothing neural is available
    m2 = T.TTSManager(root=tmp, secrets_path=Path(tmp) / "s2.json", engines={"piper": Fake(m, "piper", [], ok=False)})
    m2.cfg["order"] = ["piper"]
    st = m2.status()
    check(not st["neural"] and "pip install piper-tts" in st["banner"], "banner explains the one-minute setup when no engine is available")

    # secrets: stored only in the local file, never logged, reported masked
    KEY = "sk-test-0123456789abcdef"
    logbuf = io.StringIO()
    h = logging.StreamHandler(logbuf)
    logging.getLogger().addHandler(h)
    logging.getLogger().setLevel(logging.DEBUG)
    st = m.configure({"azure_key": KEY, "azure_region": "westeurope"})
    a.ok = True
    a.broken = True
    try:
        m.render("azure:en-GB-SoniaNeural", "test", {})
    except LookupError:
        pass
    logging.getLogger().removeHandler(h)
    check(KEY in sec.read_text("utf-8"), "key stored in the local secrets file")
    check(st["config"]["azure_key"] is True and KEY not in str(st), "status reports the key masked (true/false)")
    check(KEY not in logbuf.getvalue(), "key never appears in the logs")
    m.configure({"azure_key": ""})
    check(KEY not in sec.read_text("utf-8"), "clearing the key removes it from the file")

gi = (ROOT / ".gitignore").read_text()
check("secrets.json" in gi and "cache/" in gi and "models/" in gi, ".gitignore covers secrets.json, cache/ (tts) and models/")
hits = []
for f in ROOT.rglob("*"):
    if f.is_file() and f.suffix in (".py", ".js", ".html", ".json", ".md") and "cache" not in f.parts and "models" not in f.parts and f.name != "secrets.json":
        try:
            if "sk-test-0123456789abcdef" in f.read_text("utf-8", "ignore") and f.name != "tts_test.py":
                hits.append(str(f))
        except OSError:
            pass
check(not hits, "no key in any repo file " + ", ".join(hits))

# real renders for installed engines
real = T.TTSManager()
for name in ("piper", "edge", "kokoro", "azure", "elevenlabs"):
    eng = real.engines[name]
    ok, why = eng.available()
    if not ok:
        print(f"SKIP  real {name} render: {why}")
        continue
    vs = [v for v in eng.voices() if v["lang"].startswith("en")] or eng.voices()
    if not vs:
        print(f"SKIP  real {name} render: no voices")
        continue
    v = vs[0]
    real._catalog = None
    t0 = time.time()
    try:
        data, mime = real.render(v["id"], f"Tallinn Tower, Finnair three two one, ready for departure, test {int(t0)}", {"rate": 1.0})
    except LookupError as ex:
        print(f"SKIP  real {name} render: service error {ex}")
        continue
    dur = None
    if mime == "audio/wav":
        w = wave.open(io.BytesIO(data))
        dur = w.getnframes() / w.getframerate()
    check(len(data) > 2000 and (dur is None or dur > 1.5), f"real {name} render {v['id']}: {len(data)} bytes {mime}" + (f", {dur:.1f} s" if dur else "") + f" in {time.time() - t0:.1f} s")

print(f"\n{fails} FAILED" if fails else "\nALL PASSED")
sys.exit(1 if fails else 0)
