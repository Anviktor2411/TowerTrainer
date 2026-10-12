// Drive the real page in headless Chrome: load an airport, run traffic, issue commands, screenshot.
//   node tests/ui.mjs [ICAO] [outDir]   (server must be running on :8780)
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const icao = process.argv[2] || "EETN";
const out = process.argv[3] || join(tmpdir(), "tt-ui");
mkdirSync(out, { recursive: true });
const CHROME = ["C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"].find(existsSync);
const port = 9333;
const prof = join(tmpdir(), "tt-chrome-prof");
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`,
  "--window-size=1600,900", "--autoplay-policy=no-user-gesture-required", "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let ws, id = 0;
const pending = new Map(), errors = [];
async function connect() {
  for (let i = 0; i < 50; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const page = list.find(t => t.type === "page");
      if (page) { ws = new WebSocket(page.webSocketDebuggerUrl); break; }
    } catch { /* not up yet */ }
    await sleep(200);
  }
  await new Promise(r => ws.addEventListener("open", r));
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") errors.push(m.params.args.map(a => a.value ?? a.description).join(" "));
  });
}
const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => { const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }); return r.result?.result?.value; };
const shot = async (name) => { const r = await send("Page.captureScreenshot", { format: "png" }); writeFileSync(join(out, name), Buffer.from(r.result.data, "base64")); console.log("screenshot", join(out, name)); };

try {
  await connect();
  await send("Runtime.enable"); await send("Page.enable");
  await send("Page.navigate", { url: `http://localhost:8780/?icao=${icao}` });
  for (let i = 0; i < 100 && !(await ev("!!(window.TT && TT.sim)")); i++) await sleep(200);
  await ev(`document.getElementById("tts").click()`); // silence TTS in headless
  console.log("loaded:", await ev(`TT.apt.icao + " rwy " + TT.sim.depEnd.name + " | " + document.getElementById("aptName").textContent`));
  console.log("log:", await ev(`document.getElementById("log").innerText`));
  // speed things up and spawn traffic
  await ev(`(() => { const s = TT.sim; s.spawnDeparture(); s.spawnDeparture(); s.spawnArrival(); for (let i = 0; i < 300; i++) s.step(0.1); })()`);
  await sleep(1500);
  const dep = await ev(`(() => { const d = TT.sim.ac.find(a => a.kind === "dep" && !a.ga); return d && d.cs; })()`);
  if (dep) {
    await ev(`TT.transmit("${dep} cleared to " + TT.sim.ac.find(a => a.cs === "${dep}").other[1] + ", climb 4000 feet, squawk 4521")`);
    await ev(`(() => { for (let i = 0; i < 700; i++) TT.sim.step(0.1); })()`);
    await ev(`TT.transmit("${dep} push and start approved")`);
    await ev(`(() => { for (let i = 0; i < 1500 && TT.sim.ac.find(a => a.cs === "${dep}").state !== "taxi_req"; i++) TT.sim.step(0.1); })()`);
    await ev(`TT.transmit("${dep} taxi holding point runway " + TT.sim.depEnd.name)`);
    await ev(`(() => { for (let i = 0; i < 900; i++) TT.sim.step(0.1); })()`);
    // select it so its route is drawn
    await ev(`document.querySelector('.strip[data-id="' + TT.sim.ac.find(a => a.cs === "${dep}").id + '"]')?.click()`);
  }
  await sleep(4000); // let radio queue drain & redraw
  await shot(`${icao}-overview.png`);
  // zoom in on the selected aircraft
  await ev(`(() => { const d = TT.sim.ac.find(a => a.cs === "${dep}"); const r = window.__radar; })()`);
  console.log("strips:", await ev(`[...document.querySelectorAll(".strip")].map(s => s.innerText.replace(/\\s+/g, " ")).join(" || ")`));
  console.log("radio:", await ev(`document.getElementById("log").innerText.split("\\n").slice(-12).join("\\n")`));
  console.log("errors:", errors.length ? errors : "none");
} finally {
  try { ws?.close(); } catch { /* ignore */ }
  chrome.kill();
}
