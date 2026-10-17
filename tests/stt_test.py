"""Local speech recognition (Firefox push-to-talk path) on a short WAV fixture.

    python tests/stt_test.py          (engines that aren't installed are skipped with a message)
"""
import base64
import sys
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")   # Windows consoles default to cp1252
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import stt as S  # noqa: E402

fails = 0


def check(c, m):
    global fails
    print(("PASS  " if c else "FAIL  ") + m)
    if not c:
        fails += 1


wav = (ROOT / "tests" / "fixtures" / "ptt_takeoff.wav").read_bytes()
m = S.STTManager()
st = m.status()
print("engines:", st["engines"] or "none")
try:
    import numpy  # noqa: F401 -- comes with every STT engine; a plain Python (like CI's) has none
except ImportError:
    print("SKIP  WAV decoding: numpy not installed")
else:
    a = S.wav_to_float(wav)
    check(len(a) > 16000 and abs(float(a.max())) <= 1.0, f"WAV decoded to {len(a) / 16000:.1f} s of 16 kHz float audio")
w2, ph = S.decode_request({"wav": base64.b64encode(wav).decode(), "phrases": ["Finnair 321"] * 100})
check(w2 == wav and len(ph) == 60, "request decoding caps the phrase list")
if not st["engines"]:
    check("pip install" in (st["help"] or ""), "no engine: status explains how to install one")
for eng in ("whisper", "vosk"):
    if eng not in st["engines"]:
        print(f"SKIP  {eng}: not installed" + ("" if eng != "vosk" or not st["vosk_package"] else " (model missing: Settings → Voices → download Vosk model)"))
        continue
    r = m.transcribe(wav, ["Finnair 321", "Speedbird 92"], eng)
    t = r["text"].lower()
    print(f"      {eng}: '{r['text']}' in {r['ms']} ms")
    check("cleared" in t and "take" in t and ("26" in t or "two six" in t), f"{eng} recognised the takeoff clearance")
    check("finnair" in t and ("321" in t or "three two one" in t), f"{eng} recognised the callsign")
print(f"\n{fails} FAILED" if fails else "\nALL PASSED")
sys.exit(1 if fails else 0)
