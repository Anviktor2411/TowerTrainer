// Tower Trainer UI. Runs as the main window (owns the simulation) or as a pop-out position window
// (?popout=GND) that renders state received over BroadcastChannel and sends transmissions back.
import { Airport } from "./airport.js";
import { Sim } from "./sim.js";
import { Radio } from "./radio.js";
import { Radar, VIEWS } from "./render.js";
import { parse } from "./commands.js";
import { buildPositions, fmtFreq } from "./positions.js";
import { renderStrips } from "./strips.js";
import { coach, coachHints } from "./coach.js";
import { Bridges } from "./bridges.js";
import { Guide } from "./guide.js";
import { NAT_NAME } from "./data.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};
const params = new URLSearchParams(location.search);
const POPOUT = params.get("popout");
const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("towertrainer") : null;
const POS_ORDER = ["DEL", "GND", "TWR", "APP", "CTR"];
const DEFAULT_VIEW = { ALL: "GND", DEL: "GND", GND: "GND", TWR: "TWR", APP: "APP", CTR: "CTR" };

const DEFAULTS = {
  accents: "natural", rate: 1, effect: 0.6, voices: true, blocked: true, rbErr: 4, sayAgain: 2, oldAtis: 10, events: false,
  dep: 10, arr: 8, coach: false, lang: "en", graph: false,
  staff: { mode: "combined", keys: ["TWR"] },
  xr: { enabled: false, host: "127.0.0.1", port: 49100, password: "", cs: "", freq: "", ai: true, humans: true, text: true, voice: false },
};

const radar = new Radar($("radar"));

if (POPOUT) bootPopout(); else bootMain();

// =====================================================================================
//  MAIN WINDOW
// =====================================================================================
function bootMain() {
  const settings = { ...DEFAULTS, ...store.get("tt.settings", {}) };
  settings.staff = { ...DEFAULTS.staff, ...(settings.staff || {}) };
  settings.xr = { ...DEFAULTS.xr, ...(settings.xr || {}) };
  const save = () => store.set("tt.settings", settings);
  const radio = new Radio();
  let sim = null, apt = null, positions = null, metar = null, speed = 1, selectedId = null;
  let activePos = "ALL";
  const logs = {};                 // pos -> [{cls, html}]
  const unread = {};
  const coachLog = [];
  const coachStats = {};           // pos -> {tx, warn}
  let guideRestore = null;
  const app = {};                  // API used by the guide

  const applyRadioSettings = () => {
    Object.assign(radio, { accents: settings.accents, rate: +settings.rate, effect: +settings.effect, tts: settings.voices, blocked: settings.blocked });
    radio.voiceCache.clear();
  };
  applyRadioSettings();

  // ---------- logs ----------
  function addLog(pos, cls, html) {
    pos = pos || "ALL";
    const t = sim ? fmtClock(sim) : "";
    const entry = { cls, html: `<span class="t">${t}</span>${html}` };
    for (const p of new Set([pos, "ALL"])) {
      (logs[p] ||= []).push(entry);
      if (logs[p].length > 300) logs[p].shift();
      if (p !== activePos && p !== "ALL") unread[p] = (unread[p] || 0) + 1;
    }
    if (pos === activePos || activePos === "ALL" || pos === "ALL") renderLog();
  }
  function renderLog() {
    const box = $("log");
    box.innerHTML = (logs[activePos] || []).map(e => `<div class="${e.cls}">${e.html}</div>`).join("");
    box.parentElement.scrollTop = box.parentElement.scrollHeight;
  }
  const sysLog = (text) => addLog(activePos, "sys", esc(text));

  radio.on((m) => {
    if (m.from === "voices") { if ($("settings").open) renderVoiceTable(); return; }
    if (m.from === "blocked") { addLog(m.pos, "blk", `⟿ blocked transmission${m.ac ? " (" + esc(m.ac.cs) + (m.rival ? " + " + esc(m.rival.cs) : "") + ")" : ""}`); return; }
    if (m.from === "atc") {
      const who = m.ai ? `${esc(posCs(m.pos))} (AI)` : "ATC";
      addLog(m.pos, m.ai ? "ai" : "atc", `<b>${who}</b> ${esc(m.text)}`);
      return;
    }
    if (m.ac) m.ac.callingUntil = Date.now() + 3500;
    addLog(m.pos, `pilot ${m.ac && m.ac.human ? "human" : m.ac ? m.ac.kind : ""}`, `<b>${esc(m.ac ? m.ac.cs : "?")}</b> ${esc(m.text)}`);
  });
  const posCs = (k) => (positions && positions[k] ? positions[k].cs : k);

  function alertBox(msg) {
    addLog("ALL", "err", "⚠ " + esc(msg));
    const d = document.createElement("div"); d.textContent = msg;
    $("alerts").appendChild(d);
    setTimeout(() => d.remove(), 12000);
    channel && channel.postMessage({ type: "alert", msg });
  }

  // ---------- airport & sim ----------
  async function loadAirport(icao) {
    icao = String(icao || "").trim().toUpperCase();
    if (!icao) return;
    $("aptName").textContent = `Loading ${icao} from the X-Plane Scenery Gateway…`;
    radio.reset();
    try {
      const r = await fetch(`/api/airport/${icao}`);
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || r.statusText);
      if (!d.runways.length) throw new Error("no runways in this airport's data");
      apt = new Airport(d);
    } catch (e) {
      $("aptName").textContent = `${icao}: ${e.message}`;
      return;
    }
    store.set("tt.icao", icao);
    $("aptIcao").value = icao;
    positions = buildPositions(apt);
    $("aptName").textContent = `${apt.name}${apt.edges.length ? "" : " — no taxi routes in Gateway data"}`;
    radar.setAirport(apt);
    const sel = $("rwySel"); sel.innerHTML = "";
    for (const r of apt.runways) for (const e of r.ends) sel.add(new Option(e.name, e.name));
    metar = null;
    try { metar = await (await fetch(`/api/metar/${icao}`)).json(); } catch { /* offline */ }
    createSim();
    const best = bestRunway();
    sel.value = best; sim.setRunway(best);
    for (const k of Object.keys(logs)) delete logs[k];
    const p = positions;
    sysLog(`${apt.icao} ${apt.name} · runway ${best}${metar && metar.wdir != null ? ` (wind ${metar.wdir}°/${metar.wspd} kt)` : ""} · ` +
      POS_ORDER.map(k => `${k} ${p[k].freq}`).join(" · "));
    renderAtis();
    channel && channel.postMessage({ type: "airport", icao });
  }

  function createSim() {
    radio.reset();
    for (const k of Object.keys(logs)) delete logs[k];
    for (const k of Object.keys(unread)) delete unread[k];
    const split = settings.staff.mode === "split";
    const staffing = split ? new Set(settings.staff.keys.length ? settings.staff.keys : ["TWR"]) : new Set(["ALL"]);
    sim = new Sim(apt, {
      positions: split ? positions : null, staffing,
      rates: { readbackError: settings.rbErr / 100, sayAgain: settings.sayAgain / 100, oldAtis: settings.oldAtis / 100 },
      events: settings.events, clockUtc: Date.now(),
      onRadio: (m) => { radio.enqueue(m); bridges.transmission(m); },
      onAlert: alertBox,
      onEvent: onSimEvent,
    });
    sim.depPerHour = +settings.dep; sim.arrPerHour = +settings.arr;
    if (metar && typeof metar.wdir === "number") sim.wind = { dir: metar.wdir, spd: metar.wspd || 0 };
    if ($("rwySel").value) sim.setRunway($("rwySel").value);
    selectedId = null;
    activePos = split ? [...staffing].sort((a, b) => POS_ORDER.indexOf(a) - POS_ORDER.indexOf(b))[0] : "ALL";
    radio.audible = split ? new Set([...staffing]) : null;
    setView(DEFAULT_VIEW[activePos]);
    renderTabs(); renderLog(); renderPosHead();
  }

  function onSimEvent(e) {
    if (e.type === "atis") { renderAtis(); sysLog(`ATIS information ${e.letter} is now current.`); }
    if (e.type === "readbackCorrected") addLog(e.ac.freq, "sys", `✓ readback corrected (${esc(e.ac.cs)})`);
    if (e.type === "emergency") alertBox(`${e.ac.cs} squawking ${e.code}${e.code === "7600" ? " — radio failure" : " — emergency"}`);
    if (e.type === "gone" && e.ac.id === selectedId) selectedId = null;
  }

  function bestRunway() {
    let best = apt.runways[0].ends[0], bs = -Infinity;
    const wdir = metar && typeof metar.wdir === "number" ? metar.wdir : null, wspd = metar ? (metar.wspd || 0) : 0;
    for (const r of apt.runways) for (const e of r.ends) {
      let s = r.len / 1000;
      if (wdir !== null) s += Math.cos((wdir - e.hdg) * Math.PI / 180) * Math.max(wspd, 1) * 10;
      if (s > bs) { bs = s; best = e; }
    }
    return best.name;
  }
  function windText() { return metar && metar.wdir != null ? `${String(metar.wdir).padStart(3, "0")}° / ${metar.wspd} kt` : "calm / unknown"; }

  function renderAtis() {
    if (!sim) return;
    const m = metar || {};
    const qnh = m.altim ? Math.round(m.altim) : null;
    const rvr = (m.rawOb || "").match(/\bR\d\d[LRC]?\/[PM]?\d{4}/g);
    $("atisBox").innerHTML = `<span>ATIS <b>${sim.atisLetter()}</b></span><span>RWY ${esc(sim.depEnd.name)}</span>` +
      `<span>${windText()}</span>${qnh ? `<span>Q${qnh}</span>` : ""}<span class="raw" title="${esc(m.rawOb || "")}">${esc(m.rawOb || "no METAR")}</span>`;
    $("wxPanel").innerHTML = `WIND <b>${windText()}</b><br>QNH <b>${qnh || "—"}</b> · VIS <b>${esc(m.visib ?? "—")}</b>${rvr ? `<br>RVR <b>${esc(rvr.join(" "))}</b>` : ""}` +
      `<br>RWY <b>${esc(sim.depEnd.name)}</b> · ATIS <b>${sim.atisLetter()}</b>`;
  }

  // ---------- positions, tabs, views ----------
  function staffedKeys() { return sim && sim.split ? POS_ORDER.filter(k => sim.userWorks(k)) : ["ALL"]; }
  function renderTabs() {
    if (!sim) return;
    const keys = sim.split ? POS_ORDER : ["ALL"];
    $("posTabs").innerHTML = keys.map(k => {
      const ai = sim.split && !sim.userWorks(k);
      const label = k === "ALL" ? "DEL/GND/TWR" : k;
      return `<div class="tab${k === activePos ? " on" : ""}${ai ? " ai" : ""}" data-pos="${k}" title="${ai ? "AI controller" : "you"}">${label}` +
        `${unread[k] ? `<span class="badge">${unread[k]}</span>` : ""}<button class="pop" data-pop="${k}" title="Pop out">⧉</button></div>`;
    }).join("");
    $("viewTabs").innerHTML = Object.keys(VIEWS).map(v => `<button data-view="${v}" class="${radar.view === v ? "on" : ""}">${VIEWS[v]}</button>`).join("");
    renderPosHead();
  }
  function renderPosHead() {
    if (!sim) return;
    const p = sim.split && positions[activePos];
    const txPos = txPosition();
    $("posHead").innerHTML = p ? `<b>${esc(p.cs)}</b> · ${esc(p.name)} · <b>${p.freq}</b>${sim.userWorks(activePos) ? "" : " · <i>AI controller (monitoring)</i>"}`
      : `<b>${esc(apt.icao)}_TWR</b> · combined DEL/GND/TWR · <b>${apt.freq.tower ? fmtFreq(apt.freq.tower.mhz) : "—"}</b>`;
    $("txOn").textContent = sim.split ? `TX ${txPos} ${positions[txPos].freq}` : "TX";
    $("logTitle").textContent = `Frequency ${sim.split ? (activePos === "ALL" ? "" : positions[activePos].freq) : ""}`;
    $("delPanel").classList.toggle("hidden", !(activePos === "DEL" || (!sim.split)));
  }
  function txPosition() { if (!sim || !sim.split) return "ALL"; return sim.userWorks(activePos) ? activePos : staffedKeys()[0]; }
  function setActive(k) { activePos = k; unread[k] = 0; setView(DEFAULT_VIEW[k] || "GND"); renderTabs(); renderLog(); }
  function setView(v) { radar.setView(v); $("wxPanel").classList.toggle("hidden", v !== "TWR"); renderTabs && $("viewTabs") && ($("viewTabs").querySelectorAll("button").forEach(b => b.classList.toggle("on", b.dataset.view === v))); }

  $("posTabs").addEventListener("click", (e) => {
    const pop = e.target.closest("[data-pop]");
    if (pop) { e.stopPropagation(); popOut(pop.dataset.pop); return; }
    const t = e.target.closest(".tab"); if (t) setActive(t.dataset.pos);
  });
  $("viewTabs").addEventListener("click", (e) => { const b = e.target.closest("[data-view]"); if (b) setView(b.dataset.view); });

  // ---------- pop-out windows ----------
  function popOut(pos) {
    const w = window.open(`?popout=${pos}&icao=${apt ? apt.icao : ""}`, `tt-${pos}`, "width=1000,height=760");
    if (!w) { sysLog("Pop-up blocked — allow pop-ups for this page."); return; }
    const list = new Set(store.get("tt.popouts", [])); list.add(pos); store.set("tt.popouts", [...list]);
  }
  const savedPop = store.get("tt.popouts", []);
  if (savedPop.length) {
    const b = $("restorePop"); b.textContent = `Restore windows: ${savedPop.join(", ")}`; b.classList.remove("hidden");
    b.onclick = () => { savedPop.forEach(p => popOut(p)); b.classList.add("hidden"); };
    setTimeout(() => b.classList.add("hidden"), 20000);
  }
  if (channel) channel.onmessage = (ev) => {
    const m = ev.data;
    if (m.type === "tx") transmit(m.text, m.pos, "pop-out");
    else if (m.type === "strip") stripAction(m);
    else if (m.type === "select") select(sim && sim.ac.find(a => a.id === m.id));
    else if (m.type === "closed") { const list = new Set(store.get("tt.popouts", [])); list.delete(m.pos); store.set("tt.popouts", [...list]); }
    else if (m.type === "hello") broadcast(true);
  };
  function broadcast(full) {
    if (!channel || !sim) return;
    channel.postMessage({ type: "state", icao: apt.icao, t: fmtClock(sim), ac: sim.snapshot(selectedId), split: sim.split,
      positions, staffed: staffedKeys(), selectedId, rwy: sim.depEnd.name, arrEnd: sim.arrEnd.name, atis: $("atisBox").innerHTML,
      logs: full ? logs : Object.fromEntries(Object.entries(logs).map(([k, v]) => [k, v.slice(-60)])) });
  }

  // ---------- strips ----------
  function stripAction(m) {
    const a = sim && sim.ac.find(x => x.id === m.id); if (!a) return;
    if (m.bay) a.strip = { bay: m.bay, state: a.state };
    if (m.field) {
      a.stripData = { ...(a.stripData || {}), [m.field]: m.value };
      if (m.field === "sid") a.sid = m.value || a.sid;
      if (m.field === "cfl") { const v = String(m.value).toUpperCase(); const n = parseInt(v.replace(/^F/, ""), 10); if (n) a.cfl = v.startsWith("F") ? n * 100 : n; }
    }
  }
  function renderBoard() {
    if (!sim) return;
    renderStrips({ el: $("stripBoard"), ac: sim.snapshot(selectedId), pos: activePos, selectedId, split: sim.split,
      onSelect: (id) => select(sim.ac.find(a => a.id === id)),
      onMove: (id, bay) => stripAction({ id, bay }), onEdit: (id, field, value) => stripAction({ id, field, value }) });
  }
  function renderDel() {
    if (!sim || $("delPanel").classList.contains("hidden")) return;
    const req = sim.ac.filter(a => a.kind === "dep" && !a.ga && ["clr_req", "parked"].includes(a.state) && a.lastCall != null);
    $("clrList").innerHTML = req.length ? req.map(a => `<div class="strip${a.id === selectedId ? " sel" : ""}" data-id="${a.id}"><span class="cs">${esc(a.cs)}</span>` +
      `<span>${esc(a.type)}</span><span>→${esc(a.other[0])} ${esc(a.other[1])}</span><span>${esc(a.stand ? a.stand.name : "")}</span><span class="st">${Math.round(sim.t - a.lastCall)}s</span></div>`).join("")
      : `<div class="muted small">No pending requests.</div>`;
    const a = sim.ac.find(x => x.id === selectedId);
    const ed = document.activeElement && $("fpEditor").contains(document.activeElement);
    if (ed) return;
    if (!a || a.kind !== "dep") { $("fpEditor").innerHTML = "Select a departure."; return; }
    const d = a.stripData || {};
    $("fpEditor").innerHTML = `<span>Callsign</span><b>${esc(a.cs)} (${esc(a.nat ? NAT_NAME[a.nat] || a.nat : "")})</b>` +
      `<span>Type</span><span>${esc(a.type)}/${a.wtc}</span><span>Route</span><span>${esc(apt.icao)} → ${esc(a.other[0])} ${esc(a.other[1])}</span>` +
      `<span>SID</span><input data-f="sid" value="${esc(d.sid ?? a.sid ?? "")}" placeholder="flight planned route">` +
      `<span>CFL</span><input data-f="cfl" value="${esc(d.cfl ?? (a.cfl || 5000))}">` +
      `<span>Squawk</span><input data-f="sq" value="${esc(d.sq ?? a.assignedSq ?? "")}" placeholder="Assign squawk">`;
  }
  $("fpEditor").addEventListener("change", (e) => { const f = e.target.dataset.f; if (f) stripAction({ id: selectedId, field: f, value: e.target.value.trim() }); });
  $("clrList").addEventListener("click", (e) => { const s = e.target.closest("[data-id]"); if (s) select(sim.ac.find(a => a.id === +s.dataset.id)); });

  function select(a) {
    selectedId = a ? a.id : null;
    if (a) { $("cmd").value = `${a.ga ? (a.abbrev ? a.cs : a.tel) : a.tel + " " + a.num} `; $("cmd").focus(); }
    renderBoard(); renderDel();
  }
  radar.onSelect = (id) => select(sim && sim.ac.find(a => a.id === id));

  function clearanceText(a, code) {
    if (!a) return "";
    const d = a.stripData || {};
    code = code || d.sq || a.assignedSq || sim.squawks.peek(sim.t);
    const cfl = d.cfl ?? a.cfl ?? 5000;
    const alt = String(cfl).toUpperCase().startsWith("F") ? `flight level ${String(cfl).slice(1)}` : `${cfl} feet`;
    const sid = d.sid || a.sid;
    const gnd = sim.split && positions.GND && !sim.userWorks("DEL") ? "" : sim.split && positions.GND ? `, contact Ground ${positions.GND.freq}` : "";
    return `${a.tel} ${a.num} cleared to ${a.other[1]} via ${sid ? sid + " departure" : "flight planned route"}, climb ${alt}, squawk ${code}${gnd}`;
  }
  $("assignSq").addEventListener("click", () => {
    const a = sim && sim.ac.find(x => x.id === selectedId);
    if (!a || a.kind !== "dep" || a.ga) { sysLog("Select an IFR departure first."); return; }
    const code = sim.squawks.peek(sim.t);
    a.stripData = { ...(a.stripData || {}), sq: code };
    $("cmd").value = clearanceText(a, code); $("cmd").focus();
  });

  // ---------- transmitting ----------
  function transmit(text, pos, source = "typed") {
    text = String(text || "").trim();
    if (!text || !sim) return;
    pos = pos && pos !== "ALL" && sim.split ? pos : txPosition();
    radio.controller(text, pos);
    if (source !== "typed" && source !== "voice") addLog(pos, "sys", `(${esc(source)})`);
    bridges.transmission({ from: "atc", text, pos });
    const pp = parse(text, sim.ac, sim.ac.find(a => a.id === selectedId));
    if (settings.coach) showCoach(coach({ text, parsed: pp, sim, pos, lang: settings.lang }), pos);
    countCoach(pos, pp);
    if (!pp.ac) { addLog(pos, "sys", "No aircraft answered (callsign not recognised)."); return; }
    if (pp.ac.human) return; // a real pilot: it went out as text on XRadio
    if (!sim.hears(pp.ac, pos)) return; // not on this frequency: nobody answers
    if (!pp.explicit) addLog(pos, "sys", `(no callsign — assumed ${esc(pp.ac.cs)})`);
    const r = sim.respond(pp.ac, pp.ins, { text: pp.normalized, pos, abbrevUsed: pp.abbrev });
    if (!r) return;
    radio.enqueue({ from: "pilot", ac: pp.ac, text: r.d, say: r.s, pos: pp.ac.freq === "LOST" ? pos : pp.ac.freq, speaker: Math.random() < 0.8 ? 0 : 1 });
    bridges.transmission({ from: "pilot", ac: pp.ac, text: r.d, pos });
  }
  function countCoach(pos, pp) {
    const s = (coachStats[pos] ||= { tx: 0, warn: 0 });
    s.tx++;
    s.warn += coach({ text: "", parsed: pp, sim, pos, lang: "en" }).filter(n => n.level === "warn").length;
  }
  function showCoach(notes, pos) {
    coachLog.unshift(...notes.map(n => ({ ...n, pos })));
    coachLog.length = Math.min(coachLog.length, 30);
    renderCoach();
  }
  function renderCoach() {
    const el = $("coachPanel");
    el.classList.toggle("hidden", !settings.coach);
    if (!settings.coach || !sim) return;
    const hints = coachHints(sim, settings.lang).slice(0, 3);
    el.innerHTML = hints.map(h => `<div class="n info">→ ${esc(h.ac.cs)}: ${esc(h.msg)}</div>`).join("") +
      coachLog.slice(0, 8).map(n => `<div class="n ${n.level}">${n.level === "good" ? "✓" : n.level === "warn" ? "!" : "i"} ${esc(n.msg)}${n.ref ? `<div class="ref">${esc(n.ref)}</div>` : ""}</div>`).join("");
  }
  $("cmdForm").addEventListener("submit", (e) => {
    e.preventDefault(); transmit($("cmd").value);
    const a = sim && sim.ac.find(x => x.id === selectedId);
    $("cmd").value = a ? `${a.ga ? a.tel : a.tel + " " + a.num} ` : "";
  });

  // ---------- push-to-talk ----------
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let rec = null, recText = "", pttDown = false;
  function pttStart() {
    if (pttDown) return;
    pttDown = true; $("mic").classList.add("live");
    radio.burst && radio.burst(0.03, 0.2);
    const pos = txPosition();
    if (bridges.voice) bridges.keyMic(true, sim && sim.split ? Math.round(positions[pos].mhz * 1000) : Math.round((parseFloat(settings.xr.freq) || (apt.freq.tower || { mhz: 118.1 }).mhz) * 1000));
    if (!SR) { sysLog("Speech recognition needs Chrome or Edge — type instead."); return; }
    recText = "";
    rec = new SR(); rec.lang = "en-US"; rec.interimResults = true; rec.continuous = true;
    rec.onresult = (e) => { recText = [...e.results].map(r => r[0].transcript).join(" "); $("cmd").value = recText; };
    rec.onend = () => { if (recText) transmit(recText, undefined, "voice"); recText = ""; $("cmd").value = ""; };
    try { rec.start(); } catch { /* already started */ }
  }
  function pttStop() {
    if (!pttDown) return;
    pttDown = false; $("mic").classList.remove("live");
    bridges.keyMic(false);
    setTimeout(() => rec && rec.stop(), 350);
  }
  $("mic").addEventListener("mousedown", pttStart);
  window.addEventListener("mouseup", pttStop);
  window.addEventListener("keydown", (e) => { if (e.code === "Space" && e.ctrlKey && !e.repeat) { e.preventDefault(); pttStart(); } });
  window.addEventListener("keyup", (e) => { if (e.code === "Space" || e.key === "Control") pttStop(); });

  // ---------- bridges (EuroScope / XRadio) ----------
  const bridges = new Bridges({
    getSim: () => sim, getApt: () => apt, log: sysLog,
    onEsMessage: (m) => {
      if (m.type === "status") { sysLog(`EuroScope: ${m.text}`); return; }
      if (m.type === "tx") {
        const pos = sim && sim.split ? (Object.values(positions).find(p => m.freq && Math.abs(p.mhz - m.freq) < 0.003) || {}).key : undefined;
        transmit(m.text, pos, `EuroScope ${m.from}`);
      }
    },
    onEsStatus: (st) => {
      const el = $("esStatus");
      if (!st) { el.textContent = "ES: off"; el.className = "pill"; return; }
      const c = st.controllers || [];
      el.textContent = c.length ? `ES: ${c.map(x => x.cs).join(", ")} connected` : `ES: listening :${st.port}`;
      el.className = "pill" + (c.length ? " on" : "");
      $("setEs").innerHTML = `FSD server on <b>${esc(st.host)}:${st.port}</b>. ${c.length ? "Connected: " + c.map(x => `${esc(x.cs)}${x.freq ? " (" + x.freq + ")" : ""}`).join(", ") : "No EuroScope connected."}<br>EuroScope → Connect → Direct to VATSIM, untick "Connect to VATSIM", server 127.0.0.1, any callsign and password.`;
    },
    onXrStatus: (st) => {
      const el = $("xrStatus");
      el.classList.toggle("hidden", !settings.xr.enabled);
      if (!st) return;
      if (st.error) { el.textContent = "XR: error"; el.className = "pill err"; el.title = st.error; }
      else if (st.running) { el.textContent = `XR: ${st.pilots || 0} pilot${st.pilots === 1 ? "" : "s"}`; el.className = "pill on"; el.title = (st.roster || []).map(r => r.cs).join(", "); }
      else { el.textContent = "XR: off"; el.className = "pill"; }
      $("xrInfo").textContent = st.error ? st.error : st.running ? `Connected · ${st.ai_sessions || 0} AI aircraft in X-Plane · real pilots: ${(st.roster || []).map(r => r.cs).join(", ") || "none"}` : "Not connected.";
      if (st.error && !xrErrShown) { xrErrShown = true; alertBox(st.error); }
    },
    onXrText: (t) => {
      const pos = sim && sim.split ? (Object.values(positions).find(p => Math.round(p.mhz * 1000) === t.khz) || {}).key : "ALL";
      addLog(pos || "ALL", "pilot human", `<b>${esc(t.from)}</b> ${esc(t.text)}`);
    },
  });
  let xrErrShown = false;
  if (settings.xr.enabled) bridges.configureXr(settings.xr);

  // ---------- staffing ----------
  $("staffBtn").addEventListener("click", () => {
    const m = $("staffMenu"); m.classList.toggle("hidden");
    m.querySelectorAll("[name=staffMode]").forEach(r => { r.checked = r.value === settings.staff.mode; });
    m.querySelectorAll(".staffKeys input").forEach(c => { c.checked = settings.staff.keys.includes(c.value); });
  });
  $("staffApply").addEventListener("click", () => {
    const m = $("staffMenu");
    settings.staff.mode = m.querySelector("[name=staffMode]:checked")?.value || "combined";
    settings.staff.keys = [...m.querySelectorAll(".staffKeys input:checked")].map(c => c.value);
    if (settings.staff.mode === "split" && !settings.staff.keys.length) settings.staff.keys = ["TWR"];
    save(); m.classList.add("hidden"); updateStaffBtn();
    if (apt) { createSim(); sysLog(`Staffing: ${settings.staff.mode === "split" ? settings.staff.keys.join("+") + " (others AI)" : "combined"}.`); }
  });
  function updateStaffBtn() { $("staffBtn").textContent = settings.staff.mode === "split" ? `Staffing: ${settings.staff.keys.join("+")}` : "Staffing: combined"; }
  updateStaffBtn();

  // ---------- settings dialog ----------
  const bindings = [
    ["setAccents", "accents"], ["setRate", "rate"], ["setEffect", "effect"], ["setVoices", "voices", "checked"], ["setBlocked", "blocked", "checked"],
    ["setRbErr", "rbErr"], ["setSayAgain", "sayAgain"], ["setOldAtis", "oldAtis"], ["setEvents", "events", "checked"],
    ["depRate", "dep"], ["arrRate", "arr"], ["setCoach", "coach", "checked"], ["setLang", "lang"], ["graph", "graph", "checked"],
  ];
  function fillSettings() {
    for (const [id, k, prop] of bindings) $(id)[prop || "value"] = settings[k];
    $("setRateV").textContent = (+settings.rate).toFixed(2); $("setEffectV").textContent = Math.round(settings.effect * 100) + "%";
    const x = settings.xr;
    $("xrEnabled").checked = x.enabled; $("xrHost").value = x.host; $("xrPort").value = x.port; $("xrPass").value = x.password;
    $("xrCs").value = x.cs || (apt ? `${apt.icao}_TWR` : ""); $("xrFreq").value = x.freq || (apt && apt.freq.tower ? fmtFreq(apt.freq.tower.mhz) : "");
    $("xrAi").checked = x.ai; $("xrHumans").checked = x.humans; $("xrText").checked = x.text; $("xrVoice").checked = x.voice;
    $("coachToggle").checked = settings.coach;
    renderVoiceTable();
  }
  function readSettings() {
    for (const [id, k, prop] of bindings) { const v = $(id)[prop || "value"]; settings[k] = prop ? v : (isNaN(+v) || v === "" ? v : +v); }
    settings.xr = { enabled: $("xrEnabled").checked, host: $("xrHost").value.trim() || "127.0.0.1", port: +$("xrPort").value || 49100,
      password: $("xrPass").value, cs: $("xrCs").value.trim().toUpperCase(), freq: $("xrFreq").value.trim(), ai: $("xrAi").checked,
      humans: $("xrHumans").checked, text: $("xrText").checked, voice: $("xrVoice").checked };
    save(); applyRadioSettings();
    if (sim) {
      sim.rates = { readbackError: settings.rbErr / 100, sayAgain: settings.sayAgain / 100, oldAtis: settings.oldAtis / 100 };
      sim.events = settings.events; sim.depPerHour = +settings.dep; sim.arrPerHour = +settings.arr;
    }
    radar.showGraph = settings.graph;
    $("coachToggle").checked = settings.coach; renderCoach();
    $("setRateV").textContent = (+settings.rate).toFixed(2); $("setEffectV").textContent = Math.round(settings.effect * 100) + "%";
  }
  function renderVoiceTable() {
    const rows = radio.voiceTable();
    $("voiceTable").innerHTML = `<table><tr><th>Nationality</th><th>Voice</th><th></th></tr>` + rows.map(r =>
      `<tr><td>${esc(r.name)}</td><td>${esc(r.voice)} <span class="muted">${esc(r.lang)}</span></td>` +
      `<td class="${r.fallback ? "fb" : "nat"}">${r.english ? (r.fallback ? "English fallback" : "native English") : r.native ? (r.respell ? "native + respelling" : "native voice") : "fallback (English)"}</td></tr>`).join("") + "</table>";
  }
  $("settingsBtn").addEventListener("click", () => { fillSettings(); $("settings").showModal(); });
  $("settings").addEventListener("change", (e) => {
    readSettings();
    if (e.target.id && e.target.id.startsWith("xr")) { xrErrShown = false; bridges.configureXr(settings.xr); }
    if (e.target.id === "setAccents") renderVoiceTable();
  });
  $("settings").addEventListener("input", (e) => { if (e.target.type === "range") readSettings(); });
  $("testVoices").addEventListener("click", () => radio.testVoices(["GB", "US", "IE", "EE", "FI", "LV", "LT", "DE", "FR"]));
  $("coachToggle").addEventListener("change", (e) => { settings.coach = e.target.checked; save(); renderCoach(); });
  radar.showGraph = settings.graph;

  // ---------- debrief ----------
  function openDebrief() {
    if (!sim) return;
    const st = sim.stats;
    const delays = st.delays.map(d => d.s);
    const avg = delays.length ? delays.reduce((a, b) => a + b, 0) / delays.length : 0;
    const L = settings.lang === "et";
    const rows = Object.entries(coachStats).filter(([, v]) => v.tx).map(([p, v]) =>
      `<tr><td>${p === "ALL" ? "DEL/GND/TWR" : p}</td><td>${v.tx}</td><td>${v.warn}</td><td><b>${Math.max(0, Math.round(100 * (1 - v.warn / (v.tx + v.warn))))}</b></td></tr>`).join("");
    $("debriefBody").innerHTML = `<h2>${L ? "Sessiooni kokkuvõte" : "Session debrief"}</h2>
      <table class="score">
        <tr><th>${L ? "Väljujaid" : "Departures"}</th><td>${st.departures}</td><th>${L ? "Saabujaid" : "Arrivals"}</th><td>${st.arrivals}</td></tr>
        <tr><th>${L ? "Keskmine ooteaeg" : "Average delay"}</th><td>${avg.toFixed(0)} s</td><th>${L ? "Kordusringid" : "Go-arounds"}</th><td>${st.goArounds}</td></tr>
        <tr><th>${L ? "Korduse vead (parandatud)" : "Readback errors (caught)"}</th><td>${st.rbErrors} (${st.rbCaught})</td><th>${L ? "Märkamata vead" : "Missed readback errors"}</th><td>${st.missedRb}</td></tr>
        <tr><th>${L ? "Konfliktid" : "Conflicts"}</th><td>${st.conflicts}</td><th>${L ? "Hoiatused" : "Alerts"}</th><td>${st.alerts}</td></tr>
      </table>
      <h3>${L ? "Fraseoloogia positsioonide kaupa" : "Phraseology per position"}</h3>
      <table class="score"><tr><th>${L ? "Positsioon" : "Position"}</th><th>${L ? "Saateid" : "Transmissions"}</th><th>${L ? "Märkusi" : "Issues"}</th><th>${L ? "Skoor" : "Score"}</th></tr>${rows || `<tr><td colspan=4 class="muted">—</td></tr>`}</table>`;
    $("debrief").showModal();
  }
  $("debriefBtn").addEventListener("click", openDebrief);

  // ---------- misc controls ----------
  $("aptForm").addEventListener("submit", (e) => { e.preventDefault(); loadAirport($("aptIcao").value); });
  $("rwySel").addEventListener("change", (e) => { if (sim) { sim.setRunway(e.target.value); renderAtis(); sysLog(`Runway in use: ${e.target.value}`); } });
  $("speed").addEventListener("change", (e) => { speed = +e.target.value; });
  $("helpBtn").addEventListener("click", () => $("help").showModal());
  function setSpeed(n) { speed = n; $("speed").value = String(n); }

  // ---------- guide ----------
  Object.defineProperties(app, { apt: { get: () => apt }, sim: { get: () => sim } });
  Object.assign(app, {
    settings, select, setSpeed, openDebrief, windText, bestRunway,
    clearanceText: (a) => clearanceText(a),
    taxiText: (a) => { if (!a) return ""; const via = sim.viaNames(a); return `${a.tel} ${a.num} taxi to holding point runway ${sim.depEnd.name}${via.length ? " via " + via.join(" ") : ""}`; },
    taxiInText: (a) => { if (!a || !a.stand) return a ? `${a.tel} ${a.num} taxi to stand` : ""; const via = sim.viaNamesTo(a, a.stand.pos); return `${a.tel} ${a.num} taxi to stand ${a.stand.name}${via.length ? " via " + via.join(" ") : ""}`; },
    crossingOnRoute: (a) => { if (!a || !a.path) return false; for (let j = 0; j + 1 < a.path.length; j++) { const z = sim.edgeZones(a.path, j); for (const r of z) if (r !== a.depEnd.rwy) return true; } return false; },
    approachName: () => `${/director/i.test(positions.APP.name) ? "Director" : "Radar"} ${positions.APP.freq}`,
    guideScenario() {
      guideRestore = { random: Math.random, staff: { ...settings.staff } };
      let seed = 4242; Math.random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
      if (settings.staff.mode !== "combined") { settings.staff.mode = "combined"; }
      createSim();
      sim.depPerHour = 0; sim.arrPerHour = 0; sim.nextDep = sim.nextArr = 1e12;
      sim.rates = { readbackError: 0, sayAgain: 0, oldAtis: 0 };
      for (let k = 0; k < 40; k++) { const d = sim.spawnDeparture(); if (d && !d.ga) { app.guideDep = d; break; } if (d) sim.ac.splice(sim.ac.indexOf(d), 1); }
      if (app.guideDep) app.guideDep.callAt = sim.t + 2;
      app.guideArr = null;
      select(app.guideDep);
    },
    guideArrival() {
      for (let k = 0; k < 40; k++) { const a = sim.spawnArrival(); if (a && !a.ga) { app.guideArr = a; break; } if (a) sim.ac.splice(sim.ac.indexOf(a), 1); }
      const a = app.guideArr; if (!a) return;
      const e = a.end; a.pos = [e.thr[0] - e.v[0] * 9000, e.thr[1] - e.v[1] * 9000]; a.alt = sim.glideAlt(a); a.callAt = sim.t + 1;
      select(a);
    },
    endGuideScenario() {
      if (!guideRestore) return;
      Math.random = guideRestore.random; settings.staff = guideRestore.staff; guideRestore = null;
      if (apt) createSim();
    },
  });
  const guide = new Guide(app);
  $("guideBtn").addEventListener("click", () => guide.start());

  // ---------- main loop ----------
  let last = performance.now(), slowT = 0, bcT = 0;
  function frame(now) {
    const dt = Math.min(0.1, (now - last) / 1000); last = now;
    if (sim && speed > 0) for (let i = 0; i < speed; i++) sim.step(dt);
    if (sim) {
      radar.draw({ ac: sim.snapshot(selectedId), arrEnd: sim.arrEnd }, selectedId);
      slowT += dt; bcT += dt;
      if (slowT > 0.5) {
        slowT = 0;
        renderBoard(); renderDel(); renderTabs(); renderCoach();
        const st = sim.stats;
        $("status").textContent = `${fmtClock(sim)}  DEP ${st.departures}  ARR ${st.arrivals}  G/A ${st.goArounds}  ALERTS ${st.alerts}` +
          (speed === 0 ? "  [PAUSED]" : speed > 1 ? `  [${speed}×]` : "");
      }
      if (bcT > 0.25) { bcT = 0; broadcast(false); }
    } else radar.draw({ ac: [], arrEnd: null }, null);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  loadAirport(params.get("icao") || store.get("tt.icao", "EETN"));
  // for debugging and automated tests
  window.TT = { get sim() { return sim; }, get apt() { return apt; }, get positions() { return positions; }, transmit, parse, radio, guide, app,
    settings, setActive, openDebrief, bridges, loadAirport, applyStaffing: (mode, keys) => { settings.staff = { mode, keys }; save(); updateStaffBtn(); createSim(); } };
}

function fmtClock(sim) {
  const s = Math.floor(sim.t), mm = Math.floor(s / 60), ss = String(s % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

// =====================================================================================
//  POP-OUT WINDOW (one position; the simulation runs in the main window)
// =====================================================================================
async function bootPopout() {
  document.body.classList.add("popout");
  document.querySelectorAll(".main-only").forEach(e => e.classList.add("hidden"));
  $("restorePop").classList.add("hidden");
  const pos = POPOUT;
  document.title = `Tower Trainer — ${pos}`;
  let apt = null, state = null, selectedId = null, aptIcao = null;
  async function load(icao) {
    if (!icao || icao === aptIcao) return;
    aptIcao = icao;
    const d = await (await fetch(`/api/airport/${icao}`)).json();
    apt = new Airport(d);
    radar.setAirport(apt);
    radar.setView(DEFAULT_VIEW[pos] || "GND");
  }
  if (params.get("icao")) await load(params.get("icao"));
  $("viewTabs").innerHTML = Object.keys(VIEWS).map(v => `<button data-view="${v}">${VIEWS[v]}</button>`).join("");
  $("viewTabs").addEventListener("click", (e) => { const b = e.target.closest("[data-view]"); if (b) radar.setView(b.dataset.view); });
  $("posTabs").innerHTML = `<div class="tab on">${pos === "ALL" ? "DEL/GND/TWR" : pos}</div>`;
  $("delPanel").classList.toggle("hidden", pos !== "DEL");
  $("assignSq").classList.add("hidden");
  radar.onSelect = (id) => { selectedId = id; channel.postMessage({ type: "select", id }); };
  channel.onmessage = async (ev) => {
    const m = ev.data;
    if (m.type === "airport") { aptIcao = null; await load(m.icao); }
    if (m.type === "alert") { const d = document.createElement("div"); d.textContent = m.msg; $("alerts").appendChild(d); setTimeout(() => d.remove(), 12000); }
    if (m.type !== "state") return;
    if (m.icao !== aptIcao) await load(m.icao);
    state = m;
    selectedId = m.selectedId ?? selectedId;
    const p = m.split && m.positions[pos];
    $("posHead").innerHTML = p ? `<b>${esc(p.cs)}</b> · ${esc(p.name)} · <b>${p.freq}</b>${m.staffed.includes(pos) ? "" : " · <i>AI controller</i>"}` : `<b>combined</b>`;
    $("txOn").textContent = p ? `TX ${pos} ${p.freq}` : "TX";
    $("atisBox").innerHTML = m.atis;
    $("status").textContent = m.t;
    const lg = (m.logs[m.split ? pos : "ALL"] || []);
    const box = $("log");
    const html = lg.map(e => `<div class="${e.cls}">${e.html}</div>`).join("");
    if (box._last !== html) { box.innerHTML = html; box._last = html; box.parentElement.scrollTop = box.parentElement.scrollHeight; }
    renderStrips({ el: $("stripBoard"), ac: m.ac, pos: m.split ? pos : "ALL", selectedId, split: m.split,
      onSelect: (id) => { selectedId = id; channel.postMessage({ type: "select", id }); },
      onMove: (id, bay) => channel.postMessage({ type: "strip", id, bay }),
      onEdit: (id, field, value) => channel.postMessage({ type: "strip", id, field, value }) });
  };
  $("cmdForm").addEventListener("submit", (e) => {
    e.preventDefault();
    channel.postMessage({ type: "tx", pos, text: $("cmd").value });
    $("cmd").value = "";
  });
  window.addEventListener("beforeunload", () => channel.postMessage({ type: "closed", pos }));
  channel.postMessage({ type: "hello", pos });
  function frame() {
    if (state && apt) {
      const arrEnd = apt.findRunwayEnd(state.arrEnd);
      radar.draw({ ac: state.ac, arrEnd }, selectedId);
    } else radar.draw({ ac: [], arrEnd: null }, null);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  window.TT = { get state() { return state; }, pos };
}
