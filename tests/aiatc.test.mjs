// S5: the AI controllers fly a real XRadio pilot from a stand at EETN to the edge of the airspace towards EVRA,
// end to end -- XRadio's own server, tools/fake_client.py as the pilot (scripted over stdin: it files the plan,
// calls, reads back, moves), the page in headless Chrome with the XRadio bridge on and nobody staffed.
//   node tests/aiatc.test.mjs            (server.py on :8780; XRADIO_DIR or ../xradio-main next to this checkout)
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { createSocket } from "node:dgram";
import { launch, sleep } from "./cdp.mjs";
import { Airport } from "../web/js/airport.js";
import { buildPositions } from "../web/js/positions.js";

const XR = process.env.XRADIO_DIR || resolve(fileURLToPath(new URL("../../xradio-main", import.meta.url)));
const PY = process.env.PYTHON || (process.platform === "win32" ? "python" : "python3");
let fails = 0, n = 0;
const ok = (c, msg) => { n++; console.log(`${c ? "PASS" : "FAIL"}  ${msg}`); if (!c) fails++; };

if (!existsSync(join(XR, "server", "server.py")) || !existsSync(join(XR, "tools", "fake_client.py"))) {
  console.log(`note  XRadio not found at ${XR} (set XRADIO_DIR) -- end-to-end AI ATC test skipped`);
  process.exit(0);
}

const freePort = () => new Promise((res) => { const s = createSocket("udp4"); s.bind(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });
const PORT = await freePort();
const apt = new Airport(JSON.parse(readFileSync(new URL("../cache/EETN.json", import.meta.url), "utf8")));
const pos = buildPositions(apt);
const khz = (k) => Math.round(pos[k].mhz * 1000);
const stand = apt.stands.find(s => s.types && s.types.includes("jets")) || apt.stands[0];
const [slat, slon] = apt.toLatLon(stand.pos);
const elev = apt.d.elevation || 0;
const procs = [];
const kill = () => { for (const p of procs) { try { p.kill(); } catch { /* */ } } };
process.on("exit", kill);

// XRadio's server
const srv = spawn(PY, ["-u", "server.py", "--port", String(PORT)], { cwd: join(XR, "server"), stdio: ["ignore", "pipe", "pipe"] });
procs.push(srv);
srv.stdout.on("data", () => {}); srv.stderr.on("data", () => {});
await sleep(1500);

// the page: XRadio on, nobody staffed, no other traffic
const br = await launch({ port: 9337 });
let p;
try {
  p = await br.newPage("about:blank");
  await p.eval(`localStorage.clear()`).catch(() => {});
  await p.eval(`location.href = "http://localhost:8780/?icao=EETN"`);
  await p.waitFor(`!!(window.TT && TT.sim && TT.apt)`, 30000);
  await p.eval(`TT.radio.tts = false; TT.settings.voices = false`);
  await p.eval(`TT.applyStaffing("split", ["TWR"])`);
  await sleep(300);
  await p.eval(`(() => { const s = TT.sim; s.staffing.clear(); s.nextDep = s.nextArr = s.nextVfr = 1e9; s.vfrPerHour = 0; for (const a of s.ac.filter(a => !a.human)) s.remove ? s.remove(a) : null; s.ac.splice(0, s.ac.length, ...s.ac.filter(a => a.human)); })()`);
  await p.click("#settingsBtn");
  await p.eval(`(() => { const $ = (i) => document.getElementById(i);
    $("xrEnabled").checked = true; $("xrHost").value = "127.0.0.1"; $("xrPort").value = "${PORT}"; $("xrPass").value = ""; $("xrCs").value = "EETN_TWR";
    $("xrAi").checked = false; $("xrHumans").checked = true; $("xrText").checked = true; $("xrVoice").checked = false; $("xrAiAtc").checked = true; $("xrTranscribe").checked = false;
    $("xrEnabled").dispatchEvent(new Event("change", { bubbles: true })); })()`);
  await sleep(500);
  await p.eval(`document.getElementById("settings").close()`);
  ok(await p.eval(`TT.settings.xr.enabled && TT.settings.xr.port === ${PORT} && TT.settings.xr.aiAtc && !!TT.pilotAtc`), "the page has XRadio on and the AI controllers armed");
  await p.waitFor(`(TT.sim.staffing.size === 0) && (() => { const s = document.getElementById("xrInfo"); return s && /Connected/.test(s.textContent); })()`, 20000).catch(() => {});
  ok(await p.eval(`/Connected/.test(document.getElementById("xrInfo").textContent)`), "the bridge is connected to XRadio's server: " + await p.eval(`document.getElementById("xrInfo").textContent.slice(0, 80)`));

  // the pilot: on the stand, a SimBrief-style plan, Delivery's frequency
  const lines = [];
  const pilot = spawn(PY, ["-u", join(XR, "tools", "fake_client.py"), "--port", String(PORT), "--callsign", "ESXYZ", "--actype", "A320",
    "--lat", String(slat), "--lon", String(slon), "--alt-ft", String(elev), "--heading", "80", "--speed-kt", "0", "--com1", String(khz("DEL")),
    "--squawk", "2000", "--xpdr", "1", "--on-ground", "--file-plan", "EETN EVRA ULGOT1G ULGOT N746 ABETI ABETI2A", "--rules", "I", "--cruise", "36000",
    "--remarks", "SIMBRIEF EOBT/0730 TAS/447 REG/ESTTR", "--script", "-"], { stdio: ["pipe", "pipe", "pipe"] });
  procs.push(pilot);
  let buf = "";
  pilot.stdout.on("data", (d) => { buf += d.toString(); let i; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i).trimEnd(); buf = buf.slice(i + 1); lines.push(l); if (process.env.VERBOSE) console.log("   pilot> " + l); } });
  pilot.stderr.on("data", (d) => { if (process.env.VERBOSE) console.log("   pilot! " + d); });
  const send = (cmd) => pilot.stdin.write(cmd + "\n");
  const waitLine = async (rx, ms = 30000, from = 0) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { for (let i = from; i < lines.length; i++) if (rx.test(lines[i])) return lines[i]; await sleep(100); } return null; };
  const sayAndWait = async (text, rx, ms = 30000) => { const from = lines.length; send("say " + text); return waitLine(rx, ms, from); };

  ok(!!await waitLine(/logged in as ESXYZ/, 15000), "the pilot logged in");
  await p.waitFor(`TT.sim.ac.some(a => a.human && a.cs === "ESXYZ" && a.fp && a.fp.dest === "EVRA")`, 20000).catch(() => {});
  ok(await p.eval(`TT.sim.ac.some(a => a.human && a.cs === "ESXYZ" && a.fp && a.fp.dest === "EVRA" && a.simbrief === true && a.planSid === "ULGOT1G")`), "the pilot and the filed plan are on the radar, with the SimBrief mark and the planned SID");

  // Delivery
  const clr = await sayAndWait(`Tallinn Delivery, ESXYZ, stand ${stand.name}, information Alpha, request clearance to Riga`, /EETN_DEL: ESXYZ, cleared to EVRA via .*, climb \d+ feet, squawk \d{4}/);
  ok(!!clr, "Delivery (AI) clears from the filed plan: " + (clr || "nothing heard"));
  const rbOk = await sayAndWait(`cleared to Riga via {sid}, climb {climb} feet, squawk {squawk}, ESXYZ`, /readback correct, contact Ground \d{3}\.\d+ when ready/);
  ok(!!rbOk, "the readback is checked and the pilot is sent to Ground: " + (rbOk || "nothing heard"));
  ok(!!await waitLine(/flight plan ESXYZ EETN->EVRA.*(acknowledged|cleared), squawk \d{4}/, 10000), "the flight plan came back answered with the squawk (PT_FLIGHTPLAN)");
  ok(await p.eval(`(() => { const F = TT.pilotAtc.flights.get("ESXYZ"); return F && F.phase === "cleared" && F.pos === "GND"; })()`), "the page's flight state follows");

  // Ground
  send(`com1 ${khz("GND")}`); await sleep(400);
  const taxi = await sayAndWait(`Tallinn Ground, ESXYZ, request taxi`, /EETN_GND: ESXYZ, taxi to holding point runway (\d\d[LRC]?).*hold short runway/);
  ok(!!taxi, "Ground (AI) gives a taxi route from the real position: " + (taxi || "nothing heard"));
  const rwy = taxi ? /runway (\d\d[LRC]?)/.exec(taxi)[1] : await p.eval(`TT.sim.depEnd.name`);
  await sayAndWait(`taxi to holding point runway ${rwy}, hold short runway ${rwy}, ESXYZ`, /./, 1500);
  await sleep(800);
  ok(await p.eval(`(() => { const F = TT.pilotAtc.flights.get("ESXYZ"); return F && F.phase === "taxi" && F.taxi && F.taxi.points.length > 1; })()`), "taxi readback accepted, route stored");
  const hp = await p.eval(`(() => { const F = TT.pilotAtc.flights.get("ESXYZ"); const pts = F.taxi.points, hp = pts[pts.length - 1], pv = pts[pts.length - 2];
    const L = Math.hypot(hp[0] - pv[0], hp[1] - pv[1]) || 1, ux = (hp[0] - pv[0]) / L, uy = (hp[1] - pv[1]) / L;
    let back = 60; while (back < 290 && TT.apt.runways.some(R => TT.apt.onRunway([hp[0] - ux * back, hp[1] - uy * back], R, 5))) back += 10;
    return TT.apt.toLatLon([hp[0] - ux * back, hp[1] - uy * back]); })()`);
  let from = lines.length;
  send(`pos ${hp[0]} ${hp[1]} ${elev} 0 80 ground`);
  const twr = await waitLine(/EETN_GND: ESXYZ, contact Tower (\d{3}\.\d+)/, 20000, from);
  ok(!!twr, "at the holding point: handed to Tower: " + (twr || "nothing heard"));

  // Tower
  send(`com1 ${khz("TWR")}`); await sleep(400);
  const tko = await sayAndWait(`Tallinn Tower, ESXYZ, holding point runway ${rwy}, ready for departure`, /EETN_TWR: ESXYZ, runway \d\d[LRC]?, cleared for takeoff/);
  ok(!!tko, "Tower (AI) clears for takeoff: " + (tko || "nothing heard"));
  await sayAndWait(`runway ${rwy}, cleared for takeoff, ESXYZ`, /./, 1500);
  const air = await p.eval(`(() => { const e = TT.sim.depEnd; return TT.apt.toLatLon([e.thr[0] + e.v[0] * 2500, e.thr[1] + e.v[1] * 2500]); })()`);
  from = lines.length;
  send(`pos ${air[0]} ${air[1]} ${elev + 1200} 160 80 air`);
  const app = await waitLine(/EETN_TWR: ESXYZ, contact (Radar|Departure|Director) (\d{3}\.\d+)/, 20000, from);
  ok(!!app, "airborne: handed to Radar: " + (app || "nothing heard"));

  // Radar and Control
  send(`com1 ${khz("APP")}`); await sleep(400);
  const climb = await sayAndWait(`Tallinn Radar, ESXYZ, passing 2000 feet`, /EETN_APP: ESXYZ, identified, climb flight level (\d+)/);
  ok(!!climb, "Radar (AI) identifies and clears the climb: " + (climb || "nothing heard"));
  await sayAndWait(`climb flight level {fl}, ESXYZ`, /./, 1500);
  const far = await p.eval(`(() => { const e = TT.sim.depEnd; return TT.apt.toLatLon([e.thr[0] + e.v[0] * 12000, e.thr[1] + e.v[1] * 12000]); })()`);
  from = lines.length;
  send(`pos ${far[0]} ${far[1]} ${elev + 7000} 250 80 air`);
  const ctr = await waitLine(/EETN_APP: ESXYZ, contact .*Control (\d{3}\.\d+)/, 20000, from);
  ok(!!ctr, "above 4500 ft: handed to Control: " + (ctr || "nothing heard"));
  send(`com1 ${khz("CTR")}`); await sleep(400);
  const cruise = await sayAndWait(`Tallinn Control, ESXYZ, climbing flight level 120`, /EE_CTR: ESXYZ, identified, climb flight level 360/);
  ok(!!cruise, "Control (AI) clears to the filed cruise level: " + (cruise || "nothing heard"));
  await sayAndWait(`climb flight level 360, ESXYZ`, /./, 1500);
  const away = await p.eval(`(() => { const e = TT.sim.depEnd; return TT.apt.toLatLon([e.v[0] * 40 * 1852, e.v[1] * 40 * 1852]); })()`);
  from = lines.length;
  send(`pos ${away[0]} ${away[1]} ${elev + 20000} 400 80 air`);
  const bye = await waitLine(/radar service terminated/, 20000, from);
  ok(!!bye, "leaving the airspace: the flight is closed: " + (bye || "nothing heard"));
  const d = await p.eval(`JSON.stringify(TT.pilotAtc.debrief("ESXYZ") || null)`);
  const deb = JSON.parse(d || "null");
  ok(deb && deb.done && deb.readbackErrors === 0 && deb.deviations === 0 && deb.score === 100 && /airborne: \+/.test(deb.text), "the debrief: a clean flight, score " + (deb && deb.score));
  ok(await p.eval(`(() => { const t = document.querySelector("#log").textContent; return /\\(AI\\)/.test(t) && /cleared for takeoff/.test(t); })()`), "the AI calls are in the controller's log");
  const errs = await p.eval(`(window.__errors || []).length`).catch(() => 0);
  ok(!errs, "no page errors");
  send("end");
} catch (e) {
  ok(false, "end-to-end flight: " + (e && e.stack || e));
} finally {
  try { if (p) await p.eval(`location.href = "about:blank"`); } catch { /* */ }
  await sleep(300);
  br.close();
  kill();
}
console.log(fails ? `${fails} FAILED of ${n}` : `ALL ${n} PASSED`);
process.exit(fails ? 1 : 0);
