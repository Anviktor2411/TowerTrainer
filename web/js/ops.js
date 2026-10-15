// Operations like a real tower: wind components and per-type limits, the runway change procedure, low visibility
// procedures (RVR, CAT II/III holding points, stop bars, bigger spacing), de-icing with holdover times, CTOT slots
// and A-CDM times, the missed approach from navdata. Installed into Sim as methods (installOps).
import { dist, vecFromHdg, hdgOf, angDiff, KT } from "./airport.js";
import { rint, rnd, AC_DIM } from "./data.js";
import { wakeDepSeconds, wakeArrNm } from "./flow.js";

const NM = 1852;
// crosswind / tailwind limits (kt) by silhouette class
const LIMITS = { widebody: { x: 35, tail: 10 }, airliner: { x: 33, tail: 10 }, regional: { x: 30, tail: 10 }, turboprop: { x: 30, tail: 10 }, props: { x: 15, tail: 5 }, ga: { x: 15, tail: 5 }, helos: { x: 25, tail: 10 }, heli: { x: 25, tail: 10 } };

/**
 * Scripted weather timelines (minutes from the start). Each step is applied through weatherFromMetar / setWind so
 * the whole operation reacts: runway change hints, LVP, de-icing, gust go-arounds, snow clearing.
 */
export const WX_SCENARIOS = {
  live: null,
  veer: [
    { at: 0, wind: { dir: 0, spd: 8 }, note: "wind veering, runway change coming" },
    { at: 6, wind: { dir: 45, spd: 10 } }, { at: 12, wind: { dir: 90, spd: 12 } }, { at: 18, wind: { dir: 135, spd: 14 } },
    { at: 24, wind: { dir: 180, spd: 16 } }, { at: 32, wind: { dir: 180, spd: 18, gust: 30 }, note: "gusts" }, { at: 50, wind: { dir: 180, spd: 10 } },
  ],
  gusts: [
    { at: 0, wind: { dir: 0, spd: 15, gust: 28 }, note: "gusty: expect go-arounds" }, { at: 20, wind: { dir: 20, spd: 18, gust: 34 } }, { at: 40, wind: { dir: 10, spd: 12 } },
  ],
  fog: [
    { at: 0, vis: 3000, wx: ["BR"], temp: 4, dew: 4, note: "fog forming" }, { at: 5, vis: 1200, wx: ["BR"] }, { at: 10, vis: 500, rvr: 450, wx: ["FG"], note: "LVP" },
    { at: 18, vis: 250, rvr: 200, wx: ["FG"], note: "CAT III" }, { at: 35, vis: 800, rvr: 700, wx: ["BR"] }, { at: 45, vis: 3000, wx: [] },
  ],
  snow: [
    { at: 0, temp: -2, dew: -3, vis: 2500, wx: ["SN"], wind: { dir: 30, spd: 8 }, note: "snow: de-icing & snow clearing" }, { at: 15, vis: 1500, wx: ["SN"] },
    { at: 30, vis: 1000, rvr: 900, wx: ["SN"] }, { at: 50, vis: 4000, wx: [] },
  ],
};

/** A synthetic METAR for a scripted weather state (the ATIS and the radar tint are built from it). */
export function synthMetar(icao, utcHHMM, w) {
  const wind = w.wind && w.wind.dir != null ? `${String(Math.round(w.wind.dir / 10) * 10 % 360).padStart(3, "0")}${String(Math.round(w.wind.spd || 0)).padStart(2, "0")}${w.wind.gust ? "G" + String(Math.round(w.wind.gust)).padStart(2, "0") : ""}KT` : "00000KT";
  const vis = w.vis == null ? "9999" : String(Math.min(9999, Math.max(50, Math.round(w.vis / 50) * 50))).padStart(4, "0");
  const rvr = w.rvr != null ? ` R${w.rwy || "26"}/${String(Math.round(w.rvr / 25) * 25).padStart(4, "0")}N` : "";
  const wx = (w.wx || []).length ? " " + w.wx.join(" ") : "";
  const clouds = w.vis != null && w.vis < 1000 ? " VV002" : w.wx && w.wx.includes("SN") ? " OVC008" : w.vis != null && w.vis < 5000 ? " BKN004" : " SCT030";
  const t = (x) => (x < 0 ? "M" : "") + String(Math.abs(Math.round(x))).padStart(2, "0");
  const temp = w.temp == null ? 12 : w.temp, dew = w.dew == null ? Math.min(temp, temp - 3) : w.dew;
  return `${icao} ${utcHHMM.slice(0, 2)}${utcHHMM.slice(2, 4)}Z ${wind} ${vis}${rvr}${wx}${clouds} ${t(temp)}/${t(dew)} Q${w.qnh || 1013}`;
}

export function installOps(Sim) {
  const P = Sim.prototype;

  /** Head/cross/tail components (kt) of the current wind on runway end `e`. */
  P.windOn = function (e) {
    const w = this.wind;
    if (!w || w.dir == null) return { head: 0, cross: 0, tail: 0, gust: 0 };
    const rel = (w.dir - e.hdg) * Math.PI / 180;
    const spd = w.spd || 0, g = Math.max(spd, w.gust || 0);
    const head = Math.cos(rel) * spd, cross = Math.abs(Math.sin(rel) * g);
    return { head, cross, tail: Math.max(0, -head), gust: Math.max(0, (w.gust || 0) - spd) };
  };
  P.limitsFor = function (a) {
    const shape = (AC_DIM[a.type] || [])[2] || (a.heli ? "heli" : a.ga ? "ga" : a.wtc === "H" ? "widebody" : "airliner");
    return LIMITS[shape] || LIMITS.airliner;
  };
  /** Why the crew would refuse this runway end (tail/crosswind), or null. */
  P.windRefusal = function (a, e) {
    const w = this.windOn(e), lim = this.limitsFor(a);
    if (w.tail > lim.tail + 1) return `tailwind component ${Math.round(w.tail)} knots`;
    if (w.cross > lim.x + 1) return `crosswind ${Math.round(w.cross)} knots exceeds our limit`;
    return null;
  };
  /** The best runway end for the wind (longest usable end with the most headwind). */
  P.bestEndForWind = function () {
    let best = null, bs = -Infinity;
    for (const r of this.apt.runways) for (const e of r.ends) {
      if (!this.apt.entries(e).length) continue;
      const w = this.windOn(e);
      const s = w.head * 10 - w.cross * 2 + r.len / 1000;
      if (s > bs) { bs = s; best = e; }
    }
    return best;
  };
  /** Called when the wind changes: recommends a runway change when the tailwind grows. */
  P.checkRunwayChange = function () {
    const cur = this.windOn(this.depEnd), best = this.bestEndForWind();
    if (!best || best === this.depEnd) { this.rwyChangeHint = null; return null; }
    if (cur.tail > 5 && this.windOn(best).tail < cur.tail - 5) {
      if (this.rwyChangeHint !== best.name) {
        this.rwyChangeHint = best.name;
        this.onEvent({ type: "runwayChange", recommended: best.name, tail: Math.round(cur.tail), current: this.depEnd.name });
        this.alert(`Wind ${String(Math.round(this.wind.dir)).padStart(3, "0")}°/${Math.round(this.wind.spd)} kt: ${Math.round(cur.tail)} kt tailwind on runway ${this.depEnd.name} — runway change to ${best.name} recommended.`, "rwychg" + best.name, false);
      }
      return best.name;
    }
    return null;
  };
  /** Set the wind (dir, spd, gust) and let the operation react. */
  P.setWind = function (w) {
    this.wind = { dir: w.dir, spd: w.spd || 0, gust: w.gust || 0 };
    this.checkRunwayChange();
  };
  /**
   * Runway change procedure: departures stop on the old runway, the last arrival already inside 8 NM lands on it,
   * everything new uses the new runway, the ATIS rolls when the old runway is clear.
   */
  P.changeRunway = function (name) {
    const e = this.apt.findRunwayEnd(name);
    if (!e || e === this.depEnd) return false;
    const old = this.depEnd;
    this.rwyChange = { from: old, to: e, at: this.t, done: false };
    this.depEnd = e; this.arrEnd = e; this.rwyChangeHint = null;
    // arrivals far out go to the new runway; the ones close in finish on the old one
    for (const a of this.ac) {
      if (a.kind === "arr" && a.state === "final" && a.end === old && this.distToThr(a) > 8 * NM && !a.landClr) {
        a.end = e; a.landClr = false;
        a.pos = [e.thr[0] - e.v[0] * this.distToThr(a), e.thr[1] - e.v[1] * this.distToThr(a)]; a.hdg = e.hdg;
        a.alt = this.arrAlt(a); a.calledIn = false; a.callAt = this.t + rint(5, 15);
      }
      if (a.kind === "dep" && a.onGround && a.depEnd === old && ["taxi", "holding", "cond_lineup"].includes(a.state) && !a.nordo) {
        a.rwyChanged = true;      // asks for a new taxi clearance on their next call
        if (a.state === "holding") { a.callAt = this.t + rint(10, 30); }
      }
    }
    this.onEvent({ type: "runwayChanged", from: old.name, to: e.name });
    if (this.t > 0) this.rollAtis();
    return true;
  };
  P.runwayChangeTick = function () {
    const c = this.rwyChange;
    if (!c || c.done) return;
    const old = c.from;
    const busy = this.ac.some(a => (a.kind === "arr" && a.end === old && !["parked", "vacated", "holding_short", "taxi"].includes(a.state)) ||
      (a.kind === "dep" && a.depEnd === old && ["lineup", "lining", "lined_up", "roll"].includes(a.state)));
    if (!busy) { c.done = true; this.onEvent({ type: "runwayChangeDone", to: c.to.name }); }
  };

  // ---------- low visibility procedures ----------
  P.setLvp = function (on, why) {
    if (!!this.lvp === !!on) return;
    this.lvp = !!on;
    for (const b of this.apt.stopBars) if (!b.manual) b.lit = this.lvp;   // stop bars come on with LVP
    this.onEvent({ type: "lvp", on: this.lvp, why });
    if (this.t > 0) this.rollAtis();
  };
  /** Auto LVP from the METAR: RVR < 550 m or visibility < 600 m. */
  P.weatherFromMetar = function (dec) {
    if (!dec) return;
    const rvr = dec.rvr && dec.rvr.length ? Math.min(...dec.rvr.map(r => r.m)) : null;
    const vis = dec.vis;
    this.rvr = rvr; this.vis = vis;
    this.wxCodes = (dec.wx || []).flatMap(w => w.codes);
    this.temp = dec.temp; this.dew = dec.dew;
    const ceil = (dec.clouds || []).filter(c => ["BKN", "OVC", "VV"].includes(c.cover) && c.ft != null).map(c => c.ft);
    this.ceiling = ceil.length ? Math.min(...ceil) : null;
    if (dec.wind && dec.wind.dir != null && !this.wxScenario) this.setWind({ dir: dec.wind.dir, spd: dec.wind.spd || 0, gust: dec.wind.gust || 0 });
    const low = (rvr != null && rvr < 550) || (vis != null && vis < 600);
    if (!this.lvpManual) this.setLvp(low, low ? `RVR ${rvr ?? ""} vis ${vis ?? ""}`.trim() : "weather improved");
    const precip = this.wxCodes.some(c => ["SN", "SG", "FZ", "RA", "DZ", "PL"].includes(c)) || this.wxCodes.includes("FG");
    this.snow = this.wxCodes.some(c => ["SN", "SG", "PL"].includes(c));
    this.deiceNeeded = dec.temp != null && dec.temp <= 3 && (precip || dec.temp <= -1 || (dec.dew != null && dec.temp - dec.dew <= 2));
  };
  /** Spacing the AI tower uses between arrivals (NM) and after a departure (s), bigger under LVP. */
  P.arrSpacingNm = function (lead, follower) { return Math.max(this.lvp ? 6 : 3, wakeArrNm(lead, follower, this.recat)); };
  P.depSpacingS = function (lead, follower) { return Math.max(this.lvp ? 120 : 60, wakeDepSeconds(lead, follower, this.recat)); };
  P.stopBarAt = function (a, b) { return this.apt.stopBarOnEdge(a, b); };
  P.setStopBar = function (bar, lit, manual = true) { bar.lit = !!lit; if (manual) bar.manual = true; this.onEvent({ type: "stopBar", bar }); };

  // ---------- de-icing ----------
  P.deicePad = function () {
    return this.apt.stands.find(s => /de-?ic/i.test(s.name)) || null;
  };
  /** Start de-icing (on stand or at the pad); holdover 20-45 min depending on the precipitation. */
  P.startDeice = function (a, atPad) {
    const hot = this.snow ? rint(20, 30) * 60 : rint(30, 45) * 60;
    a.deice = { start: this.t, until: this.t + rint(6, 11) * 60, hot, atPad: !!atPad };
    a.state = "deicing"; a.holdPos = true;
    this.onEvent({ type: "deice", ac: a });
  };
  P.deiceTick = function (a) {
    const d = a.deice;
    if (!d || a.state !== "deicing") return;
    if (this.t >= d.until) {
      a.hotUntil = this.t + d.hot; a.deiced = true; a.holdPos = false;
      a.state = d.atPad ? "taxi_req" : "push_req"; a.callAt = this.t + rint(10, 40);
      this.call(a, "stillWaitingGeneric", { what: `de-icing complete, holdover time ${Math.round(d.hot / 60)} minutes, ${d.atPad ? "request taxi" : "request push and start"}`, greet: "" }, "GND");
      a.state = d.atPad ? "taxi_req" : "push_req";
    }
  };
  /** Holdover expired before takeoff: the crew will not go. */
  P.hotExpired = function (a) { return !!(this.deiceNeeded && a.deiced && a.hotUntil != null && this.t > a.hotUntil); };

  // ---------- slots & A-CDM ----------
  /** Give a departure its target times; ~25 % get a CTOT slot. */
  P.assignSlot = function (a) {
    if (a.ga || a.ctot != null) return;
    a.tobt = a.callAt != null && a.callAt < Infinity ? a.callAt : this.t;
    a.taxiEst = 480 + rint(0, 300);
    a.queueDelay = rint(0, 240);
    a.tsat = a.tobt + a.queueDelay;
    if (Math.random() < 0.25) a.ctot = a.tsat + a.taxiEst + rint(120, 900);
  };
  P.ctotCheck = function (a) {
    if (a.ctot == null) return;
    const d = a.ctot - this.t;
    if (d > 300 || d < -600) {
      this.stats.ctotMissed = (this.stats.ctotMissed || 0) + 1;
      this.alert(`${a.cs} departed outside its CTOT window (${d > 0 ? Math.round(d / 60) + " min early" : Math.round(-d / 60) + " min late"}).`, "ctot" + a.cs, false);
    }
  };

  // ---------- missed approach from navdata ----------
  /** Fly the published missed approach (legs with lat/lon, altitudes) when main.js provides it, else straight ahead. */
  P.flyMissed = function (a) {
    const legs = this.missedFor ? this.missedFor(a.end) : null;
    if (!legs || !legs.length) return false;
    const pts = legs.filter(l => l.lat != null).map(l => ({ p: this.apt.toXY(l.lat, l.lon), leg: l.fix, alt: l.alt }));
    if (!pts.length) return false;
    a.wps = pts; a.wpi = 0; a.state = "circuit"; a.missed = true;
    a.circuitAlt = Math.max(3000, pts.find(p => p.alt)?.alt || 3000); a.circuitSpd = (a.ga ? 100 : 200) * KT;
    a.circuitStart = this.t; a.circuitFrom = [...a.pos]; a.circuitLeg = "missed approach";
    a.onMissedEnd = () => { a.gone = true; };
    return true;
  };

  // ---------- scripted weather ----------
  /** Start a weather scenario ("veer", "gusts", "fog", "snow") or go back to the live METAR (null / "live"). */
  P.setWxScenario = function (name) {
    const steps = WX_SCENARIOS[name] || null;
    this.wxScenario = steps ? { name, steps, start: this.t, idx: 0, state: { wind: { ...this.wind }, vis: null, rvr: null, wx: [], temp: this.temp ?? 10, dew: this.dew ?? 6 } } : null;
    this.wxOverride = null;
    if (!steps) { this.onEvent({ type: "wx", live: true }); return; }
    this.wxTick();
  };
  P.wxTick = function () {
    const s = this.wxScenario;
    if (!s) return;
    let changed = false;
    while (s.idx < s.steps.length && this.t - s.start >= s.steps[s.idx].at * 60) {
      const st = s.steps[s.idx++];
      if (st.wind) s.state.wind = { ...st.wind, gust: st.wind.gust || 0 };
      if ("vis" in st) s.state.vis = st.vis;
      s.state.rvr = st.rvr ?? null;
      if (st.wx) s.state.wx = st.wx;
      if (st.temp != null) s.state.temp = st.temp;
      if (st.dew != null) s.state.dew = st.dew;
      s.note = st.note || s.note;
      changed = true;
    }
    if (!changed) return;
    const w = s.state;
    this.wxOverride = { wind: { ...w.wind }, vis: w.vis, rvr: w.rvr, wx: [...w.wx], temp: w.temp, dew: w.dew, rwy: this.depEnd.name, note: s.note };
    this.setWind(w.wind);
    this.weatherFromMetar({ wind: null, vis: w.vis, rvr: w.rvr != null ? [{ m: w.rvr }] : [], wx: [{ codes: w.wx }], clouds: w.vis != null && w.vis < 1000 ? [{ cover: "VV", ft: 200 }] : [], temp: w.temp, dew: w.dew });
    this.onEvent({ type: "wx", note: s.note, scenario: s.name });
    if (this.t > 0) this.rollAtis();
  };

  /** One-second tick for the operations. */
  P.opsTick = function () {
    this.runwayChangeTick();
    this.wxTick();
    for (const a of this.ac) {
      if (a.state === "deicing") this.deiceTick(a);
    }
  };
}
