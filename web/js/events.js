// Abnormal and emergency events, and the ground vehicles that need clearances: tug tows, the fire service
// ("Rescue 1"), runway inspections ("Ops 2"), snow ploughs. Installed into Sim (installEvents).
import { dist, vecFromHdg, hdgOf, KT } from "./airport.js";
import { rint, rnd } from "./data.js";
import { pilotCall } from "./phrase.js";

const NM = 1852;

export const CHECKLISTS = {
  mayday: ["Acknowledge the MAYDAY and give priority", "Alert the fire service: 'Rescue 1, full emergency, runway …'", "Clear the runway: stop departures, send arrivals around", "Ask souls on board and fuel remaining", "Inform Approach / Centre and the airport authority"],
  pan: ["Acknowledge the PAN PAN and give priority", "Alert the fire service: 'Rescue 1, local standby'", "Keep the runway available, delay departures", "Ask the crew what assistance they need"],
  medical: ["Acknowledge, ask the nature of the medical case", "Arrange an ambulance at the stand (handling / airport authority)", "Give priority for taxi to the stand if asked"],
  rto: ["Confirm the aircraft is stopping / stopped", "Send the next arrival around if inside 4 NM", "Ask if assistance is needed; alert Rescue 1 if requested", "Runway inspection before the next movement ('Ops 2, inspect runway …')"],
  fod: ["Stop departures and arrivals on that runway", "Send Ops 2 for a runway inspection", "Reopen the runway when Ops 2 reports it clear"],
  incursion: ["Instruct the aircraft/vehicle to stop immediately", "Send the arrival around if inside 2 NM", "File it: note the time and who was involved"],
  hijack: ["Do not challenge the crew; 'confirm squawk 7500' only", "Clear the runway and give priority", "Inform the police and the supervisor", "Taxi to the isolated stand after landing"],
  rcf: ["Try 'if you read, squawk ident'", "Clear the runway for the expected landing", "Use the light gun on the ground", "Send the follow-me to the stand"],
  birdstrike: ["Acknowledge, ask intentions", "Give priority for the return, clear the runway", "Alert Rescue 1 (local standby)", "Runway inspection for bird remains afterwards"],
  breakdown: ["Confirm the position and that the taxiway is blocked", "Re-route other traffic around it", "Send a tug ('Tug 1 tow approved …')"],
};

export function installEvents(Sim) {
  const P = Sim.prototype;

  P.vehicleOf = function (vtype) { return this.ac.find(a => a.veh && a.vtype === vtype && !a.gone); };
  P.vehicleFor = function (vtype, pos) {
    let v = this.vehicleOf(vtype);
    if (!v) {
      // parked beside the base node (not on the taxiway) until it gets a task
      const base = this.apt.nodes[this.vehicleBase()];
      const at = pos || [base[0] + 30, base[1] + 30];
      v = this.spawnVehicle({ vtype, pos: at, freq: "GND", maxSpd: vtype === "fire" ? 16 : 10 }); v.state = "idle";
    }
    return v;
  };

  /** A vehicle asks for something on the radio and waits for it. */
  P.vehicleRequest = function (v, what, pos = "TWR", kind = "request") {
    v.freq = this.split ? pos : "ALL"; v.reqAt = this.t; v.wants = kind;
    this.call(v, "vehRequest", { what, greet: "" }, pos);
  };

  // ---------- runway inspection (Ops) ----------
  P.runwayInspection = function (rwy, why = "routine") {
    const r = this.apt.runways[rwy];
    const v = this.vehicleFor("ops");
    if (v.task) return v;
    const e0 = r.ends[0];
    const entry = this.apt.entries(e0)[0];
    if (!entry) return null;
    v.task = { kind: "inspection", rwy, why, stage: "toRunway", entry };
    v.target = null;
    const start = this.startNode(v);
    const route = this.apt.routeNodes(start.node, entry.node);
    if (!route) { v.task = null; return null; }
    this.setPath(v, route); v.state = "task"; v.crossOk = new Set();
    v.onDone = () => this.inspectionNext(v);
    this.vehicleRequest(v, `request to enter runway ${r.label} for a runway inspection${why !== "routine" ? ", " + why : ""}, ${why === "routine" ? "5" : "10"} minutes`, "TWR", "enter");
    this.closedRunways.add(rwy);
    this.onEvent({ type: "inspection", veh: v, rwy, why });
    return v;
  };
  P.inspectionNext = function (v) {
    const t = v.task; if (!t) return;
    if (t.stage === "toRunway") {
      // waits at the holding point until cleared to enter (crossOk given by "enter runway" / "cross")
      v.holdPos = !v.crossOk.has(t.rwy);
      if (v.holdPos) { v.onDone = () => this.inspectionNext(v); v.pi = v.path.length; return; }
      const r = this.apt.runways[t.rwy], e = r.ends[0];
      const far = [e.pos[0] + e.v[0] * (r.len - 60), e.pos[1] + e.v[1] * (r.len - 60)];
      const back = [e.pos[0] + e.v[0] * 60, e.pos[1] + e.v[1] * 60];
      v.path = [[...v.pos, null], [...far, null], [...back, null], [...this.apt.nodes[t.entry.node], t.entry.node]]; v.pi = 1; v.maxSpd = 9;
      t.stage = "inspecting"; v.onDone = () => this.inspectionNext(v);
    } else if (t.stage === "inspecting") {
      const exit = this.apt.exitRoute(t.entry.node, t.rwy, null);
      if (exit) { v.path = [[...v.pos, null], ...exit.map(n => [...this.apt.nodes[n], n])]; v.pi = 1; }
      t.stage = "vacating"; v.onDone = () => this.inspectionNext(v);
      this.call(v, "vehVacated", { rwy: this.apt.runways[t.rwy].label, greet: "" }, "TWR");
      this.vehicleRequest(v, `runway ${this.apt.runways[t.rwy].label} inspected${t.why === "fod" ? ", FOD removed" : t.why === "rto" ? ", no debris found" : ""}, runway is clear`, "TWR", "report");
      this.closedRunways.delete(t.rwy);
      if (this.fod && this.fod.rwy === t.rwy) this.fod = null;
      this.onEvent({ type: "inspectionDone", veh: v, rwy: t.rwy });
    } else { v.task = null; v.onDone = null; v.crossOk.clear(); this.vehicleHome(v); }
  };

  // ---------- fire service ----------
  P.rescueRespond = function (target, level) {
    const v = this.vehicleFor("fire");
    v.rescueLevel = level; v.target = target; v.task = { kind: "rescue", level };
    if (level === "full") {
      // drives to the runway entry (or to the aircraft on the ground) and waits beside the taxiway
      const goal = target && target.onGround ? this.startNode(target).node : (this.apt.entries(this.arrEnd)[0] || {}).node;
      const start = this.startNode(v);
      const route = goal != null ? this.apt.routeNodes(start.node, goal) : null;
      if (route) {
        this.setPath(v, route); v.state = "task"; v.crossOk = new Set();
        v.onDone = () => {
          const h = v.hdg + 90, vv = vecFromHdg(h);
          v.path = [[v.pos[0] + vv[0] * 35, v.pos[1] + vv[1] * 35, null]]; v.pi = 0; v.blockedRwy = null; v.holdPos = false;
          v.onDone = () => { v.task = null; v.onDone = null; v.pauseUntil = this.t + 600; v.standby = true; };
        };
      }
    } else { v.state = "idle"; v.pauseUntil = this.t + 300; }
    this.vehicleRequest(v, level === "full" ? `${target ? "responding to " + this.cs(target).d + ", " : ""}request to proceed to the runway` : `local standby, holding at the fire station`, "TWR", "proceed");
    this.onEvent({ type: "rescue", veh: v, level, ac: target });
    return v;
  };

  // ---------- tug tows ----------
  P.towRequest = function (a) {
    if (!a || !a.onGround) return null;
    const v = this.vehicleFor("tug");
    if (v.task) return null;
    const dest = this.apt.stands.find(s => /hangar|maint/i.test(s.name) && s.node != null) || rnd(this.freeStands(["gate", "misc"])) || null;
    if (!dest) return null;
    v.task = { kind: "tow", ac: a, dest, stage: "toAircraft" };
    const start = this.startNode(v), as = this.startNode(a, true);
    const route = this.apt.routeNodes(start.node, as.node);
    if (!route) { v.task = null; return null; }
    this.setPath(v, route); v.state = "task"; v.crossOk = new Set(); v.target = a; v.targetCs = a.cs;
    v.onDone = () => this.towNext(v);
    const via = this.namesOf(this.apt.routeToPos(as.node, dest.pos, []) || []);
    this.vehicleRequest(v, `with ${this.cs(a).d}, request tow from ${a.stand ? "stand " + a.stand.name : "present position"} to ${dest.name}${via.length ? " via " + via.join(" ") : ""}`, "GND", "tow");
    a.towed = v; a.state = a.state === "parked" ? "parked" : "broken";
    this.onEvent({ type: "tow", veh: v, ac: a, dest });
    return v;
  };
  P.towNext = function (v) {
    const t = v.task; if (!t) return;
    const a = t.ac;
    if (t.stage === "toAircraft") {
      if (!v.towOk) { v.holdPos = true; v.pi = v.path.length; v.onDone = () => this.towNext(v); return; }   // waits for "tow approved"
      const as = this.startNode(v);
      const route = this.apt.routeToPos(as.node, t.dest.pos, [], as.avoid) || this.apt.routeToPos(as.node, t.dest.pos, []);
      if (!route) { v.task = null; this.vehicleHome(v); return; }
      this.setPath(v, route); v.holdPos = false; t.stage = "towing"; v.maxSpd = 4;
      a.leader = v; a.path = null; a.towing = true; a.state = "towed"; a.stand = null; a.holdPos = false;
      if (a.stand) a.stand = null;
      v.onDone = () => this.towNext(v);
    } else if (t.stage === "towing") {
      a.towing = false; a.leader = null; a.stand = t.dest; a.pos = [...t.dest.pos]; a.hdg = t.dest.hdg; a.state = "parked"; a.parkedAt = this.t; a.towed = null; a.broken = false;
      if (a.blockedEdges) { for (const e of a.blockedEdges) this.blockedEdges.delete(e); a.blockedEdges = null; }
      a.dormant = true; a.callAt = Infinity; a.kind = "dep";
      v.task = null; v.onDone = null; v.towOk = false; v.target = null;
      this.call(v, "stillWaitingGeneric", { what: `tow complete at ${t.dest.name}`, greet: "" }, "GND");
      this.vehicleHome(v);
      this.onEvent({ type: "towDone", veh: v, ac: a });
    }
  };
  /** The towed aircraft follows the tug exactly. */
  P.towedTick = function (a) {
    const v = a.towed; if (!v || !a.towing) return;
    const back = vecFromHdg(v.hdg);
    a.pos = [v.pos[0] - back[0] * 9, v.pos[1] - back[1] * 9]; a.hdg = v.hdg; a.spd = v.spd; a.onGround = true;
  };

  // ---------- snow ploughs ----------
  P.snowClearing = function (rwy) {
    const v = this.vehicleFor("snow");
    if (v.task) return v;
    const r = this.apt.runways[rwy], entry = this.apt.entries(r.ends[0])[0];
    if (!entry) return null;
    v.task = { kind: "inspection", rwy, why: "snow clearing", stage: "toRunway", entry };
    const start = this.startNode(v);
    const route = this.apt.routeNodes(start.node, entry.node);
    if (!route) { v.task = null; return null; }
    this.setPath(v, route); v.state = "task"; v.crossOk = new Set(); v.maxSpd = 7;
    v.onDone = () => this.inspectionNext(v);
    this.vehicleRequest(v, `request runway ${r.label} for snow clearing, 20 minutes`, "TWR", "enter");
    this.onEvent({ type: "snow", veh: v, rwy });
    return v;
  };

  // ---------- abnormal events ----------
  P.scheduleAbnormal = function () {
    const per = this.abnormals && this.abnormals.on ? Math.max(0.1, this.abnormals.perHour || 2) : 0;
    this.nextAbnormal = per ? this.t + 3600 / per * (0.5 + Math.random()) : Infinity;
  };
  P.eventsTick = function () {
    if (this.nextAbnormal == null) this.scheduleAbnormal();
    if (this.abnormals && this.abnormals.on && this.t >= this.nextAbnormal) { this.scheduleAbnormal(); this.abnormalEvent(); }
    for (const a of this.ac) {
      if (a.towing) this.towedTick(a);
      if (a.state === "rto") this.rtoTick(a);
      if (a.state === "inbound") this.vfrInboundTick(a);
      if (a.kind === "dep" && a.state === "airborne" && a.birdstrike && !a.birdCalled && a.alt > 600) { a.birdCalled = true; a.rejoin = true; a.priority = "pan";
        this.pilot(a, pilotCall("pan", { st: a.style, cs: this.cs(a), unit: this.unitFor(a, "TWR"), what: "bird strike on departure, request return to land", rwy: a.depEnd.name }), "pan");
        this.onEvent({ type: "abnormal", kind: "birdstrike", ac: a }); }
    }
    // snow: a plough asks for the runway every ~40 min while it snows
    if (this.snow && (this.lastSnowRun == null || this.t - this.lastSnowRun > 2400) && !this.vehicleOf("snow")?.task) { this.lastSnowRun = this.t; this.snowClearing(this.depEnd.rwy); }
  };

  /** Pick and trigger one abnormal event (returns its kind or null). */
  P.abnormalEvent = function (force) {
    const kinds = ["medical", "birdstrike", "rto", "breakdown", "fod", "incursion", "unstable", "pan", "mayday", "7500", "7600"];
    const kind = force || rnd(kinds);
    const arrivals = this.ac.filter(a => a.kind === "arr" && a.state === "final" && !a.ga && !a.nordo && !a.mayday && this.distToThr(a) > 6 * NM);
    const deps = this.ac.filter(a => a.kind === "dep" && !a.ga && !a.nordo);
    const taxiing = deps.filter(a => a.state === "taxi" && a.onGround && !a.leader);
    const holding = deps.filter(a => ["holding", "lined_up"].includes(a.state));
    let a = null;
    switch (kind) {
      case "medical":
        a = rnd(arrivals) || rnd(taxiing); if (!a) return null;
        a.medical = true; a.priority = "medical";
        this.call(a, "stillWaitingGeneric", { what: "we have a medical emergency on board, passenger unconscious, request ambulance on arrival and priority", greet: "" }, a.kind === "arr" ? "TWR" : "GND");
        break;
      case "birdstrike":
        a = holding[0] || deps.find(x => x.state === "roll"); if (!a) return null;
        a.birdstrike = true;        // fires after takeoff (eventsTick)
        return "birdstrike";
      case "rto":
        a = deps.find(x => x.state === "roll" && x.spd < 60 * KT) || holding.find(x => x.state === "lined_up"); if (!a) return null;
        this.rejectTakeoff(a, "engine indication");
        break;
      case "breakdown":
        a = rnd(taxiing); if (!a) return null;
        this.breakdown(a);
        break;
      case "fod":
        a = rnd(arrivals) || rnd(holding); if (!a) return null;
        this.call(a, "stillWaitingGeneric", { what: `be advised, we saw debris on the runway ${this.depEnd.name} near the intersection, looks like a piece of metal`, greet: "" }, "TWR");
        this.fod = { rwy: this.depEnd.rwy, t: this.t };
        this.alert(`${a.cs} reports FOD on runway ${this.depEnd.name} — stop movements and send Ops 2 for an inspection.`, "fod" + this.t);
        this.onEvent({ type: "abnormal", kind: "fod", ac: a, checklist: CHECKLISTS.fod });
        return "fod";
      case "incursion": {
        const v = this.vehicleFor("ops"); const e = this.depEnd; const entry = this.apt.entries(e)[0]; if (!entry || v.task) return null;
        const start = this.startNode(v); const route = this.apt.routeNodes(start.node, entry.node); if (!route) return null;
        this.setPath(v, route); v.state = "task"; v.crossOk = new Set([e.rwy]); v.task = { kind: "incursion", rwy: e.rwy }; v.maxSpd = 9;
        v.onDone = () => { v.task = null; v.onDone = null; v.crossOk.clear(); this.vehicleHome(v); };
        this.alert(`Runway incursion: ${v.cs} is entering runway ${e.name} without clearance — stop it ("${v.cs} stop immediately") and send any arrival around.`, "incursion" + this.t);
        this.onEvent({ type: "abnormal", kind: "incursion", veh: v, checklist: CHECKLISTS.incursion });
        return "incursion";
      }
      case "unstable":
        a = this.ac.find(x => x.kind === "arr" && x.state === "final" && this.distToThr(x) < 3 * NM && this.distToThr(x) > 1.2 * NM); if (!a) return null;
        a.unstable = true; this.goAround(a, "unstable approach");
        break;
      case "pan":
        a = rnd(arrivals); if (!a) return null;
        a.priority = "pan"; a.pan = true;
        this.pilot(a, pilotCall("pan", { st: a.style, cs: this.cs(a), unit: this.unitFor(a, "TWR"), what: rnd(["hydraulic failure", "smoke in the cabin", "pressurisation problem"]) + ", request priority landing", rwy: a.end.name }), "pan");
        break;
      case "mayday":
        a = rnd(arrivals); if (!a) return null;
        this.triggerEvent("7700", a);
        break;
      case "7500":
        a = rnd(arrivals); if (!a) return null;
        this.triggerEvent("7500", a);
        break;
      case "7600":
        a = rnd(arrivals); if (!a) return null;
        this.triggerEvent("7600", a);
        break;
    }
    const cl = CHECKLISTS[{ medical: "medical", rto: "rto", breakdown: "breakdown", unstable: null, pan: "pan", mayday: "mayday", "7500": "hijack", "7600": "rcf" }[kind]] || null;
    this.onEvent({ type: "abnormal", kind, ac: a, checklist: cl });
    return kind;
  };

  /** Rejected takeoff: the aircraft stops on the runway and asks for help. */
  P.rejectTakeoff = function (a, why = "engine indication") {
    if (!["roll", "lined_up", "lining", "lineup"].includes(a.state)) return false;
    a.state = "rto"; a.toClr = false; a.rtoWhy = why; a.onGround = true;
    this.pilot(a, { d: `${this.cs(a).d}, stopping, stopping`, s: `${this.cs(a).s}, stopping, stopping` }, "rto");
    this.alert(`${a.cs} rejected the takeoff on runway ${a.depEnd.name} (${why}).`, "rto" + a.cs);
    return true;
  };
  P.rtoTick = function (a) {
    if (a.spd > 0.5) { a.spd = Math.max(0, a.spd - 3.5 * 1); const v = a.depEnd.v; a.pos = [a.pos[0] + v[0] * a.spd, a.pos[1] + v[1] * a.spd]; return; }
    if (!a.rtoCalled) {
      a.rtoCalled = true; a.reqAt = this.t;
      this.call(a, "stillWaitingGeneric", { what: `stopped on the runway, ${a.rtoWhy}, ${Math.random() < 0.5 ? "brakes are hot, request the fire service to have a look, then we can vacate" : "request to vacate the runway and return to the stand"}`, greet: "" }, "TWR");
    }
  };
  /** "vacate runway": an aircraft stopped on the runway taxis off at the next exit. */
  P.vacateRunway = function (a) {
    const r = this.apt.runways.find(R => this.apt.onRunway(a.pos, R, 5));
    if (!r) return false;
    const near = [...this.apt.rwyNodes[r.id]].map(n => [n, dist(this.apt.nodes[n], a.pos)]).sort((x, y) => x[1] - y[1]);
    for (const [n] of near) {
      const route = this.apt.exitRoute(n, r.id, null);
      if (!route) continue;
      a.path = [[...a.pos, null], ...route.map(k => [...this.apt.nodes[k], k])]; a.pi = 1;
      a.crossOk.add(r.id); a.state = "vacating"; a.kind = "arr"; a.end = a.end || a.depEnd; a.exitName = ""; a.holdPos = false; a.maxSpd = null;
      a.stand = a.stand || rnd(this.freeStands()) || null;
      this.fod = { rwy: r.id, t: this.t, why: "rto" };
      return true;
    }
    return false;
  };
  /** A taxiing aircraft breaks down and blocks its taxiway until towed. */
  P.breakdown = function (a) {
    a.state = "broken"; a.holdPos = true; a.spd = 0; a.broken = true;
    const j = Math.max(0, a.pi - 1);
    const p = a.path;
    const edges = new Set();
    if (p && p[j] && p[j + 1] && p[j][2] != null && p[j + 1][2] != null) { const e = this.apt.edgeBetween(p[j][2], p[j + 1][2]); if (e && e.i != null) edges.add(e.i); }
    const near = this.apt.nearestEdge(a.pos, 60, false); if (near && near.e.i != null) edges.add(near.e.i);
    for (const e of edges) this.blockedEdges.add(e);
    a.blockedEdges = edges;
    const twy = (near && near.e.name) || (this.apt.nearestEdge(a.pos, 120) || { e: {} }).e.name || "";
    this.call(a, "stillWaitingGeneric", { what: `we have a hydraulic problem, unable to taxi, we are stopped${twy ? " on taxiway " + twy : ""}, request a tug`, greet: "" }, "GND");
    this.alert(`${a.cs} broke down${twy ? " on taxiway " + twy : ""} — it blocks the taxiway until towed ('Tug 1 tow approved').`, "brk" + a.cs);
    // traffic already routed through the blocked edge re-plans
    for (const o of this.ac) {
      if (o === a || !o.path || !o.onGround || o.veh) continue;
      const hit = o.path.some((q, k) => k + 1 < o.path.length && q[2] != null && o.path[k + 1][2] != null && k >= o.pi - 1 && edges.has((this.apt.edgeBetween(q[2], o.path[k + 1][2]) || {}).i));
      if (hit) o.replan = true;
    }
  };
}
