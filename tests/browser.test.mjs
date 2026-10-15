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
  await p.eval(`(() => { const s = TT.sim; s.nextDep = s.nextArr = 1e9; for (let k = 0; k < 20; k++) { const d = s.spawnDeparture({ ga: false }); if (d && !d.ga) { window.dep = d; break; } if (d) s.putBack(d); } window.dep.callAt = s.t + 1; for (let i = 0; i < 25000 && !(window.dep.freq === "TWR" && window.dep.state === "holding"); i++) s.step(0.1); })()`);
  ok(await p.eval(`dep.freq === "TWR" && dep.state === "holding"`), "AI Delivery+Ground brought the departure to my Tower frequency");
  await p.eval(`TT.setActive("GND")`);
  ok(await p.waitFor(`/AI/.test(document.getElementById("log").innerText) && /taxi to holding point/.test(document.getElementById("log").innerText)`, 40000), "Ground tab shows the AI controller's taxi instruction");
  await p.eval(`TT.setActive("TWR")`);
  ok(await p.waitFor(`!!document.querySelector('#stripBoard .strip[data-id="' + dep.id + '"]')`, 5000), "departure strip is on the Tower board");
  // transmit from the main window on TWR (once the runway is free: a landing aircraft would get "confirm takeoff")
  await p.waitFor(`TT.sim.runwayFree(dep.depEnd.rwy, dep)`, 90000);
  await p.eval(`TT.transmit(dep.tel + " " + dep.num + " runway " + dep.depEnd.name + " cleared for takeoff")`);
  ok(await p.eval(`dep.state === "lineup" || dep.state === "lining" || dep.state === "roll"`), "takeoff clearance applied");
  await p.shot(join(OUT, "split-twr.png"));

  // ---- pop-out window (BroadcastChannel) ----
  const pop = await br.newPage("http://localhost:8780/?popout=GND&icao=EETN");
  ok(await pop.waitFor("window.TT && TT.state && TT.state.ac.length > 0", 15000), "pop-out receives the sim state " + (p.errors.join(" | ") || "") + (pop.errors.join(" | ") || ""));
  ok(await pop.waitFor(`document.getElementById("posHead").innerText.includes("EETN_GND")`), "pop-out shows the Ground position");
  const d2 = await p.eval(`(() => { const s = TT.sim; for (let k = 0; k < 20; k++) { const d = s.spawnDeparture({ ga: false }); if (d && !d.ga) { d.freq = "GND"; d.state = "push_req"; d.ifr = true; return d.tel + " " + d.num; } if (d) s.putBack(d); } })()`);
  await pop.eval(`document.getElementById("cmd").value = ${JSON.stringify(d2 + " push and start approved")}; document.getElementById("cmdForm").requestSubmit();`);
  ok(await p.waitFor(`TT.sim.ac.some(a => a.tel + " " + a.num === ${JSON.stringify(d2)} && a.state === "pushing")`, 5000), "transmission typed in the pop-out is applied by the main window");
  await sleep(600);
  await pop.shot(join(OUT, "popout-gnd.png"));
  ok(pop.errors.length === 0, "pop-out has no JS errors " + pop.errors.join(" | "));
  pop.close();
  await p.send("Page.bringToFront");          // a background tab gets no animation frames in headless Chrome

  // ---- Phase F: multiplayer over the relay — a remote controller claims Ground, transmits, chats, accepts a handoff; a tablet strip board ----
  await p.eval(`TT.settings.nick = "viktor"; TT.mp.host(false)`);
  ok(await p.waitFor("TT.mp.relay && TT.mp.relay.code && TT.mp.relay.id === 'host'", 10000), "hosting a session over the relay");
  const code = await p.eval("TT.mp.relay.code");
  const g = await br.newPage(`http://localhost:8780/?join=${code}&role=guest&name=liisa&icao=EETN`);
  await p.send("Page.bringToFront");          // the host simulation steps on animation frames: keep it in front
  ok(await g.waitFor("window.TT && TT.remote && TT.state && TT.state.ac.length > 0", 15000), "remote controller receives the host's state " + g.errors.join(" | "));
  await g.eval(`TT.radio.tts = false`);
  await g.eval(`document.querySelector('#posTabs .tab[data-pos="GND"]').click()`);
  ok(await p.waitFor(`TT.sim.remoteStaff.GND === "liisa" && TT.sim.userWorks("GND")`, 5000), "the guest claimed Ground: the host marks it as worked by liisa");
  ok(await g.waitFor(`TT.myPos === "GND" && !!document.querySelector('#posTabs .tab.mine[data-pos="GND"]')`, 5000), "the guest's window shows GND as its own position");
  ok(await p.eval(`!!document.querySelector('#posTabs .tab.remote[data-pos="GND"] .who')`), "the host's Ground tab shows who works it");
  const d4 = await p.eval(`(() => { const s = TT.sim; for (let k = 0; k < 20; k++) { const d = s.spawnDeparture({ ga: false }); if (d && !d.ga) { d.freq = "GND"; d.state = "push_req"; d.ifr = true; window.mpDep = d; return d.tel + " " + d.num; } if (d) s.putBack(d); } })()`);
  await g.eval(`document.getElementById("cmd").value = ${JSON.stringify(d4 + " push and start approved")}; document.getElementById("cmdForm").requestSubmit();`);
  ok(await p.waitFor(`mpDep.state === "pushing"`, 8000), "the guest's transmission on Ground is applied by the host");
  await g.eval(`document.getElementById("chatIn").value = "hello tower"; document.getElementById("chatForm").requestSubmit()`);
  ok(await p.waitFor(`TT.mp.chat.some(m => m.text === "hello tower" && m.name === "liisa")`, 5000), "chat from the guest reaches the host");
  ok(await g.waitFor(`document.getElementById("chatLog").innerText.includes("hello tower")`, 5000), "and is shown in the guest's chat");
  // a handoff Tower -> Ground: the guest's board shows the incoming strip and accepts it
  const d5 = await p.eval(`(() => { const s = TT.sim; for (let k = 0; k < 20; k++) { const d = s.spawnDeparture({ ga: false }); if (d && !d.ga) { d.freq = "TWR"; d.state = "holding"; d.depEnd = s.depEnd; d.onGround = true; window.hoDep = d; return d.tel + " " + d.num; } if (d) s.putBack(d); } })()`);
  await p.eval(`TT.transmit(${JSON.stringify(d5)} + " contact ground " + TT.positions.GND.freq, "TWR")`);
  ok(await p.waitFor(`hoDep.freq === "GND" && hoDep.handoff && !hoDep.handoff.accepted`, 15000), "the frequency change offers the strip to Ground (worked by the guest, so not auto-accepted)");
  ok(await g.waitFor(`!!document.querySelector('#stripBoard .strip.incoming [data-accept]')`, 8000), "the guest's board shows the incoming strip with ACCEPT");
  await g.eval(`(() => { const e = document.querySelector('#stripBoard .strip.incoming [data-accept]'); if (e) e.click(); })()`);
  ok(await p.waitFor(`hoDep.handoff.accepted && hoDep.handoff.by === "liisa"`, 5000), "the guest accepted the handoff");
  // a strip board on a tablet (role=board), then a kick
  const b = await br.newPage(`http://localhost:8780/?join=${code}&role=board&pos=GND&name=tablet&icao=EETN`);
  await p.send("Page.bringToFront");
  ok(await b.waitFor("window.TT && TT.state && document.body.classList.contains('board') && document.querySelectorAll('#stripBoard .strip').length > 0", 15000), "a strip board (tablet) shows Ground's strips " + b.errors.join(" | "));
  ok(await p.waitFor(`TT.mp.roster.some(r => r.name === "tablet" && r.role === "board")`, 5000), "the host's roster lists the board");
  await p.eval(`TT.mp.kick(TT.mp.roster.find(r => r.name === "tablet").id, false)`);
  ok(await p.waitFor(`!TT.mp.roster.some(r => r.name === "tablet")`, 5000), "the host kicked the board");
  ok(await b.waitFor(`document.getElementById("alerts").innerText.includes("removed")`, 5000), "the board was told it was removed");
  await g.shot(join(OUT, "mp-guest.png")); await b.shot(join(OUT, "mp-board.png"));
  ok(g.errors.length === 0 && b.errors.length === 0, "remote windows have no JS errors " + g.errors.join(" | ") + b.errors.join(" | "));
  await g.send("Page.navigate", { url: "about:blank" }); await b.send("Page.navigate", { url: "about:blank" });   // closing the CDP session alone leaves the tab open
  g.close(); b.close();
  ok(await p.waitFor(`!TT.mp.roster.some(r => r.name === "liisa")`, 8000), "the host learns the guest left");
  await p.eval(`TT.mp.stop()`);
  ok(await p.eval(`!TT.sim.remoteStaff.GND && !TT.mp.relay && !TT.sim.userWorks("GND")`), "stopping the session gives the claimed position back to the AI");
  // a single panel of a position in its own window
  const pp = await br.newPage("http://localhost:8780/?popout=TWR&panel=strips&icao=EETN");
  await p.send("Page.bringToFront");
  ok(await pp.waitFor("window.TT && TT.state && document.body.classList.contains('panel-only') && document.querySelectorAll('#stripBoard .strip').length > 0 && getComputedStyle(document.querySelector('.scope')).display === 'none'", 15000), "panel-only pop-out shows just the strips " + pp.errors.join(" | "));
  ok(pp.errors.length === 0, "panel pop-out has no JS errors");
  pp.close();
  await p.send("Page.bringToFront");
  // ---- F2: autocomplete on the command line (Tab accepts) ----
  await p.eval(`(() => { const c = document.getElementById("cmd"); c.value = ""; c.focus(); c.dispatchEvent(new Event("input", { bubbles: true })); })()`);
  ok(await p.waitFor(`!document.getElementById("suggest").classList.contains("hidden") && document.querySelectorAll("#suggest div").length > 0`, 3000), "an empty command line suggests the callsigns on my frequency");
  await p.eval(`document.getElementById("cmd").dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }))`);
  const accepted = await p.eval(`document.getElementById("cmd").value`);
  ok(/^[A-Za-z]/.test(accepted) && accepted.endsWith(" "), "Tab accepts the first suggestion: " + accepted);
  ok(await p.waitFor(`[...document.querySelectorAll("#suggest div")].some(d => /cleared|line up|taxi|push|hold|contact|next expected/i.test(d.innerText))`, 3000), "after the callsign the next instructions are offered");
  await p.eval(`document.getElementById("cmd").value = ""; document.getElementById("cmd").blur()`);

  // ---- Phase G: 3D tower view, charts, scenarios / career, replay, statistics, the setup wizard ----
  await p.eval(`TT.setView("3D")`); await sleep(600);
  ok(await p.eval(`TT.radar.view === "3D" && TT.radar.labelBoxes.length > 0`), "3D tower view draws aircraft labels (" + (await p.eval(`TT.radar.labelBoxes.length`)) + ")");
  await p.shot(join(OUT, "tower-3d.png"));
  await p.eval(`TT.setView("TWR")`);
  await p.eval(`document.getElementById("chartsBtn").click()`); await sleep(200);
  ok(await p.eval(`document.getElementById("chartsDialog").open && /Charts for EETN/.test(document.getElementById("chartsBody").innerText)`), "charts dialog opens with the chart links");
  await p.eval(`document.getElementById("chartsDialog").close()`);
  await p.eval(`document.getElementById("scenBtn").click()`); await sleep(200);
  ok(await p.eval(`document.getElementById("scenDialog").open && document.querySelectorAll("#scenBody .scen").length >= 8 && document.querySelectorAll("#scenBody .scen.locked").length >= 5`), "career path lists the scenarios with the higher levels locked");
  await p.eval(`document.querySelector('#scenTabs [data-tab="list"]').click(); document.getElementById("scenNew").click()`); await sleep(100);
  await p.eval(`document.querySelector('#scenForm [name="name"]').value = "Browser test"; document.querySelector('#scenForm [name="minutes"]').value = "5"; document.getElementById("scenForm").requestSubmit()`); await sleep(200);
  ok(await p.eval(`TT.scenarios.list().some(s => s.name === "Browser test" && s.user && s.minutes === 5)`), "a user scenario is saved from the editor");
  await p.eval(`document.getElementById("scenDialog").close(); TT.scenarios.start(TT.scenarios.list()[0])`);
  ok(await p.waitFor(`TT.scenarios.current && TT.scenarios.current.id === "del-first" && TT.sim.split && TT.sim.userWorks("DEL") && !TT.sim.userWorks("TWR")`, 15000), "the first career scenario starts with Delivery only");
  await p.eval(`(() => { for (let i = 0; i < 30; i++) { TT.sim.step(1); TT.recorder.tick(TT.sim, {}); } TT.sim.t += 15 * 60 + 5; })()`); await sleep(1500);
  ok(await p.waitFor(`!TT.scenarios.current && document.getElementById("debrief").open && /Passed|Not passed/.test(document.getElementById("debriefBody").innerText)`, 5000), "the scenario ends in the debrief with a result: " + (await p.eval(`(document.querySelector("#debriefBody .result") || {}).innerText || ""`)));
  ok(await p.eval(`JSON.parse(localStorage.getItem("tt.history") || "[]").length === 1 && !!JSON.parse(localStorage.getItem("tt.career") || "{}").last`), "the session went into the statistics and the career record");
  await p.eval(`document.getElementById("dbReplay").click()`); await sleep(800);
  ok(await p.eval(`TT.replay.on && !document.getElementById("replayBar").classList.contains("hidden") && +document.getElementById("rpPos").max >= 10`), "replay opens with a scrubber over the recorded frames (" + (await p.eval(`document.getElementById("rpPos").max`)) + ")");
  await p.eval(`document.getElementById("rpPos").value = "5"; document.getElementById("rpPos").dispatchEvent(new Event("input"))`); await sleep(400);
  ok(await p.eval(`TT.replay.i === 5 && /REPLAY/.test(document.getElementById("status").innerText)`), "scrubbing moves the replay");
  await p.eval(`document.getElementById("rpClose").click()`); await sleep(200);
  ok(await p.eval(`!TT.replay.on`), "replay closes and the simulation continues");
  await p.eval(`TT.applyStaffing("split", ["TWR"]); TT.app.setSpeed(1)`);
  const wz = await br.newPage("http://localhost:8780/setup");
  ok(await wz.waitFor(`document.getElementById("pyBody").innerText.includes("Python") && document.querySelectorAll("table.pk tr").length > 3 && !!document.getElementById("esIcao")`, 20000), "setup wizard page renders (Python, packages, EuroScope, X-Plane) " + wz.errors.join(" | "));
  await wz.eval(`document.getElementById("dry").checked = true; document.getElementById("esGen").click()`);
  ok(await wz.waitFor(`/DRY RUN/.test(document.getElementById("esOut").innerText) && /TowerTrainer_/.test(document.getElementById("esOut").innerText)`, 10000), "wizard dry run lists the sector files it would generate");
  ok(wz.errors.length === 0, "wizard page has no JS errors " + wz.errors.join(" | "));
  await wz.send("Page.navigate", { url: "about:blank" }); wz.close();
  await p.send("Page.bringToFront");

  // ---- Delivery view, plain-language labels, info panel, light signals, voice status ----
  await p.eval(`TT.setView("DEL")`); await sleep(500);
  ok(await p.eval(`!document.getElementById("delPanel").classList.contains("hidden") && document.querySelectorAll("#viewTabs button").length === 6`), "Delivery view tab shows the clearance panel (six view tabs incl. Tower 3D)");
  await p.eval(`(() => { TT.app.setSpeed(0); const s = TT.sim; for (let k = 0; k < 20; k++) { const d = s.spawnDeparture({ ga: false }); if (d && !d.ga) { d.callAt = s.t + 1; window.delAc = d; break; } if (d) s.putBack(d); } for (let i = 0; i < 25; i++) s.step(0.1); })()`);
  await p.waitFor(`/squawk [0-9]{4}/.test(document.getElementById("clrList").innerText)`, 5000);
  ok(await p.eval(`/squawk [0-9]{4}/.test(document.getElementById("clrList").innerText) && /climb [0-9]{4} ft/.test(document.getElementById("clrList").innerText)`), "clearance list shows SID/climb/next squawk suggestions: " + (await p.eval(`JSON.stringify({ st: delAc.state, ga: delAc.ga, kind: delAc.kind, lc: delAc.lastCall, t: TT.sim.t, n: TT.sim.ac.length, view: TT.radar.view })`)) + " " + (await p.eval(`document.getElementById("clrList").innerText.split("\\n").slice(0, 2).join(" | ")`)));
  await p.eval(`TT.select(delAc.id)`); await sleep(300);
  ok(await p.eval(`!document.getElementById("acInfo").classList.contains("hidden") && /LIGHT GUN/i.test(document.getElementById("acInfo").innerText) && /NEXT EXPECTED/i.test(document.getElementById("acInfo").innerText)`), "aircraft info panel opens on select with light-gun buttons and the next expected call");
  ok(await p.eval(`(() => { const b = TT.radar.labelBoxes; for (let i = 0; i < b.length; i++) for (let j = i + 1; j < b.length; j++) { const p = b[i], q = b[j]; if (p.x < q.x + q.w && p.x + p.w > q.x && p.y < q.y + q.h && p.y + p.h > q.y) return false; } return b.length > 0; })()`), "no two data blocks overlap on the Delivery picture");
  ok(await p.eval(`[...document.querySelectorAll("#stripBoard .strip .st")].every(e => !/^(CLRD|PUSH REQ|VACATED|LUW)$/.test(e.innerText.trim()))`), "strips use plain-language state text");
  await p.eval(`TT.sim.triggerEvent("7600", delAc)`); await sleep(300);
  await p.eval(`document.querySelector('#acInfo [data-cmd="light green flashing"]').click()`); await sleep(300);
  ok(await p.eval(`TT.sim.lightLog.length > 0 && TT.sim.lightLog[TT.sim.lightLog.length - 1].cs === delAc.cs && delAc.nordo && (delAc.state === "pushing" || delAc.state === "taxi")`), "light-gun button on a 7600 aircraft: logged as an action and the aircraft complies (" + (await p.eval(`delAc.state`)) + ")");
  await p.eval(`TT.app.setSpeed(1)`);
  const vst = await p.eval(`fetch("/api/tts/status").then(r => r.json())`);
  ok(await p.eval(`document.getElementById("voicePill").innerText.startsWith("Voices:")`) && (vst.neural ? await p.eval(`document.getElementById("voiceBanner").classList.contains("hidden") || /Neural voices ready/.test(document.getElementById("voiceBanner").innerText)`) : await p.eval(`!document.getElementById("voiceBanner").classList.contains("hidden")`)), `voice banner/pill match the server (neural=${vst.neural})`);
  await p.eval(`TT.setView("GND")`);

  // ---- radio chain measured offline (OfflineAudioContext), ATIS text ----
  const st = await p.eval(`TT.radio.selfTest(0.85, "good")`);
  ok(st && st.worklet, "radio worklet loads in an OfflineAudioContext");
  ok(st.lowRatio > 4 && st.highRatio > 4, `band-pass: 1 kHz passes, 150 Hz and 6 kHz are cut (ratios ${st.lowRatio.toFixed(1)}, ${st.highRatio.toFixed(1)})`);
  ok(st.floor > 0.002 && st.floor < st.mid, `AM noise floor under the carrier, below the voice (${st.floor.toFixed(4)} vs ${st.mid.toFixed(3)})`);
  ok(st.tail > st.after * 3 && st.after < 0.003, `squelch tail then silence (tail ${st.tail.toFixed(4)}, after ${st.after.toFixed(5)})`);
  const stClean = await p.eval(`TT.radio.selfTest(0, "clean")`);
  ok(stClean.lowRatio < 2 && stClean.floor < 0.0005, "clean preset: no band limiting, no noise");
  ok(await p.eval(`/information [A-Z][a-z]+/.test(TT.app.atisText()) && /Runway in use/.test(TT.app.atisText())`), "ATIS text generated from the METAR: " + (await p.eval(`TT.app.atisText().slice(0, 90)`)));
  ok(await p.eval(`document.getElementById("atisListen") && document.getElementById("wxPanel").innerText.includes("ATIS")`), "ATIS listen button and weather panel present");

  // ---- Phase D: sequence panel, LVP & stop bars, weather scenario, checklist, runway inspection ----
  await p.eval(`TT.app.setSpeed(0)`);
  await p.eval(`(() => { const s = TT.sim; for (let k = 0; k < 20; k++) { const d = s.spawnDeparture({ ga: false }); if (d && !d.ga) { d.state = "holding"; d.depEnd = s.depEnd; d.holdAt = s.t; d.onGround = true; d.ctot = s.t + 900; d.freq = "TWR"; window.seqDep = d; break; } if (d) s.putBack(d); } })()`);
  ok(await p.waitFor(`!document.getElementById("seqPanel").classList.contains("hidden") && document.getElementById("seqPanel").innerText.includes(seqDep.cs) && /CTOT/.test(document.getElementById("seqPanel").innerText)`, 3000), "departure sequence panel lists the holding departure with its CTOT");
  await p.eval(`(() => { const el = document.getElementById("setLvp"); el.checked = true; el.dispatchEvent(new Event("change", { bubbles: true })); })()`);
  ok(await p.eval(`TT.sim.lvp && TT.apt.stopBars.length > 0 && TT.apt.stopBars.every(b => b.lit) && /low visibility/i.test(TT.app.atisText())`), "LVP switch: stop bars lit, ATIS says low visibility procedures (" + (await p.eval(`TT.apt.stopBars.length`)) + " bars)");
  // click a stop bar on the radar to switch it off
  await p.eval(`(() => { const b = TT.apt.stopBars[0]; TT.radar.cx = b.p[0]; TT.radar.cy = b.p[1]; TT.radar.staticKey = null; })()`); await sleep(150);
  await p.eval(`(() => { const b = TT.apt.stopBars[0]; const s = TT.radar.toScreen(b.p); const c = document.getElementById("radar"); const r = c.getBoundingClientRect();
    const ev = (t) => new MouseEvent(t, { bubbles: true, clientX: r.left + s[0], clientY: r.top + s[1], button: 0 }); c.dispatchEvent(ev("mousedown")); c.dispatchEvent(ev("mouseup")); })()`);
  ok(await p.eval(`!TT.apt.stopBars[0].lit && TT.apt.stopBars[0].manual`), "clicking a stop bar on the radar toggles it (manual override)");
  await p.eval(`(() => { const el = document.getElementById("setLvp"); el.checked = false; el.dispatchEvent(new Event("change", { bubbles: true })); })()`);
  await p.eval(`(() => { const el = document.getElementById("setWx"); el.value = "fog"; el.dispatchEvent(new Event("change", { bubbles: true })); })()`);
  ok(await p.eval(`TT.sim.wxScenario && TT.sim.wxScenario.name === "fog" && /BR|FG/.test(document.getElementById("atisBox").innerText)`), "weather scenario: synthetic METAR shown in the ATIS box: " + (await p.eval(`document.getElementById("atisBox").innerText.replace(/\\s+/g, " ").slice(0, 80)`)));
  await p.eval(`(() => { const s = TT.sim; s.t += 11 * 60; s.wxTick(); })()`);
  ok(await p.eval(`TT.sim.lvp && !TT.sim.lvpManual`), "fog scenario brings LVP after ten minutes");
  await p.eval(`(() => { const el = document.getElementById("setWx"); el.value = "live"; el.dispatchEvent(new Event("change", { bubbles: true })); })()`);
  ok(await p.eval(`!TT.sim.wxScenario`), "back to the live METAR");
  await p.eval(`(() => { const s = TT.sim; const e = s.arrEnd; const others = s.ac.filter(a => a.kind === "arr" && !a.onGround); others.forEach(a => a.onGround = true);
    for (let k = 0; k < 20; k++) { const a = s.spawnArrival(); if (a && !a.ga) { a.pos = [e.thr[0] - e.v[0] * 9 * 1852, e.thr[1] - e.v[1] * 9 * 1852]; a.alt = 3000; window.evArr = a; break; } if (a) s.ac.splice(s.ac.indexOf(a), 1); }
    others.forEach(a => a.onGround = false); s.abnormalEvent("pan"); })()`);
  ok(await p.waitFor(`!document.getElementById("checkPanel").classList.contains("hidden") && /PAN/.test(document.getElementById("checkPanel").innerText)`, 3000), "PAN PAN opens the checklist panel");
  await p.eval(`document.getElementById("checkClose").click()`);
  ok(await p.eval(`document.getElementById("checkPanel").classList.contains("hidden")`), "checklist panel closes");
  await p.eval(`TT.sim.runwayInspection(TT.sim.depEnd.rwy, "routine")`);
  ok(await p.eval(`TT.sim.closedRunways.size === 1 && TT.sim.ac.some(a => a.veh && a.vtype === "ops" && a.task) && /CLOSED/.test(document.getElementById("wxPanel").innerText)`), "runway inspection closes the runway (Ops dispatched, weather panel shows CLOSED)");
  await p.eval(`(() => { const s = TT.sim; for (const v of s.ac.filter(a => a.veh && a.task)) { v.task = null; v.gone = true; } s.closedRunways.clear(); if (window.evArr) evArr.gone = true; if (window.seqDep) seqDep.gone = true; })()`);
  ok(await p.eval(`["setWx", "setLvp", "setRecat", "setVfr", "setAbnormals", "setAbnormalRate", "setSeq"].every(id => document.getElementById(id)) && document.querySelectorAll("[data-ev]").length >= 12`), "operations & weather settings and event buttons present");
  await p.eval(`TT.app.setSpeed(1)`);

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
