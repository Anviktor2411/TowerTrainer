"""Opus for the XRadio bridge: AI pilots' TTS audio -> 20 ms Opus frames, and real pilots' frames -> PCM.

Optional, like every extra package here. Two backends, tried in this order:
  * PyAV   (`pip install av`)        -- decodes mp3/wav/anything and has libopus built in; the one to install
  * opuslib (`pip install opuslib`) -- needs the libopus shared library on the system; WAV input only
Without either, capabilities() says so and the bridge falls back to text. Everything runs at XRadio's
native format: 48 kHz mono, 960 samples (20 ms) per frame.
"""
import array
import io
import wave

FRAME = 960            # samples per 20 ms frame at 48 kHz
RATE = 48000


def _av():
    import av  # noqa: F401
    return av


def _opuslib():
    import opuslib  # noqa: F401
    return opuslib


def capabilities():
    """What this machine can do: {"encode": "av"|"opuslib"|None, "decode": ..., "mp3": bool, "help": str}."""
    enc = dec = None
    mp3 = False
    try:
        _av()
        enc = dec = "av"
        mp3 = True
    except Exception:
        try:
            _opuslib()
            enc = dec = "opuslib"
        except Exception:
            pass
    help_ = "" if enc else "pip install av  (AI pilot voice and ATIS for X-Plane pilots, Firefox voice)"
    return {"encode": enc, "decode": dec, "mp3": mp3, "help": help_}


# ---------- PCM helpers (stdlib) ----------
def pcm16_from_wav(data):
    """(samples as array('h'), rate, channels) from WAV bytes."""
    w = wave.open(io.BytesIO(data))
    if w.getsampwidth() != 2:
        raise ValueError("expected 16-bit PCM WAV")
    a = array.array("h")
    a.frombytes(w.readframes(w.getnframes()))
    return a, w.getframerate(), w.getnchannels()


def to_mono_48k(samples, rate, channels):
    """Linear resample to 48 kHz mono; pure Python, fast enough for radio calls (a few seconds)."""
    if channels > 1:
        mono = array.array("h", (sum(samples[i:i + channels]) // channels for i in range(0, len(samples) - channels + 1, channels)))
    else:
        mono = samples
    if rate == RATE:
        return mono
    n = int(len(mono) * RATE / rate)
    out = array.array("h", bytes(2 * n))
    step = rate / RATE
    last = len(mono) - 1
    for i in range(n):
        x = i * step
        j = int(x)
        if j >= last:
            out[i] = mono[last]
        else:
            f = x - j
            out[i] = int(mono[j] + (mono[j + 1] - mono[j]) * f)
    return out


def pcm_to_wav(pcm16, rate=RATE):
    """WAV bytes (16-bit mono) from raw PCM bytes -- for the STT engines."""
    b = io.BytesIO()
    w = wave.open(b, "wb")
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(rate)
    w.writeframes(pcm16)
    w.close()
    return b.getvalue()


# ---------- decoding audio files (TTS output) ----------
def decode_audio(data, mime=""):
    """Any audio the TTS engines produce -> array('h') of 48 kHz mono samples. WAV needs nothing; mp3 needs PyAV."""
    if data[:4] == b"RIFF" or "wav" in (mime or ""):
        s, rate, ch = pcm16_from_wav(data)
        return to_mono_48k(s, rate, ch)
    av = _av()
    out = array.array("h")
    with av.open(io.BytesIO(data)) as container:
        stream = container.streams.audio[0]
        resampler = av.AudioResampler(format="s16", layout="mono", rate=RATE)
        for frame in container.decode(stream):
            for rf in resampler.resample(frame):
                out.frombytes(bytes(rf.planes[0])[:rf.samples * 2])
        for rf in resampler.resample(None):
            out.frombytes(bytes(rf.planes[0])[:rf.samples * 2])
    return out


# ---------- Opus encode / decode ----------
class Encoder:
    def __init__(self, bitrate=24000):
        caps = capabilities()
        self.kind = caps["encode"]
        if self.kind == "av":
            av = _av()
            self.ctx = av.CodecContext.create("libopus", "w")
            self.ctx.format = "s16"
            self.ctx.layout = "mono"
            self.ctx.sample_rate = RATE
            self.ctx.bit_rate = bitrate
            self.ctx.open()
            self._pts = 0
        elif self.kind == "opuslib":
            opuslib = _opuslib()
            self.enc = opuslib.Encoder(RATE, 1, "voip")
            self.enc.bitrate = bitrate
        else:
            raise LookupError(caps["help"])

    def frames(self, samples):
        """20 ms Opus frames (bytes) for array('h') 48 kHz mono samples; the tail is zero-padded."""
        pcm = samples.tobytes()
        pad = (-len(pcm)) % (FRAME * 2)
        pcm += bytes(pad)
        out = []
        if self.kind == "av":
            av = _av()
            for off in range(0, len(pcm), FRAME * 2):
                fr = av.AudioFrame(format="s16", layout="mono", samples=FRAME)
                fr.sample_rate = RATE
                fr.pts = self._pts
                self._pts += FRAME
                fr.planes[0].update(pcm[off:off + FRAME * 2])
                for pkt in self.ctx.encode(fr):
                    out.append(bytes(pkt))
            for pkt in self.ctx.encode(None):
                out.append(bytes(pkt))
            # a fresh context for the next transmission: flushing ends this one
            self.__init__(self.ctx.bit_rate)
        else:
            for off in range(0, len(pcm), FRAME * 2):
                out.append(self.enc.encode(pcm[off:off + FRAME * 2], FRAME))
        return [f for f in out if f]


class Decoder:
    """One per speaker: Opus frames in, 16-bit 48 kHz mono PCM bytes out."""

    def __init__(self):
        caps = capabilities()
        self.kind = caps["decode"]
        if self.kind == "av":
            av = _av()
            self.ctx = av.CodecContext.create("libopus", "r")
            self.ctx.sample_rate = RATE
            self.ctx.layout = "mono"
            self.resampler = av.AudioResampler(format="s16", layout="mono", rate=RATE)
        elif self.kind == "opuslib":
            self.dec = _opuslib().Decoder(RATE, 1)
        else:
            raise LookupError(caps["help"])

    def pcm(self, frame):
        if self.kind == "av":
            av = _av()
            out = b""
            for fr in self.ctx.decode(av.Packet(frame)):
                for rf in self.resampler.resample(fr):
                    out += bytes(rf.planes[0])[:rf.samples * 2]
            return out
        return self.dec.decode(frame, FRAME)


def frames_from_audio(data, mime="", encoder=None):
    """TTS output (mp3/wav bytes) -> list of Opus frames. Raises LookupError when no codec is installed."""
    enc = encoder or Encoder()
    return enc.frames(decode_audio(data, mime))
