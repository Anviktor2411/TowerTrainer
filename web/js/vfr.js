// VFR and GA: reporting points, inbound joins, visual circuits with downwind/base/final reports, touch-and-go,
// full stop, extend downwind, orbits, special VFR and helicopters. Installed into Sim (installVfr).
import { dist, vecFromHdg, hdgOf, angDiff, KT } from "./airport.js";
import { rint, rnd, LETTER_WORD } from "./data.js";
import { pilotCall } from "./phrase.js";

const NM = 1852;

/** Default VFR reporting points: 5 NM from the field on the cardinal bearings, named phonetically. */
export function defaultVfrPoints(apt) {
  const pts = [["N", 0, "November"], ["E", 90, "Echo"], ["S", 180, "Sierra"], ["W", 270, "Whiskey"]];
  return pts.map(([id, brg, name]) => ({ id, name, brg, nm: 5, p: [Math.sin(brg * Math.PI / 180) * 5 * NM, Math.cos(brg * Math.PI / 180) * 5 * NM], alt: 1500 }));
}

export function installVfr(Sim) {
  const P = Sim.prototype;

  P.vfrPoints = function () { return this._vfrPoints || (this._vfrPoints = defaultVfrPoints(this.apt)); };
  P.setVfrPoints = function (list) {
    this._vfrPoints = (list || []).map(p => ({ ...p, p: p.p || [Math.sin(p.brg * Math.PI / 180) * p.nm * NM, Math.cos(p.brg * Math.PI / 180) * p.nm * NM], alt: p.alt || 1500 }));
    if (!this._vfrPoints.length) this._vfrPoints = defaultVfrPoints(this.apt);
  };
  /** Special VFR conditions: visibility below 5 km or ceiling below 1500 ft. */
  P.svfrNeeded = function () { return (this.vis != null && this.vis < 5000) || (this.ceiling != null && this.ceiling < 1500); };

  /** A VFR arrival approaching a reporting point from outside, asking to join. */
  P.spawnVfrInbound = function () {
    const stands = this.freeStands(["tie_down", "hangar", "misc", "gate"], true);
    if (!stands.length) return null;
    const f = this.makeGA();
    const pt = rnd(this.vfrPoints());
    const from = [pt.p[0] * 2.2, pt.p[1] * 2.2];
    Object.assign(f, {
      kind: "arr", state: "inbound", pos: from, hdg: hdgOf(-from[0], -from[1]), spd: f.appSpd * 1.4, alt: pt.alt, onGround: false, end: this.arrEnd,
      landClr: false, squawk: this.region === "US" ? "1200" : "7000", assignedSq: null, xpdr: "C", ifr: false, callAt: this.t + rint(20, 60), stand: stands[0],
      cfl: pt.alt, freq: this.split ? "TWR" : "ALL", vfrPoint: pt, vfr: true, wps: [{ p: pt.p, leg: pt.name, alt: pt.alt }], wpi: 0, circuitAlt: pt.alt,
      circuitSpd: f.appSpd * 1.4, circuitStart: this.t, circuitFrom: from, reports: {}, fullStop: true,
    });
    f.stand.reserved = f;
    this.ac.push(f);
    this.onEvent({ type: "spawn", ac: f });
    return f;
  };

  /** Join instruction: "join left downwind runway 26" / "join final" / "join overhead". */
  P.joinCircuit = function (a, i) {
    const end = (i.rwy && this.apt.findRunwayEnd(i.rwy)) || a.end || this.arrEnd;
    a.end = end; a.joined = true;
    const side = i.side || a.circuitSide || (this.region === "US" ? "left" : "left");
    if (i.leg === "final" || i.leg === "straight in") {
      a.wps = [{ p: [end.thr[0] - end.v[0] * 4 * NM, end.thr[1] - end.v[1] * 4 * NM], leg: "final" }]; a.wpi = 0;
    } else {
      this.startCircuit(a, end, { side, joinNm: a.ga ? 2.5 : 4, altFt: a.ga ? 1000 : 1500 });
      // enter at the leg asked for: skip the earlier waypoints
      const idx = { crosswind: 0, overhead: 0, downwind: 1, base: 3 }[i.leg] ?? 1;
      a.wpi = idx;
    }
    a.state = "circuit"; a.reports = { ...(a.reports || {}), downwind: true, final: true };
    return `join ${side === "right" ? "right" : "left"} ${i.leg} runway ${end.name}`;
  };

  /** Touch-and-go / option: after touchdown, go again and stay in the circuit. */
  P.touchAndGo = function (a) {
    a.touchGo = true; a.fullStop = false; a.landClr = true;
  };
  P.fullStop = function (a) { a.fullStop = true; a.touchGo = false; };

  /** After a touch-and-go: climb out and rejoin the circuit (same side). */
  P.goAgain = function (a) {
    a.touchGo = false; a.landClr = false;
    a.onGround = false; a.state = "goaround"; a.rejoin = true; a.circuits = (a.circuits || 0) + 1;
    this.stats.departures++;
    this.onEvent({ type: "touchGo", ac: a });
    if (!a.nordo) this.call(a, "stillWaitingGeneric", { what: "touch and go, going around", greet: "" }, "TWR");
    if (a.circuits >= (a.wantCircuits || 2)) a.fullStop = true;
  };

  P.extendDownwind = function (a) {
    if (a.state !== "circuit" || !a.wps) return false;
    const i = a.wps.findIndex(w => w.leg === "late downwind");
    if (i < 0) return false;
    const w = a.wps[i], prev = a.wps[i - 1] || w;
    const v = [w.p[0] - prev.p[0], w.p[1] - prev.p[1]], l = Math.hypot(...v) || 1;
    a.wps[i] = { ...w, p: [w.p[0] + v[0] / l * 1.5 * NM, w.p[1] + v[1] / l * 1.5 * NM] };
    const base = a.wps[i + 1];
    if (base) base.p = [base.p[0] + v[0] / l * 1.5 * NM, base.p[1] + v[1] / l * 1.5 * NM];
    const fin = a.wps[i + 2];
    if (fin) fin.p = [fin.p[0] + v[0] / l * 1.5 * NM, fin.p[1] + v[1] / l * 1.5 * NM];
    a.extended = true;
    return true;
  };
  /** A 360 at the present position: the waypoint list gets a short loop inserted. */
  P.orbit = function (a, side) {
    if (a.state !== "circuit" && a.state !== "inbound" && a.state !== "final") return false;
    const R = a.ga ? 600 : 1500, h = a.hdg * Math.PI / 180;
    const n = side === "right" ? [Math.cos(h), -Math.sin(h)] : [-Math.cos(h), Math.sin(h)];
    const c = [a.pos[0] + n[0] * R, a.pos[1] + n[1] * R];
    const loop = [];
    for (let k = 1; k <= 4; k++) { const ang = (side === "right" ? -1 : 1) * k * Math.PI / 2; const vx = a.pos[0] - c[0], vy = a.pos[1] - c[1]; loop.push({ p: [c[0] + vx * Math.cos(ang) - vy * Math.sin(ang), c[1] + vx * Math.sin(ang) + vy * Math.cos(ang)], leg: "orbit" }); }
    if (a.state === "final") { a.wps = [...loop, { p: [a.end.thr[0] - a.end.v[0] * Math.max(2 * NM, this.distToThr(a)), a.end.thr[1] - a.end.v[1] * Math.max(2 * NM, this.distToThr(a))], leg: "final" }]; a.wpi = 0; a.state = "circuit"; a.circuitSpd = a.spd; a.circuitAlt = a.alt; a.circuitStart = this.t; a.circuitFrom = [...a.pos]; }
    else { a.wps.splice(a.wpi, 0, ...loop); }
    return true;
  };

  /** VFR inbound flight reaching its reporting point: calls for joining instructions and holds there (orbits) until told. */
  P.vfrInboundTick = function (a) {
    if (a.state !== "inbound") return;
    if (a.wps && a.wpi >= a.wps.length) {
      if (!a.calledIn) {
        a.calledIn = true; a.reqAt = this.t;
        const pt = a.vfrPoint;
        if (this.svfrNeeded() && !a.svfr) this.call(a, "stillWaitingGeneric", { what: `${a.type ? "" : ""}overhead ${pt.name} at ${pt.alt} feet, request special VFR to land`, greet: undefined }, "TWR");
        else this.call(a, "vfrInbound", { point: pt.name, alt: `${pt.alt} feet`, greet: undefined }, "TWR");
      }
      // hold at the point: orbit while waiting
      if (!a.wps.some(w => w.leg === "orbit")) this.orbit(a, "left");
      a.state = "circuit"; a.circuitHold = true;
      a.onCircuitEnd = () => { if (!a.joined) { a.state = "inbound"; a.wps = [{ p: a.vfrPoint.p, leg: a.vfrPoint.name }]; a.wpi = 0; } };
    }
  };

  /** Helicopter: lifts from its stand, departs direct, no runway needed. */
  P.heliLift = function (a) {
    if (!a.heli || !a.onGround) return false;
    a.state = "airborne"; a.onGround = false; a.depEnd = this.depEnd; a.alt = 50; a.spd = 20 * KT; a.toClr = true; a.heliDep = true;
    this.stats.departures++;
    return true;
  };
}
