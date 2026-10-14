// Frame-rate check with a crowded airport: 150+ aircraft and vehicles on screen, reports the average and worst
// frame times of the real page (headless Chrome, software rendering - a desktop GPU is faster).
//   node tests/perf.mjs [ICAO] [count]     (server must be running on :8780)
import { launch, sleep } from "./cdp.mjs";

const icao = process.argv[2] || "KORD";
const want = +(process.argv[3] || 160);
const br = await launch({ port: 9340, width: 1600, height: 900 });
let fails = 0;
const ok = (c, m) => { console.log((c ? "PASS  " : "FAIL  ") + m); if (!c) fails++; };
try {
  const p = await br.newPage(`http://localhost:8780/?icao=${icao}`);
  ok(await p.waitFor(`window.TT && TT.sim && TT.apt && TT.apt.icao === '${icao}'`, 60000), `page loads ${icao}`);
  await p.eval(`TT.radio.tts = false; TT.settings.voices = false;`);
  const n = await p.eval(`(() => { const s = TT.sim; s.populate(1); s.serviceVehicles = 30; s.ensureServiceVehicles(); s.nextDep = s.nextArr = 1e9;
    for (let i = 0; i < 25; i++) { const a = s.spawnArrival(); if (a) { a.pos = [a.pos[0] - i * 3000 * a.end.v[0], a.pos[1] - i * 3000 * a.end.v[1]]; } }
    for (let i = 0; i < 200; i++) s.step(0.1); return s.ac.length; })()`);
  ok(n >= want, `${n} aircraft and vehicles in the simulation (wanted ≥ ${want})`);
  for (const view of ["GND", "TWR"]) {
    await p.eval(`TT.setView("${view}")`);
    const r = await p.eval(`new Promise(res => { const t = []; let last = performance.now(), k = 0; const f = (now) => { t.push(now - last); last = now; if (++k < 120) requestAnimationFrame(f); else res(t); }; requestAnimationFrame(f); })`);
    const frames = r.slice(10);
    const avg = frames.reduce((a, b) => a + b, 0) / frames.length, worst = Math.max(...frames);
    ok(avg < 25, `${view} view: ${frames.length} frames, average ${avg.toFixed(1)} ms, worst ${worst.toFixed(1)} ms (headless software rendering; 16.7 ms = 60 fps)`);
  }
  await p.eval(`TT.setView("GND")`);
  const draw = await p.eval(`(() => { const t0 = performance.now(); for (let i = 0; i < 30; i++) TT.radar.draw({ ac: TT.sim.snapshot(null), arrEnd: TT.sim.arrEnd }, null); return (performance.now() - t0) / 30; })()`);
  ok(draw < 16, `radar.draw() with ${n} targets: ${draw.toFixed(1)} ms per frame`);
  const step = await p.eval(`(() => { const t0 = performance.now(); for (let i = 0; i < 100; i++) TT.sim.step(0.1); return (performance.now() - t0) / 100; })()`);
  ok(step < 8, `sim.step() with ${n} targets: ${step.toFixed(2)} ms per step`);
  console.log("errors:", p.errors.length ? p.errors : "none");
  ok(p.errors.length === 0, "no JS errors");
  p.close();
} finally { br.close(); }
console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
