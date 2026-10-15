// Push-to-talk speech input shared by the main window and remote windows: the browser's SpeechRecognition
// where it exists (Chrome, Edge), otherwise the microphone is recorded and sent to /api/stt on the server
// (Vosk or Whisper, biased with the callsigns on frequency). Nothing recognised here ever acts on its own:
// the text goes through the same parser as a typed instruction.

let sttInfo = null;
/** The server's speech engines (cached). */
export async function sttStatus() {
  if (!sttInfo) { try { sttInfo = await (await fetch("/api/stt/status")).json(); } catch { sttInfo = {}; } }
  return sttInfo;
}

/** Float32 chunks at `rate` Hz -> base64 of a 16-bit 16 kHz mono WAV (what stt.py expects). */
export function wavBase64(chunks, rate) {
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const step = rate / 16000, n = Math.floor(total / step), all = new Float32Array(total);
  let o = 0; for (const c of chunks) { all.set(c, o); o += c.length; }
  const pcm = new Int16Array(n);
  for (let i = 0; i < n; i++) { const x = all[Math.floor(i * step)]; pcm[i] = Math.max(-1, Math.min(1, x)) * 32767; }
  const wav = new ArrayBuffer(44 + pcm.length * 2), dv = new DataView(wav);
  const str = (off, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)); };
  str(0, "RIFF"); dv.setUint32(4, 36 + pcm.length * 2, true); str(8, "WAVE"); str(12, "fmt "); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true); dv.setUint32(24, 16000, true); dv.setUint32(28, 32000, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  str(36, "data"); dv.setUint32(40, pcm.length * 2, true); new Int16Array(wav, 44).set(pcm);
  const b = new Uint8Array(wav); let s = ""; for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192));
  return btoa(s);
}

export const ATC_PHRASES = ["runway", "cleared for takeoff", "cleared to land", "line up and wait", "taxi to holding point", "via", "hold position",
  "contact", "squawk", "push and start approved", "go around", "cleared", "approved", "hold short", "cross", "report", "continue approach", "wind"];

export class Ptt {
  /**
   * onText(text, engine) when a phrase is ready; onPartial(text) while the browser recogniser listens;
   * onInfo(message) for problems; phrases() -> words that bias the server recogniser; cmd: the input to show progress in.
   */
  constructor({ onText, onPartial = () => {}, onInfo = () => {}, phrases = () => [], cmd = null }) {
    Object.assign(this, { onText, onPartial, onInfo, phrases, cmd });
    this.SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    this.rec = null; this.text = ""; this.local = null; this.down = false;
  }
  get browser() { return !!this.SR; }
  async start() {
    if (this.down) return;
    this.down = true;
    if (!this.SR) { await this.startLocal(); return; }
    this.text = "";
    const rec = this.rec = new this.SR(); rec.lang = "en-US"; rec.interimResults = true; rec.continuous = true;
    rec.onresult = (e) => { this.text = [...e.results].map(r => r[0].transcript).join(" "); this.onPartial(this.text); };
    rec.onend = () => { const t = this.text; this.text = ""; if (this.cmd) this.cmd.value = ""; if (t) this.onText(t, ""); };
    rec.onerror = (e) => { if (e.error && e.error !== "no-speech" && e.error !== "aborted") this.onInfo("Speech recognition: " + e.error); };
    try { rec.start(); } catch { /* already started */ }
  }
  async stop() {
    if (!this.down) return;
    this.down = false;
    if (!this.SR) { await this.stopLocal(); return; }
    const rec = this.rec; setTimeout(() => rec && rec.stop(), 350);
  }
  async startLocal() {
    if (this.local) return;
    const info = await sttStatus();
    if (!(info.whisper || info.vosk || info.engine)) { this.onInfo(`Speech input: this browser has no recogniser and the server has no engine — ${info.help || "install Vosk or Whisper (Settings)"}. Type instead.`); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true } });
      const ctx = new AudioContext(), src = ctx.createMediaStreamSource(stream), proc = ctx.createScriptProcessor(4096, 1, 1);
      const chunks = [];
      proc.onaudioprocess = (e) => { if (this.local) chunks.push(new Float32Array(e.inputBuffer.getChannelData(0))); };
      src.connect(proc); proc.connect(ctx.destination);
      this.local = { ctx, stream, proc, chunks, rate: ctx.sampleRate, placeholder: this.cmd ? this.cmd.placeholder : "" };
      if (this.cmd) this.cmd.placeholder = "listening… (server recogniser)";
    } catch (e) { this.onInfo("Microphone unavailable: " + e.message); }
  }
  async stopLocal() {
    const r = this.local; if (!r) return;
    this.local = null;
    r.proc.disconnect(); r.stream.getTracks().forEach(t => t.stop()); r.ctx.close();
    if (this.cmd) this.cmd.placeholder = r.placeholder;
    if (r.chunks.reduce((s, c) => s + c.length, 0) < r.rate * 0.3) return;
    const wav = wavBase64(r.chunks, r.rate);
    const phrases = [...new Set([...this.phrases(), ...ATC_PHRASES])];
    if (this.cmd) this.cmd.value = "recognising…";
    try {
      const j = await (await fetch("/api/stt", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ wav, phrases }) })).json();
      if (this.cmd) this.cmd.value = "";
      if (j.text) this.onText(j.text, `${j.engine}, ${j.ms} ms`);
      else this.onInfo(j.error || "Nothing recognised.");
    } catch (e) { if (this.cmd) this.cmd.value = ""; this.onInfo("Speech recognition failed: " + e.message); }
  }
}
