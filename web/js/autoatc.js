// Automatic ATC (PART E): every AI controller position as a person on shift, in the airport's own phraseology.
//
//   profiles      data/airports/<ICAO>.json (unit names, frequencies, transition altitude, taxi habits, runway
//                 preferences, local phrases), defaults generated for any airport (defaultProfile)
//   controllers   one per position per shift: voice (gender, local accent), speech rate, chattiness, greetings,
//                 how often traffic information is given, preferred LEGAL wordings; a new controller every 45-90
//                 min of sim time announces itself
//   workload      quiet -> full phrases, greetings, extra traffic information; busy -> short, "standby", combined
//   style()       turns the AI's canonical instruction into what this controller says (the canonical text is what
//                 the AI pilot acts on, so a styled variant never changes the clearance)
//   validate()    every phrase checked against the region's rules (ICAO Doc 4444 / UK CAP 413 / US FAA 7110.65)
//   explain()     why the AI controller said it, for the Auto ATC log and the assist suggestions
import { regionOf } from "./phrase.js";
import { controllerNat } from "./data.js";

const NM = 1852, KT = 0.514444, FT = 0.3048;
export const POS = ["DEL", "GND", "TWR", "APP", "CTR"];
export const MODES = ["manual", "assist", "auto"];

// ------------------------------------------------------------------------------------------------- profiles
const LOCAL_LANG = { LF: "fr", LE: "es", LI: "it", LP: "pt" };          // where controllers really speak it to locals
const NAT_LANG = { fr: "FR", es: "ES", it: "IT", pt: "PT" };

/** Sensible defaults for any airport; a data/airports/<ICAO>.json overrides any of it. */
export function defaultProfile(icao, apt = null, positions = null) {
  const region = regionOf(icao);
  const call = (apt && apt.callName) || icao;
  const pre = icao.slice(0, 2);
  const units = {};
  for (const k of POS) units[k] = positions && positions[k] ? positions[k].name : `${call} ${{ DEL: region === "US" ? "Clearance" : "Delivery", GND: "Ground", TWR: "Tower", APP: region === "US" ? "Approach" : "Radar", CTR: region === "US" ? "Center" : "Control" }[k]}`;
  return {
    icao, region, units,
    freqs: positions ? Object.fromEntries(POS.filter(k => positions[k]).map(k => [k, positions[k].freq])) : {},
    transitionAlt: region === "US" || region === "CA" ? 18000 : region === "UK" ? 6000 : 5000,
    transitionLevel: null,
    preferredRunways: [], runwayChange: { maxTailwind: 5, maxCrosswind: 25 },
    taxiRoutes: {}, holdingPoints: {},
    lvp: { rvr: 550, ceiling: 200, note: "" }, noise: "",
    localLanguage: LOCAL_LANG[pre] ? { lang: LOCAL_LANG[pre], nat: NAT_LANG[LOCAL_LANG[pre]] } : null,
    habits: {
      windOnClearance: true,                          // wind with every takeoff and landing clearance
      landAfter: region === "UK",                     // UK: "land after the ..."
      conditional: true,                              // "behind the landing ..., line up and wait behind"
      lineUpWord: "line up and wait",                  // never "position and hold" (FAA dropped it in 2010)
      taxiTo: region === "US" ? "runway" : "holding point",
      contactOn: region === "US" ? "" : "",            // "contact Tallinn Radar 127.905" (ICAO) -- no "on"
      goodDay: region === "US" ? "good day" : "goodbye",
    },
    nat: controllerNat(icao),
  };
}

export function mergeProfile(def, file) {
  if (!file || typeof file !== "object") return def;
  return { ...def, ...file, units: { ...def.units, ...(file.units || {}) }, habits: { ...def.habits, ...(file.habits || {}) },
    lvp: { ...def.lvp, ...(file.lvp || {}) }, runwayChange: { ...def.runwayChange, ...(file.runwayChange || {}) } };
}

/** Apply the profile's unit names / frequencies to the positions table (what the sim calls the units). */
export function applyProfile(profile, positions) {
  if (!positions) return;
  for (const k of POS) {
    if (!positions[k]) continue;
    if (profile.units && profile.units[k]) positions[k].name = profile.units[k];
    if (profile.freqs && profile.freqs[k] && /^\d{3}\.\d{1,3}$/.test(profile.freqs[k])) { positions[k].freq = profile.freqs[k]; positions[k].mhz = +profile.freqs[k]; }
  }
}

// ------------------------------------------------------------------------------------------------- controllers
const rng = (seed) => () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

/** The controller working `pos` during `shift` (deterministic for a seed: the same airport and shift sound the same). */
export function makeController(pos, profile, shift = 0, seed = 1) {
  const r = rng([...`${profile.icao}${pos}${shift}`].reduce((s, c) => s * 31 + c.charCodeAt(0), seed) % 2147483647 || 7);
  const gender = r() < 0.38 ? "F" : "M";
  const names = { F: ["Kati", "Laura", "Anna", "Sarah", "Emma", "Julia", "Maria", "Helen"], M: ["Mart", "Peter", "John", "Tom", "Andres", "Mike", "David", "Erik"] };
  return {
    id: `${pos}-${shift}`, pos, shift, gender, nat: profile.nat || controllerNat(profile.icao),
    name: names[gender][Math.floor(r() * names[gender].length)],
    voiceSeed: Math.floor(r() * 100000),
    rate: 0.92 + r() * 0.24,
    chatty: r(),                                       // 0 terse ... 1 chatty
    greets: r() < 0.7,
    trafficInfo: 0.3 + r() * 0.6,
    windFirst: r() < 0.35,                             // "wind 240 degrees 12 knots, runway 26 cleared to land"
    knotsShort: r() < 0.3,                             // US "wind 240 at 12"
    slip: r() < 0.5,                                   // may make a rare slip (only with the realism toggle)
    shiftLength: (45 + r() * 45) * 60,                 // 45-90 min of sim time
  };
}

/** How busy a position is: aircraft on the frequency and transmissions in the last two minutes. */
export function workload(sim, pos) {
  const n = sim.ac.filter(a => !a.veh && (a.freq === pos || (!sim.split && pos === "ALL"))).length;
  const tx = (sim.txLog || []).filter(x => x.pos === pos && sim.t - x.t < 120).length;
  const score = n + tx * 0.6;
  return score >= 12 ? "busy" : score >= 5 ? "normal" : "quiet";
}

// ------------------------------------------------------------------------------------------------- style
const WIND_RE = /, wind (\d{3}) degrees (\d+) knots/;
const greeting = (h) => (h < 12 ? "good morning" : h < 18 ? "good afternoon" : "good evening");

/**
 * What this controller says for the AI's canonical instruction `text` (ctx: {a, pos, ctrl, profile, load, sim, hour,
 * first (first call to this aircraft), qnh, heavyAhead, realism}). Returns the spoken/displayed text.
 */
export function style(text, ctx) {
  const { ctrl, profile, load } = ctx;
  const region = profile.region;
  const m = /^([^,]+), (.*)$/.exec(text);
  if (!m) return text;
  let cs = m[1], rest = m[2];
  // ---- landing / takeoff clearances: the wind always, in this controller's order
  const wind = WIND_RE.exec(rest);
  const clr = /\b(runway \S+), (cleared (?:to land|for takeoff|for immediate takeoff|touch and go))/.exec(rest);
  if (clr) {
    const w = wind ? (region === "US" && ctrl.knotsShort ? `wind ${wind[1]} at ${wind[2]}` : `wind ${wind[1]} degrees ${wind[2]} knots`) : null;
    const core = region === "US" ? `${clr[1]}, ${clr[2]}` : `${clr[1]}, ${clr[2]}`;
    const before = rest.slice(0, clr.index).replace(/,\s*$/, "");
    if (w && (ctrl.windFirst || region === "US" && ctrl.knotsShort)) rest = `${before ? before + ", " : ""}${w}, ${core}`;
    else rest = `${before ? before + ", " : ""}${core}${w ? ", " + w : ""}`;
    if (ctx.heavyAhead && !/wake turbulence/.test(rest)) rest += ", caution wake turbulence";
  }
  // ---- "line up and wait": never "position and hold"; UK conditional wording kept as is
  rest = rest.replace(/\bposition and hold\b/g, "line up and wait");
  // ---- US taxi wording: "taxi to runway 22L via ..." and the hold short spelled out
  if (region === "US") rest = rest.replace(/\btaxi to holding point runway (\S+)/, "taxi to runway $1");
  // ---- contact: quiet -> "goodbye" / "good day"; busy -> nothing extra
  if (/^contact /.test(rest) || /, contact /.test(rest)) {
    if (load === "quiet" && ctrl.chatty > 0.4) rest += `, ${profile.habits.goodDay}`;
  }
  // ---- first call: greeting (quiet), QNH on first contact for arrivals with Approach / Tower
  if (ctx.first) {
    if (ctrl.greets && load !== "busy") cs = `${cs}, ${greeting(ctx.hour ?? 10)}`;
    if (ctx.qnh && /\bidentified\b|\bradar contact\b/.test(rest) && !/QNH/.test(rest)) rest += `, QNH ${ctx.qnh}`;
  }
  // ---- radar identification: some say "radar contact"
  if (/^identified\b/.test(rest) && ctrl.chatty < 0.35) rest = rest.replace(/^identified/, "radar contact");
  // ---- busy: drop the courtesy, keep the clearance
  if (load === "busy") rest = rest.replace(/, (goodbye|good day)$/, "").replace(/, report established$/, "");
  // ---- quiet + chatty: "report vacated" after a landing clearance
  if (load === "quiet" && ctrl.chatty > 0.6 && /cleared to land/.test(rest) && !/report vacated/.test(rest)) rest += ", report vacated";
  // ---- the realism toggle: a rare slip, corrected at once ("squawk 4251, correction, squawk 4521")
  if (ctx.realism && ctrl.slip && ctx.random && ctx.random() < 0.04) {
    const sq = /squawk ([0-7])([0-7])([0-7])([0-7])/.exec(rest);
    if (sq && sq[2] !== sq[3]) rest = rest.replace(sq[0], `squawk ${sq[1]}${sq[3]}${sq[2]}${sq[4]}, correction, squawk ${sq[1]}${sq[2]}${sq[3]}${sq[4]}`);
  }
  let out = `${cs}, ${rest}`;
  // ---- local language to local pilots where that really happens (French at French airports...)
  if (ctx.realism && profile.localLanguage && ctx.a && ctx.a.nat === profile.localLanguage.nat) out = translate(out, profile.localLanguage.lang) || out;
  return out;
}

const FR = [[/cleared to land/g, "autorisé atterrissage"], [/cleared for takeoff/g, "autorisé décollage"], [/\brunway\b/g, "piste"],
  [/line up and wait/g, "alignez-vous et attendez"], [/\bwind (\d{3}) degrees (\d+) knots/g, "vent $1 degrés $2 nœuds"], [/\bcontact\b/g, "contactez"],
  [/\btaxi to holding point\b/g, "roulez point d'arrêt"], [/\bvia\b/g, "via"], [/\bsquawk\b/g, "transpondeur"], [/\bgoodbye\b/g, "au revoir"]];
export function translate(text, lang) {
  if (lang !== "fr") return null;
  let t = text;
  for (const [re, w] of FR) t = t.replace(re, w);
  return t;
}

// ------------------------------------------------------------------------------------------------- validator
/** Is this a legal transmission for the region? {ok, problems: []} (ICAO Doc 4444, UK CAP 413, US FAA 7110.65). */
export function validate(text, region = "ICAO") {
  const p = [];
  const t = String(text || "");
  const low = t.toLowerCase();
  if (!/^[^,]+,/.test(t) && !/^all stations\b/i.test(t)) p.push("starts with the callsign (or 'all stations')");
  if (/position and hold/.test(low)) p.push("'position and hold' is not used: 'line up and wait'");
  if (/\bfl ?\d/.test(low)) p.push("say 'flight level', not 'FL'");
  if (/cleared (to land|for (immediate )?takeoff|touch and go)/.test(low)) {
    if (!/\brunway \d{1,2}[lrc]?\b/.test(low)) p.push("a takeoff / landing clearance names the runway");
    if (!/\bwind (\d{3} (degrees|at)|calm|variable)/.test(low)) p.push("wind with every takeoff and landing clearance");
    if (/line up and wait/.test(low) && /cleared (to land|for)/.test(low.replace(/line up and wait.*$/, "")) === false && /cleared for takeoff/.test(low)) p.push("line up and wait and a takeoff clearance in one");
  }
  if (/\bcontact\b/.test(low) && !/\bcontact [a-z ]+ \d{3}\.\d{1,3}\b/.test(low) && !/frequency change approved/.test(low)) p.push("'contact' + unit + frequency");
  const sq = /squawk (\d+)/.exec(low);
  if (sq && !/^[0-7]{4}$/.test(sq[1]) && !/correction/.test(low)) p.push("a squawk is four octal digits");
  if (/\b(climb|descend)(?: and maintain)? (\d{3,5})\b(?! feet)/.test(low) && !/flight level/.test(low)) p.push("altitudes in feet");
  if (region === "US" && /\btaxi to holding point\b/.test(low)) p.push("FAA: 'taxi to runway ...', not 'holding point'");
  if (region !== "US" && /\bmaintain\b.*\buntil further advised\b/.test(low)) p.push("not ICAO wording");
  return { ok: p.length === 0, problems: p };
}

// ------------------------------------------------------------------------------------------------- explanations
/** Why the AI controller said it (for the Auto ATC log and the assist suggestions). */
export function explain(sim, a, pos, text) {
  const t = String(text || "");
  const NMf = (m) => (m / NM).toFixed(1);
  try {
    if (/cleared to land|cleared touch and go/.test(t)) {
      const next = sim.finalTraffic ? sim.finalTraffic(a.end.rwy, a).find(f => f.ac !== a && f.nm * NM > sim.distToThr(a)) : null;
      return `runway ${a.end.name} free${next ? `, next arrival ${next.nm.toFixed(1)} NM` : ""}`;
    }
    if (/cleared for (immediate )?takeoff/.test(t)) {
      const e = a.depEnd || sim.depEnd;
      const arr = sim.nearestArrival ? sim.nearestArrival(e) : Infinity;
      const gap = sim.lastTakeoff ? Math.round(sim.t - sim.lastTakeoff.t) : null;
      return `runway ${e.name} free, nearest arrival ${arr === Infinity ? "none" : NMf(arr) + " NM"}${gap != null ? `, ${gap} s since the last departure` : ""}`;
    }
    if (/line up and wait/.test(t)) return "runway free, a gap before the next arrival";
    if (/go around/.test(t)) return "no landing clearance possible in time";
    if (/push and start/.test(t)) return "nobody passing behind the stand";
    if (/taxi to/.test(t)) return `shortest conflict-free route${a.taxiTo === "stand" || /stand/.test(t) ? " to a free stand that fits" : ""}`;
    if (/cross runway/.test(t)) return "runway free, nobody on final inside 3 NM";
    if (/cleared to .* squawk/.test(t)) return "flight plan, SID for the runway in use, next free squawk";
    if (/\bcontact\b/.test(t)) return "handoff to the next sector";
    if (/identified|radar contact/.test(t)) return "first contact: identified, descent / approach clearance";
    if (/standby/.test(t)) return "busy: one at a time";
    if (/reduce speed|increase speed/.test(t)) return "spacing on final";
    if (/number \d/.test(t)) return "runway still occupied: sequence and continue";
  } catch { /* the reason is a nicety */ }
  return "";
}

// ------------------------------------------------------------------------------------------------- traffic information
/** "traffic 2 o'clock, 5 miles, opposite direction, A320, 1000 feet above" for `a` about `o`. */
export function trafficInfo(a, o, spokenType = (t) => t) {
  const dx = o.pos[0] - a.pos[0], dy = o.pos[1] - a.pos[1];
  const brg = (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360;
  const rel = (brg - a.hdg + 360) % 360;
  const clock = Math.round(rel / 30) % 12 || 12;
  const miles = Math.max(1, Math.round(Math.hypot(dx, dy) / NM));
  const dh = Math.abs(((o.hdg - a.hdg + 540) % 360) - 180);
  const dir = dh > 135 ? "opposite direction" : dh < 45 ? "same direction" : (((o.hdg - a.hdg + 360) % 360) < 180 ? "crossing left to right" : "crossing right to left");
  const dz = Math.round(((o.alt || 0) - (a.alt || 0)) / 100) * 100;
  const alt = Math.abs(dz) < 200 ? "same level" : `${Math.abs(dz)} feet ${dz > 0 ? "above" : "below"}`;
  return `traffic ${clock} o'clock, ${miles} ${miles === 1 ? "mile" : "miles"}, ${dir}, ${spokenType(o.type)}, ${alt}`;
}

/** "number 2, follow the A320 on 4 mile final" */
export function sequenceInfo(n, lead, nm, spokenType = (t) => t) {
  return `number ${n}, follow the ${spokenType(lead.type)} on ${Math.max(1, Math.round(nm))} mile final`;
}

// ================================================================================================= the simulation
export function installAutoAtc(Sim) {
  const P = Sim.prototype;

  /** Mode of a position: manual (you), assist (suggestions), auto (an AI controller works it). */
  P.modeOf = function (pos) { return (this.atcMode && this.atcMode[pos]) || "manual"; };
  P.setMode = function (pos, mode) {
    this.atcMode ||= {};
    const keys = pos === "ALL" ? POS : [pos];
    for (const k of keys) this.atcMode[k] = MODES.includes(mode) ? mode : "manual";
    this.onEvent({ type: "atcMode", pos, mode });
  };

  /** This shift's controller on `pos` (a new one every 45-90 min of sim time, who says so on the frequency). */
  P.controllerFor = function (pos) {
    this.ctrls ||= {};
    const prof = this.profile || defaultProfile(this.apt.icao, this.apt, this.positions);
    let c = this.ctrls[pos];
    if (!c) { c = this.ctrls[pos] = { ...makeController(pos, prof, 0, this.ctrlSeed || 1), start: this.t }; return c; }
    if (this.t - c.start > c.shiftLength) {
      const n = makeController(pos, prof, c.shift + 1, this.ctrlSeed || 1);
      this.ctrls[pos] = c = { ...n, start: this.t };
      if (this.ac.some(a => a.freq === pos && !a.veh)) {
        const unit = this.split && this.positions[pos] ? this.positions[pos].name : this.unitName(pos);
        const text = `all stations, ${unit}, new controller, information ${this.atis()} current`;
        this.onRadio({ from: "atc", ai: true, pos, text, say: text, ctrl: c });
        this.onEvent({ type: "shiftChange", pos, ctrl: c, text });
      }
    }
    return c;
  };

  /** Speak for an AI position: the canonical instruction is applied, this controller's wording is what is heard. */
  P.atcSay = function (pos, canonical, a) {
    const ctrl = this.controllerFor(pos);
    const prof = this.profile || defaultProfile(this.apt.icao, this.apt, this.positions);
    const load = workload(this, pos);
    a.atcHeard ||= {};
    const first = !a.atcHeard[pos];
    a.atcHeard[pos] = true;
    const prev = /cleared to land/.test(canonical) ? this.leaderOnFinal && this.leaderOnFinal(a) : null;
    const heavyAhead = (/cleared for (immediate )?takeoff/.test(canonical) && this.lastTakeoff && ["H", "J"].includes(this.lastTakeoff.wtc) && this.t - this.lastTakeoff.t < 180) ||
      (prev && ["H", "J"].includes(prev.ac.wtc));
    const hour = new Date(this.clockUtc + this.t * 1000).getUTCHours() + Math.round((this.apt.d.lon || 0) / 15);
    const shown = style(canonical, { a, pos, ctrl, profile: prof, load, first, hour: (hour + 24) % 24, qnh: this.qnh || null, heavyAhead,
      realism: !!this.realism, random: Math.random });
    const v = validate(shown, prof.region);
    const text = v.ok ? shown : canonical;
    (this.txLog ||= []).push({ t: this.t, pos });
    if (this.txLog.length > 400) this.txLog.splice(0, 200);
    this.atc(pos, canonical, { display: text, ctrl });
    this.onEvent({ type: "autoAtc", pos, ac: a, text, canonical, why: explain(this, a, pos, canonical), load, ctrl: ctrl.name, problems: v.problems });
    this.landline(pos, canonical, a);
  };

  /** Coordination between positions, heard faintly in the background (releases, handoffs, crossings). */
  P.landline = function (pos, text, a) {
    const say = (to, what) => this.onEvent({ type: "landline", from: pos, to, text: what });
    const m = /contact (\w+)/.exec(text);
    if (m) {
      const to = { Ground: "GND", Tower: "TWR", Radar: "APP", Approach: "APP", Director: "APP", Departure: "APP", Control: "CTR", Center: "CTR" }[m[1]] || "";
      if (to) say(to, `${a.cs} ${a.kind === "dep" ? "airborne / handed over" : "inbound, handed over"} — accepted`);
    } else if (/cleared for (immediate )?takeoff/.test(text) && this.split && this.positions.APP) say("APP", `release ${a.cs} runway ${(a.depEnd || this.depEnd).name} — released`);
    else if (/cross runway/.test(text) && pos === "GND") say("TWR", `${a.cs} crossing runway ${(/cross runway (\S+)/.exec(text) || [])[1]} — approved`);
  };

  /** Assist: what the AI controller would say to `a` now, without saying it (no squawk taken, no flags set). */
  P.assistFor = function (a, pos) {
    if (a.human || (a.tcas && a.tcas.ra)) return null;
    const shadow = { ...a, crossOk: new Set(a.crossOk || []), reports: { ...(a.reports || {}) } };
    this._dry = true;
    let text = null;
    try { text = this.aiDecide(shadow, pos); } catch { text = null; } finally { this._dry = false; }
    if (!text) return null;
    return { text, why: explain(this, a, pos, text) };
  };
}
