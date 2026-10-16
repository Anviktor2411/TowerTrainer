// Radio: queued transmissions per frequency and the voices on them.
//
// Voice path (Settings → Voices → engine):
//   server  neural TTS rendered by server.py (Azure / edge-tts / Piper / Kokoro / ElevenLabs, see tts.py), played
//           through a VHF AM radio chain in Web Audio (buildChain):
//             mic high-pass 250 Hz with cockpit noise UNDER the voice → modulation limiter + soft clipping →
//             steep band-pass ~350–2700 Hz (cascaded Butterworth biquads) with a presence lift ~1.8 kHz →
//             AudioWorklet: sample-and-hold downsampling (~8–11 kHz) + bit-crush, AM noise floor that pumps
//             against the voice (AGC), dropouts and fading with distance, squelch click + opening burst at the
//             start and a 150–250 ms noise tail at the end, heterodyne squeal when two carriers collide.
//           With the effect on there is NO clean signal mixed in.
//   browser Web Speech API (last fallback; prefers "Natural"/"Online" voices). Web Speech can't be routed through
//           Web Audio, so the radio feel is layered around it (click, static bed, tail).
// Every position is its own channel: transmissions on different frequencies overlap, a monitored frequency
// plays quieter, guard (121.500) is always monitored by Tower/Approach. Rendering starts as soon as a call is
// queued (and for predictable next calls, before the pilot even keys), so playback latency stays under a second.
import { pickVoice, respell } from "./voices.js";
import { NAT_NAME, ENGLISH_NATIVE, controllerNat } from "./data.js";

export { sayNumbers as sayify } from "./phrase.js";
export { controllerNat };

export const PRESETS = {
  clean: { effect: 0, label: "Clean" },
  good: { effect: 0.85, label: "Good VHF" },
  distant: { effect: 1, label: "Distant", quality: 0.38 },
  old: { effect: 0.95, label: "Old radio", hp: 430, lp: 2300, bits: -2, noise: 1.6, hum: true },
};

const WORKLET = `
class TTRadio extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: "rate", defaultValue: 10000, minValue: 2000, maxValue: 96000 },
      { name: "bits", defaultValue: 10, minValue: 3, maxValue: 16 },
      { name: "noise", defaultValue: 0.03, minValue: 0, maxValue: 1 },
      { name: "quality", defaultValue: 1, minValue: 0, maxValue: 1 },
      { name: "carrier", defaultValue: 1, minValue: 0, maxValue: 1 },
      { name: "het", defaultValue: 0, minValue: 0, maxValue: 1 },
      { name: "agc", defaultValue: 0.7, minValue: 0, maxValue: 1 },
    ];
  }
  constructor() {
    super();
    this.hold = 0; this.phase = 0; this.env = 0; this.seed = 22222; this.tail = 0; this.burst = 0; this.click = 0; this.clickSign = 1;
    this.hetPhase = 0; this.wobble = 0; this.drop = 0; this.open = false; this.fade = 1; this.fadePhase = Math.random() * 6.28;
  }
  rnd() { this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0; return this.seed / 4294967296 * 2 - 1; }
  process(inputs, outputs, params) {
    const inp = inputs[0] && inputs[0][0];
    const out = outputs[0][0];
    if (!out) return true;
    const sr = sampleRate, n = out.length;
    const P = (name, i) => (params[name].length > 1 ? params[name][i] : params[name][0]);
    for (let i = 0; i < n; i++) {
      const carrier = P("carrier", i) > 0.5, q = P("quality", i), floor = P("noise", i);
      if (carrier && !this.open) { this.open = true; this.click = Math.round(sr * 0.002); this.clickSign = 1; this.burst = Math.round(sr * 0.02); }
      if (!carrier && this.open) { this.open = false; this.tail = Math.round(sr * (0.15 + 0.1 * (1 - q))); }
      let x = carrier && inp ? inp[i] : 0;
      const a = Math.abs(x);
      this.env += (a > this.env ? 0.012 : 0.0006) * (a - this.env);
      // weak signal: the audio breaks up
      if (carrier && q < 0.7) {
        if (this.drop > 0) { this.drop--; x = 0; }
        else if (this.rnd() > 1 - (0.7 - q) * 0.0025) this.drop = Math.round(sr * (0.015 + 0.09 * (0.7 - q)));
      }
      // sample-and-hold + quantisation
      this.phase += P("rate", i) / sr;
      if (this.phase >= 1) { this.phase -= 1; const steps = Math.pow(2, P("bits", i)); this.hold = Math.round(x * steps) / steps; }
      let y = this.hold;
      // slow fading with distance
      this.fadePhase += 2 * Math.PI * 0.45 / sr;
      const fade = 1 - (1 - q) * 0.45 * (0.5 + 0.5 * Math.sin(this.fadePhase));
      y *= fade;
      let noiseAmp = 0;
      if (this.tail > 0) { noiseAmp = Math.max(0.03, floor * 5); this.tail--; if (this.tail === 0) { this.click = Math.round(sr * 0.002); this.clickSign = -1; } }
      else if (carrier) {
        noiseAmp = floor * (1 + 7 * (1 - q)) * (1 - P("agc", i) * Math.min(1, this.env * 9));
        if (this.burst > 0) { noiseAmp = Math.max(noiseAmp, 0.22); this.burst--; }
      }
      if (noiseAmp > 0) y += this.rnd() * noiseAmp;
      if (this.click > 0) { y += this.clickSign * 0.55 * this.click / (sr * 0.002); this.click--; }
      if (carrier && P("het", i) > 0.5) {
        this.wobble += 2 * Math.PI * 0.7 / sr;
        const f = 1300 + 250 * Math.sin(this.wobble);
        this.hetPhase += 2 * Math.PI * f / sr;
        y += 0.22 * Math.sin(this.hetPhase);
      }
      out[i] = y;
    }
    return true;
  }
}
registerProcessor("tt-radio", TTRadio);`;

let workletUrl = null;
const workletFor = new WeakMap();   // AudioContext -> Promise<boolean>
export function ensureWorklet(ctx) {
  if (!ctx.audioWorklet) return Promise.resolve(false);
  let p = workletFor.get(ctx);
  if (!p) {
    workletUrl ||= URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" }));
    p = ctx.audioWorklet.addModule(workletUrl).then(() => true).catch(() => false);
    workletFor.set(ctx, p);
  }
  return p;
}

function butterworth(ctx, type, f, chain) {
  for (const q of [0.5412, 1.3066]) { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; chain.push(b); }
}
function noiseBuffer(ctx, sec, crackle = 0.0009) {
  const len = Math.floor(ctx.sampleRate * sec), buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) { let x = Math.random() * 2 - 1; if (Math.random() < crackle) x += (Math.random() < 0.5 ? -1 : 1) * (2 + Math.random() * 3); d[i] = x * 0.5; }
  return buf;
}

/**
 * The VHF AM chain. opts: { effect 0..1, preset, quality 0..1 (1 = next door), atc (controller: cleaner), loud,
 * het (second carrier), worklet (bool: the module is loaded in ctx), cockpit (0..1 cockpit noise level) }
 * Returns { input, output, setCarrier(time, on), dispose(time), params }.
 */
export function buildChain(ctx, o = {}) {
  const preset = PRESETS[o.preset] || PRESETS.good;
  const e = Math.max(0, Math.min(1, o.effect ?? preset.effect));
  const input = ctx.createGain(), output = ctx.createGain();
  if (e <= 0) { input.connect(output); output.gain.value = 0.9; return { input, output, setCarrier() {}, dispose() {}, params: { effect: 0 } }; }
  const q = Math.max(0.05, Math.min(1, preset.quality != null ? Math.min(preset.quality, o.quality ?? 1) : (o.quality ?? 1)));
  const atc = !!o.atc;
  // transmitter: mic high-pass, cockpit noise under the voice, limiter, soft clip
  const micHp = ctx.createBiquadFilter(); micHp.type = "highpass"; micHp.frequency.value = 250; micHp.Q.value = 0.7;
  const tx = ctx.createGain(); tx.gain.value = o.loud ? 2.4 : 1.2;
  input.connect(micHp).connect(tx);
  const nodes = [];
  const cockpit = o.cockpit ?? (atc ? 0 : 1);
  if (cockpit > 0) {
    const src = ctx.createBufferSource(); src.buffer = noiseBuffer(ctx, 2, 0); src.loop = true;
    const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 230; lp.Q.value = 1.1;
    const g = ctx.createGain(); g.gain.value = 0.06 * cockpit * (preset.hum ? 1.4 : 1) * e;
    src.connect(lp).connect(g).connect(tx); src.start(); nodes.push(src);
  }
  const lim = ctx.createDynamicsCompressor();
  lim.threshold.value = -30; lim.knee.value = 3; lim.ratio.value = 20; lim.attack.value = 0.002; lim.release.value = 0.12;
  const makeup = ctx.createGain(); makeup.gain.value = 1.9 + e;
  const sat = ctx.createWaveShaper();
  const curve = new Float32Array(2048), drive = 1 + e * (o.loud ? 5 : 2.6);
  for (let i = 0; i < 2048; i++) { const x = i / 1023.5 - 1; curve[i] = Math.tanh(x * drive) / Math.tanh(drive); }
  sat.curve = curve; sat.oversample = "2x";
  tx.connect(lim).connect(makeup).connect(sat);
  // receiver: steep band-pass with a presence lift
  const hp = preset.hp || (250 + 130 * e), lp = preset.lp || (3400 - 720 * e);
  const band = [];
  butterworth(ctx, "highpass", hp, band);
  butterworth(ctx, "lowpass", lp, band);
  const pres = ctx.createBiquadFilter(); pres.type = "peaking"; pres.frequency.value = 1800; pres.Q.value = 1.0; pres.gain.value = 3.5 * e;
  band.push(pres);
  let last = sat;
  for (const b of band) { last.connect(b); last = b; }
  // AM / sampling / noise stage
  const params = {
    effect: e, quality: q, hp, lp,
    rate: e < 0.5 ? 48000 - (48000 - 16000) * e * 2 : 16000 - (16000 - 8000) * (e - 0.5) * 2,
    bits: Math.max(5, Math.round(16 - 7 * e + (preset.bits || 0))),
    noise: (0.004 + 0.034 * e) * (atc ? 0.4 : 1) * (preset.noise || 1),
    agc: 0.75 * e,
  };
  let stage = last, node = null;
  if (o.worklet && typeof AudioWorkletNode !== "undefined") {
    node = new AudioWorkletNode(ctx, "tt-radio", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    node.parameters.get("rate").value = params.rate;
    node.parameters.get("bits").value = params.bits;
    node.parameters.get("noise").value = params.noise;
    node.parameters.get("quality").value = q;
    node.parameters.get("carrier").value = 0;
    node.parameters.get("het").value = o.het ? 1 : 0;
    node.parameters.get("agc").value = params.agc;
    last.connect(node); stage = node;
  }
  const post = ctx.createBiquadFilter(); post.type = "lowpass"; post.frequency.value = Math.min(3400, lp + 500); post.Q.value = 0.7;
  const fade = ctx.createGain(); fade.gain.value = (0.55 + 0.45 * q) * 0.9;
  stage.connect(post).connect(fade).connect(output);
  if (preset.hum) {
    const osc = ctx.createOscillator(); osc.frequency.value = 100; const hg = ctx.createGain(); hg.gain.value = 0.01;
    osc.connect(hg).connect(output); osc.start(); nodes.push(osc);
  }
  return {
    input, output, params, node,
    setCarrier(t, on) { if (node) node.parameters.get("carrier").setValueAtTime(on ? 1 : 0, t); },
    dispose(t) { for (const n of nodes) { try { n.stop(t); } catch { /* */ } } setTimeout(() => { try { input.disconnect(); output.disconnect(); if (node) node.disconnect(); } catch { /* */ } }, Math.max(0, (t - ctx.currentTime) * 1000) + 600); },
  };
}

const rms = (data, a, b) => { let s = 0, n = 0; for (let i = Math.max(0, a | 0); i < Math.min(data.length, b | 0); i++) { s += data[i] * data[i]; n++; } return n ? Math.sqrt(s / n) : 0; };

/** Offline measurement of the chain: band limiting, noise floor under the carrier, squelch tail. */
export async function selfTest(effect = 0.85, preset = "good") {
  const sr = 48000, dur = 1.3;
  const run = async (freq) => {
    const oc = new OfflineAudioContext(1, Math.floor(sr * dur), sr);
    const w = await ensureWorklet(oc);
    const chain = buildChain(oc, { effect, preset, quality: 1, atc: false, cockpit: 0, worklet: w });
    if (freq) {
      const osc = oc.createOscillator(); osc.frequency.value = freq; const g = oc.createGain(); g.gain.value = 0.3;
      osc.connect(g).connect(chain.input); osc.start(0); osc.stop(0.8);
    }
    chain.output.connect(oc.destination);
    chain.setCarrier(0, true); chain.setCarrier(0.8, false);
    const buf = await oc.startRendering();
    const d = buf.getChannelData(0);
    return { during: rms(d, sr * 0.25, sr * 0.7), tail: rms(d, sr * 0.83, sr * 0.93), after: rms(d, sr * 1.15, sr * 1.28), worklet: w };
  };
  const [low, mid, high, none] = await Promise.all([run(150), run(1000), run(6000), run(0)]);
  return { worklet: mid.worklet, low: low.during, mid: mid.during, high: high.during, floor: none.during, tail: mid.tail, after: mid.after,
    lowRatio: mid.during / Math.max(1e-6, low.during), highRatio: mid.during / Math.max(1e-6, high.during) };
}

export class Radio {
  constructor() {
    this.channels = new Map();    // pos -> {queue, busy, timer, stuckUntil, stuckAc}
    this.tts = true;
    this.engine = "auto";         // auto | server | browser
    this.accents = "natural";     // off | natural | strong
    this.effect = 0.85;           // radio effect strength 0..1 (0 = clean voice)
    this.preset = "good";
    this.rate = 1.0;              // speech rate multiplier
    this.blocked = true;          // simulate blocked transmissions and stuck mics
    this.blockedRate = 0.05;
    this.stuckRate = 1 / 2400;    // per transmission: ~one stuck mic per 40 min of busy frequency
    this.human = 0.12;            // rate of human touches ("uh", breath, self-corrections)
    this.respellLangs = { et: true, fi: true, lv: true, lt: true, de: false };
    this.audible = null;          // Set of position keys to play (null = all)
    this.monitor = new Set();     // positions played quietly
    this.monitorGain = 0.35;
    this.airport = "";
    this.muted = false;           // pop-out windows never play audio
    this.ctx = null;
    this.listeners = [];
    this.voices = [];
    this.voiceCache = new Map();
    this.server = { neural: false, checked: false, banner: null };
    this.pre = new Map();         // pre-rendered next calls: key -> Promise<ArrayBuffer>
    this.onFrequency = null;      // (pos) => aircraft on that frequency (voice casting)
    this.onBlocked = null;        // (pos) => {} after a blocked transmission (AI "say again")
    this.atis = null;             // current ATIS loop
    this.loadBrowserVoices();
  }

  on(fn) { this.listeners.push(fn); }
  emit(msg) { for (const f of this.listeners) f(msg); }
  chan(pos) {
    let c = this.channels.get(pos || "ALL");
    if (!c) { c = { pos: pos || "ALL", queue: [], busy: false, timer: null, stuckUntil: 0, stuckAc: null }; this.channels.set(pos || "ALL", c); }
    return c;
  }
  get queue() { return [...this.channels.values()].flatMap(c => c.queue); }
  get busy() { return [...this.channels.values()].some(c => c.busy); }

  /** Firefox: getVoices() is often empty at first — wait for voiceschanged, with a timeout and retries. */
  loadBrowserVoices() {
    if (typeof speechSynthesis === "undefined") return;
    const load = () => {
      const v = speechSynthesis.getVoices();
      if (v.length !== this.voices.length) { this.voices = v; this.voiceCache.clear(); this.emit({ from: "voices" }); }
      return v.length;
    };
    load();
    if ("onvoiceschanged" in speechSynthesis) speechSynthesis.addEventListener("voiceschanged", load);
    let tries = 0;
    const t = setInterval(() => { if (load() || ++tries > 20) clearInterval(t); }, 250);
  }
  /** True when the browser only has old desktop (SAPI) voices, i.e. would sound robotic. */
  get browserRobotic() { return this.voices.length > 0 && !this.voices.some(v => /natural|online|neural/i.test(v.name)); }

  async checkServer() {
    try {
      const r = await fetch("/api/tts/status");
      const s = await r.json();
      this.server = { neural: !!s.neural, checked: true, banner: s.banner, engines: s.engines, config: s.config, python: s.python, cache: s.cache, speaking: s.speaking };
    } catch { this.server = { neural: false, checked: true, banner: "Voice server unreachable — using browser voices." }; }
    this.emit({ from: "voices" });
    return this.server;
  }
  useServer() { return this.tts && this.engine !== "browser" && this.server.neural; }

  audio() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      if (this.sinkId && typeof this.ctx.setSinkId === "function") this.ctx.setSinkId(this.sinkId).catch(() => {});
      this.workletReady = ensureWorklet(this.ctx);
      this.master = this.ctx.createGain(); this.master.gain.value = 1; this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === "suspended") this.ctx.resume().catch(() => {});
    return this.ctx;
  }
  /** Radio output device (Chrome/Edge AudioContext.setSinkId). Returns false where unsupported. */
  static canChooseOutput() { return typeof AudioContext !== "undefined" && typeof AudioContext.prototype.setSinkId === "function"; }
  async setSink(id) {
    this.sinkId = id || "";
    if (this.ctx && typeof this.ctx.setSinkId === "function") { try { await this.ctx.setSinkId(this.sinkId); } catch { return false; } }
    return true;
  }
  gainFor(pos) { return this.monitor.has(pos) ? this.monitorGain : 1; }

  // ---------- sound effects (also used around browser voices, which cannot go through Web Audio) ----------
  noiseBuffer(sec, crackle = 0.0009) { return noiseBuffer(this.audio(), sec, crackle); }
  bandpass(ctx, lo = 300, hi = 3000) {
    const hp = ctx.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = lo;
    const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = hi;
    hp.connect(lp);
    return { input: hp, output: lp };
  }
  /** Short burst: squelch click (start) or tail (end). */
  burst(dur, gain, pos) {
    if (this.effect <= 0 || this.muted) return;
    try {
      const ctx = this.audio(), src = ctx.createBufferSource();
      src.buffer = this.noiseBuffer(dur);
      const bp = this.bandpass(ctx, 350, 2700), g = ctx.createGain();
      g.gain.setValueAtTime(gain * this.effect * this.gainFor(pos), ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
      src.connect(bp.input); bp.output.connect(g).connect(this.master); src.start();
    } catch { /* audio unavailable */ }
  }
  /** Static bed; returns stop(). */
  staticBed(level, dest) {
    if (this.effect <= 0 || this.muted) return () => {};
    try {
      const ctx = this.audio(), src = ctx.createBufferSource();
      src.buffer = this.noiseBuffer(2); src.loop = true;
      const bp = this.bandpass(ctx, 350, 2700), g = ctx.createGain();
      g.gain.value = 0.0001;
      g.gain.linearRampToValueAtTime(level * this.effect, ctx.currentTime + 0.05);
      src.connect(bp.input); bp.output.connect(g).connect(dest || this.master); src.start();
      return () => { try { g.gain.linearRampToValueAtTime(0.0001, ctx.currentTime + 0.08); src.stop(ctx.currentTime + 0.1); } catch { /* */ } };
    } catch { return () => {}; }
  }
  chime() {
    try {
      const ctx = this.audio(), t = ctx.currentTime;
      for (const [f, dt] of [[1046, 0], [784, 0.35]]) {
        const o = ctx.createOscillator(), g = ctx.createGain(); o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, t + dt); g.gain.linearRampToValueAtTime(0.012 * this.effect, t + dt + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + dt + 0.6);
        o.connect(g).connect(this.master); o.start(t + dt); o.stop(t + dt + 0.65);
      }
    } catch { /* */ }
  }
  /** Two carriers beating against each other: the squeal of a blocked transmission (synthetic version). */
  heterodyne(sec = 1.4, pos) {
    if (this.muted) return;
    try {
      const ctx = this.audio(), t = ctx.currentTime;
      const o1 = ctx.createOscillator(), o2 = ctx.createOscillator(), g = ctx.createGain();
      const vol = 0.06 * Math.max(0.3, this.effect) * this.gainFor(pos);
      o1.frequency.value = 1150; o2.frequency.setValueAtTime(1150 + 380, t); o2.frequency.linearRampToValueAtTime(1150 + 520, t + sec);
      g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(vol, t + 0.05);
      g.gain.setValueAtTime(vol, t + sec - 0.1); g.gain.linearRampToValueAtTime(0.0001, t + sec);
      o1.connect(g); o2.connect(g); g.connect(this.master);
      o1.start(t); o2.start(t); o1.stop(t + sec); o2.stop(t + sec);
      const stop = this.staticBed(0.05); setTimeout(stop, sec * 1000);
    } catch { /* audio unavailable */ }
  }

  /** Signal quality 0..1 from distance (km) to the field: full inside ~12 km, down to 0.3 at ~60 km. */
  qualityFor(km) { return Math.max(0.3, Math.min(1, 1 - (km - 12) / 65)); }

  /**
   * Play decoded voice audio through the radio chain. Resolves when the transmission (with squelch tail) is over.
   * opts: km distance, loud, atc, pos (gain), het (second carrier), buffers: extra buffers played at once (blocked)
   */
  async playVoice(buffer, { km = 0, loud = false, atc = false, pos = "ALL", het = false, buffers = null, cut = null } = {}) {
    const ctx = this.audio();
    const worklet = await this.workletReady;
    const chain = buildChain(ctx, { effect: this.effect, preset: this.preset, quality: atc ? 1 : this.qualityFor(km), atc, loud, het, worklet, cockpit: atc ? 0 : 1 });
    const out = ctx.createGain(); out.gain.value = this.gainFor(pos);
    chain.output.connect(out).connect(this.master);
    const srcs = [buffer, ...(buffers || [])].map(b => { const s = ctx.createBufferSource(); s.buffer = b; s.connect(chain.input); return s; });
    const t0 = ctx.currentTime + 0.03;
    const dur = cut != null ? Math.min(cut, Math.max(...srcs.map(s => s.buffer.duration))) : Math.max(...srcs.map(s => s.buffer.duration));
    chain.setCarrier(t0, true);
    for (const s of srcs) { s.start(t0); if (cut != null) s.stop(t0 + dur); }
    chain.setCarrier(t0 + dur + 0.02, false);
    if (!worklet) { this.burst(0.03, 0.25, pos); const stop = this.staticBed(atc ? 0.006 : 0.012, out); setTimeout(() => { stop(); this.burst(0.14, 0.18, pos); }, dur * 1000); }
    const tail = worklet ? 0.32 : 0.2;
    chain.dispose(t0 + dur + tail + 0.1);
    return new Promise((resolve) => setTimeout(resolve, (t0 - ctx.currentTime + dur + tail) * 1000));
  }

  // ---------- voices ----------
  voiceFor(ac, speaker = 0) {
    const key = `${ac.id}:${speaker}:${this.accents}:${this.voices.length}`;
    if (!this.voiceCache.has(key)) {
      const m = (ac.crew && ac.crew[speaker]) || { seed: ac.id * 7919, pitch: 1, rate: 1 };
      this.voiceCache.set(key, { ...pickVoice(this.voices, ac.nat || "GB", m.seed, this.accents), pitch: m.pitch, rate: m.rate });
    }
    return this.voiceCache.get(key);
  }
  controllerVoice() {
    if (!this.ctlVoice || this.ctlVoice.n !== this.voices.length) {
      this.ctlVoice = { ...pickVoice(this.voices, "GB", 4, "off"), pitch: 0.95, rate: 1.05, n: this.voices.length };
    }
    return this.ctlVoice;
  }

  /** Server voice for a crew member: cast once per flight, never the same voice as another aircraft on the frequency
   *  nor the other crew member; ~10 % female pilots. */
  castServer(ac, speaker, pos) {
    ac.cast ||= {};
    if (ac.cast[speaker]) return ac.cast[speaker];
    const m = (ac.crew && ac.crew[speaker]) || { seed: (ac.id || 1) * 7919 };
    const nat = this.accents === "off" ? (ENGLISH_NATIVE[ac.nat] ? ac.nat : "GB") : (ac.nat || "GB");
    const gender = m.gender || (Math.abs(m.seed) % 100 < 10 ? "F" : "M");
    if (m && !m.gender) m.gender = gender;
    const exclude = [];
    for (const o of this.onFrequency ? this.onFrequency(pos) : []) {
      if (o === ac || !o.cast) continue;
      for (const p of Object.values(o.cast)) if (p && p.id) exclude.push(p.id);
    }
    for (const [k, p] of Object.entries(ac.cast)) if (+k !== speaker && p && p.id) exclude.push(p.id);
    ac.cast[speaker] = fetch("/api/tts/cast", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nat, seed: m.seed, gender, exclude, role: ac.veh ? "driver" : "pilot" }) })
      .then(r => r.json()).then(j => { ac.cast[speaker] = j.voice; return j.voice; })
      .catch(() => { ac.cast[speaker] = null; return null; });
    return ac.cast[speaker];
  }
  /** The voice of the controller on `pos`. ctrl (autoatc.js): this shift's controller -- its own seed, gender and
   *  accent, so every position and every shift sounds like another person. */
  castController(pos, ctrl = null) {
    this.ctlCast ||= {};
    const key = ctrl ? `${pos}#${ctrl.id}` : pos;
    if (!this.ctlCast[key]) {
      const nat = this.accents === "off" ? "GB" : (ctrl && ctrl.nat) || controllerNat(this.airport);
      const seed = ctrl ? ctrl.voiceSeed : [...String(pos)].reduce((s, c) => s + c.charCodeAt(0), 11);
      this.ctlCast[key] = fetch("/api/tts/cast", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nat, seed, gender: ctrl ? ctrl.gender : undefined, role: "controller" }) })
        .then(r => r.json()).then(j => { this.ctlCast[key] = j.voice; return j.voice; }).catch(() => null);
    }
    return this.ctlCast[key];
  }

  /** Natural delivery at a low rate: "uh" before numbers, "...and" before the callsign, a self-correction. Spoken text only. */
  humanize(s, busy, kind) {
    if (this.human <= 0) return s;
    if (Math.random() < this.human * (busy ? 0.5 : 1)) s = s.replace(/(squawk|runway|contact \w+|climb|descend) (?=[a-z]+ [a-z]+)/i, "$1, uh, ");
    if (Math.random() < this.human * 0.4) s = s.replace(/, ([A-Z][a-z]+(?: [A-Z][a-z]+)? [a-z-]+(?: [a-z-]+){1,3})$/, ", and $1");
    if (kind === "readback" && Math.random() < this.human * 0.2) {
      // "squawk four five two, correction, four five two one"
      const NUM = "(?:zero|one|two|three|four|five|six|seven|eight|nine|niner|tree|fife|fower|wun|too|ait)";
      const m = s.match(new RegExp(`\\b(${NUM}(?: ${NUM}){2,3})\\b`));
      if (m) { const w = m[1].split(" "); s = s.replace(m[1], `${w.slice(0, w.length - 1).join(" ")}, correction, ${m[1]}`); }
    }
    return s;
  }

  /** Spoken text + prosody for a transmission (accent respelling only where the voice needs it). */
  prepare(m, voice) {
    const busy = this.chan(m.pos).queue.length > 1;
    let text = m.say || m.text;
    if (!voice || !/^et/i.test(voice.lang || "")) text = text.replace(/\bhead aega\b/gi, "bye");
    if (m.from !== "atc") text = this.humanize(text, busy, m.kind);
    const lang2 = String((voice && voice.lang) || "").slice(0, 2).toLowerCase();
    if (voice && voice.respell && this.respellLangs[lang2]) text = respell(text, voice.lang);
    const crew = m.ac && m.ac.crew && m.ac.crew[m.speaker || 0];
    let rate = (crew ? crew.rate : 1) * this.rate;
    if (m.kind === "readback") rate *= 1.06;           // routine readbacks a little quicker
    else if (m.kind && m.kind !== "readback") rate *= 0.97;  // initial calls slower and clearer
    if (busy) rate *= 1.06;
    let pitch = crew ? (crew.pitch - 1) * 18 : 0;
    let style;
    if (m.from === "atc") { rate = 0.97 * this.rate * (m.ctrl ? m.ctrl.rate : 1); pitch = -3; style = "calm"; }   // controllers: calm, even (each at its own pace)
    if (m.kind === "atis") { rate = 0.93 * this.rate; pitch = -2; style = "newscast"; }
    return { text, prosody: { rate: Math.round(rate * 100) / 100, pitch: Math.round(pitch), ...(style ? { style } : {}) } };
  }

  renderKey(voiceId, text, prosody) { return `${voiceId}|${text}|${JSON.stringify(prosody)}`; }

  /** Start rendering on the server right away (runs during the pilot's reaction delay). */
  prerender(m) {
    if (!this.useServer() || this.muted || m.from === "blocked") return;
    const voiceP = m.from === "atc" ? this.castController(m.pos, m.ctrl || null) : this.castServer(m.ac, m.speaker || 0, m.pos);
    m.render = Promise.resolve(m.voiceId ? { id: m.voiceId } : voiceP).then(async (voice) => {
      if (!voice) return null;
      m.voiceId = voice.id;
      const { text, prosody } = this.prepare(m, voice);
      const key = this.renderKey(voice.id, text, prosody);
      const pre = this.pre.get(key);
      if (pre) { this.pre.delete(key); return pre; }
      return this.fetchRender(voice.id, text, prosody);
    }).catch(() => null);
  }
  async fetchRender(voiceId, text, prosody) {
    const r = await fetch("/api/tts/speak", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ voice: voiceId, text, prosody }) });
    if (!r.ok) return null;
    return r.arrayBuffer();
  }
  /** Pre-render a call the pilot is expected to make soon, so it plays within a second when it comes. */
  prerenderText(ac, msg) {
    if (!this.useServer() || this.muted || !ac) return;
    const m = { from: "pilot", ac, text: msg.d, say: msg.s, pos: ac.freq, speaker: 0, kind: msg.kind };
    Promise.resolve(this.castServer(ac, 0, ac.freq)).then(voice => {
      if (!voice) return;
      const saveHuman = this.human; this.human = 0;        // deterministic text so the key matches later
      const { text, prosody } = this.prepare(m, voice);
      this.human = saveHuman;
      const key = this.renderKey(voice.id, text, prosody);
      if (this.pre.has(key)) return;
      if (this.pre.size > 40) this.pre.delete(this.pre.keys().next().value);
      this.pre.set(key, this.fetchRender(voice.id, text, prosody).catch(() => null));
    });
  }

  // ---------- transmissions ----------
  /** Controller (user) transmission: shown immediately. Returns false when the frequency is blocked by a stuck mic. */
  controller(text, pos) {
    const ch = this.chan(pos);
    this.emit({ from: "atc", text, pos });
    if (ch.stuckUntil > performance.now()) { this.emit({ from: "blocked", pos, ac: null, stuck: true }); return false; }
    return true;
  }

  /**
   * Queue a pilot or AI-controller transmission.
   * m: { from: "pilot"|"atc", ac?, text, say?, pos, speaker?, ai?, kind?, voiceId? }
   */
  enqueue(m, delay) {
    const ch = this.chan(m.pos);
    const sameFreq = ch.queue.length + (ch.busy ? 1 : 0);
    const d = delay ?? (m.from === "atc" ? 0.8 + Math.random() * 1.2 : 0.5 + Math.random() * 2.0);
    const item = { ...m, readyAt: performance.now() + (d + sameFreq * 1.2) * 1000 };
    if (this.isAudible(m.pos)) {
      const saveHuman = this.human;
      if (m.kind !== "readback") this.human = Math.min(this.human, 0.06);
      this.prerender(item);
      this.human = saveHuman;
    }
    ch.queue.push(item);
    this.pump(ch);
  }
  isAudible(pos) { return !this.audible || this.audible.has(pos) || pos === "ALL" || pos === "GUARD" || this.monitor.has(pos); }
  /** Legacy API. */
  pilot(ac, text, delay) { this.enqueue({ from: "pilot", ac, text, say: undefined, pos: ac.freq }, delay); }

  pump(ch) {
    if (ch.busy || !ch.queue.length) return;
    ch.queue.sort((a, b) => a.readyAt - b.readyAt);
    const wait = Math.max(0, ch.queue[0].readyAt - performance.now());
    if (ch.timer) clearTimeout(ch.timer);
    ch.timer = setTimeout(() => this.next(ch), wait);
  }

  next(ch) {
    ch.timer = null;
    if (ch.busy || !ch.queue.length) return;
    const now = performance.now();
    if (ch.stuckUntil > now) { const m = ch.queue[0]; m.readyAt = ch.stuckUntil + 500 + Math.random() * 2000; if (!m.stuckNoted) { m.stuckNoted = true; this.emit({ from: "blocked", pos: m.pos, ac: m.ac, stuck: true }); } this.pump(ch); return; }
    const m = ch.queue.shift();
    const rival = this.blocked && m.from === "pilot" &&
      ch.queue.find(q => q.from === "pilot" && q.pos === m.pos && q.readyAt - now < 400 && q.ac !== m.ac);
    if (rival && Math.random() < Math.max(this.blockedRate, 0.35)) return this.block(ch, m, rival);
    if (!rival && this.blocked && m.from === "pilot" && !m.retried && Math.random() < this.blockedRate * 0.3) {
      return this.block(ch, m, null); // a station we cannot see steps on this call
    }
    if (this.blocked && m.from === "pilot" && m.ac && !m.ac.human && Math.random() < this.stuckRate && !ch.stuckUntil) { this.stuckMic(ch, m.ac); }
    this.transmit(ch, m);
  }

  /** Both stations garbled with a heterodyne squeal; then both try again and the controller asks who called. */
  async block(ch, m, rival) {
    ch.busy = true;
    const audible = this.tts && !this.muted && this.isAudible(m.pos);
    ch.queue = ch.queue.filter(q => q !== rival);
    this.emit({ from: "blocked", pos: m.pos, ac: m.ac, rival: rival && rival.ac });
    const retry = (x) => { x.readyAt = performance.now() + (3 + Math.random() * 4) * 1000; x.retried = true; };
    const done = () => { ch.busy = false; retry(m); ch.queue.push(m); if (rival) { retry(rival); ch.queue.push(rival); } this.pump(ch); if (this.onBlocked) this.onBlocked(m.pos); };
    if (audible) {
      const bufs = [];
      for (const x of [m, rival].filter(Boolean)) {
        const b = x.render ? await Promise.race([x.render, new Promise(r => setTimeout(() => r(null), 2500))]) : null;
        if (b) { try { bufs.push(await this.audio().decodeAudioData(b.slice(0))); } catch { /* */ } }
      }
      if (bufs.length) {
        this.emit({ from: "engine", engine: "garbled", voice: "" });
        await this.playVoice(bufs[0], { km: 15, pos: m.pos, het: true, loud: true, buffers: bufs.slice(1), cut: 1.2 + Math.random() * 0.8 });
        done(); return;
      }
      this.heterodyne(1.2 + Math.random() * 0.6, m.pos);
    }
    setTimeout(done, 1700);
  }

  /** A microphone stuck open: cockpit noise on the frequency for a while, nobody else gets through. */
  stuckMic(ch, ac) {
    const dur = 8 + Math.random() * 12;
    ch.stuckUntil = performance.now() + dur * 1000; ch.stuckAc = ac;
    this.emit({ from: "stuck", pos: ch.pos, ac, on: true });
    if (this.tts && !this.muted && this.isAudible(ch.pos)) {
      try {
        const ctx = this.audio();
        this.workletReady.then(w => {
          const chain = buildChain(ctx, { effect: Math.max(0.5, this.effect), preset: this.preset, quality: 0.8, atc: false, worklet: w, cockpit: 2.5 });
          const out = ctx.createGain(); out.gain.value = this.gainFor(ch.pos); chain.output.connect(out).connect(this.master);
          const t0 = ctx.currentTime + 0.05; chain.setCarrier(t0, true); chain.setCarrier(t0 + dur, false); chain.dispose(t0 + dur + 0.5);
        });
      } catch { /* */ }
    }
    setTimeout(() => { ch.stuckUntil = 0; ch.stuckAc = null; this.emit({ from: "stuck", pos: ch.pos, ac, on: false }); this.pump(ch); }, dur * 1000);
  }

  async transmit(ch, m) {
    ch.busy = true;
    this.emit(m);
    const audible = this.tts && !this.muted && this.isAudible(m.pos);
    const textSaid = m.say || m.text;
    const done = () => { setTimeout(() => { ch.busy = false; this.pump(ch); }, 350); };
    if (!audible) { setTimeout(() => { ch.busy = false; this.pump(ch); }, 300 + textSaid.length * 20); return; }
    const km = m.ac && m.ac.pos ? Math.hypot(m.ac.pos[0], m.ac.pos[1]) / 1000 : 0;
    // server neural voice through the real radio chain
    if (m.render) {
      const buf = await Promise.race([m.render, new Promise(r => setTimeout(() => r(null), 4500))]);
      if (buf) {
        try {
          const audio = await this.audio().decodeAudioData(buf.slice(0));
          this.emit({ from: "engine", engine: String(m.voiceId || "").split(":")[0] || "server", voice: m.voiceId || "" });
          if (m.from === "pilot" && Math.random() < this.human * 0.5) this.burst(0.18, 0.05, m.pos); // a breath before keying
          if (m.from === "pilot" && Math.random() < 0.03) this.chime();
          await this.playVoice(audio, { km, loud: m.from === "pilot" && Math.random() < 0.08, atc: m.from === "atc", pos: m.pos });
          done();
          return;
        } catch { /* fall back to the browser voice */ }
      }
    }
    this.speakBrowser(m, km, done);
  }

  speakBrowser(m, km, done) {
    if (typeof speechSynthesis === "undefined") { setTimeout(done, 400 + (m.say || m.text).length * 25); return; }
    const v = m.from === "atc" ? this.controllerVoice() : this.voiceFor(m.ac, m.speaker || 0);
    this.emit({ from: "engine", engine: "browser", voice: v.voice ? v.voice.name : "" });
    const { text } = this.prepare(m, v.voice ? { lang: v.voice.lang, respell: v.respell } : null);
    const u = new SpeechSynthesisUtterance(text);
    if (v.voice) { u.voice = v.voice; u.lang = v.voice.lang; }
    u.pitch = v.pitch; u.rate = Math.min(2, v.rate * this.rate); u.volume = 0.95 * this.gainFor(m.pos);
    const level = m.from === "atc" ? 0.012 : Math.min(0.09, 0.015 + km * 0.0018);
    this.burst(0.03, 0.25, m.pos);
    let stopBed = () => {}, finished = false;
    const fin = () => { if (finished) return; finished = true; stopBed(); this.burst(0.14, 0.18, m.pos); done(); };
    u.onstart = () => { stopBed = this.staticBed(level); };
    u.onend = fin; u.onerror = fin;
    setTimeout(fin, 2500 + text.length * 110); // safety if TTS stalls
    speechSynthesis.speak(u);
  }

  // ---------- ATIS loop ----------
  /** Loop an ATIS text on the ATIS "frequency" (quiet, controller voice). stopAtis() ends it. */
  async playAtis(text, pos = "ATIS") {
    this.stopAtis();
    const run = { on: true, text };
    this.atis = run;
    let buffer = null;
    if (this.useServer()) {
      try {
        const voice = await this.castController("ATIS");
        if (voice) {
          const { text: say, prosody } = this.prepare({ from: "atc", text, say: text, pos, kind: "atis" }, voice);
          const buf = await this.fetchRender(voice.id, say.slice(0, 600), prosody);
          if (buf) buffer = await this.audio().decodeAudioData(buf);
        }
      } catch { buffer = null; }
    }
    while (run.on && this.atis === run) {
      if (buffer) {
        this.emit({ from: "engine", engine: "atis", voice: "" });
        await this.playVoice(buffer, { km: 0, atc: true, pos: "ATIS" });
      } else if (typeof speechSynthesis !== "undefined") {
        await new Promise((res) => { const u = new SpeechSynthesisUtterance(text); const v = this.controllerVoice(); if (v.voice) u.voice = v.voice; u.rate = 0.95; u.volume = 0.6; u.onend = res; u.onerror = res; speechSynthesis.speak(u); setTimeout(res, 2000 + text.length * 90); });
      } else break;
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  stopAtis() { if (this.atis) { this.atis.on = false; this.atis = null; if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel(); } }

  /** Radio lab: the same call clean (A) and through the radio (B). */
  async lab(phrase = "Tallinn Tower, Finnair three two one, holding point runway two six, ready for departure") {
    const ctx = this.audio();
    let buffer = null;
    if (this.useServer()) {
      try {
        const voice = await this.castController("LAB");
        if (voice) { const buf = await this.fetchRender(voice.id, phrase, { rate: 1 }); if (buf) buffer = await ctx.decodeAudioData(buf); }
      } catch { buffer = null; }
    }
    if (!buffer) buffer = syntheticVoice(ctx, 2.6);
    this.emit({ from: "lab", step: "A (clean)" });
    const clean = ctx.createBufferSource(); clean.buffer = buffer; const g = ctx.createGain(); g.gain.value = 0.8; clean.connect(g).connect(this.master); clean.start();
    await new Promise(r => setTimeout(r, buffer.duration * 1000 + 600));
    this.emit({ from: "lab", step: `B (${PRESETS[this.preset] ? PRESETS[this.preset].label : "radio"} ${Math.round(this.effect * 100)} %)` });
    await this.playVoice(buffer, { km: 0, atc: false, pos: "ALL" });
    this.emit({ from: "lab", step: "done" });
  }
  selfTest(effect = this.effect, preset = this.preset) { return selfTest(effect, preset); }

  /** Which voice each nationality would get (settings table). Server casts are looked up asynchronously. */
  voiceTable() {
    return Object.keys(NAT_NAME).map(nat => {
      const v = pickVoice(this.voices, nat, 1, this.accents);
      return { nat, name: NAT_NAME[nat], voice: v.voice ? v.voice.name : "(none installed)", lang: v.voice ? v.voice.lang : "",
        native: v.native, respell: v.respell, fallback: v.fallback, english: !!ENGLISH_NATIVE[nat] };
    });
  }
  async serverVoiceTable() {
    const out = [];
    for (const nat of Object.keys(NAT_NAME)) {
      try {
        const r = await fetch("/api/tts/cast", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ nat, seed: 1 }) });
        out.push({ nat, name: NAT_NAME[nat], v: (await r.json()).voice });
      } catch { out.push({ nat, name: NAT_NAME[nat], v: null }); }
    }
    return out;
  }

  /** Speak the same phrase in every nationality's cast voice (settings "Test voices"). */
  testVoices(nats) {
    nats.forEach((nat, i) => this.enqueue({ from: "pilot", pos: "ALL", kind: "test", text: `${NAT_NAME[nat]} pilot`,
      say: `Tallinn Tower, Finnair three two one, ready for departure runway two six`,
      ac: { id: 9000 + i, nat, crew: [{ seed: 1 + i, pitch: 1, rate: 1 }], pos: [0, 0] } }, 0.2 + i * 0.1));
  }

  /** Stop speaking and drop pending transmissions (e.g. airport change). */
  reset() {
    for (const c of this.channels.values()) { c.queue = []; c.busy = false; if (c.timer) clearTimeout(c.timer); c.stuckUntil = 0; }
    if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
    this.ctlCast = {};
    this.pre.clear();
    this.stopAtis();
  }
}

/** A vowel-like buzz for the radio lab when no TTS is available: glottal pulses through two formants, syllabic. */
function syntheticVoice(ctx, sec) {
  const sr = ctx.sampleRate, buf = ctx.createBuffer(1, Math.floor(sr * sec), sr), d = buf.getChannelData(0);
  let phase = 0, y1 = 0, y2 = 0, z1 = 0, z2 = 0;
  const f0 = 118;
  for (let i = 0; i < d.length; i++) {
    const t = i / sr;
    phase += f0 * (1 + 0.04 * Math.sin(2 * Math.PI * 3 * t)) / sr; if (phase >= 1) phase -= 1;
    const pulse = Math.pow(1 - phase, 6) * 2 - 0.3;
    const syll = Math.max(0, Math.sin(2 * Math.PI * 3.2 * t)) ** 0.6 * (t > 0.1 && t < sec - 0.15 ? 1 : 0);
    const vowel = Math.floor(t * 3.2) % 3;
    const F1 = [650, 400, 800][vowel], F2 = [1200, 1900, 1400][vowel];
    const r1 = Math.exp(-2 * Math.PI * 90 / sr), r2 = Math.exp(-2 * Math.PI * 120 / sr);
    const a1 = 2 * r1 * Math.cos(2 * Math.PI * F1 / sr), a2 = 2 * r2 * Math.cos(2 * Math.PI * F2 / sr);
    const o1 = pulse + a1 * y1 - r1 * r1 * y2; y2 = y1; y1 = o1;
    const o2 = pulse + a2 * z1 - r2 * r2 * z2; z2 = z1; z1 = o2;
    d[i] = (o1 * 0.03 + o2 * 0.02) * syll;
  }
  return buf;
}
