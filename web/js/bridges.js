// Browser side of the EuroScope (FSD) and XRadio bridges: periodic sync with server.py, and XRadio voice
// (WebCodecs Opus decode for real pilots, encode for push-to-talk; without WebCodecs the server does the
// codec work and the browser moves PCM). Everything degrades to text.
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
      route: a.route ? (a.sid ? `${a.sid} ${a.route}` : a.route) : (a.sid ? `${a.sid} DCT` : "DCT"), cfl: a.cfl || 5000, tas: a.ga ? 110 : 280, vfr: !!a.ga, nat: a.nat || "",
      simbrief: !!a.simbrief, equip: a.equip || "", rfl: a.rfl || 0, altn: a.altn || "", remarks: a.remarks || "", eobt: a.eobt || "", reg: a.reg || "",
      tas_plan: a.plan && a.plan.cruise_tas ? a.plan.cruise_tas : 0,
      xpdr: a.xpdr || "C", khz: pos ? Math.round(pos.mhz * 1000) : 0, human: !!a.human,
    };
  });
}

/** A short "how to fly with TowerTrainer ATC" for XRadio pilots, shown in Settings. */
export const XR_PILOT_HELP = [
  "In X-Plane, open the XRadio window: the ATC online list shows this station and its frequency — click it to tune COM1.",
  "Tune the ATIS on COM2 (click the ATIS entry) and note the information letter; say it on first contact.",
  "File a flight plan in XRadio → Settings → ATC (departure, destination, route); the clearance and squawk come back there.",
  "Talk with push-to-talk on the frequency, or type in the Say field. @CALLSIGN sends a private message; 121.500 is guard.",
  "Standard phraseology works best: callsign first, read back runway, squawk and clearances.",
];

export class Bridges {
  constructor({ getSim, getApt, getWeather, getAtis, onEsMessage, onEsStatus, onXrStatus, onXrText, onXrFlightPlan, onXrWeather, onXrEvent, log }) {
    Object.assign(this, { getSim, getApt, getWeather, getAtis, onEsMessage, onEsStatus, onXrStatus, onXrText, onXrFlightPlan, onXrWeather, onXrEvent, log });
    this.esTx = [];      // pilot transmissions for EuroScope
    this.xrTx = [];      // transmissions for XRadio
    this.fpAcks = [];    // answers to real pilots' flight plans
    this.xr = { enabled: false };
    this.xrStatus = null;
    this.voice = null;
    setInterval(() => this.esSync(), 1000);
    setInterval(() => this.xrSync(), 400);
  }

  /** Every pilot / AI-controller / user transmission passes here. */
  transmission({ from, ac, text, say, pos, ai, seed, gender, to }) {
    const sim = this.getSim();
    if (!sim) return;
    const p = sim.positions && sim.positions[pos];
    const mhz = p ? p.mhz : (sim.apt.freq.tower ? sim.apt.freq.tower.mhz : 118.1);
    if (from === "pilot" && ac && !ac.human) this.esTx.push({ cs: ac.cs, freq: mhz, text });
    if (this.xr.enabled && this.xr.text) {
      const voice = ac && ac.cast && ac.cast[0] && ac.cast[0].id ? ac.cast[0].id : null;   // the voice the browser speaks with
      this.xrTx.push({ kind: from === "pilot" ? "pilot" : "atc", cs: ac ? ac.cs : "", khz: Math.round(mhz * 1000), text,
        say: from === "pilot" ? say || text : undefined, nat: ac ? ac.nat || "" : "", seed: seed || (ac ? ac.id : 0), gender, voice, to: to || "" });
    }
  }

  /** The controller answers a real pilot's flight plan (squawk / clearance / cancel). */
  fpAck(cs, { squawk = 0, status = "ack", remarks = "" } = {}) { this.fpAcks.push({ cs, squawk, status, remarks }); }

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
      const apt = this.getApt();
      const body = { enabled: !!cfg.enabled, host: cfg.host || "127.0.0.1", port: +cfg.port || 49100, password: cfg.password || "",
        atc_cs: cfg.cs || "", freq_khz: Math.round((parseFloat(cfg.freq) || 0) * 1000), ai_traffic: !!cfg.ai, real_pilots: !!cfg.humans,
        text: !!cfg.text, voice: !!cfg.voice, weather: cfg.weather || "off", transcribe: !!cfg.transcribe, ai_voice: cfg.aiVoice !== false,
        atis_voice: !!cfg.atisVoice, icao: apt ? apt.icao : "" };
      const r = await fetch("/api/xradio/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      this.xrStatus = await r.json();
      this.onXrStatus(this.xrStatus);
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
    const body = { center, positions, aircraft: this.xr.ai ? bridgeAircraft(sim, apt, { ownOnly: true }) : [], tx: this.xrTx.splice(0),
      fp_acks: this.fpAcks.splice(0), weather: this.xr.weather === "publish" && this.getWeather ? this.getWeather() : null,
      atis: this.getAtis ? this.getAtis() : null };
    try {
      const r = await fetch("/api/xradio/sync", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json();
      this.xrStatus = j;
      this.onXrStatus(j);
      const fps = new Map((j.fps || []).map(f => [f.callsign, f]));
      if (this.xr.humans) for (const h of j.humans || []) {
        const pos = apt.toXY(h.lat, h.lon);
        sim.upsertHuman({ hid: h.hid, cs: h.cs, type: h.type, pos, alt: Math.max(0, h.alt_m / FT_M - (apt.d.elevation || 0)),
          hdg: h.hdg, spd: h.gs_ms, onGround: h.on_ground, squawk: h.squawk, xpdr: h.xpdr >= 3 ? "C" : "S", ai: h.ai, tx: h.tx, fp: fps.get(h.cs) || null });
      }
      for (const t of j.texts || []) this.onXrText(t);
      for (const e of j.events || []) if (this.onXrEvent) this.onXrEvent(e);
      if (j.weather && this.xr.weather === "follow" && this.onXrWeather) this.onXrWeather(j.weather);
    } catch { /* server down */ }
  }

  // ---------- XRadio voice ----------
  startVoice() {
    if (this.voice) return;
    const webcodecs = typeof AudioDecoder !== "undefined";
    const serverDecode = !!(this.xrStatus && this.xrStatus.voice && this.xrStatus.voice.server_decode);
    if (!webcodecs && !serverDecode) {
      this.log("XRadio voice needs WebCodecs (Chrome/Edge) or the av package on the server (pip install av) — staying on text.");
      return;
    }
    const ctx = new AudioContext({ sampleRate: 48000 });
    const v = this.voice = { ctx, decoders: new Map(), playhead: 0, es: new EventSource(webcodecs ? "/api/xradio/events" : "/api/xradio/events?pcm=1"), enc: null, pcmMode: !webcodecs };
    v.es.onmessage = (e) => {
      for (const f of JSON.parse(e.data)) {
        if (f.pcm) {                                        // decoded on the server: 16-bit 48 kHz mono
          const bytes = Uint8Array.from(atob(f.pcm), c => c.charCodeAt(0));
          const n = bytes.length >> 1, data = new Float32Array(n), dv = new DataView(bytes.buffer);
          for (let i = 0; i < n; i++) data[i] = dv.getInt16(i * 2, true) / 32768;
          this.playPcm(data);
          continue;
        }
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
    const n = ad.numberOfFrames, data = new Float32Array(n);
    ad.copyTo(data, { planeIndex: 0, format: "f32-planar" }); ad.close();
    this.playPcm(data);
  }
  playPcm(data) {
    const v = this.voice; if (!v) return;
    const n = data.length, buf = v.ctx.createBuffer(1, n, 48000);
    buf.copyToChannel(data, 0);
    const src = v.ctx.createBufferSource(); src.buffer = buf; src.connect(this.voiceOut || v.ctx.destination);
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

  /** Push-to-talk on XRadio: capture mic, encode 20 ms Opus frames (WebCodecs) or ship PCM for the server to encode. */
  async keyMic(on, khz) {
    if (!this.voice || !this.xr.voice) return;
    const v = this.voice;
    if (!on) { v.keyed = false; if (v.flush) v.flush(); return; }
    try {
      if (!v.stream) {
        v.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, sampleRate: 48000, echoCancellation: true } });
        const pending = [], pcmPending = [];
        v.flush = () => {
          if (pending.length) {
            const frames = pending.splice(0);
            fetch("/api/xradio/voice", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ khz: v.khz, frames }) }).catch(() => {});
          }
          if (pcmPending.length) {
            const chunks = pcmPending.splice(0), total = chunks.reduce((s, c) => s + c.length, 0), all = new Int16Array(total);
            let o = 0; for (const c of chunks) { all.set(c, o); o += c.length; }
            const b = new Uint8Array(all.buffer); let s = ""; for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192));
            fetch("/api/xradio/voice_pcm", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ khz: v.khz, pcm: btoa(s) }) }).catch(() => {});
          }
        };
        setInterval(() => v.flush(), 120);
        const track = v.stream.getAudioTracks()[0];
        if (typeof AudioEncoder !== "undefined" && typeof MediaStreamTrackProcessor !== "undefined") {
          v.enc = new AudioEncoder({
            output: (chunk) => { if (!v.keyed) return; const b = new Uint8Array(chunk.byteLength); chunk.copyTo(b); pending.push(btoa(String.fromCharCode(...b))); },
            error: (e) => this.log("Opus encode: " + e.message),
          });
          const rate = track.getSettings().sampleRate || 48000;
          v.enc.configure({ codec: "opus", sampleRate: rate, numberOfChannels: 1, bitrate: 24000, opus: { frameDuration: 20000 } });
          const proc = new MediaStreamTrackProcessor({ track });
          const reader = proc.readable.getReader();
          (async () => { for (;;) { const { value, done } = await reader.read(); if (done) break; if (v.keyed) v.enc.encode(value); value.close(); } })();
        } else {
          // Firefox: raw PCM through a ScriptProcessor, resampled to 48 kHz, encoded on the server (needs av)
          const src = v.ctx.createMediaStreamSource(v.stream), proc = v.ctx.createScriptProcessor(2048, 1, 1);
          proc.onaudioprocess = (e) => {
            if (!v.keyed) return;
            const f = e.inputBuffer.getChannelData(0), out = new Int16Array(f.length);
            for (let i = 0; i < f.length; i++) out[i] = Math.max(-1, Math.min(1, f[i])) * 32767;
            pcmPending.push(out);
          };
          src.connect(proc); proc.connect(v.ctx.destination);
          v.proc = proc;
        }
      }
      v.khz = khz; v.keyed = true;
    } catch (e) { this.log("XRadio mic unavailable (" + e.message + ") — text only."); }
  }
}
