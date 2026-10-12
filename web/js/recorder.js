// Push-to-talk recording for browsers without SpeechRecognition (Firefox): capture the mic while the PTT key is held,
// convert to 16 kHz mono 16-bit WAV, and let server.py recognise it offline (faster-whisper / Vosk, see stt.py).

const WORKLET = `class Cap extends AudioWorkletProcessor {
  process(inputs) { const ch = inputs[0] && inputs[0][0]; if (ch) this.port.postMessage(ch.slice(0)); return true; }
}
registerProcessor("tt-capture", Cap);`;

export const hasBrowserRecognition = () => !!(window.SpeechRecognition || window.webkitSpeechRecognition);
export const canRecord = () => !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);

export class PttRecorder {
  constructor() { this.chunks = []; this.rate = 48000; this.live = false; }

  async start(deviceId) {
    if (!this.stream) {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true,
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}) } });
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.rate = this.ctx.sampleRate;
      const src = this.ctx.createMediaStreamSource(this.stream);
      if (this.ctx.audioWorklet) {
        const url = URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" }));
        await this.ctx.audioWorklet.addModule(url);
        this.node = new AudioWorkletNode(this.ctx, "tt-capture");
        this.node.port.onmessage = (e) => { if (this.live) this.chunks.push(e.data); };
        src.connect(this.node);
      } else {                                   // very old browsers
        this.node = this.ctx.createScriptProcessor(4096, 1, 1);
        this.node.onaudioprocess = (e) => { if (this.live) this.chunks.push(new Float32Array(e.inputBuffer.getChannelData(0))); };
        src.connect(this.node); this.node.connect(this.ctx.destination);
      }
    }
    if (this.ctx.state === "suspended") await this.ctx.resume();
    this.chunks = []; this.live = true;
  }

  /** Stop and return base64 WAV (16 kHz mono PCM16), or null if too short. */
  stop() {
    this.live = false;
    const n = this.chunks.reduce((s, c) => s + c.length, 0);
    if (n < this.rate * 0.3) return null;
    const all = new Float32Array(n); let o = 0;
    for (const c of this.chunks) { all.set(c, o); o += c.length; }
    return toWavBase64(resample(all, this.rate, 16000), 16000);
  }
}

export function resample(x, from, to) {
  if (from === to) return x;
  const n = Math.floor(x.length * to / from), out = new Float32Array(n), r = from / to;
  for (let i = 0; i < n; i++) {
    const p = i * r, j = Math.floor(p), f = p - j;
    out[i] = (x[j] || 0) * (1 - f) + (x[j + 1] || 0) * f;
  }
  return out;
}

export function toWavBase64(samples, rate) {
  const buf = new ArrayBuffer(44 + samples.length * 2), v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, "RIFF"); v.setUint32(4, 36 + samples.length * 2, true); w(8, "WAVE"); w(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, "data"); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i])) * 32767, true);
  let bin = ""; const u8 = new Uint8Array(buf);
  for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Send a recording to the local recogniser. Returns {text} or throws with the server's help text. */
export async function recognise(wavB64, phrases, engine = "auto") {
  const r = await fetch("/api/stt", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ wav: wavB64, phrases, engine }) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || "speech recognition failed");
  return j;
}
