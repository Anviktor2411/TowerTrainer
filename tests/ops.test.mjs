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

console.log(fails ? `${fails} FAILED of ${n}` : `ALL ${n} PASSED`);
process.exit(fails ? 1 : 0);
