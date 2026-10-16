// PART D: TCAS II for AI aircraft (tcas.js) and STCA.   node tests/tcas.test.mjs
import { readFileSync } from "node:fs";
import { Airport } from "../web/js/airport.js";
import { Sim } from "../web/js/sim.js";
import { parse } from "../web/js/commands.js";
import { sensitivity, geometry, threat, chooseSense, pilotVs } from "../web/js/tcas.js";

let seed = 3;
Math.random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
let fails = 0;
const ok = (c, m) => { console.log((c ? "PASS  " : "FAIL  ") + m); if (!c) fails++; };
const NM = 1852, KT = 0.514444, FT = 0.3048;
const apt = new Airport(JSON.parse(readFileSync(new URL("../cache/EETN.json", import.meta.url), "utf8")));

// ---------------------------------------------------------------- pure logic: sensitivity levels and tau
ok(sensitivity(35000).sl === 7 && sensitivity(35000).raTau === 35 && sensitivity(35000).taTau === 48, "FL350: SL7, TA tau 48 s, RA tau 35 s");
ok(sensitivity(3000).sl === 4 && sensitivity(3000).raTau === 20 && sensitivity(3000).taTau === 30, "3000 ft: SL4, TA tau 30 s, RA tau 20 s");
ok(sensitivity(800, 800).sl === 2 && sensitivity(800, 800).raTau === 0, "below 1000 ft AGL: SL2, TA only");
const headOn = (alt, ktEach, sec) => {
  const v = ktEach * KT, gap = 2 * v * sec;              // closing at 2v, `sec` seconds to go
  const own = { pos: [0, 0], vel: [0, v], alt, vs: 0 }, intr = { pos: [0, gap], vel: [0, -v], alt: alt + 200, vs: 0 };
  return threat(geometry(own, intr), sensitivity(alt));
};
// a fast head-on at FL350 (2 x 450 kt): the TA comes ~48 s before, the RA ~35 s before
let taAt = null, raAt = null;
for (let s = 80; s >= 5; s--) { const th = headOn(35000, 450, s); if (th.ta && taAt == null) taAt = s; if (th.ra && raAt == null) raAt = s; }
ok(taAt >= 46 && taAt <= 52 && raAt >= 33 && raAt <= 38, `FL350 head-on: TA at ${taAt} s, RA at ${raAt} s to go`);
taAt = raAt = null;
for (let s = 80; s >= 5; s--) { const th = headOn(3000, 200, s); if (th.ta && taAt == null) taAt = s; if (th.ra && raAt == null) raAt = s; }
ok(taAt >= 28 && taAt <= 36 && raAt >= 18 && raAt <= 25, `3000 ft head-on (2 x 200 kt): TA at ${taAt} s, RA at ${raAt} s to go — later than at FL350`);
ok(pilotVs(0, 1500, 3) === 0 && pilotVs(0, 1500, 6) > 400 && pilotVs(0, 1500, 6) < 600, "pilot response: 5 s to react, then ~0.25 g");

// ---------------------------------------------------------------- the simulation
const mk = (split = false) => {
  const radio = [], alerts = [], events = [];
  const sim = new Sim(apt, { onRadio: (m) => radio.push(m), onAlert: (m) => alerts.push({ t: sim.t, m }), onEvent: (e) => events.push({ t: sim.t, ...e }), populate: false, serviceVehicles: 0 });
  sim.nextDep = sim.nextArr = sim.nextVfr = sim.nextOvf = 1e9; sim.vfrPerHour = 0; sim.abnormals = { on: false, perHour: 0 };
  return { sim, radio, alerts, events };
};
const ai = (sim, cs, pos, hdg, altFt, kt = 250) => {
  const f = sim.makeFlight(null, false);
  Object.assign(f, { cs, kind: "ovf", state: "cruise", pos, hdg, spd: kt * KT, alt: altFt, cfl: altFt, onGround: false, squawk: "2" + String(f.id).padStart(3, "0").slice(-3), xpdr: "C", ifr: true,
    callAt: 1e9, calledIn: true, freq: "ALL", other: ["ZZZZ", "ZZZZ"] });
  f.squawk = f.squawk.replace(/[89]/g, "1"); f.assignedSq = f.squawk;
  sim.ac.push(f);
  return f;
};
const human = (sim, cs, pos, hdg, altFt, kt, vsFpm, tcas) => sim.upsertHuman({ hid: cs, cs, type: "B738", pos, alt: altFt, hdg, spd: kt * KT, onGround: false, squawk: "1000", xpdr: "C", vs: vsFpm * FT / 60, tcas: tcas || null });
const said = (radio, a) => radio.filter(m => m.ac === a).map(m => m.text);

{ // AI vs AI head-on at FL120: coordinated, opposite senses, radio sequence
  const { sim, radio, alerts, events } = mk();
  const A = ai(sim, "AAA1", [0, -8 * NM], 0, 12000), B = ai(sim, "BBB2", [0, 8 * NM], 180, 12300);
  let senses = new Set(), both = [], minSep = Infinity, firstRa = null, firstStca = null;
  for (let i = 0; i < 1800; i++) {
    sim.step(0.1);
    const ra = [A, B].filter(x => x.tcas && x.tcas.ra);
    if (ra.length && firstRa == null) firstRa = sim.t;
    if (A.tcas && A.tcas.ra && B.tcas && B.tcas.ra) both.push([A.tcas.ra.sense, B.tcas.ra.sense]);
    if (firstStca == null && alerts.some(x => /STCA: conflict/.test(x.m))) firstStca = sim.t;
    if (Math.hypot(A.pos[0] - B.pos[0], A.pos[1] - B.pos[1]) < 0.5 * NM) minSep = Math.min(minSep, Math.abs(A.alt - B.alt));
  }
  ok(both.length > 0 && both.every(([x, y]) => x === -y), `AI vs AI: opposite senses, never the same (${both.length} s of joint RA)`);
  ok(minSep > 600, `vertical separation when passing: ${Math.round(minSep)} ft`);
  ok(firstStca != null && firstRa != null && firstStca < firstRa, `STCA (t=${firstStca}) fires before the TCAS RA (t=${firstRa})`);
  const sa = said(radio, A);
  ok(sa.some(t => /TCAS RA$/.test(t)) && sa.some(t => /clear of conflict, returning to flight level 120/.test(t)), "radio: 'TCAS RA' then 'clear of conflict, returning to flight level 120': " + sa.join(" | "));
  ok(sa.findIndex(t => /TCAS RA$/.test(t)) < sa.findIndex(t => /clear of conflict/.test(t)), "in that order");
  ok(events.some(e => e.type === "tcas" && e.kind === "ta"), "a TA came first");
  ok(Math.abs(A.alt - 12000) < 200, `back at the cleared level afterwards (${Math.round(A.alt)} ft)`);
}
{ // ATC instructions refused during an RA
  const { sim } = mk();
  const A = ai(sim, "AAA3", [0, -6 * NM], 0, 9000), B = ai(sim, "BBB4", [0, 6 * NM], 180, 9100);
  for (let i = 0; i < 1000 && !(A.tcas && A.tcas.ra); i++) sim.step(0.1);
  const p = parse(`${A.cs} descend 8000 feet`, sim.ac, A);
  const r = sim.respond(A, p.ins, { text: p.normalized });
  ok(A.tcas && A.tcas.ra && /Unable, TCAS RA/.test(r.d), "an instruction during the RA: " + (r && r.d));
}
{ // reversal AI vs AI: the other one keeps descending into us
  const { sim, events } = mk();
  const A = ai(sim, "AAA5", [0, -7 * NM], 0, 10000), B = ai(sim, "BBB6", [0, 7 * NM], 180, 10500);
  B.tcasOff = true;
  let first = null;
  for (let i = 0; i < 1600; i++) {
    sim.step(0.1);
    // once A has its RA, B (no TCAS) starts descending at 3000 fpm straight through A's level
    if (A.tcas && A.tcas.ra && sim.t - A.tcas.ra.t > 2 || B.alt < 10499) { B.alt -= 3000 / 60 * 0.1; B.cfl = B.alt; }
    if (A.tcas && A.tcas.ra && first == null) first = A.tcas.ra.sense;
  }
  ok(first === -1 && events.some(e => e.type === "tcas" && e.kind === "reversal" && e.ac === A), `A first descends, then reverses to climb as B keeps descending into it (first ${first})`);
}
{ // inhibits
  const { sim, events } = mk();
  const A = ai(sim, "LOW1", [0, -3 * NM], 0, 800, 160), B = ai(sim, "LOW2", [0, 3 * NM], 180, 850, 160);
  for (let i = 0; i < 700; i++) sim.step(0.1);
  ok(events.some(e => e.type === "tcas" && e.kind === "ta" && e.ac === A) && !events.some(e => e.type === "tcas" && e.kind === "ra"), "below 1000 ft AGL: TA only, no RA");
  const s2 = mk().sim, ev2 = [];
  s2.onEvent = (e) => ev2.push(e);
  const C = ai(s2, "LOW3", [0, -4 * NM], 0, 1060, 180), D = ai(s2, "LOW4", [0, 4 * NM], 180, 1250, 180);
  for (let i = 0; i < 800; i++) s2.step(0.1);
  ok(!ev2.some(e => e.type === "tcas" && e.ac === C && e.ra && e.ra.sense < 0), "no Descend RA below 1100 ft AGL");
  const s3 = mk().sim, ev3 = [];
  s3.onEvent = (e) => ev3.push(e);
  const E = ai(s3, "GND1", [0, -4 * NM], 0, 3000);
  const G = ai(s3, "GND2", [0, 1 * NM], 180, 0, 20); G.onGround = true;
  for (let i = 0; i < 600; i++) s3.step(0.1);
  ok(!ev3.some(e => e.type === "tcas"), "nothing against traffic on the ground");
  const s4 = mk().sim, ev4 = [];
  s4.onEvent = (e) => ev4.push(e);
  const H = ai(s4, "MDA1", [0, -6 * NM], 0, 6000), I = ai(s4, "MDA2", [0, 6 * NM], 180, 6100); I.xpdr = "A";
  I.tcasOff = true;
  for (let i = 0; i < 800; i++) { s4.step(0.1); I.tcas = null; }
  ok(ev4.some(e => e.type === "tcas" && e.kind === "ta" && e.ac === H) && !ev4.some(e => e.type === "tcas" && e.kind === "ra" && e.ac === H), "Mode A intruder (no altitude): TA only, never an RA");
  const s5 = mk().sim, ev5 = [];
  s5.onEvent = (e) => ev5.push(e);
  const J = ai(s5, "OFF1", [0, -6 * NM], 0, 6000), K = ai(s5, "OFF2", [0, 6 * NM], 180, 6100); K.xpdr = "S";
  for (let i = 0; i < 800; i++) { s5.step(0.1); K.tcas = null; }
  ok(!ev5.some(e => e.type === "tcas" && e.ac === J), "transponder off / standby: invisible to TCAS");
}
{ // AI vs a real pilot
  const run = (vs, tcas, label, check, steps = 900, change = null, startAlt = 10300) => {
    const { sim, events, alerts } = mk();
    const A = ai(sim, "AIX1", [0, -7 * NM], 0, 10000);
    let hp = [0, 7 * NM], halt = startAlt;
    human(sim, "HUM1", hp, 180, halt, 250, vs, tcas);
    for (let i = 0; i < steps; i++) {
      const cur = change ? change(i, sim, A) : { vs, tcas };
      if (i % 3 === 0) { hp = [hp[0], hp[1] - 250 * KT * 0.3]; halt += cur.vs / 60 * 0.3; human(sim, "HUM1", hp, 180, halt, 250, cur.vs, cur.tcas); }
      sim.step(0.1);
    }
    check(A, events, alerts, sim);
  };
  run(0, { level: 2, sense: 1, message: 1 }, "human RA climb", (A, ev) => {
    const ra = ev.find(e => e.type === "tcas" && e.kind === "ra" && e.ac === A);
    ok(ra && ra.ra.sense === -1, "the real pilot has an RA 'climb' -> the AI descends");
  });
  // descending from 2000 ft above so that it reaches our level about when the paths cross (~100 s)
  run(-1200, null, "no RA data, human descending", (A, ev) => {
    const ra = ev.find(e => e.type === "tcas" && e.kind === "ra" && e.ac === A);
    ok(ra && ra.ra.sense === 1, "no RA data, the real pilot descends -> the AI climbs" + (ra ? "" : " (no RA)"));
  }, 900, null, 12000);
  let flip = null;
  run(-1200, null, "human reverses", (A, ev) => {
    ok(ev.some(e => e.type === "tcas" && e.kind === "reversal" && e.ac === A), "the real pilot reverses (starts climbing) -> the AI reverses");
  }, 1000, (i, sim, A) => {
    if (flip == null && A.tcas && A.tcas.ra) flip = sim.t + 3;
    return { vs: flip != null && sim.t > flip ? 2500 : -1200, tcas: null };
  }, 12000);
  run(0, { level: 2, sense: 1, message: 1 }, "human ignores RA", (A, ev, alerts, sim) => {
    ok(ev.some(e => e.type === "tcas" && e.kind === "increase" && e.ac === A), "the real pilot ignores its RA -> the AI increases its descent");
    ok(alerts.some(x => /not following its RA/.test(x.m)) && (sim.stats.atcErrors || []).some(e => e.kind === "tcasNonCompliance"), "ATC alert + debrief entry for the human's TCAS non-compliance");
  });
}
{ // training event
  const { sim, events } = mk();
  const two = sim.injectTcasEvent();
  for (let i = 0; i < 1200; i++) sim.step(0.1);
  ok(two.length === 2 && events.some(e => e.type === "tcas" && e.kind === "ra"), "'inject TCAS event' sets up two AI aircraft that get an RA");
}
console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
