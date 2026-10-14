// Traffic simulation: aircraft state machines, ground movement, pilots' calls and readbacks,
// ATC positions with handoffs, AI controllers for unstaffed positions, squawks, readback errors.
import { KT, FT, dist, hdgOf, angDiff, vecFromHdg } from "./airport.js";
import { AIRLINES, TYPES, GA_TYPES, HELI_TYPES, REG_PREFIX, LETTER_WORD, DESTS, AIRLINE_NAT, AIRLINE_TYPES, CARGO_TYPES, HOUR_WAVE, REG_NAT, rnd, rint, distKm, weighted, controllerNat } from "./data.js";
import { standKey, parse, normalize, setTaxiNames } from "./commands.js";
import { regionOf, makeStyle, callsign, spokenType, pilotCall, readback, ph, greeting, signOff, localHour, cap, NEUTRAL_STYLE, sayNumbers } from "./phrase.js";
import { makeCrew } from "./voices.js";
import { SquawkAllocator, validCode } from "./squawk.js";
import { positionFor, fmtFreq } from "./positions.js";

const TAXI_SPD = 18 * KT, TURN_SPD = 7 * KT, PUSH_SPD = 1.3;
const FINAL_SPAWN = 14000;      // m from threshold (combined mode)
const APP_SPAWN = 25 * 1852;    // m from threshold when an approach position exists
const NM = 1852;
const TYPE_INFO = Object.fromEntries(TYPES.map(t => [t[0], t]));
const isCargoStand = (s) => s.op === "cargo" || /cargo|freight/i.test(s.name);
const standFits = (s, t) => !s || !s.types || !s.types.length || s.types.includes(t[2]) || (t[2] === "heavy" && s.types.includes("jets") && s.size && s.size >= "D");

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
  userWorks(pos) { return !this.split || this.staffing.has("ALL") || this.staffing.has(pos); }
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
  rollAtis() { this.atisIdx++; this.atisAt = this.t; this.onEvent({ type: "atis", letter: this.atisLetter() }); }

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
    const ty = rnd(GA_TYPES);
    const dir = rnd(["north", "south", "east", "west"]);
    const f = {
      id: nextId++, cs, tel, num: "", ga: true, type: ty[0], wtc: ty[1], appSpd: ty[3] * KT, other: ["VFR", `the ${dir}`],
      crossOk: new Set(), log: [],
    };
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
      this.onEvent({ type: "wake", ac: f });
      return f;
    }
    let { stand: st, ga } = this.pickStand();
    if (opts.ga === false && ga) { const g = this.freeStands(); if (!g.length) return null; st = rnd(g); ga = false; }
    if (!st) return null;
    const f = this.makeFlight(st.types, ga, { cargo: !ga && isCargoStand(st), stand: st });
    return this.placeParked(f, st, false);
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
    if (last > spawnD - 5500) return null;
    const f = this.makeFlight(stand ? stand.types : null, ga, { cargo: !!stand && !ga && isCargoStand(stand), stand });
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

  spawnOverflight() {
    if (!this.hasPos("CTR")) return null;
    const f = this.makeFlight(null, false);
    const brg = Math.random() * 360, R = 40 * NM;
    const pos = [Math.sin(brg * Math.PI / 180) * R, Math.cos(brg * Math.PI / 180) * R];
    const hdg = (brg + 180 + rint(-35, 35) + 360) % 360;
    const fl = rint(30, 38) * 1000;
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

  /** Real pilots (XRadio): placed and moved from outside, never by the sim. */
  upsertHuman(h) {
    let a = this.ac.find(x => x.human && x.hid === h.hid);
    if (!a) {
      a = { id: nextId++, human: true, hid: h.hid, kind: "human", state: "human", crossOk: new Set(), log: [],
        tel: h.cs, num: "", nat: "", style: NEUTRAL_STYLE, crew: makeCrew("GB"), other: ["", ""], wtc: "M", freq: "ALL" };
      this.ac.push(a);
      this.onEvent({ type: "spawn", ac: a });
    }
    Object.assign(a, { cs: h.cs, type: h.type || "ZZZZ", pos: h.pos, alt: h.alt, hdg: h.hdg, spd: h.spd,
      onGround: !!h.onGround, squawk: h.squawk, xpdr: h.xpdr || "C", seenAt: this.t });
    return a;
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
  atc(pos, text) {
    const pp = parse(text, this.ac.filter(a => this.hears(a, pos)), null);
    const action = pp.ins.length && pp.ins.every(i => i.t === "light" || i.t === "followMe");
    if (action) {                      // a light-gun signal is not a transmission
      if (pp.ac) this.respond(pp.ac, pp.ins, { text: pp.normalized, pos, ai: true });
      this.onEvent({ type: "aiAction", pos, text, ac: pp.ac });
      return;
    }
    this.onRadio({ from: "atc", ai: true, pos, text, say: sayNumbers(text, NEUTRAL_STYLE) });
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
    if (this.overflights && this.t >= this.nextOvf) {
      this.spawnOverflight();
      this.nextOvf = this.t + 3600 / Math.max(1, this.ovfPerHour) * (0.6 + Math.random() * 0.8);
    }
    if (this.t - this.atisAt > 1800) this.rollAtis();
    for (const a of this.ac) if (!a.human) this.update(a, dt);
    for (const a of this.ac) if (a.human && this.t - a.seenAt > 15) a.gone = true;
    for (const a of this.ac) if (a.gone && a.assignedSq && !a.human) this.squawks.release(a.assignedSq, this.t);
    const gone = this.ac.filter(a => a.gone);
    this.ac = this.ac.filter(a => !a.gone);
    for (const a of gone) this.onEvent({ type: "gone", ac: a });
    if (Math.floor(this.t) !== Math.floor(this.t - dt)) {
      this.checkConflicts();
      this.checkReadbacks();
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

    if (s === "circuit") {
      this.circuitMove(a, dt);
    } else if (a.kind === "dep") {
      if (s === "parked" && a.dormant) { /* waiting on the stand for its slot */ }
      else if (s === "parked" && this.t >= a.callAt && a.ga) {
        this.call(a, "gaTaxi", { dest: a.other[1] }, "GND");
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
        if (this.followPath(a, dt, true)) {
          a.state = "pushed"; a.callAt = this.t + rint(20, 60);
          if (a.autoTaxi) { a.autoTaxi = false; this.lightTaxi(a); }
          else this.scheduleCall(a, "taxi", {}, "GND");
        }
      } else if (s === "pushed" && this.t >= a.callAt) {
        this.callPrepared(a, "taxi", {}, "GND");
        a.state = "taxi_req"; a.callAt = this.t + 150;
      } else if (s === "taxi_req" && this.t >= a.callAt) {
        this.call(a, "stillWaitingGeneric", { what: "ready to taxi", greet: "" }, "GND");
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
        this.call(a, "stillWaitingGeneric", { what: `holding point runway ${a.depEnd.name}, ready for departure`, greet: "" }, "TWR");
        a.callAt = this.t + 120;
      } else if (s === "lining") {
        // align with the runway centreline
        const e = a.depEnd;
        const d = angDiff(a.hdg, e.hdg);
        a.hdg = (a.hdg + Math.sign(d) * Math.min(Math.abs(d), 30 * dt) + 360) % 360;
        const cross = (a.pos[0] - e.pos[0]) * e.v[1] - (a.pos[1] - e.pos[1]) * e.v[0];
        const sh = Math.sign(cross) * Math.min(Math.abs(cross), 6 * dt);
        a.pos = [a.pos[0] - e.v[1] * sh, a.pos[1] + e.v[0] * sh];
        if (Math.abs(d) < 1 && Math.abs(cross) < 0.5) {
          a.hdg = e.hdg; a.state = a.toClr ? "roll" : "lined_up";
          if (a.state === "roll") this.startRoll(a);
        }
      } else if (s === "roll" || s === "airborne") {
        this.takeoffMove(a, dt);
      }
    } else if (a.kind === "ovf") {
      a.pos = [a.pos[0] + Math.sin(a.hdg * Math.PI / 180) * a.spd * dt, a.pos[1] + Math.cos(a.hdg * Math.PI / 180) * a.spd * dt];
      if (this.t >= a.callAt && !a.calledIn) { a.calledIn = true; this.call(a, "overflight", { cfl: `flight level ${a.alt / 100}` }, "CTR"); }
      if (Math.hypot(...a.pos) > 45 * NM) a.gone = true;
    } else {
      if (s === "final" || s === "goaround") {
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
    a.state = "parked"; a.parkedAt = this.t; a.xpdr = "S"; a.spd = 0;
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
  startCircuit(a, end, { side = "left", joinNm = a.ga ? 2.5 : 4, altFt = a.ga ? 1000 : 1500, widthM = a.ga ? 1300 : 3300 } = {}) {
    const v = end.v, n = side === "right" ? [v[1], -v[0]] : [-v[1], v[0]];
    const len = this.apt.runways[end.rwy].len, thr = end.thr, joinM = joinNm * NM;
    const P = (along, out) => [thr[0] + v[0] * along + n[0] * out, thr[1] + v[1] * along + n[1] * out];
    a.wps = [
      { p: P(len + 700, widthM * 0.25), leg: "crosswind" },
      { p: P(len + 200, widthM), leg: "downwind" },
      { p: P(-1.0 * NM, widthM), leg: "late downwind" },
      { p: P(-joinM, widthM * 0.45), leg: "base" },
      { p: P(-joinM, 0), leg: "final" },
    ];
    a.wpi = 0; a.circuitLeg = "upwind"; a.circuitAlt = altFt; a.circuitSpd = (a.ga ? 90 : 170) * KT;
    a.end = end; a.state = "circuit"; a.onGround = false; a.landClr = false; a.calledIn = false; a.toClr = false;
    a.circuitSide = side; a.circuitStart = this.t; a.circuitFrom = [...a.pos];
    return a.wps;
  }

  circuitMove(a, dt) {
    const wp = a.wps && a.wps[a.wpi];
    if (!wp) { this.joinFinal(a); return; }
    const dx = wp.p[0] - a.pos[0], dy = wp.p[1] - a.pos[1], d = Math.hypot(dx, dy);
    a.hdg = this.turnToward(a.hdg, hdgOf(dx, dy), dt, a.ga ? 4.5 : 3);
    a.spd += Math.max(-2 * dt, Math.min(1.5 * dt, a.circuitSpd - a.spd));
    const want = a.circuitAlt;
    a.alt += Math.max(-800 / 60 * dt, Math.min((a.ga ? 700 : 1500) / 60 * dt, want - a.alt));
    const v = vecFromHdg(a.hdg);
    a.pos = [a.pos[0] + v[0] * a.spd * dt, a.pos[1] + v[1] * a.spd * dt];
    // reached: close to it, or passed abeam it (so a wide turn never circles a waypoint for ever)
    const prev = a.wpi ? a.wps[a.wpi - 1].p : a.circuitFrom || a.pos;
    const lx = wp.p[0] - prev[0], ly = wp.p[1] - prev[1], ll = Math.hypot(lx, ly) || 1;
    const passed = ((wp.p[0] - a.pos[0]) * lx + (wp.p[1] - a.pos[1]) * ly) / ll < -50;
    if (d < Math.max(120, a.spd * 3.5) || passed || this.t - a.circuitStart > 900) {
      a.circuitLeg = wp.leg; a.wpi++;
      this.onEvent({ type: "circuitLeg", ac: a, leg: wp.leg });
      if (wp.leg === "downwind" && a.reports?.downwind !== false && !a.nordo) this.call(a, "circuitReport", { leg: "downwind", rwy: a.end.name, greet: "" }, "TWR");
      if (wp.leg === "base" && !a.nordo && a.reports?.base) this.call(a, "circuitReport", { leg: "base", rwy: a.end.name, greet: "" }, "TWR");
      if (a.wpi >= a.wps.length) this.joinFinal(a);
    }
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
    // the first call on the new frequency is predictable: render it now
    if (!a.nordo && a.kind === "dep" && to.key === "GND" && ["cleared", "parked"].includes(a.state)) this.scheduleCall(a, "push", {}, "GND", a.checkInAt);
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
      const z = this.edgeZones(p, j), zPrev = j > 0 ? this.edgeZones(p, j - 1) : new Set();
      for (const r of z) {
        if (zPrev.has(r) || a.crossOk.has(r)) continue;
        // a departure may pass through its own runway's zone (e.g. behind the threshold) if it leaves it again
        if (a.kind === "dep" && a.depEnd && r === a.depEnd.rwy && this.leavesZone(p, j, r)) continue;
        return { j, rwy: r };
      }
    }
    return { j: p.length - 1, rwy: null };
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
      if (zIn.has(r) && !zOut.has(r) && !(a.kind === "dep" && a.state === "lineup")) a.crossOk.delete(r);
    }
  }

  trafficLimit(a) {
    let lim = Infinity;
    const v = vecFromHdg(a.hdg);
    for (const o of this.ac) {
      if (o === a || !o.onGround) continue;
      if (o.onRoad && !a.onRoad) continue;           // service roads run next to the taxiways; vehicles there do not block aircraft
      if (o.state === "parked" && o.stand && dist(o.pos, o.stand.pos) < 5) continue;   // aircraft on their stands are passed by
      if (a.veh && o === a.target) continue;        // the car drives up to its aircraft, and its follower is behind it
      if (o.leader === a) continue;
      if (a.leader === o && o.state !== "leading") continue;   // the car has stepped aside at the stand
      if (o.veh && o.serving === a) continue;                                // ground equipment at our stand
      const dx = o.pos[0] - a.pos[0], dy = o.pos[1] - a.pos[1];
      const along = dx * v[0] + dy * v[1], cross = Math.abs(dx * v[1] - dy * v[0]);
      if (along > 0 && along < 90 && cross < 25) {
        lim = Math.min(lim, along < 55 ? 0 : TURN_SPD);
      }
    }
    return lim;
  }

  startRoll(a) {
    a.state = "roll"; a.rollStart = this.t;
    const prev = this.lastTakeoff;
    if (prev && prev.wtc === "H" && a.wtc !== "H" && this.t - prev.t < 120) {
      this.alert(`Wake turbulence: ${a.cs} (${a.wtc}) departed ${Math.round(this.t - prev.t)} s after ${prev.cs} (heavy); 2 min required.`, "wake" + a.cs);
    }
    this.lastTakeoff = { t: this.t, wtc: a.wtc, cs: a.cs };
  }

  takeoffMove(a, dt) {
    const e = a.depEnd, v = e.v;
    const vr = a.appSpd * 1.1;
    if (a.state === "roll") {
      a.spd = Math.min(a.spd + 2.2 * dt, 250 * KT);
      if (a.spd >= vr) { a.state = "airborne"; a.onGround = false; this.stats.departures++; }
    } else {
      a.spd = Math.min(a.spd + 1.0 * dt, (this.split ? 250 : 220) * KT);
      const top = this.split ? a.cfl : Infinity;
      if (a.alt < top) a.alt = Math.min(top, a.alt + (a.ga ? 700 : 2500) / 60 * dt);
      const onTwr = !this.split ? !a.handedOff : a.freq === "TWR" || a.freq === "ALL";
      if (a.alt > (a.ga ? 1500 : 2500) && onTwr && !a.askedFreq) {
        a.askedFreq = true;
        this.call(a, "freqChange", { alt: `${Math.round(a.alt / 100) * 100} feet`, greet: "" }, "TWR");
      }
    }
    a.hdg = e.hdg;
    a.pos = [a.pos[0] + v[0] * a.spd * dt, a.pos[1] + v[1] * a.spd * dt];
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
      a.alt = this.arrAlt(a);
      a.spd = this.split && !a.ga && d > 15000 ? Math.max(a.appSpd, 200 * KT - (46000 - d) * 0.0005) : a.appSpd;
      if (this.split && !a.ga && d <= 15000) a.spd = a.appSpd + Math.max(0, (d - 6000) / 9000) * 40 * KT;
      const occupied = this.runwayOccupants(e.rwy, a).length > 0;
      if (d < 600 && ((!a.landClr && !a.nordo) || occupied)) {
        this.goAround(a, a.landClr || a.nordo ? "runway occupied" : a.freq !== "TWR" && this.split ? `no landing clearance (still on ${a.freq})` : "no landing clearance");
        return;
      }
      a.pos = [a.pos[0] + e.v[0] * a.spd * dt, a.pos[1] + e.v[1] * a.spd * dt];
      if (d < -350) { a.state = "rollout"; a.onGround = true; a.alt = 0; a.crossOk.add(e.rwy); }
    } else {
      a.alt += 1800 / 60 * dt;
      a.spd = Math.min(a.spd + 1 * dt, 180 * KT);
      a.pos = [a.pos[0] + e.v[0] * a.spd * dt, a.pos[1] + e.v[1] * a.spd * dt];
      if (a.rejoin && a.alt > (a.ga ? 900 : 1400)) { a.rejoin = false; this.startCircuit(a, e); }
      else if (!a.rejoin && a.alt > 3000) a.gone = true;
    }
  }

  goAround(a, why) {
    a.state = "goaround"; this.stats.goArounds++;
    if (a.nordo) a.rejoin = true;                 // a radio-failure aircraft stays in the circuit and tries again
    this.call(a, "goingAround", { greet: "" }, "TWR");
    this.alert(`${a.cs} went around: ${why}.`, "ga" + a.cs, why !== "instructed");
  }

  rolloutMove(a, dt) {
    const e = a.end;
    a.spd = Math.max(25 * KT, a.spd - 2.0 * dt);
    a.pos = [a.pos[0] + e.v[0] * a.spd * dt, a.pos[1] + e.v[1] * a.spd * dt];
    if (a.spd > 32 * KT) return;
    const along = (a.pos[0] - e.pos[0]) * e.v[0] + (a.pos[1] - e.pos[1]) * e.v[1];
    for (const x of this.apt.exitsAhead(e, along + 15)) {
      const route = this.apt.exitRoute(x.node, e.rwy, e.hdg);
      if (!route) continue;
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
      if (a.human || a.lostUntil) continue;
      const pos = a.freq;
      if (!this.positions[pos] || this.userWorks(pos)) continue;
      if (this.t < (a.aiNext || 0)) continue;
      if (a.lastCall != null && this.t - a.lastCall < 2.5) continue; // let the pilot finish
      const text = this.aiDecide(a, pos);
      if (text) { a.aiNext = this.t + 6; this.atc(pos, text); }
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
        const code = this.squawks.next(this.t);
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
      if (a.atStop && a.blockedRwy != null && (pos === "GND" || pos === "TWR")) {
        const r = apt.runways[a.blockedRwy];
        if (this.runwayFree(r.id, a) && r.ends.every(x => this.nearestArrival(x) > 3 * NM)) return `${cs}, cross runway ${r.ends[0].name}`;
      }
      return null;
    }
    if (pos === "GND") {
      if (a.kind === "dep" && s === "push_req") return `${cs}, push and start approved`;
      if (a.kind === "dep" && s === "taxi_req") {
        const via = this.viaNames(a);
        return `${cs}, taxi to holding point runway ${this.depEnd.name}${via.length ? " via " + via.join(" ") : ""}`;
      }
      if ((a.state === "taxi" || a.state === "lineup") && a.atStop && a.blockedRwy != null && !(a.kind === "dep" && a.blockedRwy === a.depEnd.rwy)) {
        const r = apt.runways[a.blockedRwy];
        const busy = !this.runwayFree(r.id, a) || r.ends.some(e => this.nearestArrival(e) < 3 * NM);
        if (!busy) return `${cs}, cross runway ${r.ends[0].name}`;
        return null;
      }
      if (a.kind === "dep" && (s === "taxi" || s === "holding") && this.positions.TWR && !a.toldTwr &&
        (s === "holding" || (a.distToStop != null && a.distToStop < 350 && a.blockedRwy === a.depEnd.rwy))) {
        a.toldTwr = true;
        return `${cs}, ${this.contactPhrase("TWR")}`;
      }
      if (a.kind === "arr" && (s === "vacated" || s === "holding_short")) {
        if (!a.stand) a.stand = rnd(this.freeStands()) || null;
        if (!a.stand) return null;
        const via = this.viaNamesTo(a, a.stand.pos);
        return `${cs}, taxi to stand ${a.stand.name}${via.length ? " via " + via.join(" ") : ""}`;
      }
    }
    if (pos === "TWR") {
      const e = a.depEnd || this.depEnd;
      if (a.kind === "dep" && (s === "holding" || s === "lined_up")) {
        const arr = this.nearestArrival(e);
        const gap = this.lastTakeoff ? this.t - this.lastTakeoff.t : 999;
        const need = this.lastTakeoff && this.lastTakeoff.wtc === "H" && a.wtc !== "H" ? 125 : 70;
        if (this.runwayFree(e.rwy, a) && arr > 4 * NM && gap >= need) return `${cs}, runway ${e.name}, cleared for takeoff${this.windTxt()}`;
        if (s === "holding" && this.runwayFree(e.rwy, a) && arr > 5 * NM) return `${cs}, runway ${e.name}, line up and wait`;
        return null;
      }
      if (a.kind === "dep" && s === "airborne" && a.alt > 700) {
        const nx = this.nextDown("TWR", a);
        if (nx) return `${cs}, ${this.contactPhrase(nx)}`;
        return a.ga ? `${cs}, frequency change approved` : null;
      }
      if (a.kind === "dep" && s === "taxi" && a.atStop && a.blockedRwy != null && a.blockedRwy !== a.depEnd.rwy) {
        const r = apt.runways[a.blockedRwy];
        if (this.runwayFree(r.id, a) && r.ends.every(x => this.nearestArrival(x) > 3 * NM)) return `${cs}, cross runway ${r.ends[0].name}`;
      }
      if (a.kind === "arr" && s === "final") {
        const d = this.distToThr(a);
        if (!a.landClr && d < 6 * NM && this.runwayFree(a.end.rwy, a) &&
          !this.ac.some(o => o.kind === "dep" && ["lining", "lined_up", "roll"].includes(o.state) && o.depEnd.rwy === a.end.rwy))
          return `${cs}, runway ${a.end.name}, cleared to land${this.windTxt()}`;
        if (!a.landClr && d < 1.2 * NM && !a.nordo) return `${cs}, go around`;
      }
      if (a.kind === "arr" && (s === "vacated" || s === "vacating") && this.positions.GND && !a.toldGnd && s === "vacated") {
        a.toldGnd = true;
        return `${cs}, ${this.contactPhrase("GND")}`;
      }
    }
    if (pos === "APP") {
      if (a.kind === "arr" && s === "final") {
        if (!a.appCleared && a.calledIn) { a.appCleared = true; return `${cs}, identified, descend 3000 feet, cleared ILS approach runway ${a.end.name}`; }
        if (a.appCleared && this.distToThr(a) < 10 * NM && this.positions.TWR) return `${cs}, ${this.contactPhrase("TWR")}`;
      }
      if (a.kind === "dep" && !a.onGround) {
        if (!a.appIdent) { a.appIdent = true; return `${cs}, identified, climb flight level 120`; }
        if (a.alt > 4500 && this.positions.CTR) return `${cs}, ${this.contactPhrase("CTR")}`;
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
        a.state = "pushing";
        return `push and start approved${i.face ? ", facing " + i.face : ""}`;
      }
      case "taxi": {
        if (!a.onGround) return { unable: "Say again" };
        const end = apt.findRunwayEnd(i.rwy) || (a.kind === "dep" ? this.depEnd : null);
        if (!end) return { unable: `Say again runway` };
        if (a.kind === "arr") return { unable: "Confirm we taxi to the stand?" };
        if (!a.ga && ["parked", "push_req", "cleared", "clr_req", "pushing"].includes(a.state)) return { unable: "Unable, we are still on stand" };
        const start = this.startNode(a);
        const route = apt.routeToRunway(start.node, end, i.via, start.avoid) || apt.routeToRunway(start.node, end, i.via);
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
        const route = apt.routeToPos(start.node, st.pos, i.via, start.avoid) || apt.routeToPos(start.node, st.pos, i.via);
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
        this.serviced(a, "cross");
        a.crossOk.add(e.rwy); a.calledHold = false;
        return `cross runway ${i.rwy}`;
      }
      case "hold": a.holdPos = true; return "holding position";
      case "continue": a.holdPos = false; return "continue taxi";
      case "lineup": {
        if (a.kind !== "dep" || !["holding", "taxi"].includes(a.state)) return { unable: "Say again" };
        if (i.rwy && apt.findRunwayEnd(i.rwy) !== a.depEnd) return { unable: `Confirm runway, we are at holding point ${a.depEnd.name}` };
        this.serviced(a, "ready");
        this.lineUp(a, false);
        return `line up and wait runway ${a.depEnd.name}`;
      }
      case "takeoff": {
        if (a.kind !== "dep" || !["holding", "taxi", "lineup", "lining", "lined_up"].includes(a.state)) return { unable: "Say again" };
        if (i.rwy && apt.findRunwayEnd(i.rwy) !== a.depEnd) return { unable: `Confirm runway, we are at ${a.depEnd.name}` };
        const occupied = !this.runwayFree(a.depEnd.rwy, a);
        if (occupied && !a.confirmTO && !i.affirm) { a.confirmTO = true; return { special: "confirmTakeoff" }; }
        a.confirmTO = false;
        this.serviced(a, "ready");
        a.toClr = true;
        if (a.state === "lined_up") this.startRoll(a);
        else if (a.state === "holding" || a.state === "taxi") this.lineUp(a, true);
        return `cleared for takeoff runway ${a.depEnd.name}`;
      }
      case "land": {
        if (a.kind !== "arr" || a.state !== "final") return { unable: "Say again" };
        if (i.rwy && apt.findRunwayEnd(i.rwy) !== a.end) return { unable: `Confirm runway, we are established ${a.end.name}` };
        this.serviced(a, "land");
        a.landClr = true;
        return `cleared to land runway ${a.end.name}`;
      }
      case "goaround": {
        if (a.kind !== "arr" || a.state !== "final") return { unable: "Say again" };
        this.goAround(a, "instructed");
        return null;
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
      case "approach": return `cleared ILS approach runway ${a.end ? a.end.name : this.arrEnd.name}`;
      case "identified": return null;
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
    }));
  }

  /** The aircraft on a position's frequency (for voice casting: no two identical voices on one frequency). */
  onFrequency(pos) { return this.ac.filter(a => !a.quiet && (!a.veh ? this.hears(a, pos) : a.freq === pos || !this.split)); }
}

const capFirstObj = (r) => ({ d: cap(r.d), s: cap(r.s) });
