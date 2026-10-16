// A simplified but realistic TCAS II (version 7.1 behaviour) for every AI aircraft, and STCA for the controller.
//
//   surveillance  every transponding aircraft within 14 NM / ±9900 ft: AI aircraft and real pilots (XRadio); nothing
//                 on the ground; transponder off / standby is invisible; Mode A (no altitude) gives a TA, never an RA
//   logic         range tau and vertical tau against the sensitivity level of the own altitude (SL2-SL7, the TCAS II
//                 v7.1 tables: TA tau 20-48 s, RA tau 15-35 s, DMOD, ZTHR, ALIM)
//   advisories    TA "traffic, traffic"; RA climb / descend / level off / monitor vertical speed / increase /
//                 crossing / reversal, then "clear of conflict"
//   inhibits      no RA below 1000 ft AGL, no Descend below 1100 ft AGL, no Increase Descent below 1450 ft AGL,
//                 no Climb RA above the type's ceiling
//   coordination  AI vs AI: the first to choose locks its sense, the other takes the opposite (Mode S); a real pilot
//                 cannot be coordinated: its own X-Plane RA (PT_TCAS) is complemented, else its vertical trend
//   response      ~5 s to react, 0.25 g to the target vertical speed (1500 fpm, 2500 for "increase"), lateral path
//                 unchanged; after "clear of conflict" back to the last cleared level
// Pure functions first (unit-testable), then installTcas(Sim) for the simulation.
import { KT, FT } from "./airport.js";

const NM = 1852;
const G25 = 0.25 * 9.81 / FT * 60;          // 0.25 g in fpm per second (~483)
export const SURV_RANGE_NM = 14, SURV_ALT_FT = 9900;

// TCAS II v7.1 sensitivity levels (own altitude): TA/RA tau (s), DMOD (NM), ZTHR (ft), ALIM (ft)
const SL_TABLE = [
  { sl: 2, maxFt: 1000, agl: true, taTau: 20, raTau: 0, taDmod: 0.30, raDmod: 0, taZthr: 850, raZthr: 0, alim: 0 },
  { sl: 3, maxFt: 2350, agl: true, taTau: 25, raTau: 15, taDmod: 0.33, raDmod: 0.20, taZthr: 850, raZthr: 600, alim: 300 },
  { sl: 4, maxFt: 5000, taTau: 30, raTau: 20, taDmod: 0.48, raDmod: 0.35, taZthr: 850, raZthr: 600, alim: 300 },
  { sl: 5, maxFt: 10000, taTau: 40, raTau: 25, taDmod: 0.75, raDmod: 0.55, taZthr: 850, raZthr: 600, alim: 350 },
  { sl: 6, maxFt: 20000, taTau: 45, raTau: 30, taDmod: 1.00, raDmod: 0.80, taZthr: 850, raZthr: 600, alim: 400 },
  { sl: 7, maxFt: 42000, taTau: 48, raTau: 35, taDmod: 1.30, raDmod: 1.10, taZthr: 850, raZthr: 700, alim: 600 },
  { sl: 7, maxFt: Infinity, taTau: 48, raTau: 35, taDmod: 1.30, raDmod: 1.10, taZthr: 1200, raZthr: 800, alim: 700 },
];

/** Sensitivity level for own altitude (ft MSL) and height above the ground (ft). */
export function sensitivity(altFt, aglFt = altFt) {
  for (const s of SL_TABLE) {
    if (s.agl ? aglFt < s.maxFt : altFt < s.maxFt) return s;
  }
  return SL_TABLE[SL_TABLE.length - 1];
}

/** Can this aircraft transpond so TCAS sees it? "C"/"S" (Mode S on) = altitude, "A" = no altitude, else invisible. */
export function xpdrClass(t) {
  if (!t || t.onGround) return null;
  if (t.xpdr === "C" || t.xpdr === "S_ALT") return "C";
  if (t.xpdr === "A") return "A";
  return null;
}

/**
 * Geometry between own and intruder. Each: {pos:[x,y] m, vel:[vx,vy] m/s, alt ft, vs fpm}.
 * Returns {range NM, rdot kt (negative closing), tau s (range tau, Infinity when diverging), dz ft (intruder above +),
 *          vtau s (time to co-altitude, Infinity when not converging), tcpa s, missNm (horizontal miss distance)}
 */
export function geometry(own, intr) {
  const dx = intr.pos[0] - own.pos[0], dy = intr.pos[1] - own.pos[1];
  const dvx = intr.vel[0] - own.vel[0], dvy = intr.vel[1] - own.vel[1];
  const r = Math.hypot(dx, dy);
  const rdot = r > 0 ? (dx * dvx + dy * dvy) / r : 0;          // m/s, negative = closing
  const v2 = dvx * dvx + dvy * dvy;
  const tcpa = v2 > 1e-6 ? Math.max(0, -(dx * dvx + dy * dvy) / v2) : 0;
  const miss = Math.hypot(dx + dvx * tcpa, dy + dvy * tcpa);
  const tau = rdot < -0.5 ? -r / rdot : Infinity;
  const dz = intr.alt - own.alt, dzdot = (intr.vs - own.vs) / 60;  // ft/s
  const vtau = dz * dzdot < 0 && Math.abs(dzdot) > 0.1 ? Math.abs(dz / dzdot) : Infinity;
  return { range: r / NM, rdot: rdot / KT, tau, dz, vtau, tcpa, missNm: miss / NM };
}

/** Is there a TA / RA against this intruder (before inhibits)? Uses the modified tau with DMOD like TCAS II. */
export function threat(g, sl, modeA = false) {
  const dm = (dmod) => g.range < dmod;
  const modTau = (dmod) => (g.rdot < -0.5 ? Math.max(0, (g.range * g.range - dmod * dmod) / (g.range * -g.rdot / 3600)) : Infinity);
  const horizTA = dm(sl.taDmod) || (g.rdot < -0.5 && (Math.min(g.tau, modTau(sl.taDmod)) < sl.taTau) && g.missNm < Math.max(sl.taDmod * 2, 1.0));
  const vertTA = modeA || Math.abs(g.dz) < sl.taZthr || g.vtau < sl.taTau;
  const ta = horizTA && vertTA;
  let ra = false;
  if (!modeA && sl.raTau > 0) {
    const horizRA = dm(sl.raDmod) || (g.rdot < -0.5 && Math.min(g.tau, modTau(sl.raDmod)) < sl.raTau && g.missNm < Math.max(sl.raDmod * 2, 0.6));
    const vertRA = Math.abs(g.dz) < sl.raZthr || g.vtau < sl.raTau;
    ra = horizRA && vertRA;
  }
  return { ta, ra };
}

/** Vertical separation at CPA (ft, own minus intruder, signed) if own flies `vsOwn` fpm after `delay` s. */
export function sepAtCpa(own, intr, g, vsOwn, delay = 5) {
  const t = Math.max(1, Math.min(g.tcpa || g.tau || 30, 60));
  const d = Math.min(delay, t);
  const ownAlt = own.alt + own.vs / 60 * d + vsOwn / 60 * (t - d);
  const intrAlt = intr.alt + intr.vs / 60 * t;
  return ownAlt - intrAlt;
}

/**
 * Choose the RA sense (+1 climb, -1 descend) against an intruder.
 * opts: {forced: sense from coordination, aglFt, canClimb, intrSense: a human's own RA, intrTrendFpm}
 */
export function chooseSense(own, intr, g, opts = {}) {
  if (opts.forced) return opts.forced;
  if (opts.intrSense) return -opts.intrSense;                     // a real pilot's own RA: always the opposite
  if (opts.human && opts.intrTrendFpm != null) {                   // no RA data from the real pilot: its trend
    if (opts.intrTrendFpm > 300) return -1;
    if (opts.intrTrendFpm < -300) return 1;
  }
  const up = Math.abs(sepAtCpa(own, intr, g, 1500)), dn = Math.abs(sepAtCpa(own, intr, g, -1500));
  // a sense that crosses the intruder's altitude is only taken when it gives clearly more separation
  const crossUp = own.alt < intr.alt, crossDn = own.alt > intr.alt;
  let s = (up - (crossUp ? 300 : 0)) >= (dn - (crossDn ? 300 : 0)) ? 1 : -1;
  if (s < 0 && (opts.aglFt ?? 5000) < 1500) s = 1;                 // keep away from the ground
  if (s > 0 && opts.canClimb === false) s = -1;
  return s;
}

/** The RA to issue for a sense: kind + target vertical speed (fpm). */
export function raFor(own, intr, g, sense, sl, opts = {}) {
  const already = sense > 0 ? own.vs >= 1500 : own.vs <= -1500;
  const sepNow = sepAtCpa(own, intr, g, own.vs, 0);
  // preventive: the current vertical speed already gives ALIM -- keep it ("monitor vertical speed")
  if (Math.abs(sepNow) >= sl.alim && Math.sign(sepNow) === sense && !opts.increase) {
    return { kind: Math.abs(own.vs) < 300 ? "monitor" : "maintain", vs: own.vs, preventive: true };
  }
  if (opts.increase) return { kind: sense > 0 ? "increase climb" : "increase descent", vs: sense * 2500 };
  const crossing = (sense > 0 && own.alt < intr.alt - 100) || (sense < 0 && own.alt > intr.alt + 100);
  // "level off" (adjust vertical speed) when stopping a climb / descent towards it is enough
  const toward = (intr.alt > own.alt && own.vs > 500) || (intr.alt < own.alt && own.vs < -500);
  if (toward && Math.abs(sepAtCpa(own, intr, g, 0)) >= sl.alim && Math.sign(sepAtCpa(own, intr, g, 0)) === sense) return { kind: "level off", vs: 0 };
  return { kind: (crossing ? "crossing " : "") + (sense > 0 ? "climb" : "descend"), vs: already ? own.vs : sense * 1500 };
}

export const RA_AURAL = {
  climb: "climb, climb", descend: "descend, descend", "crossing climb": "climb, crossing climb", "crossing descend": "descend, crossing descend",
  "increase climb": "increase climb, increase climb", "increase descent": "increase descent, increase descent", "level off": "level off, level off",
  monitor: "monitor vertical speed", maintain: "maintain vertical speed, maintain", reversal: "climb, climb now",
};

/** One second of the pilot following an RA: 5 s to react, then 0.25 g to the target vertical speed. */
export function pilotVs(current, target, sinceRa, dt = 1) {
  if (sinceRa < 5) return current;
  const step = G25 * dt;
  return current + Math.max(-step, Math.min(step, target - current));
}

/** STCA: will these two be inside `nm` and `ft` within `look` s on present tracks? Returns {t, nm, ft} or null. */
export function stca(a, b, { nm = 3, ft = 1000, look = 120 } = {}) {
  for (let t = 0; t <= look; t += 5) {
    const ax = a.pos[0] + a.vel[0] * t, ay = a.pos[1] + a.vel[1] * t, bx = b.pos[0] + b.vel[0] * t, by = b.pos[1] + b.vel[1] * t;
    const h = Math.hypot(ax - bx, ay - by) / NM;
    const v = Math.abs((a.alt + a.vs / 60 * t) - (b.alt + b.vs / 60 * t));
    if (h < nm && v < ft - 50) return { t, nm: h, ft: v };
  }
  return null;
}

// =====================================================================================================================
//  The simulation side
// =====================================================================================================================
const CEILING = { L: 14000, M: 41000, H: 43000, J: 43000 };

export function installTcas(Sim) {
  const P = Sim.prototype;

  /** Kinematics for the logic: position, velocity, altitude, vertical speed (fpm), transponder class. */
  P.tcasState = function (a) {
    const h = (a.hdg || 0) * Math.PI / 180;
    return { pos: a.pos, vel: [Math.sin(h) * (a.spd || 0), Math.cos(h) * (a.spd || 0)], alt: a.alt || 0, vs: a.vsFpm || 0 };
  };
  P.aglFt = function (a) { return (a.alt || 0); };          // the sim's altitudes are above the field

  /** Every step: vertical speeds; once a second: surveillance, advisories, coordination, STCA. */
  P.tcasTick = function (dt) {
    for (const a of this.ac) {
      if (a.onGround || a.veh) { a.vsFpm = 0; a._altPrev = a.alt; continue; }
      if (a.human) { a.vsFpm = a.vs != null ? a.vs / FT * 60 : a.vsFpm || 0; continue; }
      if (a._altPrev != null && dt > 0) a.vsFpm = a.vsFpm == null ? (a.alt - a._altPrev) / dt * 60 : a.vsFpm * 0.7 + 0.3 * (a.alt - a._altPrev) / dt * 60;
      a._altPrev = a.alt;
    }
    if (Math.floor(this.t) === Math.floor(this.t - dt)) return;
    if (this.tcasOn !== false) for (const a of this.ac) if (!a.human && !a.veh && !a.onGround && !a.tcasOff) this.tcasLogic(a);
    this.stcaTick();
  };

  /** Surveillance + logic for one AI aircraft (1 Hz). */
  P.tcasLogic = function (a) {
    const own = this.tcasState(a), agl = this.aglFt(a), sl = sensitivity(own.alt, agl);
    const T = a.tcas || (a.tcas = { ta: null, ra: null });
    let worst = null;
    for (const o of this.ac) {
      if (o === a || o.veh) continue;
      const cls = xpdrClass(o);
      if (!cls) continue;                                                    // on the ground or transponder off
      const intr = this.tcasState(o);
      const dz = intr.alt - own.alt;
      if (Math.hypot(intr.pos[0] - own.pos[0], intr.pos[1] - own.pos[1]) > SURV_RANGE_NM * NM || (cls === "C" && Math.abs(dz) > SURV_ALT_FT)) continue;
      const g = geometry(own, cls === "A" ? { ...intr, alt: own.alt, vs: own.vs } : intr);
      const th = threat(g, sl, cls === "A");
      if (!th.ta && !th.ra) continue;
      const score = (th.ra ? 1000 : 0) - Math.min(g.tau, 200);
      if (!worst || score > worst.score) worst = { o, g, th, intr, cls, score };
    }
    // RA inhibits: below 1000 ft AGL only TAs
    const raAllowed = agl >= 1000 && this.tcasRaAllowed !== false;
    if (worst && worst.th.ra && raAllowed) this.tcasRa(a, worst, own, sl, agl);
    else if (T.ra) {
      // "clear of conflict" only once the range is increasing: until the aircraft have passed the RA stays
      const o = T.ra.intr, g = geometry(own, this.tcasState(o));
      if (!o.gone && this.ac.includes(o) && g.rdot < 0 && g.range < 6) T.lastRaAt = this.t;
      else this.tcasClear(a);
    }
    if (worst && (worst.th.ta || worst.th.ra) && !T.ta) {
      T.ta = { intr: worst.o, t: this.t };
      this.onEvent({ type: "tcas", kind: "ta", ac: a, intr: worst.o });
    } else if (!worst && T.ta && this.t - T.ta.t > 5) T.ta = null;
  };

  /** Coordinated sense for a pair: the first aircraft to choose locks, the other gets the opposite. */
  P.tcasCoord = function (a, o) {
    const key = a.id < o.id ? `${a.id}:${o.id}` : `${o.id}:${a.id}`;
    return (this._tcasLock ||= new Map()).get(key) ? { key, ...this._tcasLock.get(key) } : { key };
  };

  P.tcasRa = function (a, w, own, sl, agl) {
    const T = a.tcas, o = w.o, intr = w.intr, g = w.g;
    const c = this.tcasCoord(a, o);
    let forced = null;
    if (c.owner != null && c.owner !== a.id) forced = -c.sense;                               // the other locked first
    else if (c.owner === a.id) forced = c.sense;
    const human = !!o.human;
    const hRa = human && o.ownTcas && o.ownTcas.level === 2 && o.ownTcas.sense ? o.ownTcas.sense : null;
    const canClimb = (a.alt || 0) < (CEILING[a.wtc] || 41000) - 500;
    let sense = T.ra ? T.ra.sense : chooseSense(own, intr, g, { forced, aglFt: agl, canClimb, human, intrSense: hRa, intrTrendFpm: human ? intr.vs : null });
    // inhibits: no Descend below 1100 ft AGL, no Increase Descent below 1450 ft AGL
    if (sense < 0 && agl < 1100) sense = 1;
    if (sense > 0 && !canClimb) sense = -1;
    let increase = false, reversal = false;
    // the other aircraft reversed (it owns the pair now): complement it -- never both climb or both descend
    if (T.ra && !human && c.owner != null && c.owner !== a.id && T.ra.sense === c.sense) { sense = -c.sense; reversal = true; }
    else if (T.ra) {
      // human: complement its own RA / trend, reverse when it starts moving our way
      if (human) {
        const want = hRa ? -hRa : intr.vs > 300 ? -1 : intr.vs < -300 ? 1 : T.ra.sense;
        if (want !== T.ra.sense && !T.ra.reversed && this.t - T.ra.t > 2) { sense = want; reversal = true; }
        // the real pilot ignores its RA (or keeps closing): increase, alert ATC, debrief
        const ignoring = hRa ? (hRa > 0 ? intr.vs < 300 : intr.vs > -300) && this.t - T.ra.t > 8 : false;
        if ((ignoring || Math.abs(sepAtCpa(own, intr, g, own.vs)) < sl.alim * 0.6) && this.t - T.ra.t > 8 && !T.ra.increased) {
          increase = !(sense < 0 && agl < 1450);
          if (ignoring && !T.ra.nonCompliance) {
            T.ra.nonCompliance = true;
            this.alert(`TCAS: ${o.cs} (real pilot) is not following its RA against ${a.cs}!`, "tcasnc" + a.cs + o.cs);
            this.atcError && this.atcError("tcasNonCompliance", { by: `pilot ${o.cs}`, ac: o, text: `${o.cs} did not follow its TCAS RA (${hRa > 0 ? "climb" : "descend"}) against ${a.cs}`, should: "a pilot always follows an RA; ATC: 'roger', no instructions until 'clear of conflict', traffic information" });
          }
        }
      } else if (!T.ra.reversed && this.t - T.ra.t > 4) {
        // AI vs AI: the geometry changed (one keeps moving into the other): reverse, coordinated
        const now = sepAtCpa(own, intr, g, T.ra.vs), other = sepAtCpa(own, intr, g, -T.ra.sense * 1500);
        if (Math.sign(now) !== T.ra.sense && Math.abs(other) > Math.abs(now) + sl.alim) { sense = -T.ra.sense; reversal = true; }
      }
      if (!increase && !reversal && Math.abs(sepAtCpa(own, intr, g, own.vs)) < sl.alim * 0.5 && this.t - T.ra.t > 10 && !T.ra.increased && !(sense < 0 && agl < 1450)) increase = true;
    }
    // an RA stays as issued (no weakening mid-manoeuvre) until it is reversed, increased or clear of conflict;
    // a preventive one may still turn corrective
    const keep = T.ra && !reversal && !increase && !(T.ra.preventive && Math.abs(sepAtCpa(own, intr, g, own.vs)) < sl.alim);
    const ra = keep ? { kind: T.ra.kind, vs: T.ra.vs, preventive: T.ra.preventive } : raFor(own, intr, g, sense, sl, { increase });
    if (reversal) ra.kind = sense > 0 ? "climb (reversal)" : "descend (reversal)";
    const first = !T.ra;
    if (first || reversal || increase || ra.kind !== T.ra.kind) {
      // Mode S coordination: the first to choose (or the one that reverses) owns the pair's sense
      if (c.owner == null || reversal) this._tcasLock.set(c.key, { owner: a.id, sense });
      T.ra = { ...(T.ra || {}), intr: o, sense, kind: ra.kind, vs: ra.vs, t: first ? this.t : T.ra.t, reversed: (T.ra && T.ra.reversed) || reversal,
        increased: (T.ra && T.ra.increased) || increase, preventive: !!ra.preventive, clearedLevel: first ? (a.cfl || a.alt) : T.ra.clearedLevel, human };
      if (first) {
        this.stats.tcasRa = (this.stats.tcasRa || 0) + 1;
        a.raCallAt = this.t + 3 + Math.random() * 3;           // "TCAS RA" as soon as possible after the manoeuvre starts
      }
      this.onEvent({ type: "tcas", kind: first ? "ra" : reversal ? "reversal" : increase ? "increase" : "ra", ac: a, intr: o, ra: T.ra });
    }
    T.lastRaAt = this.t;
  };

  P.tcasClear = function (a) {
    const T = a.tcas;
    if (!T || !T.ra) return;
    if (this.t - (T.lastRaAt || 0) < 2) return;                 // clear of conflict once it has stayed clear
    const ra = T.ra;
    T.ra = null;
    T.returning = { to: ra.clearedLevel, t: this.t };
    for (const [k, v] of this._tcasLock || []) if (v.owner === a.id || k.split(":").includes(String(a.id))) this._tcasLock.delete(k);
    const lvl = ra.clearedLevel >= 6000 && (this.split || a.kind === "ovf") ? `flight level ${Math.round(ra.clearedLevel / 100)}` : `${Math.round(ra.clearedLevel / 100) * 100} feet`;
    if (ra.called) this.pilot(a, `${this.cs(a).d}, clear of conflict, returning to ${lvl}`, "tcas");
    this.onEvent({ type: "tcas", kind: "clear", ac: a, intr: ra.intr });
  };

  /** Vertical control during an RA (and the return afterwards). Returns true when TCAS moved the aircraft. */
  P.tcasControls = function (a, dt) {
    const T = a.tcas;
    if (!T) return false;
    if (T.ra) {
      if (!T.ra.called && this.t >= (a.raCallAt || 0) && !a.nordo) {
        T.ra.called = true;
        this.pilot(a, `${this.cs(a).d}, TCAS RA`, "tcas");
        // an AI controller acknowledges and keeps quiet until "clear of conflict"
        if (this.split && this.positions && this.positions[a.freq] && !this.userWorks(a.freq))
          (this.pendingAtc ||= []).push({ pos: a.freq, ac: a, at: this.t + 3, text: `${a.ga ? a.cs : a.tel + " " + a.num}, roger`, rb: null });
      }
      const since = this.t - T.ra.t;
      a.raVs = pilotVs(a.raVs ?? a.vsFpm ?? 0, T.ra.vs, since, dt);
      a.alt = Math.max(0, a.alt + a.raVs / 60 * dt);
      return true;
    }
    if (T.returning) {
      const want = a.kind === "arr" && a.state === "final" ? this.arrAlt(a) : T.returning.to, d = want - a.alt;
      a.raVs = pilotVs(a.raVs || 0, Math.sign(d) * Math.min(1500, Math.abs(d) * 10), 99, dt);
      a.alt += a.raVs / 60 * dt;
      if (Math.abs(d) < 60 || this.t - T.returning.t > 240) { T.returning = null; a.raVs = 0; return false; }
      return true;
    }
    return false;
  };

  /** STCA: the controller's warning before TCAS -- 3 NM / 1000 ft lost within 2 minutes on present tracks. */
  P.stcaTick = function () {
    const air = this.ac.filter(a => !a.onGround && !a.veh && xpdrClass(a) === "C" && (a.alt || 0) > 800);
    this._stca = this._stca || new Map();
    for (let i = 0; i < air.length; i++) for (let j = i + 1; j < air.length; j++) {
      const a = air[i], b = air[j];
      // the approach funnel: two arrivals in sequence on the same final are the controller's spacing, not STCA's
      if (a.kind === "arr" && b.kind === "arr" && a.state === "final" && b.state === "final" && a.end === b.end) continue;
      if (Math.hypot(a.pos[0] - b.pos[0], a.pos[1] - b.pos[1]) > 30 * NM) continue;
      const hit = stca(this.tcasState(a), this.tcasState(b));
      const key = a.id < b.id ? `${a.id}:${b.id}` : `${b.id}:${a.id}`;
      if (hit) {
        const prev = this._stca.get(key);
        if (!prev || this.t - prev > 120) {
          this._stca.set(key, this.t);
          this.stats.stca = (this.stats.stca || 0) + 1;
          a.stcaUntil = b.stcaUntil = this.t + 30;
          this.alert(`STCA: conflict ${a.cs} / ${b.cs} — ${hit.t ? "in " + hit.t + " s, " : ""}${hit.nm.toFixed(1)} NM, ${Math.round(hit.ft / 100) * 100} ft`, `stca${key}${Math.floor(this.t / 120)}`);
          this.onEvent({ type: "stca", a, b, hit });
        }
      }
    }
  };

  /** Training: two AI aircraft set up for an RA in the user's airspace (head-on, ~70 s apart, 500 ft between). */
  P.injectTcasEvent = function (opts = {}) {
    const pos = opts.pos || (this.split ? (["CTR", "APP", "TWR"].find(k => this.positions[k] && this.userWorks(k)) || "APP") : "ALL");
    const fl = opts.alt || (pos === "CTR" ? 15000 : pos === "TWR" ? 4000 : 9000);
    const brg = Math.random() * 360, d = (opts.nm || 7) * NM, R = (pos === "TWR" ? 6 : 15) * NM;
    const c = [Math.sin(brg * Math.PI / 180) * R, Math.cos(brg * Math.PI / 180) * R];
    const h = (brg + 90) % 360, v = [Math.sin(h * Math.PI / 180), Math.cos(h * Math.PI / 180)];
    const made = [];
    for (const k of [-1, 1]) {
      const f = this.makeFlight(null, false);
      const sq = this.squawks.next(this.t);
      Object.assign(f, {
        kind: "ovf", state: "cruise", pos: [c[0] + v[0] * k * d / 2, c[1] + v[1] * k * d / 2], hdg: k < 0 ? h : (h + 180) % 360, spd: 250 * KT,
        alt: fl + (k < 0 ? 0 : 500), cfl: fl + (k < 0 ? 0 : 500), onGround: false, squawk: sq, assignedSq: sq, xpdr: "C", ifr: true, callAt: Infinity, calledIn: true,
        freq: this.split ? pos : "ALL", other: ["ZZZZ", "ZZZZ"], tcasTraining: true,
      });
      this.ac.push(f); this.onEvent({ type: "spawn", ac: f });
      made.push(f);
    }
    this.onEvent({ type: "tcasInject", ac: made });
    return made;
  };
}
