// Screenshots of specific pictures for the README and for eyeballing: zoomed ground view with silhouettes,
// Delivery view, the aircraft info panel, tower view at night.
//   node tests/shots.mjs [ICAO] [outDir]     (server must be running on :8780)
import { launch, sleep } from "./cdp.mjs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  console.log("errors:", p.errors.length ? p.errors : "none");
  p.close();
} finally { br.close(); }
