// Screenshots of specific pictures for the README and for eyeballing: zoomed ground view with silhouettes,
// Delivery view, the aircraft info panel, tower view at night.
//   node tests/shots.mjs [ICAO] [outDir]     (server must be running on :8780)
import { launch, sleep } from "./cdp.mjs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";

const icao = process.argv[2] || "EETN";
const out = process.argv[3] || join(tmpdir(), "tt-shots");
const br = await launch({ port: 9336, width: 1600, height: 900 });
try {
  const p = await br.newPage(`http://localhost:8780/?icao=${icao}`);
  await p.waitFor(`window.TT && TT.sim && TT.apt && TT.apt.icao === '${icao}'`, 30000);
  await p.eval(`TT.radio.tts = false; TT.settings.voices = false;`);
  await p.eval(`(() => { const s = TT.sim; s.nextDep = s.nextArr = 1e9; for (let i = 0; i < 6; i++) s.spawnDeparture(); for (let i = 0; i < 3; i++) s.spawnArrival(); for (let i = 0; i < 400; i++) s.step(0.1); })()`);
  await sleep(800);
  await p.shot(join(out, `${icao}-ground.png`));
  // zoom on the apron: silhouettes
  await p.eval(`(() => { const r = TT.radar; const a = TT.sim.ac.find(x => x.onGround && x.kind === "dep"); r.cx = a.pos[0]; r.cy = a.pos[1]; r.scale = 1.6; r.staticKey = null; TT.select(a.id); })()`);
  await sleep(700);
  await p.shot(join(out, `${icao}-apron-zoom.png`));
  await p.eval(`TT.setView("DEL")`); await sleep(700);
  await p.shot(join(out, `${icao}-delivery.png`));
  await p.eval(`(() => { TT.setView("TWR"); const a = TT.sim.ac.find(x => x.kind === "arr"); if (a) TT.select(a.id); })()`); await sleep(700);
  await p.shot(join(out, `${icao}-tower.png`));
  await p.eval(`(() => { TT.setView("GND"); TT.radar.night = true; TT.radar.staticKey = null; TT.radar.cx = 0; TT.radar.cy = 0; TT.radar.scale = 0.35; })()`); await sleep(700);
  await p.shot(join(out, `${icao}-night.png`));
  // S1/S2: the SimBrief OFP panel with the route on the map (the made-up fixture plan)
  const plan = JSON.parse(readFileSync(new URL("./fixtures/simbrief_plan.json", import.meta.url), "utf8"));
  await p.eval(`(() => { TT.radar.night = false; TT.radar.staticKey = null; try { TT.select(null); } catch (e) { /* no selection */ } TT.setView("DEL"); TT.app.setOfp(${JSON.stringify(plan)}); document.getElementById("ofpPanel").classList.remove("hidden"); })()`); await sleep(900);
  await p.shot(join(out, `${icao}-ofp.png`));
  await p.eval(`document.getElementById("ofpPanel").classList.add("hidden")`);
  // S4: the debrief of a real pilot's flight handled by the AI controllers
  await p.eval(`(() => { const s = TT.sim, atc = TT.pilotAtc; if (!atc) return; const stand = TT.apt.stands.find(x => x.types && x.types.includes("jets")) || TT.apt.stands[0];
    const fp = { session_id: 9, callsign: "ESXYZ", ac_icao: "A320", rules: "I", status: "filed", squawk: 0, dep: TT.apt.icao, dest: "EVRA", altn: "EYVI", cruise_ft: 36000, route: "ULGOT1G ULGOT N746 ABETI ABETI2A", remarks: "SIMBRIEF EOBT/0730" };
    const khz = (k) => Math.round(TT.positions[k].mhz * 1000);
    s.staffing.clear(); s.upsertHuman({ hid: 9, cs: "ESXYZ", type: "A320", pos: stand.pos, alt: 0, hdg: 80, spd: 0, onGround: true, squawk: "2000", xpdr: "S", ai: false, tx: false, fp });
    s.step(1); atc.tick();
    atc.heard("ESXYZ", "Tallinn Delivery, ESXYZ, request clearance to Riga", khz("DEL"), false);
    const F = atc.flights.get("ESXYZ"); atc.heard("ESXYZ", "cleared to Riga, climb " + F.climb + " feet, squawk 4512, ESXYZ", khz("DEL"), false);
    atc.heard("ESXYZ", "cleared to Riga via flight planned route, climb " + F.climb + " feet, squawk " + F.squawk + ", ESXYZ", khz("DEL"), false);
    atc.heard("ESXYZ", "request taxi", khz("GND"), false); atc.heard("ESXYZ", "taxi to holding point runway " + s.depEnd.name + ", hold short, ESXYZ", khz("GND"), false);
    const d = atc.debrief("ESXYZ"); document.getElementById("pilotDebriefBody").textContent = d.text; document.getElementById("pilotDebrief").showModal(); })()`); await sleep(700);
  await p.shot(join(out, `${icao}-debrief.png`));
  await p.eval(`document.getElementById("pilotDebrief").close()`);
  console.log("errors:", p.errors.length ? p.errors : "none");
  p.close();
} finally { br.close(); }
