// PART A: one traffic-awareness system for AI aircraft, real pilots (humans) and vehicles.
//   ground conflicts, right of way, deadlocks, pushback, runway safety net (A10), approach spacing, a stopped human
//   blocking a taxiway (A9), 150 movers.         node tests/traffic.test.mjs
import { readFileSync } from "node:fs";
import { Airport, dist, hdgOf, vecFromHdg } from "../web/js/airport.js";
import { Sim } from "../web/js/sim.js";
import { parse } from "../web/js/commands.js";

let seed = 7;
Math.random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
let fails = 0;
const ok = (c, m) => { console.log((c ? "PASS  " : "FAIL  ") + m); if (!c) fails++; };
const NM = 1852, KT = 0.514444, FT = 0.3048;
const apt = new Airport(JSON.parse(readFileSync(new URL("../cache/EETN.json", import.meta.url), "utf8")));

const mk = () => {
  const radio = [], alerts = [], events = [];
  const sim = new Sim(apt, { onRadio: (m) => radio.push(m), onAlert: (m) => alerts.push(m), onEvent: (e) => events.push(e), populate: false, serviceVehicles: 0 });
  sim.setRunway("26"); sim.nextDep = sim.nextArr = sim.nextVfr = sim.nextOvf = 1e9; sim.vfrPerHour = 0; sim.abnormals = { on: false, perHour: 0 };
  return { sim, radio, alerts, events };
};
const say = (sim, a, text) => { const p = parse(`${a.cs} ${text}`, sim.ac, a); return sim.respond(p.ac || a, p.ins, { text: p.normalized }); };
const txt = (r) => (r && (r.d || r.unable || r.text)) || JSON.stringify(r);
const said = (radio, a, re) => radio.some(m => m.ac === a && re.test(m.text));

// ---- a taxiway intersection away from the runways: node X with three or more taxiway edges
const zoneFree = (n) => apt.adj[n].every(o => !o.e.runway && !(o.e.zones && o.e.zones.size));
let X = null, legs = null;
for (let n = 0; n < apt.nodes.length && !X; n++) {
  if (apt.nodeStand.has(n) || apt.adj[n].length < 3 || !zoneFree(n)) continue;
  const nb = apt.adj[n].filter(o => !o.e.runway && o.e.name && zoneFree(o.to) && !apt.nodeStand.has(o.to)).map(o => ({ to: o.to, h: hdgOf(apt.nodes[o.to][0] - apt.nodes[n][0], apt.nodes[o.to][1] - apt.nodes[n][1]) }));
  for (const p of nb) for (const q of nb) {
    const d = Math.abs(((p.h - q.h + 540) % 360) - 180);
    if (p !== q && d > 60 && d < 120) { X = n; legs = [p, q, nb.find(r => r !== p && r !== q)]; break; }
  }
}
ok(X != null, `a taxiway intersection for the tests (node ${X})`);
const XP = apt.nodes[X];
/** A path that starts `back` metres before X coming from leg `from`, through X, out along leg `to`. */
const through = (from, to, back = 130) => {
  const v = vecFromHdg(from.h);
  const start = [XP[0] + v[0] * back, XP[1] + v[1] * back];
  const w = vecFromHdg(to.h);
  return { start, hdg: (from.h + 180) % 360, path: [[...start, null], [...XP, X], [XP[0] + w[0] * 150, XP[1] + w[1] * 150, null]] };
};
const taxiing = (sim, cs, route) => {
  const f = sim.makeFlight(null, false);
  Object.assign(f, { cs, kind: "dep", state: "taxi", pos: [...route.start], hdg: route.hdg, spd: 7, onGround: true, alt: 0, path: route.path, pi: 1,
    depEnd: sim.depEnd, freq: "ALL", xpdr: "C", ifr: true, squawk: "2001", callAt: 1e9 });
  sim.ac.push(f);
  return f;
};
/** A real pilot (XRadio) moving in a straight line, updated 3 times a second like the bridge does. */
const human = (sim, cs, pos, hdg, spd, extra = {}) => sim.upsertHuman({ hid: cs, cs, type: "B738", pos, alt: extra.alt || 0, hdg, spd, onGround: extra.onGround ?? true, squawk: "2000", xpdr: "C" });
const runFor = (sim, sec, each) => { for (let i = 0; i < sec * 10; i++) { sim.step(0.1); if (each) each(i); } };

// ---------------------------------------------------------------- A1 crossing AI aircraft
{
  const { sim } = mk();
  const A = taxiing(sim, "TST1", through(legs[0], legs[1]));
  const B = taxiing(sim, "TST2", through(legs[2], legs[0], 125));
  let minD = Infinity, aStopped = false, bStopped = false;
  runFor(sim, 120, () => { minD = Math.min(minD, dist(A.pos, B.pos)); if (A.spd < 0.2 && A.pi <= 1) aStopped = true; if (B.spd < 0.2 && B.pi <= 1) bStopped = true; });
  ok(minD > 30, `two AI aircraft at an intersection never closer than 30 m (min ${minD.toFixed(0)} m)`);
  ok(aStopped !== bStopped || (aStopped && bStopped), `one of them gave way (A stopped ${aStopped}, B stopped ${bStopped})`);
  ok(A.pi >= 3 && B.pi >= 3, `no deadlock: both passed the intersection (A ${A.pi}/3, B ${B.pi}/3)`);
}
// ---------------------------------------------------------------- A1 the same with a real pilot crossing
{
  const { sim } = mk();
  const A = taxiing(sim, "TST3", through(legs[0], legs[1]));
  // the real pilot comes across from the other side and leaves along the taxiway A wants: A must let it pass first
  const hv = vecFromHdg(legs[1].h);
  const r = { start: [XP[0] - hv[0] * 110, XP[1] - hv[1] * 110], hdg: legs[1].h };
  let hp = [...r.start];
  const H = human(sim, "HUM1", hp, r.hdg, 6);
  let minD = Infinity, waited = false;
  runFor(sim, 90, (i) => {
    if (i % 3 === 0) { const v = vecFromHdg(r.hdg); hp = [hp[0] + v[0] * 6 * 0.3, hp[1] + v[1] * 6 * 0.3]; human(sim, "HUM1", hp, r.hdg, 6); }
    minD = Math.min(minD, dist(A.pos, H.pos)); if (A.spd < 0.3 && dist(A.pos, XP) < 120) waited = true;
  });
  ok(waited && minD > 30, `AI stops for a crossing real pilot (min ${minD.toFixed(0)} m, waited ${waited})`);
  ok(A.pi >= 3, "and continues once the real pilot has passed");
}
// ---------------------------------------------------------------- A9 a stopped real pilot in the intersection
{
  const { sim, radio, events } = mk();
  const A = taxiing(sim, "TST4", through(legs[0], legs[1]));
  human(sim, "HUM2", [...XP], 0, 0);
  let t0 = null;
  runFor(sim, 100, () => { human(sim, "HUM2", [...XP], 0, 0); if (A.spd < 0.2 && t0 == null) t0 = sim.t; });
  ok(dist(A.pos, XP) > 30 && t0 != null, `AI waits for the stopped real pilot (${dist(A.pos, XP).toFixed(0)} m away)`);
  ok(said(radio, A, /request alternative routing, traffic blocking/), "after ~60 s it asks for alternative routing: " + (radio.filter(m => m.ac === A).map(m => m.text).pop() || ""));
  ok(events.some(e => e.type === "blocked" && e.by.cs === "HUM2") && (A.altRoute || sim.labelWarnings(A).some(w => /BLOCKED BY HUM2/.test(w))), "strip shows 'blocked by HUM2' / an alternative route is offered");
}
// ---------------------------------------------------------------- A2 no pushback into passing traffic
{
  const { sim, radio } = mk();
  const st = apt.stands.find(s => s.kind === "gate" && s.node != null) || apt.stands[0];
  const D = sim.makeFlight(st.types, false, { stand: st });
  sim.placeParked(D, st, false);
  Object.assign(D, { state: "push_req", ifr: true, assignedSq: "2002", squawk: "2002", callAt: 1e9 });
  const r = say(sim, D, "push and start approved");
  ok(D.state === "pushing", "push approved: " + txt(r));
  const target = D.path[D.path.length - 1];
  // an AI aircraft taxiing past the push target right now
  const n = apt.nearestNode(target), nb = apt.adj[n].find(o => !apt.nodeStand.has(o.to)) || apt.adj[n][0];
  const from = apt.nodes[nb.to], h = hdgOf(apt.nodes[n][0] - from[0], apt.nodes[n][1] - from[1]), v = vecFromHdg(h);
  const passer = taxiing(sim, "PASS1", { start: [apt.nodes[n][0] - v[0] * 70, apt.nodes[n][1] - v[1] * 70], hdg: h, path: [[apt.nodes[n][0] - v[0] * 70, apt.nodes[n][1] - v[1] * 70, null], [...apt.nodes[n], n], [apt.nodes[n][0] + v[0] * 400, apt.nodes[n][1] + v[1] * 400, null]] });
  let pushedWhileNear = false;
  runFor(sim, 20, () => { if (D.pushStarted && dist(passer.pos, target) < 60) pushedWhileNear = true; });
  ok(!pushedWhileNear && said(radio, D, /traffic passing behind/), "no pushback while an AI aircraft passes behind — the crew waits and says so");
  runFor(sim, 120);
  ok(D.pushStarted, "pushes once the traffic has passed");
  // the same with a real pilot behind
  const { sim: s2, radio: r2 } = mk();
  const D2 = s2.makeFlight(st.types, false, { stand: st });
  s2.placeParked(D2, st, false);
  Object.assign(D2, { state: "push_req", ifr: true, assignedSq: "2003", squawk: "2003", callAt: 1e9 });
  say(s2, D2, "push and start approved");
  const t2 = D2.path[D2.path.length - 1];
  let hp = [t2[0] - v[0] * 60, t2[1] - v[1] * 60], early = false;
  human(s2, "HUM3", hp, h, 5);
  runFor(s2, 15, (i) => { if (i % 3 === 0) { hp = [hp[0] + v[0] * 1.5, hp[1] + v[1] * 1.5]; human(s2, "HUM3", hp, h, 5); } if (D2.pushStarted && dist(hp, t2) < 60) early = true; });
  ok(!early && said(r2, D2, /traffic passing behind/), "no pushback while a real pilot taxis behind the stand");
}
// ---------------------------------------------------------------- A3 / A10 runways
const e26 = apt.findRunwayEnd("26");
const onFinal = (sim, nm, extra = {}) => {
  const f = sim.makeFlight(null, false);
  const pos = [e26.thr[0] - e26.v[0] * nm * NM, e26.thr[1] - e26.v[1] * nm * NM];
  Object.assign(f, { kind: "arr", state: "final", pos, hdg: e26.hdg, spd: f.appSpd, alt: 0, onGround: false, end: e26, landClr: false, squawk: "2100", assignedSq: "2100",
    xpdr: "C", ifr: true, callAt: 1e9, calledIn: true, cfl: 6000, freq: "ALL", ...extra });
  f.alt = sim.arrAlt(f);
  sim.ac.push(f);
  return f;
};
const linedUp = (sim, cs = "LUP1") => {
  const f = sim.makeFlight(null, false);
  const pos = [e26.thr[0] + e26.v[0] * 150, e26.thr[1] + e26.v[1] * 150];
  Object.assign(f, { cs, kind: "dep", state: "lined_up", pos, hdg: e26.hdg, spd: 0, onGround: true, alt: 0, depEnd: e26, ifr: true, squawk: "2200", assignedSq: "2200", xpdr: "C", callAt: 1e9, freq: "ALL", path: [], pi: 0 });
  sim.ac.push(f);
  return f;
};
for (const who of ["ai", "human", "vehicle"]) {
  const { sim, radio } = mk();
  const A = onFinal(sim, 4);
  let blocker = null;
  const rp = [e26.thr[0] + e26.v[0] * 900, e26.thr[1] + e26.v[1] * 900];
  if (who === "ai") blocker = linedUp(sim);
  else if (who === "human") blocker = human(sim, "HUMRW", rp, e26.hdg, 0);
  else { blocker = sim.spawnVehicle({ vtype: "ops", cs: "OPS1", tel: "Ops", num: "1", pos: rp }); blocker.state = "task"; blocker.path = []; blocker.pi = 0; }
  const r = say(sim, A, "runway 26 cleared to land");
  ok(/confirm cleared to land.*(traffic|vehicle) on the runway/i.test(txt(r)), `landing clearance with ${who === "ai" ? "an AI aircraft" : who === "human" ? "a real pilot" : "a vehicle"} on the runway → the crew queries: ${txt(r)}`);
  let gaAt = null;
  runFor(sim, 120, () => { if (who === "human") human(sim, "HUMRW", rp, e26.hdg, 0); if (A.state === "goaround" && gaAt == null) gaAt = sim.distToThr(A) * Math.tan(3 * Math.PI / 180) / FT; });
  ok(A.state === "goaround" && gaAt != null && gaAt > 250 && gaAt < 600, `…and goes around by itself at the decision height (${gaAt && gaAt.toFixed(0)} ft)`);
  ok(said(radio, A, /going around, traffic on the runway/), "radio: going around, traffic on the runway");
  ok((sim.stats.atcErrors || []).some(e => e.cs === A.cs || e.kind === "incursion"), "logged in the debrief as an ATC error: " + JSON.stringify((sim.stats.atcErrors || []).map(e => e.kind + " by " + e.by)));
}
{
  const { sim } = mk();
  const D = linedUp(sim, "LUP2");
  const hp = [e26.thr[0] - e26.v[0] * NM, e26.thr[1] - e26.v[1] * NM];
  human(sim, "HUMFIN", hp, e26.hdg, 140 * KT, { onGround: false, alt: 320 });
  const r = say(sim, D, "runway 26 cleared for takeoff");
  ok(/unable, traffic on .*final/i.test(txt(r)) && D.state !== "roll", "takeoff refused with a real pilot on 1 NM final: " + txt(r));
  ok(sim.stats.atcErrors.some(e => e.kind === "takeoffFinal"), "the takeoff clearance is logged as an ATC error");
}
{
  const { sim, radio } = mk();
  const D = linedUp(sim, "LUP3");
  const r = say(sim, D, "runway 26 cleared for takeoff");
  ok(D.state === "roll", "takeoff roll started: " + txt(r));
  runFor(sim, 4);
  const ahead = [e26.thr[0] + e26.v[0] * 1500, e26.thr[1] + e26.v[1] * 1500];
  human(sim, "HUMINC", ahead, (e26.hdg + 90) % 360, 3);
  runFor(sim, 1);
  ok(D.state === "rto" && said(radio, D, /stopping/), `late runway incursion below V1 → rejected takeoff (${D.state}, ${(D.spd / KT).toFixed(0)} kt)`);
  ok(sim.stats.atcErrors.some(e => e.kind === "incursion" && /HUMINC/.test(e.by)), "incursion logged with who caused it");
}
{
  // arrival spacing behind an AI and behind a real pilot
  for (const who of ["ai", "human"]) {
    const { sim } = mk();
    let lead;
    if (who === "ai") lead = onFinal(sim, 5, { appSpd: 115 * KT, spd: 115 * KT, cs: "SLOW1", landClr: true });
    else lead = human(sim, "HUMLEAD", [e26.thr[0] - e26.v[0] * 5 * NM, e26.thr[1] - e26.v[1] * 5 * NM], e26.hdg, 115 * KT, { onGround: false, alt: 1600 });
    const B = onFinal(sim, 8.4, { landClr: true });
    let minGap = Infinity, ga = false, hp = who === "human" ? lead.pos : null;
    runFor(sim, 150, (i) => {
      if (who === "human" && i % 3 === 0) { hp = [hp[0] + e26.v[0] * 115 * KT * 0.3, hp[1] + e26.v[1] * 115 * KT * 0.3]; const d = -((hp[0] - e26.thr[0]) * e26.v[0] + (hp[1] - e26.thr[1]) * e26.v[1]); human(sim, "HUMLEAD", hp, e26.hdg, 115 * KT, { onGround: d < 0, alt: Math.max(0, d * Math.tan(3 * Math.PI / 180) / FT) }); }
      if (B.state === "goaround") ga = true;
      const ld = who === "ai" ? (lead.state === "final" ? sim.distToThr(lead) : null) : (lead.onGround ? null : -((lead.pos[0] - e26.thr[0]) * e26.v[0] + (lead.pos[1] - e26.thr[1]) * e26.v[1]));
      if (ld != null && B.state === "final") minGap = Math.min(minGap, (sim.distToThr(B) - ld) / NM);
    });
    ok(ga || minGap >= 1.8, `spacing behind ${who === "ai" ? "an AI" : "a real pilot"} on final kept (min ${minGap.toFixed(2)} NM${ga ? ", went around" : ""})`);
    ok(B.spd <= 150 * KT, "the follower slowed down");
  }
}
// ---------------------------------------------------------------- A7 150 movers
{
  const { sim } = mk();
  const nodes = apt.nodes.map((p, i) => i).filter(i => !apt.nodeStand.has(i) && apt.adj[i].length && zoneFree(i));
  let made = 0;
  for (let k = 0; k < 600 && made < 150; k++) {
    const a = nodes[Math.floor(Math.random() * nodes.length)], b = nodes[Math.floor(Math.random() * nodes.length)];
    const route = apt.routeNodes(a, b);
    if (!route || route.length < 3) continue;
    const f = sim.makeFlight(null, false);
    Object.assign(f, { kind: "dep", state: "taxi", pos: [...apt.nodes[a]], hdg: 0, spd: 0, onGround: true, alt: 0, depEnd: sim.depEnd, ifr: true, freq: "ALL", callAt: 1e9, xpdr: "C", squawk: "2000" });
    sim.setPath(f, route.slice(1));
    sim.ac.push(f); made++;
  }
  const t0 = performance.now();
  runFor(sim, 30);
  const ms = (performance.now() - t0) / 300;
  ok(made >= 150 && ms < 12, `150 movers: ${ms.toFixed(2)} ms per 0.1 s step (${made} aircraft)`);
}
console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
