// Radio: queued transmissions per frequency, pilot voices (Web Speech) with nationality accents, and the
// radio feel around them with Web Audio: squelch click, band-passed static + crackle during speech
// (louder when the aircraft is far away), squelch tail, and blocked transmissions (heterodyne squeal).
// Web Speech output cannot be routed through Web Audio, so the effect is layered around it.
import { pickVoice, respell } from "./voices.js";
import { NAT_NAME, ENGLISH_NATIVE } from "./data.js";

export { sayNumbers as sayify } from "./phrase.js";

export class Radio {
  constructor() {
    this.queue = [];
    this.busy = false;
    this.tts = true;
    this.accents = "natural";     // off | natural | strong
    this.effect = 0.6;            // radio effect strength 0..1
    this.rate = 1.0;              // speech rate multiplier
    this.blocked = true;          // simulate blocked transmissions
    this.blockedRate = 0.05;
    this.audible = null;          // Set of position keys to play (null = all)
    this.ctx = null;
    this.listeners = [];
    this.voices = [];
    this.voiceCache = new Map();
    const load = () => { this.voices = speechSynthesis.getVoices(); this.voiceCache.clear(); this.emit({ from: "voices" }); };
    if (typeof speechSynthesis !== "undefined") { load(); speechSynthesis.onvoiceschanged = load; }
  }

  on(fn) { this.listeners.push(fn); }
  emit(msg) { for (const f of this.listeners) f(msg); }

  audio() {
    if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (this.ctx.state === "suspended") this.ctx.resume().catch(() => {});
    return this.ctx;
  }

  // ---------- sound effects ----------
  noiseBuffer(sec) {
    const ctx = this.audio(), len = Math.floor(ctx.sampleRate * sec);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) {
      let x = Math.random() * 2 - 1;
      if (Math.random() < 0.0009) x += (Math.random() < 0.5 ? -1 : 1) * (2 + Math.random() * 3); // crackle
      d[i] = x * 0.5;
    }
    return buf;
  }
  bandpass(ctx) {
    const hp = ctx.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 300;
    const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 3000;
    hp.connect(lp);
    return { input: hp, output: lp };
  }
  /** Short burst: squelch click (start) or tail (end). */
  burst(dur, gain) {
    if (this.effect <= 0) return;
    try {
      const ctx = this.audio(), src = ctx.createBufferSource();
      src.buffer = this.noiseBuffer(dur);
      const bp = this.bandpass(ctx), g = ctx.createGain();
      g.gain.setValueAtTime(gain * this.effect, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
      src.connect(bp.input); bp.output.connect(g).connect(ctx.destination); src.start();
    } catch { /* audio unavailable */ }
  }
  /** Static bed during a transmission; returns a stop() function. */
  staticBed(level) {
    if (this.effect <= 0) return () => {};
    try {
      const ctx = this.audio(), src = ctx.createBufferSource();
      src.buffer = this.noiseBuffer(2); src.loop = true;
      const bp = this.bandpass(ctx), g = ctx.createGain();
      g.gain.value = 0.0001;
      g.gain.linearRampToValueAtTime(level * this.effect, ctx.currentTime + 0.05);
      src.connect(bp.input); bp.output.connect(g).connect(ctx.destination); src.start();
      return () => { try { g.gain.linearRampToValueAtTime(0.0001, ctx.currentTime + 0.08); src.stop(ctx.currentTime + 0.1); } catch { /* */ } };
    } catch { return () => {}; }
  }
  /** Two carriers beating against each other: the squeal of a blocked transmission. */
  heterodyne(sec = 1.4) {
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
  /** Which voice each nationality would get (for the settings table). */
  voiceTable() {
    return Object.keys(NAT_NAME).map(nat => {
      const v = pickVoice(this.voices, nat, 1, this.accents);
      return { nat, name: NAT_NAME[nat], voice: v.voice ? v.voice.name : "(none installed)", lang: v.voice ? v.voice.lang : "",
        native: v.native, respell: v.respell, fallback: v.fallback, english: !!ENGLISH_NATIVE[nat] };
    });
  }

  // ---------- transmissions ----------
  /** Controller (user) transmission: shown immediately. */
  controller(text, pos) { this.emit({ from: "atc", text, pos }); }

  /**
   * Queue a pilot or AI-controller transmission.
   * m: { from: "pilot"|"atc", ac?, text, say?, pos, speaker?, ai? }
   */
  enqueue(m, delay) {
    const sameFreq = this.queue.filter(q => q.pos === m.pos).length + (this.busy ? 1 : 0);
    const d = delay ?? (m.from === "atc" ? 0.8 + Math.random() * 1.2 : 0.5 + Math.random() * 2.0);
    this.queue.push({ ...m, readyAt: performance.now() + (d + sameFreq * 1.2) * 1000 });
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
    // two pilots keying at the same moment on the same frequency
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

  transmit(m) {
    this.busy = true;
    this.emit(m);
    const audible = this.tts && typeof speechSynthesis !== "undefined" && (!this.audible || this.audible.has(m.pos) || m.pos === "ALL");
    const textSaid = m.say || m.text;
    const finish = () => { this.burst(0.14, 0.18); setTimeout(() => { this.busy = false; this.pump(); }, 350); };
    if (!audible) {
      setTimeout(() => { this.busy = false; this.pump(); }, 300 + textSaid.length * 20);
      return;
    }
    const v = m.from === "atc" ? this.controllerVoice() : this.voiceFor(m.ac, m.speaker || 0);
    const u = new SpeechSynthesisUtterance(v.respell ? respell(textSaid, v.lang) : textSaid);
    if (v.voice) { u.voice = v.voice; u.lang = v.voice.lang; }
    u.pitch = v.pitch; u.rate = Math.min(2, v.rate * this.rate); u.volume = 0.95;
    // static louder for distant aircraft (km from the field)
    const km = m.ac && m.ac.pos ? Math.hypot(m.ac.pos[0], m.ac.pos[1]) / 1000 : 0;
    const level = m.from === "atc" ? 0.012 : Math.min(0.09, 0.015 + km * 0.0018);
    this.burst(0.03, 0.25);
    let stopBed = () => {};
    let finished = false;
    const fin = () => { if (finished) return; finished = true; stopBed(); finish(); };
    u.onstart = () => { stopBed = this.staticBed(level); };
    u.onend = fin; u.onerror = fin;
    setTimeout(fin, 2500 + textSaid.length * 110); // safety if TTS stalls
    speechSynthesis.speak(u);
  }

  /** Speak one sample per nationality (settings "Test voices"). */
  testVoices(nats) {
    nats.forEach((nat, i) => this.enqueue({ from: "pilot", pos: "ALL", text: `${NAT_NAME[nat]} pilot`,
      say: `Cleared to land runway two six, ${NAT_NAME[nat]} one two three`,
      ac: { id: 9000 + i, nat, crew: [{ seed: 1, pitch: 1, rate: 1 }], pos: [0, 0] } }, 0.2));
  }

  /** Stop speaking and drop pending transmissions (e.g. airport change). */
  reset() {
    this.queue = [];
    if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
    this.busy = false;
  }
}
