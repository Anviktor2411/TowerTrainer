// Headless end-to-end check of the sim + parser on a cached airport.
//   node tests/flow.test.mjs [ICAO] [RWY]
import { readFileSync } from "node:fs";
import { Airport } from "../web/js/airport.js";
import { Sim } from "../web/js/sim.js";
import { parse, normalize } from "../web/js/commands.js";

const icao = process.argv[2] || "EETN";
// deterministic runs: node tests/flow.test.mjs ICAO RWY SEED
let seed = +(process.argv[4] || Date.now() % 100000);
console.log("seed", seed);
Math.random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const apt = new Airport(JSON.parse(readFileSync(new URL(`../cache/${icao}.json`, import.meta.url), "utf8")));
const radio = [], alerts = [];
const sim = new Sim(apt, { onRadio: (m) => radio.push(`${m.ac.cs}: ${m.text}`), onAlert: (m) => alerts.push(m) });
const rwy = process.argv[3] === "-0" ? apt.runways[0].ends[0].name : process.argv[3] && process.argv[3] !== "-" ? process.argv[3] : apt.runways[0].ends[1].name;
sim.setRunway(rwy);
sim.depPerHour = 0; sim.arrPerHour = 0; sim.nextDep = sim.nextArr = 1e9;

let fails = 0;
const ok = (c, msg) => { console.log(`${c ? "PASS" : "FAIL"}  ${msg}`); if (!c) fails++; };
const run = (sec, until) => { for (let i = 0; i < sec * 10; i++) { sim.step(0.1); if (until && until()) return true; } return !until; };
const say = (text) => {
  const { ac, ins } = parse(text, sim.ac, null);
  if (!ac) console.log("   (no callsign match for: " + text + ")");
  const rb = ac ? sim.instruct(ac, ins) : "(nobody)";
  console.log(`   ATC: ${text}\n   ${ac ? ac.cs : "?"}: ${rb}`);
  return rb;
};

// --- parser ---
ok(normalize("Air Baltic one two three, runway two six cleared for take-off") === "air baltic 123, runway 26 cleared for take off",
  "normalize spoken numbers: " + normalize("Air Baltic one two three, runway two six cleared for take-off"));
ok(normalize("taxi via alpha one, bravo") === "taxi via a1, b", "normalize phonetics: " + normalize("taxi via alpha one, bravo"));
ok(normalize("climb four thousand five hundred feet") === "climb 4500 feet", "normalize altitude");
ok(normalize("contact radar one two seven decimal niner zero five") === "contact radar 127.905", "normalize frequency");

// --- departure ---
const d = sim.spawnDeparture();
ok(d && d.state === "parked", `departure spawned ${d.cs} at stand ${d.stand.name}`);
let rb;
if (d.ga) {
  console.log(`   (GA flight ${d.cs} "${d.tel}" ${d.type}, VFR — no clearance/push)`);
} else {
  run(40, () => d.state === "clr_req");
  ok(d.state === "clr_req", "pilot requests clearance");
  rb = say(`${d.tel} ${d.num} cleared to ${d.other[1]} via TEST1A departure, climb 4000 feet, squawk 4521`);
  ok(d.state === "cleared" && d.squawk === "4521" && /squawk 4521/.test(rb), "clearance read back");
  run(80, () => d.state === "push_req");
  ok(d.state === "push_req", "pilot requests push");
  say(`${d.cs} push and start approved`);
  run(400, () => d.state === "pushed");
  ok(d.state === "pushed", `pushback complete, hdg ${d.hdg.toFixed(0)} state ${d.state} pi ${d.pi}/${d.path.length} spd ${d.spd.toFixed(2)} path ${JSON.stringify(d.path.map(p => p.map(v => v == null ? v : Math.round(v))))}`);
  if (d.state !== "pushed") process.exit(1);
}
run(70, () => d.state === "taxi_req");
ok(d.state === "taxi_req", "pilot requests taxi");
rb = say(`${d.cs} taxi holding point runway ${rwy}`);
ok(d.state === "taxi", "taxi accepted: " + rb);
for (let k = 0; k < 8 && d.state !== "holding"; k++) {
  run(900, () => d.state === "holding" || d.atStop && d.blockedRwy !== d.depEnd.rwy && d.spd === 0);
  if (d.state !== "holding" && d.blockedRwy != null) say(`${d.cs} cross runway ${apt.runways[d.blockedRwy].ends[0].name}`);
}
ok(d.state === "holding", `reached holding point after ${sim.t.toFixed(0)} s, dist to rwy ${apt.distToRunway(d.pos, apt.runways[d.depEnd.rwy]).toFixed(0)} m`);
ok(!apt.onRunway(d.pos, apt.runways[d.depEnd.rwy], 5), "holding point is off the runway");
say(`${d.cs} runway ${rwy} line up and wait`);
run(120, () => d.state === "lined_up");
ok(d.state === "lined_up", `lined up on runway (state ${d.state}, pi ${d.pi}/${d.path.length}, hdg ${d.hdg.toFixed(0)} vs ${d.depEnd.hdg.toFixed(0)}, blocked ${d.blockedRwy})`);
say(`${d.cs} runway ${rwy} cleared for takeoff`);
run(400, () => d.state === "airborne" && d.alt > 1000);
ok(d.state === "airborne", `airborne, alt ${d.alt.toFixed(0)} ft`);
say(`${d.cs} contact radar 127.905`);
run(10);
ok(!sim.ac.includes(d), "handed off and removed");

// --- arrival ---
const a = sim.spawnArrival();
ok(a && a.state === "final", `arrival ${a.cs} on final ${a.end.name}, ${(sim.distToThr(a) / 1852).toFixed(1)} nm`);
run(60, () => a.calledIn);
say(`${a.tel} ${a.num} runway ${rwy} cleared to land`);
run(900, () => a.state === "vacated");
ok(a.state === "vacated", `vacated via ${a.exitName || "?"} (state ${a.state}, spd ${(a.spd / 0.5144).toFixed(0)} kt, blocked ${a.blockedRwy}, gone ${!!a.gone})`);
rb = say(`${a.cs} taxi to stand ${a.stand.name}`);
ok(a.state === "taxi", "taxi-in accepted: " + rb);
for (let k = 0; k < 8 && a.state !== "parked"; k++) {
  run(900, () => a.state === "parked" || (a.atStop && a.spd === 0));
  if (a.state !== "parked" && a.blockedRwy != null) say(`${a.cs} cross runway ${apt.runways[a.blockedRwy].ends[0].name}`);
}
ok(a.state === "parked", `parked at ${a.stand.name}, ${apt.distToRunway(a.pos, apt.runways[0]).toFixed(0)} m from runway`);

// --- go-around without landing clearance ---
const g = sim.spawnArrival();
run(500, () => g.state === "goaround");
ok(g.state === "goaround" || g.gone, "arrival without clearance goes around");

console.log("\nRadio:\n  " + radio.join("\n  "));
console.log("Alerts:\n  " + (alerts.join("\n  ") || "(none)"));
console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
