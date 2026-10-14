// Radio: queued transmissions per frequency and the voices on them.
//
// Voice path (Settings → Voices → engine):
//   server  neural TTS rendered by server.py (Azure / edge-tts / Piper / Kokoro / ElevenLabs, see tts.py), played
//           through a REAL radio chain in Web Audio: band-pass 300–3400 Hz, compressor, light saturation, noise and
//           crackle under the voice, fading with distance, occasional clipping, cockpit hum, squelch open/close.
//   browser Web Speech API (last fallback; prefers "Natural"/"Online" voices). Web Speech can't be routed through
//           Web Audio, so the radio feel is layered around it (click, static bed, tail).
// Rendering starts as soon as a call is queued, in parallel with the pilot's 0.5–2.5 s reaction delay.
import { pickVoice, respell } from "./voices.js";
import { NAT_NAME, ENGLISH_NATIVE, controllerNat } from "./data.js";

export { sayNumbers as sayify } from "./phrase.js";
export { controllerNat };

export class Radio {
  constructor() {
    this.queue = [];
    this.busy = false;
    this.tts = true;
    this.engine = "auto";         // auto | server | browser
    this.accents = "natural";     // off | natural | strong
    this.effect = 0.6;            // radio effect strength 0..1 (0 = clean voice)
    this.rate = 1.0;              // speech rate multiplier
    this.blocked = true;          // simulate blocked transmissions
    this.blockedRate = 0.05;
    this.human = 0.12;            // rate of human touches ("uh", breath, "...and")
    this.respellLangs = { et: true, fi: true, lv: true, lt: true, de: false };
    this.audible = null;          // Set of position keys to play (null = all)
    this.airport = "";
    this.muted = false;           // pop-out windows never play audio
    this.ctx = null;
    this.listeners = [];
    this.voices = [];
    this.voiceCache = new Map();
    this.server = { neural: false, checked: false, banner: null };
    this.loadBrowserVoices();
  }

  on(fn) { this.listeners.push(fn); }
  emit(msg) { for (const f of this.listeners) f(msg); }

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
      this.server = { neural: !!s.neural, checked: true, banner: s.banner, engines: s.engines, config: s.config };
    } catch { this.server = { neural: false, checked: true, banner: "Voice server unreachable — using browser voices." }; }
    this.emit({ from: "voices" });
    return this.server;
  }
  useServer() { return this.tts && this.engine !== "browser" && this.server.neural; }

  audio() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      if (this.sinkId && typeof this.ctx.setSinkId === "function") this.ctx.setSinkId(this.sinkId).catch(() => {});
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

  // ---------- sound effects ----------
  noiseBuffer(sec, crackle = 0.0009) {
    const ctx = this.audio(), len = Math.floor(ctx.sampleRate * sec);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) {
      let x = Math.random() * 2 - 1;
      if (Math.random() < crackle) x += (Math.random() < 0.5 ? -1 : 1) * (2 + Math.random() * 3);
      d[i] = x * 0.5;
    }
    return buf;
  }
  bandpass(ctx, lo = 300, hi = 3000) {
    const hp = ctx.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = lo;
    const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = hi;
    hp.connect(lp);
    return { input: hp, output: lp };
  }
  /** Short burst: squelch click (start) or tail (end). */
  burst(dur, gain) {
    if (this.effect <= 0 || this.muted) return;
    try {
      const ctx = this.audio(), src = ctx.createBufferSource();
      src.buffer = this.noiseBuffer(dur);
      const bp = this.bandpass(ctx), g = ctx.createGain();
      g.gain.setValueAtTime(gain * this.effect, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
      src.connect(bp.input); bp.output.connect(g).connect(ctx.destination); src.start();
    } catch { /* audio unavailable */ }
  }
  /** Static bed; returns stop(). */
  staticBed(level, dest) {
    if (this.effect <= 0 || this.muted) return () => {};
    try {
      const ctx = this.audio(), src = ctx.createBufferSource();
      src.buffer = this.noiseBuffer(2); src.loop = true;
      const bp = this.bandpass(ctx), g = ctx.createGain();
      g.gain.value = 0.0001;
      g.gain.linearRampToValueAtTime(level * this.effect, ctx.currentTime + 0.05);
      src.connect(bp.input); bp.output.connect(g).connect(dest || ctx.destination); src.start();
      return () => { try { g.gain.linearRampToValueAtTime(0.0001, ctx.currentTime + 0.08); src.stop(ctx.currentTime + 0.1); } catch { /* */ } };
    } catch { return () => {}; }
  }
  /** Cockpit background: low engine/airflow hum and a faint whine. */
  cockpitBed(level) {
    if (this.effect <= 0 || this.muted || level <= 0) return () => {};
    try {
      const ctx = this.audio(), t = ctx.currentTime;
      const src = ctx.createBufferSource(); src.buffer = this.noiseBuffer(2, 0); src.loop = true;
      const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 260;
      const osc = ctx.createOscillator(); osc.frequency.value = 410 + Math.random() * 60;
      const og = ctx.createGain(); og.gain.value = 0.08;
      const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(level * this.effect, t + 0.1);
      src.connect(lp).connect(g); osc.connect(og).connect(g); g.connect(ctx.destination);
      src.start(); osc.start();
      return () => { try { g.gain.linearRampToValueAtTime(0.0001, ctx.currentTime + 0.1); src.stop(ctx.currentTime + 0.12); osc.stop(ctx.currentTime + 0.12); } catch { /* */ } };
    } catch { return () => {}; }
  }
  chime() {
    try {
      const ctx = this.audio(), t = ctx.currentTime;
      for (const [f, dt] of [[1046, 0], [784, 0.35]]) {
        const o = ctx.createOscillator(), g = ctx.createGain(); o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, t + dt); g.gain.linearRampToValueAtTime(0.012 * this.effect, t + dt + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + dt + 0.6);
        o.connect(g).connect(ctx.destination); o.start(t + dt); o.stop(t + dt + 0.65);
      }
    } catch { /* */ }
  }
  /** Two carriers beating against each other: the squeal of a blocked transmission. */
  heterodyne(sec = 1.4) {
    if (this.muted) return;
    try {
      const ctx = this.audio(), t = ctx.currentTime;
      const o1 = ctx.createOscillator(), o2 = ctx.createOscillator(), g = ctx.createGain();
      const vol = 0.06 * Math.max(0.3, this.effect);
      o1.frequency.value = 1150; o2.frequency.setValueAtTime(1150 + 380, t); o2.frequency.linearRampToValueAtTime(1150 + 520, t + sec);
      g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(vol, t + 0.05);
      g.gain.setValueAtTime(vol, t + sec - 0.1); g.gain.linearRampToValueAtTime(0.0001, t + sec);
      o1.connect(g); o2.connect(g); g.connect(ctx.destination);
      o1.start(t); o2.start(t); o1.stop(t + sec); o2.stop(t + sec);
      const stop = this.staticBed(0.05); setTimeout(stop, sec * 1000);
    } catch { /* audio unavailable */ }
  }

  /**
   * Play decoded voice audio through the radio chain. Returns a promise that resolves when done.
   * km: distance from the field; loud: clip this transmission; atc: controller (less noise, no cockpit)
   */
  playVoice(buffer, { km = 0, loud = false, atc = false } = {}) {
    const ctx = this.audio();
    const src = ctx.createBufferSource(); src.buffer = buffer;
    const e = this.effect;
    const out = ctx.createGain(); out.connect(ctx.destination);
    if (e <= 0) { src.connect(out); out.gain.value = 0.9; }
    else {
      const pre = ctx.createGain(); pre.gain.value = loud ? 2.6 : 1.15;
      const sat = ctx.createWaveShaper();
      const curve = new Float32Array(1024), drive = 1 + e * (loud ? 5 : 2.2);
      for (let i = 0; i < 1024; i++) { const x = i / 511.5 - 1; curve[i] = Math.tanh(x * drive) / Math.tanh(drive); }
      sat.curve = curve;
      const bp = this.bandpass(ctx, 300, 3400);
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -24; comp.ratio.value = 6; comp.attack.value = 0.003; comp.release.value = 0.15;
      const fade = ctx.createGain();
      fade.gain.value = Math.max(0.45, 1 - Math.min(0.55, km / 90)) * 0.95;       // signal fades with distance
      // wet/dry: e=1 fully radio, small e keeps some of the clean voice
      const wet = ctx.createGain(), dry = ctx.createGain();
      wet.gain.value = Math.min(1, 0.35 + e); dry.gain.value = Math.max(0, 0.65 - e);
      src.connect(pre).connect(sat).connect(bp.input); bp.output.connect(comp).connect(fade).connect(wet).connect(out);
      src.connect(dry).connect(out);
      // slow random fading (AM-style) for distant aircraft
      if (km > 15) {
        const lfo = ctx.createOscillator(), lg = ctx.createGain();
        lfo.frequency.value = 0.4 + Math.random() * 0.8; lg.gain.value = Math.min(0.25, km / 400);
        lfo.connect(lg).connect(fade.gain); lfo.start(); setTimeout(() => { try { lfo.stop(); } catch { /* */ } }, (buffer.duration + 1) * 1000);
      }
    }
    const level = atc ? 0.008 : Math.min(0.06, 0.012 + km * 0.0012);
    const stopBed = this.staticBed(level, out);
    const stopCockpit = atc ? () => {} : this.cockpitBed(0.018);
    return new Promise((resolve) => {
      src.onended = () => { stopBed(); stopCockpit(); resolve(); };
      src.start(ctx.currentTime + 0.04);
    });
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

  /** Server voice for a crew member: cast once per flight, never the same voice as another aircraft on the frequency. */
  castServer(ac, speaker, pos) {
    ac.cast ||= {};
    if (ac.cast[speaker]) return ac.cast[speaker];
    const m = (ac.crew && ac.crew[speaker]) || { seed: (ac.id || 1) * 7919 };
    const nat = this.accents === "off" ? (ENGLISH_NATIVE[ac.nat] ? ac.nat : "GB") : (ac.nat || "GB");
    const gender = m.gender || (Math.abs(m.seed) % 100 < 9 ? "F" : "M");   // ~9% female pilots
    const exclude = [];
    for (const o of this.onFrequency ? this.onFrequency(pos) : []) {
      if (o === ac || !o.cast) continue;
      for (const p of Object.values(o.cast)) if (p && p.id) exclude.push(p.id);
    }
    ac.cast[speaker] = fetch("/api/tts/cast", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nat, seed: m.seed, gender, exclude, role: "pilot" }) })
      .then(r => r.json()).then(j => { ac.cast[speaker] = j.voice; return j.voice; })
      .catch(() => { ac.cast[speaker] = null; return null; });
    return ac.cast[speaker];
  }
  castController(pos) {
    this.ctlCast ||= {};
    if (!this.ctlCast[pos]) {
      const nat = this.accents === "off" ? "GB" : controllerNat(this.airport);
      this.ctlCast[pos] = fetch("/api/tts/cast", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nat, seed: [...String(pos)].reduce((s, c) => s + c.charCodeAt(0), 11), role: "controller" }) })
        .then(r => r.json()).then(j => { this.ctlCast[pos] = j.voice; return j.voice; }).catch(() => null);
    }
    return this.ctlCast[pos];
  }

  /** Natural delivery: occasional "uh" before numbers, "...and" before the callsign. Spoken text only. */
  humanize(s, busy) {
    if (this.human <= 0) return s;
    if (Math.random() < this.human * (busy ? 0.5 : 1)) s = s.replace(/(squawk|runway|contact \w+|climb|descend) (?=[a-z]+ [a-z]+)/i, "$1, uh, ");
    if (Math.random() < this.human * 0.4) s = s.replace(/, ([A-Z][a-z]+(?: [A-Z][a-z]+)? [a-z-]+(?: [a-z-]+){1,3})$/, ", and $1");
    return s;
  }

  /** Spoken text + prosody for a transmission (accent respelling only where the voice needs it). */
  prepare(m, voice) {
    const busy = this.queue.filter(q => q.pos === m.pos).length > 1;
    let text = m.say || m.text;
    if (!voice || !/^et/i.test(voice.lang || "")) text = text.replace(/\bhead aega\b/gi, "bye");
    text = this.humanize(text, busy);
    const lang2 = String((voice && voice.lang) || "").slice(0, 2).toLowerCase();
    if (voice && voice.respell && this.respellLangs[lang2]) text = respell(text, voice.lang);
    const crew = m.ac && m.ac.crew && m.ac.crew[m.speaker || 0];
    let rate = (crew ? crew.rate : 1) * this.rate;
    if (m.kind === "readback") rate *= 1.06;           // routine readbacks a little quicker
    else if (m.kind && m.kind !== "readback") rate *= 0.97;  // initial calls slower and clearer
    if (busy) rate *= 1.06;
    const pitch = crew ? (crew.pitch - 1) * 18 : 0;
    return { text, prosody: { rate: Math.round(rate * 100) / 100, pitch: Math.round(pitch) } };
  }

  /** Start rendering on the server right away (runs during the pilot's reaction delay). */
  prerender(m) {
    if (!this.useServer() || this.muted || m.from === "blocked") return;
    const voiceP = m.from === "atc" ? this.castController(m.pos) : this.castServer(m.ac, m.speaker || 0, m.pos);
    m.render = Promise.resolve(m.voiceId ? { id: m.voiceId } : voiceP).then(async (voice) => {
      if (!voice) return null;
      m.voiceId = voice.id;
      const { text, prosody } = this.prepare(m, voice);
      const r = await fetch("/api/tts/speak", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ voice: voice.id, text, prosody }) });
      if (!r.ok) return null;
      return r.arrayBuffer();
    }).catch(() => null);
  }

  // ---------- transmissions ----------
  /** Controller (user) transmission: shown immediately. */
  controller(text, pos) { this.emit({ from: "atc", text, pos }); }

  /**
   * Queue a pilot or AI-controller transmission.
   * m: { from: "pilot"|"atc", ac?, text, say?, pos, speaker?, ai?, kind?, voiceId? }
   */
  enqueue(m, delay) {
    const sameFreq = this.queue.filter(q => q.pos === m.pos).length + (this.busy ? 1 : 0);
    const d = delay ?? (m.from === "atc" ? 0.8 + Math.random() * 1.2 : 0.5 + Math.random() * 2.0);
    const item = { ...m, readyAt: performance.now() + (d + sameFreq * 1.2) * 1000 };
    if (!this.audible || this.audible.has(m.pos) || m.pos === "ALL") this.prerender(item);
    this.queue.push(item);
    this.pump();
  }
  /** Legacy API. */
  pilot(ac, text, delay) { this.enqueue({ from: "pilot", ac, text, say: undefined, pos: ac.freq }, delay); }

  pump() {
    if (this.busy || !this.queue.length) return;
    this.queue.sort((a, b) => a.readyAt - b.readyAt);
    const wait = Math.max(0, this.queue[0].readyAt - performance.now());
    if (this.pumpTimer) clearTimeout(this.pumpTimer);
    this.pumpTimer = setTimeout(() => this.next(), wait);
  }

  next() {
    this.pumpTimer = null;
    if (this.busy || !this.queue.length) return;
    const now = performance.now();
    const m = this.queue.shift();
    const rival = this.blocked && m.from === "pilot" &&
      this.queue.find(q => q.from === "pilot" && q.pos === m.pos && q.readyAt - now < 400 && q.ac !== m.ac);
    if (rival && Math.random() < Math.max(this.blockedRate, 0.35)) return this.block(m, rival);
    if (!rival && this.blocked && m.from === "pilot" && !m.retried && Math.random() < this.blockedRate * 0.3) {
      return this.block(m, null); // a station we cannot see steps on this call
    }
    this.transmit(m);
  }

  block(m, rival) {
    this.busy = true;
    const audible = !this.audible || this.audible.has(m.pos);
    if (audible) this.heterodyne(1.2 + Math.random() * 0.6);
    this.emit({ from: "blocked", pos: m.pos, ac: m.ac, rival: rival && rival.ac });
    const retry = (x) => { x.readyAt = performance.now() + (3 + Math.random() * 4) * 1000; x.retried = true; };
    retry(m); this.queue.push(m);
    if (rival) retry(rival);
    setTimeout(() => { this.busy = false; this.pump(); }, 1700);
  }

  async transmit(m) {
    this.busy = true;
    this.emit(m);
    const audible = this.tts && !this.muted && (!this.audible || this.audible.has(m.pos) || m.pos === "ALL");
    const textSaid = m.say || m.text;
    const done = () => { this.burst(0.14, 0.18); setTimeout(() => { this.busy = false; this.pump(); }, 350); };
    if (!audible) { setTimeout(() => { this.busy = false; this.pump(); }, 300 + textSaid.length * 20); return; }
    const km = m.ac && m.ac.pos ? Math.hypot(m.ac.pos[0], m.ac.pos[1]) / 1000 : 0;
    // server neural voice through the real radio chain
    if (m.render) {
      const buf = await Promise.race([m.render, new Promise(r => setTimeout(() => r(null), 4500))]);
      if (buf) {
        try {
          const audio = await this.audio().decodeAudioData(buf.slice(0));
          this.emit({ from: "engine", engine: String(m.voiceId || "").split(":")[0] || "server", voice: m.voiceId || "" });
          if (m.from === "pilot" && Math.random() < this.human * 0.5) this.burst(0.18, 0.05); // a breath before keying
          this.burst(0.03, 0.25);
          if (m.from === "pilot" && Math.random() < 0.03) this.chime();
          await this.playVoice(audio, { km, loud: m.from === "pilot" && Math.random() < 0.08, atc: m.from === "atc" });
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
    u.pitch = v.pitch; u.rate = Math.min(2, v.rate * this.rate); u.volume = 0.95;
    const level = m.from === "atc" ? 0.012 : Math.min(0.09, 0.015 + km * 0.0018);
    this.burst(0.03, 0.25);
    let stopBed = () => {}, finished = false;
    const fin = () => { if (finished) return; finished = true; stopBed(); done(); };
    u.onstart = () => { stopBed = this.staticBed(level); };
    u.onend = fin; u.onerror = fin;
    setTimeout(fin, 2500 + text.length * 110); // safety if TTS stalls
    speechSynthesis.speak(u);
  }

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
    this.queue = [];
    if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
    this.busy = false;
    this.ctlCast = {};
  }
}
