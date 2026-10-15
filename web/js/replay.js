// Recording and replay (G1): the main window keeps a compact snapshot every second (positions, states,
// strips) and remembers how long each frequency log was at that moment. A recording replays on the radar
// with a scrubber, and can be saved as JSON and loaded again later (also in another browser).

const FIELDS = ["id", "cs", "type", "wtc", "kind", "state", "x", "y", "alt", "hdg", "spd", "flags", "freq", "squawk", "stand", "other", "vtype"];
const F_GROUND = 1, F_VEH = 2, F_GA = 4, F_HUMAN = 8, F_NORDO = 16, F_MAYDAY = 32, F_HELI = 64;

export class Recorder {
  constructor(maxSeconds = 3 * 3600) { this.max = maxSeconds; this.frames = []; this.meta = null; this.lastT = -1; this.on = false; }
  start(meta) { this.meta = { ...meta, started: new Date().toISOString() }; this.frames = []; this.lastT = -1; this.on = true; }
  stop() { this.on = false; }
  /** Called every frame; keeps one snapshot per simulated second. */
  tick(sim, logs) {
    if (!this.on || !sim) return;
    const t = Math.floor(sim.t);
    if (t === this.lastT) return;
    this.lastT = t;
    const ac = sim.ac.filter(a => !(a.veh && a.state === "idle") && !a.dormant).map(a => [a.id, a.cs, a.type, a.wtc, a.kind, a.state, Math.round(a.pos[0]), Math.round(a.pos[1]), Math.round(a.alt || 0), Math.round(a.hdg || 0), Math.round((a.spd || 0) * 10) / 10,
      (a.onGround ? F_GROUND : 0) | (a.veh ? F_VEH : 0) | (a.ga ? F_GA : 0) | (a.human ? F_HUMAN : 0) | (a.nordo ? F_NORDO : 0) | (a.mayday ? F_MAYDAY : 0) | (a.heli ? F_HELI : 0),
      a.freq, a.squawk || "", a.stand ? a.stand.name : "", a.other ? [a.other[0] || "", a.other[1] || ""] : ["", ""], a.vtype || ""]);
    const logN = {}; for (const [k, v] of Object.entries(logs || {})) logN[k] = v.length;
    this.frames.push({ t, rwy: sim.depEnd.name, arr: sim.arrEnd.name, ac, logN, atis: sim.atis ? sim.atis() : "" });
    if (this.frames.length > this.max) this.frames.shift();
  }
  get seconds() { return this.frames.length ? this.frames[this.frames.length - 1].t - this.frames[0].t : 0; }
  toJSON(logs) { return { towertrainer: "recording", v: 1, meta: this.meta, fields: FIELDS, frames: this.frames, logs: logs || {} }; }
  static fromJSON(obj) {
    if (!obj || obj.towertrainer !== "recording" || !Array.isArray(obj.frames)) throw new Error("not a Tower Trainer recording");
    const r = new Recorder(); r.meta = obj.meta || {}; r.frames = obj.frames; r.logs = obj.logs || {}; return r;
  }
}

/** The aircraft of one frame as the plain objects the radar draws. */
export function frameAircraft(frame) {
  return frame.ac.map(r => {
    const f = r[11];
    return { id: r[0], cs: r[1], type: r[2], wtc: r[3], kind: r[4], state: r[5], pos: [r[6], r[7]], alt: r[8], hdg: r[9], spd: r[10], onGround: !!(f & F_GROUND), veh: !!(f & F_VEH), ga: !!(f & F_GA),
      human: !!(f & F_HUMAN), nordo: !!(f & F_NORDO), mayday: !!(f & F_MAYDAY), heli: !!(f & F_HELI), freq: r[12], squawk: r[13], stand: r[14] ? { name: r[14] } : null, other: r[15] || ["", ""],
      assignedSq: r[13], vtype: r[16] || "veh", path: null, warn: [], strip: null, stripData: null, replay: true };
  });
}

/** Frame index for a time (binary search). */
export function frameAt(frames, t) {
  let lo = 0, hi = frames.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (frames[mid].t <= t) lo = mid; else hi = mid - 1; }
  return lo;
}

/** Download a text file from the browser. */
export function download(name, text, type = "application/json") {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name;
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

/** The frequency logs as plain text (one file for all positions). */
export function logsAsText(logs, meta = {}) {
  const strip = (h) => String(h).replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"');
  const out = [`Tower Trainer log — ${meta.icao || ""} ${meta.started || ""}`.trim(), ""];
  for (const [pos, list] of Object.entries(logs)) {
    if (!list.length) continue;
    out.push(`=== ${pos} ===`);
    for (const e of list) out.push(`[${e.cls}] ${strip(e.html)}`);
    out.push("");
  }
  return out.join("\n");
}
