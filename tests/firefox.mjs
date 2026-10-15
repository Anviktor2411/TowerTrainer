// Firefox smoke test over WebDriver BiDi (Firefox's own remote protocol, no extra packages): the real page,
// split positions, strips, autocomplete, the layout dialog, a hosted session with a second Firefox window
// joining as a remote controller, and no console errors anywhere.
//   node tests/firefox.mjs      (server.py must be running on :8780; Firefox in Program Files)
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const FF = ["C:/Program Files/Mozilla Firefox/firefox.exe", "C:/Program Files (x86)/Mozilla Firefox/firefox.exe", "/usr/bin/firefox", "/Applications/Firefox.app/Contents/MacOS/firefox"].find(existsSync);
if (!FF) { console.log("SKIP  Firefox not installed"); process.exit(0); }
let fails = 0;
const ok = (c, m) => { console.log((c ? "PASS  " : "FAIL  ") + m); if (!c) fails++; };

const port = 9400;
const prof = join(tmpdir(), "tt-ff-bidi");
rmSync(prof, { recursive: true, force: true }); mkdirSync(prof, { recursive: true });
writeFileSync(join(prof, "user.js"), 'user_pref("media.navigator.permission.disabled", true);\nuser_pref("dom.disable_open_during_load", false);\n');
const proc = spawn(FF, ["--headless", "--no-remote", "--profile", prof, "--remote-debugging-port", String(port), "--window-size=1400,900", "about:blank"], { stdio: "ignore" });

let ws = null;
for (let i = 0; i < 100 && !ws; i++) {
  try { const w = new WebSocket(`ws://127.0.0.1:${port}/session`); await new Promise((res, rej) => { w.onopen = res; w.onerror = rej; }); ws = w; } catch { await sleep(300); }
}
if (!ws) { console.log("FAIL  Firefox did not open its remote port"); proc.kill(); process.exit(1); }
let id = 0; const pending = new Map(); const logs = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id != null && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  else if (m.method === "log.entryAdded") logs.push(m.params);
};
const send = (method, params) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ctxOf = async (r) => (r.result && r.result.context) || (r.result && r.result.contexts && r.result.contexts[0].context);

try {
  await send("session.new", { capabilities: {} });
  await send("session.subscribe", { events: ["log.entryAdded"] });
  const main = await ctxOf(await send("browsingContext.getTree", {}));
  const evalIn = async (ctx, expression) => {
    const r = await send("script.evaluate", { expression, target: { context: ctx }, awaitPromise: true, resultOwnership: "none" });
    if (r.result && r.result.type === "exception") throw new Error(r.result.exceptionDetails.text);
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  const waitFor = async (ctx, expr, ms = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await evalIn(ctx, expr) === true) return true; } catch { /* page still loading */ } await sleep(250); } return false; };
  const nav = (ctx, url) => send("browsingContext.navigate", { context: ctx, url, wait: "complete" });

  await nav(main, "http://localhost:8780/?icao=EETN");
  ok(await waitFor(main, "!!(window.TT && TT.sim && TT.apt && TT.apt.icao === 'EETN')", 40000), "Firefox: page loads EETN");
  await evalIn(main, "TT.radio.tts = false; TT.settings.voices = false; TT.applyStaffing('split', ['TWR']); true");
  ok(await evalIn(main, "TT.sim.split && document.querySelectorAll('#posTabs .tab').length === 5"), "Firefox: split positions with five tabs");
  // bring one departure through AI Delivery and Ground to my Tower frequency (as the Chrome suite does)
  const freq = await evalIn(main, "(() => { const s = TT.sim; s.nextDep = s.nextArr = 1e9; for (let k = 0; k < 20; k++) { const d = s.spawnDeparture({ ga: false }); if (d && !d.ga) { window.dep = d; break; } if (d) s.putBack(d); } window.dep.callAt = s.t + 1; for (let i = 0; i < 25000 && !(window.dep.freq === 'TWR' && window.dep.state === 'holding'); i++) s.step(0.1); return window.dep.freq; })()");
  ok(freq === "TWR", "Firefox: AI Delivery and Ground brought a departure to my Tower frequency (" + freq + ")");
  ok(await waitFor(main, "!!document.querySelector('#stripBoard .strip[data-id=\"' + dep.id + '\"]')", 20000), "Firefox: its strip renders on the Tower board");
  await evalIn(main, "(() => { const c = document.getElementById('cmd'); c.value = ''; c.focus(); c.dispatchEvent(new Event('input', { bubbles: true })); return true; })()");
  ok(await waitFor(main, "!document.getElementById('suggest').classList.contains('hidden') && document.querySelectorAll('#suggest div').length > 0", 5000), "Firefox: command-line suggestions");
  await evalIn(main, "document.getElementById('cmd').blur(); document.getElementById('layoutBtn').click(); true");
  ok(await evalIn(main, "document.getElementById('layoutDialog').open && document.querySelectorAll('#layoutBody [data-layout]').length >= 3 && !('getScreenDetails' in window)"), "Firefox: layout dialog opens (no Window Management API here, saved positions are used)");
  await evalIn(main, "document.getElementById('layoutDialog').close(); true");
  ok(await evalIn(main, "(() => { const w = window.open('/?popout=GND&panel=strips&icao=EETN', 'tt-GND:strips', 'width=600,height=500'); return !!w; })()"), "Firefox: a panel pop-out window opens");
  // a hosted session and a second window that joins it as a remote controller
  await evalIn(main, "TT.settings.nick = 'viktor'; TT.mp.host(false); true");
  ok(await waitFor(main, "!!(TT.mp.relay && TT.mp.relay.code && TT.mp.relay.id === 'host')", 10000), "Firefox: hosts a session over the relay");
  const code = await evalIn(main, "TT.mp.relay.code");
  const guest = await ctxOf(await send("browsingContext.create", { type: "tab" }));
  await nav(guest, `http://localhost:8780/?join=${code}&role=guest&name=ffguest&icao=EETN`);
  ok(await waitFor(guest, "!!(window.TT && TT.remote && TT.state && TT.state.ac.length > 0)", 20000), "Firefox: the guest window receives the state");
  await evalIn(guest, "TT.radio.tts = false; const t = document.querySelector('#posTabs .tab[data-pos=\"GND\"]'); if (t) t.click(); true");
  ok(await waitFor(main, "TT.sim.remoteStaff.GND === 'ffguest'", 8000), "Firefox: the guest claimed Ground");
  ok(await waitFor(guest, "TT.myPos === 'GND'", 8000), "Firefox: the guest window knows its position");
  await evalIn(guest, "document.getElementById('chatIn').value = 'tere'; document.getElementById('chatForm').requestSubmit(); true");
  ok(await waitFor(main, "TT.mp.chat.some(m => m.text === 'tere')", 8000), "Firefox: chat reaches the host");
  await send("browsingContext.close", { context: guest });
  ok(await waitFor(main, "!TT.mp.roster.some(r => r.name === 'ffguest')", 8000), "Firefox: the host sees the guest leave");
  await evalIn(main, "TT.mp.stop(); true");
  await sleep(1000);
  const errors = logs.filter(l => l.level === "error" && !/favicon/.test(l.text || ""));
  ok(errors.length === 0, "Firefox: no console errors " + errors.map(e => `[${e.type}] ${e.text}`).join(" | "));
} catch (e) {
  ok(false, "Firefox test crashed: " + e.message);
} finally {
  try { ws.close(); } catch { /* */ }
  proc.kill();
}
console.log(fails ? `${fails} FAILED` : "ALL PASSED");
process.exit(fails ? 1 : 0);
