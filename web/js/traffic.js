// One traffic-awareness / separation system for everything that moves (PART A): AI aircraft, real XRadio pilots
// (humans) and vehicles are all traffic to each other. The only differences: the sim never moves a human (AI gives
// way to them, they cannot be told to stop by it) and a human's position is extrapolated between updates.
//
//   ground   every mover's path is predicted 20 s ahead (AI: its cleared route, humans: heading and speed); an AI
//            aircraft / vehicle stops before a place someone else will occupy first, gives way to traffic from
//            the right (fixed tie-break, deadlock detection), never meets anyone head-on in a segment and keeps
//            >= 50 m (wingspan based) behind anyone on its path; blocked by a stopped human for 60 s it asks for
//            another route and re-plans when the network allows it, else holds with "blocked by <cs>" on its strip
//   pushback no push while anyone passes behind the stand or is within ~100 m of the push path
//   runways  nobody lines up / takes off / crosses with anyone on the runway or on short final; arrivals keep
//            wake spacing behind whoever is ahead on final and go around when it collapses; a landing clearance
//            with the runway occupied is queried and becomes a go-around at the decision height; a late runway
//            incursion rejects the takeoff below V1. Every ATC slip is logged with who caused it.
// Positions are local metres; the grid keeps the work proportional to the traffic near each mover (150+ targets).
import { dist, hdgOf, angDiff, vecFromHdg, KT, FT } from "./airport.js";
import { AC_DIM } from "./data.js";

const NM = 1852;
const CELL = 250;                 // spatial grid cell (m)
const HORIZON = 20;               // prediction horizon (s)
const STEP = 2;                   // prediction step (s)
const RECHECK = 0.4;              // s between two full conflict checks for one mover
const SEP_MIN = 50;               // minimum distance behind another mover on the same taxiway (m)
const HUMAN_STALE = 5;            // s without an update before a human is "stale"
const BLOCK_ASK = 60;             // s blocked by a stopped human before asking for another route
const DEADLOCK = 4;               // s of mutual waiting before the tie-break lets one go

export const spanOf = (a) => a.veh ? 4 : a.span || (AC_DIM[a.type] || [35])[0];
const moving = (o) => o.spd > 0.3;

export function installTraffic(Sim) {
  const P = Sim.prototype;

  /** Once per step: human extrapolation and staleness, the spatial grid, path predictions (cached for the tick). */
  P.trafficTick = function () {
    const t = this.t;
    for (const a of this.ac) {
      if (!a.human) continue;
      const age = t - (a.fixT ?? t);
      if (a.fixPos && age > 0 && age <= HUMAN_STALE && a.spd > 0.2) {
        const v = vecFromHdg(a.hdg || 0);
        a.pos = [a.fixPos[0] + v[0] * a.spd * age, a.fixPos[1] + v[1] * a.spd * age];
      }
      const stale = age > HUMAN_STALE;
      if (stale && !a.stale) {
        this.onEvent({ type: "humanStale", ac: a, s: Math.round(age) });
        this.note(`${a.cs}: no position from XRadio for ${Math.round(age)} s (out of range or disconnected) — AI traffic uses its last known position`);
      }
      a.stale = stale;
    }
    const grid = new Map();
    for (const a of this.ac) {
      if (!a.pos) continue;
      const k = `${Math.floor(a.pos[0] / CELL)}:${Math.floor(a.pos[1] / CELL)}`;
      (grid.get(k) || grid.set(k, []).get(k)).push(a);
      a._pred = null;
    }
    this._grid = grid;
  };

  /** Traffic within r metres of p (grid lookup). */
  P.nearby = function (p, r = 400) {
    const g = this._grid;
    if (!g) return this.ac;
    const out = [], c0 = Math.floor((p[0] - r) / CELL), c1 = Math.floor((p[0] + r) / CELL), d0 = Math.floor((p[1] - r) / CELL), d1 = Math.floor((p[1] + r) / CELL);
    for (let i = c0; i <= c1; i++) for (let j = d0; j <= d1; j++) { const l = g.get(`${i}:${j}`); if (l) for (const a of l) out.push(a); }
    return out;
  };

  /** Predicted ground positions, one per second for HORIZON s: an AI follows its route at (at least) taxi pace while
   *  it is cleared to move; a human goes straight on at its speed (its cleared route is not known to the sim). */
  P.predict = function (a) {
    if (a._pred) return a._pred;
    const out = [a.pos];
    const n = HORIZON / STEP;
    const wantsToMove = !a.human && !a.holdPos && a.path && a.pi < a.path.length && ["taxi", "lineup", "vacating", "pushing", "toAircraft", "leading", "task", "home", "aside"].includes(a.state) && !(a.atStop && a.spd < 0.1) &&
      !(a.state === "pushing" && !a.pushStarted);            // a push not started yet stays on its stand
    // one that is itself waiting for someone stays where it is in the prediction
    const v = a.human ? (a.spd > 0.5 ? a.spd : 0) : Math.max(a.spd, wantsToMove && !a.waitOn ? 4 : 0);
    if (a.human || !a.path || a.pi >= (a.path || []).length) {
      const h = vecFromHdg(a.hdg || 0);
      for (let s = 1; s <= n; s++) out.push([a.pos[0] + h[0] * v * s * STEP, a.pos[1] + h[1] * v * s * STEP]);
    } else {
      let p = a.pos, k = a.pi, left = 0;
      for (let s = 1; s <= n; s++) {
        left += v * STEP;
        while (left > 0 && k < a.path.length) {
          const d = dist(p, a.path[k]);
          if (d <= left) { left -= d; p = [a.path[k][0], a.path[k][1]]; k++; } else { p = [p[0] + (a.path[k][0] - p[0]) * left / d, p[1] + (a.path[k][1] - p[1]) * left / d]; left = 0; }
        }
        out.push(p);
      }
    }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const q of out) { if (q[0] < x0) x0 = q[0]; if (q[0] > x1) x1 = q[0]; if (q[1] < y0) y0 = q[1]; if (q[1] > y1) y1 = q[1]; }
    out.box = [x0, y0, x1, y1];
    a._pred = out;
    return out;
  };

  /** Ground traffic that does not count for `a` (equipment at its stand, its follow-me car, parked aircraft…). */
  P.ignoreOnGround = function (a, o) {
    if (o === a || !o.onGround || !o.pos) return true;
    if (o.onRoad && !a.onRoad) return true;
    if (a.onRoad && !o.onRoad && !o.veh) return false;
    if (o.state === "parked" && o.stand && dist(o.pos, o.stand.pos) < 5) return true;
    if (a.veh && o === a.target) return true;
    if (o.leader === a || (a.leader === o && o.state !== "leading")) return true;
    if (o.veh && (o.serving === a || o.state === "idle" || o.standby)) return true;
    if (a.veh && a.serving === o) return true;
    if (o.state === "rto" || o.state === "roll" || o.state === "rollout") return true;      // runway traffic: the runway rules handle it
    return false;
  };

  P.note = function (text) { this.onEvent({ type: "log", text }); };

  /** Who gives way at a crossing conflict: true when `a` must wait for `o`. */
  P.givesWay = function (a, o, ti, tj) {
    if (o.human) return true;                       // nobody can tell a real pilot to stop: AI always gives way
    // it is stopped because we are in its way: giving way to it would wait for ever -- we move on first
    if (o.waitOn === a && (o.blockWhy === "behind" || o.blockWhy === "head-on") && !moving(o)) return false;
    if (a.veh && !o.veh) return true;               // vehicles give way to aircraft
    if (!a.veh && o.veh) return false;
    // both waiting for each other for a while: the fixed tie-break lets the lower id go first
    if (o.waitOn === a && a.waitOn === o && this.t - Math.max(a.waitSince || 0, o.waitSince || 0) > DEADLOCK) return a.id > o.id;
    if (tj + 2 < ti) return true;                   // it gets there clearly first
    if (ti + 2 < tj) return false;
    const rel = (hdgOf(o.pos[0] - a.pos[0], o.pos[1] - a.pos[1]) - a.hdg + 360) % 360;
    if (rel > 10 && rel < 170) return true;         // traffic from the right has right of way
    const relO = (hdgOf(a.pos[0] - o.pos[0], a.pos[1] - o.pos[1]) - o.hdg + 360) % 360;
    if (relO > 10 && relO < 170) return false;
    return a.id > o.id;
  };

  /** Speed limit for an AI aircraft / vehicle on the ground from all other traffic (replaces the old 90 m cone). */
  P.trafficLimit = function (a) {
    // the full check runs a few times a second per mover; in between the last answer stands (it only gets safer:
    // a stop stays a stop until the next check)
    if (a._limT != null && this.t - a._limT < RECHECK && this.t >= a._limT) return a._lim;
    a._limT = this.t;
    a._lim = this.trafficLimitNow(a);
    return a._lim;
  };
  P.trafficLimitNow = function (a) {
    let lim = Infinity, by = null, why = "";
    const sa = spanOf(a);
    const mine = this.predict(a);
    // the path ahead as a polyline (up to ~300 m)
    const ahead = [a.pos];
    if (a.path) { let acc = 0; for (let k = a.pi; k < a.path.length && acc < 300; k++) { acc += dist(ahead[ahead.length - 1], a.path[k]); ahead.push(a.path[k]); } }
    if (ahead.length === 1) { const v = vecFromHdg(a.hdg); ahead.push([a.pos[0] + v[0] * 120, a.pos[1] + v[1] * 120]); }
    for (const o of this.nearby(a.pos, 450)) {
      if (this.ignoreOnGround(a, o)) continue;
      const so = spanOf(o);
      const sep = Math.max(SEP_MIN, (sa + so) / 2 + 15);
      // 1) someone on my path ahead: follow at a distance, never meet head-on
      const on = alongPath(ahead, o.pos, Math.max(12, (sa + so) / 4));
      // a stand-off (each standing in the other's way): the one nearest its destination goes first -- an aircraft
      // entering its stand clears the lane for the other
      let standoff = a.passing === o && dist(a.pos, o.pos) < 90;      // already squeezing past it
      if (!standoff && on != null && o.waitOn === a && a.waitOn === o && !moving(o)) {
        const waited = this.t - Math.max(a.waitSince || 0, o.waitSince || 0);
        const remA = a.path ? a.path.length - a.pi : 99, remO = o.path ? o.path.length - o.pi : 99;
        const first = remA < remO || (remA === remO && a.id < o.id);
        standoff = first && ((waited > 20 && dist(a.pos, o.pos) > 25) || waited > 90);
        if (standoff) a.passing = o;
      }
      if (on != null && on > 0 && !standoff) {
        const opposite = Math.abs(angDiff(a.hdg, o.hdg)) > 120 && moving(o);
        if (opposite) {
          if (on < sep + 150) { lim = 0; by = o; why = "head-on"; }
        } else if (on < sep) { lim = 0; by = o; why = "behind"; }
        else if (on < sep + 50) { const l = Math.max(0, Math.min(o.spd, 5)); if (l < lim) { lim = l; by = o; why = "behind"; } }
        continue;
      }
      // 2) crossing conflict in the next 20 s
      const theirs = this.predict(o);
      const R = (sa + so) / 2 + 20;
      const bm = mine.box, bt = theirs.box;
      if (bm[0] - R > bt[2] || bt[0] - R > bm[2] || bm[1] - R > bt[3] || bt[1] - R > bm[3]) continue;
      let hit = null;
      for (let i = 0; i < mine.length && !hit; i++) for (let j = Math.max(0, i - 2); j <= Math.min(theirs.length - 1, i + 2); j++) {
        if (dist(mine[i], theirs[j]) < R) { hit = [i * STEP, j * STEP, i]; break; }
      }
      if (!hit) continue;
      const [ti, tj, ki] = hit;
      if (ti === 0 && tj === 0 && !moving(a) && !moving(o)) continue;     // both standing still side by side
      if (!this.givesWay(a, o, ti, tj)) continue;
      // stop short of the conflict point
      let dStop = 0;
      for (let i = 1; i <= ki; i++) dStop += dist(mine[i - 1], mine[i]);
      dStop -= R;
      const l = dStop <= 3 ? 0 : Math.sqrt(2 * 0.9 * dStop);
      if (l < lim) { lim = l; by = o; why = o.human ? "giving way to a real pilot" : "giving way"; }
    }
    this.noteBlocked(a, lim, by, why);
    return lim;
  };

  /** Book-keeping for waiting: deadlock detection, and A9 (a stopped human in the way for 60 s). */
  P.noteBlocked = function (a, lim, by, why) {
    if (lim < 1.0 && by) {
      if (a.waitOn !== by) { a.waitOn = by; a.waitSince = this.t; }
      a.blockWhy = why;
      const waited = this.t - a.waitSince;
      if (waited > BLOCK_ASK && !moving(by) && (!a.altAsked || this.t > (a.altRetryAt || Infinity)) && !a.veh) this.requestAltRoute(a, by);
    } else if (lim >= 1.0 || !by) {
      if (a.waitOn && a.blockedBy && this.t - a.waitSince > 5) a.blockedBy = null;
      a.waitOn = null; a.waitSince = null; a.blockWhy = "";
      if (a.altAsked && moving(a)) a.altAsked = false;
    }
  };

  /** Blocked for a minute: ask for another route, re-plan around the blocker when the network allows it, else hold
   *  and show "blocked by <cs>" (never drive through, never wait silently). */
  P.requestAltRoute = function (a, by) {
    const again = a.altAsked;
    a.altAsked = true; a.blockedBy = by.cs; a.altRetryAt = this.t + 60;
    const near = this.apt.nearestEdge ? this.apt.nearestEdge(by.pos, 60, false) : null;
    const twy = (near && near.e.name) || "";
    if (!again) {
      this.call(a, "stillWaitingGeneric", { what: `request alternative routing, traffic blocking${twy ? " at " + twy : ""}`, greet: "" }, "GND");
      this.onEvent({ type: "blocked", ac: a, by, twy });
    }
    // edges around the blocker are avoided for this route
    const blocked = new Set(this.blockedEdges);
    for (const e of this.apt.edges || []) {
      if (e.i == null) continue;
      const p1 = this.apt.nodes[e.a], p2 = this.apt.nodes[e.b];
      if (segDist(by.pos, p1, p2) < spanOf(by) / 2 + spanOf(a) / 2 + 10) blocked.add(e.i);
    }
    const start = this.startNode(a, true);
    const plan = (b) => a.taxiTo === "stand" && a.stand ? this.apt.routeToPos(start.node, a.stand.pos, [], start.avoid, { blocked: b, avoidRwy: this.depEnd.rwy })
      : a.kind === "dep" && a.depEnd ? this.apt.routeToRunway(start.node, a.depEnd, [], start.avoid, { blocked: b }) : null;
    let route = plan(blocked);
    if (route) { const opp = this.headOnEdges(route, a); if (opp.size) route = plan(new Set([...blocked, ...opp])); }
    // an arrival that cannot get to its stand: another free stand that fits, reachable around the blocker
    if (!route && a.kind === "arr" && a.onGround && this.freeStands) {
      const cands = this.freeStands(["gate", "misc", "tie_down", "hangar"], !!a.ga, !!a.cargo).filter(s => s !== a.stand)
        .sort((p, q) => dist(p.pos, a.pos) - dist(q.pos, a.pos)).slice(0, 8);
      for (const s of cands) {
        const r = this.apt.routeToPos(start.node, s.pos, [], start.avoid, { blocked, avoidRwy: this.depEnd.rwy });
        if (r && !this.headOnEdges(r, a).size) { if (a.stand && a.stand.reserved === a) a.stand.reserved = null; a.stand = s; a.taxiTo = "stand"; route = r; break; }
      }
    }
    if (!route) { if (!again) this.note(`${a.cs} is blocked by ${by.cs}${twy ? " at " + twy : ""}: no other route — holding`); return false; }
    const names = this.namesOf(route);
    const pos = a.freq;
    if (this.split && this.positions && this.positions[pos] && !this.userWorks(pos)) {
      // an AI controller works the frequency: it answers with the new route
      this.startNode(a);
      this.setPath(a, route);
      if (a.taxiTo === "stand" && a.stand && dist(a.path[a.path.length - 1], a.stand.pos) > 1) a.path.push([...a.stand.pos, null]);
      a.viaText = names.join(" ");
      a.blockedBy = null; a.waitOn = null;
      const what = `${a.taxiTo === "stand" && a.stand ? "taxi to stand " + a.stand.name : "taxi to holding point runway " + a.depEnd.name}${names.length ? " via " + names.join(" ") : ""}`;
      (this.pendingAtc ||= []).push({ pos, ac: a, at: this.t + 4, text: `${a.ga ? a.cs : a.tel + " " + a.num}, ${what}`, rb: what });
      return true;
    }
    a.altRoute = { route, names };      // the controller (you) decides; the strip shows it
    return true;
  };

  /** Edges of `route` (node list) that someone else is taxiing along in the other direction: issuing that route
   *  would meet them head-on in a segment. */
  P.headOnEdges = function (route, a) {
    const out = new Set();
    if (!route || route.length < 2) return out;
    const mine = new Map();
    for (let i = 0; i + 1 < route.length; i++) mine.set(`${route[i]}>${route[i + 1]}`, (this.apt.edgeBetween(route[i], route[i + 1]) || {}).i);
    for (const o of this.ac) {
      if (o === a || !o.onGround || !o.path || o.veh && o.onRoad) continue;
      if (o.waitOn === a && !moving(o)) continue;          // it waits for us: our moving is what frees it
      if (!["taxi", "vacating", "lineup", "pushing", "toAircraft", "leading", "task", "home"].includes(o.state) && !(o.human && moving(o))) continue;
      for (let k = Math.max(0, (o.pi || 1) - 1); k + 1 < o.path.length; k++) {
        const n1 = o.path[k][2], n2 = o.path[k + 1][2];
        if (n1 == null || n2 == null) continue;
        const id = mine.get(`${n2}>${n1}`);
        if (id != null) out.add(id);
      }
    }
    return out;
  };

  /** Will anyone be behind the stand / on the push path in the next 20 s? */
  P.pushClear = function (a) {
    const pts = a.path ? a.path.slice(a.pi) : [];
    if (!pts.length) return { ok: true };
    for (const o of this.nearby(a.pos, 300)) {
      if (o === a || !o.onGround || !o.pos || o.onRoad) continue;
      if (o.state === "parked" || (o.veh && (o.serving === a || o.state === "idle" || o.standby))) continue;
      if (o.veh && o.target === a) continue;
      if (!moving(o)) {
        const r = (spanOf(a) + spanOf(o)) / 2;
        if (segDist(o.pos, a.pos, pts[pts.length - 1]) < r || pts.some(p => dist(p, o.pos) < r)) return { ok: false, by: o };
        continue;
      }
      const pr = this.predict(o);
      for (const q of pr) {
        if (pts.some(p => dist(p, q) < 60) || dist(q, a.pos) < 100 && segDist(q, a.pos, pts[pts.length - 1]) < 60) return { ok: false, by: o };
      }
    }
    return { ok: true };
  };

  // ---------------------------------------------------------------- runways
  /** Everyone on runway `rwy` (AI, humans, vehicles). */
  P.runwayUsers = function (rwy, except) {
    const r = this.apt.runways[rwy];
    return this.ac.filter(o => o !== except && o.onGround && o.pos && !o.onRoad && this.apt.onRunway(o.pos, r, 5));
  };

  /** Aircraft approaching runway `rwy` (either end): AI on final and humans lined up with it, with NM and seconds. */
  P.finalTraffic = function (rwy, except) {
    const out = [];
    const r = this.apt.runways[rwy];
    for (const o of this.ac) {
      if (o === except || o.onGround || !o.pos) continue;
      if (o.state === "goaround" || (o.vsFpm || 0) > 300) continue;      // climbing away: not landing
      for (const e of r.ends) {
        let d = null;
        if (!o.human && o.kind === "arr" && o.state === "final" && o.end && o.end.rwy === rwy && o.end === e) d = this.distToThr(o);
        else if (o.human || o.kind !== "arr" || o.state !== "final") {
          // a human (or anyone) flying down the extended centreline towards the threshold, low
          const along = -((o.pos[0] - e.thr[0]) * e.v[0] + (o.pos[1] - e.thr[1]) * e.v[1]);
          const cross = Math.abs((o.pos[0] - e.thr[0]) * e.v[1] - (o.pos[1] - e.thr[1]) * e.v[0]);
          if (along > 0 && along < 6 * NM && cross < Math.max(400, along * 0.12) && Math.abs(angDiff(o.hdg, e.hdg)) < 30 && (o.alt || 0) < 2500 && (o.human || o.kind === "arr")) d = along;
        }
        // over the threshold and not yet down still counts: until it touches down it is landing traffic
        if (d != null && d > -2500) out.push({ ac: o, end: e, nm: Math.max(0, d) / NM, sec: Math.max(0, d) / Math.max(30, o.spd || 60) });
      }
    }
    return out.sort((x, y) => x.nm - y.nm);
  };

  /** Is runway `rwy` unsafe to enter / use for `a` now? {busy, why, by} — on it, on short final, taking off. */
  P.runwayDanger = function (rwy, a, { finalNm = 3, finalSec = 120 } = {}) {
    const users = this.runwayUsers(rwy, a).filter(o => !(o.leader === a || a.leader === o) && !(o.waitOn === a && !moving(o)));
    if (users.length) {
      const o = users[0];
      return { busy: true, why: o.state === "roll" ? "traffic taking off" : o.veh ? "vehicle on the runway" : "traffic on the runway", by: o };
    }
    const f = this.finalTraffic(rwy, a).find(x => x.nm < finalNm || x.sec < finalSec);
    if (f) return { busy: true, why: "traffic on final", by: f.ac, nm: f.nm };
    return { busy: false };
  };

  /** Wake separation behind `lead` on final for `a` (NM): ICAO / RECAT-like table, never under 3 NM. */
  P.wakeNm = function (lead, a) {
    const L = lead.wtc || "M", F = a.wtc || "M";
    const T = { J: { J: 4, H: 6, M: 7, L: 8 }, H: { H: 4, M: 5, L: 6 }, M: { L: 5 } };
    return Math.max(3, (T[L] && T[L][F]) || 3);
  };

  /** Whoever is ahead of `a` on the same final (AI or human). */
  P.leaderOnFinal = function (a) {
    const e = a.end, mine = this.distToThr(a);
    let best = null;
    for (const f of this.finalTraffic(e.rwy, a)) {
      if (f.end !== e) continue;
      const d = f.nm * NM;
      if (d < mine - 50 && (!best || d > best.d)) best = { ac: f.ac, d };
    }
    // still rolling out on the runway counts as "ahead" too (the landing roll)
    return best;
  };

  /** Log an ATC error / runway incursion for the debrief with who caused it and what should have been said. */
  P.atcError = function (kind, { by = "you", ac = null, text = "", should = "" } = {}) {
    const key = `${kind}:${ac ? ac.cs : ""}:${Math.floor(this.t / 60)}`;
    this._atcErr = this._atcErr || new Set();
    if (this._atcErr.has(key)) return;
    this._atcErr.add(key);
    (this.stats.atcErrors ||= []).push({ t: this.t, kind, by, cs: ac ? ac.cs : "", text, should });
    if (kind === "incursion") this.stats.incursions = (this.stats.incursions || 0) + 1;
    this.onEvent({ type: "atcError", kind, by, ac, text, should });
  };
}

/** Distance along polyline `pts` to the projection of `p`, when p is within `lat` metres of it (else null). */
export function alongPath(pts, p, lat) {
  let acc = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy);
    if (L < 0.01) continue;
    const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (L * L);
    if (t >= -0.05 && t <= 1.05) {
      const q = [a[0] + dx * t, a[1] + dy * t];
      if (Math.hypot(p[0] - q[0], p[1] - q[1]) < lat) return acc + t * L;
    }
    acc += L;
  }
  return null;
}

export function segDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy;
  const t = L2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2)) : 0;
  return Math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dy * t);
}

export { KT, FT };
