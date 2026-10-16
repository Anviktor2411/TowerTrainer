// PART E: automatic ATC -- airport profiles, controllers with their own style, the phraseology validator, full auto
// for an hour, assist = auto, take-over / hand-back, and the AI controller with a (fake) XRadio pilot.
//   node tests/autoatc.test.mjs [minutes]       (default 60 simulated minutes per airport)
import { readFileSync, existsSync } from "node:fs";
import { Airport } from "../web/js/airport.js";
import { Sim } from "../web/js/sim.js";
import { buildPositions } from "../web/js/positions.js";
import { PilotAtc } from "../web/js/pilotatc.js";
import { parse } from "../web/js/commands.js";
import { defaultProfile, mergeProfile, applyProfile, makeController, style, validate, workload } from "../web/js/autoatc.js";

const MINUTES = +(process.argv[2] || 60);
let seed = 21;
Math.random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
let fails = 0;
const ok = (c, m) => { console.log((c ? "PASS  " : "FAIL  ") + m); if (!c) fails++; };
const NM = 1852, KT = 0.514444;
const load = (icao) => new Airport(JSON.parse(readFileSync(new URL(`../cache/${icao}.json`, import.meta.url), "utf8")));
const file = (icao) => { const u = new URL(`../data/airports/${icao}.json`, import.meta.url); return existsSync(u) ? JSON.parse(readFileSync(u, "utf8")) : {}; };

// ---------------------------------------------------------------- E8: profiles
const profiles = {};
for (const icao of ["EETN", "EGLL", "KJFK"]) {
  const apt = existsSync(new URL(`../cache/${icao}.json`, import.meta.url)) ? load(icao) : null;
  const pos = apt ? buildPositions(apt) : null;
  const p = mergeProfile(defaultProfile(icao, apt, pos), file(icao));
  if (pos) applyProfile(p, pos);
  profiles[icao] = { p, pos, apt };
}
ok(profiles.EETN.p.units.TWR === "Tallinn Tower" && profiles.EETN.p.units.APP === "Tallinn Radar" && profiles.EETN.p.region === "ICAO", "EETN: Tallinn Tower / Tallinn Radar, ICAO phraseology");
ok(profiles.EGLL.p.units.APP === "Heathrow Director" && profiles.EGLL.p.region === "UK" && profiles.EGLL.p.habits.landAfter, "EGLL: Heathrow Director, CAP 413, 'land after' used");
ok(profiles.KJFK.p.units.GND === "Kennedy Ground" && profiles.KJFK.p.units.DEL === "Kennedy Clearance" && profiles.KJFK.p.region === "US" && profiles.KJFK.p.transitionAlt === 18000, "KJFK: Kennedy Ground / Clearance, FAA, transition altitude 18000");
if (profiles.KJFK.pos) {
  const s = new Sim(profiles.KJFK.apt, { positions: profiles.KJFK.pos, staffing: new Set(["TWR"]), populate: false });
  ok(s.unitName("GND") === "Kennedy Ground" && s.positions.APP.name === "New York Approach", "the profile renames the units the sim and the pilots use");
}
const gen = defaultProfile("LFPG");
ok(gen.units.TWR === "LFPG Tower" && gen.localLanguage && gen.localLanguage.lang === "fr", "defaults generated for any airport (LFPG: French to French pilots)");

// ---------------------------------------------------------------- E8: the same situation in three regions
const fixed = (over = {}) => ({ id: "TWR-0", name: "Kati", gender: "F", nat: "EE", rate: 1, chatty: 0.5, greets: false, trafficInfo: 0.5, windFirst: false, knotsShort: false, slip: false, ...over });
const ctx = (region, over = {}) => ({ ctrl: fixed(over.ctrl), profile: { ...profiles[{ US: "KJFK", UK: "EGLL", ICAO: "EETN" }[region]].p }, load: "normal", first: false, ...over, ctrl: fixed(over.ctrl) });
const land = "BTI123, runway 26, cleared to land, wind 240 degrees 12 knots";
const usLand = style(land, ctx("US", { ctrl: { knotsShort: true } }));
ok(/^BTI123, wind 240 at 12, runway 26, cleared to land$/.test(usLand), "US: " + usLand);
ok(/^BTI123, runway 26, cleared to land, wind 240 degrees 12 knots$/.test(style(land, ctx("ICAO"))), "ICAO: runway, cleared to land, wind");
ok(/wind 240 degrees 12 knots, runway 26, cleared to land/.test(style(land, ctx("UK", { ctrl: { windFirst: true } }))), "UK (this controller): the wind first");
const taxi = "BTI123, taxi to holding point runway 22L via B A";
ok(/taxi to runway 22L via B A/.test(style(taxi, ctx("US"))) && /taxi to holding point runway 22L/.test(style(taxi, ctx("ICAO"))), "US 'taxi to runway 22L', ICAO 'taxi to holding point runway 22L'");
ok(!/position and hold/.test(style("BTI123, runway 26, position and hold", ctx("US"))), "'position and hold' is never used (US: line up and wait)");
for (const r of ["US", "UK", "ICAO"]) {
  const t = style(land, ctx(r, { ctrl: { knotsShort: r === "US" } }));
  ok(validate(t, r).ok, `${r} landing clearance passes the ${r} validator: ${t}`);
}
ok(!validate("BTI123, runway 26, cleared to land", "ICAO").ok && !validate("BTI123, position and hold runway 26", "US").ok && !validate("BTI123, climb FL120", "ICAO").ok && !validate("BTI123, squawk 4589", "ICAO").ok, "the validator rejects: no wind, 'position and hold', 'FL', a non-octal squawk");

// ---------------------------------------------------------------- E8: busy vs quiet
const quiet = style("BTI123, runway 26, cleared to land, wind 240 degrees 12 knots", { ...ctx("ICAO", { ctrl: { chatty: 0.9, greets: true } }), load: "quiet", first: true, hour: 9 });
const busy = style("BTI123, runway 26, cleared to land, wind 240 degrees 12 knots", { ...ctx("ICAO", { ctrl: { chatty: 0.9, greets: true } }), load: "busy", first: true, hour: 9 });
ok(/good morning/.test(quiet) && /report vacated/.test(quiet) && busy.length < quiet.length && !/good morning/.test(busy), `quiet: full ("${quiet}"), busy: short ("${busy}")`);
const cq = style("BTI123, contact Tallinn Radar 127.905", { ...ctx("ICAO", { ctrl: { chatty: 0.8 } }), load: "quiet" }), cb = style("BTI123, contact Tallinn Radar 127.905", { ...ctx("ICAO", { ctrl: { chatty: 0.8 } }), load: "busy" });
ok(/goodbye$/.test(cq) && !/goodbye/.test(cb), "a goodbye when it is quiet, none when busy");
ok(makeController("TWR", profiles.EETN.p, 0, 5).voiceSeed !== makeController("TWR", profiles.EETN.p, 1, 5).voiceSeed && makeController("TWR", profiles.EETN.p, 0, 5).nat === "EE" && makeController("TWR", profiles.EGLL.p, 0, 5).nat === "GB", "every shift its own voice; Estonian controllers at EETN, British at EGLL");

// ---------------------------------------------------------------- the auto runs
const auto = (icao, minutes) => {
  const apt = load(icao), pos = buildPositions(apt);
  const prof = mergeProfile(defaultProfile(icao, apt, pos), file(icao));
  applyProfile(prof, pos);
  const radio = [], alerts = [], events = [];
  const sim = new Sim(apt, { positions: pos, staffing: new Set(["TWR"]), onRadio: (m) => radio.push({ ...m, at: sim.t }), onAlert: (m) => alerts.push({ t: sim.t, m }), onEvent: (e) => events.push({ t: sim.t, snap: e.ac && e.intr ? `${e.ac.state} ${Math.round(e.ac.alt)}ft h${Math.round(e.ac.hdg)} ${(Math.hypot(...e.ac.pos) / 1852).toFixed(1)}NM / ${e.intr.state} ${e.intr.circuitLeg || ''} ${Math.round(e.intr.alt)}ft h${Math.round(e.intr.hdg)} ${(Math.hypot(...e.intr.pos) / 1852).toFixed(1)}NM, apart ${(Math.hypot(e.ac.pos[0] - e.intr.pos[0], e.ac.pos[1] - e.intr.pos[1]) / 1852).toFixed(2)}NM ${e.kind} pos ${e.ac.pos.map(Math.round)} / ${e.intr.pos.map(Math.round)} spd ${Math.round(e.ac.spd)}/${Math.round(e.intr.spd)} orbit ${e.intr.orbitDir || ''} ba ${e.intr.baseAfter ? e.intr.baseAfter.cs : ''} side ${e.intr.circuitSide} wpi ${e.intr.wpi} wps ${(e.intr.wps || []).map(w => w.leg + ":" + w.p.map(Math.round)).join(" ")}` : '', ...e }), abnormals: false, vfrPerHour: 1 });
  sim.profile = prof; sim.ctrlSeed = 9;
  sim.setMode("ALL", "auto");
  const r0 = apt.runways.find(r => apt.entries(r.ends[0]).length && apt.entries(r.ends[1]).length) || apt.runways[0];
  sim.setRunway(r0.ends[1].name);
  sim.setWind({ dir: Math.round(r0.ends[1].hdg / 10) * 10 % 360, spd: 8, gust: 0 });
  // the airport's own capacity: Tallinn (one runway) at its normal rates, O'Hare busy
  sim.depPerHour = icao === "KORD" ? 20 : 10; sim.arrPerHour = icao === "KORD" ? 16 : 8; sim.waves = false;
  const stuck = new Map();
  for (let i = 0; i < minutes * 60 * 2; i++) {
    sim.step(0.5);
    if (i % 120 === 0) for (const a of sim.ac) if (!a.veh && !a.human && a.reqAt != null && sim.t - a.reqAt > 600 && !["parked"].includes(a.state)) stuck.set(a.cs, `${a.state} on ${a.freq}`);
  }
  if (process.env.DIAG) {
    // what led to each problem: the radio of the aircraft involved and their states
    const show = (cs, t0, t1) => radio.filter(r => r.at > t0 && r.at < t1 && ((r.ac && r.ac.cs === cs) || (r.from === "atc" && r.text.includes(cs.slice(-3))))).forEach(r => console.log(`   ${r.at.toFixed(0)} ${r.pos} ${r.ac ? r.ac.cs : "ATC"}: ${r.text}`));
    for (const e of (sim.stats.atcErrors || []).filter(e => /^AI /.test(e.by))) { console.log("DIAG atcError", e.t.toFixed(0), e.text); for (const cs of new Set(e.text.match(/\b[A-Z]{2,3}[A-Z0-9]{1,5}\b/g) || [])) show(cs, e.t - 240, e.t + 5); }
    for (const al of alerts.filter(x => /Runway conflict|went around|cleared for takeoff with/.test(x.m))) {
      console.log("DIAG alert", al.t.toFixed(0), al.m);
      for (const cs of new Set(al.m.match(/\b[A-Z]{2,3}[A-Z0-9]{1,5}\b/g) || [])) show(cs, al.t - 200, al.t + 5);
    }
    for (const e of events.filter(e => e.type === "tcas" && ["ra", "ta"].includes(e.kind))) console.log("DIAG RA", e.t.toFixed(0), e.ac.cs, e.ac.kind, e.ac.ga ? "GA" : "", "vs", e.intr.cs, e.intr.kind, e.intr.ga ? "GA" : "", "|", e.snap);
    for (const a of sim.ac.filter(a => !a.veh && !a.human && a.reqAt != null && sim.t - a.reqAt > 600 && a.state !== "parked")) { if (a.blockedRwy != null) { const d = sim.runwayDanger(a.blockedRwy, a, { finalNm: 1.5, finalSec: 45 }); console.log("DIAG stuck-rwy", a.cs, "dep rwy", a.depEnd && a.depEnd.rwy, "crossOk", [...(a.crossOk || [])], "crossGo", a.crossGo && [...a.crossGo], "toClr", a.toClr, "danger", d.busy, d.why, d.by && d.by.cs, d.by && d.by.state, "users", sim.runwayUsers(a.blockedRwy, a).map(o => o.cs + ":" + o.state + ":" + (o.waitOn ? o.waitOn.cs : "")).join(",")); }
      console.log("DIAG stuck", a.cs, a.kind, a.state, a.freq, "wait", a.waitOn && a.waitOn.cs, a.waitOn && a.waitOn.state, a.blockWhy || "", "atStop", a.atStop, a.blockedRwy, "spd", a.spd.toFixed(1)); for (let o = a.waitOn, k = 0; o && k < 6; o = o.waitOn, k++) console.log("    -> ", o.cs, o.kind, o.state, o.freq, "why", o.blockWhy || "", "atStop", o.atStop, o.blockedRwy, "spd", (o.spd || 0).toFixed(1), "pi", o.pi, o.path && o.path.length, "assist:", JSON.stringify(sim.assistFor(o, o.freq))); }
  }
  return { sim, radio, alerts, events, prof };
};
for (const icao of ["EETN", "KORD"]) {
  if (!existsSync(new URL(`../cache/${icao}.json`, import.meta.url))) { console.log(`SKIP  ${icao} not cached`); continue; }
  const t0 = Date.now();
  const { sim, alerts, events, prof } = auto(icao, MINUTES);
  const st = sim.stats;
  const autoTx = events.filter(e => e.type === "autoAtc");
  const bad = autoTx.filter(e => !validate(e.text, prof.region).ok);
  const aiErr = (st.atcErrors || []).filter(e => /^AI /.test(e.by));
  const runway = alerts.filter(a => /Runway conflict|cleared for takeoff with/.test(a.m));
  ok(st.departures + st.arrivals >= MINUTES / 6, `${icao} ${MINUTES} min full auto: ${st.departures} departures, ${st.arrivals} arrivals, ${autoTx.length} AI transmissions (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  ok(runway.length === 0 && aiErr.length === 0, `${icao}: no runway conflict or incursion caused by the AI controllers${runway.length || aiErr.length ? ": " + [...runway.map(a => a.m), ...aiErr.map(e => e.text)].slice(0, 3).join(" | ") : ""}`);
  ok((st.stca || 0) === 0 || events.filter(e => e.type === "tcas" && e.kind === "ra").length === 0, `${icao}: no TCAS RA between the AI controllers' aircraft (STCA ${st.stca || 0})`);
  const stuckNow = sim.ac.filter(a => !a.veh && !a.human && a.reqAt != null && sim.t - a.reqAt > 600 && a.state !== "parked");
  ok(stuckNow.length === 0, `${icao}: no stuck aircraft${stuckNow.length ? ": " + stuckNow.map(a => `${a.cs} ${a.state}/${a.freq}`).slice(0, 4).join(", ") : ""}`);
  ok(bad.length === 0, `${icao}: every generated phrase passes the ${prof.region} validator${bad.length ? ": " + bad.slice(0, 2).map(e => e.text + " (" + e.problems.join("; ") + ")").join(" | ") : ""}`);
  // shifts last 45-90 min: end the current one on a position with traffic on frequency
  const natural = events.filter(e => e.type === "shiftChange").length;
  const busyPos = ["TWR", "APP", "GND", "CTR", "DEL"].find(p => sim.ac.some(a => a.freq === p && !a.veh));
  const before = busyPos && sim.controllerFor(busyPos);
  if (before) before.start = sim.t - before.shiftLength - 1;
  const after = busyPos && sim.controllerFor(busyPos);
  const shifts = events.filter(e => e.type === "shiftChange");
  ok(!!busyPos && after.shift === before.shift + 1 && after.voiceSeed !== before.voiceSeed && shifts.some(e => e.pos === busyPos && /new controller, information \w+ current/.test(e.text)),
    `${icao}: shift change: a new controller with a new voice announces itself on ${busyPos} (${natural} during the run)`);
}
{ // assist suggestions = what full auto would send
  const apt = load("EETN"), pos = buildPositions(apt);
  const sim = new Sim(apt, { positions: pos, staffing: new Set(["DEL", "GND", "TWR", "APP", "CTR"]), abnormals: false });
  sim.setMode("ALL", "assist");
  let compared = 0, same = 0;
  for (let i = 0; i < 2400; i++) {
    sim.step(0.5);
    if (i % 20) continue;
    for (const a of sim.ac) {
      if (a.veh || a.human) continue;
      const s = sim.assistFor(a, a.freq);
      if (!s) continue;
      const shadow = { ...a, crossOk: new Set(a.crossOk || []), reports: { ...(a.reports || {}) } };
      const real = sim.aiDecide(shadow, a.freq);
      compared++; if (real === s.text) same++; else if (process.env.DIAG) console.log("DIAG assist", a.cs, a.state, a.freq, "|", s.text, "|", real);
      // play the controller: send it
      sim.atc(a.freq, s.text);
    }
  }
  ok(compared > 5 && same === compared, `assist suggestions match what full auto would send (${same}/${compared})`);
}
{ // take over and hand back mid-session
  const apt = load("EETN"), pos = buildPositions(apt);
  const events = [];
  const sim = new Sim(apt, { positions: pos, staffing: new Set(["TWR"]), onEvent: (e) => events.push({ t: sim.t, ...e }), abnormals: false });
  sim.setMode("ALL", "auto");
  sim.depPerHour = 20; sim.arrPerHour = 16;
  for (let i = 0; i < 1800; i++) sim.step(0.5);
  ok(!sim.userWorks("TWR") && events.some(e => e.type === "autoAtc" && e.pos === "TWR"), "full auto: the AI works Tower");
  sim.setMode("TWR", "manual");
  const tTake = sim.t;
  for (let i = 0; i < 600; i++) sim.step(0.5);
  ok(sim.userWorks("TWR") && !events.some(e => e.type === "autoAtc" && e.pos === "TWR" && e.t > tTake), "taken over: the AI says nothing more on Tower");
  sim.setMode("TWR", "auto");
  const tBack = sim.t;
  for (let i = 0; i < 1200; i++) sim.step(0.5);
  ok(events.some(e => e.type === "autoAtc" && e.pos === "TWR" && e.t > tBack), "handed back: the AI works Tower again");
}
{ // the AI controller with a real (fake) XRadio pilot: a wrong readback corrected, a runway entered without clearance stopped
  const apt = load("EETN"), pos = buildPositions(apt);
  const sim = new Sim(apt, { positions: pos, staffing: new Set(["TWR"]), populate: false, serviceVehicles: 0 });
  sim.nextDep = sim.nextArr = sim.nextVfr = sim.nextOvf = 1e9;
  sim.setMode("ALL", "auto");
  const said = [];
  const atc = new PilotAtc(sim, { say: (m) => said.push(m), fpAck: () => {}, log: () => {} });
  const khz = (k) => Math.round(pos[k].mhz * 1000);
  const stand = apt.stands.find(s => s.types && s.types.includes("jets")) || apt.stands[0];
  const fp = { session_id: 9, callsign: "ESXYZ", ac_icao: "A320", rules: "I", status: "filed", squawk: 0, dep: "EETN", dest: "EVRA", cruise_ft: 36000, route: "DCT" };
  let cur = { pos: [stand.pos[0], stand.pos[1]], alt: 0, hdg: 80, spd: 0, onGround: true };
  const upd = (x) => { cur = { ...cur, ...x }; return sim.upsertHuman({ hid: 9, cs: "ESXYZ", type: "A320", squawk: "2000", xpdr: "S", fp, ...cur }); };
  upd({}); sim.step(1); atc.tick();
  atc.heard("ESXYZ", "Tallinn Delivery, ESXYZ, request clearance to Riga", khz("DEL"));
  const clr = said[said.length - 1];
  ok(clr && /cleared to EVRA/.test(clr.text), "auto Delivery clears the real pilot: " + (clr && clr.text));
  atc.heard("ESXYZ", "cleared to Riga, squawk 1234, ESXYZ", khz("DEL"));
  ok(/negative, .*read back/.test(said[said.length - 1].text), "a wrong readback is corrected: " + said[said.length - 1].text);
  const r = apt.runways[sim.depEnd.rwy];
  const onRwy = [(r.ends[0].pos[0] + r.ends[1].pos[0]) / 2, (r.ends[0].pos[1] + r.ends[1].pos[1]) / 2];
  upd({ pos: onRwy, spd: 4 * KT }); sim.step(1); atc.tick();
  ok(said.some(m => /stop immediately|hold position/.test(m.text)), "the real pilot on the runway without clearance is stopped: " + said[said.length - 1].text);
}
console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
