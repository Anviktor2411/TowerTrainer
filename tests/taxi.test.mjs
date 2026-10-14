// Taxi network: every stand must reach every runway end (and every runway end every stand) through the
// taxi graph, with generated stand links where the Gateway data has none.
//   node tests/taxi.test.mjs            (uses whatever of EGSS, EGLL, EETN, KJFK is in cache/)
import { readFileSync, existsSync } from "node:fs";
import { Airport } from "../web/js/airport.js";

let fails = 0, n = 0;
const ok = (c, msg) => { n++; if (!c) { fails++; console.log("FAIL  " + msg); } else console.log("PASS  " + msg); };
const WANT = process.argv.slice(2).length ? process.argv.slice(2) : ["EGSS", "EGLL", "EETN", "KJFK"];

for (const icao of WANT) {
  const file = new URL(`../cache/${icao}.json`, import.meta.url);
  if (!existsSync(file)) { console.log(`SKIP  ${icao}: not in cache/ (load it once in the app or via server.load_airport)`); continue; }
  const d = JSON.parse(readFileSync(file, "utf8"));
  const apt = new Airport(d);
  const stands = apt.stands.filter(s => s.kind === "gate" || s.kind === "tie_down" || s.kind === "hangar" || s.kind === "misc");
  const linked = stands.filter(s => s.node != null && !s.unlinked);
  ok(linked.length === stands.length, `${icao}: ${linked.length}/${stands.length} stands linked to the taxi network (${apt.standLinks.length} generated links)`);
  let toRwy = 0, fromRwy = 0, total = 0, missing = [];
  const ends = apt.runways.flatMap(r => r.ends).filter(e => apt.entries(e).length);   // a runway without any taxiway is not usable
  ok(ends.length > 0, `${icao}: ${ends.length} runway ends with taxiway entries`);
  for (const s of linked) {
    for (const e of ends) {
      total++;
      const out = apt.routeToRunway(s.node, e, []);
      if (out) toRwy++; else missing.push(`${s.name}→${e.name}`);
      // back from the runway's first exit to the stand
      const ex = apt.exitsAhead(e, 0)[0];
      if (ex) {
        const back = apt.routeToPos(ex.node, s.pos, []);
        if (back && back[back.length - 1] === s.node) fromRwy++; else missing.push(`${e.name}→${s.name}`);
      } else fromRwy++;
    }
  }
  ok(toRwy === total, `${icao}: ${toRwy}/${total} stand→runway routes` + (toRwy === total ? "" : ` missing: ${missing.slice(0, 8).join(", ")}`));
  ok(fromRwy === total, `${icao}: ${fromRwy}/${total} runway→stand routes end on the stand node`);
  // routes leave the apron via taxilanes: the first edge from a stand is the generated link or an unnamed lane
  const s0 = linked[0];
  if (s0) {
    const r = apt.routeToRunway(s0.node, ends[0], []);
    ok(r && r[0] === s0.node && r.length > 2, `${icao}: route from ${s0.name} starts at the stand node and has ${r ? r.length : 0} nodes`);
  }
  ok(apt.roads.length >= 0 && apt.roadAdj.length === apt.nodes.length, `${icao}: ${apt.roads.length} service-road edges parsed`);
  ok((d.leadLines || []).length >= 0 && (d.lines || []).length > 0, `${icao}: ${d.lines.length} centrelines, ${(d.leadLines || []).length} lead-in lines, ${(d.edgeLines || []).length} edge markings`);
}
console.log(fails ? `\n${fails}/${n} FAILED` : `\nALL ${n} PASSED`);
process.exit(fails ? 1 : 0);
