// Traffic simulation: aircraft state machines, ground movement, pilots' calls and readbacks,
// ATC positions with handoffs, AI controllers for unstaffed positions, squawks, readback errors.
import { KT, FT, dist, hdgOf, angDiff, vecFromHdg } from "./airport.js";
import { AC_DIM, AIRLINES, TYPES, GA_TYPES, HELI_TYPES, REG_PREFIX, LETTER_WORD, DESTS, AIRLINE_NAT, AIRLINE_TYPES, CARGO_TYPES, HOUR_WAVE, REG_NAT, rnd, rint, distKm, weighted, controllerNat } from "./data.js";
import { standKey, parse, normalize, setTaxiNames } from "./commands.js";
import { regionOf, makeStyle, callsign, spokenType, atcType, pilotCall, readback, ph, greeting, signOff, localHour, cap, NEUTRAL_STYLE, sayNumbers } from "./phrase.js";
import { makeCrew } from "./voices.js";
import { SquawkAllocator, validCode } from "./squawk.js";
import { positionFor, fmtFreq } from "./positions.js";
import { installOps } from "./ops.js";
import { installVfr } from "./vfr.js";
import { installEvents, CHECKLISTS } from "./events.js";
import { wakeDepSeconds, ctotStatus } from "./flow.js";
import { installTraffic, spanOf } from "./traffic.js";
import { installTcas, stca as stcaCheck } from "./tcas.js";
import { installAutoAtc, trafficInfo, sequenceInfo, workload as workloadOf } from "./autoatc.js";
export { CHECKLISTS };

const TAXI_SPD = 18 * KT, TURN_SPD = 7 * KT, PUSH_SPD = 1.3;
const FINAL_SPAWN = 14000;      // m from threshold (combined mode)
const APP_SPAWN = 25 * 1852;    // m from threshold when an approach position exists
const NM = 1852;
const TYPE_INFO = Object.fromEntries(TYPES.map(t => [t[0], t]));
const isCargoStand = (s) => s.op === "cargo" || /cargo|freight/i.test(s.name);
// a stand takes its own category and anything smaller (a heavy stand takes an A220; a jets stand a turboprop)
const CAT_RANK = { heavy: 4, jets: 3, turboprops: 2, props: 1, helos: 0 };
const standFits = (s, t) => !s || !s.types || !s.types.length || s.types.includes(t[2]) || s.types.some(k => (CAT_RANK[k] ?? -1) >= (CAT_RANK[t[2]] ?? 9) && t[2] !== "helos") ||
  (t[2] === "heavy" && s.types.includes("jets") && s.size && s.size >= "D");

let nextId = 1;

export class Sim {
  /**
   * opts.positions: table from buildPositions() to work split positions; omit for the legacy combined frequency.
   * opts.staffing:  Set of position keys the user works (others are run by AI controllers).
   * opts.rates:     { readbackError, sayAgain, oldAtis } probabilities (all 0 by default → deterministic).
   */
  constructor(apt, opts = {}) {
    const { onRadio, onAlert, onEvent } = opts;
    this.apt = apt;
    this.onRadio = onRadio || (() => {});
    this.onAlert = onAlert || (() => {});
    this.onEvent = onEvent || (() => {});
    this.region = regionOf(apt.icao);
    this.rates = { readbackError: 0, sayAgain: 0, oldAtis: 0, ...(opts.rates || {}) };
    this.positions = opts.positions || null;
    this.remoteStaff = {};                      // pos -> nickname of the remote controller working it (multiplayer)
    this.staffing = opts.staffing || new Set(["ALL"]);
    this.events = !!opts.events;          // scripted 7600/7700 events
    this.overflights = this.positions ? (opts.overflights ?? true) : false;
    this.clockUtc = opts.clockUtc ?? Date.UTC(2026, 9, 12, 9, 0);
    this.squawks = new SquawkAllocator(apt.icao);
    this.t = 0;
    this.ac = [];
    this.depEnd = apt.runways[0].ends[0];
    this.arrEnd = this.depEnd;
    this.depPerHour = 10;
    this.arrPerHour = 8;
    this.ovfPerHour = 6;
    this.nextDep = 5;
    this.nextArr = 20;
    this.nextOvf = 60;
    this.nextEvent = 300;
    this.atisIdx = 0;
    this.atisAt = 0;
    this.wind = { dir: null, spd: 0 };
    this.lastTakeoff = null; // {t, wtc, cs}
    this.alerted = new Map();
    this.vehNo = {};         // vehicle callsign counters per type
    this.lightLog = [];      // light-gun signals given {t, cs, color, mode, effect}
    setTaxiNames(apt.taxiNames);
    this.occupancy = opts.occupancy ?? 0.7;   // share of stands with an aircraft on them
    this.waves = opts.waves ?? true;          // time-of-day traffic peaks
    this.serviceVehicles = opts.serviceVehicles ?? Math.max(0, Math.min(24, Math.round(apt.stands.length / 6)));
    this.mix = null;                           // real traffic mix (OpenFlights), see setTrafficMix()
    this.populated = opts.populate === false;  // true = never populate (tests)
    this.recat = !!opts.recat;                 // RECAT-EU wake categories instead of ICAO H/M/L
    this.lvp = false; this.lvpManual = false;  // low visibility procedures
    this.closedRunways = new Set();            // runway ids closed (inspection, FOD, snow)
    this.blockedEdges = new Set();             // taxi edges blocked by a broken-down aircraft
    this.abnormals = { on: !!opts.abnormals, perHour: opts.abnormalRate ?? 2 };
    this.vfrPerHour = opts.vfrPerHour ?? 2;    // VFR inbound flights per hour (where the field has GA stands)
    this.nextVfr = 240;
    this.fod = null;
    this.stats = { departures: 0, arrivals: 0, goArounds: 0, alerts: 0, rbErrors: 0, rbCaught: 0, missedRb: 0,
      conflicts: 0, delays: [], tx: {} };
  }

  // ---------- real traffic mix (OpenFlights) ----------
  /** data: /api/traffic result {airlines:[{icao,callsign,nat,routes}], dests:[{icao,city,name,lat,lon}], pairs:[[al,dest,n]], cargo:[]} */
  setTrafficMix(data) {
    if (!data || !data.airlines || !data.airlines.length) { this.mix = null; return; }
    const known = Object.fromEntries(AIRLINES.map(a => [a[0], a[1]]));
    const dests = new Map(data.dests.map(d => [d.icao, [d.icao, d.city || d.name, d.lat, d.lon]]));
    const pairs = new Map();
    for (const [al, de, n] of data.pairs || []) if (dests.has(de)) (pairs.get(al) || pairs.set(al, []).get(al)).push([de, n]);
    const cargo = new Set(data.cargo || []);
    const airlines = data.airlines.filter(a => a.icao && (a.callsign || known[a.icao]) && pairs.has(a.icao))
      .map(a => ({ icao: a.icao, tel: known[a.icao] || a.callsign, nat: a.nat || "", routes: a.routes || 1, cargo: cargo.has(a.icao) }));
    this.mix = airlines.length ? { airlines, dests, pairs, cargo } : null;
  }

  /** Aircraft type for an airline on a route of `km`, fitting the stand. */
  pickType(icao, km, stand, cargo) {
    const fit = (t) => standFits(stand, t);
    let pool = (cargo ? CARGO_TYPES : (AIRLINE_TYPES[icao] || [])).map(c => TYPE_INFO[c]).filter(Boolean);
    if (pool.length) {
      const ok = pool.filter(fit).filter(t => km == null || t[1] !== "H" || km > 1800 || pool.every(x => x[1] === "H"));
      const exact = ok.filter(t => stand && stand.types && stand.types.includes(t[2]));   // a heavy stand prefers the fleet's heavies
      if (exact.length) return rnd(exact);
      if (ok.length) return rnd(ok);
    }
    pool = TYPES.filter(t => !cargo || CARGO_TYPES.includes(t[0])).filter(fit);
    if (!pool.length) pool = TYPES.filter(t => t[2] === "jets");
    if (km != null) {
      const want = km < 1600 ? ["A320", "B738", "A20N", "E190", "A21N", "BCS3", "A319", "E195"] : km < 4500 ? ["A321", "B738", "A21N", "B38M", "A320"] : ["B789", "A359", "A333", "B77W", "A388"];
      const w = pool.filter(t => want.includes(t[0]));
      if (w.length) return rnd(w);
    }
    if (pool.some(t => t[1] === "M") && Math.random() < 0.85) pool = pool.filter(t => t[1] === "M");
    return rnd(pool);
  }

  // ---------- positions / frequencies ----------
  get split() { return !!this.positions; }
  userWorks(pos) {
    if (this.split && this.atcMode && this.atcMode[pos] === "auto" && !this.remoteStaff[pos]) return false;
    return !this.split || this.staffing.has("ALL") || this.staffing.has(pos);
  }
  hasPos(k) { return this.split && !!this.positions[k]; }
  /** Does the pilot hear a transmission on position `pos`? */
  hears(a, pos) { return !this.split || !pos || pos === "ALL" || a.freq === pos; }
  unitName(kind) {
    if (this.split && this.positions[kind]) return this.positions[kind].name;
    const U = { DEL: "Delivery", GND: "Ground", TWR: "Tower", APP: "Radar", CTR: "Control" };
    return `${this.apt.callName} ${U[kind] || kind}`;
  }
  /** Unit the pilot addresses: their current frequency in split mode, else by phase. */
  unitFor(a, phaseKind) {
    if (this.split && this.positions[a.freq]) return this.positions[a.freq].name;
    return this.unitName(phaseKind);
  }
  atis() { return LETTER_WORD[String.fromCharCode(65 + this.atisIdx % 26)].replace(/^\w/, c => c.toUpperCase()); }
  atisLetter() { return String.fromCharCode(65 + this.atisIdx % 26); }
  rollAtis() {
    this.atisIdx++; this.atisAt = this.t; this.onEvent({ type: "atis", letter: this.atisLetter() });
    if (!this.split) return;
    for (const pos of ["TWR", "APP"]) {
      if (!this.positions[pos] || this.userWorks(pos) || !this.ac.some(a => a.freq === pos && !a.veh)) continue;
      const text = `all stations, information ${this.atis()} now current${this.qnh ? ", QNH " + this.qnh : ""}`;
      this.onRadio({ from: "atc", ai: true, pos, text, say: text, ctrl: this.controllerFor(pos) });
    }
  }

  setRunway(name) {
    const e = this.apt.findRunwayEnd(name);
    if (e && e !== this.depEnd) { const had = this.t > 0; this.depEnd = e; this.arrEnd = e; if (had) this.rollAtis(); }
    else if (e) { this.depEnd = e; this.arrEnd = e; }
  }

  // ---------- spawning ----------
  freeStands(ofKinds = ["gate"], ga = false, cargo = false) {
    const used = new Set(this.ac.map(a => a.stand).filter(Boolean));
    return this.apt.stands.filter(s => !used.has(s) && ofKinds.includes(s.kind) && (cargo ? isCargoStand(s) : !isCargoStand(s)) &&
      !/maint|hangar|fuel|de-?ic|wash|engine|run-?up/i.test(s.name) &&
      (ga ? (s.kind !== "gate" || s.op === "general_aviation" || s.types.every(t => t === "props" || t === "helos")) : s.op !== "general_aviation") &&
      !this.ac.some(a => a.onGround && !a.veh && dist(a.pos, s.pos) < 40));
  }

  crewFor(f, nat) {
    f.nat = nat;
    f.style = makeStyle(this.region, nat);
    f.crew = makeCrew(nat);
    f.voice = { pitch: f.crew[0].pitch, rate: f.crew[0].rate, idx: f.crew[0].seed }; // legacy field
    return f;
  }

  makeGA() {
    const p = REG_PREFIX[this.apt.icao.slice(0, 2)] || REG_PREFIX[this.apt.icao[0]] || "N";
    let cs;
    do {
      const L = () => String.fromCharCode(65 + rint(0, 25));
      cs = p === "N" ? "N" + rint(100, 999) + L() + L() : p + L() + L() + L() + (p.length === 1 ? L() : "");
    } while (this.ac.some(a => a.cs === cs));
    const tel = [...cs].map(c => /\d/.test(c) ? c : LETTER_WORD[c][0].toUpperCase() + LETTER_WORD[c].slice(1))
      .join(" ").replace(/(\d) (?=\d)/g, "$1");
    const heli = Math.random() < 0.12;
    const ty = heli ? rnd(HELI_TYPES) : rnd(GA_TYPES);
    const dir = rnd(["north", "south", "east", "west"]);
    const f = {
      id: nextId++, cs, tel, num: "", ga: true, heli, type: ty[0], wtc: ty[1], appSpd: ty[3] * KT, other: ["VFR", `the ${dir}`],
      crossOk: new Set(), log: [],
      wantCircuits: !heli && Math.random() < 0.35 ? rint(1, 3) : 0,   // stays in the circuit for touch-and-goes
    };
    if (f.wantCircuits) f.other = ["VFR", "circuits"];
    return this.crewFor(f, REG_NAT[p] || "US");
  }

  makeFlight(standTypes, ga, { cargo = false, stand = null } = {}) {
    if (ga) return this.makeGA();
    const st = stand || (standTypes ? { types: standTypes } : null);
    let al, num, cs, dest, nat;
    const flightNo = () => String(rint(1, 9) * (Math.random() < 0.5 ? 100 : 10) + rint(0, 99));
    if (this.mix) {
      const pool = this.mix.airlines.filter(a => a.cargo === cargo);
      const list = (pool.length ? pool : this.mix.airlines).map(a => [a, a.routes]);
      let tries = 0;
      do { const a = weighted(list); al = [a.icao, a.tel]; nat = a.nat; num = flightNo(); cs = al[0] + num; } while (this.ac.some(x => x.cs === cs) && ++tries < 20);
      const pairs = this.mix.pairs.get(al[0]);
      dest = pairs && pairs.length ? this.mix.dests.get(weighted(pairs)) : null;
      nat = AIRLINE_NAT[al[0]] ? weighted(AIRLINE_NAT[al[0]]) : (nat || "GB");
    } else {
      do { al = rnd(AIRLINES); num = flightNo(); cs = al[0] + num; } while (this.ac.some(a => a.cs === cs));
      nat = weighted(AIRLINE_NAT[al[0]] || [["GB", 1]]);
    }
    const km = dest ? distKm(this.apt.d.lat, this.apt.d.lon, dest[2], dest[3]) : null;
    const ty = this.pickType(al[0], km, st, cargo);
    if (!dest) {
      const near = DESTS.filter(d => {
        const k = distKm(this.apt.d.lat, this.apt.d.lon, d[2], d[3]);
        return d[0] !== this.apt.icao && k > 150 && k < (ty[1] === "H" ? 12000 : 3500);
      });
      dest = rnd(near.length ? near : DESTS.filter(d => d[0] !== this.apt.icao));
    }
    const f = {
      id: nextId++, cs, tel: al[1], num, type: ty[0], wtc: ty[1], appSpd: ty[3] * KT, other: dest, cargo,
      crossOk: new Set(), log: [],
    };
    return this.crewFor(f, nat);
  }

  /** Local hour at the airport for the simulated clock. */
  localHourNow() { return localHour(this.clockUtc + this.t * 1000, this.apt.d.lon); }
  /** Traffic multiplier for the time of day (morning/evening peaks). */
  wave() { return this.waves ? HOUR_WAVE[Math.floor(this.localHourNow()) % 24] : 1; }

  /**
   * Put aircraft on a share of the stands (airline mix, type by stand size, cargo on cargo stands, GA on GA
   * stands). They are the next departures: spawnDeparture() wakes them up in random order.
   */
  populate(fraction = this.occupancy) {
    this.populated = true;
    const used = new Set(this.ac.map(a => a.stand).filter(Boolean));
    const stands = this.apt.stands.filter(s => !used.has(s) && s.node != null && ["gate", "tie_down", "hangar", "misc"].includes(s.kind) &&
      !/maint|hangar|fuel|de-?ic|wash|engine|run-?up/i.test(s.name));
    for (let i = stands.length - 1; i > 0; i--) { const j = rint(0, i); [stands[i], stands[j]] = [stands[j], stands[i]]; }
    const n = Math.round(Math.max(0, Math.min(1, fraction)) * stands.length);
    let made = 0;
    for (const st of stands.slice(0, n)) {
      const ga = st.kind !== "gate" || st.op === "general_aviation" || (st.types.length && st.types.every(t => t === "props" || t === "helos"));
      const cargo = !ga && isCargoStand(st);
      const f = this.makeFlight(st.types, ga, { cargo, stand: st });
      if (ga && st.types.every(t => t === "helos")) { const h = rnd(HELI_TYPES); f.type = h[0]; f.appSpd = h[3] * KT; f.heli = true; }
      this.placeParked(f, st, true);
      made++;
    }
    return made;
  }

  /** Put a just-woken aircraft back to sleep on its stand (tests, scenario editors). */
  putBack(a) { if (a && a.state === "parked" && a.kind === "dep") { a.dormant = true; a.callAt = Infinity; a.lastCall = null; } }

  /** A departure sitting on its stand. dormant: waits for spawnDeparture() to wake it. */
  placeParked(f, st, dormant) {
    const us = this.region === "US";
    Object.assign(f, {
      kind: "dep", state: "parked", stand: st, pos: [...st.pos], hdg: st.hdg, spd: 0, alt: 0, onGround: true,
      squawk: f.ga ? (us ? "1200" : "7000") : "2000", xpdr: f.ga ? "C" : "S", assignedSq: null, ifr: f.ga, dormant,
      callAt: dormant ? Infinity : this.t + rint(4, 25), freq: this.split ? (f.ga ? "GND" : "DEL") : "ALL", cfl: f.ga ? 1500 : 5000,
      parkedAt: this.t - rint(0, 1800), gear: null,
    });
    this.ac.push(f);
    this.onEvent({ type: "spawn", ac: f });
    return f;
  }

  /** Ground equipment around a parked aircraft (drawn by the radar): bridge/stairs, fuel, catering, bags, bus, tug. */
  equipment(a) {
    if (!a.onGround || a.veh || a.human) return null;
    const s = a.state;
    if (a.kind === "dep" && (s === "push_req" || s === "pushing")) return s === "pushing" ? ["tug"] : ["tug", "stairs"];
    if (s !== "parked" || !a.stand) return null;
    const age = this.t - (a.parkedAt ?? this.t);
    if (a.kind === "arr" && age > 1500) return null;
    if (a.dormant && (a.id * 2654435761 >>> 0) % 3 === 0) return null;      // some just sit there
    const gate = a.stand.kind === "gate" && !a.ga;
    const out = [gate && a.stand.size && a.stand.size >= "C" && !isCargoStand(a.stand) ? "bridge" : "stairs"];
    if (!a.ga) { if (age < 1200 || a.dormant) out.push("fuel"); if (gate && !isCargoStand(a.stand) && age < 900) out.push("catering"); out.push("baggage"); if (out[0] === "stairs" && !a.ga && !isCargoStand(a.stand)) out.push("bus"); }
    return out;
  }

  /** A landed aircraft becomes the next departure after a turnaround (or leaves when the apron is full). */
  turnaround(a) {
    const parked = this.ac.filter(o => o.state === "parked" && o.kind === "dep").length;
    const stands = this.apt.stands.filter(s => s.kind === "gate" || s.kind === "tie_down").length;
    if (parked > this.occupancy * stands + 2 || Math.random() < 0.15) { a.gone = true; return; }
    if (a.assignedSq) this.squawks.release(a.assignedSq, this.t);
    const al = a.cs.slice(0, 3);
    const pairs = this.mix && this.mix.pairs.get(al);
    const dest = a.ga ? a.other : pairs && pairs.length ? this.mix.dests.get(weighted(pairs)) : rnd(DESTS.filter(d => d[0] !== this.apt.icao));
    let num; do { num = String(rint(1, 9) * (Math.random() < 0.5 ? 100 : 10) + rint(0, 99)); } while (this.ac.some(x => x !== a && x.cs === al + num));
    if (!a.ga) { a.num = num; a.cs = al + num; }
    Object.assign(a, { kind: "dep", state: "parked", dormant: true, ifr: !!a.ga, assignedSq: null, squawk: a.ga ? a.squawk : "2000", xpdr: a.ga ? "C" : "S",
      other: dest || a.other, callAt: Infinity, sid: null, cfl: a.ga ? 1500 : 5000, landClr: false, end: null, depEnd: null, calledIn: false, greeted: {},
      atisReported: null, exitName: "", viaText: "", path: null, rbError: null, reqAt: null, strip: null, stripData: null, prepared: null,
      freq: this.split ? (a.ga ? "GND" : "DEL") : "ALL", lastCall: null, handedOff: false, askedFreq: false, toClr: false, parkedAt: this.t });
    a.crossOk.clear();
    this.onEvent({ type: "turnaround", ac: a });
  }

  // ---------- service vehicles on the service roads ----------
  ensureServiceVehicles() {
    const have = this.ac.filter(a => a.veh && a.onRoad).length;
    const want = this.apt.roads.length ? this.serviceVehicles : 0;
    const kinds = ["fuel", "baggage", "bus", "catering", "baggage", "fuel"];
    for (let i = have; i < want; i++) {
      const n = this.apt.nearestRoadNode(this.apt.stands.length ? rnd(this.apt.stands).pos : this.apt.towerPos());
      if (n < 0) break;
      const v = this.spawnVehicle({ vtype: kinds[i % kinds.length], pos: this.apt.nodes[n], maxSpd: 7 + Math.random() * 4 });
      v.onRoad = true; v.quiet = true; v.state = "roam"; v.node = n; v.pauseUntil = this.t + rint(0, 60);
    }
    for (const v of this.ac.filter(a => a.veh && a.onRoad).slice(want)) v.gone = true;
  }

  roam(v, dt) {
    if (this.t < (v.pauseUntil || 0)) { v.spd = 0; return; }
    if (!v.path || v.pi >= v.path.length) {
      const from = this.apt.nearestRoadNode(v.pos);
      let route = null;
      for (let k = 0; k < 6 && !route; k++) {
        const goal = this.apt.nearestRoadNode(rnd(this.apt.stands.length && Math.random() < 0.7 ? this.apt.stands : [{ pos: this.apt.nodes[rnd([...this.apt.roadAdj.keys()].filter(i => this.apt.roadAdj[i].length))] }]).pos);
        if (goal >= 0 && goal !== from) route = this.apt.roadRoute(from, goal);
      }
      if (!route || route.length < 2) { v.pauseUntil = this.t + 30; return; }
      v.path = [[...v.pos, null], ...route.map(n => [...this.apt.nodes[n], null])]; v.pi = 1;
      return;
    }
    if (this.followPath(v, dt)) { v.pauseUntil = this.t + rint(20, 120); v.path = null; }
  }

  spawnDeparture(opts = {}) {
    // the apron is populated: wake a parked aircraft (cargo stands get cargo flights, GA stands GA); airline
    // flights far more often than the light aircraft, whatever the stand count says
    let dormant = this.ac.filter(a => a.dormant && a.state === "parked" && !a.human && (opts.ga == null || !!a.ga === !!opts.ga));
    if (dormant.length) {
      const f = weighted(dormant.map(a => [a, a.ga ? 0.15 : a.cargo ? 0.6 : 1]));
      f.dormant = false; f.callAt = this.t + rint(4, 25);
      f.freq = this.split ? (f.ga ? "GND" : "DEL") : "ALL";
      this.assignSlot(f);
      this.onEvent({ type: "wake", ac: f });
      return f;
    }
    let { stand: st, ga } = this.pickStand();
    if (opts.ga === false && ga) { const g = this.freeStands(); if (!g.length) return null; st = rnd(g); ga = false; }
    if (!st) return null;
    const f = this.makeFlight(st.types, ga, { cargo: !ga && isCargoStand(st), stand: st });
    const placed = this.placeParked(f, st, false);
    if (placed) this.assignSlot(placed);
    return placed;
  }

  /** Cargo stands take cargo flights; GA stands GA. Occasionally a cargo departure from a free cargo stand. */
  pickStand() {
    const gates = this.freeStands();
    const cargoStands = this.freeStands(["gate", "misc"], false, true);
    const ga = this.freeStands(["tie_down", "hangar", "misc", "gate"], true);
    if (cargoStands.length && this.mix && this.mix.airlines.some(a => a.cargo) && Math.random() < 0.15) return { stand: rnd(cargoStands), ga: false };
    if (gates.length && (!ga.length || Math.random() < 0.85)) return { stand: rnd(gates), ga: false };
    if (ga.length) return { stand: rnd(ga), ga: true };
    return { stand: null, ga: !this.apt.stands.some(s => s.kind === "gate") };
  }

  spawnArrival() {
    const e = this.arrEnd;
    const { stand, ga } = this.pickStand();
    const spawnD = ga ? 6000 : this.hasPos("APP") ? APP_SPAWN : FINAL_SPAWN;
    // keep ~3 nm (5.5 km) behind previous arrival
    const last = this.ac.filter(a => a.kind === "arr" && !a.onGround && a.state !== "goaround")
      .map(a => this.distToThr(a)).reduce((m, d) => Math.max(m, d), -1e9);
    // Approach leaves gaps for the departures when some are waiting (mixed mode): ~6 NM instead of ~3
    const waiting = this.ac.filter(o => o.kind === "dep" && ["holding", "taxi", "lined_up"].includes(o.state) && o.depEnd && o.depEnd.rwy === e.rwy).length;
    if (last > spawnD - (waiting >= 2 ? 15000 : waiting ? 11000 : 5500)) return null;
    // and in time: a slow aircraft put on a short final must not land in front of a faster one already inbound (a STAR
    // flight's distance is the way it still has to fly, not its projection on the runway axis)
    const etaNew = spawnD / ((ga ? 90 : 140) * KT);
    const etas = this.ac.filter(a => a.kind === "arr" && !a.onGround && ["final", "star"].includes(a.state) && !a.vfr && a.end === e)
      .map(a => (a.state === "star" ? dist(a.pos, e.thr) * 1.15 : Math.max(0, this.distToThr(a))) / Math.max(40, a.spd || a.appSpd || 60));
    if (etas.some(t => Math.abs(t - etaNew) < (waiting ? 150 : 90))) return null;
    const f = this.makeFlight(stand ? stand.types : null, ga, { cargo: !!stand && !ga && isCargoStand(stand), stand });
    // F4: with an approach position and real data, the arrival starts at its STAR's entry fix and flies the STAR
    const sp = !ga && this.hasPos("APP") && this.starPath ? this.starPath(e, f) : null;
    if (sp && sp.pts.length && Math.hypot(...sp.pts[0].p) < 80 * NM && Math.hypot(...sp.pts[0].p) > 8 * NM &&
      !this.ac.some(o => o.kind === "arr" && !o.onGround && dist(o.pos, sp.pts[0].p) < 8 * NM)) {
      return this.spawnStarArrival(f, e, sp, stand);
    }
    const pos = [e.thr[0] - e.v[0] * spawnD, e.thr[1] - e.v[1] * spawnD];
    const sq = ga ? (this.region === "US" ? "1200" : "7000") : this.squawks.next(this.t);
    Object.assign(f, {
      kind: "arr", state: "final", pos, hdg: e.hdg, spd: f.appSpd, alt: 0, onGround: false, end: e,
      landClr: false, squawk: sq, assignedSq: ga ? null : sq, xpdr: "C", ifr: !ga,
      callAt: this.t + rint(3, 15), stand, cfl: 6000,
      freq: this.split ? (ga || !this.hasPos("APP") ? "TWR" : "APP") : "ALL",
    });
    f.alt = this.arrAlt(f);
    this.ac.push(f);
    this.onEvent({ type: "spawn", ac: f });
    return f;
  }

  /** An arrival on a real STAR: entry fix, the STAR's fixes with their altitudes, then a 10 NM final intercept. */
  spawnStarArrival(f, e, sp, stand) {
    const sq = this.squawks.next(this.t);
    const icpt = { p: [e.thr[0] - e.v[0] * 10 * NM, e.thr[1] - e.v[1] * 10 * NM], id: "FINAL", alt: 3000, final: true };
    const first = sp.pts[0];
    const alt = Math.max(5000, Math.min(14000, first.alt || 10000));
    const wps = [...sp.pts.slice(1), icpt];
    Object.assign(f, {
      kind: "arr", state: "star", pos: [...first.p], hdg: hdgOf(wps[0].p[0] - first.p[0], wps[0].p[1] - first.p[1]), spd: 250 * KT, alt, onGround: false, end: e,
      landClr: false, squawk: sq, assignedSq: sq, xpdr: "C", ifr: true, callAt: this.t + rint(3, 15), stand, cfl: alt,
      freq: this.split ? "APP" : "ALL", star: sp.name, appName: sp.app, starWps: wps, starI: 0,
    });
    this.ac.push(f);
    this.onEvent({ type: "spawn", ac: f });
    return f;
  }

  /** Flying the STAR: turn toward the next fix (3°/s), descend to its altitude (or 3000 ft at the intercept). */
  starMove(a, dt) {
    if (this.t >= a.callAt && !a.calledIn) {
      a.calledIn = true;
      this.call(a, "approachInitial", { alt: `${a.alt >= 10000 ? "flight level " + Math.round(a.alt / 1000) * 10 : Math.round(a.alt / 100) * 100 + " feet"}` }, "APP");
    }
    // E7: radar vectors fly a heading until the approach clearance; a hold circles the fix until the EAT
    if (a.vectorHdg != null) {
      a.hdg = this.turnToward(a.hdg, a.vectorHdg, dt, 3);
      const hv0 = vecFromHdg(a.hdg);
      a.pos = [a.pos[0] + hv0[0] * a.spd * dt, a.pos[1] + hv0[1] * a.spd * dt];
      if (!this.tcasControls(a, dt) && a.cfl && a.alt > a.cfl) a.alt = Math.max(a.cfl, a.alt - 1800 / 60 * dt);
      return;
    }
    if (a.holdP && (a.eat == null || this.t < a.eat) && dist(a.pos, a.holdP) < 3 * NM) {
      a.hdg = (a.hdg + 3 * dt) % 360;                     // standard rate, right-hand pattern around the fix
      const hv1 = vecFromHdg(a.hdg);
      a.pos = [a.pos[0] + hv1[0] * a.spd * dt, a.pos[1] + hv1[1] * a.spd * dt];
      a.holding = true;
      this.tcasControls(a, dt);
      return;
    }
    a.holding = false;
    const list = a.navWps && a.navWps.length ? a.navWps : a.starWps;
    const k = a.navWps && a.navWps.length ? "navI" : "starI";
    a[k] = a[k] || 0;
    const w = list[a[k]];
    if (!w) { a.navWps = null; a.navI = 0; if (a.starI >= a.starWps.length) a.starI = a.starWps.length - 1; return; }
    a.hdg = this.turnToward(a.hdg, hdgOf(w.p[0] - a.pos[0], w.p[1] - a.pos[1]), dt, 3);
    const want = w.final ? 3000 : (w.alt && w.desc !== "+" ? w.alt : Math.max(3000, Math.min(a.alt, w.alt || a.alt)));
    const top = Math.min(a.cfl || a.alt, a.alt);
    if (!this.tcasControls || !this.tcasControls(a, dt)) a.alt += Math.max(-1800 / 60 * dt, Math.min(0, Math.max(want, Math.min(want, top)) - a.alt));
    a.spd = Math.max(a.appSpd + 30 * KT, Math.min(250 * KT, a.spd + (w.final ? -0.5 : 0) * dt));
    const hv = vecFromHdg(a.hdg);
    a.pos = [a.pos[0] + hv[0] * a.spd * dt, a.pos[1] + hv[1] * a.spd * dt];
    if (dist(a.pos, w.p) < 1800) {
      a[k]++;
      if (w.final) {                      // established: the rest is the normal final (ILS) model
        const e = a.end, along = -this.distToThr(a);
        a.pos = [e.thr[0] + e.v[0] * along, e.thr[1] + e.v[1] * along];
        a.hdg = e.hdg; a.state = "final"; a.cfl = Math.max(a.alt, 3000); a.navWps = null;
        a.alt = this.arrAlt(a);
      }
    }
  }

  spawnOverflight() {
    if (!this.hasPos("CTR")) return null;
    const f = this.makeFlight(null, false);
    const brg = Math.random() * 360, R = 40 * NM;
    const pos = [Math.sin(brg * Math.PI / 180) * R, Math.cos(brg * Math.PI / 180) * R];
    const hdg = (brg + 180 + rint(-35, 35) + 360) % 360;
    const east = hdg < 180;
    const fl = (Math.floor(rint(30, 38) / 2) * 2 + (east ? 1 : 0)) * 1000;
    Object.assign(f, {
      kind: "ovf", state: "cruise", pos, hdg, spd: 450 * KT, alt: fl, onGround: false, squawk: this.squawks.next(this.t),
      xpdr: "C", ifr: true, callAt: this.t + rint(5, 20), freq: "CTR", cfl: fl,
      other: [rnd(DESTS)[0], rnd(DESTS)[0]],
    });
    f.assignedSq = f.squawk;
    this.ac.push(f);
    this.onEvent({ type: "spawn", ac: f });
    return f;
  }

  /**
   * The pilot's own SimBrief flight (S2) as traffic, with exactly the OFP's data: callsign, type, registration,
   * a stand that fits, destination, route, SID (if it is one of this runway's), cruise level, EOBT as the TOBT.
   * kind: "dep" when the OFP leaves this airport, "arr" when it arrives here.
   */
  spawnFromPlan(plan, kind = "dep") {
    if (!plan || !plan.callsign) return null;
    const icao = plan.aircraft.type || "A320";
    const known = TYPES.find(t => t[0] === icao);
    const ty = known || [icao, plan.aircraft.wtc || "M", plan.aircraft.wtc === "H" ? "heavy" : "jets", plan.aircraft.wtc === "L" ? 100 : 140];
    const airline = plan.airline || plan.callsign.slice(0, 3);
    const mixAl = this.mix && this.mix.airlines.find(a => a.icao === airline);
    const tel = (mixAl && mixAl.tel) || (AIRLINES.find(a => a[0] === airline) || [])[1] || airline;
    const nat = AIRLINE_NAT[airline] ? weighted(AIRLINE_NAT[airline]) : (mixAl && mixAl.nat) || "GB";
    const existing = this.ac.find(a => a.cs === plan.callsign);
    if (existing) this.ac.splice(this.ac.indexOf(existing), 1);
    const far = kind === "dep" ? plan.destination : plan.origin;
    const other = [far.icao || "ZZZZ", far.name ? far.name.split(" ")[0].replace(/^\w/, c => c.toUpperCase()).replace(/[A-Z]{2,}/g, w => w[0] + w.slice(1).toLowerCase()) : far.icao, far.lat || 0, far.lon || 0];
    const f = { id: nextId++, cs: plan.callsign, tel, num: plan.flight_number || plan.callsign.replace(/^[A-Z]{3}/, ""), type: ty[0], wtc: ty[1], appSpd: ty[3] * KT, other, cargo: false, crossOk: new Set(), log: [] };
    this.crewFor(f, nat);
    const planned = { plan, reg: plan.aircraft.reg || "", equip: plan.aircraft.equip || "", route: plan.route || "", rfl: plan.initial_alt_ft || 0, planSid: plan.sid || "", planStar: plan.star || "",
      eobt: plan.times && plan.times.eobt ? plan.times.eobt.hhmm : "", altn: plan.alternate ? plan.alternate.icao : "", remarks: plan.remarks || "", simbrief: true };
    if (kind === "dep") {
      let st = this.freeStands().find(s => standFits(s, ty)) || this.freeStands()[0] || this.freeStands(["gate", "misc"], false, true)[0];
      if (!st) return null;
      const placed = this.placeParked(f, st, false);
      Object.assign(placed, planned, { callAt: this.t + rint(8, 20), sid: null });   // the SID comes with the clearance (suggested from the OFP when it fits the runway)
      this.assignSlot(placed);
      this.onEvent({ type: "planFlight", ac: placed });
      return placed;
    }
    const e = this.arrEnd;
    const spawnD = this.hasPos("APP") ? APP_SPAWN : FINAL_SPAWN;
    const pos = [e.thr[0] - e.v[0] * spawnD, e.thr[1] - e.v[1] * spawnD];
    const sq = this.squawks.next(this.t);
    const stand = this.freeStands().find(s => standFits(s, ty)) || this.freeStands()[0] || null;
    Object.assign(f, planned, { kind: "arr", state: "final", pos, hdg: e.hdg, spd: f.appSpd, alt: 0, onGround: false, end: e, landClr: false, squawk: sq, assignedSq: sq, xpdr: "C", ifr: true,
      callAt: this.t + rint(3, 10), stand, cfl: 6000, freq: this.split ? (this.hasPos("APP") ? "APP" : "TWR") : "ALL", star: plan.star || "" });
    f.alt = this.arrAlt(f);
    this.ac.push(f);
    this.onEvent({ type: "spawn", ac: f });
    this.onEvent({ type: "planFlight", ac: f });
    return f;
  }

  /** Real pilots (XRadio): placed and moved from outside, never by the sim. */
  upsertHuman(h) {
    let a = this.ac.find(x => x.human && x.hid === h.hid);
    if (!a) {
      a = { id: nextId++, human: true, hid: h.hid, kind: "human", state: "human", crossOk: new Set(), log: [],
        tel: h.cs, num: "", nat: "", style: NEUTRAL_STYLE, crew: makeCrew("GB"), other: ["", ""], wtc: "M", freq: "ALL" };
      this.ac.push(a);
      this.onEvent({ type: "spawn", ac: a });
    }
    const wasGround = a.onGround;
    const oldType = a.type;
    Object.assign(a, { cs: h.cs, type: h.type || "ZZZZ", pos: h.pos, alt: h.alt, hdg: h.hdg, spd: h.spd,
      onGround: !!h.onGround, squawk: h.squawk, xpdr: h.xpdr || "C", seenAt: this.t, ai: !!h.ai, tx: !!h.tx });
    this.humanType(a, h.acft || null, oldType);
    if (h.tcas !== undefined) a.ownTcas = h.tcas || null;          // PART D: the pilot's own X-Plane TCAS
    if (h.vs != null) a.vs = h.vs;                                  // vertical speed, m/s (TCAS sense against a human)
    a.fixPos = h.pos; a.fixT = this.t; a.stale = false;           // A5: extrapolated between updates (traffic.js)
    this.humanRunwayEvents(a, wasGround);
    if (h.fp) this.humanFlightPlan(a, h.fp);
    return a;
  }

  /** A real pilot's flight plan (XRadio PT_FLIGHTPLAN) fills the strip: route, type, cruise, rules. */
  humanFlightPlan(a, fp) {
    a.fp = fp;
    a.other = [fp.dep || "", fp.dest || ""];
    if (fp.ac_icao) a.type = fp.ac_icao;
    if (fp.cruise_ft) a.cfl = fp.cruise_ft;
    a.ifr = fp.rules !== "V";
    a.assignedSq = fp.squawk ? String(fp.squawk).padStart(4, "0") : a.assignedSq;
    a.fpStatus = fp.status || "filed";
    // S3: what the pilot filed from XRadio (a SimBrief OFP, usually) shows on the strip and goes into EuroScope's $FP
    if (fp.route) a.route = fp.route;
    const first = String(fp.route || "").trim().split(/\s+/)[0] || "";
    if (/^[A-Z]{3,5}\d[A-Z]?$/.test(first)) a.planSid = first;   // the SID the pilot filed (SimBrief puts it first)
    if (fp.altn) a.altn = fp.altn;
    if (fp.cruise_ft) a.rfl = fp.cruise_ft;
    const rem = String(fp.remarks || "");
    if (rem) a.remarks = rem;
    const eobt = /EOBT\/(\d{4})/.exec(rem), tas = /TAS\/(\d{3,4})/.exec(rem), reg = /REG\/([A-Z0-9]+)/.exec(rem), eq = /EQPT\/(\S+)/.exec(rem);
    if (eobt) a.eobt = eobt[1];
    if (tas) a.tas_plan = +tas[1];
    if (reg) a.reg = reg[1];
    if (eq) a.equip = eq[1];
    if (/\bSIMBRIEF\b/.test(rem)) a.simbrief = true;
  }
  humanByCs(cs) { return this.ac.find(x => x.human && x.cs === cs) || null; }

  /** C3: a real pilot's type as XRadio detected it: wake category, wingspan (silhouette, separation), approach
   *  speed, stand size. An unknown type shows "type?" and flies with medium / default values. */
  humanType(a, acft, oldType) {
    const t = TYPE_INFO[a.type] || [...GA_TYPES, ...HELI_TYPES].find(x => x[0] === a.type), dim = AC_DIM[a.type];
    const fromXr = acft && acft.ac_icao === a.type ? acft : null;
    a.typeUnknown = !t && !dim && !(fromXr && fromXr.wtc) || a.type === "ZZZZ" || (fromXr && fromXr.source === 0);
    a.wtc = (fromXr && fromXr.wtc) || (t && t[1]) || (a.typeUnknown ? "M" : a.wtc || "M");
    a.span = (fromXr && fromXr.span_m) || (dim && dim[0]) || 35;
    a.appSpd = ((t && t[3]) || (a.wtc === "H" || a.wtc === "J" ? 145 : a.wtc === "L" ? 80 : 135)) * KT;
    a.cat = t ? t[2] : a.span > 52 ? "heavy" : a.span > 20 ? "jets" : a.span > 15 ? "turboprops" : "props";
    if (fromXr) { a.tail = fromXr.tailnum || a.tail; a.typeSource = ["default", "detected", "mapped", "manual"][fromXr.source] || ""; a.mtow = fromXr.mtow_kg || 0; }
    if (oldType && oldType !== a.type) this.onEvent({ type: "humanType", ac: a, from: oldType, to: a.type });
  }
  /** A free stand that fits a real pilot's aircraft. */
  standForHuman(a) {
    const tup = [a.type, a.wtc, a.cat || "jets", 0];
    const free = this.freeStands(["gate", "misc", "tie_down", "hangar"], a.cat === "props", false);
    return free.find(s => standFits(s, tup) && (!s.types || !s.types.length || s.types.includes(tup[2]))) || free.find(s => standFits(s, tup)) || free[0] || null;
  }

  /** A real pilot taking off starts the wake timers like anyone; entering a runway in use is a runway incursion. */
  humanRunwayEvents(a, wasGround) {
    const r = a.pos ? this.apt.nearestRunway(a.pos) : -1;
    if (wasGround && !a.onGround && r >= 0 && this.apt.distToRunway(a.pos, this.apt.runways[r]) < 300) {
      const e = this.apt.runways[r].ends.reduce((b, x) => Math.abs(angDiff(a.hdg, x.hdg)) < Math.abs(angDiff(a.hdg, b.hdg)) ? x : b);
      this.lastTakeoff = { t: this.t, wtc: a.wtc || "M", cs: a.cs, type: a.type, rwy: e.rwy, human: true };
    }
    if (!a.onGround || r < 0) { a.onRwy = null; return; }
    const on = this.apt.onRunway(a.pos, this.apt.runways[r], 5) ? r : null;
    if (on != null && a.onRwy !== on) {
      const d = this.runwayDanger(on, a, { finalNm: 2, finalSec: 60 });
      if (d.busy && a.spd < 40 * KT) this.atcError("incursion", { by: `pilot ${a.cs}`, ac: a, text: `${a.cs} (real pilot) entered runway ${this.apt.runways[on].label} with ${d.by ? d.by.cs : "traffic"} ${d.why}`,
        should: `"${a.cs}, hold position" — and stop the traffic on the runway / send the arrival around` });
    }
    a.onRwy = on;
  }

  distToThr(a) {
    const e = a.end || this.arrEnd;
    return -((a.pos[0] - e.thr[0]) * e.v[0] + (a.pos[1] - e.thr[1]) * e.v[1]);
  }
  glideAlt(a) { return Math.max(0, this.distToThr(a) * Math.tan(3 * Math.PI / 180) / FT + 50); }
  arrAlt(a) { return Math.min(this.glideAlt(a), a.cfl || 6000); }

  // ---------- radio ----------
  /** Legacy helper: "Tallinn Ground" etc. by phase. */
  unit(kind) {
    const K = { Delivery: "DEL", Ground: "GND", Tower: "TWR", Radar: "APP", Control: "CTR" }[kind] || kind;
    return this.unitName(K);
  }
  sayCs(a) { return callsign(a, a.style || NEUTRAL_STYLE).d; }
  cs(a) { return callsign(a, a.style || NEUTRAL_STYLE); }

  /** Emit a pilot transmission. text may be a string or {d, s}. A radio-failure aircraft cannot transmit:
   *  what it would have said is kept for the info panel instead. */
  pilot(a, text, kind) {
    const m = typeof text === "string" ? { d: text, s: sayNumbers(text, a.style || NEUTRAL_STYLE) } : text;
    if (a.nordo) { a.lastWant = m.d; a.lastWantAt = this.t; this.onEvent({ type: "nordoWants", ac: a, text: m.d }); return; }
    a.lastCall = this.t;
    const speaker = m.prepared ? 0 : Math.random() < 0.85 ? 0 : 1;
    // an emergency that lost its frequency calls on guard (121.500), which Tower and Approach always monitor
    const pos = a.mayday && a.freq === "LOST" ? "GUARD" : a.freq;
    this.onRadio({ from: "pilot", ac: a, text: m.d, say: m.s, pos, speaker, kind, prepared: !!m.prepared });
  }

  /** Build a templated pilot call {d, s} without transmitting it. */
  buildCall(a, kind, ctx = {}, phaseUnit = "TWR") {
    const st = a.style || NEUTRAL_STYLE;
    const c = {
      st, cs: this.cs(a), unit: this.unitFor(a, phaseUnit), typeSp: spokenType(a.type),
      stand: a.stand ? a.stand.name : "", atis: a.atisReported || this.atis(), dest: a.other ? a.other[1] : "",
      rwy: (a.depEnd || a.end || this.depEnd).name, greet: "", ...ctx,
    };
    if (ctx.greet === undefined && !a.greeted?.[a.freq]) {
      c.greet = greeting(st, localHour(this.clockUtc + this.t * 1000, this.apt.d.lon), this.apt.icao);
      a.greeted = { ...(a.greeted || {}), [a.freq]: true };
    }
    return pilotCall(kind, c);
  }

  /** A templated pilot call. */
  call(a, kind, ctx = {}, phaseUnit = "TWR") {
    this.pilot(a, this.buildCall(a, kind, ctx, phaseUnit), kind);
    a.reqAt = this.t;
  }

  /** Build the pilot's next call now (so its voice can be rendered before they key) and keep it for later. */
  scheduleCall(a, kind, ctx = {}, phaseUnit = "TWR", at = a.callAt) {
    if (a.nordo) return;
    const m = this.buildCall(a, kind, ctx, phaseUnit);
    m.prepared = true;
    a.prepared = { kind, m, at, freq: a.freq };
    this.onEvent({ type: "prepare", ac: a, m: { ...m, kind } });
  }
  /** Transmit a prepared call if it still fits (same frequency), else build a fresh one. */
  callPrepared(a, kind, ctx = {}, phaseUnit = "TWR") {
    const p = a.prepared;
    a.prepared = null;
    if (p && p.kind === kind && p.freq === a.freq) { this.pilot(a, p.m, kind); a.reqAt = this.t; return; }
    this.call(a, kind, ctx, phaseUnit);
  }

  /** ATC (AI controller) transmission on a position; parsed and applied like the user's. */
  atc(pos, text, opts = {}) {
    const pp = parse(text, this.ac.filter(a => this.hears(a, pos)), null);
    const action = pp.ins.length && pp.ins.every(i => i.t === "light" || i.t === "followMe");
    if (action) {                      // a light-gun signal is not a transmission
      if (pp.ac) this.respond(pp.ac, pp.ins, { text: pp.normalized, pos, ai: true });
      this.onEvent({ type: "aiAction", pos, text, ac: pp.ac });
      return;
    }
    const shown = opts.display || text;
    this.onRadio({ from: "atc", ai: true, pos, text: shown, say: sayNumbers(shown, NEUTRAL_STYLE), ctrl: opts.ctrl || null });
    if (pp.ac && !pp.ac.human) {
      const r = this.respond(pp.ac, pp.ins, { text: pp.normalized, pos, ai: true });
      if (r) this.pilot(pp.ac, r, "readback");
    }
  }

  // ---------- main loop ----------
  step(dt) {
    this.t += dt;
    if (!this.populated) { this.populate(); this.ensureServiceVehicles(); }
    const wave = Math.max(0.1, this.wave());
    if (this.t >= this.nextDep) {
      this.spawnDeparture();
      this.nextDep = this.t + 3600 / Math.max(1, this.depPerHour * wave) * (0.6 + Math.random() * 0.8);
    }
    if (this.t >= this.nextArr) {
      if (this.spawnArrival()) this.nextArr = this.t + 3600 / Math.max(1, this.arrPerHour * wave) * (0.6 + Math.random() * 0.8);
      else this.nextArr = this.t + 20;
    }
    if (Math.floor(this.t / 30) !== Math.floor((this.t - dt) / 30)) this.ensureServiceVehicles();
    if (this.t >= this.nextVfr) {
      if (this.vfrPerHour > 0 && this.freeStands(["tie_down", "hangar", "misc", "gate"], true).length) this.spawnVfrInbound();
      this.nextVfr = this.t + 3600 / Math.max(0.2, this.vfrPerHour * wave) * (0.6 + Math.random() * 0.8);
    }
    if (this.overflights && this.t >= this.nextOvf) {
      this.spawnOverflight();
      this.nextOvf = this.t + 3600 / Math.max(1, this.ovfPerHour) * (0.6 + Math.random() * 0.8);
    }
    if (this.t - this.atisAt > 1800) this.rollAtis();
    this.trafficTick();
    for (const a of this.ac) if (!a.human) this.update(a, dt);
    this.tcasTick(dt);
    if (this.pendingAtc && this.pendingAtc.length) {
      // an AI controller's answer prepared by the traffic logic (a new route around a blocking aircraft)
      for (const m of this.pendingAtc.filter(m => this.t >= m.at)) {
        this.onRadio({ from: "atc", ai: true, pos: m.pos, text: m.text, say: sayNumbers(m.text, NEUTRAL_STYLE) });
        if (!m.ac.gone && m.rb) this.pilot(m.ac, readback([m.rb], this.cs(m.ac), m.ac.style || NEUTRAL_STYLE), "readback");
      }
      this.pendingAtc = this.pendingAtc.filter(m => this.t < m.at);
    }
    for (const a of this.ac) if (a.human && this.t - a.seenAt > 15) a.gone = true;
    for (const a of this.ac) if (a.gone && a.assignedSq && !a.human) this.squawks.release(a.assignedSq, this.t);
    const gone = this.ac.filter(a => a.gone);
    this.ac = this.ac.filter(a => !a.gone);
    for (const a of gone) this.onEvent({ type: "gone", ac: a });
    if (Math.floor(this.t) !== Math.floor(this.t - dt)) {
      this.checkConflicts();
      this.checkReadbacks();
      this.opsTick();
      this.eventsTick();
      this.handoffTick();
      if (this.split) this.aiTick();
      if (this.events && this.t >= this.nextEvent) this.scriptedEvent();
    }
  }

  update(a, dt) {
    const s = a.state;
    // frequency switch after a "contact" instruction
    if (a.switchAt && this.t >= a.switchAt) this.doSwitch(a);
    if (a.lostUntil && this.t >= a.lostUntil) {
      a.lostUntil = null; a.freq = a.prevFreq;
      this.call(a, "noReply", { freq: a.lostFreq, greet: "" });
    }
    if (a.checkInAt && this.t >= a.checkInAt && !a.lostUntil) { a.checkInAt = null; this.checkIn(a); }
    if (a.veh) { this.updateVehicle(a, dt); if (a.removeAt && this.t >= a.removeAt) a.gone = true; return; }
    this.transponder(a);
    if (a.ga && a.reports) this.vfrReportTick(a);

    if (s === "circuit" || (s === "inbound" && a.wps && a.wpi < a.wps.length)) {
      this.circuitMove(a, dt);
    } else if (s === "inbound") {
      /* at the reporting point, waiting for joining instructions (vfrInboundTick) */
    } else if (a.kind === "dep") {
      if (s === "parked" && a.dormant) { /* waiting on the stand for its slot */ }
      else if (s === "parked" && this.t >= a.callAt && a.heli) {
        this.call(a, "stillWaitingGeneric", { what: `helicopter on the apron, request departure from present position, VFR to ${a.other[1]}` }, "GND");
        a.state = "taxi_req"; a.callAt = this.t + 150;
      } else if (s === "parked" && this.t >= a.callAt && a.ga) {
        if (!a.vfrExit && !a.wantCircuits) a.vfrExit = this.pickVfrExit(a);
        this.call(a, "gaTaxi", { dest: `${a.other[1]}${a.vfrExit && !a.vfrExit.generic ? " via " + a.vfrExit.name : ""}` }, "GND");
        a.state = "taxi_req";
      } else if (s === "parked" && this.t >= a.callAt) {
        a.atisReported = Math.random() < this.rates.oldAtis && this.atisIdx > 0
          ? LETTER_WORD[String.fromCharCode(64 + this.atisIdx % 26 || 90)].replace(/^\w/, c => c.toUpperCase()) : null;
        this.call(a, "clearanceRequest", {}, "DEL");
        a.state = "clr_req"; a.callAt = this.t + 120;
      } else if (s === "clr_req" && this.t >= a.callAt) {
        this.call(a, "stillWaiting", { greet: "" }, "DEL");
        a.callAt = this.t + 120;
      } else if (s === "cleared" && this.t >= a.callAt) {
        if (!this.split || a.freq === "GND" || !this.hasPos("GND")) {
          this.callPrepared(a, "push", {}, "GND");
          a.state = "push_req"; a.callAt = this.t + 150;
        } else if (!a.askedHandoff) {
          a.askedHandoff = true; // left on Delivery: asks where to go
          this.call(a, "stillWaitingGeneric", { what: `ready for push and start, which frequency?`, greet: "" }, "DEL");
        }
      } else if (s === "push_req" && this.t >= a.callAt) {
        this.call(a, "stillWaitingGeneric", { what: `stand ${a.stand ? a.stand.name : ""}, still waiting for push and start`, greet: "" }, "GND");
        a.callAt = this.t + 150;
      } else if (s === "pushing") {
        if (!a.pushStarted) {
          const pc = this.pushClear(a);
          if (!pc.ok) {
            a.spd = 0;
            if (!a.pushWaitCalled) { a.pushWaitCalled = true; this.call(a, "stillWaitingGeneric", { what: `traffic passing behind, we'll wait before we push`, greet: "" }, "GND"); }
            return;
          }
          a.pushStarted = true;
        }
        if (this.followPath(a, dt, true)) {
          a.state = "pushed"; a.callAt = this.t + rint(20, 60);
          if (a.autoTaxi) { a.autoTaxi = false; this.lightTaxi(a); }
          else this.scheduleCall(a, "taxi", {}, "GND");
        }
      } else if (s === "pushed" && this.t >= a.callAt) {
        this.callPrepared(a, "taxi", {}, "GND");
        a.state = "taxi_req"; a.callAt = this.t + 150;
      } else if (s === "taxi_req" && this.t >= a.callAt) {
        this.call(a, "stillWaitingGeneric", { what: a.heli ? "ready for departure from present position" : "ready to taxi", greet: "" }, "GND");
        a.callAt = this.t + 150;
      } else if (s === "taxi" || s === "lineup") {
        const done = this.followPath(a, dt);
        if (s === "taxi" && a.taxiTo === "stand") {
          if (done) { this.parkAt(a); a.returned = true; a.callAt = this.t + rint(240, 600); a.state = "parked"; }
        } else if (s === "taxi" && a.atStop && a.blockedRwy === a.depEnd.rwy && a.spd < 0.1) {
          a.state = "holding"; a.holdAt = this.t;
          if (!a.calledReadyEarly) this.callPrepared(a, "ready", { rwy: a.depEnd.name }, "TWR");
          a.calledReadyEarly = false; a.callAt = this.t + 120;
        } else if (s === "taxi" && !a.prepared && !a.calledReadyEarly && a.blockedRwy === a.depEnd.rwy && a.distToStop != null && a.distToStop < 300 && a.freq !== "LOST") {
          this.scheduleCall(a, "ready", { rwy: a.depEnd.name }, "TWR", this.t + 20);
        } else if (done && s === "lineup") {
          a.state = "lining";
        }
      } else if (s === "holding" && this.t >= a.callAt) {
        if (a.rwyChanged) this.call(a, "stillWaitingGeneric", { what: `holding point runway ${a.depEnd.name}, we understand the runway has changed, request taxi to runway ${this.depEnd.name}`, greet: "" }, "TWR");
        else if (this.hotExpired(a)) this.call(a, "stillWaitingGeneric", { what: `holding point runway ${a.depEnd.name}, our holdover time has expired, request taxi back for de-icing`, greet: "" }, "TWR");
        else this.call(a, "stillWaitingGeneric", { what: `holding point runway ${a.depEnd.name}, ready for departure`, greet: "" }, "TWR");
        a.callAt = this.t + 120;
      } else if (s === "cond_lineup") {
        if (this.condMet(a)) { a.cond = null; this.lineUp(a, !!a.condTakeoff); }
      } else if (s === "lining") {
        // align with the runway centreline (an immediate takeoff rolls as soon as it is roughly straight)
        const e = a.depEnd;
        const d = angDiff(a.hdg, e.hdg);
        a.hdg = (a.hdg + Math.sign(d) * Math.min(Math.abs(d), 30 * dt) + 360) % 360;
        const cross = (a.pos[0] - e.pos[0]) * e.v[1] - (a.pos[1] - e.pos[1]) * e.v[0];
        const sh = Math.sign(cross) * Math.min(Math.abs(cross), 6 * dt);
        a.pos = [a.pos[0] - e.v[1] * sh, a.pos[1] + e.v[0] * sh];
        if ((Math.abs(d) < 1 && Math.abs(cross) < 0.5) || (a.toClr && a.immediate && Math.abs(d) < 12 && Math.abs(cross) < 4)) {
          a.hdg = e.hdg; a.state = a.toClr ? "roll" : "lined_up";
          if (a.state === "roll" && this.departureBlocked(a)) a.state = "lined_up";
          if (a.state === "roll") this.startRoll(a);
        }
      } else if (s === "lined_up" && a.toClr && a.heldForTraffic) {
        // A3: cleared for takeoff but held for traffic on the runway / short final: go once it is clear
        if (!this.departureBlocked(a)) { a.heldForTraffic = false; this.startRoll(a); }
      } else if (s === "roll" || s === "airborne") {
        this.takeoffMove(a, dt);
      } else if (s === "rto" || s === "broken" || s === "towed" || s === "deicing") {
        /* handled by the ops / events ticks */
      }
    } else if (a.kind === "ovf") {
      if (!this.tcasControls(a, dt) && a.cfl && Math.abs(a.cfl - a.alt) > 1) a.alt += Math.sign(a.cfl - a.alt) * Math.min(Math.abs(a.cfl - a.alt), 1500 / 60 * dt);
      a.pos = [a.pos[0] + Math.sin(a.hdg * Math.PI / 180) * a.spd * dt, a.pos[1] + Math.cos(a.hdg * Math.PI / 180) * a.spd * dt];
      if (this.t >= a.callAt && !a.calledIn) { a.calledIn = true; this.call(a, "overflight", { cfl: `flight level ${a.alt / 100}` }, "CTR"); }
      if (Math.hypot(...a.pos) > 45 * NM) a.gone = true;
    } else {
      if (s === "star") {
        this.starMove(a, dt);
      } else if (s === "final" || s === "goaround") {
        this.approachMove(a, dt);
      } else if (s === "rollout") {
        this.rolloutMove(a, dt);
      } else if (s === "vacating" || s === "taxi") {
        let done = this.followPath(a, dt);
        // vacating route reached another runway's holding point: we are clear of ours, stop here
        if (s === "vacating" && !done && a.atStop && a.blockedRwy !== a.end.rwy && a.spd === 0) {
          a.path = a.path.slice(0, a.pi); done = true; a.blockedRwy = null;
        }
        if (done) {
          if (s === "vacating") {
            a.state = "vacated"; a.crossOk.clear(); a.callAt = this.t + 60;
            if (this.split && this.hasPos("GND") && a.freq !== "GND") this.call(a, "vacated", { exit: a.exitName, greet: "" }, "TWR");
            else this.call(a, "vacatedTaxi", { exit: a.exitName, greet: "" }, "GND");
          } else if (a.taxiTo === "stand") {
            this.parkAt(a);
          } else {
            a.state = "holding_short";
            this.call(a, "holdingShort", { rwy: a.holdRwyName }, "GND");
          }
        }
      } else if (s === "vacated" && this.t >= a.callAt) {
        this.call(a, "stillWaitingGeneric", { what: `request taxi to stand ${a.stand ? a.stand.name : ""}`, greet: "" }, "GND");
        a.callAt = this.t + 120;
      } else if (s === "parked" && this.t - a.parkedAt > 45) {
        if (!a.counted) { a.counted = true; this.stats.arrivals++; }
        if (this.t - a.parkedAt > rint(1500, 2400)) this.turnaround(a);
      }
    }
    // generic: stopped at a runway crossing while taxiing
    if ((a.state === "taxi" || a.state === "lineup") && a.atStop && a.spd < 0.1 && !a.calledHold) {
      a.calledHold = true;
      const r = this.apt.runways[a.blockedRwy];
      a.holdRwyName = r.label;
      a.reqAt = this.t;
      if (!a.leader) this.call(a, "holdingShort", { rwy: r.label }, "GND");   // behind a follow-me the car calls
    }
    if (a.removeAt && this.t >= a.removeAt) a.gone = true;
  }

  /** The aircraft is on its stand. */
  parkAt(a) {
    a.state = "parked"; a.parkedAt = this.t; a.xpdr = "S"; a.spd = 0; a.onGround = true; a.alt = 0; a.tcas = null;
    if (a.stand) { a.pos = [...a.stand.pos]; a.hdg = a.stand.hdg; }
    a.path = null; a.taxiTo = null; a.holdPos = false;
    if (a.leader) { a.leader = null; }
    a.crossOk.clear();
  }

  // ---------- light signals (ICAO Annex 2, Appendix 1) ----------
  /**
   * Apply a light-gun signal. Returns a short description of the effect (for the log / tests), or null when
   * the signal means nothing in this situation.
   *   ground: green flashing = cleared to taxi · green steady = cleared for takeoff · red steady = stop
   *           red flashing = taxi clear of the landing area · white flashing = return to the starting point
   *   air:    green steady = cleared to land · green flashing = return for landing · red steady = give way,
   *           continue circling (go around) · red flashing = aerodrome unsafe, do not land
   */
  applyLight(a, color, mode) {
    let effect = null;
    if (a.onGround) {
      if (color === "green" && mode === "flashing") effect = this.lightTaxi(a);
      else if (color === "green" && mode === "steady") {
        if (a.kind === "dep" && ["holding", "lined_up", "lineup", "lining", "taxi"].includes(a.state) && a.depEnd) {
          a.toClr = true;
          if (a.state === "lined_up") this.startRoll(a); else if (a.state === "holding" || a.state === "taxi") this.lineUp(a, true);
          effect = "cleared for takeoff";
        }
      } else if (color === "red" && mode === "steady") { a.holdPos = true; if (a.leader) a.leader.holdPos = true; effect = "stop"; }
      else if (color === "red" && mode === "flashing") effect = this.lightClearRunway(a);
      else if (color === "white" && mode === "flashing") effect = this.lightReturn(a);
    } else if (a.kind === "arr" && (a.state === "final" || a.state === "circuit" || a.state === "goaround")) {
      if (color === "green" && mode === "steady") { if (a.state === "final") { a.landClr = true; effect = "cleared to land"; } else { a.landClr = true; effect = "cleared to land (will land from the circuit)"; } }
      else if (color === "green" && mode === "flashing") { a.rejoin = true; effect = "return for landing"; }
      else if (color === "red") {
        if (a.state === "final") { a.rejoin = mode === "steady"; this.goAround(a, "instructed"); effect = mode === "steady" ? "go around, continue circling" : "go around, aerodrome unsafe"; }
        else effect = "continue circling";
        if (mode === "flashing") a.divert = true;
      }
    }
    this.lightLog.push({ t: this.t, cs: a.cs, color, mode, effect });
    this.onEvent({ type: "light", ac: a, color, mode, effect });
    return effect;
  }

  lightTaxi(a) {
    if (a.holdPos) { a.holdPos = false; if (a.leader) a.leader.holdPos = false; return "continue taxi"; }
    if (a.atStop && a.blockedRwy != null) {
      a.crossOk.add(a.blockedRwy); a.calledHold = false;
      if (a.leader) a.leader.crossOk.add(a.blockedRwy);
      return `cross runway ${this.apt.runways[a.blockedRwy].label}`;
    }
    if (a.kind === "arr" && ["vacated", "holding_short", "rollout"].includes(a.state)) {
      if (!a.stand) a.stand = rnd(this.freeStands()) || null;
      if (!a.stand) return null;
      const start = this.startNode(a);
      const route = this.apt.routeToPos(start.node, a.stand.pos, [], start.avoid) || this.apt.routeToPos(start.node, a.stand.pos, []);
      if (!route) return null;
      this.setPath(a, route); a.state = "taxi"; a.taxiTo = "stand"; a.holdPos = false; a.viaText = "";
      return `taxi to stand ${a.stand.name}`;
    }
    if (a.kind === "dep" && a.onGround) {
      if (["parked", "clr_req", "cleared", "push_req"].includes(a.state)) {
        if (!a.ga) { this.planPush(a, null); a.state = "pushing"; a.autoTaxi = true; return "push back and taxi"; }
      }
      if (["pushed", "taxi_req", "parked", "clr_req", "cleared"].includes(a.state)) {
        const start = this.startNode(a);
        const route = this.apt.routeToRunway(start.node, this.depEnd, [], start.avoid) || this.apt.routeToRunway(start.node, this.depEnd, []);
        if (!route) return null;
        a.depEnd = this.depEnd; this.setPath(a, route); a.state = "taxi"; a.holdPos = false; a.viaText = ""; a.taxiTo = null;
        return `taxi to holding point runway ${this.depEnd.name}`;
      }
      if (a.state === "taxi") { a.holdPos = false; return "continue taxi"; }
    }
    return null;
  }

  /** Red flashing on the ground: get off the runway. */
  lightClearRunway(a) {
    const r = this.apt.runways.find(R => this.apt.onRunway(a.pos, R, 5));
    if (r) {
      const near = [...this.apt.rwyNodes[r.id]].map(n => [n, dist(this.apt.nodes[n], a.pos)]).sort((x, y) => x[1] - y[1]);
      for (const [n] of near) {
        const route = this.apt.exitRoute(n, r.id, null);
        if (!route) continue;
        a.path = [[...a.pos, null], ...route.map(k => [...this.apt.nodes[k], k])]; a.pi = 1;
        a.crossOk.add(r.id); a.toClr = false; a.holdPos = false;
        a.state = "vacating"; a.end = a.end || a.depEnd || r.ends[0]; a.exitName = "";
        if (a.kind === "dep") { a.kind = "dep"; a.vacateToHold = true; }
        return `vacate runway ${r.label}`;
      }
      return null;
    }
    a.holdPos = true;
    return "hold clear of the runway";
  }

  /** White flashing: return to the starting point (a departure goes back to its stand). */
  lightReturn(a) {
    if (!a.onGround) return null;
    let st = a.stand || (a.standName && this.apt.stands.find(s => s.name === a.standName)) || null;
    if (!st || this.ac.some(o => o !== a && o.onGround && o.stand === st && o.state === "parked")) st = rnd(this.freeStands()) || st;
    if (!st) return null;
    a.stand = st;
    const start = this.startNode(a);
    const route = this.apt.routeToPos(start.node, st.pos, [], start.avoid) || this.apt.routeToPos(start.node, st.pos, []);
    if (!route) return null;
    this.setPath(a, route); a.state = "taxi"; a.taxiTo = "stand"; a.holdPos = false; a.toClr = false; a.viaText = "";
    return `return to stand ${st.name}`;
  }

  // ---------- visual circuit (NORDO rejoin, VFR circuits, go-around rejoins) ----------
  /**
   * Fly a rectangular circuit around runway end `end` and rejoin final at `joinNm`.
   * side: "left" | "right" (direction of the turns), altFt: circuit altitude.
   */
  startCircuit(a, end, opts = {}) { a.extTold = false; a.orbitTold = false; return this.startCircuitNow(a, end, opts); }
  startCircuitNow(a, end, { side = "left", joinNm = a.ga ? 2.5 : 4, altFt = a.ga ? 1000 : 1500, widthM = a.ga ? 2000 : 3300 } = {}) {
    const v = end.v, n = side === "right" ? [v[1], -v[0]] : [-v[1], v[0]];
    const len = this.apt.runways[end.rwy].len, thr = end.thr, joinM = joinNm * NM;
    const P = (along, out) => [thr[0] + v[0] * along + n[0] * out, thr[1] + v[1] * along + n[1] * out];
    a.wps = [
      { p: P(len + 700, widthM * 0.25), leg: "crosswind" },
      { p: P(len + 200, widthM), leg: "downwind" },
      { p: P(-1.0 * NM, widthM), leg: "late downwind" },
      { p: P(-joinM, widthM), leg: "base" },                   // a rectangle: the downwind never slants towards final
      { p: P(-joinM, 0), leg: "final" },
    ];
    a.wpi = 0; a.circuitLeg = "upwind"; a.circuitAlt = altFt; a.circuitSpd = (a.ga ? 90 : 170) * KT;
    a.end = end; a.state = "circuit"; a.onGround = false; a.landClr = false; a.calledIn = false; a.toClr = false;
    a.circuitSide = side; a.circuitStart = this.t; a.circuitFrom = [...a.pos];
    return a.wps;
  }

  /** A jet on (or about to be on) final behind which a circuit aircraft must not turn base. */
  jetBehind(a) {
    const along = Math.max(0, -((a.pos[0] - a.end.thr[0]) * a.end.v[0] + (a.pos[1] - a.end.thr[1]) * a.end.v[1]));
    return this.ac.filter(o => o !== a && o.kind === "arr" && !o.ga && !o.onGround && ["final", "star", "inbound"].includes(o.state) && o.end && o.end.name === a.end.name &&
      this.distToThr(o) > along - 0.8 * NM && this.distToThr(o) < along + 5 * NM).sort((x, y) => this.distToThr(x) - this.distToThr(y))[0] || null;
  }

  circuitMove(a, dt) {
    const wp = a.wps && a.wps[a.wpi];
    if (!wp) { this.joinFinal(a); return; }
    // "extend downwind, I'll call your base": straight on along the downwind until the traffic has passed
    // turning base in front of a jet on final is never done: wait for it (the pilot sees it, the Tower says so)
    if (!a.baseAfter && wp.leg === "base" && a.end && !a.nordo) {
      const j = this.jetBehind(a);
      if (j) {
        a.baseAfter = j; a.baseAfterT = this.t;
        if (this.split && this.positions.TWR && !this.userWorks("TWR")) (this.pendingAtc ||= []).push({ pos: a.freq, ac: a, at: this.t + 1,
          text: `${a.cs}, extend downwind, I'll call your base, traffic ${atcType(j.type)} on ${Math.max(1, Math.round(this.distToThr(j) / NM))} mile final`, rb: "extending downwind" });
      }
    }
    const jet = a.baseAfter;
    if (jet && wp.leg === "base") {
      const along = -((a.pos[0] - a.end.thr[0]) * a.end.v[0] + (a.pos[1] - a.end.thr[1]) * a.end.v[1]);
      let passed = !this.ac.includes(jet) || jet.onGround || !["final", "star", "inbound"].includes(jet.state) || this.distToThr(jet) < Math.max(0, along) - 2 * NM;
      if (passed && !a.nordo) {                                        // the next one behind it: wait for that too
        const next = this.jetBehind(a);
        if (next && next !== jet) { a.baseAfter = next; passed = false; }
      }
      // waited long: give up only when the jet is still far out
      if (!passed && (this.t - (a.baseAfterT || this.t) < 300 || this.distToThr(jet) < along + 4 * NM)) {
        if (along > 3 * NM || a.orbitDir) {
          // never further out towards the jet: orbit on the outside of the downwind until it has passed
          if (!a.orbitDir) {
            const out = [a.pos[0] - (a.end.thr[0] - a.end.v[0] * along), a.pos[1] - (a.end.thr[1] - a.end.v[1] * along)];
            a.orbitDir = (((hdgOf(out[0], out[1]) - a.hdg + 540) % 360) - 180) >= 0 ? 1 : -1;
          }
          a.hdg = (a.hdg + a.orbitDir * 3 * dt + 360) % 360;
        } else {
          a.hdg = this.turnToward(a.hdg, (a.end.hdg + 180) % 360, dt, a.ga ? 4.5 : 3);
        }
        const v0 = vecFromHdg(a.hdg);
        a.pos = [a.pos[0] + v0[0] * a.spd * dt, a.pos[1] + v0[1] * a.spd * dt];
        if (!this.tcasControls(a, dt)) a.alt += Math.max(-800 / 60 * dt, Math.min(700 / 60 * dt, a.circuitAlt - a.alt));
        return;
      }
      a.baseAfter = null; a.orbitDir = null;
      // base turn where the aircraft now is; final abeam it
      const fin = a.wps[a.wpi + 1];
      wp.p = [...a.pos];
      if (fin) fin.p = [a.end.thr[0] - a.end.v[0] * Math.max(along, 1.2 * NM), a.end.thr[1] - a.end.v[1] * Math.max(along, 1.2 * NM)];
      if (!a.nordo && this.split && this.positions.TWR && !this.userWorks("TWR")) (this.pendingAtc ||= []).push({ pos: a.freq, ac: a, at: this.t + 1, text: `${a.cs}, turn base now, number 2, traffic passing`, rb: null });
    }
    const dx = wp.p[0] - a.pos[0], dy = wp.p[1] - a.pos[1], d = Math.hypot(dx, dy);
    a.hdg = this.turnToward(a.hdg, hdgOf(dx, dy), dt, a.ga ? 4.5 : 3);
    a.spd += Math.max(-2 * dt, Math.min(1.5 * dt, a.circuitSpd - a.spd));
    const want = a.circuitAlt;
    if (!this.tcasControls(a, dt)) a.alt += Math.max(-800 / 60 * dt, Math.min((a.ga ? 700 : 1500) / 60 * dt, want - a.alt));
    const v = vecFromHdg(a.hdg);
    a.pos = [a.pos[0] + v[0] * a.spd * dt, a.pos[1] + v[1] * a.spd * dt];
    // reached: close to it, or passed abeam it (so a wide turn never circles a waypoint for ever)
    const prev = a.wpi ? a.wps[a.wpi - 1].p : a.circuitFrom || a.pos;
    const lx = wp.p[0] - prev[0], ly = wp.p[1] - prev[1], ll = Math.hypot(lx, ly) || 1;
    const passed = ((wp.p[0] - a.pos[0]) * lx + (wp.p[1] - a.pos[1]) * ly) / ll < -50;
    if (d < Math.max(120, a.spd * 3.5) || passed || this.t - a.circuitStart > 900) {
      a.circuitLeg = wp.leg; a.wpi++;
      this.onEvent({ type: "circuitLeg", ac: a, leg: wp.leg });
      if (wp.leg === "downwind" && a.reports?.downwind !== false && !a.nordo && !a.circuitHold) this.call(a, "circuitReport", { leg: `${a.circuitSide === "right" ? "right " : ""}downwind${a.touchGo ? ", touch and go" : a.fullStop && a.circuits ? ", full stop" : ""}`, rwy: a.end.name, greet: "" }, "TWR");
      if (wp.leg === "base" && !a.nordo && a.reports?.base) this.call(a, "circuitReport", { leg: "base", rwy: a.end.name, greet: "" }, "TWR");
      if (a.wpi >= a.wps.length) {
        if (a.missed && a.onMissedEnd) { a.onMissedEnd(); return; }
        if (a.circuitHold && a.onCircuitEnd) { a.circuitHold = false; a.onCircuitEnd(); return; }
        if (a.state === "inbound") return;     // reached the reporting point: vfrInboundTick calls in and orbits there
        this.joinFinal(a);
      }
    }
  }

  /** Conditional clearance: is the traffic in the condition past? */
  condMet(a) {
    const c = a.cond;
    if (!c || !c.ac) return true;
    const o = c.ac;
    if (o.gone) return true;
    if (c.phase === "departing" || c.phase === "next") return o.state === "airborne" || !o.onGround || (o.state === "roll" && o.spd > 40 * KT);
    // landing / arriving: it has touched down and rolled past our entry (or vacated)
    if (o.kind === "arr") {
      if (["vacating", "vacated", "holding_short", "taxi", "parked"].includes(o.state)) return true;
      if (o.state === "rollout") {
        const e = o.end, along = (o.pos[0] - e.pos[0]) * e.v[0] + (o.pos[1] - e.pos[1]) * e.v[1];
        const mine = (a.pos[0] - e.pos[0]) * e.v[0] + (a.pos[1] - e.pos[1]) * e.v[1];
        return along > mine + 60;
      }
      return false;
    }
    return !o.onGround;
  }

  /** Find the traffic a condition refers to ("the landing A320", "Finnair 321"). */
  findSubject(a, cond, phase) {
    const sub = (cond.subject || "").toLowerCase().trim();
    const cands = this.ac.filter(o => o !== a && !o.veh && !o.gone);
    const generic = /^(the )?(traffic|aircraft|one|airplane|aeroplane)$/.test(sub);
    // a callsign ("Finnair 321", "Echo Bravo Charlie") names the traffic directly
    if (!generic && (/\d/.test(sub) || sub.split(" ").length >= 2)) { const p = parse(sub, cands, null); if (p.ac && p.explicit) return p.ac; }
    const words = sub.split(" ").filter(w => w.length > 2 && !["the", "that", "traffic", "aircraft"].includes(w));
    const typeMatch = (o) => { const t = spokenType(o.type).toLowerCase(); return (sub.includes(o.type.toLowerCase()) && o.type.length > 2) || words.some(w => t.includes(w) || (o.tel || "").toLowerCase().includes(w)); };
    const ph = cond.phase || phase || "";
    const rwy = a.depEnd || a.end || this.depEnd;
    if (ph === "departing" || ph === "next") {
      const deps = cands.filter(o => o.kind === "dep" && ["lined_up", "lining", "lineup", "roll", "holding", "cond_lineup"].includes(o.state) && (o.depEnd || rwy).rwy === rwy.rwy).sort((p, q) => (p.state === "roll" ? -1 : 1) - (q.state === "roll" ? -1 : 1));
      return deps.find(typeMatch) || deps[0] || null;
    }
    if (ph === "taxiing" || ph === "crossing" || ph === "preceding" || (!ph && a.onGround)) {
      const ground = cands.filter(o => o.onGround && ["taxi", "holding", "pushing", "pushed", "lineup", "vacating", "holding_short", "vacated", "cond_lineup", "lining", "lined_up"].includes(o.state)).sort((p, q) => dist(p.pos, a.pos) - dist(q.pos, a.pos));
      return ground.find(typeMatch) || ground[0] || null;
    }
    // landing / arriving: still airborne first (nearest to the threshold), then the one rolling out
    const air = cands.filter(o => o.kind === "arr" && o.state === "final" && o.end.rwy === rwy.rwy).sort((p, q) => this.distToThr(p) - this.distToThr(q));
    const roll = cands.filter(o => o.kind === "arr" && o.state === "rollout" && o.end.rwy === rwy.rwy);
    const finals = [...air, ...roll];
    return finals.find(typeMatch) || finals[0] || null;
  }

  /** A lit stop bar on the path before the runway? */
  litBarAhead(a) {
    const p = a.path;
    if (!p) return null;
    for (let j = Math.max(0, a.pi - 1); j < p.length - 1; j++) {
      const n1 = p[j][2], n2 = p[j + 1][2];
      if (n1 == null || n2 == null) continue;
      const bar = this.apt.stopBarOnEdge(n1, n2);
      if (bar && bar.lit) return bar;
      const here = j === a.pi - 1 && dist(a.pos, p[j]) < 10 ? this.apt.stopBarAtNode(n1) : null;
      if (here && here.lit) return here;
    }
    return null;
  }

  joinFinal(a) {
    const e = a.end;
    const d = Math.max(2.0 * NM, this.distToThr(a));
    a.pos = [e.thr[0] - e.v[0] * d, e.thr[1] - e.v[1] * d];
    a.hdg = e.hdg; a.state = "final"; a.kind = "arr"; a.onGround = false;
    a.alt = Math.min(a.alt, this.glideAlt(a)); a.spd = a.appSpd || a.spd;
    a.calledIn = false; a.callAt = this.t + 2; a.wps = null; a.circuitLeg = null;
    if (!a.nordo) { a.calledIn = true; this.call(a, "finalReport", { rwy: e.name, greet: "", dist: Math.max(2, Math.round(d / NM)) }, "TWR"); }
    this.onEvent({ type: "joinedFinal", ac: a });
  }

  // ---------- ground vehicles ----------
  homeNat() { return controllerNat(this.apt.icao); }
  /** Where vehicles live: a taxi node near the apron centroid that is not a stand and not in a runway zone. */
  vehicleBase() {
    if (this._vehBase != null) return this._vehBase;
    const c = this.apt.towerPos();
    this._vehBase = this.apt.nearestNode(c, i => !this.apt.nodeStand.has(i) && !this.apt.adj[i].some(o => o.e.runway || o.e.zones.size));
    return this._vehBase;
  }

  spawnVehicle({ vtype = "followme", cs, tel, num, pos, freq = "GND", maxSpd = 11 } = {}) {
    const n = (this.vehNo[vtype] = (this.vehNo[vtype] || 0) + 1);
    const NAMES = { followme: ["FOLLOWME", "Follow-me"], tug: ["TUG", "Tug"], fire: ["RESCUE", "Rescue"], ops: ["OPS", "Ops"],
      snow: ["SNOW", "Snow"], fuel: ["FUEL", "Fuel"], bus: ["BUS", "Bus"], catering: ["CATERING", "Catering"], baggage: ["BAGGAGE", "Baggage"] };
    const [pre, t] = NAMES[vtype] || [vtype.toUpperCase(), vtype];
    const nat = this.homeNat();
    const v = {
      id: nextId++, kind: "veh", veh: true, vtype, cs: cs || `${pre}${num ?? n}`, tel: tel || t, num: String(num ?? n), type: vtype.toUpperCase(),
      wtc: "L", pos: [...(pos || this.apt.towerPos())], hdg: 0, spd: 0, alt: 0, onGround: true, state: "idle", crossOk: new Set(), log: [],
      freq: this.split ? freq : "ALL", maxSpd, other: ["", ""], ga: false, squawk: "", xpdr: "O", ifr: false, nat,
      crew: makeCrew(nat), style: { ...makeStyle(this.region, nat), chatty: 0.15 },
    };
    v.voice = { pitch: v.crew[0].pitch, rate: v.crew[0].rate, idx: v.crew[0].seed };
    this.ac.push(v);
    this.onEvent({ type: "spawn", ac: v });
    return v;
  }

  /** Dispatch the follow-me car to aircraft `a`; it leads the aircraft to its stand. */
  sendFollowMe(a) {
    if (a.followMe && !a.followMe.gone) return a.followMe;
    const base = this.vehicleBase();
    if (base == null || base < 0) return null;
    const v = this.spawnVehicle({ vtype: "followme", pos: this.apt.nodes[base], freq: ["GND", "TWR"].includes(a.freq) ? a.freq : "GND" });
    v.target = a; v.targetCs = a.cs; a.followMe = v;
    const start = this.startNode(a, true);
    const route = this.apt.routeNodes(base, start.node) || this.apt.routeToPos(base, a.pos, []);
    if (!route) { v.gone = true; return null; }
    this.setPath(v, route); v.state = "toAircraft";
    this.onEvent({ type: "followMeSent", ac: a, veh: v });
    return v;
  }

  updateVehicle(v, dt) {
    const t = v.target;
    if (v.state === "idle") return;
    if (v.state === "roam") { this.roam(v, dt); return; }
    if (v.pauseUntil && this.t < v.pauseUntil) { v.spd = 0; return; }   // told to stop / waiting
    if (v.state === "toAircraft") {
      const done = this.followPath(v, dt);
      this.vehicleHoldCall(v);
      if (!t || t.gone) { this.vehicleHome(v); return; }
      if (done || dist(v.pos, t.pos) < 60) {
        const st = t.stand || (t.standName && this.apt.stands.find(s => s.name === t.standName)) || rnd(this.freeStands()) || null;
        if (!st) { this.vehicleHome(v); return; }
        t.stand = st; v.standTo = st.name;
        const vs = this.startNode(v), as = this.startNode(t);
        const vroute = this.apt.routeToPos(vs.node, st.pos, [], vs.avoid) || this.apt.routeToPos(vs.node, st.pos, []);
        const aroute = this.apt.routeToPos(as.node, st.pos, [], as.avoid) || this.apt.routeToPos(as.node, st.pos, []);
        if (!vroute || !aroute) { this.vehicleHome(v); return; }
        this.setPath(v, vroute); v.state = "leading"; v.crossOk = new Set();
        this.setPath(t, aroute); t.state = "taxi"; t.taxiTo = "stand"; t.holdPos = false; t.leader = v; t.crossOk = new Set(); t.calledHold = false;
        this.onEvent({ type: "followMe", ac: t, veh: v });
      }
      return;
    }
    if (v.state === "leading") {
      if (!t || t.gone) { this.vehicleHome(v); return; }
      v.holdPos = dist(v.pos, t.pos) > 110;         // wait for the aircraft
      const done = this.followPath(v, dt);
      if (t.leader === v) for (const r of v.crossOk) t.crossOk.add(r);
      this.vehicleHoldCall(v);
      if (done) {
        v.state = "aside";
        const h = (t.stand ? t.stand.hdg : v.hdg) + 90, vv = vecFromHdg(h);
        v.path = [[v.pos[0] + vv[0] * 30, v.pos[1] + vv[1] * 30, null]]; v.pi = 0; v.holdPos = false; v.blockedRwy = null;
      }
      return;
    }
    if (v.state === "aside") {
      this.followPath(v, dt);
      if (!t || t.gone || t.state === "parked") { if (t) t.leader = null; this.vehicleHome(v); }
      return;
    }
    if (v.state === "home") { if (this.followPath(v, dt)) v.gone = true; return; }
    if (v.state === "task") { if (this.followPath(v, dt) && v.onDone) v.onDone(v); this.vehicleHoldCall(v); return; }
  }

  vehicleHome(v) {
    v.target = null; v.holdPos = false; v.state = "home";
    const base = this.vehicleBase();
    const s = this.startNode(v);
    const r = base != null && base >= 0 ? this.apt.routeNodes(s.node, base) : null;
    if (r && r.length > 1) this.setPath(v, r); else v.gone = true;
  }

  /** A vehicle stopped short of a runway asks to cross (with the aircraft it leads, if any). */
  vehicleHoldCall(v) {
    if (v.atStop && v.spd < 0.1 && v.blockedRwy != null && !v.calledHold) {
      v.calledHold = true;
      const r = this.apt.runways[v.blockedRwy];
      v.holdRwyName = r.label; v.reqAt = this.t;
      this.call(v, "vehHold", { rwy: r.label, ac: v.target && v.target.leader === v ? this.cs(v.target).d : "" }, "GND");
    }
  }

  /** Transponder mode follows the phase of flight (Europe: mode C from line-up; US: from taxi). */
  transponder(a) {
    if (a.nordo || a.mayday || a.ga || a.veh) return;
    const s = a.state;
    if (a.kind === "dep") {
      const on = ["lining", "lined_up", "lineup", "roll", "airborne"].includes(s) || (this.region === "US" && s === "taxi");
      a.xpdr = on ? "C" : "S";
    }
    if (a.identUntil && this.t > a.identUntil) a.identUntil = null;
  }

  /** Radar label warnings like a real system: missing mode C, wrong code, duplicate code, emergencies. */
  labelWarnings(a) {
    const w = [];
    if (a.veh) return w;
    if (a.squawk === "7600") w.push("RCF");
    if (a.squawk === "7500") w.push("HIJ");
    if (a.squawk === "7700") w.push("EMG");
    if (!a.onGround && a.xpdr !== "C" && !a.human) w.push("NO MODE C");
    if (a.assignedSq && a.squawk !== a.assignedSq && !["7600", "7700"].includes(a.squawk)) w.push("SQK " + a.assignedSq);
    if (a.squawk && !["7000", "1200", "2000", "7600", "7700"].includes(a.squawk) &&
      this.ac.some(o => o !== a && o.squawk === a.squawk)) w.push("DUP");
    if (a.identUntil) w.push("ID");
    if (a.blockedBy) w.push(`BLOCKED BY ${a.blockedBy}`);
    if (a.human && a.stale) w.push("STALE");
    return w;
  }

  // ---------- handoffs ----------
  doSwitch(a) {
    const to = a.switchTo;
    a.switchAt = null; a.switchTo = null;
    if (!to) return;
    a.prevFreq = a.freq;
    if (to.lost) {
      a.freq = "LOST"; a.lostFreq = to.freq; a.lostUntil = this.t + rint(25, 35);
      return;
    }
    a.freq = to.key;
    if (a.prevFreq === "TWR" && a.kind === "dep" && !a.onGround) a.handedOff = true;
    a.checkInAt = this.t + rint(3, 8);
    // the strip follows the aircraft: the receiving position accepts it (an AI position after a moment)
    if (this.split && this.positions && this.positions[to.key] && a.prevFreq !== to.key) {
      a.handoff = { from: a.prevFreq, to: to.key, t: this.t, accepted: false };
      this.onEvent({ type: "handoff", ac: a, from: a.prevFreq, to: to.key });
    }
    // the first call on the new frequency is predictable: render it now
    if (!a.nordo && a.kind === "dep" && to.key === "GND" && ["cleared", "parked"].includes(a.state)) this.scheduleCall(a, "push", {}, "GND", a.checkInAt);
  }

  /** The receiving position takes the strip (F1). */
  acceptHandoff(a, by = "") {
    if (!a.handoff || a.handoff.accepted) return false;
    a.handoff.accepted = true; a.handoff.by = by; a.handoff.acceptedAt = this.t;
    this.stats.handoffs = (this.stats.handoffs || 0) + 1;
    this.onEvent({ type: "handoffAccepted", ac: a, to: a.handoff.to, by });
    return true;
  }
  /** Every second: AI positions accept their incoming strips; an unanswered human handoff is flagged. */
  handoffTick() {
    for (const a of this.ac) {
      const h = a.handoff;
      if (!h || h.accepted) continue;
      const human = this.userWorks(h.to) && !(this.remoteStaff && this.remoteStaff[h.to] === null);
      if (!human) { if (this.t - h.t > rint(2, 6)) this.acceptHandoff(a, "AI"); continue; }
      if (this.t - h.t > 45 && !h.flagged) { h.flagged = true; this.alert(`Handoff of ${a.cs} to ${h.to} not accepted for 45 s.`, "ho" + a.cs, false); }
    }
  }

  /** First call on a new frequency. */
  checkIn(a) {
    const f = a.freq, s = a.state;
    const altTxt = () => `${Math.max(100, Math.round(a.alt / 100) * 100)} feet`;
    const cflTxt = () => a.cfl >= 6000 ? `flight level ${Math.round(a.cfl / 100)}` : `${a.cfl} feet`;
    if (a.kind === "dep") {
      if (f === "GND" && ["cleared", "parked"].includes(s)) { this.callPrepared(a, "push", {}, "GND"); a.state = "push_req"; a.callAt = this.t + 150; }
      else if (f === "GND" && s === "pushed") { this.call(a, "taxi", {}, "GND"); a.state = "taxi_req"; }
      else if (f === "TWR" && s === "holding") { this.call(a, "ready", {}, "TWR"); a.callAt = this.t + 120; }
      else if (f === "TWR" && s === "taxi") { this.call(a, "approachingHold", {}, "TWR"); a.calledReadyEarly = true; }
      else if ((f === "APP" || f === "CTR") && !a.onGround) this.call(a, "departureInitial", { alt: altTxt(), cfl: cflTxt() }, f);
    } else if (a.kind === "arr") {
      if (f === "TWR" && s === "final") this.call(a, a.ga ? "gaFinal" : "established", { dist: Math.max(2, Math.round(this.distToThr(a) / NM)) }, "TWR");
      else if (f === "GND") { this.call(a, "groundArrival", { exit: a.exitName }, "GND"); a.callAt = this.t + 120; }
      else if (f === "APP") this.call(a, "approachInitial", { alt: altTxt() }, "APP");
    } else if (a.kind === "ovf") {
      this.call(a, "overflight", { cfl: `flight level ${a.alt / 100}` }, "CTR");
    }
  }

  // ---------- movement ----------
  /** Index j such that the aircraft must stop at path[j] (not enter edge j->j+1); or path.length-1. */
  stopIndex(a) {
    const p = a.path;
    for (let j = Math.max(0, a.pi - 1); j < p.length - 1; j++) {
      // "hold short of taxiway X": stop at the intersection
      if (a.holdShortIdx != null && j >= a.holdShortIdx) return { j: a.holdShortIdx, rwy: null, twy: a.holdShortTwy };
      const n1 = p[j][2], n2 = p[j + 1][2];
      // a lit stop bar is never crossed, clearance or not (stop at the bar's node, or before a mid-segment bar);
      // a bar at the node we are standing on counts too, but not one we have already rolled past
      if (n1 != null && n2 != null) {
        const bar = this.apt.stopBarOnEdge(n1, n2);
        if (bar && bar.lit) return { j: bar.node === n2 ? j + 1 : j, rwy: bar.rwy, bar };
        const here = j === a.pi - 1 && dist(a.pos, p[j]) < 10 ? this.apt.stopBarAtNode(n1) : null;
        if (here && here.lit) return { j, rwy: here.rwy, bar: here };
      }
      const z = this.edgeZones(p, j), zPrev = j > 0 ? this.edgeZones(p, j - 1) : new Set();
      // low visibility: hold at the CAT II/III holding position, further back than the normal one
      if (this.lvp && n2 != null && !a.onRunway) {
        for (const h of this.apt.ilsHolds) {
          if (dist(h.p, p[j + 1]) < 25) {
            const r = this.apt.nearestRunway(h.p);
            if (r >= 0 && !a.crossOk.has(r) && !zPrev.has(r)) return { j: j + 1, rwy: r, cat: true };
          }
        }
      }
      for (const r of z) {
        if (zPrev.has(r)) continue;
        // A3/A10: a crossing / line-up clearance is not used while someone takes off, lands or is on the runway
        if (a.crossOk.has(r)) {
          // checked once at the bar; a crossing that has begun is finished, not stopped half-way
          if (!a.leader && !(a.crossGo && a.crossGo.has(r)) && this.crossDanger(a, r)) return { j, rwy: r, danger: true };
          if (dist(a.pos, p[j]) < 25) (a.crossGo ||= new Set()).add(r);       // committed only at the runway edge
          continue;
        }
        // a departure may pass through its own runway's zone (e.g. behind the threshold) if it leaves it again
        if (a.kind === "dep" && a.depEnd && r === a.depEnd.rwy && this.leavesZone(p, j, r) && !this.zoneTouchesRunway(p, j, r)) continue;
        return { j, rwy: r };
      }
    }
    return { j: p.length - 1, rwy: null };
  }
  /** Seconds this aircraft needs to cross runway `r` from where it is: the path through the runway's zone at taxi speed
   *  (a light aircraft is slow), plus the time to get going. */
  crossTime(a, r) {
    const p = a.path;
    if (!p || a.pi >= p.length) return 60;
    let d = 0, inZone = false, prev = a.pos;
    for (let k = Math.max(0, a.pi - 1); k + 1 < p.length; k++) {
      const z = this.edgeZones(p, k);
      d += dist(prev, p[k + 1]); prev = p[k + 1];
      if (z.has(r)) inZone = true;
      else if (inZone) break;
      if (d > 1500) break;
    }
    const v = Math.min(a.maxSpd || TAXI_SPD, a.ga || a.veh ? 5 : 8);
    return d / v + 12;
  }
  /** Lined up with a takeoff clearance: anyone on the runway ahead or landing within ~1.5 NM / 45 s holds the roll. */
  departureBlocked(a) {
    const d = this.runwayDanger(a.depEnd.rwy, a, { finalNm: 1.5, finalSec: 45 });
    if (!d.busy || (d.by && (d.by.state === "airborne" || (d.by.state === "roll" && d.by.spd > 40 * KT)))) return false;
    if (!a.heldForTraffic) {
      a.heldForTraffic = true;
      this.pilot(a, `${this.cs(a).d}, holding in position, ${d.why}`, "query");
    }
    return true;
  }
  /** B2: the reporting point a VFR departure leaves by: the one facing its direction ("VFR to the north"), else the
   *  nearest. Real points when the airport has them; the generic ones otherwise. */
  pickVfrExit(a) {
    const pts = this.vfrPoints();
    if (!pts.length) return null;
    const dir = { north: 0, east: 90, south: 180, west: 270 }[(String(a.other && a.other[1] || "").match(/north|east|south|west/) || [])[0]];
    // never out through the final approach of the runway in use (VFR traffic there flies into the arrivals)
    const fin = (this.arrEnd.hdg + 180) % 360;
    const ok = pts.filter(p => Math.abs(angDiff(hdgOf(...p.p), fin)) > 60);
    const list = ok.length ? ok : pts;
    if (dir == null) return list[Math.floor(Math.random() * list.length)];
    return list.reduce((b, p) => Math.abs(angDiff(dir, hdgOf(...p.p))) < Math.abs(angDiff(dir, hdgOf(...b.p))) ? p : b);
  }
  /** "report Bravo": the pilot calls when it gets there. */
  vfrReportTick(a) {
    if (!a.reports || a.onGround || a.nordo) return;
    for (const pt of this.vfrPoints()) {
      if (!a.reports[pt.name] || (a.reported && a.reported[pt.name])) continue;
      if (dist(a.pos, pt.p) < 800) { a.reported = { ...(a.reported || {}), [pt.name]: true }; this.pilot(a, `${this.cs(a).d}, ${pt.name}, ${Math.round(a.alt / 100) * 100} feet`, "report"); }
    }
  }
  crossDanger(a, r) {
    if (a.state === "vacating" || a.state === "rollout") return false;
    const own = a.kind === "dep" && a.depEnd && r === a.depEnd.rwy;
    const d = this.runwayDanger(r, a, own ? { finalNm: 1.5, finalSec: 45 } : { finalNm: 1.2, finalSec: this.crossTime(a, r) + 20 });
    if (!d.busy) return false;
    // lining up on our own runway behind traffic that is already rolling away (landing roll, takeoff) is fine
    if (a.kind === "dep" && a.depEnd && r === a.depEnd.rwy && d.by && ["roll", "airborne", "rollout", "vacating"].includes(d.by.state) && d.by.onGround !== false) {
      const v = a.depEnd.v, al = (q) => (q[0] - a.depEnd.thr[0]) * v[0] + (q[1] - a.depEnd.thr[1]) * v[1];
      if (al(d.by.pos) > al(a.pos) + 100 || d.by.state === "airborne") return false;
    }
    if (a.kind === "dep" && a.depEnd && r === a.depEnd.rwy && d.by && d.by.state === "airborne") return false;
    return true;
  }
  /** Does the path, from segment j through runway r's zone, run over the runway itself (a crossing, not a pass behind)? */
  zoneTouchesRunway(p, j, r) {
    const R = this.apt.runways[r];
    for (let k = j; k < p.length - 1; k++) {
      if (!this.edgeZones(p, k).has(r)) break;
      const a = p[k], b = p[k + 1];
      for (const f of [0.25, 0.5, 0.75, 1]) if (this.apt.onRunway([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f], R, 0)) return true;
    }
    return false;
  }
  leavesZone(p, j, r) {
    for (let k = j + 1; k < p.length - 1; k++) if (!this.edgeZones(p, k).has(r)) return true;
    return false;
  }
  edgeZones(p, j) {
    const n1 = p[j][2], n2 = p[j + 1][2];
    if (n1 == null || n2 == null) return new Set();
    return this.apt.zonesOf(n1, n2);
  }

  /** Move along a.path. Returns true when the end of the path is reached and stopped. */
  followPath(a, dt, reverse = false) {
    const p = a.path;
    if (!p || a.pi >= p.length) { a.spd = 0; return true; }
    const stop = reverse ? { j: p.length - 1, rwy: null } : this.stopIndex(a);
    a.blockedRwy = stop.j < p.length - 1 ? stop.rwy : null;
    a.atStop = a.blockedRwy != null && a.pi - 1 >= stop.j;
    if (a.blockedRwy == null) a.calledHold = false;
    // distance to stop point
    let dStop = 0, prev = a.pos;
    for (let k = a.pi; k <= stop.j; k++) { dStop += dist(prev, p[k]); prev = p[k]; }
    a.distToStop = dStop;
    let target = reverse ? PUSH_SPD : (a.maxSpd || TAXI_SPD);
    if (!reverse) {
      // slow for turns ahead
      let acc = dist(a.pos, p[a.pi]);
      for (let k = a.pi; k < Math.min(p.length - 1, a.pi + 4) && acc < 60; k++) {
        const h1 = hdgOf(p[k][0] - (k ? p[k - 1][0] : a.pos[0]), p[k][1] - (k ? p[k - 1][1] : a.pos[1]));
        const h2 = hdgOf(p[k + 1][0] - p[k][0], p[k + 1][1] - p[k][1]);
        if (Math.abs(angDiff(h1, h2)) > 35) { target = Math.min(target, TURN_SPD); break; }
        acc += dist(p[k], p[k + 1]);
      }
      if (a.holdPos) target = 0;
      target = Math.min(target, this.trafficLimit(a));
    }
    // brake for the stop point, creeping the last metre so the point is actually reached
    target = Math.min(target, dStop > 0 ? Math.max(0.4, Math.sqrt(2 * 0.9 * dStop)) : 0);
    a.spd += Math.max(-1.5 * dt, Math.min(0.6 * dt, target - a.spd));
    if (target === 0 && a.spd < 0.05) a.spd = 0;
    // a point the aircraft is already standing on is passed whatever its speed
    while (a.pi < p.length && dist(a.pos, p[a.pi]) < 0.01 && (reverse || a.pi - 1 < stop.j)) { a.pi++; this.onPassNode(a); }
    let s = a.spd * dt;
    while (s > 0 && a.pi < p.length) {
      if (!reverse && a.pi - 1 >= stop.j) break;
      const d = dist(a.pos, p[a.pi]);
      const mh = d > 0.01 ? hdgOf(p[a.pi][0] - a.pos[0], p[a.pi][1] - a.pos[1]) : null;
      if (mh !== null) a.hdg = reverse ? (mh + 180) % 360 : this.turnToward(a.hdg, mh, dt);
      if (s >= d) {
        a.pos = [p[a.pi][0], p[a.pi][1]]; s -= d; a.pi++;
        this.onPassNode(a);
      } else {
        a.pos = [a.pos[0] + (p[a.pi][0] - a.pos[0]) * s / d, a.pos[1] + (p[a.pi][1] - a.pos[1]) * s / d]; s = 0;
      }
    }
    if (reverse && a.pi >= p.length && a.pushFace != null) a.hdg = a.pushFace;
    return a.pi >= p.length && a.spd < 0.3;
  }

  /** Remaining path length (m). */
  remaining(a) {
    if (!a.path || a.pi >= a.path.length) return 0;
    let d = dist(a.pos, a.path[a.pi]);
    for (let k = a.pi; k < a.path.length - 1; k++) d += dist(a.path[k], a.path[k + 1]);
    return d;
  }

  turnToward(h, target, dt, rate = 90) {
    const d = angDiff(h, target);
    return (h + Math.sign(d) * Math.min(Math.abs(d), rate * dt) + 360) % 360;
  }

  onPassNode(a) {
    // crossing clearances expire once the runway zone is left
    const j = a.pi - 1, p = a.path;
    if (j <= 0 || j >= p.length - 1) return;
    const zIn = this.edgeZones(p, j - 1), zOut = this.edgeZones(p, j);
    for (const r of [...a.crossOk]) {
      if (zIn.has(r) && !zOut.has(r) && !(a.kind === "dep" && a.state === "lineup")) { a.crossOk.delete(r); if (a.crossGo) a.crossGo.delete(r); }
    }
  }

  startRoll(a) {
    a.state = "roll"; a.rollStart = this.t; a.incursionSeen = false;
    a.rollUsers = new Set(this.runwayUsers(a.depEnd.rwy, a).map(o => o.id));
    const prev = this.lastTakeoff;
    if (prev && prev.rwy === a.depEnd.rwy) {
      const need = wakeDepSeconds(prev, a, this.recat), gap = this.t - prev.t;
      if (need > 60 && gap < need) this.alert(`Wake turbulence: ${a.cs} (${a.wtc}) departed ${Math.round(gap)} s after ${prev.cs} (${prev.wtc}); ${Math.round(need / 60)} min required.`, "wake" + a.cs);
    }
    this.lastTakeoff = { t: this.t, wtc: a.wtc, cs: a.cs, type: a.type, rwy: a.depEnd.rwy };
    this.ctotCheck(a);
  }

  takeoffMove(a, dt) {
    const e = a.depEnd, v = e.v;
    const vr = a.appSpd * 1.1;
    if (a.state === "roll") {
      // A10: someone entered the runway ahead after the roll started -> reject below V1, continue above it
      const along = (q) => (q[0] - e.thr[0]) * v[0] + (q[1] - e.thr[1]) * v[1];
      const intruder = this.runwayUsers(e.rwy, a).find(o => !(a.rollUsers && a.rollUsers.has(o.id)) && along(o.pos) > along(a.pos) - 20);
      if (intruder && !a.incursionSeen) {
        a.incursionSeen = true;
        const by = intruder.human ? `pilot ${intruder.cs}` : intruder.veh ? `vehicle ${intruder.cs}` : `AI ${intruder.cs}`;
        this.atcError("incursion", { by, ac: intruder, text: `${intruder.cs} entered runway ${e.name} during ${a.cs}'s takeoff roll`, should: `"${intruder.cs}, hold position" / "stop immediately" before the holding point, and cancel the takeoff clearance in time` });
        if (a.spd < vr * 0.92) { this.rejectTakeoff(a, `runway incursion by ${intruder.cs}`); return; }
        this.alert(`${a.cs} above V1 — continuing the takeoff with ${intruder.cs} on the runway!`, "v1" + a.cs);
      }
      a.spd = Math.min(a.spd + 2.2 * dt, 250 * KT);
      if (a.spd >= vr) { a.state = "airborne"; a.onGround = false; this.stats.departures++; }
    } else {
      a.spd = Math.min(a.spd + 1.0 * dt, (this.split ? 250 : 220) * KT);
      const top = this.split ? a.cfl : Infinity;
      if (!this.tcasControls(a, dt) && a.alt < top) a.alt = Math.min(top, a.alt + (a.ga ? 700 : 2500) / 60 * dt);
      const onTwr = !this.split ? !a.handedOff : a.freq === "TWR" || a.freq === "ALL";
      if (a.wantCircuits && a.alt > 500 && !a.inCircuit) {   // VFR: stays in the circuit for touch-and-goes
        a.inCircuit = true; a.touchGo = true; a.fullStop = false; a.reports = { downwind: true, final: true }; a.circuits = 0;
        const gs = this.freeStands(["tie_down", "hangar", "misc", "gate"], true);
        if (gs.length) { a.stand = rnd(gs); a.stand.reserved = a; }
        this.startCircuit(a, e, { side: "left" });
        this.onEvent({ type: "circuitJoin", ac: a });
        return;
      }
      if (a.alt > (a.ga ? 1500 : 2500) && onTwr && !a.askedFreq) {
        a.askedFreq = true;
        this.call(a, "freqChange", { alt: `${Math.round(a.alt / 100) * 100} feet`, greet: "" }, "TWR");
      }
    }
    // B2: a VFR departure leaves the zone via its reporting point (real names when the airport has real points)
    if (a.state === "airborne" && a.ga && !a.wantCircuits && !a.inCircuit && a.alt > 300 && !a.navWps) {
      if (!a.vfrExit) a.vfrExit = this.pickVfrExit(a);
      if (a.vfrExit) a.navWps = [{ p: a.vfrExit.p, id: a.vfrExit.name }];
    }
    if (a.vfrExit && a.navWps && !a.vfrExitCalled && dist(a.pos, a.vfrExit.p) < 900) {
      a.vfrExitCalled = true;
      this.pilot(a, `${this.cs(a).d}, ${a.vfrExit.name}, ${Math.round(a.alt / 100) * 100} feet, leaving the zone`, "report");
    }
    // F4: once airborne the departure flies its real SID (or a "direct" it was given), else runway heading
    let route = null;
    if (a.state === "airborne" && !a.heliDep) {
      if (a.sidWps === undefined) a.sidWps = this.sidPath ? (this.sidPath(a) || []) : [];
      route = a.navWps || a.sidWps;
    }
    if (route && route.length && a.alt > 400) {
      const k = a.navWps ? "navI" : "sidI";
      a[k] = a[k] || 0;
      while (a[k] < route.length && dist(a.pos, route[a[k]].p) < 1500) a[k]++;
      if (a[k] < route.length) { const w = route[a[k]].p; a.hdg = this.turnToward(a.hdg, hdgOf(w[0] - a.pos[0], w[1] - a.pos[1]), dt, 3); }
    } else if (a.hdgHold != null && a.alt > 400) a.hdg = this.turnToward(a.hdg, a.hdgHold, dt, 3);
    else if (!route || !route.length || a.alt <= 400) a.hdg = e.hdg;
    const hv = vecFromHdg(a.hdg);
    a.pos = [a.pos[0] + hv[0] * a.spd * dt, a.pos[1] + hv[1] * a.spd * dt];
    if (!this.split) {
      if (a.alt > 5000 || dist(a.pos, e.pos) > 25000) {
        if (!a.handedOff) this.alert(`${a.cs} left your airspace without a frequency change.`, "ho" + a.cs, false);
        a.gone = true;
      }
    } else if (dist(a.pos, e.pos) > (a.ga ? 15000 : 40 * NM)) {
      const endPos = this.hasPos("CTR") ? "CTR" : this.hasPos("APP") ? "APP" : "TWR";
      if (a.freq !== endPos && !a.ga) this.alert(`${a.cs} left the area on ${a.freq} without being handed to ${endPos}.`, "ho" + a.cs, false);
      a.gone = true;
    }
  }

  approachMove(a, dt) {
    const e = a.end;
    const d = this.distToThr(a);
    if (a.state === "final") {
      if (this.t >= a.callAt && !a.calledIn) {
        a.calledIn = true;
        if (a.freq === "APP") this.call(a, "approachInitial", { alt: `${Math.round(a.alt / 100) * 100} feet` }, "APP");
        else this.call(a, a.ga ? "gaFinal" : "established", { dist: Math.max(2, Math.round(d / NM)) }, "TWR");
      }
      // left on approach frequency too long: ask for tower
      if (this.split && a.freq === "APP" && d < 7000 && !a.askedTwr && !a.switchAt) {
        a.askedTwr = true;
        this.call(a, "stillWaitingGeneric", { what: `established runway ${e.name}, request tower frequency`, greet: "" }, "APP");
      }
      if (!this.tcasControls(a, dt)) a.alt = this.arrAlt(a);
      // D3: an RA close in on final ends the approach: go around once the manoeuvre has started
      if (a.tcas && a.tcas.ra && d < 5 * NM && this.t - a.tcas.ra.t > 6 && !a.nordo) { this.goAround(a, "TCAS RA on final", "going around, TCAS RA"); return; }
      a.spd = this.split && !a.ga && d > 15000 ? Math.max(a.appSpd, 200 * KT - (46000 - d) * 0.0005) : a.appSpd;
      if (this.split && !a.ga && d <= 15000) a.spd = a.appSpd + Math.max(0, (d - 6000) / 9000) * 40 * KT;
      if (a.spdCap && d > (a.spdCapUntil || 0)) a.spd = Math.max(a.appSpd, Math.min(a.spd, a.spdCap));
      const occupied = this.runwayOccupants(e.rwy, a).length > 0;
      // "land after …": the clearance becomes effective once the preceding traffic is clear
      if (a.landAfter && !a.landClr && this.condMet({ cond: a.landAfter, pos: a.pos })) { a.landClr = true; a.landAfter = null; }
      // gusty wind: an occasional unstable approach
      const gust = this.wind && this.wind.gust ? this.wind.gust - (this.wind.spd || 0) : 0;
      if (gust > 12 && d < 2.5 * NM && d > 0.8 * NM && Math.random() < dt * 0.0025 * (gust - 10) && !a.nordo) { this.goAround(a, `gusts ${Math.round(gust)} kt, unstable approach`); return; }
      // A3: spacing behind whoever is ahead on this final (AI or real pilot), wake based; go around when it collapses
      const lead = this.leaderOnFinal(a);
      if (lead && !a.ga) {
        const need = this.wakeNm(lead.ac, a) * NM, gap = d - lead.d;
        if (gap < need + 0.5 * NM) a.spd = Math.max(a.appSpd * 0.92, Math.min(a.spd, lead.ac.spd || a.appSpd));
        if (gap < Math.min(need * 0.6, 2 * NM) && d < 4 * NM && d > 0.4 * NM && !a.nordo) {
          this.goAround(a, `too close behind ${lead.ac.cs}${lead.ac.human ? " (real pilot)" : ""}, ${(gap / NM).toFixed(1)} NM`, "going around, too close to the traffic ahead");
          return;
        }
      }
      // A10: the decision height (500 ft, 400 ft in poor visibility, 300 ft in LVP) with the runway still occupied
      const dh = this.lvp ? 300 : this.vis != null && this.vis < 5000 ? 400 : 500;
      if (a.landClr && !a.nordo && d > 0 && d < dh * FT / Math.tan(3 * Math.PI / 180)) {
        const occ = this.runwayDanger(e.rwy, a, { finalNm: 0, finalSec: 0 });
        if (occ.busy && !(occ.by && occ.by.state === "roll" && occ.by.spd > 60 * KT)) {
          const o = occ.by;
          this.atcError(o && o.human && !a.rwyQuery ? "incursion" : "landOccupied", { by: o && o.human && !a.rwyQuery ? `pilot ${o.cs}` : a.landClrBy || "you", ac: a,
            text: `${a.cs} went around at ${dh} ft: ${o ? o.cs + (o.human ? " (real pilot)" : o.veh ? " (vehicle)" : "") + " " : ""}${occ.why}`,
            should: `no landing clearance until the runway is vacated: "continue approach" / "land after", and send it around yourself in time ("${this.cs(a).d}, go around")` });
          this.goAround(a, `${occ.why}${o ? " (" + o.cs + ")" : ""} at the decision height`, "going around, traffic on the runway");
          return;
        }
      }
      const gaDist = a.contApp ? 300 : 600;
      if (d < gaDist && ((!a.landClr && !a.nordo) || occupied || this.closedRunways.has(e.rwy))) {
        this.goAround(a, this.closedRunways.has(e.rwy) ? "runway closed" : a.landClr || a.nordo ? "runway occupied" : a.freq !== "TWR" && this.split ? `no landing clearance (still on ${a.freq})` : "no landing clearance");
        return;
      }
      a.pos = [a.pos[0] + e.v[0] * a.spd * dt, a.pos[1] + e.v[1] * a.spd * dt];
      if (d < -350) {
        if (a.touchGo) { this.goAgain(a); return; }
        a.state = "rollout"; a.onGround = true; a.alt = 0; a.crossOk.add(e.rwy); a.contApp = false;
        if (a.landClr) this.stats.landings = (this.stats.landings || 0) + 1;
      }
    } else {
      if (!this.tcasControls(a, dt)) a.alt += 1800 / 60 * dt;
      a.spd = Math.min(a.spd + 1 * dt, 180 * KT);
      a.pos = [a.pos[0] + e.v[0] * a.spd * dt, a.pos[1] + e.v[1] * a.spd * dt];
      if (a.rejoin && a.alt > (a.ga ? 900 : 1400)) { a.rejoin = false; this.startCircuit(a, e); }
      else if (!a.rejoin && a.alt > 1400 && !a.missed && this.flyMissed(a)) { /* flying the published missed approach */ }
      else if (!a.rejoin && a.alt > 3000) a.gone = true;
    }
  }

  goAround(a, why, said = null) {
    a.state = "goaround"; this.stats.goArounds++;
    if (a.nordo || (a.ga && !a.heli)) a.rejoin = true;   // a radio-failure aircraft / a light aircraft stays in the circuit and tries again
    if (said) this.pilot(a, `${this.cs(a).d}, ${said}`, "goingAround");
    else this.call(a, "goingAround", { greet: "" }, "TWR");
    this.alert(`${a.cs} went around: ${why}.`, "ga" + a.cs, why !== "instructed");
  }

  rolloutMove(a, dt) {
    const e = a.end;
    a.spd = Math.max(25 * KT, a.spd - 2.0 * dt);
    a.pos = [a.pos[0] + e.v[0] * a.spd * dt, a.pos[1] + e.v[1] * a.spd * dt];
    if (a.spd > 32 * KT) return;
    const along = (a.pos[0] - e.pos[0]) * e.v[0] + (a.pos[1] - e.pos[1]) * e.v[1];
    // the first exit on the side of the stand (no runway crossing on the way in), unless that one is far
    const side = (p) => Math.sign((p[0] - e.pos[0]) * e.v[1] - (p[1] - e.pos[1]) * e.v[0]);
    const want = a.stand ? side(a.stand.pos) : 0;
    // ...and never one whose way off the runway is blocked by someone standing on it (a departure queue)
    const standing = this.ac.filter(o => o !== a && o.onGround && !o.veh && o.spd < 0.5 && !this.apt.onRunway(o.pos, this.apt.runways[e.rwy], 5));
    const blocked = (route) => route.some(n => standing.some(o => dist(o.pos, this.apt.nodes[n]) < 45));
    const all = this.apt.exitsAhead(e, along + 15).map(x => ({ x, route: this.apt.exitRoute(x.node, e.rwy, e.hdg) })).filter(c => c.route);
    const exits = all.filter(c => !blocked(c.route)).length ? all.filter(c => !blocked(c.route)) : all;
    const good = want ? exits.find(c => side(this.apt.nodes[c.route[c.route.length - 1]]) === want && c.x.along - along < 900) : null;
    for (const { x, route } of good ? [good] : exits) {
      a.path = [[...a.pos, null], ...route.map(n => [...this.apt.nodes[n], n])];
      a.pi = 1;
      const ed = this.apt.edgeBetween(route[0], route[1]);
      a.exitName = ed && ed.name ? ed.name : "";
      a.state = "vacating";
      return;
    }
    // no exit ahead: slow to the end, then backtrack to the nearest usable exit
    const len = this.apt.runways[e.rwy].len;
    if (along > len - 400) {
      const cands = this.apt.exitsAhead(e, 0, true).sort((x, y) => Math.abs(x.along - along) - Math.abs(y.along - along));
      for (const x of cands) {
        const route = this.apt.exitRoute(x.node, e.rwy, null);
        if (!route) continue;
        const onCl = [e.pos[0] + e.v[0] * x.along, e.pos[1] + e.v[1] * x.along, null];
        a.path = [[...a.pos, null], onCl, ...route.map(n => [...this.apt.nodes[n], n])];
        a.pi = 1; a.spd = Math.min(a.spd, 10 * KT);
        const ed = this.apt.edgeBetween(route[0], route[1]);
        a.exitName = ed && ed.name ? ed.name : "";
        a.state = "vacating";
        return;
      }
    }
    if (along > len - 50) {
      a.spd = 0; a.state = "vacated";
      this.alert(`${a.cs} could not find a runway exit (taxi network missing?).`, "noexit" + a.cs, false);
      a.gone = true;
    }
  }

  runwayOccupants(rwy, except) {
    const r = this.apt.runways[rwy];
    return this.ac.filter(o => o !== except && o.onGround && this.apt.onRunway(o.pos, r, 5));
  }

  /** Runway free for a takeoff/landing: nobody on it, nobody rolling out. */
  runwayFree(rwy, except) { return this.runwayOccupants(rwy, except).length === 0; }
  /** Nearest arrival distance (m) to the threshold of runway end `e`, or Infinity. */
  nearestArrival(e, except) {
    let best = Infinity;
    for (const o of this.ac) if (o !== except && o.kind === "arr" && o.state === "final" && o.end.rwy === e.rwy) best = Math.min(best, this.distToThr(o));
    return best;
  }

  // ---------- safety checks ----------
  alert(msg, key, counts = true) {
    if (this.alerted.has(key)) return;
    this.alerted.set(key, this.t);
    if (counts) this.stats.alerts++;
    this.onAlert(msg);
  }

  checkConflicts() {
    for (const r of this.apt.runways) {
      const occ = this.ac.filter(o => o.onGround && this.apt.onRunway(o.pos, r, 5));
      const fast = occ.filter(o => o.state === "roll" || o.state === "rollout" || (o.human && o.spd > 30 * KT));
      for (const f of fast) for (const o of occ) {
        if (o !== f && !this.alerted.has(`rc${f.cs}${o.cs}`)) {
          this.stats.conflicts++;
          this.alert(`Runway conflict ${r.label}: ${f.cs} (${f.state === "roll" ? "takeoff roll" : f.human ? "high speed" : "landing"}) with ${o.cs} on the runway.`, `rc${f.cs}${o.cs}`);
        }
      }
      // takeoff roll while an arrival is inside 2 nm
      for (const f of occ.filter(o => o.state === "roll")) {
        for (const ar of this.ac.filter(o => o.kind === "arr" && o.state === "final" && o.end.rwy === r.id)) {
          const d = this.distToThr(ar);
          if (d < 2 * 1852 && d > 0 && this.t - f.rollStart < 2)
            this.alert(`${f.cs} cleared for takeoff with ${ar.cs} at ${(d / 1852).toFixed(1)} nm final.`, `tf${f.cs}${ar.cs}`);
        }
      }
    }
    const g = this.ac.filter(o => o.onGround && !o.onRoad && !(o.state === "parked"));
    for (let i = 0; i < g.length; i++) for (let j = i + 1; j < g.length; j++) {
      if (g[i].leader === g[j] || g[j].leader === g[i] || (g[i].veh && g[i].serving === g[j]) || (g[j].veh && g[j].serving === g[i])) continue;
      if (dist(g[i].pos, g[j].pos) < 30 && (g[i].spd > 0.5 || g[j].spd > 0.5) && !this.alerted.has(`gc${g[i].cs}${g[j].cs}`)) {
        this.stats.conflicts++;
        this.alert(`Ground conflict: ${g[i].cs} and ${g[j].cs} are less than 30 m apart.`, `gc${g[i].cs}${g[j].cs}`);
      }
    }
  }

  /** A readback error nobody corrected within 30 s becomes an alert. */
  checkReadbacks() {
    for (const a of this.ac) {
      const e = a.rbError;
      if (e && !e.fixed && !e.missed && this.t - e.t > 30) {
        e.missed = true; this.stats.missedRb++;
        this.alert(`Missed readback error: ${a.cs} read back ${e.label} ${e.wrong} instead of ${e.right}.`, "rb" + a.cs + e.t);
        this.onEvent({ type: "missedReadback", ac: a, err: e });
      }
    }
  }

  // ---------- scripted events (7600 / 7700) ----------
  scriptedEvent() {
    this.nextEvent = this.t + rint(600, 1200);
    const c = this.ac.filter(a => a.kind === "arr" && a.state === "final" && !a.ga && this.distToThr(a) > 9000 && !a.nordo && !a.mayday);
    if (!c.length) { this.nextEvent = this.t + 60; return; }
    const a = rnd(c);
    if (Math.random() < 0.5) {
      a.nordo = true; a.squawk = "7600";
      this.onEvent({ type: "emergency", ac: a, code: "7600" });
    } else {
      a.mayday = true; a.squawk = "7700";
      this.pilot(a, pilotCall("mayday", { st: a.style, cs: this.cs(a), unit: this.unitFor(a, "TWR"), rwy: a.end.name }), "mayday");
      this.onEvent({ type: "emergency", ac: a, code: "7700" });
    }
  }
  triggerEvent(kind, ac) { // for the UI / tests
    const c = ac || this.ac.find(a => a.kind === "arr" && a.state === "final");
    if (!c) return null;
    if (kind === "7600") { c.nordo = true; c.squawk = "7600"; }
    else if (kind === "7500") { c.hijack = true; c.squawk = "7500"; }
    else { c.mayday = true; c.squawk = "7700"; this.pilot(c, pilotCall("mayday", { st: c.style, cs: this.cs(c), unit: this.unitFor(c, "TWR"), rwy: (c.end || this.arrEnd).name }), "mayday"); }
    this.onEvent({ type: "emergency", ac: c, code: kind });
    return c;
  }

  // ---------- AI controllers for unstaffed positions ----------
  aiTick() {
    for (const a of this.ac) {
      if (a.human || a.lostUntil || (a.tcas && a.tcas.ra)) continue;
      const pos = a.freq;
      if (!this.positions[pos] || this.userWorks(pos)) continue;
      if (this.t < (a.aiNext || 0)) continue;
      if (a.lastCall != null && this.t - a.lastCall < 2.5) continue; // let the pilot finish
      const cs = `${a.ga ? callsign(a, NEUTRAL_STYLE).d : a.tel + " " + a.num}`;
      // a wrong readback is corrected first ("negative, squawk 4521")
      const e = a.rbError;
      if (e && !e.fixed && this.t - e.t > 2) { a.aiNext = this.t + 6; this.atcSay(pos, `${cs}, negative, ${e.fixPhrase}`, a); continue; }
      const text = this.aiDecide(a, pos);
      if (text) {
        a.aiNext = this.t + 6;
        // busy: one at a time -- the others waiting get "standby" once
        if (this.busyPos && this.busyPos[pos] === this.t && a.reqAt != null && !a.toldStandby && Math.random() < 0.7) { a.toldStandby = true; this.atcSay(pos, `${cs}, standby`, a); continue; }
        this.busyPos ||= {};
        if (workloadOf(this, pos) === "busy") this.busyPos[pos] = this.t;
        a.toldStandby = false;
        this.atcSay(pos, text, a);
      }
    }
  }

  freqOf(k) { return this.positions[k] ? `${this.positions[k].unit === "Radar" ? "Radar" : this.positions[k].unit} ${this.positions[k].freq}` : null; }
  contactPhrase(k) {
    const p = this.positions[k];
    if (!p) return null;
    const word = k === "APP" ? (/director/i.test(p.name) ? "Director" : /departure/i.test(p.name) ? "Departure" : "Radar") : k === "CTR" ? (p.name.split(" ").slice(0, -1).join(" ") + " " + p.name.split(" ").pop()) : p.unit;
    return `contact ${word} ${p.freq}`;
  }
  nextDown(k, a) { // where a departure goes after k
    const order = ["DEL", "GND", "TWR", "APP", "CTR"];
    for (let i = order.indexOf(k) + 1; i < order.length; i++) if (this.positions[order[i]]) return order[i];
    return null;
  }
  windTxt() { return this.wind.dir != null ? `, wind ${String(Math.round(this.wind.dir / 10) * 10).padStart(3, "0")} degrees ${Math.round(this.wind.spd)} knots` : ""; }

  /** What an AI controller says next to aircraft `a` on position `pos` (or null). */
  aiDecide(a, pos) {
    const cs = `${a.ga ? callsign(a, NEUTRAL_STYLE).d : a.tel + " " + a.num}`;
    const s = a.state;
    const apt = this.apt;
    if (pos === "DEL" && a.kind === "dep") {
      if (s === "clr_req" || (s === "parked" && a.lastCall != null)) {
        const code = this._dry ? this.squawks.peek(this.t) : this.squawks.next(this.t);
        const gnd = this.positions.GND ? `, when ready ${this.contactPhrase("GND")}` : "";
        const sg = this.suggestDeparture(a);
        return `${cs}, cleared to ${a.other[1]} via ${sg.sid ? sg.sid + " departure" : "flight planned route"}, climb ${sg.climb} feet, squawk ${code}${gnd}`;
      }
      if (s === "cleared" && a.askedHandoff && this.positions.GND) return `${cs}, ${this.contactPhrase("GND")}`;
    }
    if (a.nordo) {
      // radio failure: the AI controller uses the light gun (logged as an action, not a transmission)
      if (pos === "GND" || pos === "TWR") {
        if (a.onGround && (["vacated", "holding_short"].includes(s) || (s === "taxi" && a.atStop && a.blockedRwy != null && this.runwayFree(a.blockedRwy, a)))) return `${cs}, light green flashing`;
        if (!a.onGround && a.kind === "arr" && s === "final" && this.distToThr(a) < 5 * NM && this.runwayFree(a.end.rwy, a) && !a.landClr) return `${cs}, light green steady`;
      }
      return null;
    }
    if (a.veh) {
      // vehicles that asked for something (D6): runway entry for an inspection, the fire service, a tow
      if (a.wants === "enter" && a.task && (pos === "TWR" || pos === "GND")) {
        const r = apt.runways[a.task.rwy];
        if (this.runwayFree(r.id, a) && r.ends.every(x => this.nearestArrival(x) > 6 * NM) && !this.ac.some(o => o.kind === "dep" && ["lining", "lined_up", "roll", "lineup"].includes(o.state) && o.depEnd.rwy === r.id)) {
          a.wants = null; a.crossOk.add(r.id); a.holdPos = false; if (a.pi >= (a.path || []).length && !this._dry) this.inspectionNext(a);
          return `${cs}, enter runway ${r.ends[0].name}, report vacated`;
        }
        return null;
      }
      if (a.wants === "proceed" && pos === "TWR") { a.wants = null; return `${cs}, proceed, ${a.rescueLevel === "full" ? "cross runway " + (this.depEnd.name) + " approved" : "hold at the fire station"}`; }
      if (a.wants === "report" && (pos === "TWR" || pos === "GND")) { a.wants = null; if (a.task && !this._dry) this.closedRunways.delete(a.task.rwy); return `${cs}, roger, runway ${apt.runways[a.task ? a.task.rwy : this.depEnd.rwy].label} open`; }
      if (a.wants === "tow" && a.task && a.task.kind === "tow" && (pos === "GND" || pos === "TWR")) { a.towOk = true; a.wants = null; a.holdPos = false; if (a.pi >= (a.path || []).length) this.towNext(a); return `${cs}, tow approved, report complete`; }
      if (a.atStop && a.blockedRwy != null && (pos === "GND" || pos === "TWR")) {
        const r = apt.runways[a.blockedRwy];
        if (!this.runwayDanger(r.id, a, { finalNm: 1.5, finalSec: this.crossTime(a, r.id) + 30 }).busy) return `${cs}, cross runway ${r.ends[0].name}`;
      }
      return null;
    }
    if (pos === "GND") {
      // E2: push sequencing -- not while another push is under way or a pushed aircraft still waits close by
      if (a.kind === "dep" && s === "push_req" && this.ac.some(o => o !== a && !o.veh && o.onGround && ["pushing", "pushed", "taxi_req"].includes(o.state) && dist(o.pos, a.pos) < 160)) return null;
      if (a.kind === "dep" && s === "push_req") return this.deiceNeeded && !a.deiced ? `${cs}, de-icing approved on stand, report when complete` : `${cs}, push and start approved`;
      if (a.kind === "dep" && a.heli && s === "taxi_req") {
        // a helicopter lifts from the apron: Ground sends it to Tower, Tower clears it from present position
        if (this.split && this.positions.TWR && !this.userWorks("TWR") && pos === "GND" && this.hasPos("TWR")) { if (a.toldTwr) return null; a.toldTwr = true; return `${cs}, ${this.contactPhrase("TWR")}`; }
        return `${cs}, cleared for takeoff from present position${this.windTxt()}`;
      }
      if (a.kind === "dep" && s === "taxi_req") {
        const via = this.safeVia(a);
        if (!via) return null;                        // someone is taxiing towards it on the only way out: wait
        return `${cs}, taxi to holding point runway ${this.depEnd.name}${via.length ? " via " + via.join(" ") : ""}`;
      }
      if (a.veh && a.wants === "tow" && a.task && a.task.kind === "tow") return `${cs}, tow approved, report complete`;
      if (a.kind === "dep" && s === "broken") { if (!this.vehicleOf("tug")?.task && !this._dry) this.towRequest(a); return null; }
      if (a.kind === "dep" && a.rwyChanged && (s === "taxi" || s === "holding")) { a.rwyChanged = false; const via = this.viaNames(a); return `${cs}, runway change, taxi to holding point runway ${this.depEnd.name}${via.length ? " via " + via.join(" ") : ""}`; }
      if ((a.state === "taxi" || a.state === "lineup") && a.atStop && a.blockedRwy != null && !(a.kind === "dep" && a.blockedRwy === a.depEnd.rwy)) {
        const r = apt.runways[a.blockedRwy];
        const busy = this.runwayDanger(r.id, a, { finalNm: 1.5, finalSec: this.crossTime(a, r.id) + 30 }).busy;
        if (!busy) return `${cs}, cross runway ${r.ends[0].name}`;
        return null;
      }
      if (a.kind === "dep" && (s === "taxi" || s === "holding") && this.positions.TWR && !a.toldTwr &&
        (s === "holding" || (a.distToStop != null && a.distToStop < 350 && a.blockedRwy === a.depEnd.rwy))) {
        a.toldTwr = true;
        return `${cs}, ${this.contactPhrase("TWR")}`;
      }
      if (a.kind === "arr" && (s === "vacated" || s === "holding_short")) {
        // the nearest free stand that fits (deterministic: an assist suggestion is what auto would say)
        if (!a.stand) { const t = TYPE_INFO[a.type]; const fs = this.freeStands().filter(x => !t || standFits(x, t)); a.stand = fs.sort((x, y) => dist(x.pos, a.pos) - dist(y.pos, a.pos))[0] || this.freeStands()[0] || null; }
        if (!a.stand) return null;
        const via = this.safeVia(a, a.stand.pos);
        if (!via) return null;
        return `${cs}, taxi to stand ${a.stand.name}${via.length ? " via " + via.join(" ") : ""}`;
      }
    }
    if (pos === "TWR") {
      const e = a.depEnd || this.depEnd;
      // emergencies and VFR joins
      if ((a.mayday || a.pan || a.priority) && a.kind === "arr" && s === "final" && !a.priorityAck) {
        a.priorityAck = true;
        if (!this._dry) {
          if (a.mayday) this.rescueRespond(a, "full"); else if (a.pan) this.rescueRespond(a, "local");
          // E7: stop the other traffic for a MAYDAY
          if (a.mayday) this.onRadio({ from: "atc", ai: true, pos, text: `all stations, stop transmitting, mayday`, say: "all stations, stop transmitting, mayday", ctrl: this.controllerFor(pos) });
        }
        return `${cs}, roger ${a.mayday ? "mayday" : a.pan ? "pan pan" : ""}, runway ${a.end.name}, number one, ${a.mayday || a.pan ? "fire service alerted, " : ""}${a.mayday && a.squawk !== "7700" ? "squawk 7700 if not already, " : ""}report final`;
      }
      // E2: a slow circuit aircraft is not turned in ahead of a jet on final: extend downwind, number 2
      if (a.kind === "arr" && s === "circuit" && !a.circuitHold && a.wps && !a.nordo && ["downwind", "late downwind", "base", "crosswind", "upwind"].includes(a.circuitLeg || "downwind")) {
        // when would the circuit aircraft land: the rest of its circuit at its speed; the jet: its final at its speed
        let rest = 0, prev = a.pos;
        for (let k = a.wpi; k < a.wps.length; k++) { rest += dist(prev, a.wps[k].p); prev = a.wps[k].p; }
        rest += dist(prev, a.end.thr);
        const etaGa = rest / Math.max(30, a.spd || 40);
        const jet = this.ac.filter(o => o !== a && o.kind === "arr" && !o.ga && ["final", "star"].includes(o.state) && o.end === a.end)
          .map(o => ({ o, eta: Math.max(0, this.distToThr(o)) / Math.max(40, o.spd || 70) })).filter(x => x.eta < 600).sort((x, y) => x.eta - y.eta)[0];
        if (jet && jet.eta < etaGa + 120 && jet.eta > 20) {
          const nm = Math.max(1, Math.round(this.distToThr(jet.o) / NM));
          if (["downwind", "late downwind"].includes(a.circuitLeg || "downwind") && !a.extTold) {
            a.extTold = true; a.baseAfter = jet.o; a.baseAfterT = this.t;
            return `${cs}, extend downwind, I'll call your base, number 2, traffic ${atcType(jet.o.type)} on ${nm} mile final`;
          }
        }
      }
      if (a.kind === "arr" && a.calledIn && !a.joined && (s === "inbound" || (s === "circuit" && a.circuitHold))) {
        return this.svfrNeeded() && !a.svfr ? `${cs}, cleared special VFR, join left downwind runway ${this.arrEnd.name}, report downwind` : `${cs}, join left downwind runway ${this.arrEnd.name}, report downwind`;
      }
      if (a.kind === "dep" && s === "rto" && a.rtoCalled && !a.rtoAck) { a.rtoAck = true; if (!this._dry) this.rescueRespond(a, "local"); return `${cs}, roger, vacate the runway when able, fire service on the way`; }
      if (a.kind === "dep" && (s === "holding" || s === "lined_up")) {
        if (a.rwyChanged) return null;                 // Ground re-clears it to the new runway
        const arr = this.nearestArrival(e);
        const gap = this.lastTakeoff ? this.t - this.lastTakeoff.t : 999;
        const need = this.lastTakeoff && this.lastTakeoff.rwy === e.rwy ? this.depSpacingS(this.lastTakeoff, a) : 0;
        if (this.closedRunways.has(e.rwy) || this.hotExpired(a)) return null;
        // one departure on the runway at a time (any entry), and never in front of an arrival already cleared to land
        const otherDep = this.ac.some(o => o !== a && o.kind === "dep" && o.onGround && o.depEnd && o.depEnd.rwy === e.rwy && (o.toClr || ["lineup", "lining", "lined_up", "cond_lineup"].includes(o.state) || (o.state === "roll")));
        const clearedArr = this.ac.some(o => o.kind === "arr" && o.landClr && ["final", "circuit"].includes(o.state) && o.end && o.end.rwy === e.rwy && this.distToThr(o) < 7 * NM);
        if (otherDep && s === "holding" || clearedArr) return null;
        if (this.ac.some(o => o !== a && o.onGround && o.crossOk && o.crossOk.has(e.rwy) && !(o.kind === "dep" && o.depEnd && o.depEnd.rwy === e.rwy))) return null;   // a crossing is under way
        // a slower aircraft just ahead that has not turned away yet: two minutes (it would be caught on the climb)
        const prevAc = this.lastTakeoff && this.lastTakeoff.rwy === e.rwy ? this.ac.find(o => o.cs === this.lastTakeoff.cs && !o.onGround) : null;
        if (prevAc && gap < 120 && (prevAc.ga || prevAc.appSpd < a.appSpd - 15 * KT) && Math.abs(angDiff(prevAc.hdg, e.hdg)) < 40) return null;
        const minNm = this.lvp ? 6 : s === "lined_up" ? 3 : 4.5;      // from the holding point it lines up first (~40 s)
        if (this.runwayFree(e.rwy, a) && arr > minNm * NM && gap >= need && !this.finalTraffic(e.rwy, a).some(f => f.nm < minNm)) return `${cs}, runway ${e.name}, cleared for takeoff${this.windTxt()}`;
        // line up only with nobody (IFR or a circuit) landing soon
        const circuitIn = this.ac.some(o => o !== a && o.state === "circuit" && o.end && o.end.rwy === e.rwy && ["base", "final", "late downwind"].includes(o.circuitLeg));
        if (s === "holding" && this.runwayFree(e.rwy, a) && arr > 6 * NM && !circuitIn && !this.finalTraffic(e.rwy, a).some(f => f.nm < 6) && need - gap < 30 && !this.lvp) return `${cs}, runway ${e.name}, line up and wait`;
        return null;
      }
      if (a.kind === "dep" && s === "airborne" && a.alt > 700) {
        const nx = this.nextDown("TWR", a);
        if (nx) return `${cs}, ${this.contactPhrase(nx)}`;
        return a.ga ? `${cs}, frequency change approved` : null;
      }
      if (a.kind === "dep" && (s === "taxi" || s === "lineup") && a.atStop && a.blockedRwy != null && a.blockedRwy !== a.depEnd.rwy) {
        const r = apt.runways[a.blockedRwy];
        if (!this.runwayDanger(r.id, a, { finalNm: 1.5, finalSec: this.crossTime(a, r.id) + 30 }).busy) return `${cs}, cross runway ${r.ends[0].name}`;
      }
      if (a.kind === "arr" && s === "final") {
        const d = this.distToThr(a);
        // only the next one to land, with nobody on the runway, lining up or turning final ahead of it
        // mixed mode: with a departure ready the landing clearance waits until ~3.5 NM, leaving it the gap in front
        const depReady = this.ac.some(o => o.kind === "dep" && ["holding", "lined_up"].includes(o.state) && o.depEnd && o.depEnd.rwy === a.end.rwy);
        if (!a.landClr && d < (depReady ? 2.8 : 6) * NM && !this.runwayDanger(a.end.rwy, a, { finalNm: 0, finalSec: 0 }).busy && !this.closedRunways.has(a.end.rwy) &&
          !this.ac.some(o => o.kind === "dep" && o.onGround && o.depEnd && (["lineup", "lining", "lined_up", "cond_lineup", "roll"].includes(o.state) || o.toClr) && o.depEnd.rwy === a.end.rwy) &&
          !this.leaderOnFinal(a) && !this.ac.some(o => o !== a && o.state === "circuit" && o.end === a.end && ["base", "final", "late downwind"].includes(o.circuitLeg) && this.distToThr(o) < d))
          return a.touchGo ? `${cs}, runway ${a.end.name}, cleared touch and go${this.windTxt()}` : `${cs}, runway ${a.end.name}, cleared to land${this.windTxt()}`;
        if (!a.landClr && d < 1.2 * NM && !a.nordo) return `${cs}, go around`;
        if (!a.landClr && !a.toldSeq && a.calledIn && d < 8 * NM && d > 3 * NM) {
          const lead = this.leaderOnFinal(a);
          if (lead) { a.toldSeq = true; return `${cs}, ${sequenceInfo(2, lead.ac, lead.d / NM, atcType)}, continue approach`; }
        }
      }
      if (a.kind === "arr" && (s === "vacated" || s === "vacating") && this.positions.GND && !a.toldGnd && s === "vacated") {
        a.toldGnd = true;
        return `${cs}, ${this.contactPhrase("GND")}`;
      }
    }
    if (pos === "APP") {
      if (a.kind === "arr" && (s === "final" || s === "star")) {
        if (!a.appCleared && a.calledIn) {
          a.appCleared = true;
          // F4: the STAR and approach from the real procedures when there are any
          const sg = this.suggestArrival ? this.suggestArrival(a) : null;
          const star = s === "star" && a.star ? `via ${a.star} arrival, ` : "";
          const app = (a.appName || (sg && sg.appTitle) || "ILS").replace(/^LOC.*/, "localizer");
          return `${cs}, identified, ${star}descend 3000 feet, cleared ${app} approach runway ${a.end.name}`;
        }
        if (a.appCleared && s === "final" && this.distToThr(a) < 10 * NM && this.positions.TWR) return `${cs}, ${this.contactPhrase("TWR")}`;
        if (a.appCleared && s === "final" && !a.spdTold && !a.ga) {
          const lead = this.leaderOnFinal(a);
          if (lead && this.distToThr(a) - lead.d < (this.wakeNm(lead.ac, a) + 1) * NM) { a.spdTold = true; return `${cs}, reduce speed ${Math.max(140, Math.round((lead.ac.spd || a.appSpd) / KT / 10) * 10)} knots until 4 mile final`; }
        }
        if (a.appCleared && !a.tiGiven) {
          const o = this.ac.find(x => x !== a && !x.onGround && !x.veh && Math.hypot(x.pos[0] - a.pos[0], x.pos[1] - a.pos[1]) < 6 * NM && Math.abs((x.alt || 0) - (a.alt || 0)) < 1500 && !(x.kind === "arr" && x.state === "final" && x.end === a.end));
          if (o) { a.tiGiven = true; if (((a.id * 7919) % 100) / 100 < ((this.ctrls && this.ctrls.APP && this.ctrls.APP.trafficInfo) || 0.6)) return `${cs}, ${trafficInfo(a, o, atcType)}`; }
        }
      }
      if (a.kind === "dep" && !a.onGround) {
        if (!a.appIdent) { a.appIdent = true; return `${cs}, identified, climb flight level 120`; }
        if (a.alt > 4500 && this.positions.CTR) return `${cs}, ${this.contactPhrase("CTR")}`;
      }
    }
    if ((pos === "CTR" || pos === "APP") && !a.onGround && a.kind === "ovf" && this.ac.length < 400) {
      const me = this.tcasState(a);
      for (const o of this.ac) {
        if (o === a || o.onGround || o.veh || !o.pos || (a.sepTold && a.sepTold[o.id])) continue;
        if (Math.hypot(o.pos[0] - a.pos[0], o.pos[1] - a.pos[1]) > 60 * NM) continue;
        const hit = stcaCheck(me, this.tcasState(o), { nm: 5, ft: 1000, look: 240 });
        if (!hit || (o.kind === "ovf" && o.id > a.id && !(o.sepTold && o.sepTold[a.id]))) continue;   // one of the two moves: the older keeps its level
        (a.sepTold ||= {})[o.id] = true;
        const up = a.alt < o.alt ? -1 : 1, lvl = Math.round(a.alt / 1000) * 1000 + up * 2000;
        if (lvl < 10000 || lvl > 41000) continue;
        return `${cs}, ${up > 0 ? "climb" : "descend"} flight level ${lvl / 100}, traffic`;
      }
    }
    if (pos === "CTR" && !a.onGround) {
      if (!a.ctrIdent && (a.calledIn || a.kind === "dep")) { a.ctrIdent = true; return `${cs}, identified${a.kind === "dep" ? ", climb flight level 240" : ""}`; }
    }
    return null;
  }

  /** Suggested SID + initial climb (main.js plugs in procedures from CIFP / EuroScope; generic otherwise). */
  suggestDeparture(a) {
    if (this.suggest) { try { const s = this.suggest(a); if (s) return s; } catch { /* ignore */ } }
    return { sid: null, climb: this.region === "US" ? 5000 : 4000, generic: true };
  }

  /** Taxiway names along the shortest taxi route to the departure runway (for AI taxi instructions). */
  viaNames(a) {
    const start = this.startNode(a, true);
    const route = this.apt.routeToRunway(start.node, this.depEnd, [], start.avoid) || this.apt.routeToRunway(start.node, this.depEnd, []);
    return this.namesOf(route);
  }
  viaNamesTo(a, pos) {
    const start = this.startNode(a, true);
    const route = this.apt.routeToPos(start.node, pos, [], start.avoid) || this.apt.routeToPos(start.node, pos, []);
    return this.namesOf(route);
  }
  /** E2 (AI Ground): a route that meets nobody head-on -- around them when the network allows, else null (wait). */
  safeVia(a, toStand) {
    const start = this.startNode(a, true);
    // never along the runway in use when there is another way (taxi-in included)
    const plan = (blocked) => toStand
      ? this.apt.routeToPos(start.node, toStand, [], start.avoid, { blocked, avoidRwy: this.depEnd.rwy }) || this.apt.routeToPos(start.node, toStand, [], start.avoid, { blocked })
      : this.apt.routeToRunway(start.node, this.depEnd, [], start.avoid, { blocked });
    // around aircraft standing on the taxiways (a departure queue at the holding point, a breakdown) when possible
    const standing = new Set();
    for (const o of this.ac) {
      if (o === a || !o.onGround || o.veh || !["holding", "holding_short", "broken", "vacated"].includes(o.state)) continue;
      const ne = this.apt.nearestEdge ? this.apt.nearestEdge(o.pos, 40, false) : null;
      if (ne && ne.e.i != null) standing.add(ne.e.i);
    }
    let route = plan(new Set([...this.blockedEdges, ...standing])) || plan(this.blockedEdges.size ? this.blockedEdges : null) ||
      (toStand ? this.apt.routeToPos(start.node, toStand, []) : this.apt.routeToRunway(start.node, this.depEnd, []));
    const opp = this.headOnEdges(route, a);
    if (opp.size) route = plan(new Set([...this.blockedEdges, ...opp, ...standing])) || plan(new Set([...this.blockedEdges, ...opp]));
    if (route && !this._dry) a.aiRoute = { to: toStand ? "stand" : "rwy", route };
    return route ? this.namesOf(route) : null;
  }
  namesOf(route) {
    if (!route) return [];
    const out = [];
    for (let i = 0; i + 1 < route.length; i++) {
      const e = this.apt.edgeBetween(route[i], route[i + 1]);
      if (e && e.name && !e.runway && out[out.length - 1] !== e.name) out.push(e.name);
    }
    return out.slice(0, 6);
  }

  // ---------- controller instructions ----------
  /** Apply parsed instructions; returns pilot readback display text (legacy API used by tests). */
  instruct(a, ins, opts = {}) {
    const r = this.respond(a, ins, opts);
    return r ? r.d : "";
  }

  /**
   * Apply a transmission to aircraft `a` and build the pilot's reply {d, s} (or null for no reply).
   * opts: { text: normalized transmission, pos: position it was sent on, ai: from an AI controller }
   */
  respond(a, ins, opts = {}) {
    const st = a.style || NEUTRAL_STYLE;
    const csObj = this.cs(a);
    const text = opts.text || "";
    const neg = /\b(negative|correction|wrong)\b/.test(text);
    if (opts.pos && opts.pos !== "ALL") this.stats.tx[opts.pos] = (this.stats.tx[opts.pos] || 0) + 1;
    if (a.ga && !a.abbrev && opts.abbrevUsed) a.abbrev = true;
    // radio failure: nothing is heard; "squawk ident" is answered on the label, light signals and the follow-me
    // car are acted on (the pilot can see those)
    if (a.nordo) {
      for (const i of ins) {
        if (i.t === "ident") a.identUntil = this.t + 15;
        else if (i.t === "light") this.applyLight(a, i.color, i.mode);
        else if (i.t === "followMe") this.sendFollowMe(a);
      }
      return null;
    }
    // correction of a pending readback error
    const err = a.rbError;
    let corrected = false;
    if (err && !err.fixed && new RegExp(`\\b${err.rightKey.replace(".", "\\.")}\\b`).test(text)) {
      err.fixed = true; corrected = true;
      if (!err.missed) this.stats.rbCaught++;   // a late correction still fixes the aircraft, but was not "caught"
      err.apply();
      this.onEvent({ type: "readbackCorrected", ac: a, err });
      // "negative, squawk 4521" is applied as an instruction too; a bare correction gets the fixed item read back
      if (!ins.length || ins.every(i => i.t === "identified")) return readback([err.fixPhrase], csObj, st);
      ins = ins.filter(i => !(err.label === "runway" && (i.t === "land" || i.t === "takeoff" || i.t === "lineup") && a.state !== "holding" && a.state !== "final"));
      if (!ins.length) return readback([err.fixPhrase], csObj, st);
    }
    if (!ins.length) {
      if (/\b(affirm|affirmative)\b/.test(text) && a.confirmTO) ins = [{ t: "takeoff", affirm: true }];
      else if (neg) return readback(["roger"], csObj, st);
      else return pilotCall("sayAgain", { st, cs: csObj });
    }
    if (a.tcas && a.tcas.ra && ins.some(i => !["identified", "contact"].includes(i.t))) {
      this.onEvent({ type: "tcasRefused", ac: a, text });
      return capFirstObj(ph(st)`Unable, TCAS RA, ${csObj}`);
    }
    if (!opts.ai && this.rates.sayAgain > 0 && Math.random() < this.rates.sayAgain) {
      return pilotCall("sayAgain", { st, cs: csObj });
    }
    const items = [];
    let extra = "";
    for (const i of ins) {
      const r = this.apply(a, i, opts);
      if (r && r.unable) return capFirstObj(ph(st)`${r.unable}, ${csObj}`);
      if (r && r.special === "confirmTakeoff") return pilotCall("confirmTakeoff", { st, cs: csObj });
      if (r && r.signoff) extra = signOff(st, this.apt.icao, true);
      if (r && r.text) items.push(r.text);
      else if (typeof r === "string") items.push(r);
    }
    if (!items.length) return readback(["roger"], csObj, st);
    // a planted readback error (training): wrong squawk digit, reciprocal runway, wrong altitude/frequency
    if (!opts.ai && !corrected && (this.forceRbError || (this.rates.readbackError > 0 && Math.random() < this.rates.readbackError))) {
      this.forceRbError = false;
      this.plantError(a, items);
    }
    return readback(items, csObj, st, extra);
  }

  plantError(a, items) {
    const tries = [
      { re: /squawk ([0-7]{4})/, label: "squawk", wrong: (v) => { const i = rint(1, 3); const d = (+v[i] + rint(1, 6)) % 8; return v.slice(0, i) + d + v.slice(i + 1); },
        apply: (a, v) => { a.squawk = v; }, fix: (a, v) => { a.squawk = v; } },
      { re: /runway (\d{2})([LRC]?)/, label: "runway", wrong: (v, m) => String(((+m[1] + 18 - 1) % 36) + 1).padStart(2, "0") + ({ L: "R", R: "L", C: "C" }[m[2]] || ""),
        apply: () => {}, fix: () => {} },
      { re: /(\d{4,5}) feet/, label: "altitude", wrong: (v) => String(+v + (+v >= 2000 && Math.random() < 0.5 ? -1000 : 1000)),
        apply: (a, v) => { a.cfl = +v; }, fix: (a, v) => { a.cfl = +v; } },
      { re: /(\d{3}\.\d{2,3})/, label: "frequency", wrong: (v) => v.slice(0, -1) + ((+v.slice(-1) + 5) % 10),
        apply: (a, v) => { if (a.switchTo) a.switchTo = { lost: true, freq: v }; a.switchAt = this.t + 8; }, fix: (a, v, key) => { if (a.switchTo || a.switchAt) { a.switchTo = { key }; a.switchAt = this.t + 3; } } },
    ];
    const cands = [];
    items.forEach((it, idx) => tries.forEach(tr => { const m = String(it).match(tr.re); if (m) cands.push({ idx, tr, m }); }));
    if (!cands.length) return;
    const { idx, tr, m } = rnd(cands);
    const right = tr.label === "runway" ? m[1] + m[2] : m[1];
    const wrong = tr.wrong(right, m);
    if (wrong === right) return;
    const original = items[idx];
    items[idx] = String(original).replace(right, wrong);
    const sw = a.switchTo;
    tr.apply(a, wrong);
    this.stats.rbErrors++;
    a.rbError = {
      label: tr.label, right, wrong, t: this.t, rightKey: right.toLowerCase(), fixPhrase: original,
      apply: () => tr.fix(a, right, sw && sw.key),
    };
    this.onEvent({ type: "readbackError", ac: a, err: a.rbError });
  }

  apply(a, i, opts = {}) {
    const apt = this.apt;
    switch (i.t) {
      case "clearance": {
        if (a.kind !== "dep" || !["parked", "clr_req", "cleared"].includes(a.state)) return { unable: "Say again" };
        if (i.dest && i.dest.toUpperCase() !== a.other[0] && !a.other[1].toLowerCase().replace(/ /g, "").startsWith(i.dest.toLowerCase()))
          return { unable: `Negative, we filed to ${a.other[1]}` };
        if (!i.squawk) return { unable: "Request squawk" };
        this.serviced(a, "clearance");
        if (a.assignedSq && a.assignedSq !== i.squawk) this.squawks.release(a.assignedSq, this.t);
        a.squawk = i.squawk; a.assignedSq = i.squawk; this.squawks.take(i.squawk);
        a.ifr = true; a.sid = i.sid && i.sid !== "flight planned route" ? i.sid.replace(/ departure$/, "") : a.sid; a.initAlt = i.alt;
        if (i.alt) { const m = i.alt.match(/(\d+)/); if (m) a.cfl = /flight level/.test(i.alt) ? +m[1] * 100 : +m[1]; }
        if (a.state !== "cleared") {
          a.state = "cleared"; a.callAt = this.t + rint(20, 60);
          if (!this.split || a.freq === "GND" || !this.hasPos("GND")) this.scheduleCall(a, "push", {}, "GND");
        }
        const parts = [`cleared to ${i.dest ? a.other[1] : "destination"}`];
        if (i.sid) parts.push(i.sid);
        if (i.alt) parts.push(`climb ${i.alt}`);
        parts.push(`squawk ${i.squawk}`);
        return parts.join(", ");
      }
      case "push": {
        if (a.kind !== "dep" || !a.onGround || a.state === "pushing") return { unable: "Say again" };
        if (!a.ifr) return { unable: "We don't have our clearance yet" };
        if (!["parked", "push_req", "cleared"].includes(a.state)) return { unable: "Say again" };
        this.serviced(a, "push");
        this.planPush(a, i.face);
        a.state = "pushing"; a.pushStarted = false; a.pushWaitCalled = false;
        return `push and start approved${i.face ? ", facing " + i.face : ""}`;
      }
      case "taxi": {
        if (!a.onGround) return { unable: "Say again" };
        const end = apt.findRunwayEnd(i.rwy) || (a.kind === "dep" ? this.depEnd : null);
        if (!end) return { unable: `Say again runway` };
        if (a.kind === "arr") return { unable: "Confirm we taxi to the stand?" };
        if (!a.ga && ["parked", "push_req", "cleared", "clr_req", "pushing"].includes(a.state)) return { unable: "Unable, we are still on stand" };
        const start = this.startNode(a);
        // the AI Ground's conflict-checked route is the one flown (safeVia); otherwise the shortest with the cleared via
        const route = (opts.ai && a.aiRoute && a.aiRoute.to === "rwy" ? a.aiRoute.route : null) || apt.routeToRunway(start.node, end, i.via, start.avoid) || apt.routeToRunway(start.node, end, i.via);
        a.aiRoute = null;
        if (!route) return { unable: `Unable to find that route, say again taxi instructions` };
        this.serviced(a, "taxi");
        a.depEnd = end;
        this.setPath(a, route);
        a.state = "taxi"; a.holdPos = false; a.taxiTo = null; a.viaText = i.via.join(" ");
        return `taxi holding point runway ${end.name}${i.via.length ? " via " + i.via.join(" ") : ""}`;
      }
      case "taxiStand": {
        if (!a.onGround || a.kind !== "arr") return { unable: "Say again" };
        if (!["vacated", "holding_short", "taxi"].includes(a.state)) return { unable: "Say again" };
        let st = a.stand;
        if (i.stand) {
          const k = standKey(i.stand);
          st = apt.stands.find(s => standKey(s.name) === k);
          if (!st) return { unable: `Say again stand` };
          a.stand = st;
        }
        if (!st) return { unable: "Request stand number" };
        const start = this.startNode(a);
        const route = (opts.ai && a.aiRoute && a.aiRoute.to === "stand" ? a.aiRoute.route : null) || apt.routeToPos(start.node, st.pos, i.via, start.avoid) || apt.routeToPos(start.node, st.pos, i.via);
        a.aiRoute = null;
        if (!route) return { unable: `Unable to find that route, say again taxi instructions` };
        this.serviced(a, "taxiIn");
        this.setPath(a, route);
        if (dist(a.path[a.path.length - 1], st.pos) > 1) a.path.push([...st.pos, null]);
        a.state = "taxi"; a.taxiTo = "stand"; a.holdPos = false; a.viaText = i.via.join(" ");
        return `taxi to stand ${st.name}${i.via.length ? " via " + i.via.join(" ") : ""}`;
      }
      case "holdShort": {
        const e = apt.findRunwayEnd(i.rwy);
        if (e) a.crossOk.delete(e.rwy);
        return `hold short runway ${i.rwy || ""}`.trim();
      }
      case "cross": {
        const e = apt.findRunwayEnd(i.rwy);
        if (!e) return { unable: "Say again runway" };
        if (!a.onGround) return { unable: "Say again" };
        const dg = this.runwayDanger(e.rwy, a, { finalNm: 2, finalSec: 60 });
        if (dg.busy && !i.affirm && !a.veh) {
          this.atcError("crossBusy", { by: opts.ai ? `AI ${opts.pos || "GND"}` : "you", ac: a, text: `${a.cs} cleared to cross runway ${i.rwy} with ${dg.by ? dg.by.cs + " " : ""}${dg.why}`,
            should: `"${this.cs(a).d}, hold short of runway ${i.rwy}" until the ${dg.why.replace(/^traffic /, "")} has passed, or "behind the landing …, cross runway ${i.rwy} behind"` });
          a.crossOk.add(e.rwy); a.calledHold = false;      // the clearance stands; the crew waits at the bar until it is safe
          return { unable: `Holding short runway ${i.rwy}, ${dg.why}, confirm cross?` };
        }
        this.serviced(a, "cross");
        a.crossOk.add(e.rwy); a.calledHold = false;
        return `cross runway ${i.rwy}`;
      }
      case "hold": {
        if (a.veh && a.task && a.task.kind === "incursion") { a.spd = 0; a.task = null; a.onDone = null; a.crossOk.clear(); a.pauseUntil = this.t + 25; this.vehicleHome(a); this.alert(`${a.cs} stopped.`, "stopped" + a.cs, false); return "stopping"; }
        a.holdPos = true; if (a.leader && a.leader.veh) a.leader.holdPos = true;
        return a.state === "rto" ? "holding position on the runway" : "holding position";
      }
      case "continue": {
        a.holdPos = false; if (a.leader && a.leader.veh) a.leader.holdPos = false;
        if (a.holdShortIdx != null) { a.holdShortIdx = null; a.holdShortTwy = null; a.calledHold = false; }
        if (a.giveWay) a.giveWay = null;
        return "continue taxi";
      }
      case "holdShortTwy": {
        if (!a.onGround || !a.path) return { unable: "Say again" };
        const idx = a.path.findIndex((p, k) => k >= a.pi && k + 1 < a.path.length && p[2] != null && a.path[k + 1][2] != null && (this.apt.edgeBetween(p[2], a.path[k + 1][2]) || {}).name === i.twy);
        if (idx < 0) return { unable: `Say again, we don't cross taxiway ${i.twy} on our route` };
        a.holdShortIdx = idx; a.holdShortTwy = i.twy; a.calledHold = false;
        return `hold short of taxiway ${i.twy}`;
      }
      case "contApp": {
        if (a.kind !== "arr" || a.state !== "final") return { unable: "Say again" };
        a.contApp = true;
        return "continue approach";
      }
      case "expect": {
        const m = i.what.match(/^(?:runway )?(\d{2}[lrc]?)$/i);
        const what = m ? `runway ${m[1].toUpperCase()}` : i.what;
        a.expect = what;
        if (m && a.kind === "dep" && apt.findRunwayEnd(m[1]) && a.onGround && !a.path) a.depEnd = apt.findRunwayEnd(m[1]);
        return `expecting ${what}`;
      }
      case "report": {
        a.reports = { ...(a.reports || {}), [i.what]: true };
        if (/passing|reaching/.test(i.what)) { const m = i.what.match(/(\d{3,5})/); if (m) a.reportAlt = +m[1]; }
        return `wilco, report ${i.what}`;
      }
      case "giveWay": {
        const o = this.findSubject(a, i, i.phase || "taxiing");
        if (!o) return { unable: "Say again the traffic" };
        a.giveWay = { ac: o }; a.holdPos = true;
        return `giving way to the ${spokenType(o.type)}`;
      }
      case "follow": {
        const o = this.findSubject(a, i, i.phase || "taxiing");
        if (!o || !o.onGround) return { unable: "Say again the traffic" };
        a.leader = o;                       // taxis behind it once it has its own taxi clearance
        a.holdPos = false;
        return `following the ${spokenType(o.type)}`;
      }
      case "lineup": {
        if (a.kind !== "dep" || !["holding", "taxi", "cond_lineup"].includes(a.state)) return { unable: "Say again" };
        if (i.rwy && apt.findRunwayEnd(i.rwy) !== a.depEnd) return { unable: `Confirm runway, we are at holding point ${a.depEnd.name}` };
        if (this.litBarAhead(a)) return { unable: "Unable, the stop bar is still lit" };
        if (this.closedRunways.has(a.depEnd.rwy)) return { unable: `Confirm, we understood runway ${a.depEnd.name} is closed?` };
        if (!i.cond) {
          const fin = this.finalTraffic(a.depEnd.rwy, a).find(f => f.nm < 1.5 || f.sec < 45);
          if (fin) {
            this.atcError("lineupFinal", { by: opts.ai ? `AI ${opts.pos || "TWR"}` : "you", ac: a, text: `${a.cs} told to line up with ${fin.ac.cs} on ${fin.nm.toFixed(1)} NM final`,
              should: `"behind the landing ${spokenType(fin.ac.type)}, line up and wait behind" (a conditional clearance), or hold the departure` });
            return { unable: `Holding short, traffic on short final, confirm line up?` };
          }
        }
        this.serviced(a, "ready");
        if (i.cond) {
          const o = this.findSubject(a, i.cond, i.cond.phase || "landing");
          if (!o) return { unable: "Say again the traffic" };
          a.cond = { ...i.cond, ac: o }; a.condTakeoff = false; a.state = "cond_lineup";
          return `behind the ${i.cond.phase || "landing"} ${spokenType(o.type)}, line up and wait runway ${a.depEnd.name} behind`;
        }
        this.lineUp(a, false);
        return `line up and wait runway ${a.depEnd.name}`;
      }
      case "takeoff": {
        if (a.heli && a.onGround && ["parked", "taxi_req", "clr_req", "cleared"].includes(a.state)) { this.heliLift(a); return "cleared for takeoff from present position"; }
        if (a.kind !== "dep" || !["holding", "taxi", "lineup", "lining", "lined_up", "cond_lineup"].includes(a.state)) return { unable: "Say again" };
        if (i.rwy && apt.findRunwayEnd(i.rwy) !== a.depEnd) return { unable: `Confirm runway, we are at ${a.depEnd.name}` };
        if (this.hotExpired(a)) return { unable: "Unable, our holdover time has expired, request taxi back for de-icing" };
        if (this.closedRunways.has(a.depEnd.rwy)) return { unable: `Confirm, we understood runway ${a.depEnd.name} is closed?` };
        if (a.state !== "lined_up" && this.litBarAhead(a)) return { unable: "Unable, the stop bar is still lit" };
        const refuse = this.windRefusal(a, a.depEnd);
        if (refuse && !a.acceptedWind) { const best = this.bestEndForWind(); a.acceptedWind = true; return { unable: `Unable runway ${a.depEnd.name}, ${refuse}${best && best !== a.depEnd ? ", request runway " + best.name : ""}` }; }
        const occupied = !this.runwayFree(a.depEnd.rwy, a);
        if (occupied && !a.confirmTO && !i.affirm) { a.confirmTO = true; return { special: "confirmTakeoff" }; }
        // A10: anyone (AI or real pilot) on short final -> unable
        const fin = this.finalTraffic(a.depEnd.rwy, a).find(f => f.nm < 2 || f.sec < 60);
        if (fin && !i.cond) {
          this.atcError("takeoffFinal", { by: opts.ai ? `AI ${opts.pos || "TWR"}` : "you", ac: a, text: `${a.cs} cleared for takeoff with ${fin.ac.cs}${fin.ac.human ? " (real pilot)" : ""} on ${fin.nm.toFixed(1)} NM final`,
            should: `hold the departure ("${this.cs(a).d}, hold position") or "line up and wait" only when it can go before the arrival reaches 4 NM` });
          return { unable: `Unable, traffic on ${fin.nm < 2 ? "short final" : fin.nm.toFixed(0) + " mile final"}` };
        }
        a.confirmTO = false;
        this.serviced(a, "ready");
        a.toClr = true; a.immediate = !!i.immediate;
        if (i.cond && a.state !== "lined_up") {
          const o = this.findSubject(a, i.cond, i.cond.phase || "landing");
          if (!o) return { unable: "Say again the traffic" };
          a.cond = { ...i.cond, ac: o }; a.condTakeoff = true; a.state = "cond_lineup";
          return `behind the ${i.cond.phase || "landing"} ${spokenType(o.type)}, cleared for takeoff runway ${a.depEnd.name} behind`;
        }
        if (a.state === "lined_up") { if (!this.departureBlocked(a)) this.startRoll(a); }
        else if (["holding", "taxi", "cond_lineup"].includes(a.state)) this.lineUp(a, true);
        return `cleared for ${i.immediate ? "immediate " : ""}takeoff runway ${a.depEnd.name}`;
      }
      case "cancelTakeoff": {
        if (a.kind !== "dep") return { unable: "Say again" };
        if (["lineup", "lining", "lined_up", "cond_lineup"].includes(a.state) && a.toClr) { a.toClr = false; a.condTakeoff = false; if (a.state === "cond_lineup") a.state = "holding"; return "cancel takeoff clearance, holding"; }
        if (a.state === "roll") {
          if (a.spd < 80 * KT) { this.rejectTakeoff(a, "takeoff clearance cancelled"); return "stopping"; }
          return { unable: "Unable, we are committed, continuing" };
        }
        return { unable: "Say again" };
      }
      case "option": case "touchGo": {
        if (a.state !== "final" && a.state !== "circuit") return { unable: "Say again" };
        if (i.rwy && apt.findRunwayEnd(i.rwy) !== a.end) return { unable: `Confirm runway, we are for ${a.end.name}` };
        this.touchAndGo(a); this.serviced(a, "land");
        return `cleared ${i.t === "option" ? "for the option" : "touch and go"} runway ${a.end.name}`;
      }
      case "fullStop": { this.fullStop(a); return "full stop"; }
      case "landAfter": {
        if (a.kind !== "arr" || a.state !== "final") return { unable: "Say again" };
        const o = this.findSubject(a, i, i.phase || "landing");
        if (!o) return { unable: "Say again the traffic" };
        a.landAfter = { ...i, ac: o };
        return `land after the ${i.phase} ${spokenType(o.type)}, runway ${a.end.name}`;
      }
      case "land": {
        if (a.kind !== "arr" || (a.state !== "final" && a.state !== "circuit")) return { unable: "Say again" };
        if (i.rwy && apt.findRunwayEnd(i.rwy) !== a.end) return { unable: `Confirm runway, we are established ${a.end.name}` };
        if (this.closedRunways.has(a.end.rwy)) return { unable: `Confirm, we understood runway ${a.end.name} is closed?` };
        this.serviced(a, "land");
        a.landClr = true; a.fullStop = true; a.touchGo = false;
        a.landClrBy = opts.ai ? `AI ${opts.pos || "TWR"}` : "you";
        // A10: the crew sees the runway is not free and asks; if it still is at the decision height they go around
        const occ = this.runwayDanger(a.end.rwy, a, { finalNm: 0, finalSec: 0 });
        if (occ.busy && !i.affirm) {
          a.rwyQuery = { t: this.t, by: occ.by ? occ.by.cs : "" };
          this.atcError("landOccupied", { by: a.landClrBy, ac: a, text: `${a.cs} cleared to land runway ${a.end.name} with ${occ.by ? occ.by.cs + " " : ""}${occ.why}`,
            should: `"${this.cs(a).d}, continue approach, expect late landing clearance" (or "land after the …" when the conditions for it are met) until the runway is vacated` });
          return { unable: `Confirm cleared to land runway ${a.end.name}, ${occ.why}?` };
        }
        return `cleared to land runway ${a.end.name}`;
      }
      case "goaround": {
        if (a.kind !== "arr" || (a.state !== "final" && a.state !== "circuit")) return { unable: "Say again" };
        this.goAround(a, "instructed");
        return null;
      }
      case "join": {
        if (a.kind !== "arr" || !["inbound", "circuit", "final", "goaround"].includes(a.state)) return { unable: "Say again" };
        a.joined = true; a.circuitHold = false;
        return this.joinCircuit(a, i);
      }
      case "extend": return this.extendDownwind(a) ? "extending downwind" : { unable: "Say again" };
      case "orbit": return this.orbit(a, i.side) ? `orbit ${i.side}` : { unable: "Say again" };
      case "svfr": { a.svfr = true; return "cleared special VFR"; }
      case "remainOutside": { if (a.state === "inbound" || a.circuitHold) { a.remainOutside = true; return "remaining outside the control zone"; } return { unable: "Say again" }; }
      case "lift": { return this.heliLift(a) ? "lifting" : { unable: "Say again" }; }
      case "deice": {
        if (a.kind !== "dep" || !a.onGround || !["push_req", "cleared", "parked", "taxi_req", "pushed"].includes(a.state)) return { unable: "Say again" };
        this.serviced(a, "deice");
        this.startDeice(a, !!i.pad);
        return i.pad ? "taxi to the de-icing pad" : "de-icing on stand, will report when complete";
      }
      case "towApproved": {
        if (!a.veh || !a.task || a.task.kind !== "tow") return { unable: "Say again" };
        a.towOk = true; a.wants = null; a.holdPos = false; if (a.pi >= (a.path || []).length) this.towNext(a);
        return "tow approved, will report complete";
      }
      case "enterRwy": {
        const e = apt.findRunwayEnd(i.rwy); if (!e) return { unable: "Say again runway" };
        if (!a.veh || !a.task) return { unable: "Say again" };
        a.crossOk.add(e.rwy); a.wants = null; a.holdPos = false; if (a.pi >= (a.path || []).length) this.inspectionNext(a);
        return `entering runway ${i.rwy}, will report vacated`;
      }
      case "vacate": {
        if (a.state === "rto" || (a.veh && a.task)) { if (a.veh) { a.task && (a.task.stage = "inspecting"); this.inspectionNext(a); return "vacating"; } return this.vacateRunway(a) ? "vacating the runway" : { unable: "Unable, we need a tow" }; }
        if (a.state === "lined_up" || a.state === "lineup" || a.state === "lining") { this.lightClearRunway(a); return "vacating the runway"; }
        return { unable: "Say again" };
      }
      case "rwyClosed": { const r = (a.depEnd || a.end || this.depEnd).rwy; this.closedRunways.add(r); this.onEvent({ type: "rwyClosed", rwy: r }); return "roger, runway closed"; }
      case "rffs": {
        if (a.veh && a.vtype === "fire") { a.rescueLevel = i.level; a.wants = null; return i.level === "full" ? "full emergency, proceeding to the runway" : "local standby, copied"; }
        const v = this.rescueRespond(this.ac.find(o => o.mayday || o.pan) || null, i.level);
        return v ? "roger" : { unable: "Say again" };
      }
      case "contact": {
        if (!this.split) {
          if (a.kind === "dep" && !a.onGround) { a.handedOff = true; a.removeAt = this.t + 6; }
          return { text: `${i.unit}${i.freq ? " " + i.freq : ""}`, signoff: true };
        }
        if (i.unit === "frequency change approved") { a.handedOff = true; a.removeAt = this.t + 6; return { text: "frequency change approved", signoff: true }; }
        const target = positionFor(i.unit, i.freq, this.positions);
        const unitWord = i.unit.replace(/\b\w/g, c => c.toUpperCase());
        if (i.freq && (!target || !target.exact)) {
          // a frequency nobody is on: the pilot goes there and comes back
          a.switchTo = { lost: true, freq: i.freq }; a.switchAt = this.t + 3;
        } else if (target && this.positions[target.key]) {
          a.switchTo = { key: target.key }; a.switchAt = this.t + 3;
          if (a.kind === "dep" && a.state === "cleared") a.callAt = Infinity; // they'll call ground on check-in
        } else return { unable: "Say again frequency" };
        return { text: `${unitWord}${i.freq ? " " + i.freq : ""}`, signoff: true };
      }
      case "squawk": {
        a.squawk = i.code; a.assignedSq = i.code; this.squawks.take(i.code);
        return `squawk ${i.code}`;
      }
      case "ident": a.identUntil = this.t + 15; return "squawk ident";
      case "atis": {
        a.atisReported = null;
        return `copy information ${i.letter ? LETTER_WORD[i.letter.toUpperCase()] : this.atis()}`;
      }
      case "alt": {
        a.cfl = i.ft;
        return `${i.verb} ${i.ft >= 6000 && i.fl ? "flight level " + i.ft / 100 : i.ft + " feet"}`;
      }
      case "approach": {
        // off a vector or a hold: on to the final intercept
        if (a.vectorHdg != null || a.holdP) { a.vectorHdg = null; a.holdP = null; a.eat = null; a.navWps = null; if (a.starWps) a.starI = a.starWps.length - 1; }
        return `cleared ILS approach runway ${a.end ? a.end.name : this.arrEnd.name}`;
      }
      case "identified": return null;
      // nav instructions (F4): a fix the crew cannot find in their box is queried, not flown
      case "direct": {
        if (i.known === false) return { unable: `Unable, ${i.fix.split("").join(" ")} is not in our database, say again the fix` };
        if (a.onGround) return { unable: "Say again" };
        const p = this.navPoint ? this.navPoint(i.fix) : null;
        if (p) { const k = (a.wps || []).findIndex(w => w.id === i.fix); a.navWps = k >= 0 ? a.wps.slice(k) : [{ p, id: i.fix, leg: i.fix }]; a.wps = a.navWps; a.wpi = 0; }
        a.directTo = i.fix;
        return `direct ${i.fix}`;
      }
      case "speed": {
        if (a.onGround) return { unable: "Say again" };
        a.spdCap = i.kt * KT; a.spdCapUntil = i.untilNm ? i.untilNm * NM : 0;
        if (a.state !== "final") a.spd = Math.min(a.spd, a.spdCap);
        return `${i.verb} speed ${i.kt} knots${i.untilNm ? ` until ${i.untilNm} mile final` : ""}`;
      }
      case "heading": {
        if (a.onGround) return { unable: "Say again" };
        a.vectorHdg = i.hdg % 360;
        if (a.kind === "dep" && a.state === "airborne") { a.sidWps = []; a.navWps = null; a.hdgHold = a.vectorHdg; }
        return `turn ${i.dir ? i.dir + " " : ""}heading ${String(i.hdg).padStart(3, "0")}`;
      }
      case "eat": {
        const hh = +i.hhmm.slice(0, 2), mm = +i.hhmm.slice(2);
        const now = new Date(this.clockUtc + this.t * 1000);
        let at = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hh, mm);
        if (at < now.getTime() - 3600e3) at += 86400e3;
        a.eat = this.t + Math.max(0, (at - now.getTime()) / 1000);
        return `expect approach at ${i.hhmm}`;
      }
      case "vfrVia": {
        // B2: "leave the zone via Kilo at 1500 feet" / "join via Kilo"
        const pt = this.vfrPoints().find(p => p.name.toLowerCase() === String(i.point).toLowerCase());
        if (!pt) return { unable: `Say again the reporting point` };
        if (a.kind === "dep" || !a.onGround && a.kind !== "arr") { a.vfrExit = pt; a.navWps = null; a.vfrExitCalled = false; }
        else if (a.kind === "arr" && a.state === "inbound") { a.vfrPoint = pt; a.wps = [{ p: pt.p, leg: pt.name, alt: i.alt || pt.alt }]; a.wpi = 0; }
        if (i.alt) a.cfl = i.alt;
        return `via ${pt.name}${i.alt ? " at " + i.alt + " feet" : ""}`;
      }
      case "holdAt": {
        if (i.known === false) return { unable: `Unable, confirm the holding fix` };
        a.holdFix = i.fix;
        a.holdP = this.navPoint ? this.navPoint(i.fix) : null;
        if (a.holdP && a.state === "star") { a.navWps = [{ p: a.holdP, id: i.fix, leg: i.fix }]; a.navI = 0; }
        return `hold at ${i.fix}${i.turn ? (i.turn === "L" ? ", left turns" : ", right turns") : ", as published"}`;
      }
      case "star": {
        if (i.known === false) return { unable: `Unable, we don't have the ${i.name} arrival` };
        a.star = i.name;
        return `via ${i.name} arrival`;
      }
      case "light": {
        const eff = this.applyLight(a, i.color, i.mode);
        return eff ? `roger, ${i.color} ${i.mode}` : { unable: "Say again" };
      }
      case "followMe": {
        const v = this.sendFollowMe(a);
        if (!v) return { unable: "Unable, no follow-me available" };
        return a.veh ? null : "roger, we'll follow the follow-me car";
      }
    }
    return null;
  }

  /** Record how long the pilot waited for a request to be serviced. */
  serviced(a, what) {
    if (a.reqAt != null) { this.stats.delays.push({ what, s: this.t - a.reqAt }); a.reqAt = null; }
  }

  startNode(a, peek = false) {
    // after pushback: taxi forward toward the node the nose points at, no U-turn
    if (a.pushNose != null) {
      const r = { node: a.pushNose, avoid: a.pushTail };
      if (!peek) a.pushNose = null;
      return r;
    }
    // node to route from: if path ended at a node use it, else nearest node ahead of the nose
    const last = a.path && a.path.length ? a.path[Math.min(a.pi, a.path.length) - 1] : null;
    if (last && last[2] != null && dist(last, a.pos) < 1) {
      const before = a.path.length > 1 ? a.path[a.path.length - 2] : null;
      return { node: last[2], avoid: before && before[2] != null ? before[2] : undefined };
    }
    const v = vecFromHdg(a.hdg);
    const node = this.apt.nearestNode([a.pos[0] + v[0] * 15, a.pos[1] + v[1] * 15]);
    return { node, avoid: a.pushTail };
  }

  setPath(a, route) {
    a.path = [[...a.pos, null], ...route.map(n => [...this.apt.nodes[n], n])];
    a.pi = 1;
  }

  planPush(a, face) {
    const apt = this.apt;
    // Candidates: push onto node N, then tail along edge N->T so the nose points at N.
    // Pick the nearest one from which the aircraft can taxi forward to the runway.
    const want = face ? { north: 180, south: 0, east: 270, west: 90 }[face] : null;
    const inZone = (i) => apt.adj[i].some(o => o.e.runway || o.e.zones.size);
    // never push onto a stand node (our own or a neighbour's); the taxilane node the stand link joins is the target
    let near = apt.nodes.map((p, i) => [i, dist(p, a.pos)]).filter(([i, d]) => d < 160 && apt.adj[i].length && !apt.nodeStand.has(i))
      .sort((x, y) => x[1] - y[1]);
    // never push onto a runway or into a runway hold zone
    const onRwy = (i) => apt.adj[i].some(o => o.e.runway);
    if (near.some(([i]) => !inZone(i))) near = near.filter(([i]) => !inZone(i));
    else if (near.some(([i]) => !onRwy(i))) near = near.filter(([i]) => !onRwy(i));
    near = near.slice(0, 6);
    let N = near.length ? near[0][0] : apt.nearestNode(a.pos), best = null, bs = Infinity;
    for (const [n, dn] of near) {
      for (const { to } of apt.adj[n]) {
        const h = hdgOf(apt.nodes[to][0] - apt.nodes[n][0], apt.nodes[to][1] - apt.nodes[n][1]);
        let sc = dn + (want != null ? Math.abs(angDiff(h, want)) * 1.5 : 0);
        if (sc >= bs) continue;
        if (!apt.routeToRunway(n, this.depEnd, [], to)) continue;
        bs = sc; best = to; N = n;
      }
    }
    const np = apt.nodes[N];
    const path = [[...a.pos, null], [...np, N]];
    a.pushFace = null;
    if (best != null) {
      const bp = apt.nodes[best];
      const L = dist(np, bp), go = Math.max(0, Math.min(L - 2, 45));
      if (go > 1) path.push([np[0] + (bp[0] - np[0]) * go / L, np[1] + (bp[1] - np[1]) * go / L, null]);
      a.pushFace = hdgOf(np[0] - bp[0], np[1] - bp[1]);
      a.pushTail = best;
    }
    a.pushNose = N;
    a.standName = a.stand ? a.stand.name : a.standName;
    a.path = path; a.pi = 1; a.stand = null;
  }

  lineUp(a, thenTakeoff) {
    a.toClr = thenTakeoff;
    a.crossOk.add(a.depEnd.rwy);
    a.state = "lineup";
  }

  /** Serializable state for pop-out windows, multiplayer and the EuroScope / XRadio bridges. */
  snapshot(selectedId) {
    return this.ac.map(a => ({
      id: a.id, cs: a.cs, tel: a.tel, num: a.num, type: a.type, wtc: a.wtc, kind: a.kind, state: a.state, pos: a.pos, hdg: a.hdg, spd: a.spd,
      alt: a.alt, onGround: a.onGround, squawk: a.squawk, assignedSq: a.assignedSq, xpdr: a.xpdr, freq: a.freq,
      other: a.other, stand: a.stand ? a.stand.name : a.standName || "", rwy: (a.depEnd || a.end || {}).name || "",
      human: !!a.human, ga: !!a.ga, sid: a.sid || "", cfl: a.cfl || 0, warn: this.labelWarnings(a), ident: !!a.identUntil,
      typeUnknown: !!a.typeUnknown, tcasRa: !!(a.tcas && a.tcas.ra), tcasTa: !!(a.tcas && a.tcas.ta && !a.tcas.ra), vs: a.vsFpm || 0,
      raKind: a.tcas && a.tcas.ra ? a.tcas.ra.kind : "", stca: !!(a.stcaUntil && this.t < a.stcaUntil),
      nat: a.nat, path: a.id === selectedId && a.path && a.onGround ? a.path.slice(a.pi).map(p => [p[0], p[1]]) : null,
      dthr: a.kind === "arr" && a.state === "final" ? this.distToThr(a) : null, strip: a.strip || null,
      stripData: a.stripData || null, callingUntil: a.callingUntil || 0, vfr: !!a.ga && a.kind !== "arr",
      veh: !!a.veh, vtype: a.vtype || "", targetCs: a.targetCs || "", standTo: a.standTo || "", leader: a.leader ? a.leader.cs : "",
      quiet: !!a.quiet, onRoad: !!a.onRoad, dormant: !!a.dormant, cargo: !!a.cargo, gear: this.equipment(a), standKind: a.stand ? a.stand.kind : "",
      via: a.viaText || "", exit: a.exitName || "", holdRwy: a.holdRwyName || "", landClr: !!a.landClr, toClr: !!a.toClr, taxiTo: a.taxiTo || "",
      atStop: !!a.atStop, holdPos: !!a.holdPos, nordo: !!a.nordo, mayday: !!a.mayday, circuitLeg: a.circuitLeg || "", returned: !!a.returned,
      waiting: a.reqAt != null ? Math.round(this.t - a.reqAt) : null, rb: a.rbError && !a.rbError.fixed ? { label: a.rbError.label, missed: !!a.rbError.missed, wrong: a.rbError.wrong, right: a.rbError.right } : null,
      atisReported: a.atisReported || null, lastWant: a.lastWant || "", ifr: !!a.ifr, calledIn: !!a.calledIn, abbrev: !!a.abbrev,
      crewNat: a.nat || "", gender: a.crew && a.crew[0] ? a.crew[0].gender || "" : "", lastCall: a.lastCall ?? null,
      ctot: a.ctot != null ? ctotStatus(a.ctot, this.t) : null, hot: a.hotUntil != null ? Math.round(a.hotUntil - this.t) : null, deiced: !!a.deiced,
      cond: a.cond && a.cond.ac ? `behind ${a.cond.ac.cs}` : "", priority: a.priority || "", pan: !!a.pan, broken: !!a.broken, towing: !!a.towing,
      heli: !!a.heli, touchGo: !!a.touchGo, circuits: a.circuits || 0, wants: a.wants || "", rwyChanged: !!a.rwyChanged, giveWay: a.giveWay && a.giveWay.ac ? a.giveWay.ac.cs : "",
      fpStatus: a.fpStatus || "", liveTx: !!a.tx, liveAi: !!a.ai,
      handoff: a.handoff ? { from: a.handoff.from, to: a.handoff.to, accepted: !!a.handoff.accepted, age: Math.round(this.t - a.handoff.t), by: a.handoff.by || "" } : null,
      simbrief: !!a.simbrief, route: a.route || "", rfl: a.rfl || 0, eobt: a.eobt || "", reg: a.reg || "", planSid: a.planSid || "",
    }));
  }

  /** Operational state for panels and pop-outs. */
  status() {
    return { lvp: this.lvp, rvr: this.rvr ?? null, vis: this.vis ?? null, closed: [...this.closedRunways].map(r => this.apt.runways[r].label), deice: !!this.deiceNeeded,
      snow: !!this.snow, wind: this.wind, rwyChange: this.rwyChange && !this.rwyChange.done ? { from: this.rwyChange.from.name, to: this.rwyChange.to.name } : null,
      hint: this.rwyChangeHint || null, fod: this.fod, stopBars: this.apt.stopBars.map(b => ({ id: b.id, lit: b.lit })) };
  }

  /** The aircraft on a position's frequency (for voice casting: no two identical voices on one frequency). */
  onFrequency(pos) { return this.ac.filter(a => !a.quiet && (!a.veh ? this.hears(a, pos) : a.freq === pos || !this.split)); }
}

const capFirstObj = (r) => ({ d: cap(r.d), s: cap(r.s) });
installOps(Sim);
installVfr(Sim);
installEvents(Sim);
installTraffic(Sim);
installTcas(Sim);
installAutoAtc(Sim);
