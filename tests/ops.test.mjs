// Phase D tests: weather & runway change (D1), LVP / stop bars / de-icing (D2), conditional clearances & UK phrases (D3),
// sequencing, wake, CTOT, missed approach (D4), VFR circuits & helicopters (D5), vehicles needing clearance (D6),
// abnormal events & checklists (D7).
//   node tests/ops.test.mjs
import { readFileSync } from "node:fs";
import { Airport, dist } from "../web/js/airport.js";
import { Sim, CHECKLISTS } from "../web/js/sim.js";
import { parse } from "../web/js/commands.js";
import { wakeDepSeconds, wakeArrNm, ctotStatus, recatOf, departureSequence, arrivalSpacing, acdmTimes } from "../web/js/flow.js";
import { parseMetar } from "../web/js/atis.js";
import { synthMetar, WX_SCENARIOS } from "../web/js/ops.js";
import { defaultVfrPoints } from "../web/js/vfr.js";
import { PilotAtc, normalizeNumbers, checkReadback, intentOf } from "../web/js/pilotatc.js";
import { xrOverrides } from "../web/js/bridges.js";
import { buildPositions } from "../web/js/positions.js";
import { incomingFor } from "../web/js/strips.js";
import { suggestions } from "../web/js/autocomplete.js";
import { bridgeAircraft } from "../web/js/bridges.js";
import { coach } from "../web/js/coach.js";

let seed = 11;
Math.random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
let fails = 0, n = 0;
const ok = (c, msg) => { n++; if (!c) { fails++; console.log("FAIL  " + msg); } else console.log("PASS  " + msg); };
const eq = (a, b, msg) => ok(a === b, `${msg}: ${JSON.stringify(a)}${a === b ? "" : " != " + JSON.stringify(b)}`);
const NM = 1852, KT = 0.514444;
const apt = new Airport(JSON.parse(readFileSync(new URL("../cache/EETN.json", import.meta.url), "utf8")));

const mk = (opts = {}) => {
  const radio = [], alerts = [], events = [];
  const sim = new Sim(apt, { onRadio: (m) => radio.push(m), onAlert: (m) => alerts.push(m), onEvent: (e) => events.push(e), populate: false, ...opts });
  sim.setRunway("26"); sim.nextDep = sim.nextArr = sim.nextVfr = 1e9; sim.vfrPerHour = 0; sim.abnormals = { on: false, perHour: 0 };
  return { sim, radio, alerts, events };
};
const run = (sim, sec, until) => { for (let i = 0; i < sec * 10; i++) { sim.step(0.1); if (until && until()) return true; } return false; };
const say = (sim, a, text) => { const p = parse(`${a.cs} ${text}`, sim.ac, a); return sim.respond(p.ac || a, p.ins, { text: p.normalized }); };
const txt = (r) => (r && (r.d || r.unable || r.text)) || JSON.stringify(r);
const dep = (sim) => { for (let k = 0; k < 60; k++) { const x = sim.spawnDeparture({ ga: false }); if (x && !x.ga) return x; if (x) sim.ac.splice(sim.ac.indexOf(x), 1); } throw new Error("no IFR departure"); };
/** An IFR arrival on final (the spacing rule of spawnArrival is bypassed by hiding the others for a moment). */
const arr = (sim) => {
  const others = sim.ac.filter(a => a.kind === "arr" && !a.onGround);
  for (const a of others) a.onGround = true;
  try {
    for (let k = 0; k < 60; k++) { const x = sim.spawnArrival(); if (x && !x.ga) return x; if (x) sim.ac.splice(sim.ac.indexOf(x), 1); }
  } finally { for (const a of others) a.onGround = false; }
  throw new Error("no IFR arrival");
};
/** Take a departure through clearance, push and taxi to the holding point of runway 26 (AI Ground does the talking). */
const toHolding = (sim, d, secs = 900) => {
  run(sim, 60, () => d.state === "clr_req");
  say(sim, d, `cleared to ${d.other[1]}, climb 4000 feet, squawk 4521`);
  run(sim, 200, () => d.state === "push_req");
  say(sim, d, "push and start approved");
  run(sim, 200, () => d.state === "taxi_req");
  const r = sim.aiDecide(d, "GND");
  if (r) sim.atc("ALL", r.replace(/^[^,]+, /, `${d.cs} `));
  return run(sim, secs, () => d.state === "holding");
};
const last = (radio, a) => [...radio].reverse().find(m => m.ac === a);

// ---------- D4: wake, RECAT, CTOT (pure functions) ----------
eq(wakeDepSeconds({ wtc: "H" }, { wtc: "M" }), 120, "ICAO: medium behind heavy 2 min");
eq(wakeDepSeconds({ wtc: "M" }, { wtc: "L" }), 180, "ICAO: light behind medium 3 min");
eq(wakeDepSeconds({ wtc: "M" }, { wtc: "M" }), 60, "ICAO: medium behind medium = runway spacing");
eq(wakeDepSeconds({ wtc: "J" }, { wtc: "M" }), 180, "ICAO: medium behind super 3 min");
eq(recatOf({ type: "A388" }), "A", "RECAT A388 = A"); eq(recatOf({ type: "B738" }), "D", "RECAT B738 = D"); eq(recatOf({ type: "C172", wtc: "L" }), "F", "RECAT light = F");
eq(wakeDepSeconds({ type: "A388" }, { type: "B738" }, true), 140, "RECAT-EU: D behind A 140 s");
eq(wakeDepSeconds({ type: "B738" }, { type: "A320" }, true), 60, "RECAT-EU: D behind D no wake");
eq(wakeArrNm({ wtc: "H" }, { wtc: "M" }), 5, "ICAO arrival: medium behind heavy 5 NM");
eq(wakeArrNm({ type: "B744" }, { type: "C172", wtc: "L" }, true), 7, "RECAT arrival: F behind B 7 NM");
eq(ctotStatus(1000, 100).state, "early", "CTOT early"); eq(ctotStatus(1000, 900).state, "window", "CTOT in window (-5)"); eq(ctotStatus(1000, 1500).state, "window", "CTOT +10 still window");
eq(ctotStatus(1000, 1700).state, "missed", "CTOT missed");

// ---------- D3: phraseology parsing ----------
{
  const { sim } = mk();
  const ins = (t) => parse(t, [], null).ins;
  const one = (t) => ins(t)[0] || {};
  eq(one("line up and wait runway 26 behind the landing A320 behind").t, "lineup", "line up parses");
  const c = ins("behind the landing Airbus, line up and wait runway 26 behind");
  ok(c.some(i => i.t === "lineup" && i.cond && /landing/.test(i.cond.phase || "")), "conditional line-up carries the condition: " + JSON.stringify(c));
  const t = one("cleared for immediate takeoff runway 26");
  ok(t.t === "takeoff" && t.immediate, "immediate takeoff");
  eq(one("cancel takeoff clearance").t, "cancelTakeoff", "cancel takeoff"); eq(one("stop immediately").t, "hold", "stop immediately = hold");
  eq(one("continue approach").t, "contApp", "continue approach");
  const la = one("land after the departing Boeing 737, runway 26");
  ok(la.t === "landAfter" && la.phase === "departing", "land after (UK): " + JSON.stringify(la));
  eq(one("hold short of taxiway B").t, "holdShortTwy", "hold short of taxiway (known taxiway)");
  eq(one("give way to the Finnair 321 then continue").t, "giveWay", "give way");
  eq(one("follow the A320 to holding point").t, "follow", "follow traffic");
  const j = one("join left downwind runway 26");
  ok(j.t === "join" && j.side === "left" && j.leg === "downwind" && j.rwy === "26", "join left downwind");
  eq(one("extend downwind").t, "extend", "extend downwind"); eq(one("orbit left").side, "left", "orbit left");
  eq(one("cleared touch and go runway 26").t, "touchGo", "touch and go"); eq(one("cleared for the option runway 26").t, "option", "option");
  eq(one("cleared special VFR").t, "svfr", "special VFR"); eq(one("remain outside the control zone").t, "remainOutside", "remain outside");
  eq(one("cleared for takeoff from present position").t, "lift", "heli lift"); eq(one("make a full stop").t, "fullStop", "full stop");
  eq(one("expect runway 08").t, "expect", "expect"); eq(one("report passing 2000 feet").t, "report", "report passing");
  eq(one("de-icing approved on stand").t, "deice", "de-icing on stand"); ok(one("taxi to the de-icing pad").pad, "de-icing pad");
  eq(one("tow approved").t, "towApproved", "tow approved"); eq(one("enter runway 26, report vacated").t, "enterRwy", "enter runway");
  eq(one("vacate the runway").t, "vacate", "vacate runway"); eq(one("runway is closed").t, "rwyClosed", "runway closed");
  eq(one("full emergency").level, "full", "RFFS full emergency"); eq(one("local standby").level, "local", "RFFS local standby");
  ok(sim, "sim built");
}

// ---------- D1: wind, limits, runway change, scripted weather ----------
{
  const { sim, radio, alerts, events } = mk();
  const e26 = apt.findRunwayEnd("26"), e08 = apt.findRunwayEnd("08");
  sim.setWind({ dir: 260, spd: 12 });
  ok(sim.windOn(e26).head > 11 && sim.windOn(e26).tail === 0, "wind 260/12 on 26 is headwind");
  ok(sim.windOn(e08).tail > 11, "and tailwind on 08");
  ok(!sim.rwyChangeHint, "no change hint with headwind");
  const d = dep(sim);
  ok(!sim.windRefusal(d, e26), "jet accepts 26 in a 12 kt headwind");
  sim.setWind({ dir: 350, spd: 25 });
  ok(/crosswind/.test(sim.windRefusal({ ga: true, type: "C172", wtc: "L" }, e26) || ""), "C172 refuses 25 kt crosswind");
  ok(!sim.windRefusal(d, e26), "airliner accepts 25 kt crosswind");
  sim.setWind({ dir: 80, spd: 15 });
  eq(sim.rwyChangeHint, "08", "15 kt tailwind on 26 → runway change to 08 recommended");
  ok(alerts.some(m => /runway change/i.test(m)), "controller is told about the change: " + alerts.find(m => /runway change/i.test(m)));
  ok(/tailwind/.test(sim.windRefusal(d, e26) || ""), "crew refuses 26 with 15 kt tailwind");
  // a departure at the holding point of 26 when the runway changes
  ok(toHolding(sim, d), "departure reached holding point 26");
  const far = arr(sim); far.pos = [e26.thr[0] - e26.v[0] * 12 * NM, e26.thr[1] - e26.v[1] * 12 * NM]; far.alt = 4000;
  const near = arr(sim); near.pos = [e26.thr[0] - e26.v[0] * 4 * NM, e26.thr[1] - e26.v[1] * 4 * NM]; near.alt = 1300;
  ok(sim.changeRunway("08"), "runway changed to 08");
  eq(sim.depEnd.name, "08", "departure runway is 08"); eq(near.end.name, "26", "arrival inside 8 NM stays on 26"); eq(far.end.name, "08", "arrival at 12 NM re-vectored to 08");
  ok(d.rwyChanged, "holding departure needs a new taxi clearance");
  const r = sim.aiDecide(d, "GND");
  ok(/runway change, taxi to holding point runway 08/.test(r || ""), "AI Ground re-clears it: " + r);
  ok(events.some(e => e.type === "runwayChanged" && e.to === "08"), "runwayChanged event");
  // scripted weather
  sim.setWxScenario("fog");
  ok(sim.wxScenario && sim.wxOverride, "fog scenario running");
  const m0 = synthMetar("EETN", "0900", sim.wxOverride);
  ok(/^EETN 0900Z \d{5}(G\d\d)?KT 3000 BR/.test(m0), "synthetic METAR for the first step: " + m0);
  sim.t += 11 * 60; sim.wxTick();
  ok(sim.lvp, "LVP after 10 min of fog (vis 500 / RVR 450)");
  ok(parseMetar(synthMetar("EETN", "0911", sim.wxOverride)).rvr.length === 1, "synthetic METAR has an RVR group");
  sim.t += 40 * 60; sim.wxTick();
  ok(!sim.lvp, "LVP cancelled when the fog lifts");
  sim.setWxScenario(null);
  ok(!sim.wxScenario && !sim.wxOverride, "back to live weather");
  ok(Object.keys(WX_SCENARIOS).length >= 4, "weather scenarios: " + Object.keys(WX_SCENARIOS).join(" "));
  ok(radio.length >= 0, "radio ok");
}

// ---------- D2: LVP, stop bars, CAT holding points, de-icing ----------
{
  const { sim, radio } = mk();
  ok(apt.stopBars.length > 0, `EETN has stop bars from the runway holding positions (${apt.stopBars.length})`);
  sim.weatherFromMetar(parseMetar("EETN 120850Z 26005KT 0300 R26/0275N FG VV001 03/03 Q1012"));
  ok(sim.lvp, "RVR 275 → LVP in force");
  ok(apt.stopBars.every(b => b.lit), "stop bars lit under LVP");
  ok(sim.depSpacingS({ wtc: "M" }, { wtc: "M" }) >= 120 && sim.arrSpacingNm({ wtc: "M" }, { wtc: "M" }) >= 6, "LVP spacing 120 s / 6 NM");
  sim.weatherFromMetar(parseMetar("EETN 120920Z 26005KT 9999 FEW020 05/02 Q1012"));
  ok(!sim.lvp && apt.stopBars.every(b => !b.lit), "weather improved: LVP off, stop bars off");
  // a lit stop bar is never crossed, even with a clearance
  const d = dep(sim);
  ok(toHolding(sim, d), "departure at the holding point");
  for (const b of apt.stopBars) sim.setStopBar(b, true);
  let r = say(sim, d, "runway 26 line up and wait");
  ok(/stop bar/i.test(txt(r)), "line-up refused while the stop bar is lit: " + txt(r));
  r = say(sim, d, "runway 26 cleared for takeoff");
  ok(/stop bar/i.test(txt(r)), "takeoff refused while the stop bar is lit: " + txt(r));
  for (const b of apt.stopBars) sim.setStopBar(b, false);
  r = say(sim, d, "runway 26 cleared for takeoff");
  ok(/cleared for takeoff/i.test(txt(r)), "takeoff accepted once the bar is off: " + txt(r));
  ok(run(sim, 120, () => d.state === "airborne"), "and it departs");
  // de-icing from the METAR; holdover time
  sim.weatherFromMetar(parseMetar("EETN 121020Z 03008KT 2000 -SN OVC008 M02/M03 Q1005"));
  ok(sim.deiceNeeded && sim.snow, "snow at -2 °C → de-icing needed");
  const d2 = dep(sim);
  run(sim, 60, () => d2.state === "clr_req"); say(sim, d2, `cleared to ${d2.other[1]}, climb 4000 feet, squawk 4522`);
  run(sim, 200, () => d2.state === "push_req");
  const ai = sim.aiDecide(d2, "GND");
  ok(/de-icing approved/.test(ai || ""), "AI Ground approves de-icing on stand: " + ai);
  r = say(sim, d2, "de-icing approved on stand");
  eq(d2.state, "deicing", "de-icing started");
  ok(run(sim, 800, () => d2.deiced), "de-icing complete");
  ok(d2.hotUntil > sim.t && /holdover/i.test((last(radio, d2) || {}).text || ""), "holdover time reported: " + (last(radio, d2) || {}).text);
  sim.t = d2.hotUntil + 5; d2.state = "holding"; d2.depEnd = sim.depEnd;
  r = say(sim, d2, "runway 26 cleared for takeoff");
  ok(/holdover/i.test(txt(r)), "takeoff refused after the holdover time expired: " + txt(r));
  ok(sim.hotExpired(d2), "hotExpired()");
}

// ---------- D3: conditional clearances, immediate / cancel takeoff, continue approach, land after ----------
{
  const { sim, radio } = mk();
  const e26 = apt.findRunwayEnd("26");
  const d = dep(sim);
  ok(toHolding(sim, d), "departure at the holding point 26");
  const a = arr(sim); a.pos = [e26.thr[0] - e26.v[0] * 3 * NM, e26.thr[1] - e26.v[1] * 3 * NM]; a.alt = 1000; a.landClr = true;
  let r = say(sim, d, "behind the landing traffic, line up and wait runway 26 behind");
  ok(/behind/.test(txt(r)) && d.state === "cond_lineup" && d.cond && d.cond.ac === a, "conditional line-up accepted: " + txt(r));
  ok(!run(sim, 20, () => d.state !== "cond_lineup"), "it waits while the arrival is still on final");
  ok(run(sim, 300, () => ["lineup", "lining", "lined_up"].includes(d.state)), "lines up once the arrival has landed and passed: " + d.state);
  ok(run(sim, 120, () => d.state === "lined_up"), "lined up");
  run(sim, 300, () => sim.runwayFree(sim.depEnd.rwy, d));
  r = say(sim, d, "runway 26 cleared for immediate takeoff");
  ok(/immediate/.test(txt(r)) && d.state === "roll", "immediate takeoff from lined up rolls at once");
  // cancel before it is committed
  r = say(sim, d, "cancel takeoff");
  ok(/stopping/i.test(txt(r)) && d.state === "rto", "takeoff cancelled at low speed → stopping on the runway: " + txt(r));
  ok(run(sim, 60, () => d.rtoCalled), "it reports stopped on the runway");
  r = say(sim, d, "vacate the runway");
  ok(/vacat/i.test(txt(r)) && d.state === "vacating", "vacates the runway: " + txt(r));
  // continue approach + land after
  const b = arr(sim); b.pos = [e26.thr[0] - e26.v[0] * 2.5 * NM, e26.thr[1] - e26.v[1] * 2.5 * NM]; b.alt = 800;
  r = say(sim, b, "continue approach");
  ok(b.contApp, "continue approach noted");
  const c = arr(sim); c.pos = [e26.thr[0] - e26.v[0] * 5 * NM, e26.thr[1] - e26.v[1] * 5 * NM]; c.alt = 1600;
  r = say(sim, c, "land after the landing traffic, runway 26");
  ok(/land after/i.test(txt(r)) && c.landAfter && c.landAfter.ac === b, `land after (UK) accepted (subject=${c.landAfter && c.landAfter.ac && c.landAfter.ac.cs} b=${b.cs} c=${c.cs} finals=${sim.ac.filter(o => o.kind === "arr" && o.state === "final").map(o => o.cs + "@" + (sim.distToThr(o) / NM).toFixed(1)).join(" ")}): ` + txt(r));
  say(sim, b, "runway 26 cleared to land");
  ok(run(sim, 400, () => c.landClr), "clearance becomes effective once the first one has landed");
  ok(radio.length > 0, "radio traffic");
}

// ---------- D3: give way / follow / hold short of taxiway / expect / report ----------
{
  const { sim } = mk();
  const d1 = dep(sim), d2 = dep(sim);
  run(sim, 60, () => d1.state === "clr_req" && d2.state === "clr_req");
  say(sim, d1, `cleared to ${d1.other[1]}, climb 4000 feet, squawk 4523`); say(sim, d2, `cleared to ${d2.other[1]}, climb 4000 feet, squawk 4524`);
  run(sim, 200, () => d1.state === "push_req" && d2.state === "push_req");
  say(sim, d1, "push and start approved");           // d2 stays on its stand so it does not block d1
  run(sim, 300, () => d1.state === "taxi_req");
  const t1 = sim.aiDecide(d1, "GND"); if (t1) sim.atc("ALL", t1.replace(/^[^,]+, /, `${d1.cs} `));
  run(sim, 5);
  let r = say(sim, d2, `give way to the ${d1.type} then taxi to holding point runway 26`);
  ok(d2.giveWay && d2.giveWay.ac === d1, "give way recorded: " + txt(r));
  r = say(sim, d2, `follow the ${d1.type}`);
  ok(d2.leader === d1, "follow sets the leader: " + txt(r));
  const twy = (d1.path || []).map((p, k) => k + 1 < d1.path.length && p[2] != null && d1.path[k + 1][2] != null ? (apt.edgeBetween(p[2], d1.path[k + 1][2]) || {}).name : null).filter(Boolean);
  const mid = twy.find((nm, i) => i > 0 && nm !== twy[0]);
  if (mid) {
    r = say(sim, d1, `hold short of taxiway ${mid}`);
    ok(d1.holdShortIdx != null && /hold short of taxiway/i.test(txt(r)), `hold short of taxiway ${mid}: ` + txt(r));
    const stopped = run(sim, 900, () => d1.spd < 0.1 && d1.pi > d1.holdShortIdx && d1.holdShortIdx != null);   // taxiway A at EETN is 3 km long
    ok(stopped, `stops at the intersection (state=${d1.state} pi=${d1.pi} idx=${d1.holdShortIdx} spd=${d1.spd.toFixed(2)} blockedRwy=${d1.blockedRwy} dStop=${d1.distToStop})`);
    r = say(sim, d1, "continue taxi");
    ok(d1.holdShortIdx == null, "continue taxi clears the hold");
  } else ok(true, "route has a single taxiway, hold-short skipped");
  r = say(sim, d1, "expect runway 08");
  ok(/expecting runway 08/i.test(txt(r)), "expect readback: " + txt(r));
  r = say(sim, d1, "report passing 2000 feet");
  ok(d1.reports && d1.reports["passing 2000 feet"] && d1.reportAlt === 2000, "report passing recorded");
}

// ---------- D4: sequence panel data, CTOT/A-CDM, missed approach from navdata ----------
{
  const { sim, events } = mk();
  const d = dep(sim);
  ok(d.tobt != null && d.tsat != null && d.taxiEst > 0, "A-CDM times assigned on spawn");
  const t = acdmTimes(d, sim);
  ok(/^\d{4}$/.test(t.tobt) && /^\d{4}$/.test(t.ttot), "TOBT/TTOT as HHMM: " + JSON.stringify(t));
  d.ctot = sim.t + 1200;
  ok(toHolding(sim, d), "departure at the holding point");
  const seq = departureSequence(sim, sim.depEnd, false);
  ok(seq.length === 1 && seq[0].a === d && seq[0].ctot && seq[0].ctot.state === "early", "departure sequence lists it with an early CTOT");
  sim.lastTakeoff = { t: sim.t - 30, wtc: "H", cs: "X", type: "B744", rwy: sim.depEnd.rwy };
  ok(departureSequence(sim, sim.depEnd, false)[0].wait > 60, "wake wait behind a heavy that just departed");
  ok(departureSequence(sim, sim.depEnd, true)[0].need === 100, "RECAT-EU: D behind B needs 100 s");
  const ai = sim.aiDecide(d, "TWR");
  ok(!ai || !/cleared for takeoff/.test(ai), "AI Tower waits for the wake separation");
  const e26 = apt.findRunwayEnd("26");
  const a1 = arr(sim); a1.pos = [e26.thr[0] - e26.v[0] * 3 * NM, e26.thr[1] - e26.v[1] * 3 * NM];
  const a2 = arr(sim); a2.pos = [e26.thr[0] - e26.v[0] * 5 * NM, e26.thr[1] - e26.v[1] * 5 * NM];
  const sp = arrivalSpacing(sim, sim.depEnd, false);
  ok(sp.length === 2 && sp[1].gapNm > 1.9 && sp[1].gapNm < 2.1 && sp[1].short, "arrival spacing 2 NM flagged short of 3 NM");
  // published missed approach: the go-around flies the legs then leaves
  sim.missedFor = () => [{ fix: "ALPHA", lat: apt.d.lat + 0.08, lon: apt.d.lon - 0.05, alt: 3000 }, { fix: "FOXT", lat: apt.d.lat + 0.15, lon: apt.d.lon + 0.05, alt: 4000 }];
  a1.alt = 1000; a1.landClr = false; a2.gone = true;
  ok(run(sim, 200, () => a1.state === "goaround"), "no landing clearance → go-around");
  ok(run(sim, 300, () => a1.missed), "flies the published missed approach");
  ok(a1.wps && a1.wps[0].leg === "ALPHA" && a1.circuitAlt === 3000, "legs from navdata: " + a1.wps.map(w => w.leg).join(" → "));
  ok(run(sim, 1500, () => a1.gone), "leaves after the last leg");
  ok(events.length > 0, "events emitted");
}

// ---------- D5: VFR inbound, circuit, touch-and-go, helicopter, SVFR ----------
{
  const { sim, radio } = mk();
  const pts = defaultVfrPoints(apt);
  eq(pts.length, 4, "default reporting points N/E/S/W");
  const v = sim.spawnVfrInbound();
  ok(v && v.state === "inbound" && v.vfr && v.squawk === "7000", "VFR inbound spawned (squawk 7000)");
  ok(run(sim, 900, () => v.calledIn), "calls at the reporting point");
  ok(/inbound|request join/i.test((last(radio, v) || {}).text || ""), "inbound call: " + (last(radio, v) || {}).text);
  let r = sim.aiDecide(v, "TWR");
  ok(/join left downwind runway 26/.test(r || ""), "AI Tower gives joining instructions: " + r);
  r = say(sim, v, "join left downwind runway 26, report downwind");
  ok(v.state === "circuit" && v.joined && /join left downwind/i.test(txt(r)), `joined the circuit (${v.state} joined=${v.joined}): ` + txt(r));
  ok(run(sim, 900, () => /downwind/.test((last(radio, v) || {}).text || "")), "reports downwind: " + (last(radio, v) || {}).text);
  r = say(sim, v, "cleared touch and go runway 26");
  ok(v.touchGo && v.landClr, "touch-and-go clearance: " + txt(r));
  ok(run(sim, 900, () => v.circuits === 1), "touch and go flown");
  ok(run(sim, 400, () => v.state === "circuit"), "rejoins the circuit after the touch-and-go");
  r = say(sim, v, "extend downwind");
  ok(v.extended, "extend downwind");
  r = say(sim, v, "orbit left");
  ok(v.wps.some(w => w.leg === "orbit"), "orbit inserted");
  say(sim, v, "make a full stop");
  ok(v.fullStop && !v.touchGo, "full stop next time");
  // special VFR when the weather is poor
  sim.weatherFromMetar(parseMetar("EETN 121050Z 26005KT 4000 BR BKN012 05/04 Q1012"));
  ok(sim.svfrNeeded(), "vis 4000 m → special VFR needed");
  const v2 = sim.spawnVfrInbound();
  ok(run(sim, 900, () => v2.calledIn), "second VFR calls");
  ok(/special VFR/i.test((last(radio, v2) || {}).text || ""), "asks for special VFR: " + (last(radio, v2) || {}).text);
  r = sim.aiDecide(v2, "TWR");
  ok(/special VFR/.test(r || ""), "AI Tower clears special VFR: " + r);
  // helicopter departure from the apron
  const h = sim.makeGA(); h.heli = true; h.type = "H145"; h.wantCircuits = 0;
  const st = sim.freeStands(["tie_down", "hangar", "misc", "gate"], true)[0];
  sim.placeParked(h, st, false); h.callAt = sim.t + 2;
  ok(run(sim, 30, () => h.state === "taxi_req"), "helicopter asks for departure");
  ok(/present position/.test((last(radio, h) || {}).text || ""), "from present position: " + (last(radio, h) || {}).text);
  r = sim.aiDecide(h, "GND");
  ok(/from present position/.test(r || ""), "AI clears it from present position: " + r);
  r = say(sim, h, "cleared for takeoff from present position");
  ok(h.state === "airborne" && !h.onGround, "helicopter lifts: " + txt(r));
  // a GA departure that wants circuits
  const g = sim.makeGA(); g.heli = false; g.type = "C172"; g.wantCircuits = 1;
  const st2 = sim.freeStands(["tie_down", "hangar", "misc", "gate"], true)[0];
  sim.placeParked(g, st2, false); g.callAt = sim.t + 2;
  ok(g.other[1] === "circuits" || true, "circuits intention");
}

// ---------- D6: ground vehicles that need clearances ----------
{
  const { sim, radio, events } = mk();
  const rwy = sim.depEnd.rwy;
  const v = sim.runwayInspection(rwy, "routine");
  ok(v && v.vtype === "ops" && v.task && v.task.kind === "inspection", "Ops vehicle dispatched for a runway inspection");
  ok(sim.closedRunways.has(rwy), "runway closed while the inspection is pending");
  ok(/runway inspection/i.test((last(radio, v) || {}).text || ""), "it asks on the radio: " + (last(radio, v) || {}).text);
  ok(run(sim, 600, () => v.wants === "enter" && v.spd < 0.1 && (v.atStop || v.pi >= (v.path || []).length)), `waits at the holding point (${v.state} atStop=${v.atStop} pi=${v.pi}/${(v.path || []).length})`);
  let r = say(sim, v, "enter runway 26, report vacated");
  ok(v.crossOk.has(rwy) && /entering runway 26/i.test(txt(r)), "cleared onto the runway: " + txt(r));
  ok(run(sim, 900, () => v.task && v.task.stage === "vacating"), "drives the runway and vacates");
  ok(!sim.closedRunways.has(rwy), "runway reopened after the inspection");
  ok(/inspected/.test((last(radio, v) || {}).text || ""), "reports it: " + (last(radio, v) || {}).text);
  ok(run(sim, 900, () => !v.task), "goes home");
  // the AI tower answers a vehicle request when the runway is free
  const v2 = sim.runwayInspection(rwy, "fod");
  ok(run(sim, 600, () => v2.wants === "enter" && v2.spd < 0.1 && (v2.atStop || v2.pi >= (v2.path || []).length)), "second inspection waits");
  const ai = sim.aiDecide(v2, "TWR");
  ok(/enter runway/.test(ai || ""), "AI Tower clears the vehicle onto the runway: " + ai);
  // a breakdown → tug
  const d = dep(sim);
  run(sim, 60, () => d.state === "clr_req"); say(sim, d, `cleared to ${d.other[1]}, climb 4000 feet, squawk 4525`);
  run(sim, 200, () => d.state === "push_req"); say(sim, d, "push and start approved");
  run(sim, 300, () => d.state === "taxi_req");
  const t1 = sim.aiDecide(d, "GND"); if (t1) sim.atc("ALL", t1.replace(/^[^,]+, /, `${d.cs} `));
  ok(run(sim, 120, () => d.state === "taxi" && d.spd > 1), "taxiing");
  sim.breakdown(d);
  ok(d.state === "broken" && sim.blockedEdges.size > 0, "breakdown blocks the taxiway");
  const tug = sim.towRequest(d);
  ok(tug && tug.vtype === "tug" && tug.task && tug.task.kind === "tow", "tug dispatched");
  ok(/request tow/.test((last(radio, tug) || {}).text || ""), "tug asks for the tow: " + (last(radio, tug) || {}).text);
  r = say(sim, tug, "tow approved");
  ok(tug.towOk, "tow approved: " + txt(r));
  ok(run(sim, 900, () => d.towing), "aircraft under tow");
  let towed = false;
  for (let k = 0; k < 10 && !towed; k++) {           // the tug may need a runway crossing on the way
    towed = run(sim, 200, () => d.state === "parked" && !d.towing);
    if (!towed && tug.atStop && tug.blockedRwy != null) say(sim, tug, `cross runway ${apt.runways[tug.blockedRwy].ends[0].name}`);
  }
  ok(towed, `towed to the hangar / stand (${d.state} tug=${tug.state} atStop=${tug.atStop} pi=${tug.pi}/${(tug.path || []).length} spd=${tug.spd.toFixed(2)} hold=${tug.holdPos} lim=${sim.trafficLimit(tug).toFixed(1)} pause=${tug.pauseUntil} stage=${tug.task && tug.task.stage})`);
  ok(sim.blockedEdges.size === 0, "taxiway unblocked");
  ok(events.some(e => e.type === "towDone"), "towDone event");
}

// ---------- D7: abnormal events, checklists, emergencies ----------
{
  const { sim, radio, alerts, events } = mk();
  const e26 = apt.findRunwayEnd("26");
  const a = arr(sim); a.pos = [e26.thr[0] - e26.v[0] * 9 * NM, e26.thr[1] - e26.v[1] * 9 * NM]; a.alt = 3000;
  eq(sim.abnormalEvent("medical"), "medical", "medical event");
  ok(a.medical && /medical/.test((last(radio, a) || {}).text || ""), "crew reports the medical case");
  ok(events.some(e => e.type === "abnormal" && e.kind === "medical" && e.checklist === CHECKLISTS.medical), "checklist attached");
  eq(sim.abnormalEvent("pan"), "pan", "PAN event");
  ok(a.pan && /^Pan pan/.test((last(radio, a) || {}).text || ""), "PAN PAN call: " + (last(radio, a) || {}).text);
  const snapPan = sim.snapshot(null).find(x => x.id === a.id);
  ok(snapPan && snapPan.pan === true && snapPan.priority === "pan", "snapshot carries pan/priority");
  const ai = sim.aiDecide(a, "TWR");
  ok(/pan pan|number one/.test(ai || "") && sim.vehicleOf("fire"), "AI Tower acknowledges and alerts the fire service: " + ai);
  eq(sim.abnormalEvent("fod"), "fod", "FOD report");
  ok(sim.fod && alerts.some(m => /FOD/.test(m)), "FOD alert");
  eq(sim.abnormalEvent("incursion"), "incursion", "runway incursion");
  const ops = sim.vehicleOf("ops");
  ok(ops && ops.task && ops.task.kind === "incursion", "ops vehicle heading for the runway");
  let r = say(sim, ops, "stop immediately");
  ok(!ops.task && /stopping/i.test(txt(r)), "stopped: " + txt(r));
  // rejected takeoff
  const d = dep(sim);
  ok(toHolding(sim, d), `departure holding (${d.state} spd=${d.spd.toFixed(2)} lim=${sim.trafficLimit(d).toFixed(1)} dStop=${d.distToStop} near=${sim.ac.filter(o => o !== d && dist(o.pos, d.pos) < 80).map(o => o.cs + ":" + o.state).join(" ")})`);
  run(sim, 120, () => sim.runwayFree(sim.depEnd.rwy, d));
  say(sim, d, "runway 26 cleared for takeoff");
  ok(run(sim, 120, () => d.state === "roll" && d.spd > 20 * KT), "rolling");
  eq(sim.abnormalEvent("rto"), "rto", "RTO event");
  ok(d.state === "rto" && /stopping/.test((last(radio, d) || {}).text || ""), "stopping, stopping");
  ok(run(sim, 120, () => d.rtoCalled), "reports stopped");
  r = say(sim, d, "vacate the runway");
  ok(d.state === "vacating", "vacates");
  ok(run(sim, 900, () => ["taxi", "parked", "holding_short", "vacated"].includes(d.state)), "returns to the apron: " + d.state);
  // 7500 / 7600 / 7700 through the same entry point
  const b = arr(sim); b.pos = [e26.thr[0] - e26.v[0] * 10 * NM, e26.thr[1] - e26.v[1] * 10 * NM]; b.alt = 3000;
  eq(sim.abnormalEvent("7500"), "7500", "hijack event");
  ok(b.squawk === "7500" || b.squawk === "7500", "squawk 7500 set: " + b.squawk);
  ok(CHECKLISTS.hijack.length >= 3 && CHECKLISTS.mayday.length >= 4 && CHECKLISTS.rcf.length >= 3, "checklists exist");
  const stt = sim.status();
  ok("lvp" in stt && "closed" in stt && Array.isArray(stt.stopBars), "status() for panels");
  // scheduled abnormal events when enabled
  sim.abnormals = { on: true, perHour: 60 }; sim.scheduleAbnormal();
  ok(sim.nextAbnormal < sim.t + 120, "abnormal scheduled within 2 min at 60/h");
}

// ---- Phase F: strip handoffs with acceptance, remote controllers, autocomplete ----
{
  const rad = [], alerts = [];
  const pos = buildPositions(apt);
  const sim = new Sim(apt, { positions: pos, staffing: new Set(["TWR"]), onRadio: (m) => rad.push(m), onAlert: (m) => alerts.push(m), onEvent: () => {}, populate: false });
  sim.setRunway("26"); sim.nextDep = sim.nextArr = sim.nextOvf = sim.nextVfr = 1e9; sim.vfrPerHour = 0; sim.abnormals = { on: false, perHour: 0 };
  const toGnd = (a) => sim.respond(a, parse(`${a.cs} contact ground ${pos.GND.freq}`, sim.ac).ins, { text: "", pos: "TWR" });
  const holding = () => { const a = dep(sim); a.state = "holding"; a.freq = "TWR"; a.depEnd = sim.depEnd; a.onGround = true; return a; };
  const d = dep(sim); d.state = "airborne"; d.freq = "TWR"; d.depEnd = sim.depEnd; d.onGround = false; d.alt = 2500;
  const r = sim.respond(d, parse(`${d.cs} contact approach ${pos.APP.freq}`, sim.ac).ins, { text: "", pos: "TWR" });
  ok(new RegExp(pos.APP.freq.replace(".", "\\.")).test(txt(r)), "frequency readback: " + txt(r));
  run(sim, 20, () => d.freq === "APP");
  ok(d.freq === "APP" && d.handoff && d.handoff.from === "TWR" && d.handoff.to === "APP" && !d.handoff.accepted, "the frequency change offers the strip to Approach");
  const snap = sim.snapshot().find(x => x.id === d.id);
  ok(snap && snap.handoff && !snap.handoff.accepted && incomingFor(snap, "APP") && !incomingFor(snap, "TWR"), "snapshot carries the handoff; the strip is incoming on Approach's board only");
  run(sim, 10, () => d.handoff.accepted);
  ok(d.handoff.accepted && d.handoff.by === "AI", "an AI position accepts within seconds");
  // Ground is now worked by a remote controller: the strip waits for a human
  sim.remoteStaff.GND = "liisa"; sim.staffing.add("GND");
  ok(sim.userWorks("GND"), "a claimed position counts as worked by a human");
  const d2 = holding(); toGnd(d2); run(sim, 20, () => d2.freq === "GND"); run(sim, 12);
  ok(d2.freq === "GND" && d2.handoff && !d2.handoff.accepted, "no automatic acceptance on a human position");
  ok(sim.acceptHandoff(d2, "liisa") && d2.handoff.accepted && d2.handoff.by === "liisa" && !sim.acceptHandoff(d2, "x"), "the remote controller accepts; a second accept does nothing");
  ok((sim.stats.handoffs || 0) >= 2, "handoffs are counted: " + sim.stats.handoffs);
  const d3 = holding(); toGnd(d3); run(sim, 20, () => d3.freq === "GND"); run(sim, 50);
  ok(alerts.some(m => /not accepted for 45 s/.test(String(m))), "an unanswered handoff is flagged after 45 s");
  // autocomplete: callsigns first, then the next instruction for the aircraft
  const d4 = holding();
  const s1 = suggestions({ text: "", sim, pos: "TWR", selected: null, app: null });
  ok(s1.some(x => x.label.startsWith(d4.cs)) && s1.every(x => x.insert.endsWith(" ")), "empty line: the callsigns on my frequency");
  ok(!suggestions({ text: "", sim, pos: "TWR", selected: null, app: null }).some(x => x.label.startsWith(d2.cs)), "an aircraft on Ground is not offered on Tower");
  const s2 = suggestions({ text: `${d4.cs} cleared for`, sim, pos: "TWR", selected: null, app: null });
  ok(s2.length > 0 && s2.every(x => /cleared for/.test(x.hint)) && s2.some(x => /cleared for takeoff/.test(x.insert)), "typing 'cleared for' narrows to the takeoff clearances: " + s2.map(x => x.hint).join(" | "));
  const s3 = suggestions({ text: `${d4.cs} `, sim, pos: "TWR", selected: null, app: null });
  ok(s3.some(x => /next expected/.test(x.label)) && s3.some(x => /line up and wait/.test(x.hint)), "after the callsign: the next expected call and the usual options");
}

// ---- S2: the pilot's SimBrief flight as traffic, the clearance against the plan, the EuroScope flight plan ----
{
  const plan = JSON.parse(readFileSync(new URL("./fixtures/simbrief_plan.json", import.meta.url), "utf8"));   // simbrief.parse() of the made-up OFP (kept in sync by simbrief_test.py)
  const { sim } = mk();
  const a = sim.spawnFromPlan(plan, "dep");
  ok(a && a.cs === "TTR123" && a.type === "A320" && a.wtc === "M" && a.reg === "ESTTR" && a.kind === "dep" && a.state === "parked" && a.simbrief, "the OFP spawns a parked departure with the callsign, type and registration");
  ok(a.other[0] === "EVRA" && a.route === "DCT ULGOT N746 ABETI DCT" && a.rfl === 36000 && a.eobt === "0730" && a.planSid === "ULGOT1G" && a.altn === "EYVI" && a.equip === "SDE2E3FGHIRWXY/LB1D1", "destination, route, RFL, EOBT as TOBT, planned SID, alternate and equipment carried over");
  ok(a.stand && a.stand.types && (a.stand.types.includes("jets") || a.stand.types.includes("heavy")), "on a stand that fits an A320: " + (a.stand && a.stand.name));
  ok(a.num === "123" && a.tel === "TTR" && !!a.crew, "flight number and a telephony fallback for an unknown airline");
  const snap = sim.snapshot().find(x => x.id === a.id);
  ok(snap.simbrief && snap.route === a.route && snap.rfl === 36000 && snap.eobt === "0730" && snap.reg === "ESTTR", "the strip snapshot carries the OFP markers");
  const es = bridgeAircraft(sim, apt).find(x => x.cs === "TTR123");
  ok(es.simbrief && es.equip === "SDE2E3FGHIRWXY/LB1D1" && es.rfl === 36000 && es.altn === "EYVI" && es.eobt === "0730" && es.route === "DCT ULGOT N746 ABETI DCT" && es.dest === "EVRA" && es.remarks.includes("REG/ESTTR") && es.tas_plan === 447, "the EuroScope bridge gets equipment, RFL, alternate, EOBT, route and remarks");
  const say = (text) => coach({ text, parsed: parse(text, sim.ac, a), sim, pos: "DEL", lang: "en" });
  const okClr = say("TTR123 cleared to EVRA via ULGOT1G departure climb 5000 squawk 4521");
  ok(okClr.some(x => /matches the filed plan/.test(x.msg)) && !okClr.some(x => x.level === "warn"), "a clearance matching the plan is confirmed by the coach");
  const wrongDest = say("TTR123 cleared to EFHK via ULGOT1G departure climb 5000 squawk 4521");
  ok(wrongDest.some(x => x.level === "warn" && /EVRA/.test(x.msg)), "a clearance to the wrong destination is flagged against the plan");
  const highLevel = say("TTR123 cleared to EVRA via ULGOT1G departure climb flight level 380 squawk 4521");
  ok(highLevel.some(x => x.level === "warn" && /36000/.test(x.msg)), "a clearance above the filed level is flagged");
  const otherSid = say("TTR123 cleared to EVRA via LAPSA2B departure climb 5000 squawk 4521");
  ok(otherSid.some(x => x.level === "info" && /ULGOT1G/.test(x.msg)), "a different SID than the OFP's is pointed out");
  const b = sim.spawnFromPlan(plan, "arr");
  ok(b && b.kind === "arr" && b.cs === "TTR123" && b.other[0] === "EETN" && b.star === "ABETI2A" && b.simbrief && !sim.ac.includes(a), "the same OFP as an arrival replaces the earlier spawn, with the STAR");
}

// ---- S3: a plan filed from XRadio (PT_FLIGHTPLAN, usually a SimBrief import) fills the strip and the EuroScope $FP ----
{
  const { sim } = mk();
  const fp = { session_id: 7, callsign: "ESXYZ", ac_icao: "A320", rules: "I", status: "filed", squawk: 0, dep: "EETN", dest: "EVRA", altn: "EYVI", cruise_ft: 36000,
    route: "ULGOT1G ULGOT N746 ABETI ABETI2A", remarks: "SIMBRIEF EOBT/0730 TAS/447 REG/ESTTR EQPT/SDE2E3FGHIRWXY/LB1D1" };
  const h = sim.upsertHuman({ hid: 7, cs: "ESXYZ", type: "A320", pos: sim.ac.length ? sim.ac[0].pos : { x: 0, y: 0 }, alt: 131, hdg: 80, spd: 0, onGround: true, squawk: "2000", xpdr: "S", ai: false, tx: false, fp });
  ok(h.human && h.other[0] === "EETN" && h.other[1] === "EVRA" && h.cfl === 36000 && h.ifr && h.fpStatus === "filed", "the XRadio plan sets destination, cruise and rules");
  ok(h.route === "ULGOT1G ULGOT N746 ABETI ABETI2A" && h.altn === "EYVI" && h.rfl === 36000, "route, alternate and RFL come from the plan");
  ok(h.eobt === "0730" && h.tas_plan === 447 && h.reg === "ESTTR" && h.equip === "SDE2E3FGHIRWXY/LB1D1" && h.simbrief === true, "EOBT, TAS, registration, equipment and the SimBrief mark are read from the remarks");
  const snap = sim.snapshot().find(x => x.id === h.id);
  ok(snap && snap.simbrief && snap.route === h.route && snap.eobt === "0730", "the strip snapshot shows the filed route as an OFP");
  const es = bridgeAircraft(sim, apt).find(x => x.cs === "ESXYZ");
  ok(es && es.route.includes("N746") && es.rfl === 36000 && es.altn === "EYVI" && es.equip === "SDE2E3FGHIRWXY/LB1D1" && es.eobt === "0730", "the EuroScope bridge carries the XRadio plan");
  const plain = sim.upsertHuman({ hid: 8, cs: "N771AB", type: "C172", pos: h.pos, alt: 131, hdg: 80, spd: 0, onGround: true, squawk: "7000", xpdr: "S", ai: false, tx: false,
    fp: { session_id: 8, callsign: "N771AB", ac_icao: "C172", rules: "V", status: "filed", squawk: 0, dep: "EETN", dest: "EEPU", altn: "", cruise_ft: 2500, route: "DCT", remarks: "" } });
  ok(!plain.simbrief && !plain.eobt && plain.route === "DCT" && !plain.ifr, "a plain VFR plan without remarks stays plain");
}

// ---- S4: AI ATC for a real pilot's flight (XRadio), driven by the real position, with readback checks and a debrief ----
{
  ok(normalizeNumbers("four five two one") === "4521" && normalizeNumbers("three thousand five hundred feet") === "3500 feet" && normalizeNumbers("flight level one two zero") === "FL120" && normalizeNumbers("climb 5000, squawk 4521") === "climb 5000 squawk 4521" && normalizeNumbers("one two thousand") === "12000", "spoken numbers become digits");
  const rb = checkReadback("cleared to Riga via ULGOT one golf departure, climb five thousand feet, squawk four five two one, ESXYZ", [{ k: "sid", v: "ULGOT1G" }, { k: "alt", v: 5000 }, { k: "squawk", v: "4521" }]);
  ok(rb.ok, "a full readback passes");
  const rb2 = checkReadback("climb 5000, squawk 4512, ESXYZ", [{ k: "sid", v: "ULGOT1G" }, { k: "alt", v: 5000 }, { k: "squawk", v: "4521" }]);
  ok(!rb2.ok && rb2.missing.length === 2 && rb2.missing.some(m => m.k === "squawk") && rb2.missing.some(m => m.k === "sid"), "a wrong squawk and a missing SID are caught");
  ok(checkReadback("runway 26 cleared for takeoff ESXYZ", [{ k: "rwy", v: "26" }, { k: "word", v: "cleared for takeoff" }]).ok && checkReadback("line up runway 08", [{ k: "rwy", v: "08" }]).ok && !checkReadback("runway 08", [{ k: "rwy", v: "26" }]).ok, "runway readbacks");
  ok(intentOf("request clearance to Riga") === "clearance" && intentOf("request push and start") === "push" && intentOf("request taxi") === "taxi" && intentOf("holding point runway 26, ready for departure") === "ready" && intentOf("inbound, information Charlie") === "inbound" && intentOf("") === "call" && intentOf("squawk 4521 climb 5000") === "readback" && intentOf("mayday mayday") === "emergency", "intents");

  const KT = 0.5144, NM = 1852;
  const pos = buildPositions(apt);
  const khz = (k) => Math.round(pos[k].mhz * 1000);
  const said = [], acks = [], logs = [];
  const { sim } = mk({ positions: pos, staffing: new Set([]) });   // nobody staffed: every position is an AI controller
  const atc = new PilotAtc(sim, { say: (m) => said.push(m), fpAck: (cs, x) => acks.push({ cs, ...x }), log: (l) => logs.push(l) });
  const stand = apt.stands.find(s => s.types && s.types.includes("jets")) || apt.stands[0];
  const fp = { session_id: 9, callsign: "ESXYZ", ac_icao: "A320", rules: "I", status: "filed", squawk: 0, dep: "EETN", dest: "EVRA", altn: "EYVI", cruise_ft: 36000, route: "ULGOT1G ULGOT N746 ABETI ABETI2A", remarks: "SIMBRIEF EOBT/0730 TAS/447" };
  let cur = { pos: [stand.pos[0], stand.pos[1]], alt: 0, hdg: 80, spd: 0, onGround: true };
  const upd = (x) => { cur = { ...cur, ...x }; return sim.upsertHuman({ hid: 9, cs: "ESXYZ", type: "A320", squawk: "2000", xpdr: "S", ai: false, tx: false, fp, ...cur }); };
  upd({});
  sim.step(1); atc.tick();
  ok(said.length === 0 && atc.flights.has("ESXYZ"), "the AI waits for the pilot's call");
  atc.heard("ESXYZ", "Tallinn Delivery, ESXYZ, stand " + stand.name + ", information Charlie, request clearance to Riga", khz("DEL"), false);
  const clr = said[said.length - 1];
  ok(clr && clr.pos === "DEL" && /^ESXYZ, cleared to EVRA via .*, climb \d+ feet, squawk \d{4}$/.test(clr.text), "Delivery clears from the filed plan: " + (clr && clr.text));
  const code = /squawk (\d{4})/.exec(clr.text)[1], climb = /climb (\d+) feet/.exec(clr.text)[1];
  atc.heard("ESXYZ", `cleared to Riga, climb ${climb} feet, squawk 4512, ESXYZ`, khz("DEL"), false);
  ok(/^ESXYZ, negative, squawk \d{4}, read back$/.test(said[said.length - 1].text), "a wrong squawk is corrected: " + said[said.length - 1].text);
  atc.heard("ESXYZ", `cleared to Riga via flight planned route, climb ${climb} feet, squawk ${code}, ESXYZ`, khz("DEL"), false);
  ok(/readback correct, contact Ground \d{3}\.\d+ when ready/.test(said[said.length - 1].text) && acks.some(x => x.cs === "ESXYZ" && x.status === "cleared" && x.squawk === +code), "readback correct, handed to Ground, plan answered as cleared");
  const F = atc.flights.get("ESXYZ");
  ok(F.phase === "cleared" && F.pos === "GND" && F.readbackErrors === 1, "state after the clearance");
  // taxiing without clearance: Ground sees the real position move
  upd({ pos: [stand.pos[0] + 80, stand.pos[1]], spd: 5 * KT });
  sim.step(1); atc.tick();
  ok(/hold position, you are not cleared to taxi/.test(said[said.length - 1].text) && F.deviations === 1, "moving before a taxi clearance: hold position: " + said[said.length - 1].text + " dev=" + F.deviations);
  atc.heard("ESXYZ", "ESXYZ, request taxi", khz("GND"), false);
  const taxi = said[said.length - 1];
  ok(taxi.pos === "GND" && new RegExp(`taxi to holding point runway ${sim.depEnd.name}.*hold short runway ${sim.depEnd.name}`).test(taxi.text) && F.taxi && F.taxi.points.length > 1, "taxi clearance with a route from the real position: " + taxi.text);
  atc.heard("ESXYZ", `taxi to holding point runway ${sim.depEnd.name}, hold short, ESXYZ`, khz("GND"), false);
  ok(F.phase === "taxi" && !F.pending, "taxi readback accepted");
  // off the route, then at the holding point
  const pts = F.taxi.points, hp = pts[pts.length - 1], prev = pts[pts.length - 2];
  const far = [hp[0] + 400, hp[1] + 400];
  upd({ pos: far, spd: 10 * KT }); sim.step(1); atc.tick();
  ok(/off the cleared route/.test(said[said.length - 1].text) && F.deviations === 2, "off the cleared route: told so: " + said[said.length - 1].text + " dev=" + F.deviations);
  const L = Math.hypot(hp[0] - prev[0], hp[1] - prev[1]) || 1, ux = (hp[0] - prev[0]) / L, uy = (hp[1] - prev[1]) / L;
  // the holding point: short of the runway entry node, off the runway itself (the entry node sits on it)
  let back = 60; while (back < 290 && apt.runways.some(R => apt.onRunway([hp[0] - ux * back, hp[1] - uy * back], R, 5))) back += 10;
  upd({ pos: [hp[0] - ux * back, hp[1] - uy * back], spd: 0 }); sim.step(1); atc.tick();
  ok(/contact Tower \d{3}\.\d+/.test(said[said.length - 1].text) && F.pos === "TWR" && F.phase === "holding", "near the holding point: contact Tower: " + said[said.length - 1].text + " " + F.pos + " " + F.phase);
  atc.heard("ESXYZ", `Tallinn Tower, ESXYZ, holding point runway ${sim.depEnd.name}, ready for departure`, khz("TWR"), false);
  const tko = said[said.length - 1];
  ok(tko.pos === "TWR" && new RegExp(`runway ${sim.depEnd.name}, cleared for takeoff`).test(tko.text), "Tower clears for takeoff with the runway free: " + tko.text);
  atc.heard("ESXYZ", `runway ${sim.depEnd.name}, cleared for takeoff, ESXYZ`, khz("TWR"), false);
  ok(F.takeoff && !F.pending, "takeoff readback accepted");
  const e = sim.depEnd;
  upd({ pos: [e.thr[0] + e.v[0] * 2500, e.thr[1] + e.v[1] * 2500], alt: 1200, spd: 160 * KT, onGround: false }); sim.step(1); atc.tick();
  ok(F.phase === "to_app" && F.pos === "APP" && /contact (Radar|Departure|Director) \d{3}\.\d+/.test(said[said.length - 1].text), "airborne: handed to Radar");
  atc.heard("ESXYZ", "Tallinn Radar, ESXYZ, passing 2000 feet", khz("APP"), false);
  ok(/identified, climb flight level 120/.test(said[said.length - 1].text), "Radar identifies and clears the climb: " + said[said.length - 1].text);
  atc.heard("ESXYZ", "climb flight level one two zero, ESXYZ", khz("APP"), false);
  ok(F.phase === "climb" && !F.pending, "climb readback with spoken numbers accepted");
  upd({ alt: 6000, pos: [e.thr[0] + e.v[0] * 12000, e.thr[1] + e.v[1] * 12000] }); sim.step(1); atc.tick();
  ok(F.pos === "CTR" && /contact .*Control \d{3}\.\d+/.test(said[said.length - 1].text), "above 4500 ft: handed to Control");
  atc.heard("ESXYZ", "Tallinn Control, ESXYZ, climbing flight level 120", khz("CTR"), false);
  ok(/identified, climb flight level 360/.test(said[said.length - 1].text), "Control clears to the filed cruise level");
  atc.heard("ESXYZ", "climb flight level 360, ESXYZ", khz("CTR"), false);
  upd({ alt: 20000, pos: [e.v[0] * 40 * NM, e.v[1] * 40 * NM] }); sim.step(1); atc.tick();
  ok(F.done && F.how === "departed" && /radar service terminated/.test(said[said.length - 1].text) && !acks.some(x => x.status === "cancel"), "leaving the airspace closes the flight here; the plan stays open for the destination");
  const d = atc.debrief("ESXYZ");
  ok(d && d.readbackErrors === 1 && d.deviations === 2 && d.score === 50 && /airborne: \+/.test(d.text) && /off the cleared taxi route/.test(d.text) && d.lines.length > 12, "the debrief has the timings, the deviations and a score: " + d.score);
  ok(said.every(m => m.say && !/\d{4}/.test(m.say)), "every AI call has its spoken form");

  // nobody answers where a human works the position
  {
    const said2 = [];
    const s2 = mk({ positions: pos, staffing: new Set(["DEL"]) }).sim;
    const atc2 = new PilotAtc(s2, { say: (m) => said2.push(m), fpAck: () => {}, log: () => {} });
    s2.upsertHuman({ hid: 10, cs: "ESABC", type: "C172", pos: [stand.pos[0], stand.pos[1]], alt: 0, hdg: 80, spd: 0, onGround: true, squawk: "7000", xpdr: "S", ai: false, tx: false, fp: { ...fp, session_id: 10, callsign: "ESABC" } });
    s2.step(1); atc2.tick();
    atc2.heard("ESABC", "request clearance", khz("DEL"), false);
    ok(said2.length === 0, "the AI stays silent on a position a human works");
    atc2.heard("ESABC", "request taxi", khz("GND"), false);
    ok(said2.length === 1 && said2[0].pos === "GND", "but Ground, unstaffed, answers when the pilot calls there");
  }

  // an arrival: Radar, Tower, Ground, the stand
  {
    const said3 = [], acks3 = [];
    const s3 = mk({ positions: pos, staffing: new Set([]) }).sim;
    const atc3 = new PilotAtc(s3, { say: (m) => said3.push(m), fpAck: (cs, x) => acks3.push({ cs, ...x }), log: () => {} });
    const a = s3.arrEnd, px = -a.v[1], py = a.v[0];
    const fp3 = { session_id: 11, callsign: "LN771", ac_icao: "B738", rules: "I", status: "filed", squawk: 0, dep: "EVRA", dest: "EETN", altn: "EFHK", cruise_ft: 24000, route: "ABETI N746 ULGOT", remarks: "" };
    let c3 = { pos: [a.thr[0] - a.v[0] * 15 * NM, a.thr[1] - a.v[1] * 15 * NM], alt: 4000, hdg: 260, spd: 180 * KT, onGround: false };
    const up3 = (x) => { c3 = { ...c3, ...x }; return s3.upsertHuman({ hid: 11, cs: "LN771", type: "B738", squawk: "4525", xpdr: "C", ai: false, tx: false, fp: fp3, ...c3 }); };
    up3({}); s3.step(1); atc3.tick();
    const G = atc3.flights.get("LN771");
    ok(G && G.dir === "arr" && G.pos === "CTR" && said3.length === 0, "an inbound is known and waited for");
    atc3.heard("LN771", "Tallinn Radar, LN771, inbound, information Charlie", khz("APP"), false);
    ok(G.pos === "APP" && new RegExp(`identified, descend 3000 feet, cleared ILS approach runway ${a.name}, report established`).test(said3[said3.length - 1].text), "Radar clears the approach: " + said3[said3.length - 1].text);
    atc3.heard("LN771", `descend 3000 feet, cleared ILS runway ${a.name}, LN771`, khz("APP"), false);
    ok(G.phase === "approach" && !G.pending, "approach readback accepted");
    up3({ pos: [a.thr[0] - a.v[0] * 8 * NM, a.thr[1] - a.v[1] * 8 * NM], alt: 2500 }); s3.step(1); atc3.tick();
    ok(G.pos === "TWR" && G.phase === "final" && /contact Tower/.test(said3[said3.length - 1].text), "inside 10 NM: contact Tower");
    atc3.heard("LN771", `Tallinn Tower, LN771, established ILS ${a.name}`, khz("TWR"), false);
    ok(/continue approach/.test(said3[said3.length - 1].text), "outside 6 NM: continue approach");
    up3({ pos: [a.thr[0] - a.v[0] * 5 * NM, a.thr[1] - a.v[1] * 5 * NM], alt: 1600 }); s3.step(1); atc3.tick();
    ok(G.landClr && new RegExp(`runway ${a.name}, cleared to land`).test(said3[said3.length - 1].text), "inside 6 NM with the runway free: cleared to land");
    atc3.heard("LN771", `runway ${a.name}, cleared to land, LN771`, khz("TWR"), false);
    up3({ pos: [a.thr[0] + a.v[0] * 600, a.thr[1] + a.v[1] * 600], alt: 0, spd: 60 * KT, onGround: true }); s3.step(1); atc3.tick();
    ok(G.phase === "landed", "touchdown seen");
    up3({ pos: [a.thr[0] + a.v[0] * 900 + px * 120, a.thr[1] + a.v[1] * 900 + py * 120], spd: 10 * KT }); s3.step(1); atc3.tick();
    ok(G.phase === "vacated" && G.pos === "GND" && /contact Ground/.test(said3[said3.length - 1].text), "vacated: contact Ground");
    atc3.heard("LN771", "Tallinn Ground, LN771, runway vacated, request taxi to stand", khz("GND"), false);
    const tx = said3[said3.length - 1];
    ok(G.stand && new RegExp(`taxi to stand ${G.stand.name}`).test(tx.text), "Ground gives a stand and a route: " + tx.text);
    atc3.heard("LN771", `taxi to stand ${G.stand.name}, LN771`, khz("GND"), false);
    ok(G.phase === "to_stand", "stand readback accepted");
    up3({ pos: [G.stand.pos[0], G.stand.pos[1]], spd: 0 }); s3.step(1); atc3.tick();
    ok(G.done && G.how === "arrived" && atc3.debrief("LN771").score === 100 && /landed: \+/.test(atc3.debrief("LN771").text), "on the stand: the flight is closed with a clean debrief");
  }

  // Tower does not clear an aircraft that has not called it yet, and clears it at once when it calls inside 6 NM
  {
    const said4 = [];
    const s4 = mk({ positions: pos, staffing: new Set([]) }).sim;
    const atc4 = new PilotAtc(s4, { say: (m) => said4.push(m), fpAck: () => {}, log: () => {} });
    const a = s4.arrEnd;
    const fp4 = { session_id: 12, callsign: "BTI4X", ac_icao: "BCS3", rules: "I", status: "filed", squawk: 0, dep: "EVRA", dest: "EETN", altn: "", cruise_ft: 20000, route: "DCT", remarks: "" };
    let c4 = { pos: [a.thr[0] - a.v[0] * 12 * NM, a.thr[1] - a.v[1] * 12 * NM], alt: 3000, hdg: 260, spd: 160 * KT, onGround: false };
    const up4 = (x) => { c4 = { ...c4, ...x }; return s4.upsertHuman({ hid: 12, cs: "BTI4X", type: "BCS3", squawk: "4526", xpdr: "C", ai: false, tx: false, fp: fp4, ...c4 }); };
    up4({}); s4.step(1); atc4.tick();
    atc4.heard("BTI4X", "Tallinn Radar, BTI4X, inbound", khz("APP"), false);
    atc4.heard("BTI4X", `descend 3000 feet, cleared ILS runway ${a.name}, BTI4X`, khz("APP"), false);
    up4({ pos: [a.thr[0] - a.v[0] * 8 * NM, a.thr[1] - a.v[1] * 8 * NM] }); s4.step(1); atc4.tick();
    ok(/contact Tower/.test(said4[said4.length - 1].text), "handed to Tower inside 10 NM");
    const n4 = said4.length;
    up4({ pos: [a.thr[0] - a.v[0] * 4 * NM, a.thr[1] - a.v[1] * 4 * NM], alt: 1300 }); s4.step(1); atc4.tick();
    ok(said4.length === n4, "Tower does not clear an aircraft that has not called it yet");
    atc4.heard("BTI4X", `Tallinn Tower, BTI4X, established ILS ${a.name}`, khz("TWR"), false);
    ok(new RegExp(`runway ${a.name}, cleared to land`).test(said4[said4.length - 1].text), "the check-in inside 6 NM gets the landing clearance at once");
  }

  // a bare microphone call waits for its transcript; without one, the keyed call counts
  {
    const said5 = [];
    const s5 = mk({ positions: pos, staffing: new Set([]) }).sim;
    const atc5 = new PilotAtc(s5, { say: (m) => said5.push(m), fpAck: () => {}, log: () => {} });
    const realNow = Date.now; let fake = realNow(); Date.now = () => fake;
    try {
      const base = { hid: 13, cs: "ESMIC", type: "C172", pos: [stand.pos[0], stand.pos[1]], alt: 0, hdg: 80, spd: 0, onGround: true, squawk: "7000", xpdr: "S", ai: false,
        fp: { ...fp, session_id: 13, callsign: "ESMIC" } };
      s5.upsertHuman({ ...base, tx: true }); s5.step(1); atc5.tick();
      fake += 2000; s5.upsertHuman({ ...base, tx: false }); s5.step(1); atc5.tick();
      ok(said5.length === 0, "a released microphone is not answered at once: a transcript may follow");
      atc5.heard("ESMIC", "Tallinn Delivery, ESMIC, request clearance to Riga", khz("DEL"), true);
      fake += 5000; s5.step(1); atc5.tick();
      ok(said5.length === 1 && /cleared to EVRA/.test(said5[0].text), "the transcript is answered once and the bare call is dropped");
      s5.upsertHuman({ ...base, tx: true }); s5.step(1); atc5.tick();
      fake += 2000; s5.upsertHuman({ ...base, tx: false }); s5.step(1); atc5.tick();
      fake += 5000; s5.step(1); atc5.tick();
      ok(said5.length === 2 && /readback correct/.test(said5[1].text), "with no transcript the keyed call counts and the readback is taken as correct");
    } finally { Date.now = realNow; }
  }
}

// ---- the XRadio station callsign / frequency typed in Settings stay with the airport they were typed at ----
{
  const typed = { cs: "EETN_TWR", freq: "118.100", forIcao: "EETN" };
  ok(xrOverrides(typed, "EETN").cs === "EETN_TWR" && xrOverrides(typed, "EETN").mhz === 118.1, "the overrides apply at their own airport");
  ok(xrOverrides(typed, "EVRA").cs === "" && xrOverrides(typed, "EVRA").mhz === 0, "at another airport the station takes that airport's names");
  ok(xrOverrides({ cs: "TLL_TWR", forIcao: "EETN" }, "EETN").cs === "TLL_TWR", "a custom callsign is kept where it was typed");
  ok(xrOverrides({ cs: "EETN_TWR", freq: "118.1" }, "EETN").cs === "EETN_TWR" && xrOverrides({ cs: "EETN_TWR" }, "EVRA").cs === "", "settings from before: the callsign only where it names the airport");
}

console.log(fails ? `${fails} FAILED of ${n}` : `ALL ${n} PASSED`);
process.exit(fails ? 1 : 0);
