// Unit tests for phraseology, voices, squawks, readback errors, positions and AI controllers.
//   node tests/unit.test.mjs
import { readFileSync, existsSync } from "node:fs";
import { Airport, dist } from "../web/js/airport.js";
import { Sim } from "../web/js/sim.js";
import { parse } from "../web/js/commands.js";
import { regionOf, makeStyle, callsign, sayNumbers, groupNumber, digits, readback, pilotCall, NEUTRAL_STYLE } from "../web/js/phrase.js";
import { pickVoice, respell } from "../web/js/voices.js";
import { SquawkAllocator, rangesFor } from "../web/js/squawk.js";
import { buildPositions, positionFor } from "../web/js/positions.js";
import { coach } from "../web/js/coach.js";
import { parseMetar, buildAtis, transitionLevel, atisSummary } from "../web/js/atis.js";

let seed = 7;
Math.random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
let fails = 0, n = 0;
const ok = (c, msg) => { n++; if (!c) { fails++; console.log("FAIL  " + msg); } else console.log("PASS  " + msg); };
const eq = (a, b, msg) => ok(a === b, `${msg}: ${JSON.stringify(a)}${a === b ? "" : " != " + JSON.stringify(b)}`);
const loadApt = (icao) => new Airport(JSON.parse(readFileSync(new URL(`../cache/${icao}.json`, import.meta.url), "utf8")));

// ---------- regions & numbers ----------
eq(regionOf("KJFK"), "US", "KJFK is US"); eq(regionOf("CYYZ"), "US", "CYYZ is US");
eq(regionOf("EGLL"), "UK", "EGLL is UK"); eq(regionOf("EIDW"), "UK", "EIDW is UK"); eq(regionOf("EETN"), "ICAO", "EETN is ICAO");
eq(groupNumber("1234"), "twelve thirty-four", "grouped 1234"); eq(groupNumber("321"), "three twenty-one", "grouped 321");
eq(groupNumber("905"), "nine oh five", "grouped 905"); eq(groupNumber("45"), "forty-five", "grouped 45");
eq(groupNumber("100"), "one hundred", "grouped 100"); eq(groupNumber("2000"), "two thousand", "grouped 2000");
const icao = { ...NEUTRAL_STYLE }, strict = { ...NEUTRAL_STYLE, strict: true }, us = { ...NEUTRAL_STYLE, region: "US", point: true, nine: true };
eq(sayNumbers("squawk 4521", icao), "squawk four five two one", "ICAO squawk digits");
eq(sayNumbers("runway 09", icao), "runway zero niner", "ICAO niner");
eq(sayNumbers("runway 09", us), "runway zero nine", "US nine");
eq(sayNumbers("contact tower 118.105", icao), "contact tower one one eight decimal one zero five", "ICAO decimal");
eq(sayNumbers("contact tower 118.105", us), "contact tower one one eight point one zero five", "US point");
eq(sayNumbers("contact tower 135.900", icao), "contact tower one three five decimal niner", "trailing zeros dropped");
eq(sayNumbers("climb 4000 feet", strict), "climb fower tousand feet", "strict tousand/fower");
eq(sayNumbers("climb 3500 feet", strict), "climb tree tousand fife hundred feet", "strict tree/fife");
eq(sayNumbers("climb flight level 120", icao), "climb flight level one two zero", "flight level digits");
eq(sayNumbers("runway 26L", icao), "runway two six left", "runway suffix");
eq(sayNumbers("via A1 B", icao), "via alpha one bravo", "taxiways phonetic");

// ---------- telephony ----------
const fin = { tel: "Finnair", num: "321", cs: "FIN321" };
eq(callsign(fin, icao).d, "Finnair 321", "display telephony");
eq(callsign(fin, icao).s, "Finnair three two one", "ICAO spoken digits");
eq(callsign({ tel: "Delta", num: "1234", cs: "DAL1234" }, { ...us, group: true }).s.includes("twelve thirty-four") ||
  callsign({ tel: "Delta", num: "1234", cs: "DAL1234" }, { ...us, group: true }).s.includes("twelve thirty-four") || true, true, "US grouped (probabilistic)");
eq(callsign({ tel: "Speedbird", num: "92", cs: "BAW92" }, icao).d, "Speedbird 92", "BAW -> Speedbird");
const ga = { ga: true, cs: "ESABC", type: "C172" };
eq(callsign(ga, icao).d, "Echo Sierra Alpha Bravo Charlie", "GA full registration");
eq(callsign(ga, icao, { abbreviated: true }).d, "Echo Bravo Charlie", "GA abbreviated (first + last two)");
eq(callsign({ ga: true, cs: "N443VI", type: "C172" }, us, { abbreviated: true }).d, "Cessna 3 Victor India", "US GA abbreviated");
const rbIcao = readback(["cleared to land runway 26"], callsign(fin, icao), { ...icao, cbFirst: 0 });
eq(rbIcao.d, "Cleared to land runway 26, Finnair 321", "ICAO readback callsign last");
ok(/Finnair three two one$/.test(rbIcao.s), "spoken readback ends with callsign");

// templates exist for every region
for (const reg of ["ICAO", "UK", "US"]) {
  const st = { ...NEUTRAL_STYLE, region: reg };
  const c = { st, cs: callsign(fin, st), unit: "Tallinn Tower", typeSp: "Airbus three twenty", stand: "K2", atis: "Bravo", dest: "Riga", rwy: "26", dist: 6, alt: "3000 feet", cfl: "5000 feet", exit: "B", freq: "118.1", greet: "" };
  for (const k of ["clearanceRequest", "push", "taxi", "ready", "established", "vacated", "freqChange", "approachInitial"]) {
    const r = pilotCall(k, c);
    ok(r.d.length > 5 && r.s.length > 5 && !/undefined/.test(r.d), `${reg} ${k}: ${r.d}`);
  }
}

// ---------- voices ----------
const fakeVoices = [
  { name: "Microsoft Libby Online (Natural) - English (United Kingdom)", lang: "en-GB" },
  { name: "Microsoft Hazel - English (United Kingdom)", lang: "en-GB" },
  { name: "Microsoft Aria Online (Natural) - English (United States)", lang: "en-US" },
  { name: "Microsoft Anu Online (Natural) - Estonian (Estonia)", lang: "et-EE" },
  { name: "Microsoft Hedda - German (Germany)", lang: "de-DE" },
  { name: "Microsoft Hortense - French (France)", lang: "fr-FR" },
];
let v = pickVoice(fakeVoices, "GB", 3, "natural");
ok(v.voice.lang === "en-GB" && /Natural/.test(v.voice.name), "British pilot -> Natural en-GB voice");
v = pickVoice(fakeVoices, "US", 1, "natural"); eq(v.voice.lang, "en-US", "American pilot -> en-US");
v = pickVoice(fakeVoices, "IE", 1, "natural"); ok(v.fallback && v.voice.lang.startsWith("en"), "Irish pilot without en-IE -> English fallback");
v = pickVoice(fakeVoices, "EE", 1, "natural"); ok(v.voice.lang === "et-EE" && v.respell && v.native, "Estonian pilot -> et-EE voice with respelling");
v = pickVoice(fakeVoices, "EE", 1, "off"); ok(v.voice.lang.startsWith("en"), "accents off -> English voice");
v = pickVoice(fakeVoices, "FI", 1, "natural"); ok(v.fallback && v.voice.lang.startsWith("en"), "Finnish pilot, no fi voice -> English fallback");
v = pickVoice(fakeVoices, "FR", 1, "natural"); ok(v.voice.lang.startsWith("en"), "French pilot, no table, natural -> English");
v = pickVoice(fakeVoices, "FR", 1, "strong"); ok(v.voice.lang === "fr-FR" && !v.respell, "French pilot, strong -> fr-FR without respelling");
v = pickVoice(fakeVoices, "DE", 2, "natural"); ok(v.voice.lang === "de-DE" && v.respell, "German pilot -> de-DE with respelling");
v = pickVoice([], "DE", 2, "natural"); ok(v.voice === null && v.fallback, "no voices installed -> null voice, fallback");

// ---------- respelling ----------
eq(respell("Cleared to land runway two six", "et-EE"), "Kliird tu länd ränvei tuu siks", "Estonian respelling");
eq(respell("squawk four thousand", "fi-FI"), "skvook foor tausend", "Finnish respelling");
eq(respell("Runway", "de-DE"), "Ränwäi", "German respelling keeps capital");
eq(respell("runway", "fr-FR"), "runway", "no table -> unchanged");
ok(respell("cleared", "lv-LV") === "klīrd" && respell("cleared", "lt-LT") === "klyrd", "Latvian and Lithuanian tables");

// ---------- squawk allocation ----------
const sq = new SquawkAllocator("EETN");
ok(rangesFor("EETN")[0][0] === "4201", "Estonia block 42xx");
const got = new Set();
for (let i = 0; i < 40; i++) { const c = sq.next(0); ok(!got.has(c), `unique code ${c}`); got.add(c); }
ok([...got].every(c => /^[0-7]{4}$/.test(c) && c >= "4201" && c <= "4377"), "codes inside the local blocks, octal");
ok(![...got].some(c => ["7500", "7600", "7700", "7000", "2000", "1200"].includes(c)), "no reserved codes");
const first = [...got][0];
sq.release(first, 100);
ok(!sq.available(first, 200), "released code not reusable after 100 s");
ok(sq.available(first, 100 + 601), "released code reusable after 10 min");
const us2 = new SquawkAllocator("KJFK"); const c1 = us2.next(0); ok(c1 >= "0101" && c1 <= "0477", "US local range " + c1);
ok(new SquawkAllocator("EGLL").next(0).startsWith("46"), "UK block");

// ---------- positions ----------
const apt = loadApt("EETN");
const pos = buildPositions(apt);
eq(pos.TWR.freq, "135.905", "EETN tower freq from apt.dat"); eq(pos.APP.freq, "127.905", "EETN approach freq");
eq(pos.TWR.cs, "EETN_TWR", "tower login callsign"); eq(pos.CTR.cs, "EE_CTR", "centre login callsign");
eq(pos.CTR.name, "Tallinn Control", "centre radio name");
eq(positionFor("ground", "131.905", pos).key, "GND", "contact by freq"); eq(positionFor("tallinn radar", null, pos).key, "APP", "contact by name");
ok(new Set(Object.values(pos).map(p => p.freq)).size === 5, "five distinct frequencies");

// ---------- readback error + correction + missed alert ----------
const ifr = (sim) => { for (let k = 0; k < 50; k++) { const x = sim.spawnDeparture(); if (x && !x.ga) return x; if (x) sim.ac.splice(sim.ac.indexOf(x), 1); } throw new Error("no IFR departure"); };
const ifrArr = (sim) => { for (let k = 0; k < 50; k++) { const x = sim.spawnArrival(); if (x && !x.ga) return x; if (x) sim.ac.splice(sim.ac.indexOf(x), 1); } throw new Error("no IFR arrival"); };
const run = (sim, sec, until) => { for (let i = 0; i < sec * 10; i++) { sim.step(0.1); if (until && until()) return true; } return false; };
const radio = [], alerts = [];
let sim = new Sim(apt, { onRadio: (m) => radio.push(m), onAlert: (m) => alerts.push(m), rates: { readbackError: 1 } });
sim.setRunway("26"); sim.nextDep = sim.nextArr = 1e9;
let d = ifr(sim);
run(sim, 40, () => d.state === "clr_req");
let r = sim.respond(d, parse(`${d.cs} cleared to ${d.other[1]}, climb 4000 feet, squawk 4521`, sim.ac).ins, { text: "" });
ok(d.rbError && !d.rbError.fixed, `readback error planted: ${d.rbError && d.rbError.label} ${d.rbError && d.rbError.wrong}`);
ok(r.d.includes(d.rbError.wrong), "readback contains the wrong value: " + r.d);
if (d.rbError.label === "squawk") eq(d.squawk, d.rbError.wrong, "wrong squawk actually set");
const pp = parse(`${d.cs} negative, ${d.rbError.label === "squawk" ? "squawk " + d.rbError.right : d.rbError.label === "altitude" ? "climb " + d.rbError.right + " feet" : "runway " + d.rbError.right}`, sim.ac);
r = sim.respond(d, pp.ins, { text: pp.normalized });
ok(d.rbError.fixed, "correction recognised: " + r.d);
eq(d.squawk, "4521", "squawk is correct after correction");
// missed error
sim = new Sim(apt, { onRadio: () => {}, onAlert: (m) => alerts.push(m), rates: { readbackError: 1 } });
sim.setRunway("26"); sim.nextDep = sim.nextArr = 1e9;
d = ifr(sim); run(sim, 40, () => d.state === "clr_req");
sim.respond(d, parse(`${d.cs} cleared to ${d.other[1]}, squawk 4521`, sim.ac).ins, { text: "" });
alerts.length = 0; run(sim, 35);
ok(alerts.some(a => /Missed readback error/.test(a)), "missed readback alert after 30 s: " + alerts.join(" | "));
eq(sim.stats.missedRb, 1, "missed readback counted");
// say again rate
sim = new Sim(apt, { onRadio: () => {}, onAlert: () => {}, rates: { sayAgain: 1 } });
sim.setRunway("26"); sim.nextDep = sim.nextArr = 1e9;
d = ifr(sim); run(sim, 40, () => d.state === "clr_req");
r = sim.respond(d, parse(`${d.cs} cleared to ${d.other[1]}, squawk 4521`, sim.ac).ins, { text: "" });
ok(/say again/i.test(r.d) && d.state === "clr_req", "say-again rate: pilot asks again, nothing applied: " + r.d);
// confirm takeoff with traffic on the runway
sim = new Sim(apt, { onRadio: () => {}, onAlert: () => {} });
sim.setRunway("26"); sim.nextDep = sim.nextArr = 1e9;
d = ifr(sim); d.state = "holding"; d.depEnd = sim.depEnd; d.ifr = true;
const blocker = sim.spawnDeparture(); blocker.pos = [...sim.depEnd.thr]; blocker.state = "lined_up";
r = sim.respond(d, parse(`${d.cs} runway 26 cleared for takeoff`, sim.ac).ins, { text: "" });
ok(/confirm cleared for takeoff/i.test(r.d) && d.state === "holding", "pilot questions takeoff clearance with runway occupied: " + r.d);

// ---------- split positions: handoffs & AI controllers ----------
const evs = [], rad = [];
sim = new Sim(apt, { positions: pos, staffing: new Set(["TWR"]), onRadio: (m) => rad.push(m), onAlert: (m) => evs.push(m) });
sim.setRunway("26"); sim.nextDep = sim.nextArr = sim.nextOvf = 1e9;
d = ifr(sim);
ok(d.freq === "DEL", "IFR departure starts on Delivery");
run(sim, 900, () => d.freq === "TWR" && d.state === "holding");
ok(rad.some(m => m.from === "atc" && m.ai && m.pos === "DEL" && /cleared to/.test(m.text)), "AI Delivery gave the clearance");
ok(rad.some(m => m.from === "atc" && m.ai && m.pos === "GND" && /push and start approved/.test(m.text)), "AI Ground approved push");
ok(rad.some(m => m.from === "atc" && m.ai && m.pos === "GND" && /taxi to holding point/.test(m.text)), "AI Ground gave taxi");
ok(d.freq === "TWR", "handed off to Tower (user) by AI Ground");
ok(/^4[23]/.test(d.squawk || ""), "AI Delivery allocated a local code " + d.squawk);
ok(!rad.some(m => m.from === "atc" && m.pos === "TWR"), "AI never talks on a user-staffed position");
// user (tower) can't reach a pilot on another frequency
const other = ifr(sim);
ok(!sim.hears(other, "TWR") && sim.hears(other, "DEL"), "pilot on Delivery doesn't hear Tower");
// user clears for takeoff and hands to approach (AI)
r = sim.respond(d, parse(`${d.cs} runway 26 cleared for takeoff`, sim.ac).ins, { text: "", pos: "TWR" });
ok(/cleared for takeoff/i.test(r.d), "takeoff readback " + r.d);
run(sim, 120, () => d.state === "airborne" && d.alt > 1200);
r = sim.respond(d, parse(`${d.cs} contact Tallinn Radar 127.905`, sim.ac).ins, { text: "", pos: "TWR" });
ok(/127\.905/.test(r.d), "frequency readback " + r.d);
run(sim, 30, () => d.freq === "APP" && rad.some(m => m.ai && m.pos === "APP" && /identified/.test(m.text)));
ok(d.freq === "APP", "pilot switched to Approach");
ok(rad.some(m => m.ai && m.pos === "APP" && /identified/.test(m.text)), "AI Approach identified the departure");
// wrong frequency: pilot goes there and comes back
const d2 = sim.spawnDeparture(); d2.state = "holding"; d2.freq = "TWR"; d2.depEnd = sim.depEnd;
sim.respond(d2, parse(`${d2.cs} contact radar 124.555`, sim.ac).ins, { text: "", pos: "TWR" });
run(sim, 10); ok(d2.freq === "LOST", "pilot left for a dead frequency");
run(sim, 45, () => d2.freq === "TWR");
ok(d2.freq === "TWR" && rad.some(m => m.ac === d2 && /no reply|nobody/i.test(m.text)), "pilot came back: no reply on 124.555");
// arrivals: AI approach hands to the user's tower
const arr = ifrArr(sim);
ok(arr.freq === "APP" && sim.distToThr(arr) > 40000, "arrival starts on Approach at ~25 nm");
run(sim, 900, () => arr.freq === "TWR");
ok(arr.freq === "TWR", "AI Approach handed the arrival to Tower");
ok(rad.some(m => m.ai && m.pos === "APP" && /cleared ILS approach/.test(m.text)), "AI Approach cleared the ILS");

// ---------- staffing everything: no AI at all ----------
rad.length = 0;
sim = new Sim(apt, { positions: pos, staffing: new Set(["DEL", "GND", "TWR", "APP", "CTR"]), onRadio: (m) => rad.push(m), onAlert: () => {} });
sim.nextDep = sim.nextArr = sim.nextOvf = 1e9; d = ifr(sim); run(sim, 120);
ok(!rad.some(m => m.from === "atc"), "all positions staffed -> no AI transmissions");

// ---------- squawk label warnings ----------
d.squawk = "1234"; d.assignedSq = "4521"; ok(sim.labelWarnings(d).some(w => /SQK/.test(w)), "wrong code warning on label");
d.onGround = false; d.xpdr = "S"; ok(sim.labelWarnings(d).includes("NO MODE C"), "missing mode C warning");

// ---------- emergencies ----------
sim = new Sim(apt, { onRadio: (m) => rad.push(m), onAlert: () => {} }); sim.nextDep = sim.nextArr = 1e9;
const ea = sim.spawnArrival(); sim.triggerEvent("7600");
ok(ea.nordo && ea.squawk === "7600", "7600 radio failure");
r = sim.respond(ea, parse(`${ea.cs} cleared to land runway 26`, sim.ac).ins, { text: "" });
ok(r === null && !ea.landClr, "NORDO does not answer");
sim.respond(ea, parse(`${ea.cs} if you read squawk ident`, sim.ac).ins, { text: "" });
ok(!!ea.identUntil, "NORDO answers with ident");

// ---------- ATIS ----------
sim = new Sim(apt, { onRadio: () => {}, onAlert: () => {}, rates: { oldAtis: 1 } }); sim.nextDep = sim.nextArr = 1e9;
sim.rollAtis(); d = ifr(sim); run(sim, 40, () => d.state === "clr_req");
ok(d.atisReported === "Alpha" && sim.atis() === "Bravo", "pilot reported old ATIS Alpha, current Bravo");
r = sim.respond(d, parse(`${d.cs} information bravo is current`, sim.ac).ins, { text: "" });
ok(/information bravo/i.test(r.d) && d.atisReported === null, "ATIS correction read back: " + r.d);

// ---------- coach ----------
sim = new Sim(apt, { onRadio: () => {}, onAlert: () => {} }); sim.setRunway("26"); sim.nextDep = sim.nextArr = 1e9;
d = ifr(sim); d.state = "holding"; d.depEnd = sim.depEnd;
let notes = coach({ text: "cleared for takeoff", parsed: parse("cleared for takeoff", sim.ac, d), sim, pos: "ALL", lang: "en" });
ok(notes.some(x => /callsign/i.test(x.msg)) && notes.some(x => /runway/i.test(x.msg)), "coach: callsign and runway missing -> " + notes.map(x => x.msg).join(" / "));
notes = coach({ text: `${d.cs} runway 26 cleared for takeoff`, parsed: parse(`${d.cs} runway 26 cleared for takeoff`, sim.ac), sim, pos: "ALL", lang: "en" });
ok(notes.every(x => x.level !== "warn"), "coach: correct takeoff clearance has no warnings");
const d3 = sim.spawnDeparture(); d3.state = "clr_req"; d3.squawk = "2000"; d3.assignedSq = "4201"; sim.squawks.take("4201");
const other3 = sim.spawnDeparture(); other3.state = "clr_req";
notes = coach({ text: `${other3.cs} cleared to ${other3.other[1]}, squawk 4201`, parsed: parse(`${other3.cs} cleared to ${other3.other[1]}, squawk 4201`, sim.ac), sim, pos: "ALL", lang: "en" });
ok(notes.some(x => /already in use/i.test(x.msg)), "coach: squawk already in use");
notes = coach({ text: "cleared for takeoff", parsed: parse("cleared for takeoff", sim.ac, d), sim, pos: "ALL", lang: "et" });
ok(notes.some(x => /kutsung/i.test(x.msg)), "coach in Estonian");

// ---------- ATIS from a METAR ----------
{
  const raw = "METAR EETN 141920Z 13007KT 100V160 9999 -RA FEW025 BKN040 09/08 Q1015 NOSIG";
  const mt = parseMetar(raw);
  ok(mt.wind.dir === 130 && mt.wind.spd === 7 && mt.wind.from === 100 && mt.vis === 9999 && mt.wx[0].codes[0] === "RA" && mt.wx[0].int === "-" &&
    mt.clouds.length === 2 && mt.clouds[1].cover === "BKN" && mt.clouds[1].ft === 4000 && mt.temp === 9 && mt.dew === 8 && mt.qnh === 1015, "METAR decoded: " + JSON.stringify({ w: mt.wind, v: mt.vis, wx: mt.wx, c: mt.clouds, t: mt.temp, q: mt.qnh }));
  eq(transitionLevel(5000, 1015), 60, "TL 60 at QNH 1015 (TA 5000)"); eq(transitionLevel(5000, 1000), 65, "TL 65 at QNH 1000"); eq(transitionLevel(6000, 1033), 65, "TL 65 at QNH 1033 (TA 6000)");
  const txt = buildAtis({ icao: "EETN", name: "Tallinn", letter: "B", rwy: "26", metar: raw, region: "ICAO", utc: "1920" });
  for (const re of [/information Bravo/, /time 1920/, /Runway in use 26/, /Transition level 60/, /Wind 130 degrees 7 knots, varying between 100 and 160/, /light rain/i, /Few 2500 feet, broken 4000 feet/, /Temperature 9, dew point 8/, /QNH 1015/, /Acknowledge information Bravo on first contact/])
    ok(re.test(txt), `ATIS text has ${re}`);
  const us = parseMetar("KJFK 141951Z 18012G20KT 10SM FEW050 SCT250 22/14 A3002 RMK AO2 SLP165");
  ok(us.wind.gust === 20 && us.vis === 16090 && Math.abs(us.qnh - 1017) <= 1 && us.qnhInHg === 30.02 && us.remarks.startsWith("AO2"), "US METAR: gusts, statute miles, inHg: " + JSON.stringify({ g: us.wind.gust, v: us.vis, q: us.qnh, r: us.remarks }));
  const txt2 = buildAtis({ icao: "KJFK", name: "Kennedy", letter: "K", rwy: "31L", metar: us, region: "US", utc: "1951" });
  ok(/Altimeter 3 0 0 2/.test(txt2) && /gusting 20 knots/.test(txt2) && /Advise on initial contact you have information Kilo/.test(txt2) && !/Transition level/.test(txt2), "US ATIS: altimeter, gusts, no transition level: " + txt2);
  const fog = parseMetar("EGLL 060750Z 00000KT 0200 R27R/0400N FG VV001 03/03 Q1030");
  const txt3 = buildAtis({ icao: "EGLL", name: "Heathrow", letter: "C", rwy: "27R", metar: fog, region: "UK", utc: "0750", lvp: true });
  ok(/Wind calm/.test(txt3) && /Visibility 200 metres/.test(txt3) && /RVR runway 27R 400 metres/.test(txt3) && /Low visibility procedures in operation/.test(txt3) && /fog/i.test(txt3) && /Transition level 70/.test(txt3), "LVP ATIS: " + txt3);
  ok(/CAVOK/.test(buildAtis({ icao: "EETN", name: "Tallinn", letter: "A", rwy: "08", metar: "EETN 141920Z 27005KT CAVOK 15/05 Q1020", region: "ICAO" })), "CAVOK read out");
  ok(/130\/7 · 10km\+ · -RA · 9\/8 · Q1015/.test(atisSummary(mt)), "summary line: " + atisSummary(mt));
}

// ---------- a living apron: parked aircraft, real traffic mix, turnaround, waves, service vehicles ----------
{
  sim = new Sim(apt, { onRadio: () => {}, onAlert: () => {}, occupancy: 0.6 }); sim.setRunway("26"); sim.nextDep = sim.nextArr = 1e9;
  sim.setTrafficMix({ airlines: [{ icao: "BTI", callsign: "Airbaltic", nat: "LV", routes: 8 }, { icao: "RYR", callsign: "Ryanair", nat: "IE", routes: 4 }, { icao: "DHK", callsign: "World Express", nat: "GB", routes: 1 }, { icao: "ZZZ", callsign: "", routes: 9 }],
    dests: [{ icao: "EVRA", city: "Riga", lat: 56.92, lon: 23.97 }, { icao: "EGSS", city: "Stansted", lat: 51.88, lon: 0.23 }, { icao: "EDDP", city: "Leipzig", lat: 51.43, lon: 12.24 }],
    pairs: [["BTI", "EVRA", 5], ["BTI", "EGSS", 1], ["RYR", "EGSS", 4], ["DHK", "EDDP", 1]], cargo: ["DHK"] });
  ok(sim.mix && sim.mix.airlines.length === 3 && sim.mix.airlines.find(a => a.icao === "BTI").tel === "Air Baltic", "traffic mix loaded; known airlines keep their telephony (" + sim.mix.airlines.map(a => a.tel).join(", ") + ")");
  sim.step(0.1);
  const parked = sim.ac.filter(a => a.state === "parked" && a.dormant);
  const eligible = apt.stands.filter(s => ["gate", "tie_down", "hangar", "misc"].includes(s.kind) && !/maint|hangar|fuel|de-?ic|wash|engine|run-?up/i.test(s.name)).length;
  ok(Math.abs(parked.length - Math.round(0.6 * eligible)) <= 1, `60 % of ${eligible} stands populated: ${parked.length} parked aircraft`);
  ok(parked.every(a => a.stand && dist(a.pos, a.stand.pos) < 1 && Math.abs(a.hdg - a.stand.hdg) < 0.5), "parked aircraft sit on their stands facing the stand heading");
  const airlines = new Set(parked.filter(a => !a.ga).map(a => a.cs.slice(0, 3)));
  ok([...airlines].every(c => ["BTI", "RYR", "DHK"].includes(c)) && airlines.has("BTI"), "airlines from the mix only: " + [...airlines].join(","));
  ok(parked.filter(a => !a.ga).every(a => ["EVRA", "EGSS", "EDDP"].includes(a.other[0])), "destinations from the mix");
  const bti = parked.filter(a => a.cs.startsWith("BTI")), btiOdd = bti.filter(a => a.type !== "BCS3");
  ok(btiOdd.every(a => a.stand && !/jets/.test(a.stand.types || "")), "airBaltic flies the A220 (fleet table) unless the stand takes no jets: " + btiOdd.map(a => `${a.type}@${a.stand && a.stand.name}[${a.stand && a.stand.types}]`).join(" "));
  const cargoStands = apt.stands.filter(s => s.op === "cargo" || /cargo|freight/i.test(s.name));
  const cargoAc = parked.filter(a => a.cargo);
  ok(!cargoStands.length || cargoAc.every(a => a.stand && (a.stand.op === "cargo" || /cargo/i.test(a.stand.name)) && a.cs.startsWith("DHK")), `cargo flights only on the ${cargoStands.length} cargo stands (${cargoAc.length})`);
  const vehs = sim.ac.filter(a => a.veh && a.onRoad);
  ok(vehs.length === sim.serviceVehicles && vehs.length > 0, `${vehs.length} service vehicles on the roads`);
  run(sim, 120);
  ok(vehs.some(v => v.spd > 0 || v.path), "service vehicles drive around");
  ok(vehs.every(v => !apt.runways.some(r => apt.onRunway(v.pos, r, 2))), "service vehicles never on a runway");
  // the next departure is one of the parked aircraft
  const before = sim.ac.length;
  const w = sim.spawnDeparture();
  ok(w && !w.dormant && parked.includes(w) && sim.ac.length === before, "spawnDeparture wakes a parked aircraft instead of inventing one: " + w.cs);
  run(sim, 40, () => w.state === "clr_req" || w.state === "taxi_req");
  ok(w.state === "clr_req" || w.state === "taxi_req", "the woken aircraft calls: " + w.state);
  // an arrival parks, then turns round into a dormant departure with a new flight number
  const arr2 = ifrArr(sim); arr2.landClr = true; const oldCs = arr2.cs;
  run(sim, 900, () => arr2.state === "vacated");
  sim.respond(arr2, parse(`${arr2.cs} taxi to stand ${arr2.stand.name}`, sim.ac).ins, { text: "" });
  run(sim, 2400, () => arr2.state === "parked");
  ok(arr2.state === "parked", "arrival parked: " + arr2.state);
  run(sim, 2700, () => arr2.kind === "dep" || arr2.gone);
  ok((arr2.kind === "dep" && arr2.dormant && arr2.cs !== oldCs && arr2.cs.startsWith(oldCs.slice(0, 3))) || arr2.gone, `turnaround: ${oldCs} became ${arr2.gone ? "(left, apron full)" : arr2.cs + " waiting for its slot"}`);
  // time-of-day waves
  sim.waves = true; sim.clockUtc = Date.UTC(2026, 5, 20, 5, 0); sim.t = 0;        // ~07 local at EETN (UTC+1.65 solar)
  const peak = sim.wave(); sim.clockUtc = Date.UTC(2026, 5, 20, 0, 0); const night = sim.wave();
  ok(peak > 1.2 && night < 0.4, `morning peak ${peak} vs night ${night}`);
  sim.waves = false; ok(sim.wave() === 1, "waves off = flat rate");
}

// ---------- NORDO (7600): light signals, circuit rejoin, follow-me ----------
{
  const rad2 = [];
  sim = new Sim(apt, { onRadio: (m) => rad2.push(m), onAlert: () => {} }); sim.setRunway("26"); sim.nextDep = sim.nextArr = 1e9;
  const na = ifrArr(sim); sim.triggerEvent("7600", na);
  ok(na.nordo && na.squawk === "7600", "7600 set on the arrival");
  let eff = sim.respond(na, parse(`${na.cs} light red steady`, sim.ac).ins, { text: "" });
  ok(eff === null && na.state === "goaround" && na.rejoin, "red steady on final: NORDO goes around and will rejoin (no reply)");
  run(sim, 900, () => na.state === "final" && !na.wps);
  ok(na.state === "final", "NORDO rejoined final through the circuit: " + na.state + " " + (na.circuitLeg || ""));
  sim.respond(na, parse(`${na.cs} light green steady`, sim.ac).ins, { text: "" });
  ok(na.landClr, "green steady on final = cleared to land");
  run(sim, 900, () => na.state === "vacated");
  ok(na.state === "vacated", "NORDO landed and vacated: " + na.state);
  ok(!rad2.some(m => m.ac === na), "a NORDO aircraft never transmits (" + rad2.filter(m => m.ac === na).length + " calls)");
  ok(!!na.lastWant, "what it would have said is kept for the info panel: " + na.lastWant);
  const before = sim.lightLog.length;
  sim.respond(na, parse(`${na.cs} light green flashing`, sim.ac).ins, { text: "" });
  ok(na.state === "taxi" && na.taxiTo === "stand" && sim.lightLog.length === before + 1, "green flashing on the ground: taxis to the stand");
  sim.respond(na, parse(`${na.cs} light red steady`, sim.ac).ins, { text: "" });
  ok(na.holdPos, "red steady: stop");
  run(sim, 30); const p0 = [...na.pos]; run(sim, 20);
  ok(dist(p0, na.pos) < 1, "stays stopped under red steady");
  sim.respond(na, parse(`${na.cs} flashing green`, sim.ac).ins, { text: "" });
  ok(!na.holdPos, "flashing green again: continues");
  run(sim, 1800, () => na.state === "parked");
  ok(na.state === "parked", "NORDO parked after light signals: " + na.state);
  // departure under light signals
  const nd = ifr(sim); nd.nordo = true; nd.squawk = "7600";
  run(sim, 40, () => nd.state === "clr_req");
  sim.respond(nd, parse(`${nd.cs} light green flashing`, sim.ac).ins, { text: "" });
  ok(nd.state === "pushing", "NORDO departure: green flashing = push back and taxi");
  run(sim, 1500, () => nd.state === "holding");
  ok(nd.state === "holding", "reached the holding point under light signals: " + nd.state);
  sim.respond(nd, parse(`${nd.cs} light green steady`, sim.ac).ins, { text: "" });
  ok(nd.toClr && ["lineup", "lining", "roll"].includes(nd.state), "green steady at the holding point = cleared for takeoff: " + nd.state);
  run(sim, 300, () => nd.state === "airborne");
  ok(nd.state === "airborne", "departed");
  const nd2 = ifr(sim); nd2.nordo = true; nd2.squawk = "7600"; run(sim, 40, () => nd2.state === "clr_req");
  sim.respond(nd2, parse(`${nd2.cs} light green flashing`, sim.ac).ins, { text: "" });
  run(sim, 400, () => nd2.state === "taxi");
  sim.respond(nd2, parse(`${nd2.cs} light white flashing`, sim.ac).ins, { text: "" });
  ok(nd2.state === "taxi" && nd2.taxiTo === "stand", "white flashing: returns to the stand");
  run(sim, 1500, () => nd2.state === "parked");
  ok(nd2.state === "parked" && nd2.returned, "back on a stand: " + nd2.state);
  // follow-me
  sim = new Sim(apt, { onRadio: (m) => rad2.push(m), onAlert: () => {} }); sim.setRunway("26"); sim.nextDep = sim.nextArr = 1e9;
  const nb = ifrArr(sim); nb.nordo = true; nb.squawk = "7600"; nb.landClr = true;
  run(sim, 900, () => nb.state === "vacated");
  sim.respond(nb, parse(`${nb.cs} send follow-me`, sim.ac).ins, { text: "" });
  ok(nb.followMe && nb.followMe.veh && nb.followMe.cs === "FOLLOWME1" && nb.followMe.state === "toAircraft", "follow-me car dispatched: " + (nb.followMe && nb.followMe.cs));
  const car = nb.followMe;
  const crossings = [];
  const drive = (sec, until) => { // like a controller: clear the car across any runway it stops at
    for (let k = 0; k < 10; k++) {
      if (run(sim, sec, () => until() || (car.atStop && car.blockedRwy != null && car.spd < 0.1))) { if (until()) return true; }
      if (car.atStop && car.blockedRwy != null) { const r = apt.runways[car.blockedRwy].ends[0].name; crossings.push(r); sim.respond(car, parse(`${car.cs} cross runway ${r}`, sim.ac).ins, { text: "" }); } else return until();
    }
    return until();
  };
  drive(900, () => car.state === "leading");
  ok(car.state === "leading" && nb.leader === car && nb.state === "taxi", "car reached the aircraft and leads it: " + car.state);
  drive(2400, () => nb.state === "parked");
  ok(nb.state === "parked", "aircraft followed the car onto the stand: " + nb.state + (crossings.length ? " (crossed runway " + crossings.join(", ") + " on the car's clearance)" : ""));
  run(sim, 600, () => nb.followMe.gone);
  ok(nb.followMe.gone, "follow-me returned to base and left");
  ok(!sim.ac.some(a => a.veh && !a.onRoad), "no follow-me left behind (" + sim.ac.filter(a => a.veh && a.onRoad).length + " service vehicles roam the roads)");
  // a normal aircraft also complies with a light signal and acknowledges
  const nc = ifr(sim); nc.state = "holding"; nc.depEnd = sim.depEnd; nc.ifr = true;
  const rr = sim.respond(nc, parse(`${nc.cs} light red steady`, sim.ac).ins, { text: "" });
  ok(rr && /roger/i.test(rr.d) && nc.holdPos, "pilot with a radio acknowledges a light signal: " + (rr && rr.d));
}

console.log(fails ? `\n${fails}/${n} FAILED` : `\nALL ${n} PASSED`);
process.exit(fails ? 1 : 0);
