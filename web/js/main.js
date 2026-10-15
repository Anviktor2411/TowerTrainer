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
import { suggestSid, procLines, runwayMatches } from "./procs.js";
import { nextExpected, callsignText } from "./advisor.js";
import { statePhrase, issueMarkers } from "./labels.js";
import { buildAtis, parseMetar, atisSummary } from "./atis.js";
import { daylight } from "./daylight.js";
import { departureSequence, arrivalSpacing } from "./flow.js";
import { CHECKLISTS } from "./events.js";
import { synthMetar } from "./ops.js";

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
const DEFAULT_VIEW = { ALL: "GND", DEL: "DEL", GND: "GND", TWR: "TWR", APP: "APP", CTR: "CTR" };
const PRESET_EFFECT = { clean: 0, good: 0.85, distant: 1, old: 0.95 };

const DEFAULTS = {
  accents: "natural", rate: 1, effect: 0.85, preset: "good", voices: true, blocked: true, rbErr: 4, sayAgain: 2, oldAtis: 10, events: false,
  dep: 10, arr: 8, coach: false, lang: "en", graph: false, monitor: [], occupancy: 70, vehicles: -1, waves: true, osm: true, realMix: true, nightAuto: true,
  wx: "live", lvp: false, recat: false, vfr: 2, abnormals: false, abnormalRate: 2, seq: true,
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
  let sim = null, apt = null, positions = null, metar = null, speed = 1, selectedId = null, procs = null, navInfo = null;
  let activePos = "ALL";
  const logs = {};                 // pos -> [{cls, html}]
  const unread = {};
  const history = {};              // callsign -> [{t, who, text}] (radio history for the info panel)
  const coachLog = [];
  const coachStats = {};           // pos -> {tx, warn}
  let guideRestore = null;
  const app = {};                  // API used by the guide

  const applyRadioSettings = () => {
    Object.assign(radio, { accents: settings.accents, rate: +settings.rate, effect: +settings.effect, tts: settings.voices, blocked: settings.blocked, preset: settings.preset });
    radio.voiceCache.clear();
  };
  applyRadioSettings();

  // ---------- logs ----------
  function addLog(pos, cls, html) {
    pos = pos || "ALL";
    const t = sim ? fmtClock(sim) : "";
    const entry = { cls, html: `<span class="t">${t}</span>${pos === "GUARD" ? '<span class="guard">121.5</span> ' : ""}${html}` };
    for (const p of new Set([pos, "ALL", ...(pos === "GUARD" ? ["TWR", "APP"] : [])])) {
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
  function remember(cs, who, text) {
    if (!cs) return;
    const h = (history[cs] ||= []);
    h.push({ t: sim ? fmtClock(sim) : "", who, text });
    if (h.length > 40) h.shift();
  }

  radio.on((m) => {
    if (m.from === "voices") { if ($("settings").open) renderVoiceTable(); renderVoicePill(); return; }
    if (m.from === "engine") { radio.lastEngine = m; renderVoicePill(); return; }
    if (m.from === "blocked") { addLog(m.pos, "blk", m.stuck ? `⟿ ${m.ac ? esc(m.ac.cs) + " " : "your transmission "}blocked — a microphone is stuck open on the frequency` : `⟿ blocked transmission${m.ac ? " (" + esc(m.ac.cs) + (m.rival ? " + " + esc(m.rival.cs) : "") + ")" : ""}`); return; }
    if (m.from === "stuck") { addLog(m.pos, "blk", `⟿ stuck microphone on the frequency${m.ac ? " (" + esc(m.ac.cs) + ")" : ""} — ${m.on ? "nobody can get through" : "cleared"}`); return; }
    if (m.from === "lab") { sysLog(`Radio lab: ${m.step}`); return; }
    if (m.from === "atc") {
      const who = m.ai ? `${esc(posCs(m.pos))} (AI)` : "ATC";
      addLog(m.pos, m.ai ? "ai" : "atc", `<b>${who}</b> ${esc(m.text)}`);
      if (sim) { const pp = parse(m.text, sim.ac, null); if (pp.ac) remember(pp.ac.cs, m.ai ? "ai" : "me", m.text); }
      return;
    }
    if (m.ac) { m.ac.callingUntil = Date.now() + 3500; remember(m.ac.cs, "pilot", m.text); }
    addLog(m.pos, `pilot ${m.ac && m.ac.human ? "human" : m.ac && m.ac.veh ? "veh" : m.ac ? m.ac.kind : ""}`, `<b>${esc(m.ac ? m.ac.cs : "?")}</b> ${esc(m.text)}`);
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
    radio.airport = apt.icao;
    radar.setAirport(apt);
    radar.stopBars = apt.stopBars || [];
    radar.onStopBar = (bar) => { if (!sim) return; sim.setStopBar(bar, !bar.lit); sysLog(`Stop bar ${bar.id} (runway ${apt.runways[bar.rwy] ? apt.runways[bar.rwy].label : "?"}) switched ${bar.lit ? "ON" : "OFF"}.`); };
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
    loadProcedures(icao);
    loadTraffic(icao);
    loadOsm(icao);
  }

  /** Airlines and destinations that really serve the airport (OpenFlights, cached by the server). */
  let trafficMix = null;
  async function loadTraffic(icao) {
    trafficMix = null;
    try { trafficMix = await (await fetch(`/api/traffic/${icao}`)).json(); } catch { trafficMix = null; }
    if (!sim || apt.icao !== icao) return;
    applyTraffic();
  }
  function applyTraffic() {
    if (!sim) return;
    sim.setTrafficMix(settings.realMix ? trafficMix : null);
    if (sim.mix) {
      const top = sim.mix.airlines.slice(0, 6).map(a => a.tel).join(", ");
      sysLog(`Traffic mix from OpenFlights: ${sim.mix.airlines.length} airlines, ${sim.mix.dests.size} destinations (${top}…).`);
    } else if (settings.realMix && trafficMix && trafficMix.error) sysLog(`Traffic mix: ${trafficMix.error} — using the built-in airline list.`);
  }
  /** Terminals, hangars and the tower from OpenStreetMap (cached by the server; nothing when offline). */
  async function loadOsm(icao) {
    radar.setOsm(null); radar.credit = "";
    if (!settings.osm) return;
    try {
      const d = await (await fetch(`/api/osm/${icao}`)).json();
      if (!apt || apt.icao !== icao) return;
      if (d && d.buildings && d.buildings.length) {
        radar.setOsm(d); radar.credit = d.credit || "© OpenStreetMap contributors (ODbL)";
        if (d.tower) apt._tower = d.tower;
        sysLog(`${d.buildings.length} buildings from OpenStreetMap (${d.credit}).`);
      } else if (d && d.error) sysLog(`OpenStreetMap buildings unavailable (${d.error.split(":")[0]}) — map without buildings.`);
    } catch { /* offline */ }
  }
  /** Day/night from the simulated clock and the weather tint from the METAR, re-evaluated every few seconds. */
  function updateSky() {
    if (!sim || !apt) return;
    const dl = settings.nightAuto ? daylight(apt.d.lat, apt.d.lon, sim.clockUtc + sim.t * 1000) : "day";
    const night = dl === "night" || (dl === "dusk" && sim.t % 2 < 1 && false);
    if (radar.night !== night) { radar.night = night; radar.staticKey = null; sysLog(night ? "Night: runway and taxiway lighting on." : "Daylight."); }
    const dec = parseMetar(metar && metar.rawOb ? metar.rawOb : "");
    const codes = dec.wx.flatMap(w => w.codes);
    radar.wx = { vis: dec.cavok ? 10000 : dec.vis, fog: codes.includes("FG") || codes.includes("BR") || (dec.vis != null && dec.vis < 1500),
      rain: codes.some(c => ["RA", "DZ", "SH", "TS"].includes(c)), snow: codes.some(c => ["SN", "SG", "PL"].includes(c)), lvp: !!sim.lvp };
  }
  setInterval(updateSky, 3000);

  /** SIDs/STARs from local navdata (CIFP / EuroScope sector files) for Delivery suggestions and the radar. */
  async function loadProcedures(icao) {
    procs = null; navInfo = null;
    try {
      const r = await fetch(`/api/procedures/${icao}`);
      if (r.ok) procs = await r.json();
      const n = await fetch(`/api/navdata`); if (n.ok) navInfo = await n.json();
    } catch { /* remote player: procedures are host-only */ }
    applyProcs();
  }
  function applyProcs() {
    if (!sim || !apt) return;
    const rwy = sim.depEnd.name;
    sim.suggest = (a) => suggestSid(procs, rwy, { lat: apt.d.lat, lon: apt.d.lon, icao: apt.icao }, a.other, sim.region);
    // the published missed approach of the runway in use (D4): legs with lat/lon from the CIFP
    sim.missedFor = (end) => {
      const app = (procs && procs.apps || []).find(p => p.missed && p.missed.length && p.missed.some(l => l.lat != null) &&
        (Object.keys(p.rwy || {}).some(k => runwayMatches(k, end.name)) || (p.runways || []).some(r => runwayMatches(r, end.name))));
      return app ? app.missed : null;
    };
    radar.setProcs(procs ? procLines(procs, rwy) : []);
    const src = procs && procs.source ? procs.source : null;
    const pill = $("navPill");
    pill.classList.remove("hidden");
    if (src && src.kind !== "fallback") {
      const old = navInfo && navInfo.outdated;
      pill.textContent = `NAV: ${src.kind === "navigraph" ? "Navigraph" : src.kind === "xplane" ? "X-Plane" : src.kind === "euroscope" ? "EuroScope" : src.kind}${src.airac ? " " + src.airac : ""}${old ? " (old)" : ""}`;
      pill.className = "pill" + (old ? " err" : " on");
      pill.title = `${src.label}${navInfo && navInfo.current ? " · current cycle " + navInfo.current : ""} — SIDs ${procs.sids.length}, STARs ${procs.stars.length}, approaches ${procs.apps.length}`;
    } else { pill.textContent = "NAV: none"; pill.className = "pill"; pill.title = (src && src.label) || "No procedures found — generic suggestions (point X-Plane/Navigraph CIFP or a sector file in Settings)"; }
    $("delNav").textContent = src ? `· ${src.label}` : "";
  }

  function createSim() {
    radio.reset();
    for (const k of Object.keys(logs)) delete logs[k];
    for (const k of Object.keys(unread)) delete unread[k];
    for (const k of Object.keys(history)) delete history[k];
    const split = settings.staff.mode === "split";
    const staffing = split ? new Set(settings.staff.keys.length ? settings.staff.keys : ["TWR"]) : new Set(["ALL"]);
    sim = new Sim(apt, {
      positions: split ? positions : null, staffing,
      rates: { readbackError: settings.rbErr / 100, sayAgain: settings.sayAgain / 100, oldAtis: settings.oldAtis / 100 },
      events: settings.events, clockUtc: Date.now(),
      occupancy: (+settings.occupancy || 0) / 100, waves: !!settings.waves,
      serviceVehicles: +settings.vehicles >= 0 ? +settings.vehicles : undefined,
      recat: !!settings.recat, abnormals: !!settings.abnormals, abnormalRate: +settings.abnormalRate || 2, vfrPerHour: +settings.vfr || 0,
      onRadio: (m) => { radio.enqueue(m); bridges.transmission(m); },
      onAlert: alertBox,
      onEvent: onSimEvent,
    });
    sim.depPerHour = +settings.dep; sim.arrPerHour = +settings.arr;
    sim.setTrafficMix(settings.realMix ? trafficMix : null);
    if ($("rwySel").value) sim.setRunway($("rwySel").value);
    applyWeather();
    radar.vfrPoints = sim.vfrPoints();
    updateSky();
    radio.onFrequency = (pos) => (sim ? sim.onFrequency(pos) : []);
    // after two stations block each other an AI controller asks who called; a staffed position leaves that to you
    radio.onBlocked = (pos) => { if (sim && sim.split && sim.positions[pos] && !sim.userWorks(pos)) setTimeout(() => sim && sim.atc(pos, Math.random() < 0.5 ? "station calling, say again" : "two stations calling at once, say again"), 900); };
    selectedId = null;
    activePos = split ? [...staffing].sort((a, b) => POS_ORDER.indexOf(a) - POS_ORDER.indexOf(b))[0] : "ALL";
    radio.audible = split ? new Set([...staffing, "GUARD"]) : null;
    radio.monitor = new Set(split ? (settings.monitor || []).filter(k => !staffing.has(k)) : []);
    setView(DEFAULT_VIEW[activePos]);
    renderTabs(); renderLog(); renderPosHead(); renderInfo();
    applyProcs();
  }

  function onSimEvent(e) {
    if (e.type === "atis") { renderAtis(); sysLog(`ATIS information ${e.letter} is now current.`); if (atisOn) startAtis(); }
    if (e.type === "prepare") radio.prerenderText(e.ac, e.m);
    if (e.type === "aiAction") addLog(e.pos, "ai", `<b>${esc(posCs(e.pos))} (AI)</b> 💡 ${esc(e.text)}`);
    if (e.type === "readbackCorrected") addLog(e.ac.freq, "sys", `✓ readback corrected (${esc(e.ac.cs)})`);
    if (e.type === "emergency") { alertBox(`${e.ac.cs} squawking ${e.code}${e.code === "7600" ? " — radio failure (RCF): use light signals or the follow-me" : e.code === "7500" ? " — unlawful interference" : " — emergency"}`); renderInfo(); }
    if (e.type === "gone" && e.ac.id === selectedId) { selectedId = null; renderInfo(); }
    if (e.type === "light") addLog(e.ac.freq, "sys", `💡 light gun → ${esc(e.ac.cs)}: ${e.color} ${e.mode}${e.effect ? " — " + esc(e.effect) : " — no effect in this situation"}`);
    if (e.type === "nordoWants" && e.ac.lastWantAt !== e.ac._lastShown) { e.ac._lastShown = e.ac.lastWantAt; addLog(e.ac.freq, "sys", `(${esc(e.ac.cs)} has no radio — would say: “${esc(e.text)}”)`); }
    if (e.type === "followMeSent") addLog(e.ac.freq, "sys", `🚗 ${esc(e.veh.cs)} dispatched to ${esc(e.ac.cs)}`);
    if (e.type === "followMe") addLog(e.ac.freq, "sys", `🚗 ${esc(e.veh.cs)} leading ${esc(e.ac.cs)} to stand ${esc(e.ac.stand ? e.ac.stand.name : "")}`);
    // Phase D: operations, weather and abnormal events
    if (e.type === "abnormal") {
      const who = e.ac ? e.ac.cs : e.veh ? e.veh.cs : "";
      const title = { medical: "Medical emergency", birdstrike: "Bird strike", rto: "Rejected takeoff", breakdown: "Breakdown on the taxiway", fod: "FOD on the runway", incursion: "Runway incursion",
        unstable: "Unstable approach", pan: "PAN PAN", mayday: "MAYDAY", "7500": "Squawk 7500 — unlawful interference", "7600": "Squawk 7600 — radio failure", "7700": "MAYDAY (7700)" }[e.kind] || e.kind;
      sysLog(`⚠ ${title}${who ? ": " + who : ""}`);
      if (e.checklist) showChecklist(e.kind, e.checklist, `${title}${who ? " — " + who : ""}`);
    }
    if (e.type === "emergency" && CHECKLISTS[{ "7500": "hijack", "7600": "rcf", "7700": "mayday" }[e.code]]) showChecklist(e.code, CHECKLISTS[{ "7500": "hijack", "7600": "rcf", "7700": "mayday" }[e.code]], `${e.ac.cs} squawking ${e.code}`);
    if (e.type === "runwayChange") renderOps();
    if (e.type === "runwayChanged") { sysLog(`Runway change: ${e.from} → ${e.to}. Departures already taxiing will ask for a new taxi clearance; arrivals inside 8 NM land on ${e.from}.`); $("rwySel").value = e.to; applyProcs(); renderOps(); }
    if (e.type === "runwayChangeDone") { sysLog(`Runway change complete, runway ${e.to} in use.`); renderOps(); }
    if (e.type === "lvp") { sysLog(e.on ? `Low visibility procedures in force (${e.why || ""}): CAT II/III holding points, stop bars on, no line-up with traffic on final, 6 NM spacing.` : `LVP cancelled (${e.why || ""}).`); updateSky(); renderOps(); }
    if (e.type === "wx") { sysLog(e.live ? "Weather: back to the live METAR." : `Weather scenario ${e.scenario}: ${e.note || "changing"}.`); updateSky(); renderOps(); }
    if (e.type === "inspection") { sysLog(`${e.veh.cs} requests runway ${apt.runways[e.rwy].label} for an inspection (${e.why}). The runway is closed until it reports clear.`); renderOps(); }
    if (e.type === "inspectionDone") { sysLog(`${e.veh.cs}: runway ${apt.runways[e.rwy].label} inspected and clear.`); renderOps(); }
    if (e.type === "rescue") sysLog(`${e.veh.cs} responding (${e.level === "full" ? "full emergency" : "local standby"})${e.ac ? " for " + e.ac.cs : ""}.`);
    if (e.type === "tow") sysLog(`${e.veh.cs} requests to tow ${e.ac.cs} to ${e.dest.name} — "${e.veh.cs} tow approved".`);
    if (e.type === "towDone") sysLog(`${e.veh.cs}: tow of ${e.ac.cs} complete.`);
    if (e.type === "deice") sysLog(`${e.ac.cs} de-icing${e.ac.deice && e.ac.deice.atPad ? " at the pad" : " on stand"}; holdover time starts when it reports complete.`);
    if (e.type === "rwyClosed") { sysLog(`Runway ${apt.runways[e.rwy].label} closed.`); renderOps(); }
    if (e.type === "touchGo") sysLog(`${e.ac.cs} touch and go (${e.ac.circuits} of ${e.ac.wantCircuits || 2}).`);
    if (e.type === "snow") sysLog(`${e.veh.cs} requests runway ${apt.runways[e.rwy].label} for snow clearing.`);
  }

  function bestRunway() {
    let best = apt.runways[0].ends[0], bs = -Infinity;
    const wdir = metar && typeof metar.wdir === "number" ? metar.wdir : null, wspd = metar ? (metar.wspd || 0) : 0;
    for (const r of apt.runways) for (const e of r.ends) {
      if (!apt.entries(e).length && apt.runways.some(o => apt.entries(o.ends[0]).length)) continue;   // no taxiway to it
      let s = r.len / 1000;
      if (wdir !== null) s += Math.cos((wdir - e.hdg) * Math.PI / 180) * Math.max(wspd, 1) * 10;
      if (s > bs) { bs = s; best = e; }
    }
    return best.name;
  }
  function windText() {
    const w = sim && sim.wind && sim.wind.dir != null ? sim.wind : metar && metar.wdir != null ? { dir: metar.wdir, spd: metar.wspd || 0, gust: metar.wgst || 0 } : null;
    return w ? `${String(Math.round(w.dir)).padStart(3, "0")}° / ${Math.round(w.spd)} kt${w.gust ? " G" + Math.round(w.gust) : ""}` : "calm / unknown";
  }
  /** The METAR the operation runs on: the live one, or the synthetic one of a scripted weather scenario (D1). */
  function currentMetar() {
    if (sim && sim.wxOverride && apt) return synthMetar(apt.icao, utcClock(), sim.wxOverride);
    return metar && metar.rawOb ? metar.rawOb : "";
  }
  /** Push the METAR into the simulation: wind, visibility/RVR (LVP), temperature (de-icing), manual LVP, weather scenario. */
  function applyWeather() {
    if (!sim) return;
    const dec = parseMetar(currentMetar());
    sim.weatherFromMetar(dec);
    if (!sim.wxScenario && !(dec.wind && dec.wind.dir != null) && metar && typeof metar.wdir === "number") sim.setWind({ dir: metar.wdir, spd: metar.wspd || 0, gust: metar.wgst || 0 });
    if (settings.lvp) { sim.lvpManual = true; sim.setLvp(true, "manual"); }
    if (settings.wx && settings.wx !== "live" && !sim.wxScenario) sim.setWxScenario(settings.wx);
    renderOps();
  }

  // ---------- ATIS ----------
  let atisOn = false;
  function utcClock() { const d = new Date((sim ? sim.clockUtc + sim.t * 1000 : Date.now())); return `${String(d.getUTCHours()).padStart(2, "0")}${String(d.getUTCMinutes()).padStart(2, "0")}`; }
  function atisText() {
    if (!sim || !apt) return "";
    const remarks = [...(sim.atisRemarks || [])];
    for (const r of sim.closedRunways) remarks.push(`Runway ${apt.runways[r].label} closed`);
    if (sim.deiceNeeded) remarks.push("De-icing in progress, expect delays");
    if (sim.rwyChange && !sim.rwyChange.done) remarks.push(`Runway change in progress, runway ${sim.rwyChange.to.name} in use`);
    if (sim.fod) remarks.push(`Runway ${apt.runways[sim.fod.rwy].label} inspection pending`);
    return buildAtis({ icao: apt.icao, name: apt.callName, letter: sim.atisLetter(), rwy: sim.depEnd.name, arrRwy: sim.arrEnd.name,
      metar: currentMetar(), region: sim.region, utc: utcClock(), lvp: !!(sim.lvp), remarks });
  }
  function startAtis() { atisOn = true; $("atisListen").classList.add("on"); $("atisListen").textContent = "■ ATIS"; radio.playAtis(atisText()); }
  function stopAtis() { atisOn = false; $("atisListen").classList.remove("on"); $("atisListen").textContent = "▶ ATIS"; radio.stopAtis(); }
  $("atisListen").addEventListener("click", () => (atisOn ? stopAtis() : startAtis()));

  function renderAtis() {
    if (!sim) return;
    const m = metar || {};
    const raw = currentMetar();
    const dec = parseMetar(raw);
    const qnh = dec.qnh || (m.altim ? Math.round(m.altim) : null);
    const rvr = raw.match(/\bR\d\d[LRC]?\/[PM]?\d{4}/g);
    const txt = atisText();
    const scen = sim.wxScenario ? ` <b class="warnline">WX SCENARIO</b>` : "";
    $("atisBox").innerHTML = `<span>ATIS <b>${sim.atisLetter()}</b></span><span>RWY ${esc(sim.depEnd.name)}</span>` +
      `<span>${windText()}</span>${qnh ? `<span>Q${qnh}</span>` : ""}<span class="raw" title="${esc(raw)}">${esc(raw || "no METAR")}</span>${scen}`;
    $("atisBox").title = txt;
    const closed = [...sim.closedRunways].map(r => apt.runways[r].label);
    $("wxPanel").innerHTML = `WIND <b>${windText()}</b><br>QNH <b>${qnh || "—"}</b> · VIS <b>${esc(dec.cavok ? "CAVOK" : dec.vis != null ? (dec.vis >= 9999 ? "10km+" : dec.vis + " m") : m.visib ?? "—")}</b>${rvr ? `<br>RVR <b>${esc(rvr.join(" "))}</b>` : ""}` +
      `${dec.wx.length ? `<br>WX <b>${esc(dec.wx.map(x => x.int + x.codes.join("")).join(" "))}</b>` : ""}${dec.temp != null ? `<br>T/DP <b>${dec.temp}/${dec.dew ?? "—"}</b>` : ""}` +
      `<br>RWY <b>${esc(sim.depEnd.name)}</b> · ATIS <b>${sim.atisLetter()}</b>${sim.lvp ? ' · <b class="warnline">LVP</b>' : ""}${sim.deiceNeeded ? ' · <b class="warnline">DE-ICE</b>' : ""}` +
      `${closed.length ? `<br><b class="warnline">RWY ${esc(closed.join(" "))} CLOSED</b>` : ""}${sim.rwyChangeHint ? `<br><b class="warnline">RWY CHANGE → ${esc(sim.rwyChangeHint)}?</b>` : ""}${sim.wxOverride && sim.wxOverride.note ? `<br><span class="muted">${esc(sim.wxOverride.note)}</span>` : ""}` +
      `<br><span class="muted atistxt" title="${esc(txt)}">${esc(txt.slice(0, 90))}…</span>`;
    if (apt && apt.freq.atis) $("atisListen").title = `Listen to the ATIS loop (${fmtFreq(apt.freq.atis.mhz)})`;
  }
  /** Operational panels: departure sequence / arrival spacing (D4) and the checklist of a running abnormal event (D7). */
  function renderSeq() {
    const el = $("seqPanel");
    if (!sim || !settings.seq) { el.classList.add("hidden"); return; }
    const deps = departureSequence(sim, sim.depEnd, sim.recat), arrs = arrivalSpacing(sim, sim.arrEnd, sim.recat);
    if (!deps.length && !arrs.length) { el.classList.add("hidden"); return; }
    el.classList.remove("hidden");
    const st = (s) => ({ lined_up: "LUW", lining: "LU", lineup: "LU", holding: "HOLD", cond_lineup: "COND", taxi: "TAXI" }[s] || s);
    el.innerHTML = `<div class="hd">Departures ${esc(sim.depEnd.name)}${sim.recat ? " · RECAT-EU" : ""}</div>` +
      deps.slice(0, 8).map((d, i) => `<div><b>${i + 1}</b> ${esc(d.a.cs)} <span class="muted">${esc(d.a.type)} ${d.a.wtc}</span> ${st(d.status)}` +
        `${d.wait > 0 ? ` <span class="bad">wake ${Math.round(d.wait)}s</span>` : ""}${d.ctot ? ` <span class="${d.ctot.ok ? "ok" : "bad"}" title="CTOT ${d.acdm.ctot}">CTOT ${esc(d.ctot.text)}</span>` : ""}` +
        `${d.a.hotUntil != null ? ` <span class="${d.a.hotUntil - sim.t > 0 ? "ok" : "bad"}">HOT ${Math.max(0, Math.round((d.a.hotUntil - sim.t) / 60))}m</span>` : ""}` +
        ` <span class="muted" title="TOBT ${d.acdm.tobt} · TSAT ${d.acdm.tsat} · TTOT ${d.acdm.ttot}">TSAT ${d.acdm.tsat}</span></div>`).join("") +
      (arrs.length ? `<div class="hd">Arrivals ${esc(sim.arrEnd.name)}</div>` + arrs.slice(0, 8).map(x => `<div>${esc(x.a.cs)} <span class="muted">${esc(x.a.type)} ${x.a.wtc}</span> ${x.nm.toFixed(1)} NM` +
        `${x.gapNm != null ? ` <span class="${x.short ? "bad" : "ok"}">+${x.gapNm.toFixed(1)} NM / ${Math.round(x.gapS)} s${x.short ? " < " + x.need : ""}</span>` : ""}</div>`).join("") : "");
  }
  let checklist = null;
  function showChecklist(kind, items, title) {
    checklist = { kind, items, title, done: items.map(() => false) };
    renderChecklist();
  }
  function renderChecklist() {
    const el = $("checkPanel");
    if (!checklist) { el.classList.add("hidden"); return; }
    el.classList.remove("hidden");
    el.innerHTML = `<div class="hd">${esc(checklist.title)} <button type="button" id="checkClose" title="Close">×</button></div>` +
      checklist.items.map((it, i) => `<label><input type="checkbox" data-i="${i}" ${checklist.done[i] ? "checked" : ""}> ${esc(it)}</label>`).join("");
    el.querySelector("#checkClose").addEventListener("click", () => { checklist = null; renderChecklist(); });
    el.querySelectorAll("input").forEach(cb => cb.addEventListener("change", () => { checklist.done[+cb.dataset.i] = cb.checked; }));
  }
  function renderOps() { renderAtis(); renderSeq(); }
  /** Live METAR: every 10 minutes; a changed observation rolls the ATIS letter and updates the wind. */
  async function pollMetar() {
    if (!apt) return;
    try {
      const m = await (await fetch(`/api/metar/${apt.icao}`)).json();
      if (m && m.rawOb && (!metar || metar.rawOb !== m.rawOb)) {
        const first = !metar;
        metar = m;
        applyWeather();
        if (sim && !first) { sim.rollAtis(); sysLog(`New METAR: ${m.rawOb}`); }
        renderAtis();
      }
    } catch { /* offline */ }
  }
  setInterval(pollMetar, 600000);

  // ---------- positions, tabs, views ----------
  function staffedKeys() { return sim && sim.split ? POS_ORDER.filter(k => sim.userWorks(k)) : ["ALL"]; }
  function renderTabs() {
    if (!sim) return;
    const keys = sim.split ? POS_ORDER : ["ALL"];
    $("posTabs").innerHTML = keys.map(k => {
      const ai = sim.split && !sim.userWorks(k);
      const label = k === "ALL" ? "DEL/GND/TWR" : k;
      const mon = ai ? `<button class="mon${radio.monitor.has(k) ? " on" : ""}" data-mon="${k}" title="${radio.monitor.has(k) ? "Monitoring this frequency (quiet) — click to stop" : "Monitor this frequency (quiet)"}">${radio.monitor.has(k) ? "🔈" : "🔇"}</button>` : "";
      return `<div class="tab${k === activePos ? " on" : ""}${ai ? " ai" : ""}" data-pos="${k}" title="${ai ? "AI controller" : "you"}">${label}` +
        `${unread[k] ? `<span class="badge">${unread[k]}</span>` : ""}${mon}<button class="pop" data-pop="${k}" title="Pop out">⧉</button></div>`;
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
    $("delPanel").classList.toggle("hidden", !(radar.view === "DEL" || activePos === "DEL"));
  }
  function txPosition() { if (!sim || !sim.split) return "ALL"; return sim.userWorks(activePos) ? activePos : staffedKeys()[0]; }
  function setActive(k) { activePos = k; unread[k] = 0; setView(DEFAULT_VIEW[k] || "GND"); renderTabs(); renderLog(); }
  function setView(v) {
    radar.setView(v);
    $("wxPanel").classList.toggle("hidden", v !== "TWR");
    $("viewTabs").querySelectorAll("button").forEach(b => b.classList.toggle("on", b.dataset.view === v));
    if (sim) renderPosHead();
    renderDel();
  }

  $("posTabs").addEventListener("click", (e) => {
    const pop = e.target.closest("[data-pop]");
    if (pop) { e.stopPropagation(); popOut(pop.dataset.pop); return; }
    const mon = e.target.closest("[data-mon]");
    if (mon) {
      e.stopPropagation();
      const k = mon.dataset.mon;
      if (radio.monitor.has(k)) radio.monitor.delete(k); else radio.monitor.add(k);
      settings.monitor = [...radio.monitor]; save(); renderTabs();
      sysLog(radio.monitor.has(k) ? `Monitoring ${posCs(k)} quietly.` : `Stopped monitoring ${posCs(k)}.`);
      return;
    }
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

  // ---------- Delivery view ----------
  function suggestionFor(a) {
    const sg = sim.suggestDeparture(a);
    const code = (a.stripData && a.stripData.sq) || a.assignedSq || sim.squawks.peek(sim.t);
    return { ...sg, code };
  }
  function renderDel() {
    if (!sim || $("delPanel").classList.contains("hidden")) return;
    const req = sim.ac.filter(a => a.kind === "dep" && !a.ga && ["clr_req", "parked", "cleared"].includes(a.state) && (a.lastCall != null || a.state === "cleared"));
    $("clrList").innerHTML = req.length ? req.map(a => {
      const sg = suggestionFor(a);
      const waiting = a.state === "cleared" ? "cleared" : `${Math.round(sim.t - (a.reqAt ?? a.lastCall ?? sim.t))}s`;
      return `<div class="clr${a.id === selectedId ? " sel" : ""}" data-id="${a.id}"><span class="cs">${esc(a.cs)}</span>` +
        `<span>${esc(a.type)}/${a.wtc} → ${esc(a.other[0])} ${esc(a.other[1])} · stand ${esc(a.stand ? a.stand.name : "")}</span><span class="st">${waiting}</span>` +
        `<span class="sg">${sg.sid ? "SID " + esc(sg.sid) : "no SID (radar vectors)"} · climb ${sg.climb} ft · squawk ${esc(sg.code)} ${a.state !== "cleared" ? `<button data-read="${a.id}" title="Put the clearance in the command line">Read clearance</button>` : ""}</span></div>`;
    }).join("") : `<div class="muted small">No pending requests.</div>`;
    const a = sim.ac.find(x => x.id === selectedId);
    const ed = document.activeElement && $("fpEditor").contains(document.activeElement);
    if (ed) return;
    if (!a || a.kind !== "dep") { $("fpEditor").innerHTML = "Select a departure."; return; }
    const d = a.stripData || {};
    const sg = suggestionFor(a);
    $("fpEditor").innerHTML = `<span>Callsign</span><b>${esc(a.cs)} (${esc(a.nat ? NAT_NAME[a.nat] || a.nat : "")})</b>` +
      `<span>Type</span><span>${esc(a.type)}/${a.wtc}</span><span>Route</span><span>${esc(apt.icao)} → ${esc(a.other[0])} ${esc(a.other[1])}</span>` +
      `<span>SID</span><input data-f="sid" value="${esc(d.sid ?? a.sid ?? "")}" placeholder="${esc(sg.sid ? sg.sid + " (suggested)" : "flight planned route")}">` +
      `<span>CFL</span><input data-f="cfl" value="${esc(d.cfl ?? (a.cfl || sg.climb || 5000))}">` +
      `<span>Squawk</span><input data-f="sq" value="${esc(d.sq ?? a.assignedSq ?? "")}" placeholder="${esc(sg.code)} (next free)">` +
      `<span></span><span class="muted small">${esc(sg.note || "")}</span>`;
  }
  $("fpEditor").addEventListener("change", (e) => { const f = e.target.dataset.f; if (f) stripAction({ id: selectedId, field: f, value: e.target.value.trim() }); });
  $("clrList").addEventListener("click", (e) => {
    const b = e.target.closest("[data-read]");
    if (b) { const a = sim.ac.find(x => x.id === +b.dataset.read); if (a) { select(a); $("cmd").value = clearanceText(a); $("cmd").focus(); } return; }
    const s = e.target.closest("[data-id]"); if (s) select(sim.ac.find(a => a.id === +s.dataset.id));
  });

  // ---------- aircraft info panel ----------
  function select(a) {
    selectedId = a ? a.id : null;
    if (a) { $("cmd").value = `${callsignText(a)} `; $("cmd").focus(); }
    renderBoard(); renderDel(); renderInfo();
  }
  radar.onSelect = (id) => select(sim && sim.ac.find(a => a.id === id));

  function renderInfo() {
    const el = $("acInfo");
    const a = sim && sim.ac.find(x => x.id === selectedId);
    if (!a) { el.classList.add("hidden"); el.innerHTML = ""; return; }
    if (el.contains(document.activeElement) && document.activeElement.tagName === "BUTTON") return;
    el.classList.remove("hidden");
    const pos = txPosition();
    const nx = nextExpected(sim, a, pos);
    const kv = (rows) => `<div class="kv">${rows.filter(r => r[1] != null && r[1] !== "").map(([k, v]) => `<span>${esc(k)}</span><b>${v}</b>`).join("")}</div>`;
    const voice = a.cast && a.cast[0] && a.cast[0].id ? a.cast[0].id.replace(/^(\w+):/, "$1 · ") : (radio.useServer() ? "casting…" : "browser voice");
    const crew = a.crew && a.crew[0] ? `${a.nat ? NAT_NAME[a.nat] || a.nat : "?"}${a.crew[0].gender === "F" ? " ♀" : ""}` : "";
    const iss = issueMarkers(a, sim.t);
    const h = (history[a.cs] || []).slice(-8);
    const lights = `<div class="sec">Light gun (ICAO Annex 2)</div><div class="btns">` +
      (a.onGround
        ? `<button class="g" data-cmd="light green flashing" title="cleared to taxi / cross">green flashing</button><button class="g" data-cmd="light green steady" title="cleared for takeoff">green steady</button>` +
          `<button class="r" data-cmd="light red steady" title="stop">red steady</button><button class="r" data-cmd="light red flashing" title="taxi clear of the landing area">red flashing</button><button class="w" data-cmd="light white flashing" title="return to your starting point">white flashing</button>`
        : `<button class="g" data-cmd="light green steady" title="cleared to land">green steady</button><button class="g" data-cmd="light green flashing" title="return for landing">green flashing</button>` +
          `<button class="r" data-cmd="light red steady" title="give way, continue circling">red steady</button><button class="r" data-cmd="light red flashing" title="aerodrome unsafe, do not land">red flashing</button>`) +
      (a.onGround && !a.veh ? `<button data-cmd="send follow-me" title="dispatch the follow-me car">🚗 Send follow-me</button>` : "") + `</div>`;
    el.innerHTML = `<h3><span>${esc(a.cs)} <span class="muted">${esc(a.type)}${a.wtc && !a.veh ? "/" + a.wtc : ""}</span>${a.nordo ? ' <span class="alertline">RCF 7600</span>' : ""}${a.mayday ? ' <span class="alertline">MAYDAY</span>' : ""}</span><span class="x" data-close title="Close">✕</span></h3>` +
      `<div class="sec">${esc(statePhrase(a))}</div>` +
      (a.veh ? kv([["Vehicle", esc(a.vtype)], ["Task", esc(statePhrase(a))], ["Frequency", esc(a.freq)]]) :
      kv([
        ["Flight plan", a.kind === "arr" ? `${esc(a.other[0])} → ${esc(apt.icao)}` : a.kind === "ovf" ? `${esc(a.other[0])} → ${esc(a.other[1])}` : `${esc(apt.icao)} → ${esc(a.other[0])} ${esc(a.other[1])}${a.ga ? " (VFR)" : ""}`],
        ["Clearance", a.kind === "dep" ? (a.ifr && a.assignedSq ? `cleared${a.sid ? " via " + esc(a.sid) : ""}, ${a.cfl >= 6000 ? "FL" + a.cfl / 100 : a.cfl + " ft"}, sq ${esc(a.assignedSq)}` : a.ga ? "VFR" : "not yet") : a.kind === "arr" ? (a.landClr ? "cleared to land " + esc(a.end.name) : a.appCleared ? "ILS " + esc(a.end.name) : "—") : ""],
        ["Squawk", `${esc(a.squawk || "")}${a.assignedSq && a.assignedSq !== a.squawk ? ` <span class="warnline">(assigned ${esc(a.assignedSq)})</span>` : ""} ${a.xpdr === "C" ? "mode C" : a.xpdr === "S" ? "standby" : a.xpdr === "A" ? "mode A" : ""}`],
        ["Ground", a.onGround ? `${a.stand ? "stand " + esc(a.stand.name) : a.standName ? "from " + esc(a.standName) : ""}${a.viaText ? " · via " + esc(a.viaText) : ""}${a.atStop && a.holdRwyName ? " · holding short " + esc(a.holdRwyName) : ""}${a.holdPos ? " · holding position" : ""}` : ""],
        ["Tower", a.kind === "dep" ? `runway ${esc((a.depEnd || sim.depEnd).name)}${a.toClr ? " · cleared for takeoff" : ""}` : a.kind === "arr" ? `runway ${esc((a.end || sim.arrEnd).name)}${a.dthr != null || a.state === "final" ? " · " + (sim.distToThr(a) / 1852).toFixed(1) + " NM" : ""}` : ""],
        ["Frequency", a.freq === "ALL" ? "combined" : a.freq === "LOST" ? "wrong frequency" : esc(a.freq)],
        ["Crew", `${esc(crew)} · ${esc(voice)}`],
        ["Waiting", a.reqAt != null ? `${Math.round(sim.t - a.reqAt)} s` : null],
        ["Issues", iss.length ? iss.map(i => `<span class="${i.level}line">${esc(i.t)}</span>`).join(" ") : null],
        ["No radio", a.nordo && a.lastWant ? `would say: “${esc(a.lastWant)}”` : null],
      ])) +
      `<div class="sec">Next expected</div>` +
      (nx.pilot ? `<div class="small">pilot: ${esc(nx.pilot)}</div>` : "") +
      (nx.atc ? `<div class="next" data-cmd="${esc(nx.atc)}" title="Click to put it in the command line">${esc(nx.atc)}</div>` : `<div class="small muted">${esc(nx.why || "nothing due")}</div>`) +
      (nx.atc && nx.why ? `<div class="small muted">${esc(nx.why)}</div>` : "") +
      (a.nordo || !a.onGround || a.kind !== "ovf" ? lights : "") +
      `<div class="sec">Radio history</div><div class="hist">${h.length ? h.map(x => `<div class="${x.who}"><span class="t">${esc(x.t)}</span> ${esc(x.who === "pilot" ? a.cs : x.who === "ai" ? "AI" : "me")}: ${esc(x.text)}</div>`).join("") : '<div class="muted">nothing yet</div>'}</div>` +
      (!a.veh && !a.human ? `<div class="btns"><button data-ev="7600" title="training: simulate a radio failure on this aircraft">simulate 7600</button><button data-ev="7700" title="training: simulate an emergency">simulate 7700</button></div>` : "");
  }
  $("acInfo").addEventListener("click", (e) => {
    const a = sim && sim.ac.find(x => x.id === selectedId);
    if (e.target.closest("[data-close]")) { selectedId = null; renderInfo(); renderBoard(); return; }
    const c = e.target.closest("[data-cmd]");
    if (c && a) {
      const text = `${callsignText(a)} ${c.dataset.cmd}`;
      if (c.classList.contains("next")) { $("cmd").value = text; $("cmd").focus(); } else transmit(text, undefined, "panel");
      return;
    }
    const ev = e.target.closest("[data-ev]");
    if (ev && a) { sim.triggerEvent(ev.dataset.ev, a); renderInfo(); }
  });

  function clearanceText(a, code) {
    if (!a) return "";
    const d = a.stripData || {};
    const sg = sim.suggestDeparture(a);
    code = code || d.sq || a.assignedSq || sim.squawks.peek(sim.t);
    const cfl = d.cfl ?? a.cfl ?? sg.climb ?? 5000;
    const alt = String(cfl).toUpperCase().startsWith("F") ? `flight level ${String(cfl).slice(1)}` : `${cfl} feet`;
    const sid = d.sid || a.sid || sg.sid;
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
    const pp = parse(text, sim.ac, sim.ac.find(a => a.id === selectedId));
    const action = pp.ins.length && pp.ins.every(i => i.t === "light" || i.t === "followMe");
    if (action) {
      // a light-gun signal / dispatching the follow-me is not a radio call
      if (!pp.ac) { sysLog("Light signal: which aircraft? Start with the callsign."); return; }
      addLog(pos, "sys", `(${esc(source === "typed" ? "action" : source)}) ${esc(text)}`);
      sim.respond(pp.ac, pp.ins, { text: pp.normalized, pos });
      renderInfo();
      return;
    }
    radio.controller(text, pos);
    if (source !== "typed" && source !== "voice") addLog(pos, "sys", `(${esc(source)})`);
    bridges.transmission({ from: "atc", text, pos });
    if (settings.coach) showCoach(coach({ text, parsed: pp, sim, pos, lang: settings.lang }), pos);
    countCoach(pos, pp);
    if (!pp.ac) { addLog(pos, "sys", "No aircraft answered (callsign not recognised)."); return; }
    if (pp.ac.human) return; // a real pilot: it went out as text on XRadio
    if (!sim.hears(pp.ac, pos)) return; // not on this frequency: nobody answers
    if (!pp.explicit) addLog(pos, "sys", `(no callsign — assumed ${esc(pp.ac.cs)})`);
    const r = sim.respond(pp.ac, pp.ins, { text: pp.normalized, pos, abbrevUsed: pp.abbrev });
    renderInfo();
    if (!r) return;
    radio.enqueue({ from: "pilot", ac: pp.ac, text: r.d, say: r.s, pos: pp.ac.freq === "LOST" ? pos : pp.ac.freq, speaker: Math.random() < 0.8 ? 0 : 1, kind: "readback" });
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
    $("cmd").value = a ? `${callsignText(a)} ` : "";
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

  // ---------- voices: server engines, banner, pill ----------
  async function refreshVoices() {
    const st = await radio.checkServer();
    renderVoiceBanner(st); renderVoicePill();
    if ($("settings").open) renderEngines(st);
    return st;
  }
  function renderVoiceBanner(st) {
    const b = $("voiceBanner");
    if (!settings.voices) { b.classList.add("hidden"); return; }
    if (st.neural) {
      const avail = (st.engines || []).filter(e => e.available).map(e => e.name).join(", ");
      b.className = "banner ok main-only"; b.innerHTML = `Neural voices ready: <b>${esc(avail)}</b> — pilots speak through the radio chain. <button type="button" data-open-settings>Voices…</button>`;
      if (!radio.bannerSeen) { b.classList.remove("hidden"); setTimeout(() => b.classList.add("hidden"), 8000); radio.bannerSeen = true; } else b.classList.add("hidden");
    } else {
      b.className = "banner main-only";
      b.innerHTML = `${esc(st.banner || "No neural voice engine — using the browser's voices.")} <button type="button" data-open-settings>Settings → Voices</button> <button type="button" data-recheck>Re-check</button>`;
      b.classList.remove("hidden");
    }
  }
  function renderVoicePill() {
    const p = $("voicePill");
    const s = radio.server;
    const last = radio.lastEngine;
    if (!settings.voices) { p.textContent = "Voices: off"; p.className = "pill main-only"; return; }
    if (!s.checked) { p.textContent = "Voices: …"; p.className = "pill main-only"; return; }
    const eng = last ? last.engine : (s.neural ? (s.engines || []).find(e => e.available)?.name : "browser");
    p.textContent = `Voices: ${eng || "browser"}${last && last.voice ? " · " + last.voice.replace(/^\w+:/, "").slice(0, 26) : ""}`;
    p.className = "pill main-only" + (s.neural && eng !== "browser" ? " on" : "");
    p.title = s.neural ? `Engines available: ${(s.engines || []).filter(e => e.available).map(e => e.name).join(", ")}${last ? `\nLast transmission: ${last.engine} ${last.voice || ""}` : ""}` : (s.banner || "");
  }
  function renderEngines(st) {
    st = st || radio.server;
    const rows = (st.engines || []).map(e => `<tr><td class="${e.available ? "ok" : "no"}">${e.available ? "●" : "○"} ${esc(e.name)}</td><td>${esc(e.available ? (e.reason || "ready") : e.reason || "")}${e.error ? ` <span class="muted">(${esc(e.error)})</span>` : ""}</td></tr>`).join("");
    $("voiceEngines").innerHTML = `<table>${rows || "<tr><td>voice server unreachable</td></tr>"}</table>` +
      (st.cache ? `<div class="muted">cache hits ${st.cache.hits} · renders ${st.cache.misses}${radio.lastEngine ? " · last: " + esc(radio.lastEngine.engine) : ""}</div>` : "");
    if (st.config) { $("azureRegion").value = st.config.azure_region || ""; $("azureKey").placeholder = st.config.azure_key ? "(key stored)" : "free tier key"; $("elevenKey").placeholder = st.config.eleven_key ? "(key stored)" : ""; }
    renderPiper();
  }
  async function renderPiper() {
    const el = $("piperList");
    try {
      const r = await fetch("/api/tts/piper/catalog"); const j = await r.json();
      if (j.error) { el.innerHTML = `<span class="muted">${esc(j.error)}</span>`; return; }
      const pick = (j.voices || []).filter(v => v.quality !== "x_low" && (v.installed || ["en_GB", "en_US", "et_EE", "fi_FI", "lv_LV", "lt_LT", "de_DE", "fr_FR", "sv_SE", "nb_NO", "da_DK", "pl_PL", "es_ES", "it_IT", "nl_NL"].includes(v.name.split("-")[0])));
      el.innerHTML = pick.map(v => `<span>${esc(v.name)} <span class="muted">${v.size_mb} MB${v.speakers > 1 ? " · " + v.speakers + " voices" : ""}</span> ${v.installed ? '<span class="ok">installed</span>' : typeof v.progress === "number" && v.progress < 100 ? `${v.progress}%` : `<button type="button" data-piper="${esc(v.name)}">download</button>`}</span>`).join("");
    } catch { el.innerHTML = ""; }
  }
  $("voiceBanner").addEventListener("click", (e) => {
    if (e.target.closest("[data-open-settings]")) { fillSettings(); $("settings").showModal(); }
    if (e.target.closest("[data-recheck]")) refreshVoices();
  });
  $("voiceRefresh").addEventListener("click", () => fetch("/api/tts/voices?refresh=1").catch(() => {}).then(refreshVoices));
  $("saveKeys").addEventListener("click", async () => {
    const body = { azure_region: $("azureRegion").value.trim() };
    if ($("azureKey").value.trim()) body.azure_key = $("azureKey").value.trim();
    if ($("elevenKey").value.trim()) body.eleven_key = $("elevenKey").value.trim();
    await fetch("/api/tts/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch(() => {});
    $("azureKey").value = ""; $("elevenKey").value = "";
    refreshVoices();
  });
  $("piperList").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-piper]"); if (!b) return;
    await fetch("/api/tts/piper/download", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: b.dataset.piper }) }).catch(() => {});
    const t = setInterval(async () => { await renderPiper(); if (!$("settings").open) clearInterval(t); }, 2000);
    setTimeout(() => { clearInterval(t); refreshVoices(); }, 120000);
  });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshVoices(); });
  window.addEventListener("focus", () => refreshVoices());
  setInterval(refreshVoices, 60000);
  refreshVoices();

  // ---------- settings dialog ----------
  const bindings = [
    ["setAccents", "accents"], ["setRate", "rate"], ["setEffect", "effect"], ["setPreset", "preset"], ["setVoices", "voices", "checked"], ["setBlocked", "blocked", "checked"],
    ["setRbErr", "rbErr"], ["setSayAgain", "sayAgain"], ["setOldAtis", "oldAtis"], ["setEvents", "events", "checked"],
    ["depRate", "dep"], ["arrRate", "arr"], ["setCoach", "coach", "checked"], ["setLang", "lang"], ["graph", "graph", "checked"],
    ["setOccupancy", "occupancy"], ["setVehicles", "vehicles"], ["setWaves", "waves", "checked"], ["setOsm", "osm", "checked"], ["setRealMix", "realMix", "checked"], ["setNight", "nightAuto", "checked"],
    ["setWx", "wx"], ["setLvp", "lvp", "checked"], ["setRecat", "recat", "checked"], ["setVfr", "vfr"], ["setAbnormals", "abnormals", "checked"], ["setAbnormalRate", "abnormalRate"], ["setSeq", "seq", "checked"],
  ];
  function fillSettings() {
    for (const [id, k, prop] of bindings) $(id)[prop || "value"] = settings[k];
    $("setRateV").textContent = (+settings.rate).toFixed(2); $("setEffectV").textContent = Math.round(settings.effect * 100) + "%";
    $("setOccupancyV").textContent = settings.occupancy + "%";
    $("setAbnormalRateV").textContent = settings.abnormalRate + "/h";
    if (+settings.vehicles < 0 && sim) $("setVehicles").value = sim.serviceVehicles;
    const x = settings.xr;
    $("xrEnabled").checked = x.enabled; $("xrHost").value = x.host; $("xrPort").value = x.port; $("xrPass").value = x.password;
    $("xrCs").value = x.cs || (apt ? `${apt.icao}_TWR` : ""); $("xrFreq").value = x.freq || (apt && apt.freq.tower ? fmtFreq(apt.freq.tower.mhz) : "");
    $("xrAi").checked = x.ai; $("xrHumans").checked = x.humans; $("xrText").checked = x.text; $("xrVoice").checked = x.voice;
    $("coachToggle").checked = settings.coach;
    renderVoiceTable(); renderEngines();
  }
  function readSettings(changedId) {
    for (const [id, k, prop] of bindings) { const v = $(id)[prop || "value"]; settings[k] = prop ? v : (isNaN(+v) || v === "" ? v : +v); }
    if (changedId === "setPreset") { settings.effect = PRESET_EFFECT[settings.preset] ?? settings.effect; $("setEffect").value = settings.effect; }
    settings.xr = { enabled: $("xrEnabled").checked, host: $("xrHost").value.trim() || "127.0.0.1", port: +$("xrPort").value || 49100,
      password: $("xrPass").value, cs: $("xrCs").value.trim().toUpperCase(), freq: $("xrFreq").value.trim(), ai: $("xrAi").checked,
      humans: $("xrHumans").checked, text: $("xrText").checked, voice: $("xrVoice").checked };
    save(); applyRadioSettings();
    if (sim) {
      sim.rates = { readbackError: settings.rbErr / 100, sayAgain: settings.sayAgain / 100, oldAtis: settings.oldAtis / 100 };
      sim.events = settings.events; sim.depPerHour = +settings.dep; sim.arrPerHour = +settings.arr;
      sim.waves = !!settings.waves; sim.occupancy = (+settings.occupancy || 0) / 100;
      if (+settings.vehicles >= 0) sim.serviceVehicles = +settings.vehicles;
      if (changedId === "setRealMix") applyTraffic();
      if (changedId === "setOccupancy" && sim.occupancy > sim.ac.filter(a => a.state === "parked").length / Math.max(1, apt.stands.length)) sim.populate(sim.occupancy - sim.ac.filter(a => a.state === "parked").length / Math.max(1, apt.stands.length));
      sim.recat = !!settings.recat; sim.vfrPerHour = +settings.vfr || 0;
      sim.abnormals = { on: !!settings.abnormals, perHour: +settings.abnormalRate || 2 };
      if (changedId === "setAbnormals" || changedId === "setAbnormalRate") sim.scheduleAbnormal();
      if (changedId === "setLvp") { sim.lvpManual = !!settings.lvp; if (settings.lvp) sim.setLvp(true, "manual"); else applyWeather(); }
      if (changedId === "setWx") { sim.setWxScenario(settings.wx === "live" ? null : settings.wx); if (settings.wx === "live") applyWeather(); renderOps(); }
      if (changedId === "setSeq") renderSeq();
    }
    $("setAbnormalRateV").textContent = settings.abnormalRate + "/h";
    if (changedId === "setOsm" && apt) loadOsm(apt.icao);
    if (changedId === "setNight") updateSky();
    $("setOccupancyV").textContent = settings.occupancy + "%";
    radar.showGraph = settings.graph; radar.staticKey = null;
    $("coachToggle").checked = settings.coach; renderCoach();
    $("setRateV").textContent = (+settings.rate).toFixed(2); $("setEffectV").textContent = Math.round(settings.effect * 100) + "%";
    renderVoicePill();
  }
  function renderVoiceTable() {
    const rows = radio.voiceTable();
    $("voiceTable").innerHTML = `<table><tr><th>Nationality</th><th>Browser voice</th><th></th></tr>` + rows.map(r =>
      `<tr><td>${esc(r.name)}</td><td>${esc(r.voice)} <span class="muted">${esc(r.lang)}</span></td>` +
      `<td class="${r.fallback ? "fb" : "nat"}">${r.english ? (r.fallback ? "English fallback" : "native English") : r.native ? (r.respell ? "native + respelling" : "native voice") : "fallback (English)"}</td></tr>`).join("") + "</table>";
  }
  $("settingsBtn").addEventListener("click", () => { fillSettings(); $("settings").showModal(); refreshVoices(); });
  $("settings").addEventListener("change", (e) => {
    readSettings(e.target.id);
    if (e.target.id && e.target.id.startsWith("xr")) { xrErrShown = false; bridges.configureXr(settings.xr); }
    if (e.target.id === "setAccents") renderVoiceTable();
    if (e.target.id === "setVoices") refreshVoices();
  });
  $("settings").addEventListener("input", (e) => { if (e.target.type === "range") readSettings(e.target.id); });
  $("testVoices").addEventListener("click", () => radio.testVoices(["GB", "US", "IE", "EE", "FI", "LV", "LT", "DE", "FR"]));
  // abnormal events on demand (D7) and the operational buttons (D1/D2)
  document.querySelectorAll("[data-ev]").forEach(b => b.addEventListener("click", () => {
    if (!sim) return;
    const k = b.dataset.ev;
    let r = null;
    if (k === "inspect") r = sim.runwayInspection(sim.depEnd.rwy, "routine") ? "inspection" : null;
    else if (k === "rwychange") { const best = sim.bestEndForWind(); const to = best && best !== sim.depEnd ? best : sim.apt.runways[sim.depEnd.rwy].ends.find(e => e !== sim.depEnd); r = to && sim.changeRunway(to.name) ? "runway change to " + to.name : null; }
    else if (k === "stopbars") { const lit = !sim.apt.stopBars.some(x => x.lit); for (const x of sim.apt.stopBars) sim.setStopBar(x, lit, true); r = `stop bars ${lit ? "on" : "off"}`; }
    else r = sim.abnormalEvent(k);
    sysLog(r ? `Triggered: ${r}.` : `Nothing suitable for "${k}" right now (needs e.g. an arrival on final or a departure taxiing) — try again in a minute.`);
    $("settings").close();
  }));
  $("radioLab").addEventListener("click", () => radio.lab && radio.lab());
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
  $("rwySel").addEventListener("change", (e) => { if (sim) { sim.setRunway(e.target.value); renderAtis(); applyProcs(); sysLog(`Runway in use: ${e.target.value}`); } });
  $("speed").addEventListener("change", (e) => { speed = +e.target.value; });
  $("helpBtn").addEventListener("click", () => $("help").showModal());
  function setSpeed(n) { speed = n; $("speed").value = String(n); }

  // ---------- guide ----------
  Object.defineProperties(app, { apt: { get: () => apt }, sim: { get: () => sim } });
  Object.assign(app, {
    settings, select, setSpeed, openDebrief, windText, bestRunway, atisText, pollMetar,
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
      radar.draw({ ac: sim.snapshot(selectedId), arrEnd: sim.arrEnd, closed: sim.closedRunways, lvp: sim.lvp }, selectedId);
      slowT += dt; bcT += dt;
      if (slowT > 0.5) {
        slowT = 0;
        renderBoard(); renderDel(); renderTabs(); renderCoach(); renderInfo(); renderSeq();
        const st = sim.stats;
        $("status").textContent = `${fmtClock(sim)}  DEP ${st.departures}  ARR ${st.arrivals}  G/A ${st.goArounds}  ALERTS ${st.alerts}  AC ${sim.ac.length}` +
          (speed === 0 ? "  [PAUSED]" : speed > 1 ? `  [${speed}×]` : "");
      }
      if (bcT > 0.25) { bcT = 0; broadcast(false); }
    } else radar.draw({ ac: [], arrEnd: null }, null);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  loadAirport(params.get("icao") || store.get("tt.icao", "EETN"));
  // for debugging and automated tests
  window.TT = { get sim() { return sim; }, get apt() { return apt; }, get positions() { return positions; }, get procs() { return procs; }, transmit, parse, radio, radar, guide, app,
    settings, setActive, setView, select: (id) => select(sim && sim.ac.find(a => a.id === id)), openDebrief, bridges, loadAirport, refreshVoices,
    applyStaffing: (mode, keys) => { settings.staff = { mode, keys }; save(); updateStaffBtn(); createSim(); } };
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
    radar.setView(DEFAULT_VIEW[pos] || VIEWS[pos] ? (VIEWS[pos] ? pos : DEFAULT_VIEW[pos]) : "GND");
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
