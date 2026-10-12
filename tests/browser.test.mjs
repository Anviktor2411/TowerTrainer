// Headless-browser tests of the real page: split positions with AI controllers, pop-out window over
// BroadcastChannel, settings/debrief dialogs, and a full run of the interactive guide.
//   node tests/browser.test.mjs [outDir]      (server.py must be running on :8780)
import { launch, sleep } from "./cdp.mjs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const OUT = process.argv[2] || join(tmpdir(), "tt-browser");
const URL0 = "http://localhost:8780/?icao=EETN";
let fails = 0;
const ok = (c, m) => { console.log((c ? "PASS  " : "FAIL  ") + m); if (!c) fails++; };

const br = await launch({ port: 9335 });
try {
  const p = await br.newPage("about:blank");
  await p.eval(`localStorage.clear()`).catch(() => {});
  await p.send("Page.navigate", { url: URL0 });
  ok(await p.waitFor("window.TT && TT.sim && TT.apt && TT.apt.icao === 'EETN'"), "page loads EETN");
  await p.eval(`TT.radio.tts = false; TT.settings.voices = false`);

  // ---- split staffing: I work Tower, AI works the rest ----
  await p.eval(`TT.applyStaffing("split", ["TWR"])`);
  ok(await p.eval(`TT.sim.split && TT.sim.userWorks("TWR") && !TT.sim.userWorks("GND")`), "split staffing: TWR is mine, GND is AI");
  ok(await p.eval(`document.querySelectorAll("#posTabs .tab").length === 5 && !!document.querySelector('#posTabs .tab.ai[data-pos="GND"]')`), "five position tabs, AI ones marked");
  await p.eval(`(() => { const s = TT.sim; s.nextDep = s.nextArr = 1e9; for (let k = 0; k < 20; k++) { const d = s.spawnDeparture(); if (d && !d.ga) { window.dep = d; break; } } window.dep.callAt = s.t + 1; for (let i = 0; i < 25000 && !(window.dep.freq === "TWR" && window.dep.state === "holding"); i++) s.step(0.1); })()`);
  ok(await p.eval(`dep.freq === "TWR" && dep.state === "holding"`), "AI Delivery+Ground brought the departure to my Tower frequency");
  await p.eval(`TT.setActive("GND")`);
  ok(await p.waitFor(`/AI/.test(document.getElementById("log").innerText) && /taxi to holding point/.test(document.getElementById("log").innerText)`, 40000), "Ground tab shows the AI controller's taxi instruction");
  await p.eval(`TT.setActive("TWR")`); await sleep(400);
  ok(await p.eval(`!!document.querySelector('#stripBoard .strip[data-id="' + dep.id + '"]')`), "departure strip is on the Tower board");
  // transmit from the main window on TWR
  await p.eval(`TT.transmit(dep.tel + " " + dep.num + " runway " + dep.depEnd.name + " cleared for takeoff")`);
  ok(await p.eval(`dep.state === "lineup" || dep.state === "lining" || dep.state === "roll"`), "takeoff clearance applied");
  await p.shot(join(OUT, "split-twr.png"));

  // ---- pop-out window (BroadcastChannel) ----
  const pop = await br.newPage("http://localhost:8780/?popout=GND&icao=EETN");
  ok(await pop.waitFor("window.TT && TT.state && TT.state.ac.length > 0", 15000), "pop-out receives the sim state");
  ok(await pop.waitFor(`document.getElementById("posHead").innerText.includes("EETN_GND")`), "pop-out shows the Ground position");
  const d2 = await p.eval(`(() => { const s = TT.sim; for (let k = 0; k < 20; k++) { const d = s.spawnDeparture(); if (d && !d.ga) { d.freq = "GND"; d.state = "push_req"; d.ifr = true; return d.tel + " " + d.num; } } })()`);
  await pop.eval(`document.getElementById("cmd").value = ${JSON.stringify(d2 + " push and start approved")}; document.getElementById("cmdForm").requestSubmit();`);
  ok(await p.waitFor(`TT.sim.ac.some(a => a.tel + " " + a.num === ${JSON.stringify(d2)} && a.state === "pushing")`, 5000), "transmission typed in the pop-out is applied by the main window");
  await sleep(600);
  await pop.shot(join(OUT, "popout-gnd.png"));
  ok(pop.errors.length === 0, "pop-out has no JS errors " + pop.errors.join(" | "));
  pop.close();

  // ---- dialogs ----
  await p.click("#settingsBtn"); await sleep(300);
  ok(await p.eval(`document.getElementById("settings").open && document.querySelectorAll("#voiceTable tr").length > 10`), "settings dialog with voice table");
  await p.shot(join(OUT, "settings.png"));
  await p.eval(`document.getElementById("settings").close()`);
  await p.click("#debriefBtn"); await sleep(200);
  ok(await p.eval(`document.getElementById("debrief").open && /Departures/.test(document.getElementById("debriefBody").innerText)`), "debrief dialog");
  await p.eval(`document.getElementById("debrief").close()`);

  // ---- guide: run every step like a trainee ----
  await p.eval(`TT.applyStaffing("combined", ["TWR"])`);
  await p.eval(`TT.guide.start()`);
  const steps = await p.eval(`TT.guide.steps.length`);
  let reached = 0;
  for (let n = 0; n < steps; n++) {
    const id = await p.eval(`TT.guide.step().id`);
    const hasDone = await p.eval(`!!TT.guide.step().done`);
    if (hasDone) {
      // perform the step
      for (let tries = 0; tries < 400 && !(await p.eval(`TT.guide.isDone()`)); tries++) {
        await p.eval(`(() => {
          const g = TT.guide, s = g.step(), app = TT.app;
          if (s.id === "runway") { const sel = document.getElementById("rwySel"); sel.value = app.bestRunway(); sel.dispatchEvent(new Event("change")); return; }
          if (s.id === "squawk") { document.getElementById("assignSq").click(); return; }
          const sim = TT.sim;
          // let the sim run (the guide pauses it between steps)
          if (s.done({ app })) return;   // done: wait for the guide to notice, don't run the sim on
          if (s.id !== "readback") for (let i = 0; i < 40; i++) sim.step(0.1);
          const ph = s.phrase ? s.phrase({ app }) : "";
          const need = { clearance: () => app.guideDep.state === "clr_req", readback: () => app.guideDep.rbError && !app.guideDep.rbError.fixed,
            push: () => app.guideDep.state === "push_req", taxi: () => app.guideDep.state === "taxi_req",
            cross: () => app.guideDep.atStop && app.guideDep.blockedRwy != null && app.guideDep.blockedRwy !== app.guideDep.depEnd.rwy,
            lineup: () => app.guideDep.state === "holding", takeoff: () => ["lined_up", "lining", "lineup"].includes(app.guideDep.state),
            handoff: () => app.guideDep.state === "airborne" && app.guideDep.alt > 600, landing: () => app.guideArr && app.guideArr.calledIn,
            taxiin: () => app.guideArr && ["vacated", "holding_short"].includes(app.guideArr.state) };
          if (ph && (!need[s.id] || need[s.id]())) { TT.transmit(ph); }
        })()`);
        await sleep(30);
      }
    }
    if (await p.eval(`TT.guide.isDone()`) || !hasDone) reached++;
    else console.log("   step not completed: " + id + " " + await p.eval(`JSON.stringify({ dep: TT.app.guideDep && TT.app.guideDep.state, rb: TT.app.guideDep && TT.app.guideDep.rbError && { l: TT.app.guideDep.rbError.label, r: TT.app.guideDep.rbError.right, w: TT.app.guideDep.rbError.wrong, f: TT.app.guideDep.rbError.fixed, m: TT.app.guideDep.rbError.missed }, stats: TT.sim.stats.rbErrors, log: document.getElementById("log").innerText.split("\\n").slice(-6) })`));
    if (id === "readback") await p.shot(join(OUT, "guide-readback.png"));
    if (n < steps - 1) await p.eval(`TT.guide.next()`);
  }
  ok(reached === steps, `guide: ${reached}/${steps} steps completed`);
  ok(await p.eval(`TT.sim.stats.rbErrors >= 1 && TT.sim.stats.rbCaught >= 1`), "guide planted a readback error and it was caught");
  await p.eval(`TT.guide.next()`); // finish -> debrief
  ok(await p.eval(`document.getElementById("debrief").open`), "guide ends with the debrief");
  ok(p.errors.length === 0, "main window has no JS errors " + p.errors.join(" | "));
  p.close();
} finally {
  br.close();
}
console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
