// PART C: a real pilot's aircraft type as XRadio detected it (PT_AIRCRAFT) is used everywhere in TowerTrainer:
// strip and label, wake category and timers, wingspan (silhouette, separation), stand size, approach speed.
//   node tests/humantype.test.mjs
import { readFileSync } from "node:fs";
import { Airport } from "../web/js/airport.js";
import { Sim } from "../web/js/sim.js";
import { stripHtml } from "../web/js/strips.js";
import { spanOf } from "../web/js/traffic.js";
import { issueMarkers } from "../web/js/labels.js";

let fails = 0;
const ok = (c, m) => { console.log((c ? "PASS  " : "FAIL  ") + m); if (!c) fails++; };
const KT = 0.514444;
const apt = new Airport(JSON.parse(readFileSync(new URL("../cache/EETN.json", import.meta.url), "utf8")));
const events = [];
const sim = new Sim(apt, { populate: false, serviceVehicles: 0, onEvent: (e) => events.push(e) });
const B738 = { ac_icao: "B738", tailnum: "ES-ABC", airline: "", livery: "Ryanair", span_m: 35.8, length_m: 39.5, mtow_kg: 79016, wtc: "M", source: 2 };
const h = (type, acft) => sim.upsertHuman({ hid: 7, cs: "ESABC", type, pos: [0, 0], alt: 0, hdg: 90, spd: 0, onGround: true, squawk: "2000", xpdr: "C", acft });

let a = h("B738", B738);
ok(a.wtc === "M" && !a.typeUnknown, `human reported as B738 (mapped by XRadio): wake ${a.wtc}`);
ok(Math.round(spanOf(a)) === 36, `36 m wingspan for the silhouette and separation (${spanOf(a)})`);
ok(Math.abs(a.appSpd / KT - 145) < 1, `approach speed for spacing ${Math.round(a.appSpd / KT)} kt`);
const st = sim.standForHuman(a);
ok(st && (!st.types || !st.types.length || st.types.includes("jets") || st.types.includes("heavy")), `a jet stand: ${st && st.name} (${st && st.types})`);
ok(/B738\/M/.test(stripHtml(a)), "strip shows B738/M");
ok(a.tail === "ES-ABC" && a.typeSource === "mapped", "tail number and how the type was found are kept");

a = h("A388", { ...B738, ac_icao: "A388", span_m: 79.8, wtc: "J", source: 1 });
ok(a.wtc === "J" && Math.round(spanOf(a)) === 80, "type change to A388: super wake, 80 m span");
ok(/A388\/J/.test(stripHtml(a)) && !/B738/.test(stripHtml(a)), "the strip follows the type change");
ok(events.some(e => e.type === "humanType" && e.from === "B738" && e.to === "A388"), "the change is announced");
ok(sim.standForHuman(a) == null || (sim.standForHuman(a).types || []).length === 0 || sim.standForHuman(a).types.includes("heavy") || sim.standForHuman(a).size >= "E", "an A388 does not get a small stand");

a = h("ZZZZ", { ...B738, ac_icao: "ZZZZ", span_m: 0, wtc: "", source: 0 });
ok(a.typeUnknown && a.wtc === "M", "unknown type: medium / default values");
ok(/type\?/.test(stripHtml(a)) && issueMarkers(a).some(i => i.t === "type?" && i.level === "warn"), "unknown type shows an amber 'type?' on strip and label");
a = h("C172", null);
ok(a.wtc === "L" && Math.round(spanOf(a)) === 11 && !a.typeUnknown, "a type known without PT_AIRCRAFT (older XRadio) still works: C172 light");
console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
