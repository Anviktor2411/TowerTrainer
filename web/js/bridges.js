// Browser side of the EuroScope (FSD) and XRadio bridges: periodic sync with server.py, and XRadio voice
// (WebCodecs Opus decode for real pilots, encode for push-to-talk). Everything degrades to text.
const FT_M = 0.3048;

/** Aircraft as the bridges want them: lat/lon from the airport's local projection, MSL altitude. */
export function bridgeAircraft(sim, apt, { ownOnly = false } = {}) {
  const elevFt = apt.d.elevation || 0;
  return sim.ac.filter(a => !ownOnly || !a.human).map(a => {
    const [lat, lon] = apt.toLatLon(a.pos);
    const altFt = elevFt + (a.onGround ? 0 : a.alt);
    const pos = sim.positions && sim.positions[a.freq];
    return {
      cs: a.cs, squawk: a.squawk || "2000", mode: a.xpdr || "C", ident: !!a.identUntil, lat, lon, alt: Math.round(altFt),
      alt_m: altFt * FT_M, gs: Math.round(a.spd / 0.514444), gs_ms: a.spd, hdg: a.hdg, onGround: !!a.onGround, on_ground: !!a.onGround,
      type: a.type, wtc: a.wtc, dep: a.kind === "arr" ? a.other[0] : apt.icao, dest: a.kind === "arr" ? apt.icao : (a.other[0] === "VFR" ? "" : a.other[0]),
      route: a.sid ? `${a.sid} DCT` : "DCT", cfl: a.cfl || 5000, tas: a.ga ? 110 : 280, vfr: !!a.ga, nat: a.nat || "",
      xpdr: a.xpdr || "C", khz: pos ? Math.round(pos.mhz * 1000) : 0, human: !!a.human,
    };
  });
}

export class Bridges {
  constructor({ getSim, getApt, onEsMessage, onEsStatus, onXrStatus, onXrText, log }) {
    Object.assign(this, { getSim, getApt, onEsMessage, onEsStatus, onXrStatus, onXrText, log });
    this.esTx = [];      // pilot transmissions for EuroScope
    this.xrTx = [];      // transmissions for XRadio
    this.xr = { enabled: false };
    this.voice = null;
    setInterval(() => this.esSync(), 1000);
    setInterval(() => this.xrSync(), 400);
  }

  /** Every pilot / AI-controller / user transmission passes here. */
  transmission({ from, ac, text, pos, ai }) {
    const sim = this.getSim();
    if (!sim) return;
    const p = sim.positions && sim.positions[pos];
    const mhz = p ? p.mhz : (sim.apt.freq.tower ? sim.apt.freq.tower.mhz : 118.1);
    if (from === "pilot" && ac && !ac.human) this.esTx.push({ cs: ac.cs, freq: mhz, text });
    if (this.xr.enabled && this.xr.text) this.xrTx.push({ kind: from === "pilot" ? "pilot" : "atc", cs: ac ? ac.cs : "", khz: Math.round(mhz * 1000), text });
  }

  async esSync() {
    const sim = this.getSim(), apt = this.getApt();
    if (!sim || !apt || document.hidden && !this.esActive) return;
    const tx = this.esTx.splice(0);
    try {
      const r = await fetch("/api/es/sync", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ aircraft: bridgeAircraft(sim, apt, { ownOnly: true }), tx }) });
      const j = await r.json();
      this.esActive = !!(j.status && j.status.controllers && j.status.controllers.length);
      this.onEsStatus(j.status);
      for (const m of j.messages || []) this.onEsMessage(m);
    } catch { this.onEsStatus(null); }
  }

  // ---------- XRadio ----------
  async configureXr(cfg) {
    this.xr = { ...cfg };
    try {
      const body = { enabled: !!cfg.enabled, host: cfg.host || "127.0.0.1", port: +cfg.port || 49100, password: cfg.password || "",
        atc_cs: cfg.cs || "", freq_khz: Math.round((parseFloat(cfg.freq) || 0) * 1000), ai_traffic: !!cfg.ai, real_pilots: !!cfg.humans,
        text: !!cfg.text, voice: !!cfg.voice };
      const r = await fetch("/api/xradio/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      this.onXrStatus(await r.json());
    } catch (e) { this.onXrStatus({ error: String(e) }); }
    if (cfg.enabled && cfg.voice) this.startVoice(); else this.stopVoice();
  }

  async xrSync() {
    const sim = this.getSim(), apt = this.getApt();
    if (!this.xr.enabled || !sim || !apt) return;
    const center = { lat: apt.d.lat, lon: apt.d.lon, elev_m: (apt.d.elevation || 0) * FT_M };
    const positions = [];
    if (sim.split) {
      for (const p of Object.values(sim.positions)) if (sim.userWorks(p.key)) positions.push({ cs: p.key === "TWR" && this.xr.cs ? this.xr.cs : p.cs, khz: Math.round(p.mhz * 1000) });
    } else {
      const mhz = parseFloat(this.xr.freq) || (apt.freq.tower ? apt.freq.tower.mhz : 118.1);
      positions.push({ cs: this.xr.cs || `${apt.icao}_TWR`, khz: Math.round(mhz * 1000) });
    }
    const body = { center, positions, aircraft: this.xr.ai ? bridgeAircraft(sim, apt, { ownOnly: true }) : [], tx: this.xrTx.splice(0) };
    try {
      const r = await fetch("/api/xradio/sync", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json();
      this.onXrStatus(j);
      if (this.xr.humans) for (const h of j.humans || []) {
        const pos = apt.toXY(h.lat, h.lon);
        sim.upsertHuman({ hid: h.hid, cs: h.cs, type: h.type, pos, alt: Math.max(0, h.alt_m / FT_M - (apt.d.elevation || 0)),
          hdg: h.hdg, spd: h.gs_ms, onGround: h.on_ground, squawk: h.squawk, xpdr: h.xpdr >= 3 ? "C" : "S" });
      }
      for (const t of j.texts || []) this.onXrText(t);
    } catch { /* server down */ }
  }

  // ---------- XRadio voice (stretch goal; text keeps working without it) ----------
  startVoice() {
    if (this.voice || typeof AudioDecoder === "undefined") {
      if (typeof AudioDecoder === "undefined") this.log("XRadio voice needs WebCodecs (Chrome/Edge) — staying on text.");
      return;
    }
    const ctx = new AudioContext({ sampleRate: 48000 });
    const v = this.voice = { ctx, decoders: new Map(), playhead: 0, es: new EventSource("/api/xradio/events"), enc: null };
    v.es.onmessage = (e) => {
      for (const f of JSON.parse(e.data)) {
        let dec = v.decoders.get(f.sid);
        if (!dec) {
          try {
            dec = new AudioDecoder({ output: (ad) => this.play(ad), error: (er) => this.log("Opus decode: " + er.message) });
            dec.configure({ codec: "opus", sampleRate: 48000, numberOfChannels: 1 });
            v.decoders.set(f.sid, dec);
          } catch (er) { this.log("Opus decoder unavailable: " + er.message); return; }
        }
        const bytes = Uint8Array.from(atob(f.opus), c => c.charCodeAt(0));
        try { dec.decode(new EncodedAudioChunk({ type: "key", timestamp: f.seq * 20000, data: bytes })); } catch { /* bad frame */ }
      }
    };
  }
  play(ad) {
    const v = this.voice; if (!v) { ad.close(); return; }
    const n = ad.numberOfFrames, buf = v.ctx.createBuffer(1, n, 48000), data = new Float32Array(n);
    ad.copyTo(data, { planeIndex: 0, format: "f32-planar" }); ad.close();
    buf.copyToChannel(data, 0);
    const src = v.ctx.createBufferSource(); src.buffer = buf; src.connect(v.ctx.destination);
    const now = v.ctx.currentTime;
    if (v.playhead < now + 0.05) v.playhead = now + 0.08;   // small jitter buffer
    src.start(v.playhead); v.playhead += n / 48000;
  }
  stopVoice() {
    if (!this.voice) return;
    this.voice.es.close();
    for (const d of this.voice.decoders.values()) try { d.close(); } catch { /* */ }
    this.voice.ctx.close();
    this.voice = null;
  }

  /** Push-to-talk on XRadio: capture mic, encode 20 ms Opus frames, send while keyed. */
  async keyMic(on, khz) {
    if (!this.voice || !this.xr.voice) return;
    const v = this.voice;
    if (!on) { v.keyed = false; if (v.flush) v.flush(); return; }
    try {
      if (!v.stream) {
        v.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, sampleRate: 48000, echoCancellation: true } });
        const pending = [];
        v.flush = () => {
          if (!pending.length) return;
          const frames = pending.splice(0);
          fetch("/api/xradio/voice", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ khz: v.khz, frames }) }).catch(() => {});
        };
        setInterval(() => v.flush(), 100);
        v.enc = new AudioEncoder({
          output: (chunk) => { if (!v.keyed) return; const b = new Uint8Array(chunk.byteLength); chunk.copyTo(b); pending.push(btoa(String.fromCharCode(...b))); },
          error: (e) => this.log("Opus encode: " + e.message),
        });
        const track = v.stream.getAudioTracks()[0];
        const rate = track.getSettings().sampleRate || 48000;
        v.enc.configure({ codec: "opus", sampleRate: rate, numberOfChannels: 1, bitrate: 24000, opus: { frameDuration: 20000 } });
        const proc = new MediaStreamTrackProcessor({ track });
        const reader = proc.readable.getReader();
        (async () => { for (;;) { const { value, done } = await reader.read(); if (done) break; if (v.keyed) v.enc.encode(value); value.close(); } })();
      }
      v.khz = khz; v.keyed = true;
    } catch (e) { this.log("XRadio mic unavailable (" + e.message + ") — text only."); }
  }
}
