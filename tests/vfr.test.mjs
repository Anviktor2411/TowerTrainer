// PART B: real VFR reporting points replace the generic placeholders; VFR traffic and phraseology use them.
//   node tests/vfr.test.mjs
import { readFileSync } from "node:fs";
import { Airport, dist } from "../web/js/airport.js";
import { Sim } from "../web/js/sim.js";
import { parse, setVfrNames } from "../web/js/commands.js";
import { symPx, SYM_MIN, SYM_MAX } from "../web/js/render.js";

let seed = 5;
Math.random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
let fails = 0;
const ok = (c, m) => { console.log((c ? "PASS  " : "FAIL  ") + m); if (!c) fails++; };
const apt = new Airport(JSON.parse(readFileSync(new URL("../cache/EETN.json", import.meta.url), "utf8")));
const mk = () => {
  const radio = [];
  const sim = new Sim(apt, { onRadio: (m) => radio.push(m), populate: false, serviceVehicles: 0 });
  sim.setRunway("26"); sim.nextDep = sim.nextArr = sim.nextVfr = sim.nextOvf = 1e9; sim.vfrPerHour = 0; sim.abnormals = { on: false, perHour: 0 };
  return { sim, radio };
};
const REAL = [{ name: "Bravo", lat: 59.50, lon: 24.83, alt: 1500 }, { name: "Kilo", lat: 59.42, lon: 24.50, alt: 1500 }, { name: "Harku", lat: 59.38, lon: 24.60, alt: 1000 }];

{
  const { sim } = mk();
  ok(sim.vfrPoints().every(p => p.generic) && sim.vfrPoints().map(p => p.name).join() === "November,Echo,Sierra,Whiskey", "no real points: the generic placeholders, marked generic");
  sim.setVfrPoints(REAL.map(p => ({ ...p, p: apt.toXY(p.lat, p.lon) })));
  ok(sim.vfrPoints().map(p => p.name).join() === "Bravo,Kilo,Harku" && !sim.vfrPoints().some(p => p.generic), "real points replace the placeholders");
  sim.setVfrPoints(null);
  ok(sim.vfrPoints().every(p => p.generic), "back to the placeholders when the real points go away");
}
{
  const { sim, radio } = mk();
  sim.setVfrPoints(REAL.map(p => ({ ...p, p: apt.toXY(p.lat, p.lon) })));
  setVfrNames(sim.vfrPoints().map(p => p.name));
  // VFR inbound traffic flies to a real point and calls it by name
  let f = null;
  for (let k = 0; k < 10 && !f; k++) f = sim.spawnVfrInbound();
  ok(f && REAL.some(p => p.name === f.vfrPoint.name) && dist(f.wps[0].p, f.vfrPoint.p) < 1, `VFR inbound routes to a real point (${f && f.vfrPoint.name})`);
  for (let i = 0; i < 4000 && !radio.some(m => m.ac === f && /request join|joining instructions/.test(m.text)); i++) sim.step(0.5);
  const call = radio.find(m => m.ac === f && /request join|joining instructions/.test(m.text));
  ok(call && call.text.includes(f.vfrPoint.name), "and calls in over it: " + (call && call.text));
  // the parser takes the real names; the placeholders where real points exist are flagged
  const p = parse(`${f.cs} report harku`, sim.ac, null);
  ok(p.ins[0] && p.ins[0].t === "report" && p.ins[0].what === "Harku", "'report Harku' parsed with the real name");
  const q = parse(`${f.cs} report november`, sim.ac, null);
  ok(q.warnings.some(w => /November is not a VFR reporting point here/.test(w)), "'report November' flagged: " + q.warnings[0]);
  // a VFR departure leaves via a real point and reports it
  const { sim: s2, radio: r2 } = mk();
  s2.setVfrPoints(REAL.map(p => ({ ...p, p: apt.toXY(p.lat, p.lon) })));
  const g = s2.makeGA();
  const st = s2.freeStands(["tie_down", "hangar", "misc", "gate"], true)[0];
  s2.placeParked(g, st, false);
  g.wantCircuits = 0; g.other = ["VFR", "the north"];
  Object.assign(g, { state: "lined_up", toClr: true, depEnd: s2.depEnd, pos: [...s2.depEnd.thr], hdg: s2.depEnd.hdg, path: [], pi: 0, freq: "ALL", callAt: 1e9 });
  s2.startRoll(g);
  for (let i = 0; i < 6000 && !g.vfrExitCalled && !g.gone; i++) s2.step(0.2);
  const rep = r2.find(m => m.ac === g && /leaving the zone/.test(m.text));
  ok(g.vfrExit && g.vfrExit.name === "Bravo" && rep && /Bravo/.test(rep.text), "a VFR departure to the north leaves via Bravo and reports it: " + (rep && rep.text));
  // "leave the zone via Kilo at 1500 feet"
  const r = s2.respond(g, parse(`${g.cs} leave the zone via kilo at 1500 feet`, s2.ac, g).ins, {});
  ok(r && /via Kilo at 1500 feet/i.test(r.d) && g.vfrExit.name === "Kilo", "'leave the zone via Kilo at 1500 feet' read back: " + (r && r.d));
}
// B1: symbol sizes are pixels, clamped
ok([1e-5, 1e-3, 0.01, 0.1, 1, 8].every(k => symPx(10, k) >= SYM_MIN && symPx(10, k) <= SYM_MAX), "symPx stays within 6-14 px at every zoom");
ok(symPx(10, 1e-4) <= symPx(10, 1), "symbols grow a little when zooming in, never when zooming out");
console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
