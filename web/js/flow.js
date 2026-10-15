// Flow management helpers: wake-turbulence separation (ICAO and RECAT-EU), CTOT slots and A-CDM times,
// departure sequencing and arrival spacing. Pure functions over aircraft objects / snapshots.

const NM = 1852;

// RECAT-EU category by ICAO type (A super, B upper heavy, C lower heavy, D upper medium, E lower medium, F light)
const RECAT = {
  A388: "A", B748: "B", B744: "B", B77W: "B", B77F: "B", A359: "B", A333: "B", A332: "B", B789: "B", B788: "B", MD11: "B",
  B763: "C", A306: "C", A310: "C",
  B738: "D", B38M: "D", B737: "D", A320: "D", A20N: "D", A21N: "D", A321: "D", A319: "D", BCS3: "D", BCS1: "D", E195: "D", E190: "D", E75L: "D",
  CRJ9: "E", AT76: "E", AT45: "E", DH8D: "E",
};
// RECAT-EU departure time separations in seconds (leader row, follower column); blank = no requirement (apply 60 s runway)
const RECAT_DEP = {
  A: { B: 100, C: 120, D: 140, E: 160, F: 180 },
  B: { D: 100, E: 120, F: 140 },
  C: { E: 80, F: 100 },
  D: { F: 120 },
  E: { F: 100 },
  F: {},
};
// ICAO wake separation on departure (same runway, same position) in seconds
const ICAO_DEP = { "J-H": 120, "J-M": 180, "J-L": 180, "H-M": 120, "H-L": 180, "M-L": 180 };

export function recatOf(a) { return RECAT[a.type] || (a.wtc === "J" ? "A" : a.wtc === "H" ? "B" : a.wtc === "L" ? "F" : "D"); }

/** Required time between a departing `leader` and a departing `follower` (seconds); minimum runway spacing 60 s. */
export function wakeDepSeconds(leader, follower, recat = false) {
  if (!leader) return 0;
  if (recat) {
    const need = (RECAT_DEP[recatOf(leader)] || {})[recatOf(follower)];
    return need || 60;
  }
  return ICAO_DEP[`${leader.wtc}-${follower.wtc}`] || 60;
}

/** Arrival wake spacing in NM behind a leader on final (ICAO distance-based; RECAT-EU where asked). */
export function wakeArrNm(leader, follower, recat = false) {
  if (!leader) return 3;
  if (recat) {
    const L = recatOf(leader), F = recatOf(follower);
    const T = { A: { B: 3, C: 4, D: 5, E: 5, F: 8 }, B: { B: 3, C: 4, D: 4, E: 5, F: 7 }, C: { D: 3, E: 3, F: 6 }, D: { F: 5 }, E: { F: 4 }, F: {} };
    return (T[L] || {})[F] || 3;
  }
  const w = `${leader.wtc}-${follower.wtc}`;
  return { "J-H": 6, "J-M": 7, "J-L": 8, "H-H": 4, "H-M": 5, "H-L": 6, "M-L": 5 }[w] || 3;
}

/** CTOT (calculated take-off time) as seconds of sim time; window -5 / +10 min. */
export function ctotStatus(ctot, now) {
  if (ctot == null) return null;
  const d = ctot - now;
  if (d > 300) return { state: "early", text: `in ${Math.round(d / 60)} min`, ok: false };
  if (d >= -600) return { state: "window", text: d >= 0 ? `-${Math.round(d / 60)} min` : `+${Math.round(-d / 60)} min`, ok: true };
  return { state: "missed", text: `missed by ${Math.round(-d / 60)} min`, ok: false };
}

const hhmm = (utcMs) => { const d = new Date(utcMs); return `${String(d.getUTCHours()).padStart(2, "0")}${String(d.getUTCMinutes()).padStart(2, "0")}`; };

/** A-CDM target times for a departure: TOBT (off-block), TSAT (start-up), TTOT (take-off), as UTC HHMM. */
export function acdmTimes(a, sim) {
  const base = sim.clockUtc;
  const tobt = a.tobt ?? a.callAt ?? sim.t;
  const taxi = a.taxiEst ?? 600;
  const tsat = a.tsat ?? tobt + (a.queueDelay || 0);
  return { tobt: hhmm(base + tobt * 1000), tsat: hhmm(base + tsat * 1000), ttot: hhmm(base + (tsat + taxi) * 1000), ctot: a.ctot != null ? hhmm(base + a.ctot * 1000) : null };
}

/**
 * Departure sequence for runway end `end`: holding/lined-up first, then taxiing by remaining distance.
 * Each entry: {a, status, wait (s until wake separation allows it), ctot}
 */
export function departureSequence(sim, end, recat = false) {
  const list = sim.ac.filter(a => a.kind === "dep" && a.onGround && !a.veh && (a.depEnd || sim.depEnd) === end &&
    ["taxi", "holding", "lineup", "lining", "lined_up", "cond_lineup"].includes(a.state));
  const rank = (a) => (["lineup", "lining", "lined_up"].includes(a.state) ? 0 : a.state === "holding" || a.state === "cond_lineup" ? 1 : 2);
  list.sort((p, q) => rank(p) - rank(q) || (rank(p) === 1 ? (p.holdAt || 0) - (q.holdAt || 0) : (p.distToStop ?? 1e9) - (q.distToStop ?? 1e9)));
  const last = sim.lastTakeoff;
  let prev = last ? { wtc: last.wtc, type: last.type, t: last.t } : null;
  return list.map(a => {
    const need = wakeDepSeconds(prev, a, recat);
    const wait = prev ? Math.max(0, need - (sim.t - (prev.t ?? sim.t))) : 0;
    const out = { a, status: a.state, wait, need, ctot: ctotStatus(a.ctot, sim.t), acdm: acdmTimes(a, sim) };
    prev = { wtc: a.wtc, type: a.type, t: Math.max(sim.t + wait, prev ? prev.t : 0) + 60 };   // if it went now
    return out;
  });
}

/** Arrivals on final for runway end `end` with spacing to the one ahead in NM and seconds. */
export function arrivalSpacing(sim, end, recat = false) {
  const list = sim.ac.filter(a => a.kind === "arr" && a.state === "final" && a.end === end).map(a => ({ a, d: sim.distToThr(a) })).sort((p, q) => p.d - q.d);
  return list.map((x, i) => {
    const lead = i ? list[i - 1] : null;
    const gapNm = lead ? (x.d - lead.d) / NM : null;
    const gapS = lead && x.a.spd > 1 ? (x.d - lead.d) / x.a.spd : null;
    const need = lead ? wakeArrNm(lead.a, x.a, recat) : null;
    return { a: x.a, nm: x.d / NM, gapNm, gapS, need, short: need != null && gapNm != null && gapNm < need };
  });
}
