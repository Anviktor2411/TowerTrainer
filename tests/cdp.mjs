// Tiny Chrome DevTools Protocol helper for headless browser tests.
import { spawn } from "node:child_process";
import { existsSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// TT_BROWSER=edge (or a path to a Chromium-based browser) runs the same tests in another browser.
const PICK = process.env.TT_BROWSER || "";
const CHROME = (PICK === "edge" ? ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"]
  : PICK ? [PICK] : ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"]).find(existsSync);

export async function launch({ port = 9334, width = 1600, height = 900 } = {}) {
  const prof = join(tmpdir(), `tt-cdp-${port}`);
  try { rmSync(prof, { recursive: true, force: true }); } catch { /* */ }
  const proc = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`,
    `--window-size=${width},${height}`, "--autoplay-policy=no-user-gesture-required", "--disable-popup-blocking", "about:blank"], { stdio: "ignore" });
  for (let i = 0; i < 60; i++) {
    try { await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); break; } catch { await sleep(200); }
  }
  const browser = {
    proc, port,
    async newPage(url) {
      const t = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: "PUT" })).json();
      return Page.connect(t.webSocketDebuggerUrl);
    },
    async pages() { return (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).filter(t => t.type === "page"); },
    close() { proc.kill(); },
  };
  return browser;
}

export class Page {
  static async connect(wsUrl) {
    const p = new Page();
    p.ws = new WebSocket(wsUrl); p.id = 0; p.pending = new Map(); p.errors = []; p.console = [];
    await new Promise(r => p.ws.addEventListener("open", r));
    p.ws.addEventListener("message", (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && p.pending.has(m.id)) { p.pending.get(m.id)(m); p.pending.delete(m.id); }
      if (m.method === "Runtime.exceptionThrown") p.errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
      if (m.method === "Runtime.consoleAPICalled") {
        const txt = m.params.args.map(a => a.value ?? a.description).join(" ");
        p.console.push(txt); if (m.params.type === "error") p.errors.push(txt);
      }
    });
    await p.send("Runtime.enable"); await p.send("Page.enable");
    return p;
  }
  send(method, params = {}) { return new Promise(r => { const i = ++this.id; this.pending.set(i, r); this.ws.send(JSON.stringify({ id: i, method, params })); }); }
  async eval(expr) {
    const r = await this.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) throw new Error("eval failed: " + (r.result.exceptionDetails.exception?.description || expr));
    return r.result?.result?.value;
  }
  async waitFor(expr, ms = 15000) {
    const end = Date.now() + ms;
    while (Date.now() < end) { try { if (await this.eval(expr)) return true; } catch { /* page loading */ } await sleep(150); }
    return false;
  }
  async shot(path) { const r = await this.send("Page.captureScreenshot", { format: "png" }); mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, Buffer.from(r.result.data, "base64")); }
  async click(sel) { return this.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.click(); return true; })()`); }
  close() { try { this.ws.close(); } catch { /* */ } }
}
