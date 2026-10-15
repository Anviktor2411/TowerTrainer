// AI controllers for a real pilot (XRadio) on the positions nobody staffs: the clearance from the filed plan
// (a SimBrief OFP, usually) with a readback check, pushback and taxi with the real position watched, takeoff
// and landing against the sim's own traffic, climb, handoffs down the line, and a debrief at the end. Silent
// wherever a human works the position. Pure logic -- main.js plugs in how a call goes out.
import { sayNumbers, NEUTRAL_STYLE } from "./phrase.js";
import { dist } from "./airport.js";

const NM = 1852, KT = 0.5144;
const ORDER_DEP = ["DEL", "GND", "TWR", "APP", "CTR"];
const ORDER_ARR = ["CTR", "APP", "TWR", "GND"];

const DIGITS = { zero: "0", oh: "0", one: "1", two: "2", three: "3", tree: "3", four: "4", fower: "4", five: "5", fife: "5",
  six: "6", seven: "7", eight: "8", nine: "9", niner: "9" };

/** Spoken numbers to digits: "four five two one" → "4521", "three thousand five hundred" → "3500", "flight level one two zero" → "FL120". */
export function normalizeNumbers(text) {
  const words = String(text || "").toLowerCase().replace(/[,.;:()\-]/g, " ").split(/\s+/).filter(Boolean);
  const out = [];
  let acc = "", big = 0;
  const flush = () => { if (acc || big) { out.push(big ? String(big + (acc ? parseInt(acc, 10) : 0)) : acc); acc = ""; big = 0; } };
  for (const w of words) {
    if (w in DIGITS) { acc += DIGITS[w]; continue; }
    if (w === "hundred" || w === "thousand") { big += (acc ? parseInt(acc, 10) : 1) * (w === "hundred" ? 100 : 1000); acc = ""; continue; }
    flush();
    out.push(w);
  }
  flush();
  return out.join(" ")
    .replace(/\bflight level (\d{1,3})\b/g, (m, n) => "FL" + n.padStart(3, "0"))
    .replace(/\bfl ?(\d{1,3})\b/g, (m, n) => "FL" + n.padStart(3, "0"));
}

/** Does the pilot's readback carry every item? items: [{k: squawk|sid|alt|fl|rwy|word, v}] → {ok, missing}. */
export function checkReadback(text, items) {
  const n = normalizeNumbers(text).toUpperCase();
  const flat = n.replace(/\s+/g, "");
  const missing = [];
  for (const it of items) {
    const v = String(it.v).toUpperCase();
    let ok = false;
    if (it.k === "squawk") ok = n.includes(v);
    else if (it.k === "sid") ok = flat.includes(v) || (/[A-Z]$/.test(v) && flat.includes(v.slice(0, -1)));
    else if (it.k === "alt") ok = new RegExp("\\b" + v + "\\b").test(n);
    else if (it.k === "fl") ok = n.includes("FL" + v.padStart(3, "0"));
    else if (it.k === "rwy") ok = new RegExp("RUNWAY\\s*0?" + v.replace(/^0/, "") + "\\b").test(n);
    else if (it.k === "word") ok = n.includes(v);
    if (!ok) missing.push(it);
  }
  return { ok: missing.length === 0, missing };
}

/** What the pilot most likely wants from this transmission. */
export function intentOf(text) {
  const t = String(text || "").toLowerCase();
  if (!t.trim()) return "call";
  if (/\bmayday\b|\bpan pan\b/.test(t)) return "emergency";
  if (/\bsay again\b|\bconfirm\b/.test(t)) return "sayagain";
  if (/\bclearance\b|\bready to copy\b|\brequest ifr\b/.test(t)) return "clearance";
  if (/\bpush\b|\bstart ?up\b|\bstart\b/.test(t)) return "push";
  if (/\bvacated\b/.test(t)) return "vacated";
  if (/\bgo(ing)? around\b/.test(t)) return "goaround";
  if (/\btaxi\b/.test(t) && !/\bholding point\b.*\bready\b/.test(t)) return "taxi";
  if (/\bready\b|\bholding point\b|\bfor departure\b/.test(t)) return "ready";
  if (/\binbound\b|\bwith you\b|\bfor landing\b|\bestablished\b|\bon the ils\b|\bfinal\b|\binformation [a-z]\b|\bdescending\b|\bfeet\b.*\binbound\b/.test(t)) return "inbound";
  if (/\d|\bsquawk\b|\bclimb\b|\bcleared\b|\bwilco\b|\broger\b|\bline up\b|\bhold short\b|\bhold position\b/.test(t)) return "readback";
  return "call";
}

function itemText(it) {
  if (it.k === "squawk") return `squawk ${it.v}`;
  if (it.k === "sid") return `${it.v} departure`;
  if (it.k === "alt") return `climb ${it.v} feet`;
  if (it.k === "fl") return `flight level ${it.v}`;
  if (it.k === "rwy") return `runway ${it.v}`;
  return String(it.v).toLowerCase();
}

function distToPolyline(p, pts) {
  let best = Infinity;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const L2 = dx * dx + dy * dy;
    const t = L2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2)) : 0;
    const q = [a[0] + dx * t, a[1] + dy * t];
    best = Math.min(best, dist(p, q));
  }
  return best;
}

export class PilotAtc {
  /**
   * sim: the Sim. hooks.say({pos, text, say}) sends an AI controller's call; hooks.fpAck(cs, {squawk, status, remarks})
   * answers the pilot's flight plan; hooks.log(line) writes a session-log line; hooks.clock() is the UTC time text.
   */
  constructor(sim, hooks = {}) {
    this.sim = sim;
    this.hooks = hooks;
    this.flights = new Map();     // cs -> flight state
    this.lastTick = -1;
  }

  // ---------- plumbing ----------
  get apt() { return this.sim.apt; }
  works(pos) { return pos !== "ALL" && this.sim.userWorks(pos); }
  posOf(khz) {
    if (!this.sim.split || !khz) return null;
    const p = Object.values(this.sim.positions || {}).find(x => Math.round(x.mhz * 1000) === khz);
    return p ? p.key : null;
  }
  firstPos(order, from = null) {
    if (!this.sim.split) return "ALL";
    const i = from ? order.indexOf(from) + 1 : 0;
    for (let k = i; k < order.length; k++) if (this.sim.positions[order[k]]) return order[k];
    return null;
  }
  contact(pos) { return this.sim.split ? this.sim.contactPhrase(pos) : null; }
  say(F, pos, text, expect = null, kind = "atc") {
    if (this.works(pos)) return false;                       // a human works it: not our call
    F.lastSaid = { pos, text, t: this.sim.t };
    F.events.push({ t: this.sim.t, clock: this.hooks.clock ? this.hooks.clock() : "", pos, kind, text });
    if (expect) F.pending = { items: expect, askedAt: this.sim.t, tries: 0, text };
    if (this.hooks.say) this.hooks.say({ pos, text, say: sayNumbers(text, NEUTRAL_STYLE), cs: F.a.cs });
    return true;
  }
  note(F, text, level = "note") {
    F.events.push({ t: this.sim.t, clock: this.hooks.clock ? this.hooks.clock() : "", pos: F.pos, kind: level, text });
    if (level === "warn") F.deviations++;
    if (this.hooks.log) this.hooks.log(`${F.a.cs}: ${text}`);
  }
  onRunway(a) { return this.apt.runways.find(R => this.apt.onRunway(a.pos, R, 5)) || null; }
  nearestNodeTo(a) {
    const v = [Math.sin(a.hdg * Math.PI / 180), Math.cos(a.hdg * Math.PI / 180)];
    return this.apt.nearestNode([a.pos[0] + v[0] * 15, a.pos[1] + v[1] * 15]);
  }
  taxiRoute(a) {
    const start = this.nearestNodeTo(a);
    const route = this.apt.routeToRunway(start, this.sim.depEnd, []) || null;
    if (!route) return null;
    return { nodes: route, points: route.map(n => this.apt.nodes[n]), via: this.sim.namesOf(route) };
  }
  standRoute(a, stand) {
    const start = this.nearestNodeTo(a);
    const route = this.apt.routeToPos(start, stand.pos, []) || null;
    if (!route) return null;
    return { nodes: route, points: route.map(n => this.apt.nodes[n]).concat([stand.pos]), via: this.sim.namesOf(route) };
  }

  // ---------- flights ----------
  flightOf(a) {
    let F = this.flights.get(a.cs);
    if (F) { F.a = a; return F; }
    const icao = this.apt.icao;
    const fp = a.fp || {};
    const dep = (fp.dep || "").toUpperCase() === icao, arr = (fp.dest || "").toUpperCase() === icao;
    if (!dep && !arr) return null;
    F = { a, cs: a.cs, dir: dep ? "dep" : "arr", phase: dep ? "filed" : "enroute", pos: null, events: [], deviations: 0, readbackErrors: 0,
      times: { filed: this.sim.t }, pending: null, lastSaid: null, origin: a.pos ? [a.pos[0], a.pos[1]] : null, taxi: null, squawk: null, sid: null, climb: 0,
      warnedAt: {}, txWas: false, done: false, createdAt: this.sim.t };
    F.pos = this.firstPos(dep ? ORDER_DEP : ORDER_ARR);
    this.flights.set(a.cs, F);
    this.note(F, dep ? `flight plan ${fp.dep} → ${fp.dest} on the strip; AI ${this.sim.split ? "positions" : "controller"} will answer on ${F.pos === "ALL" ? "the frequency" : this.sim.positions[F.pos].freq}` : `inbound ${fp.dep} → ${fp.dest}; AI ${F.pos} will answer`);
    return F;
  }

  /** Every second from the page: watch the real positions, time out readbacks, answer mic-only calls. */
  tick() {
    const sim = this.sim;
    if (sim.t - this.lastTick < 1) return;
    this.lastTick = sim.t;
    for (const a of sim.ac) {
      if (!a.human || a.gone) continue;
      if (!a.fp || a.fpStatus === "cancelled") continue;
      const F = this.flightOf(a);
      if (!F || F.done) continue;
      // a keyed microphone without a transcript still counts as a call
      if (a.tx && !F.txWas) F.txAt = sim.t;
      if (!a.tx && F.txWas && F.txAt != null && sim.t - F.txAt > 0.8 && !F.textAt) this.heard(a.cs, "", null, true, true);
      if (!a.tx && F.txWas) F.textAt = false;
      F.txWas = !!a.tx;
      if (this.works(F.pos)) continue;                       // a human controller has them
      this.watch(F);
      if (F.pending && sim.t - F.pending.askedAt > 25 && !F.pending.nudged) {
        F.pending.nudged = true;
        this.say(F, F.pos, `${a.cs}, confirm you copied: ${F.pending.items.map(itemText).join(", ")}`);
        F.pending.askedAt = sim.t;
        this.note(F, "no readback within 25 s");
      }
    }
    for (const [cs, F] of this.flights) if (!sim.ac.includes(F.a) || F.a.gone) { if (!F.done) { this.note(F, "left the flight"); this.finish(F, "left"); } }
  }

  /** The real position against what was cleared. */
  watch(F) {
    const sim = this.sim, a = F.a, t = sim.t;
    const once = (key, every = 60) => { if (F.warnedAt[key] != null && t - F.warnedAt[key] < every) return false; F.warnedAt[key] = t; return true; };
    const rwy = a.onGround ? this.onRunway(a) : null;
    if (F.dir === "dep") {
      if (["filed", "clr_given", "cleared", "push"].includes(F.phase) && a.onGround && F.origin && dist(a.pos, F.origin) > 60 && a.spd > 2 * KT) {
        if (once("moved")) { this.note(F, "moving without a taxi clearance", "warn"); this.say(F, F.pos, `${a.cs}, hold position, you are not cleared to taxi`); }
      }
      if (F.phase === "taxi" && F.taxi) {
        if (rwy && rwy.id !== sim.depEnd.rwy && !F.crossOk && once("rwy" + rwy.id, 30)) { this.note(F, `on runway ${rwy.label} without a crossing clearance`, "warn"); this.say(F, F.pos, `${a.cs}, stop immediately, you are on runway ${rwy.ends[0].name} without clearance`); }
        if (rwy && rwy.id === sim.depEnd.rwy && once("rwyDep", 30)) { this.note(F, `entered runway ${sim.depEnd.name} without a line-up clearance`, "warn"); this.say(F, F.pos, `${a.cs}, stop immediately, you are entering runway ${sim.depEnd.name} without clearance`); }
        const off = distToPolyline(a.pos, F.taxi.points);
        if (!rwy && off > 60 && a.spd > 2 * KT && once("offroute", 60)) { this.note(F, `off the cleared taxi route (${Math.round(off)} m)`, "warn"); this.say(F, F.pos, `${a.cs}, you are off the cleared route, taxi via ${F.taxi.via.join(" ") || "the taxiway"} to holding point runway ${sim.depEnd.name}`); }
        const hp = F.taxi.points[F.taxi.points.length - 1];
        const twr = this.firstPos(ORDER_DEP, "GND");
        if (dist(a.pos, hp) < 300 && twr && twr !== F.pos && !F.toldTwr) {
          F.toldTwr = true;
          if (this.works(twr)) { this.note(F, `handed to ${twr} (a human controller)`); F.pos = twr; F.phase = "holding"; }
          else if (this.say(F, F.pos, `${a.cs}, ${this.contact(twr)}`)) { F.pos = twr; F.phase = "holding"; }
        }
        if (F.pos === "ALL" && dist(a.pos, hp) < 300) F.phase = "holding";
      }
      if (F.phase === "holding" && rwy && rwy.id === sim.depEnd.rwy && !F.lineup && !F.takeoff && once("rwyHold", 30)) {
        this.note(F, `entered runway ${sim.depEnd.name} without clearance`, "warn");
        this.say(F, F.pos, `${a.cs}, stop immediately, you are entering runway ${sim.depEnd.name} without clearance`);
      }
      if ((F.phase === "holding" || F.phase === "lined_up") && !a.onGround) {
        if (!F.takeoff) this.note(F, "took off without a takeoff clearance", "warn");
        F.phase = "airborne"; F.times.airborne = t; this.note(F, "airborne");
      }
      if (F.phase === "airborne" && a.alt > 700) {
        const nx = this.firstPos(ORDER_DEP, "TWR");
        if (nx && nx !== F.pos) { if (this.works(nx)) { F.pos = nx; F.phase = "to_app"; this.note(F, `handed to ${nx} (a human controller)`); } else if (this.say(F, F.pos, `${a.cs}, ${this.contact(nx)}`)) { F.pos = nx; F.phase = "to_app"; } }
        else if (!nx) { this.say(F, F.pos, `${a.cs}, frequency change approved, goodbye`); this.finish(F, "departed"); }
      }
      if (F.phase === "climb" && a.alt > 4500) {
        const nx = this.firstPos(ORDER_DEP, "APP");
        if (nx && nx !== F.pos && !F.toldCtr) { F.toldCtr = true; if (this.works(nx)) { F.pos = nx; F.phase = "to_ctr"; } else if (this.say(F, F.pos, `${a.cs}, ${this.contact(nx)}`)) { F.pos = nx; F.phase = "to_ctr"; } }
      }
      if ((F.phase === "climb" || F.phase === "cruise") && (dist(a.pos, [0, 0]) > 35 * NM || (a.fp.cruise_ft && a.alt > a.fp.cruise_ft - 1000))) {
        this.say(F, F.pos, `${a.cs}, leaving my airspace, radar service terminated, contact the next unit, goodbye`);
        this.finish(F, "departed");
      }
    } else {
      if (F.phase === "approach" && this.sim.distToThr(a) < 10 * NM && !a.onGround) {
        const twr = this.firstPos(ORDER_ARR, "APP");
        if (twr && twr !== F.pos && !F.toldTwr) { F.toldTwr = true; if (this.works(twr)) { F.pos = twr; F.phase = "final"; } else if (this.say(F, F.pos, `${a.cs}, ${this.contact(twr)}`)) { F.pos = twr; F.phase = "final"; } }
        if (F.pos === "ALL") F.phase = "final";
      }
      if ((F.phase === "final" || F.phase === "approach") && !a.onGround && !F.landClr) {
        const d = this.sim.distToThr(a);
        const e = this.sim.arrEnd;
        const free = this.sim.runwayFree(e.rwy, a) && !this.sim.ac.some(o => o.kind === "dep" && ["lining", "lined_up", "roll"].includes(o.state) && o.depEnd.rwy === e.rwy);
        if (F.checkedIn && d < 6 * NM && free && !this.sim.closedRunways.has(e.rwy)) { F.landClr = true; this.say(F, F.pos, `${a.cs}, runway ${e.name}, cleared to land${this.sim.windTxt()}`, [{ k: "rwy", v: e.name }, { k: "word", v: "cleared to land" }]); }
        else if (d < 1.2 * NM && once("goaround", 30)) { this.note(F, "not cleared to land inside 1.2 NM: go around", "warn"); this.say(F, F.pos, `${a.cs}, go around, I say again, go around`); F.landClr = false; }
      }
      if ((F.phase === "final" || F.phase === "approach") && a.onGround) { F.phase = "landed"; F.times.landed = t; this.note(F, F.landClr ? "landed" : "landed without a landing clearance", F.landClr ? "note" : "warn"); }
      if (F.phase === "landed" && !rwy && a.spd < 30 * KT) {
        const gnd = this.firstPos(ORDER_ARR, "TWR");
        if (gnd && gnd !== F.pos) { if (this.works(gnd)) { F.pos = gnd; F.phase = "vacated"; } else if (this.say(F, F.pos, `${a.cs}, ${this.contact(gnd)}`)) { F.pos = gnd; F.phase = "vacated"; } }
        else F.phase = "vacated";
      }
      if (F.phase === "to_stand" && F.taxi) {
        const end = F.taxi.points[F.taxi.points.length - 1];
        if (rwy && !F.crossOk && once("rwyArr" + rwy.id, 30)) { this.note(F, `on runway ${rwy.label} without a crossing clearance`, "warn"); this.say(F, F.pos, `${a.cs}, stop immediately, you are on runway ${rwy.ends[0].name} without clearance`); }
        if (dist(a.pos, end) < 40 && a.spd < 1 * KT) { this.note(F, `on stand ${F.stand ? F.stand.name : ""}`); this.finish(F, "arrived"); }
      }
    }
  }

  /** A transmission from the pilot: text (typed, or a transcript), or a bare mic key when `voiceOnly`. */
  heard(cs, text, khz = null, voice = false, voiceOnly = false) {
    const a = this.sim.humanByCs(cs);
    if (!a) return null;
    const F = this.flightOf(a);
    if (!F || F.done) return null;
    if (!voiceOnly) F.textAt = this.sim.t;
    const tuned = this.posOf(khz);
    if (tuned && tuned !== F.pos) { this.note(F, `calls on ${tuned}`); F.pos = tuned; }
    if (this.works(F.pos)) return null;                      // the human controller answers
    const sim = this.sim, t = sim.t;
    F.events.push({ t, clock: this.hooks.clock ? this.hooks.clock() : "", pos: F.pos, kind: "pilot", text: text || (voice ? "(voice, no transcript)" : "") });
    const intent = intentOf(text);
    if (intent === "emergency") { F.emergency = true; this.note(F, "declared an emergency", "warn"); return this.say(F, F.pos, `${cs}, roger ${/mayday/i.test(text) ? "mayday" : "pan pan"}, runway ${sim.arrEnd.name} is yours, wind ${sim.windTxt().replace(/^, wind /, "")}, fire service alerted, report intentions`); }
    if (intent === "sayagain" && F.lastSaid) return this.say(F, F.pos, `${cs}, I say again, ${F.lastSaid.text.replace(new RegExp("^" + cs + ",?\\s*"), "")}`);
    // a readback is due: check it before anything else
    if (F.pending && text) {
      const r = checkReadback(text, F.pending.items);
      if (r.ok) {
        const p = F.pending; F.pending = null;
        return this.afterReadback(F, p);
      }
      F.pending.tries++;
      F.readbackErrors++;
      this.note(F, `readback missed ${r.missing.map(itemText).join(", ")}`, "miss");   // counted as a readback error, not a deviation
      if (F.pending.tries >= 2) { const p = F.pending; F.pending = null; this.say(F, F.pos, `${cs}, ${r.missing.map(itemText).join(", ")}, ${p.hint || "readback correct otherwise"}`); return this.afterReadback(F, p); }
      return this.say(F, F.pos, `${cs}, negative, ${r.missing.map(itemText).join(", ")}, read back`);
    }
    if (F.pending && voiceOnly) { this.note(F, "readback not understood (no transcript): taken as correct"); const p = F.pending; F.pending = null; return this.afterReadback(F, p); }
    return F.dir === "dep" ? this.departure(F, intent, text) : this.arrival(F, intent, text);
  }

  afterReadback(F, p) {
    const sim = this.sim, cs = F.cs;
    if (p.kind === "clearance") {
      F.phase = "cleared"; F.times.cleared = sim.t;
      if (this.hooks.fpAck) this.hooks.fpAck(cs, { squawk: +F.squawk, status: "cleared", remarks: p.text.slice(0, 63) });
      const gnd = this.firstPos(ORDER_DEP, "DEL");
      if (gnd && gnd !== F.pos && !this.works(gnd)) { const ok = this.say(F, F.pos, `${cs}, readback correct, ${this.contact(gnd)} when ready`); F.pos = gnd; return ok; }
      if (gnd && gnd !== F.pos) { F.pos = gnd; return this.say(F, F.pos, `${cs}, readback correct`); }
      return this.say(F, F.pos, `${cs}, readback correct, report ready for push and start`);
    }
    if (p.kind === "taxi") { F.phase = "taxi"; F.times.taxi = sim.t; return true; }
    if (p.kind === "lineup") { F.phase = "lined_up"; F.lineup = true; return true; }
    if (p.kind === "takeoff") { F.takeoff = true; F.lineup = true; F.phase = F.phase === "holding" ? "holding" : F.phase; return true; }
    if (p.kind === "climb") { F.phase = "climb"; return true; }
    if (p.kind === "cruise") { F.phase = "cruise"; return true; }
    if (p.kind === "approach") { F.phase = "approach"; return true; }
    if (p.kind === "stand") { F.phase = "to_stand"; return true; }
    return true;
  }

  departure(F, intent, text) {
    const sim = this.sim, a = F.a, cs = F.cs, fp = a.fp;
    const dest = (fp.dest || "").toUpperCase();
    const atDel = F.pos === this.firstPos(ORDER_DEP);
    if (F.phase === "filed" || (F.phase === "clr_given" && intent === "clearance")) {
      if (intent !== "clearance" && intent !== "call" && intent !== "readback") {
        if (intent === "push" || intent === "taxi" || intent === "ready") return this.say(F, F.pos, `${cs}, negative, you have no clearance yet, say when ready to copy`);
      }
      const sg = sim.suggestDeparture(a);
      const code = String(sim.squawks.next(sim.t)).padStart(4, "0");
      F.squawk = code; F.sid = sg.sid || null; F.climb = sg.climb;
      const items = [{ k: "squawk", v: code }, { k: "alt", v: sg.climb }];
      if (sg.sid) items.unshift({ k: "sid", v: sg.sid });
      const t = `${cs}, cleared to ${dest} via ${sg.sid ? sg.sid + " departure" : "flight planned route"}, climb ${sg.climb} feet, squawk ${code}`;
      F.phase = "clr_given";
      const ok = this.say(F, F.pos, t, items);
      if (ok && F.pending) { F.pending.kind = "clearance"; F.pending.hint = "readback correct"; }
      return ok;
    }
    if (F.phase === "clr_given") return this.say(F, F.pos, `${cs}, read back your clearance: ${F.sid ? F.sid + " departure, " : ""}climb ${F.climb} feet, squawk ${F.squawk}`);
    if (F.phase === "cleared" || F.phase === "push") {
      if (intent === "push" || (intent === "call" && F.phase === "cleared")) { F.phase = "push"; return this.say(F, F.pos, `${cs}, push and start approved${sim.deiceNeeded ? ", de-icing on request" : ""}`); }
      if (intent === "taxi" || intent === "ready" || (intent === "call" && F.phase === "push")) {
        const r = this.taxiRoute(a);
        if (!r) return this.say(F, F.pos, `${cs}, standby`);
        F.taxi = r; F.crossOk = false;
        const t = `${cs}, taxi to holding point runway ${sim.depEnd.name}${r.via.length ? " via " + r.via.join(" ") : ""}, hold short runway ${sim.depEnd.name}`;
        const ok = this.say(F, F.pos, t, [{ k: "rwy", v: sim.depEnd.name }, { k: "word", v: "hold short" }]);
        if (ok && F.pending) { F.pending.kind = "taxi"; F.pending.hint = "taxi approved"; }
        return ok;
      }
      return this.say(F, F.pos, `${cs}, go ahead`);
    }
    if (F.phase === "taxi") {
      if (intent === "ready" || intent === "call") return this.say(F, F.pos, `${cs}, continue taxi to holding point runway ${sim.depEnd.name}, report ready`);
      return this.say(F, F.pos, `${cs}, roger`);
    }
    if (F.phase === "holding" || F.phase === "lined_up") {
      if (intent !== "ready" && intent !== "call" && intent !== "readback" && intent !== "taxi") return this.say(F, F.pos, `${cs}, roger`);
      const e = sim.depEnd;
      const arr = sim.nearestArrival(e);
      const gap = sim.lastTakeoff ? sim.t - sim.lastTakeoff.t : 999;
      const need = sim.lastTakeoff && sim.lastTakeoff.rwy === e.rwy ? sim.depSpacingS(sim.lastTakeoff, a) : 0;
      const free = sim.runwayFree(e.rwy, a) && !sim.closedRunways.has(e.rwy);
      if (free && arr > (sim.lvp ? 6 : 4) * NM && gap >= need) {
        F.takeoff = true; F.lineup = true; F.times.takeoffClr = sim.t;
        const t = `${cs}, runway ${e.name}, cleared for takeoff${sim.windTxt()}`;
        const ok = this.say(F, F.pos, t, [{ k: "rwy", v: e.name }, { k: "word", v: "cleared for takeoff" }]);
        if (ok && F.pending) { F.pending.kind = "takeoff"; F.pending.hint = "cleared for takeoff"; }
        return ok;
      }
      if (free && !F.lineup && arr > 2.5 * NM && !sim.lvp) {
        F.lineup = true;
        const ok = this.say(F, F.pos, `${cs}, runway ${e.name}, line up and wait${arr < 8 * NM ? ", traffic on final" : ""}`, [{ k: "rwy", v: e.name }, { k: "word", v: "line up" }]);
        if (ok && F.pending) { F.pending.kind = "lineup"; F.pending.hint = "line up and wait"; }
        return ok;
      }
      return this.say(F, F.pos, `${cs}, hold position, ${!free ? "runway occupied" : arr <= 4 * NM ? "traffic on short final" : "wake turbulence spacing"}, expect departure in ${arr <= 4 * NM ? "two" : "one"} minutes`);
    }
    if (F.phase === "to_app") {
      const fl = Math.min(120, Math.max(50, Math.floor((fp.cruise_ft || 12000) / 100)));
      F.phase = "climb";
      const ok = this.say(F, F.pos, `${cs}, identified, climb flight level ${fl}${F.sid ? "" : ", direct " + ((fp.route || "").split(/\s+/).find(w => /^[A-Z]{5}$/.test(w)) || "your first fix")}`, [{ k: "fl", v: fl }]);
      if (ok && F.pending) { F.pending.kind = "climb"; F.pending.hint = "climb approved"; }
      return ok;
    }
    if (F.phase === "to_ctr") {
      const fl = Math.max(100, Math.floor((fp.cruise_ft || 24000) / 100));
      F.phase = "cruise";
      const ok = this.say(F, F.pos, `${cs}, identified, climb flight level ${fl}`, [{ k: "fl", v: fl }]);
      if (ok && F.pending) { F.pending.kind = "cruise"; F.pending.hint = "climb approved"; }
      return ok;
    }
    if (F.phase === "climb" || F.phase === "cruise") return this.say(F, F.pos, `${cs}, roger`);
    return this.say(F, F.pos, `${cs}, roger`);
  }

  arrival(F, intent, text) {
    const sim = this.sim, a = F.a, cs = F.cs;
    const e = sim.arrEnd;
    if (F.phase === "enroute" || F.phase === "approach") {
      if (!F.checkedIn) {
        F.checkedIn = true; F.phase = "approach"; F.times.inbound = sim.t;
        const ok = this.say(F, F.pos, `${cs}, identified, descend 3000 feet, cleared ILS approach runway ${e.name}, report established`, [{ k: "alt", v: 3000 }, { k: "rwy", v: e.name }]);
        if (ok && F.pending) { F.pending.kind = "approach"; F.pending.hint = "descend 3000 feet"; }
        return ok;
      }
      if (intent === "inbound") return this.say(F, F.pos, `${cs}, roger, continue approach`);
      return this.say(F, F.pos, `${cs}, roger`);
    }
    if (F.phase === "final") {
      F.checkedIn = true;
      if (F.landClr) return this.say(F, F.pos, `${cs}, roger, runway ${e.name}, cleared to land`);
      const d = sim.distToThr(a);
      const free = sim.runwayFree(e.rwy, a) && !sim.ac.some(o => o.kind === "dep" && ["lining", "lined_up", "roll"].includes(o.state) && o.depEnd.rwy === e.rwy);
      if (d < 6 * NM && free && !sim.closedRunways.has(e.rwy)) { F.landClr = true; return this.say(F, F.pos, `${cs}, runway ${e.name}, cleared to land${sim.windTxt()}`, [{ k: "rwy", v: e.name }, { k: "word", v: "cleared to land" }]); }
      return this.say(F, F.pos, `${cs}, continue approach runway ${e.name}, ${free ? "expect late landing clearance" : "traffic on the runway"}${sim.windTxt()}`);
    }
    if (F.phase === "landed") return this.say(F, F.pos, `${cs}, roger, vacate the runway when able, report vacated`);
    if (F.phase === "vacated") {
      const stand = F.stand || (() => { const s = sim.freeStands(); return s && s.length ? s[0] : null; })();
      if (!stand) return this.say(F, F.pos, `${cs}, standby for a stand`);
      F.stand = stand;
      const r = this.standRoute(a, stand);
      if (!r) return this.say(F, F.pos, `${cs}, taxi to stand ${stand.name}`);
      F.taxi = r; F.crossOk = false;
      const ok = this.say(F, F.pos, `${cs}, taxi to stand ${stand.name}${r.via.length ? " via " + r.via.join(" ") : ""}`, [{ k: "word", v: "stand " + String(stand.name).toUpperCase() }]);
      if (ok && F.pending) { F.pending.kind = "stand"; F.pending.hint = "taxi to the stand"; }
      return ok;
    }
    if (F.phase === "to_stand") return this.say(F, F.pos, `${cs}, roger`);
    return this.say(F, F.pos, `${cs}, roger`);
  }

  finish(F, how) {
    if (F.done) return;
    F.done = true; F.how = how; F.times.done = this.sim.t;
    if (this.hooks.fpAck && F.dir === "dep" && how === "departed") this.hooks.fpAck(F.cs, { squawk: +F.squawk || 0, status: "cancel", remarks: "flight closed, debrief in TowerTrainer" });
    this.note(F, `flight closed (${how}): debrief ready`);
    if (this.hooks.onDone) this.hooks.onDone(F);
  }

  /** The debrief: phases with times, every call, the deviations, a score. */
  debrief(cs) {
    const F = this.flights.get(cs);
    if (!F) return null;
    const mm = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
    const T = F.times, t0 = F.createdAt;
    const lines = [];
    lines.push(`${F.cs}  ${F.a.fp ? `${F.a.fp.dep} → ${F.a.fp.dest}` : ""}  ${F.dir === "dep" ? "departure" : "arrival"}  ${F.done ? `closed (${F.how})` : "in progress (" + F.phase + ")"}`);
    const steps = F.dir === "dep"
      ? [["clearance read back", T.cleared], ["taxi", T.taxi], ["takeoff clearance", T.takeoffClr], ["airborne", T.airborne], ["closed", T.done]]
      : [["inbound", T.inbound], ["landed", T.landed], ["closed", T.done]];
    for (const [k, v] of steps) if (v != null) lines.push(`  ${k}: +${mm(v - t0)}`);
    lines.push(`  readback errors: ${F.readbackErrors}   deviations: ${F.deviations}`);
    const score = Math.max(0, 100 - 10 * F.readbackErrors - 20 * F.deviations);
    lines.push(`  score: ${score}/100`);
    lines.push("");
    for (const e of F.events) lines.push(`${e.clock || mm(e.t - t0)}  ${e.kind === "pilot" ? F.cs : e.kind === "atc" ? (e.pos === "ALL" ? "ATC" : e.pos) + " (AI)" : e.kind === "warn" ? "!!" : e.kind === "miss" ? "?!" : "--"}  ${e.text}`);
    return { cs: F.cs, score, readbackErrors: F.readbackErrors, deviations: F.deviations, done: F.done, phase: F.phase, lines, text: lines.join("\n") };
  }
}
