// Nav data in the parser, Delivery/Approach suggestions and the AI traffic's procedures (F4), on synthetic data.
//   node tests/nav.test.mjs
import { readFileSync } from "node:fs";
import { Airport } from "../web/js/airport.js";
import { Sim } from "../web/js/sim.js";
import { buildPositions } from "../web/js/positions.js";
import { parse, setNavVocab, resolveFix } from "../web/js/commands.js";
import { sidByRoute, suggestStar, procPoints, approachTitle } from "../web/js/procs.js";

let fails = 0;
const ok = (c, m) => { console.log((c ? "PASS  " : "FAIL  ") + m); if (!c) fails++; };

const VOCAB = [
  { ident: "LAKUT", kind: "fix", spoken: "Lakut", lat: 59.55, lon: 24.10 },
  { ident: "ROXOG", kind: "fix", spoken: "Roxog", lat: 59.48, lon: 25.20 },
  { ident: "TLL", kind: "VOR", spoken: "Tallinn VOR", lat: 59.33, lon: 24.80 },
  { ident: "LAKUT1A", kind: "SID", spoken: "LAKUT1A" }, { ident: "LAKUT1T", kind: "STAR", spoken: "LAKUT1T" },
  { ident: "I26", kind: "APPCH", spoken: "ILS 26" },
];
setNavVocab(VOCAB);
ok(resolveFix("lakut").ident === "LAKUT" && resolveFix("lakut").known, "spoken 'lakut' -> LAKUT");
ok(resolveFix("tallinn vor").ident === "TLL", "spoken 'Tallinn VOR' -> TLL");
ok(resolveFix("tallinn").ident === "TLL", "'tallinn' alone -> TLL");
const ac = [{ cs: "BTI123", tel: "Air Baltic", num: "123", route: "LAKUT1A LAKUT UL602 SUGOL" }];
let pp = parse("Air Baltic 123 proceed direct lakut", ac, null);
ok(pp.ins[0] && pp.ins[0].t === "direct" && pp.ins[0].fix === "LAKUT" && pp.warnings.length === 0, "'direct lakut' parsed, on the route, no warning");
pp = parse("Air Baltic 123 direct roxog", ac, null);
ok(pp.warnings.some(w => /not on BTI123's route/.test(w)), "direct to a fix that is not on the route warns: " + pp.warnings.join("; "));
pp = parse("Air Baltic 123 direct xyzab", ac, null);
ok(pp.ins[0].known === false && pp.warnings.some(w => /XYZAB is not a known fix/.test(w)), "unknown fix rejected: " + pp.warnings.join("; "));
pp = parse("Air Baltic 123 hold at tallinn vor, left turns", ac, null);
ok(pp.ins.some(i => i.t === "holdAt" && i.fix === "TLL" && i.turn === "L"), "'hold at Tallinn VOR, left turns'");
pp = parse("Air Baltic 123 cleared to riga via lakut1a departure, climb 4000 feet, squawk 4521", ac, null);
ok(pp.ins[0].t === "clearance" && pp.ins[0].sid === "LAKUT1A departure" && !pp.warnings.length, "clearance with a published SID");
pp = parse("Air Baltic 123 cleared to riga via nopes1a departure, climb 4000 feet, squawk 4521", ac, null);
ok(pp.warnings.some(w => /NOPES1A is not a published SID/.test(w)), "unknown SID in a clearance warns");
pp = parse("Air Baltic 123 descend 3000 feet via lakut1t arrival", ac, null);
ok(pp.ins.some(i => i.t === "star" && i.name === "LAKUT1T" && i.known), "'via LAKUT1T arrival'");

// procedures (shape of /api/procedures)
const P = {
  sids: [{ name: "LAKUT1A", runways: ["26"], rwy: { "26": [{ fix: "TSTA1", lat: 59.1, lon: 24.3 }] }, common: [{ fix: "LAKUT", lat: 59.55, lon: 24.1, alt: 5000 }], exit: "LAKUT", climb: 5000, bearing: 300 },
    { name: "ROXOG1A", runways: ["26"], rwy: {}, common: [{ fix: "ROXOG", lat: 59.48, lon: 25.2 }], exit: "ROXOG", climb: 4000, bearing: 80 }],
  stars: [{ name: "LAKUT1T", runways: [], rwy: {}, common: [{ fix: "LAKUT", lat: 59.55, lon: 24.1, alt: 7000 }, { fix: "TSTA1", lat: 59.1, lon: 24.3, alt: 3000 }] },
    { name: "ROXOG1T", runways: [], rwy: {}, common: [{ fix: "ROXOG", lat: 59.48, lon: 25.2, alt: 7000 }] }],
  apps: [{ name: "R26", runways: ["26"] }, { name: "I26", runways: ["26"] }],
};
ok(sidByRoute(P, "26", "LAKUT UL602 SUGOL").name === "LAKUT1A", "SID by the route's first fix");
ok(sidByRoute(P, "26", "ROXOG1A ROXOG DCT X").name === "ROXOG1A", "SID named in the route");
const st = suggestStar(P, "26", "SUGOL UL602 ROXOG ROXOG1T", { lat: 59.41, lon: 24.83 }, null);
ok(st.star === "ROXOG1T" && st.app === "I26" && st.appTitle === "ILS", "STAR from the route, ILS before RNAV: " + JSON.stringify(st));
const st2 = suggestStar(P, "26", "", { lat: 59.41, lon: 24.83 }, ["EVRA", "Riga", 56.92, 23.97]);
ok(st2.star === "LAKUT1T", "no route: STAR whose entry faces the origin (Riga, south-west): " + st2.star);
ok(procPoints(P, "star", "LAKUT1T", "26").map(p => p.id).join(" ") === "LAKUT TSTA1", "STAR points");
ok(approachTitle("R08-Y") === "RNAV Y" && approachTitle("I26") === "ILS", "approach titles");

// the AI traffic: a STAR arrival and a SID departure on a cached airport
const apt = new Airport(JSON.parse(readFileSync(new URL("../cache/EETN.json", import.meta.url), "utf8")));
const sim = new Sim(apt, { positions: buildPositions(apt), staffing: new Set([]), populate: false });
sim.setRunway("26");
sim.nextDep = sim.nextArr = sim.nextVfr = sim.nextOvf = 1e9; sim.vfrPerHour = 0;
const toXY = (l) => apt.toXY(l.lat, l.lon);
sim.starPath = () => ({ name: "LAKUT1T", app: "ILS", pts: [{ id: "FAR", p: toXY({ lat: 60.1, lon: 23.6 }), alt: 9000 }, { id: "LAKUT", p: toXY({ lat: 59.55, lon: 24.1 }), alt: 6000 }] });
sim.suggestArrival = () => ({ star: "LAKUT1T", appTitle: "ILS" });
let arr = null;
for (let k = 0; k < 20 && !arr; k++) { const f = sim.spawnArrival(); if (f && !f.ga) arr = f; else if (f) sim.ac.splice(sim.ac.indexOf(f), 1); }
ok(arr && arr.state === "star" && arr.star === "LAKUT1T", "arrival spawned on its STAR: " + (arr && arr.state));
const said = [];
sim.onRadio = (m) => said.push(m.text);
let reachedFinal = false;
for (let i = 0; i < 20000 && arr && sim.ac.includes(arr); i++) { sim.step(0.2); if (arr.state === "final") { reachedFinal = true; break; } }
ok(said.some(t => /via LAKUT1T arrival.*cleared ILS approach runway 26/.test(t)), "the AI approach controller clears the STAR and the ILS: " + said.find(t => /arrival/.test(t)));
ok(reachedFinal && Math.abs(((arr.hdg - arr.end.hdg + 540) % 360) - 180) < 1, "the STAR ends established on the final");
console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
