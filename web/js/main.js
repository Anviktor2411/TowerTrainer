// Tower Trainer UI. Runs as the main window (owns the simulation) or as a pop-out position window
// (?popout=GND) that renders state received over BroadcastChannel and sends transmissions back.
import { Airport } from "./airport.js";
import { Sim } from "./sim.js";
import { Radio } from "./radio.js";
import { Radar, VIEWS } from "./render.js";
import { parse } from "./commands.js";
import { buildPositions, fmtFreq } from "./positions.js";
import { renderStrips, incomingFor } from "./strips.js";
import { suggestions } from "./autocomplete.js";
import { Relay, Intercom } from "./remote.js";
import { Ptt } from "./speech.js";
import { fetchOfp, importOfp, planUrl, renderOfp, routePoints } from "./simbrief.js";
import { BUILTIN, WX_CHOICES, allScenarios, findScenario, saveScenario, deleteScenario, exportScenarios, importScenarios, normalize, scenarioSettings, evaluate, career, recordResult, levelOpen, history as sessionHistory, addHistory, overallScore, sparkline } from "./career.js";
import { Recorder, frameAircraft, download, logsAsText } from "./replay.js";
import { coach, coachHints } from "./coach.js";
import { Bridges, XR_PILOT_HELP } from "./bridges.js";
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
  nick: "", layouts: {}, layout: "", chartsUrl: "",
  staff: { mode: "combined", keys: ["TWR"] },
  xr: { enabled: false, host: "127.0.0.1", port: 49100, password: "", cs: "", freq: "", ai: true, humans: true, text: true, voice: false,
    weather: "off", aiVoice: true, atisVoice: false, transcribe: false, tower: false },
  simbrief: { user: "", units: "kg", apiKey: "", autoFetch: true },
};

const radar = new Radar($("radar"));

if (POPOUT || params.get("join")) bootPopout(); else bootMain();

// =====================================================================================
//  MAIN WINDOW
// =====================================================================================
function bootMain() {
  const settings = { ...DEFAULTS, ...store.get("tt.settings", {}) };
  settings.staff = { ...DEFAULTS.staff, ...(settings.staff || {}) };
  settings.xr = { ...DEFAULTS.xr, ...(settings.xr || {}) };
  settings.simbrief = { ...DEFAULTS.simbrief, ...(settings.simbrief || {}) };
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
  const recorder = new Recorder();   // one frame per second, for replay and export (G1)
  let scenario = null, scenarioEndsAt = 0;
  const replay = { on: false, rec: null, logs: null, i: 0, playing: false, acc: 0, speedBefore: 1, lastShown: -1 };

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
    const src = replay.on && replay.rec ? (replay.logs[activePos] || []).slice(0, ((replay.rec.frames[replay.i] || {}).logN || {})[activePos] || 0) : (logs[activePos] || []);
    box.innerHTML = src.map(e => `<div class="${e.cls}">${e.html}</div>`).join("");
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
    // the pilot's OFP: the cached one, or at most one automatic fetch per page load when none is cached
    if (settings.simbrief.user && settings.simbrief.autoFetch && !ofpAutoDone) { ofpAutoDone = true; loadOfp(false).then(p => { if (!p) loadOfp(true); }); }
    else if (ofp) renderOfpPanel();
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
  // ---------- S1: the pilot's SimBrief OFP ----------
  let ofp = null, ofpAutoDone = false;
  function renderOfpPanel() { $("ofpBody").innerHTML = renderOfp(ofp, { user: settings.simbrief.user }); radar.setFlightRoute(routePoints(ofp, apt)); }
  async function loadOfp(refresh) {
    const user = settings.simbrief.user;
    $("ofpPanel").classList.remove("hidden");
    if (refresh && !user) { sysLog("SimBrief: enter your username or pilot ID in Settings → SimBrief."); renderOfpPanel(); return null; }
    try {
      const p = await fetchOfp({ user, refresh });
      if (p) { ofp = p; sysLog(`SimBrief OFP ${refresh ? "fetched" : "loaded"}: ${p.callsign} ${p.aircraft.type} ${p.origin.icao}→${p.destination.icao} ${p.route}.`); }
      else if (refresh) sysLog("SimBrief: nothing came back.");
    } catch (e) { sysLog(e.message); alertBox(e.message); }
    renderOfpPanel();
    return ofp;
  }
  $("ofpBtn").addEventListener("click", () => { const hidden = $("ofpPanel").classList.toggle("hidden"); if (!hidden) { if (ofp) renderOfpPanel(); else loadOfp(false); } });
  $("ofpFetch").addEventListener("click", () => loadOfp(true));
  $("ofpHide").addEventListener("click", () => $("ofpPanel").classList.add("hidden"));
  $("ofpPlan").addEventListener("click", async () => {
    if (!settings.simbrief.apiKey) {
      window.open("https://www.simbrief.com/system/dispatch.php?newflight=1", "_blank", "noopener");
      sysLog("SimBrief opened in a new tab: plan the flight there, then press Fetch latest OFP.");
      return;
    }
    const orig = prompt("Origin (ICAO)", apt ? apt.icao : ""); if (!orig) return;
    const dest = prompt("Destination (ICAO)", ofp ? ofp.destination.icao : ""); if (!dest) return;
    const type = prompt("Aircraft type (ICAO)", ofp ? ofp.aircraft.type : "A320"); if (!type) return;
    try {
      const url = await planUrl({ orig: orig.toUpperCase(), dest: dest.toUpperCase(), type: type.toUpperCase(), airline: ofp ? ofp.airline : "", fltnum: ofp ? ofp.flight_number : "", units: settings.simbrief.units === "lb" ? "LBS" : "KGS" }, settings.simbrief.apiKey);
      window.open(url, "_blank", "noopener");
      sysLog("SimBrief: the plan request was opened on SimBrief's page (official API form). Press Fetch latest OFP when it is done.");
    } catch (e) { sysLog(e.message); }
  });
  $("ofpImport").addEventListener("click", () => $("ofpFile").click());
  $("ofpFile").addEventListener("change", async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try { ofp = await importOfp(await f.text()); sysLog(`SimBrief OFP imported: ${ofp.callsign} ${ofp.origin.icao}→${ofp.destination.icao}.`); $("ofpPanel").classList.remove("hidden"); renderOfpPanel(); }
    catch (err) { sysLog("Import failed: " + err.message); }
    e.target.value = "";
  });
  $("ofpAdd").addEventListener("click", () => addPlanFlight());
  function addPlanFlight(kindWanted) {
    if (!ofp) { sysLog("SimBrief: fetch or import an OFP first."); return null; }
    if (!sim) return null;
    const here = apt.icao;
    const kind = kindWanted || (ofp.origin.icao === here ? "dep" : ofp.destination.icao === here ? "arr" : null);
    if (!kind) { sysLog(`SimBrief: the OFP is ${ofp.origin.icao}→${ofp.destination.icao}, this is ${here}. Load ${ofp.origin.icao} (departure) or ${ofp.destination.icao} (arrival) first.`); return null; }
    const a = sim.spawnFromPlan(ofp, kind);
    if (!a) { sysLog("SimBrief: no free stand that fits — try again in a moment."); return null; }
    sysLog(`${a.cs} (${a.type}/${a.wtc}${a.reg ? ", " + a.reg : ""}) added as ${kind === "dep" ? "a departure on stand " + (a.stand ? a.stand.name : "?") + " to " + a.other[0] : "an arrival from " + a.other[0]}: route ${a.route}${a.rfl ? ", " + (a.rfl >= 6000 ? "FL" + Math.round(a.rfl / 100) : a.rfl + " ft") : ""}${a.eobt ? ", EOBT " + a.eobt + "z" : ""}${kind === "dep" ? (() => { const sg = sim.suggestDeparture(a); return sg.sid ? ", suggested SID " + sg.sid + (sg.note ? " (" + sg.note + ")" : "") : ""; })() : ""}.`);
    select(a); renderBoard(); renderDel();
    return a;
  }
  app.ofp = () => ofp; app.loadOfp = loadOfp; app.setOfp = (p) => { ofp = p; renderOfpPanel(); }; app.addPlanFlight = addPlanFlight;

  // ---------- G3: procedures & charts ----------
  const procFilter = new Set();
  function renderCharts() {
    if (!apt) return;
    const rwy = sim ? sim.depEnd.name : "";
    const src = procs && procs.source;
    const url = (settings.chartsUrl || "https://skyvector.com/airport/{icao}").replace(/\{icao\}/gi, apt.icao);
    const list = (title, kind, arr) => arr.length ? `<h3>${title} (${arr.length})</h3>` + arr.map(p => {
      const rws = (p.runways && p.runways.length ? p.runways : Object.keys(p.rwy || {})).map(r => String(r).replace(/^RW/, "")).join(" ");
      const key = `${kind}:${p.name}`;
      return `<label class="proc">${kind ? `<input type="checkbox" data-proc="${esc(key)}" ${procFilter.has(key) ? "checked" : ""}>` : ""} <b>${esc(p.name)}</b> <span class="muted">${esc(rws)}${p.climb ? " · climb " + p.climb : ""}${p.exit ? " · " + esc(p.exit) : ""}${p.missed && p.missed.length ? " · missed approach " + p.missed.filter(l => l.fix).map(l => l.fix).join(" ") : ""}</span></label>`;
    }).join("") : "";
    $("chartsBody").innerHTML = `<p class="small muted">${src && src.kind !== "fallback" ? `Procedures from ${esc(src.label || src.kind)}${src.airac ? ", AIRAC " + esc(src.airac) : ""}${navInfo && navInfo.outdated ? " (older than the current cycle)" : ""}` : "No procedure data for this airport — point Settings → Navigation data at your Navigraph, X-Plane or EuroScope files; the trainer never bundles them."}. Runway in use <b>${esc(rwy)}</b>. Tick SIDs/STARs to show only those on the radar views (none ticked = all for the runway).</p>` +
      `<div class="row"><a href="${esc(url)}" target="_blank" rel="noopener">Charts for ${esc(apt.icao)} ↗</a> <a href="https://chartfox.org/${esc(apt.icao)}" target="_blank" rel="noopener">ChartFox ↗</a> <a href="https://www.navigraph.com/" target="_blank" rel="noopener">Navigraph ↗</a> <span class="muted small">(the chart link is a setting: Settings → Training)</span></div>` +
      list("SIDs", "sid", (procs && procs.sids) || []) + list("STARs", "star", (procs && procs.stars) || []) + list("Approaches", "", (procs && procs.apps) || []);
  }
  $("chartsBtn").addEventListener("click", () => { renderCharts(); $("chartsDialog").showModal(); });
  $("chartsBody").addEventListener("change", (e) => {
    const c = e.target.closest("[data-proc]"); if (!c) return;
    if (c.checked) procFilter.add(c.dataset.proc); else procFilter.delete(c.dataset.proc);
    applyProcs();
  });
  function applyProcs() {
    if (!sim || !apt) return;
    const rwy = sim.depEnd.name;
    sim.suggest = (a) => {
      const s = suggestSid(procs, rwy, { lat: apt.d.lat, lon: apt.d.lon, icao: apt.icao }, a.other, sim.region);
      if (a.plan) {   // S2: the pilot's OFP wins when its SID is one of this runway's; its cruise level is the filed RFL
        const sids = (procs && procs.sids) || [];
        const ok = a.planSid && sids.some(p => p.name === a.planSid && p.runways.some(r => runwayMatches(r, rwy)));
        return { ...s, sid: ok ? a.planSid : s.sid, rfl: a.rfl || 0, note: ok ? "SID from the OFP" : a.planSid ? `OFP SID ${a.planSid} is for runway ${a.plan.origin.rwy || "?"}; ${s.sid ? s.sid + " suggested" : "radar vectors"}` : s.note };
      }
      return s;
    };
    // the published missed approach of the runway in use (D4): legs with lat/lon from the CIFP
    sim.missedFor = (end) => {
      const app = (procs && procs.apps || []).find(p => p.missed && p.missed.length && p.missed.some(l => l.lat != null) &&
        (Object.keys(p.rwy || {}).some(k => runwayMatches(k, end.name)) || (p.runways || []).some(r => runwayMatches(r, end.name))));
      return app ? app.missed : null;
    };
    radar.setProcs(procs ? procLines(procs, rwy).filter(l => !procFilter.size || procFilter.has(`${l.kind}:${l.name}`)) : []);
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
      onRadio: (m) => { radio.enqueue(m); bridges.transmission(m); mp.radio(m); },
      onAlert: alertBox,
      onEvent: onSimEvent,
    });
    sim.depPerHour = +settings.dep; sim.arrPerHour = +settings.arr;
    recorder.start({ icao: apt.icao, staff: settings.staff });
    if (settings.xr.tower && !(mp.relay && mp.role === "host")) setTimeout(() => { if (sim && !(mp.relay && mp.role === "host")) mp.host(false, "TOWER"); }, 500);
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
  /** Positions worked by a human: me, or a remote controller in a multiplayer session. */
  function staffedKeys() { return sim && sim.split ? POS_ORDER.filter(k => sim.userWorks(k)) : ["ALL"]; }
  /** Positions I work myself (not an AI, not a remote controller). */
  function isMine(k) { return !!sim && sim.userWorks(k) && !sim.remoteStaff[k]; }
  function myKeys() { return sim && sim.split ? POS_ORDER.filter(isMine) : ["ALL"]; }
  function renderTabs() {
    if (!sim) return;
    const keys = sim.split ? POS_ORDER : ["ALL"];
    $("posTabs").innerHTML = keys.map(k => {
      const ai = sim.split && !sim.userWorks(k);
      const remote = sim.split && sim.remoteStaff[k];
      const label = k === "ALL" ? "DEL/GND/TWR" : k;
      const mon = ai || remote ? `<button class="mon${radio.monitor.has(k) ? " on" : ""}" data-mon="${k}" title="${radio.monitor.has(k) ? "Monitoring this frequency (quiet) — click to stop" : "Monitor this frequency (quiet)"}">${radio.monitor.has(k) ? "🔈" : "🔇"}</button>` : "";
      return `<div class="tab${k === activePos ? " on" : ""}${ai ? " ai" : ""}${remote ? " remote" : ""}" data-pos="${k}" title="${ai ? "AI controller" : remote ? "worked by " + esc(remote) : "you"}">${label}${remote ? `<span class="who">${esc(remote)}</span>` : ""}` +
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
  function txPosition() { if (!sim || !sim.split) return "ALL"; return isMine(activePos) ? activePos : (myKeys()[0] || staffedKeys()[0] || "TWR"); }
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
  /**
   * Any view in its own window (F3): a position (pos) and optionally a single panel of it -- "radar", "strips",
   * "del", "wx", "log", "chat", "seq". Placement comes from the saved layout (Window Management API on Chrome
   * puts it on the chosen screen; elsewhere the last known position is used).
   */
  function popOut(pos, panel = "", bounds = null) {
    const key = panel ? `${pos}:${panel}` : pos;
    const layout = settings.layouts[settings.layout || "default"] || {};
    const b = bounds || layout[key] || null;
    const feat = b ? `left=${b.x},top=${b.y},width=${b.w},height=${b.h}` : "width=1000,height=760";
    const w = window.open(`?popout=${pos}${panel ? "&panel=" + panel : ""}&icao=${apt ? apt.icao : ""}`, `tt-${key}`, feat);
    if (!w) { sysLog("Pop-up blocked — allow pop-ups for this page."); return null; }
    const list = new Set(store.get("tt.popouts", [])); list.add(key); store.set("tt.popouts", [...list]);
    return w;
  }
  const savedPop = store.get("tt.popouts", []);
  if (savedPop.length) {
    const b = $("restorePop"); b.textContent = `Restore windows: ${savedPop.join(", ")}`; b.classList.remove("hidden");
    b.onclick = () => { savedPop.forEach(p => { const [pos, panel] = p.split(":"); popOut(pos, panel || ""); }); b.classList.add("hidden"); };
    setTimeout(() => b.classList.add("hidden"), 20000);
  }
  // ---------- layouts: presets of windows across screens ----------
  const LAYOUT_PRESETS = {
    "Tower (2 screens)": [{ pos: "TWR", panel: "radar", screen: 1 }, { pos: "TWR", panel: "strips", screen: 1, half: "right" }],
    "Ground + Tower": [{ pos: "GND", panel: "", screen: 1 }, { pos: "TWR", panel: "", screen: 2 }],
    "Delivery + strips": [{ pos: "DEL", panel: "del", screen: 1 }, { pos: "ALL", panel: "strips", screen: 1, half: "right" }],
    "Approach radar": [{ pos: "APP", panel: "radar", screen: 1 }],
    "Weather + chat": [{ pos: "TWR", panel: "wx", screen: 1, half: "left", small: true }, { pos: "TWR", panel: "chat", screen: 1, half: "right", small: true }],
  };
  async function screensInfo() {
    // Window Management API (Chrome/Edge): every screen's position; elsewhere just this one
    try {
      if ("getScreenDetails" in window) {
        const d = await window.getScreenDetails();
        return d.screens.map(s => ({ x: s.availLeft, y: s.availTop, w: s.availWidth, h: s.availHeight, primary: s.isPrimary, label: s.label || "" }));
      }
    } catch (e) { sysLog("Window placement: " + e.message + " (allow the window-management permission for multi-screen placement)"); }
    return [{ x: screen.availLeft || 0, y: screen.availTop || 0, w: screen.availWidth, h: screen.availHeight, primary: true, label: "this screen" }];
  }
  async function applyLayout(name) {
    const preset = LAYOUT_PRESETS[name]; if (!preset) return;
    const screens = await screensInfo();
    settings.layout = name; save();
    for (const p of preset) {
      const s = screens[Math.min(p.screen - 1, screens.length - 1)] || screens[0];
      const w = p.half ? Math.floor(s.w / 2) : s.w, h = p.small ? Math.floor(s.h / 2) : s.h;
      const x = p.half === "right" ? s.x + Math.floor(s.w / 2) : s.x, y = s.y;
      const win = popOut(p.pos, p.panel, { x, y, w: w - 10, h: h - 60 });
      if (!win) break;
      await new Promise(r => setTimeout(r, 250));
    }
    sysLog(`Layout "${name}" opened on ${screens.length} screen${screens.length === 1 ? "" : "s"}. Windows remember where you drag them.`);
  }
  function renderLayoutDialog() {
    const cur = settings.layouts[settings.layout || "default"] || {};
    $("layoutBody").innerHTML = `<p class="small muted">Presets open windows on your screens (Chrome/Edge place them on other monitors with the window-management permission; Firefox reopens them where you last left them). Every pop-out has a ⛶ full-screen button.</p>` +
      Object.keys(LAYOUT_PRESETS).map(n => `<button type="button" data-layout="${esc(n)}">${esc(n)}</button>`).join(" ") +
      `<h4>Single windows</h4>` + ["GND", "TWR", "APP", "CTR", "DEL", "ALL"].map(p => `<span class="row small">${p}: ` + ["", "radar", "strips", "log", "del", "wx", "seq", "chat"].map(k => `<button type="button" data-pop="${p}" data-panel="${k}">${k || "full"}</button>`).join(" ") + "</span>").join("") +
      `<h4>Saved positions (${esc(settings.layout || "default")})</h4><div class="small muted">${Object.keys(cur).length ? Object.entries(cur).map(([k, b]) => `${esc(k)}: ${b.x},${b.y} ${b.w}×${b.h}`).join(" · ") : "none yet — drag a pop-out and it is remembered"}</div>` +
      `<div class="row"><button type="button" id="layoutForget">Forget saved positions</button></div>`;
  }
  $("layoutBtn").addEventListener("click", () => { renderLayoutDialog(); $("layoutDialog").showModal(); });
  $("layoutBody").addEventListener("click", (e) => {
    const l = e.target.closest("[data-layout]"); if (l) { $("layoutDialog").close(); applyLayout(l.dataset.layout); return; }
    const p = e.target.closest("[data-pop]"); if (p) { popOut(p.dataset.pop, p.dataset.panel || ""); return; }
    if (e.target.id === "layoutForget") { settings.layouts[settings.layout || "default"] = {}; save(); renderLayoutDialog(); }
  });
  /** What a pop-out window or a remote controller sends back: the same handling for both links. */
  function handleLink(m, guest) {
    if (m.type === "tx") {
      if (guest && guest.role !== "guest") return;                       // spectators and boards do not transmit
      if (guest && mp.claims[guest.id] !== m.pos && !(mp.claims[guest.id] && m.pos === "ALL")) { mp.to(guest.id, { type: "alert", msg: `You do not work ${m.pos} — claim a position first.` }); return; }
      transmit(m.text, m.pos, guest ? `${guest.name}` : "pop-out");
    } else if (m.type === "strip") { if (guest) m.by = guest.name; stripAction(m); }
    else if (m.type === "select") { if (!guest) select(sim && sim.ac.find(a => a.id === m.id)); }
    else if (m.type === "closed") { const list = new Set(store.get("tt.popouts", [])); list.delete(m.pos); store.set("tt.popouts", [...list]); }
    else if (m.type === "hello") { broadcast(true); if (guest) mp.sendClaims(); }
    else if (m.type === "chat" && !guest) { if (mp.relay) mp.relay.send({ type: "chat", text: String(m.text || "").slice(0, 400) }); }
    else if (m.type === "bounds") { if (m.key) { settings.layouts[settings.layout || "default"] ||= {}; settings.layouts[settings.layout || "default"][m.key] = m.bounds; save(); } }
    else if (guest) mp.fromGuest(m, guest);
  }
  if (channel) channel.onmessage = (ev) => handleLink(ev.data, null);
  function stateMessage(full) {
    return { type: "state", icao: apt.icao, t: fmtClock(sim), ac: sim.snapshot(selectedId), split: sim.split,
      positions, staffed: staffedKeys(), selectedId, rwy: sim.depEnd.name, arrEnd: sim.arrEnd.name, atis: $("atisBox").innerHTML,
      closed: [...sim.closedRunways], lvp: sim.lvp, seq: $("seqPanel").innerHTML, wx: $("wxPanel").innerHTML,
      claims: mp.claims, roster: mp.roster, coords: mp.coords, remoteStaff: sim.remoteStaff, hostNick: settings.nick || "host",
      del: $("clrList").innerHTML, seqOn: !$("seqPanel").classList.contains("hidden"), chat: mp.relay ? mp.chat.slice(-40) : [],
      metar: currentMetar(), utc: Date.now(),
      logs: full ? logs : Object.fromEntries(Object.entries(logs).map(([k, v]) => [k, v.slice(-60)])) };
  }
  function broadcast(full) {
    if (!sim) return;
    const msg = stateMessage(full);
    if (channel) channel.postMessage(msg);
    if (mp.relay && mp.role === "host") mp.relay.send(msg);
  }

  // ---------- strips ----------
  function stripAction(m) {
    const a = sim && sim.ac.find(x => x.id === m.id); if (!a) return;
    if (m.accept) { if (sim.acceptHandoff(a, m.by || "me")) addLog(a.freq, "sys", `✓ strip ${esc(a.cs)} accepted${m.by ? " by " + esc(m.by) : ""}`); return; }
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
      onMove: (id, bay) => stripAction({ id, bay }), onEdit: (id, field, value) => stripAction({ id, field, value }),
      onAccept: (id) => stripAction({ id, accept: true }) });
    renderCoord();
  }

  // ---------- Delivery view ----------
  function suggestionFor(a) {
    const sg = sim.suggestDeparture(a);
    const code = (a.stripData && a.stripData.sq) || a.assignedSq || sim.squawks.peek(sim.t);
    return { ...sg, code };
  }
  function renderDel() {
    if (!sim) return;
    // rendered while visible here, or while a Delivery window / a remote controller may be showing it
    if ($("delPanel").classList.contains("hidden") && !mp.relay && !store.get("tt.popouts", []).some(k => k.startsWith("DEL") || k.endsWith(":del"))) return;
    const req = sim.ac.filter(a => a.kind === "dep" && !a.ga && ["clr_req", "parked", "cleared"].includes(a.state) && (a.lastCall != null || a.state === "cleared"));
    // real pilots' flight plans from XRadio (PT_FLIGHTPLAN): the clearance with a squawk answers the plan
    const live = sim.ac.filter(a => a.human && a.fp && a.fpStatus !== "cancelled");
    const liveHtml = live.map(a => {
      const sg = suggestionFor(a);
      return `<div class="clr live${a.id === selectedId ? " sel" : ""}" data-id="${a.id}"><span class="cs">${esc(a.cs)} <span class="muted">(live pilot)</span></span>` +
        `<span>${esc(a.type)} ${esc(a.fp.rules || "V")}FR ${esc(a.fp.dep)} → ${esc(a.fp.dest)} ${esc(a.fp.route || "")} ${a.fp.cruise_ft ? a.fp.cruise_ft + " ft" : ""}</span>` +
        `<span class="st">${a.fpStatus === "ack" || a.fpStatus === "cleared" ? "answered" + (a.assignedSq ? " · " + esc(a.assignedSq) : "") : "filed"}</span>` +
        `<span class="sg">${sg.sid ? "SID " + esc(sg.sid) : "no SID"} · climb ${sg.climb} ft · squawk ${esc(sg.code)} ${a.fpStatus === "filed" ? `<button data-read="${a.id}" title="Put the clearance in the command line">Read clearance</button>` : ""}</span></div>`;
    }).join("");
    $("clrList").innerHTML = (liveHtml + (req.length ? req.map(a => {
      const sg = suggestionFor(a);
      const waiting = a.state === "cleared" ? "cleared" : `${Math.round(sim.t - (a.reqAt ?? a.lastCall ?? sim.t))}s`;
      return `<div class="clr${a.id === selectedId ? " sel" : ""}" data-id="${a.id}"><span class="cs">${esc(a.cs)}</span>` +
        `<span>${esc(a.type)}/${a.wtc} → ${esc(a.other[0])} ${esc(a.other[1])} · stand ${esc(a.stand ? a.stand.name : "")}</span><span class="st">${waiting}</span>` +
        `<span class="sg">${sg.sid ? "SID " + esc(sg.sid) : "no SID (radar vectors)"} · climb ${sg.climb} ft · squawk ${esc(sg.code)} ${a.state !== "cleared" ? `<button data-read="${a.id}" title="Put the clearance in the command line">Read clearance</button>` : ""}</span></div>`;
    }).join("") : "")) || `<div class="muted small">No pending requests.</div>`;
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
  // click-to-instruct (F2): a click on a taxiway builds the "via" of the taxi instruction being typed
  radar.onEdgeClick = (e) => {
    if (!sim || !e || !e.name) return;
    const cmd = $("cmd");
    let v = cmd.value.trimEnd();
    const a = sim.ac.find(x => x.id === selectedId);
    if (!v && a) v = a.kind === "arr" && a.stand ? `${callsignText(a)} taxi to stand ${a.stand.name}` : `${callsignText(a)} taxi to holding point runway ${(a.depEnd || sim.depEnd).name}`;
    if (!v) { sysLog(`Taxiway ${e.name}: select an aircraft (or start typing) and click taxiways to build the route.`); return; }
    const last = v.split(/\s+/).pop().toUpperCase();
    if (last === e.name) return;
    v += /\bvia\b/i.test(v) ? ` ${e.name}` : ` via ${e.name}`;
    cmd.value = v + " "; cmd.focus(); renderSuggest();
  };

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
    if (text.startsWith("@")) {   // a private message to one XRadio pilot: "@ESXYZ say again your type"
      const sp = text.indexOf(" ");
      const to = (sp > 1 ? text.slice(1, sp) : text.slice(1)).toUpperCase(), body = sp > 1 ? text.slice(sp + 1).trim() : "";
      if (!body) { sysLog("Private message: @CALLSIGN followed by the text."); return; }
      addLog(pos, "sys", `✉ to ${esc(to)}: ${esc(body)}`);
      bridges.transmission({ from: "atc", text: body, pos, to });
      return;
    }
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
    mp.radio({ from: "atc", text, pos, by: source });
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
    hideSuggest();
  });

  // ---------- autocomplete and keyboard shortcuts (F2) ----------
  let sugList = [], sugPick = 0;
  function renderSuggest() {
    const box = $("suggest"), cmd = $("cmd");
    if (!sim || document.activeElement !== cmd) { hideSuggest(); return; }
    sugList = suggestions({ text: cmd.value, sim, pos: txPosition(), selected: sim.ac.find(x => x.id === selectedId) || null, app });
    if (!sugList.length) { hideSuggest(); return; }
    sugPick = Math.min(sugPick, sugList.length - 1);
    box.innerHTML = sugList.map((s, i) => `<div class="${i === sugPick ? "on" : ""}" data-i="${i}">${esc(s.label)}</div>`).join("") +
      `<div class="muted small">Tab = accept · ↑↓ · Esc</div>`;
    box.classList.remove("hidden");
  }
  function hideSuggest() { $("suggest").classList.add("hidden"); sugList = []; sugPick = 0; }
  function acceptSuggest(i = sugPick) {
    const s = sugList[i]; if (!s) return false;
    $("cmd").value = s.insert.endsWith(" ") ? s.insert : s.insert + " ";
    sugPick = 0; renderSuggest();
    return true;
  }
  $("cmd").addEventListener("input", () => { sugPick = 0; renderSuggest(); });
  $("cmd").addEventListener("focus", renderSuggest);
  $("cmd").addEventListener("blur", () => setTimeout(hideSuggest, 150));
  $("cmd").addEventListener("keydown", (e) => {
    if (e.key === "Tab" && sugList.length) { e.preventDefault(); acceptSuggest(); return; }
    if (e.key === "ArrowDown" && sugList.length) { e.preventDefault(); sugPick = (sugPick + 1) % sugList.length; renderSuggest(); return; }
    if (e.key === "ArrowUp" && sugList.length) { e.preventDefault(); sugPick = (sugPick + sugList.length - 1) % sugList.length; renderSuggest(); return; }
    if (e.key === "Escape") { e.preventDefault(); if (sugList.length) hideSuggest(); else $("cmd").value = ""; }
  });
  $("suggest").addEventListener("mousedown", (e) => { const d = e.target.closest("[data-i]"); if (d) { e.preventDefault(); acceptSuggest(+d.dataset.i); $("cmd").focus(); } });
  window.addEventListener("keydown", (e) => {
    const typing = ["INPUT", "TEXTAREA"].includes(document.activeElement.tagName) || document.activeElement.isContentEditable;
    if (e.key === "/" && !typing) { e.preventDefault(); $("cmd").focus(); return; }
    if (!e.altKey || e.ctrlKey || e.metaKey) return;
    const views = { 1: "GND", 2: "TWR", 3: "APP", 4: "CTR", 5: "DEL", 6: "3D" };
    const posKeys = { q: "DEL", w: "GND", e: "TWR", r: "APP", t: "CTR", a: "ALL" };
    if (views[e.key]) { e.preventDefault(); setView(views[e.key]); }
    else if (posKeys[e.key] && sim && (sim.split ? e.key !== "a" : e.key === "a")) { e.preventDefault(); setActive(posKeys[e.key]); }
    else if (e.key === "s") { e.preventDefault(); $("settingsBtn").click(); }
    else if (e.key === "p") { e.preventDefault(); setSpeed(speed ? 0 : 1); }
    else if (e.key === "m") { e.preventDefault(); openMp(); }
    else if (e.key === "l") { e.preventDefault(); $("layoutBtn").click(); }
  });

  // ---------- push-to-talk: the browser's recogniser, or the server's (Vosk / Whisper) where there is none ----------
  const ptt = new Ptt({ onText: (t, engine) => { if (engine) sysLog(`🎙 (${engine}) ${t}`); transmit(t, undefined, "voice"); }, onPartial: (t) => { $("cmd").value = t; }, onInfo: sysLog, cmd: $("cmd"),
    phrases: () => (sim ? sim.ac.filter(a => sim.hears(a, txPosition())).flatMap(a => [a.cs, `${a.tel} ${a.num}`.trim()]) : []) });
  let pttDown = false;
  function pttStart() {
    if (pttDown) return;
    pttDown = true; $("mic").classList.add("live");
    radio.burst && radio.burst(0.03, 0.2);
    const pos = txPosition();
    if (bridges.voice) bridges.keyMic(true, sim && sim.split ? Math.round(positions[pos].mhz * 1000) : Math.round((parseFloat(settings.xr.freq) || (apt.freq.tower || { mhz: 118.1 }).mhz) * 1000));
    ptt.start();
  }
  function pttStop() {
    if (!pttDown) return;
    pttDown = false; $("mic").classList.remove("live");
    bridges.keyMic(false);
    ptt.stop();
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
    getWeather: () => {
      if (!sim || !apt) return null;
      const dec = parseMetar(currentMetar());
      const ceil = dec.clouds.filter(c => c.ft != null).map(c => ({ cover: c.cover, base_ft: c.ft }));
      const d = new Date(sim.clockUtc + sim.t * 1000);
      return { wind_dir: sim.wind.dir ?? 0, wind_kt: sim.wind.spd || 0, vis_m: dec.cavok ? 10000 : (dec.vis ?? 10000), qnh_hpa: dec.qnh || 1013,
        temp_c: dec.temp ?? 12, dew_c: dec.dew ?? 8, clouds: ceil.slice(0, 3), rain: dec.wx.some(w => w.codes.some(c => ["RA", "DZ", "SH"].includes(c))) ? 0.6 : 0,
        snow: dec.wx.some(w => w.codes.includes("SN")) ? 0.6 : 0, zulu_s: d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds(),
        date_days: Math.floor((d - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86400000) };
    },
    getAtis: () => (sim && apt ? { icao: apt.icao, khz: apt.freq.atis ? Math.round(apt.freq.atis.mhz * 1000) : 0, letter: sim.atisLetter(), text: atisText() } : null),
    onXrStatus: (st) => {
      const el = $("xrStatus");
      el.classList.toggle("hidden", !settings.xr.enabled);
      if (!st) return;
      const v = st.voice || {};
      if (st.error) { el.textContent = "XR: error"; el.className = "pill err"; el.title = st.error; }
      else if (st.running) { el.textContent = `XR: v${st.proto || "?"} · ${st.pilots || 0} pilot${st.pilots === 1 ? "" : "s"} · ${st.ai_count || 0} AI`; el.className = "pill on"; el.title = (st.roster || []).map(r => r.cs).join(", "); }
      else { el.textContent = "XR: off"; el.className = "pill"; }
      const stations = (st.atc_list || []).map(s => `${s.cs} ${(s.khz / 1000).toFixed(3)}`).join(", ");
      $("xrInfo").innerHTML = st.error ? esc(st.error) : st.running
        ? `Connected, protocol v${st.proto}${st.proto === 5 ? " (old server: one session per AI aircraft, no flight plans/ATIS)" : ""} · ${st.ai_count || 0} AI aircraft in X-Plane · real pilots: ${esc((st.roster || []).filter(r => !r.atc).map(r => r.cs).join(", ") || "none")}` +
          ` · flight plans: ${st.fps_count || 0} · ATIS ${st.atis ? "published (" + esc(st.atis) + ")" : "not published"}` +
          `<br>Stations in the flight: ${esc(stations || "none")} · voice: ${typeof AudioDecoder !== "undefined" ? "WebCodecs" : v.server_decode ? "server codec" : "text only"}${v.server_encode ? " · AI voice: on" : " · AI voice: off (" + esc(v.help || "pip install av") + ")"}${v.stt ? " · transcripts: on" : ""}` +
          ` · weather: ${st.weather === "publish" ? "published" : st.weather === "follow" ? (st.weather_in ? "following the flight" : "waiting for the flight's sky") : "separate"}`
        : "Not connected.";
      if (st.error && !xrErrShown) { xrErrShown = true; alertBox(st.error); }
    },
    onXrText: (t) => {
      const pos = t.khz === 121500 ? "GUARD" : sim && sim.split ? (Object.values(positions).find(p => Math.round(p.mhz * 1000) === t.khz) || {}).key : "ALL";
      const tag = t.to ? "✉ " : t.voice ? "🎙 " : "";
      addLog(pos || "ALL", "pilot human", `${tag}<b>${esc(t.from)}</b> ${esc(t.text)}${t.to ? ' <span class="muted">(private)</span>' : t.voice ? ' <span class="muted">(transcript)</span>' : ""}`);
      if (t.to) alertBox(`Private message from ${t.from}: ${t.text}`);
    },
    onXrFlightPlan: null,
    onXrEvent: (e) => {
      if (e.type === "fp") {
        sysLog(e.status === "filed" ? `Flight plan from ${e.cs}: ${e.dep || "?"} → ${e.dest || "?"} — it is on the strip; clear them with a squawk to answer it.` : `Flight plan ${e.cs}: ${e.status}${e.squawk ? ", squawk " + String(e.squawk).padStart(4, "0") : ""}.`);
        renderBoard(); renderDel();
      }
    },
    onXrWeather: (w) => {
      if (!sim || !w) return;
      const key = JSON.stringify([Math.round(w.wind_dir), Math.round(w.wind_kt), Math.round(w.vis_m / 100), Math.round(w.temp_c)]);
      if (key === xrWxKey) return;
      xrWxKey = key;
      sim.setWxScenario(null);
      sim.wxOverride = { wind: { dir: w.wind_dir, spd: w.wind_kt, gust: 0 }, vis: w.vis_m, rvr: null, wx: w.snow > 0.2 ? ["SN"] : w.rain > 0.2 ? ["RA"] : [],
        temp: w.temp_c, dew: w.temp_c - 3, qnh: Math.round(w.qnh_hpa), rwy: sim.depEnd.name, note: "weather from the XRadio flight" };
      sim.setWind(sim.wxOverride.wind);
      sim.weatherFromMetar(parseMetar(currentMetar()));
      renderOps(); updateSky();
    },
  });
  let xrWxKey = "";
  $("xrHelp").innerHTML = XR_PILOT_HELP.map(s => `<li>${esc(s)}</li>`).join("");
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
    ["depRate", "dep"], ["arrRate", "arr"], ["setCoach", "coach", "checked"], ["setLang", "lang"], ["setChartsUrl", "chartsUrl"], ["graph", "graph", "checked"],
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
    $("xrWeather").value = x.weather || "off"; $("xrAiVoice").checked = x.aiVoice !== false; $("xrAtisVoice").checked = !!x.atisVoice; $("xrTranscribe").checked = !!x.transcribe; $("xrTower").checked = !!x.tower;
    const sb = settings.simbrief; $("sbUser").value = sb.user || ""; $("sbUnits").value = sb.units || "kg"; $("sbKey").value = sb.apiKey || ""; $("sbAuto").checked = sb.autoFetch !== false;
    $("coachToggle").checked = settings.coach;
    renderVoiceTable(); renderEngines();
  }
  function readSettings(changedId) {
    for (const [id, k, prop] of bindings) { const v = $(id)[prop || "value"]; settings[k] = prop ? v : (isNaN(+v) || v === "" ? v : +v); }
    if (changedId === "setPreset") { settings.effect = PRESET_EFFECT[settings.preset] ?? settings.effect; $("setEffect").value = settings.effect; }
    settings.xr = { enabled: $("xrEnabled").checked, host: $("xrHost").value.trim() || "127.0.0.1", port: +$("xrPort").value || 49100,
      password: $("xrPass").value, cs: $("xrCs").value.trim().toUpperCase(), freq: $("xrFreq").value.trim(), ai: $("xrAi").checked,
      humans: $("xrHumans").checked, text: $("xrText").checked, voice: $("xrVoice").checked,
      weather: $("xrWeather").value, aiVoice: $("xrAiVoice").checked, atisVoice: $("xrAtisVoice").checked, transcribe: $("xrTranscribe").checked, tower: $("xrTower").checked };
    settings.simbrief = { user: $("sbUser").value.trim(), units: $("sbUnits").value, apiKey: $("sbKey").value.trim(), autoFetch: $("sbAuto").checked };
    if (settings.xr.tower && sim && !(mp.relay && mp.role === "host")) mp.host(false, "TOWER");
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
  function openDebrief(result = null) {
    if (!sim) return;
    const score = overallScore(coachStats), hist = sessionHistory(), Lx = settings.lang === "et";
    const resHtml = result && result.scenario ? `<div class="result ${result.passed ? "pass" : "fail"}">${result.passed ? (Lx ? "✓ Läbitud" : "✓ Passed") : (Lx ? "✗ Ei läbinud" : "✗ Not passed")}: ${esc(scenName(result.scenario))} — ${Lx ? "skoor" : "score"} ${result.score}${result.reasons.length ? " (" + esc(result.reasons.join("; ")) + ")" : ""}</div>` : "";
    const extras = `<h3>${Lx ? "Varasemad sessioonid" : "Earlier sessions"} (${hist.length})</h3>${hist.length ? sparkline(hist.slice(-30).map(r => r.score)) : `<span class="muted">—</span>`}` +
      `<div class="row"><button type="button" id="dbLog">${Lx ? "Salvesta logi (.txt)" : "Export log (.txt)"}</button><button type="button" id="dbJson">${Lx ? "Salvesta sessioon (.json)" : "Export session (.json)"}</button><button type="button" id="dbReplay">${Lx ? "Vaata tagasi" : "Replay"}</button>${result ? "" : `<button type="button" id="dbSave">${Lx ? "Salvesta statistikasse" : "Save to statistics"}</button>`}</div>`;
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
    $("debriefBody").innerHTML = resHtml + $("debriefBody").innerHTML + extras;
    $("debrief").showModal();
  }
  $("debriefBtn").addEventListener("click", () => openDebrief());
  $("debriefBody").addEventListener("click", (e) => {
    const id = e.target.id, name = `towertrainer-${apt ? apt.icao : "session"}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}`;
    if (id === "dbLog") download(name + ".txt", logsAsText(logs, { icao: apt && apt.icao, started: recorder.meta && recorder.meta.started }), "text/plain");
    if (id === "dbJson") download(name + ".json", JSON.stringify({ towertrainer: "session", v: 1, icao: apt && apt.icao, stats: sim.stats, coach: coachStats, score: overallScore(coachStats), alerts: sim.alertLog || null, recording: recorder.toJSON(logs) }));
    if (id === "dbReplay") { $("debrief").close(); openReplay(recorder, logs); }
    if (id === "dbSave") { addHistory({ date: new Date().toISOString().slice(0, 10), icao: apt.icao, scenario: "", minutes: Math.round(sim.t / 60), departures: sim.stats.departures, arrivals: sim.stats.arrivals, goArounds: sim.stats.goArounds, conflicts: sim.stats.conflicts, missedRb: sim.stats.missedRb, alerts: sim.stats.alerts, score: overallScore(coachStats), passed: null }); e.target.disabled = true; e.target.textContent = "✓"; }
  });

  // ---------- misc controls ----------
  $("aptForm").addEventListener("submit", (e) => { e.preventDefault(); loadAirport($("aptIcao").value); });
  $("rwySel").addEventListener("change", (e) => { if (sim) { sim.setRunway(e.target.value); renderAtis(); applyProcs(); sysLog(`Runway in use: ${e.target.value}`); } });
  $("speed").addEventListener("change", (e) => { speed = +e.target.value; });
  $("helpBtn").addEventListener("click", () => $("help").showModal());
  function setSpeed(n) { speed = n; $("speed").value = String(n); }

  // ---------- multiplayer (F4): this browser hosts, others join over the relay in server.py ----------
  const mp = {
    relay: null, role: null, claims: {}, roster: [], coords: [], intercom: null, releaseAt: {}, chat: [], info: null, nextCoord: 1,
    to(id, msg) { if (this.relay) this.relay.send({ type: "to", id, msg }); },
    /** Radio traffic goes to the guests who work or monitor that frequency: they hear what you hear. */
    radio(m) {
      if (!this.relay || this.role !== "host" || m.from === "blocked") return;
      const a = m.ac;
      this.relay.send({ type: "radio", m: { from: m.from, text: m.text, say: m.say, pos: m.pos, speaker: m.speaker, kind: m.kind, ai: !!m.ai, by: m.by || "",
        ac: a ? { id: a.id, cs: a.cs, tel: a.tel, num: a.num, nat: a.nat || "", ga: !!a.ga, veh: !!a.veh, human: !!a.human, kind: a.kind, type: a.type, crew: a.crew || null, pos: a.pos ? [a.pos[0], a.pos[1]] : null } : null } });
    },
    /** Host a session; a fixed code (TOWER for the X-Plane plugin) skips the server-made one. */
    async host(pub, fixedCode = "") {
      if (!apt) { sysLog("Load an airport first."); return; }
      if (this.relay) this.relay.close();
      this.role = "host"; this.claims = {}; this.roster = []; this.coords = [];
      settings.nick = settings.nick || "host"; save();
      let code = fixedCode;
      if (!code) try { code = (await (await fetch("/api/mp/create", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: `${apt.icao} ${settings.nick}`, public: pub }) })).json()).code; } catch { /* offline */ }
      try { this.info = await (await fetch("/api/mp/info")).json(); } catch { this.info = null; }
      this.relay = new Relay({ code, role: "host", name: settings.nick, sname: `${apt.icao} ${settings.nick}`, pub,
        onStatus: (st, m) => { if (st === "connected") { sysLog(`Hosting session ${m.code}. Others join with the code or ${this.joinUrl()}.`); broadcast(true); } renderMp(); },
        onMessage: (m) => this.fromRelay(m) });
      this.intercom = new Intercom({ send: (m) => this.relay.send(m), log: sysLog, onSpeaking: () => renderMp() });
      renderMp();
    },
    joinUrl() { const i = this.info || {}; const host = i.bind && i.bind !== "127.0.0.1" ? i.lan : location.hostname; return `${location.protocol}//${host}:${i.port || location.port}/?join=${this.relay ? this.relay.code : ""}`; },
    stop() {
      if (this.relay) this.relay.close();
      this.relay = null; this.role = null;
      if (this.intercom) this.intercom.closeAll();
      if (sim) for (const k of Object.keys(sim.remoteStaff)) { delete sim.remoteStaff[k]; sim.staffing.delete(k); }
      this.claims = {}; this.roster = []; this.releaseAt = {}; this.coords = [];
      renderMp(); renderTabs(); renderCoord();
    },
    fromRelay(m) {
      if (m.type === "joined") { sysLog(`${m.name} joined as ${m.role}.`); this.roster = this.roster.filter(r => r.id !== m.id).concat([{ id: m.id, name: m.name, role: m.role, pos: "" }]); this.sendClaims(); if (this.intercom && this.intercom.enabled && m.role !== "board") this.intercom.call(m.id); renderMp(); broadcast(true); }
      else if (m.type === "left") { sysLog(`${m.name} left${m.pos ? " (" + m.pos + " unstaffed — AI takes it in 30 s)" : ""}.`); this.roster = this.roster.filter(r => r.id !== m.id); if (this.intercom) this.intercom.drop(m.id); const pos = this.claims[m.id]; delete this.claims[m.id]; if (pos) this.releaseAt[pos] = Date.now() + 30000; this.sendClaims(); renderMp(); }
      else if (m.type === "roster") { this.roster = m.roster; renderMp(); }
      else if (m.type === "chat") { this.chat.push(m); if (this.chat.length > 80) this.chat.shift(); renderChat(); }
      else if (m.type === "rtc" && this.intercom) this.intercom.onSignal(m);
      else if (m.type === "error") sysLog("Session: " + m.error);
      else if (m.from) handleLink(m, { id: m.from, name: m.name, role: m.role });
    },
    /** A guest's request that is not a pop-out message: claims, coordination, instructor events. */
    fromGuest(m, g) {
      if (m.type === "claim") {
        const pos = String(m.pos || "").toUpperCase();
        for (const [id, p] of Object.entries(this.claims)) if (id === g.id && p) { delete sim.remoteStaff[p]; delete this.claims[id]; this.releaseAt[p] = Date.now() + 30000; }
        if (pos && POS_ORDER.includes(pos) && sim.split && !isMine(pos) && !Object.values(this.claims).includes(pos) && g.role === "guest") {
          this.claims[g.id] = pos; sim.remoteStaff[pos] = g.name; sim.staffing.add(pos); delete this.releaseAt[pos];
          sysLog(`${g.name} now works ${pos}.`);
        } else if (pos) this.to(g.id, { type: "alert", msg: `${pos} is not available${!sim.split ? " (the host works a combined position)" : ""}.` });
        this.sendClaims(); renderTabs(); renderMp(); broadcast(true);
      } else if (m.type === "coord") {
        const c = { id: this.nextCoord++, from: g.name, fromId: g.id, fromPos: this.claims[g.id] || "", to: String(m.to || "").toUpperCase(), kind: m.kind || "approval", ac: m.ac || "", text: String(m.text || "").slice(0, 120), t: Date.now(), state: "open" };
        this.coords.push(c); this.coordArrived(c);
      } else if (m.type === "coordReply") { const c = this.coords.find(x => x.id === m.id); if (c && this.claims[g.id] === c.to) this.answerCoord(m.id, !!m.ok, g.name); }
      else if (m.type === "ops" && g.role === "guest" && this.claims[g.id]) {
        // operations requests from a remote controller (the X-Plane tower): the trainer stays the authority
        const w = String(m.what || "");
        if (w === "lvp") { sim.setLvp(!!m.value, `by ${g.name}`); sysLog(`${g.name}: LVP ${m.value ? "on" : "off"}.`); renderOps(); }
        else if (w === "runway") { const name = String(m.value || "").toUpperCase(); if (apt.findRunwayEnd(name)) { sim.setRunway(name); $("rwySel").value = name; renderAtis(); applyProcs(); sysLog(`${g.name}: runway in use ${name}.`); } else this.to(g.id, { type: "alert", msg: `no runway ${name}` }); }
        else if (w === "stopbars") { for (const b of apt.stopBars || []) sim.setStopBar(b, !!m.value); sysLog(`${g.name}: stop bars ${m.value ? "on" : "off"}.`); }
        else if (w === "stopbar") { const b = (apt.stopBars || []).find(x => x.id === m.id); if (b) sim.setStopBar(b, !!m.value); }
        broadcast(false);
      }
      else if (m.type === "event" && g.role === "instructor") { const r = sim.abnormalEvent(m.kind); sysLog(`Instructor ${g.name} triggered: ${r || m.kind + " (nothing suitable now)"}.`); }
      else if (m.type === "note" && (g.role === "instructor" || g.role === "spectator")) { const target = this.roster.find(r => r.id === m.to); if (target) this.to(m.to, { type: "note", from: g.name, text: String(m.text || "").slice(0, 300) }); else { sysLog(`Note from ${g.name}: ${m.text}`); } }
    },
    sendClaims() { if (this.relay) this.relay.send({ type: "claims", claims: this.claims }); },
    kick(id, ban) { if (this.relay) this.relay.send({ type: ban ? "ban" : "kick", id, reason: ban ? "banned by the host" : "removed by the host" }); },
    /** Coordination requests (release / crossing / approval / point-out) between positions, answered by whoever works the target. */
    request(kind, to, ac, text) {
      const c = { id: this.nextCoord++, from: settings.nick || "host", fromId: "host", fromPos: txPosition(), to, kind, ac, text, t: Date.now(), state: "open" };
      this.coords.push(c); this.coordArrived(c); renderCoord();
    },
    coordArrived(c) {
      const human = sim.userWorks(c.to);
      if (!human) { setTimeout(() => this.answerCoord(c.id, true, `${c.to} (AI)`), 4000 + Math.random() * 4000); }   // an AI position answers in a few seconds
      addLog(c.to, "sys", `☎ ${esc(c.from)} (${esc(c.fromPos)}) → ${esc(c.to)}: ${esc(c.kind)} ${esc(c.ac)} ${esc(c.text)}`);
      broadcast(false); renderCoord();
    },
    answerCoord(id, ok, by) {
      const c = this.coords.find(x => x.id === id); if (!c || c.state !== "open") return;
      c.state = ok ? "approved" : "denied"; c.by = by;
      addLog(c.fromPos || "ALL", "sys", `☎ ${esc(c.to)} ${ok ? "approved" : "denied"} ${esc(c.kind)} ${esc(c.ac)} (${esc(by)})`);
      if (c.fromId !== "host") this.to(c.fromId, { type: "coordResult", id, ok, by, ac: c.ac, kind: c.kind });
      setTimeout(() => { this.coords = this.coords.filter(x => x.id !== id); broadcast(false); renderCoord(); }, 20000);
      broadcast(false); renderCoord();
    },
    tick() {
      for (const [pos, at] of Object.entries(this.releaseAt)) if (Date.now() >= at) { delete this.releaseAt[pos]; if (!Object.values(this.claims).includes(pos)) { delete sim.remoteStaff[pos]; sim.staffing.delete(pos); sysLog(`AI takes over ${pos}.`); renderTabs(); } }
    },
  };
  setInterval(() => { if (sim && mp.role === "host") mp.tick(); }, 2000);
  function openMp() { renderMp(); $("mpDialog").showModal(); }
  function renderMp() {
    const el = $("mpBody"); if (!el) return;
    const r = mp.relay;
    const guests = mp.roster.map(g => `<tr><td>${esc(g.name)}</td><td>${esc(g.role)}</td><td>${esc(mp.claims[g.id] || "—")}</td><td>${mp.intercom && mp.intercom.peers.has(g.id) ? "🎧" : ""}</td><td><button type="button" data-kick="${g.id}">Kick</button> <button type="button" data-ban="${g.id}">Ban</button></td></tr>`).join("");
    el.innerHTML = `<div class="row"><label>My nickname <input id="mpNick" value="${esc(settings.nick)}" placeholder="nickname (no account needed)" size="12"></label></div>` +
      (mp.role === "host" && r ? `<div class="mpcode">Session code <b>${esc(r.code)}</b> · others open <code>${esc(mp.joinUrl())}</code>${mp.info && mp.info.bind === "127.0.0.1" ? ' <span class="warnline">(start server.py with --host 0.0.0.0 so others on your network can reach it)</span>' : ""}</div>` +
        `<table class="score"><tr><th>Controller</th><th>Role</th><th>Position</th><th>Intercom</th><th></th></tr>${guests || "<tr><td colspan=5 class='muted'>nobody has joined yet</td></tr>"}</table>` +
        `<div class="row"><button type="button" id="mpStop">Stop hosting</button> <span class="small muted">Guests claim positions in their window; a position whose controller drops goes back to the AI after 30 s. Hold <b>Alt+Shift</b> or the Intercom button to talk to the other controllers.</span></div>`
        : `<div class="row"><button type="button" id="mpHost">Host a session</button><label><input type="checkbox" id="mpPublic"> list it publicly on this server</label></div>` +
          `<div class="row"><label>Join with code <input id="mpCode" size="8" placeholder="ABC123"></label><label>as <select id="mpRole"><option value="guest">controller</option><option value="spectator">spectator</option><option value="instructor">instructor</option></select></label><button type="button" id="mpJoin">Join</button></div>` +
          `<div class="row small muted">Or paste the host's link (http://…/?join=CODE). Sessions on this server: <span id="mpList">…</span></div>` +
          `<div class="row small muted">Phone / tablet strip board on the LAN: open <code>${location.origin}/?join=CODE&amp;role=board&amp;pos=TWR</code> on the device.</div>`);
    if (mp.role !== "host") fetch("/api/mp/sessions").then(r => r.json()).then(j => { const l = $("mpList"); if (l) l.innerHTML = (j.sessions || []).filter(s => s.public || true).map(s => `<button type="button" data-join="${esc(s.code)}">${esc(s.name)} (${s.guests} joined${s.host ? "" : ", host away"})</button>`).join(" ") || "none"; }).catch(() => {});
  }
  $("mpBody").addEventListener("click", (e) => {
    const nick = $("mpNick"); if (nick) { settings.nick = nick.value.trim().slice(0, 24); save(); }
    if (e.target.id === "mpHost") { mp.host(!!($("mpPublic") && $("mpPublic").checked)); return; }
    if (e.target.id === "mpStop") { mp.stop(); return; }
    const j = e.target.closest("[data-join]"); const code = j ? j.dataset.join : e.target.id === "mpJoin" ? ($("mpCode").value || "").trim().toUpperCase() : "";
    if (code) { const role = $("mpRole") ? $("mpRole").value : "guest"; location.href = `?join=${encodeURIComponent(code)}&role=${role}&name=${encodeURIComponent(settings.nick || "guest")}&icao=${apt ? apt.icao : ""}`; return; }
    const k = e.target.closest("[data-kick]"); if (k) { mp.kick(k.dataset.kick, false); return; }
    const b = e.target.closest("[data-ban]"); if (b) { mp.kick(b.dataset.ban, true); return; }
  });
  $("mpBtn").addEventListener("click", openMp);
  // intercom push-to-talk: Alt+Shift held, or the button
  let icDown = false;
  const icKey = (on) => {
    if (!mp.intercom || icDown === on) return;
    icDown = on;
    if (on && !mp.intercom.enabled) { mp.intercom.enabled = true; for (const g of mp.roster) if (g.role !== "board") mp.intercom.call(g.id); }
    mp.intercom.key(on); $("icBtn").classList.toggle("live", on);
  };
  $("icBtn").addEventListener("mousedown", () => icKey(true)); window.addEventListener("mouseup", () => icKey(false));
  window.addEventListener("keydown", (e) => { if (e.altKey && e.shiftKey && !e.repeat) icKey(true); });
  window.addEventListener("keyup", (e) => { if (!(e.altKey && e.shiftKey)) icKey(false); });
  // chat
  function renderChat() {
    const el = $("chatLog"); if (!el) return;
    el.innerHTML = mp.chat.slice(-40).map(m => `<div><b>${esc(m.name)}</b> ${esc(m.text)}</div>`).join("");
    el.scrollTop = el.scrollHeight;
    $("chatPanel").classList.toggle("hidden", !mp.relay);
  }
  $("chatForm").addEventListener("submit", (e) => { e.preventDefault(); const t = $("chatIn").value.trim(); if (t && mp.relay) mp.relay.send({ type: "chat", text: t }); $("chatIn").value = ""; });
  // coordination panel: open requests for the positions I work, with Approve / Deny
  function renderCoord() {
    const el = $("coordPanel"); if (!el) return;
    const mine = mp.coords.filter(c => c.state === "open" && isMine(c.to));
    const sent = mp.coords.filter(c => c.fromId === "host" && c.state !== "open");
    if (!mine.length && !sent.length) { el.classList.add("hidden"); return; }
    el.classList.remove("hidden");
    el.innerHTML = mine.map(c => `<div class="coord"><b>${esc(c.from)}</b> (${esc(c.fromPos)}) asks ${esc(c.to)}: <b>${esc(c.kind)}</b> ${esc(c.ac)} ${esc(c.text)} <button type="button" data-ok="${c.id}">Approve</button><button type="button" data-no="${c.id}">Deny</button></div>`).join("") +
      sent.map(c => `<div class="coord muted">${esc(c.to)} ${c.state} ${esc(c.kind)} ${esc(c.ac)}</div>`).join("");
  }
  $("coordPanel").addEventListener("click", (e) => {
    const ok = e.target.closest("[data-ok]"), no = e.target.closest("[data-no]");
    if (ok) mp.answerCoord(+ok.dataset.ok, true, settings.nick || "host");
    if (no) mp.answerCoord(+no.dataset.no, false, settings.nick || "host");
  });
  $("coordBtn").addEventListener("click", () => {
    if (!sim || !sim.split) { sysLog("Coordination needs split positions (Staffing)."); return; }
    const a = sim.ac.find(x => x.id === selectedId);
    const to = prompt("Coordinate with which position? (DEL, GND, TWR, APP, CTR)", activePos === "TWR" ? "GND" : "TWR");
    if (!to) return;
    const kind = prompt("Request: release / crossing / approval / point-out", "release") || "approval";
    mp.request(kind.trim().toLowerCase(), to.trim().toUpperCase(), a ? a.cs : "", "");
  });

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

  // ---------- G1: scenarios, the career path, recording / replay, statistics ----------
  let scenTab = "career";
  function scenName(s) { return settings.lang === "et" && s.nameEt ? s.nameEt : s.name; }
  function scenIntro(s) { return settings.lang === "et" && s.introEt ? s.introEt : s.intro; }
  function scenMeta(s) {
    const g = s.goals || {};
    return `${s.icao || "current airport"}${s.rwy ? " RWY " + s.rwy : ""} · ${s.staff === "combined" ? "combined DEL/GND/TWR" : s.staff.join("+")} · ${s.dep}/h dep, ${s.arr}/h arr${s.vfr ? ", VFR " + s.vfr + "/h" : ""} · wx ${s.wx || "live"}${s.lvp ? " · LVP" : ""}${s.abnormals ? " · abnormals " + s.abnormalRate + "/h" : ""} · ${s.minutes} min · goals: score ≥ ${g.score}${g.missedRb != null ? ", missed readbacks ≤ " + g.missedRb : ""}${g.conflicts != null ? ", conflicts ≤ " + g.conflicts : ""}${g.goArounds != null ? ", go-arounds ≤ " + g.goArounds : ""}`;
  }
  function renderScen() {
    $("scenTabs").querySelectorAll("button").forEach(b => b.classList.toggle("on", b.dataset.tab === scenTab));
    const el = $("scenBody"), L = settings.lang === "et", c = career();
    if (scenTab === "career") {
      const levels = [...new Set(BUILTIN.map(s => s.level))].sort((a, b) => a - b);
      el.innerHTML = `<p class="small muted">${L ? "Tasemed avanevad järjest: läbi eelmise taseme üks stsenaarium. Tulemus = fraseoloogia skoor ja eesmärgid kokkuvõttes." : "Levels open one after another: pass one scenario of the level before. The result is the phraseology score and the goals in the debrief."}</p>` +
        levels.map(lv => { const open = levelOpen(lv); return BUILTIN.filter(s => s.level === lv).map(s => { const p = c.passed[s.id]; return `<div class="scen${open ? "" : " locked"}"><div><span class="lvl">${lv}</span><b>${esc(scenName(s))}</b> ${p ? `<span class="pass">✓ ${p.score} (${p.date})</span>` : c.last && c.last.id === s.id && !c.last.passed ? `<span class="fail">✗ ${c.last.score}</span>` : ""}</div><div>${open ? `<button type="button" data-start="${s.id}">${L ? "Alusta" : "Start"}</button>` : "🔒"}</div><div class="meta">${esc(scenIntro(s))}<br>${esc(scenMeta(s))}</div></div>`; }).join(""); }).join("");
    } else if (scenTab === "list") {
      el.innerHTML = `<div class="row"><button type="button" id="scenNew">${L ? "Uus stsenaarium" : "New scenario"}</button><button type="button" id="scenImport">${L ? "Impordi JSON" : "Import JSON"}</button><button type="button" id="scenExport">${L ? "Ekspordi minu omad" : "Export mine"}</button><input type="file" id="scenFile" accept=".json" class="hidden"></div><div id="scenEdit"></div>` +
        allScenarios().map(s => `<div class="scen"><div><span class="lvl">${s.level || "·"}</span><b>${esc(scenName(s))}</b>${s.user ? "" : ' <span class="muted small">built-in</span>'}</div><div><button type="button" data-start="${s.id}">${L ? "Alusta" : "Start"}</button> <button type="button" data-edit="${s.id}">${s.user ? (L ? "Muuda" : "Edit") : (L ? "Kopeeri" : "Copy")}</button>${s.user ? ` <button type="button" data-del="${s.id}">${L ? "Kustuta" : "Delete"}</button>` : ""}</div><div class="meta">${esc(scenMeta(s))}</div></div>`).join("");
    } else if (scenTab === "replay") {
      el.innerHTML = `<p class="small muted">${L ? "Salvestus käib kogu aeg (üks kaader sekundis). Vaata praegust sessiooni tagasi või laadi varem salvestatud fail." : "Recording runs all the time (one frame per second). Replay the current session or load a saved file."}</p>` +
        `<div class="row"><button type="button" id="rpNow">${L ? "Vaata praegust sessiooni" : "Replay this session"} (${Math.round(recorder.seconds / 60)} min)</button><button type="button" id="rpLoadBtn">${L ? "Laadi salvestus" : "Load a recording"}</button><input type="file" id="rpFile" accept=".json" class="hidden"><button type="button" id="rpExport">${L ? "Salvesta fail" : "Save as file"}</button></div>`;
    } else {
      const h = sessionHistory();
      el.innerHTML = `<p class="small muted">${L ? "Iga lõpetatud sessioon (kokkuvõte või stsenaarium) jääb siia brauserisse." : "Every finished session (debrief or scenario) is kept here in this browser."}</p>` +
        (h.length ? sparkline(h.slice(-30).map(r => r.score)) + `<table class="score"><tr><th>${L ? "Kuupäev" : "Date"}</th><th>ICAO</th><th>${L ? "Stsenaarium" : "Scenario"}</th><th>min</th><th>DEP</th><th>ARR</th><th>G/A</th><th>${L ? "Konfl." : "Confl."}</th><th>${L ? "Vead" : "Missed"}</th><th>${L ? "Skoor" : "Score"}</th><th></th></tr>` +
          h.slice().reverse().slice(0, 40).map(r => `<tr><td>${esc(r.date)}</td><td>${esc(r.icao)}</td><td>${esc(r.scenario || "—")}</td><td>${r.minutes}</td><td>${r.departures}</td><td>${r.arrivals}</td><td>${r.goArounds}</td><td>${r.conflicts}</td><td>${r.missedRb}</td><td><b>${r.score}</b></td><td>${r.passed == null ? "" : r.passed ? '<span class="pass">✓</span>' : '<span class="fail">✗</span>'}</td></tr>`).join("") + "</table>" +
          `<div class="row"><button type="button" id="statClear">${L ? "Kustuta ajalugu" : "Clear history"}</button></div>` : `<p class="muted">${L ? "Veel midagi pole." : "Nothing yet."}</p>`);
    }
  }
  function scenForm(s) {
    const L = settings.lang === "et";
    const f = (k, label, v, extra = "") => `<label>${label}<input name="${k}" value="${esc(v ?? "")}" ${extra}></label>`;
    $("scenEdit").innerHTML = `<form id="scenForm" class="scenform">` + f("id", "id", s.id) + f("name", L ? "Nimi" : "Name", s.name) + f("nameEt", "Nimi (et)", s.nameEt) + f("level", L ? "Tase" : "Level", s.level, 'type="number" min="0" max="9"') +
      f("icao", "ICAO", s.icao, 'placeholder="current"') + f("rwy", "RWY", s.rwy) + f("staff", L ? "Positsioonid" : "Positions", s.staff === "combined" ? "combined" : s.staff.join(" "), 'placeholder="combined or TWR GND"') + f("minutes", L ? "Kestus (min)" : "Minutes", s.minutes, 'type="number" min="5"') +
      f("dep", "DEP/h", s.dep, 'type="number"') + f("arr", "ARR/h", s.arr, 'type="number"') + f("vfr", "VFR/h", s.vfr, 'type="number"') + `<label>${L ? "Ilm" : "Weather"}<select name="wx">${WX_CHOICES.map(w => `<option ${s.wx === w ? "selected" : ""}>${w}</option>`).join("")}</select></label>` +
      `<label><input type="checkbox" name="lvp" ${s.lvp ? "checked" : ""}> LVP</label><label><input type="checkbox" name="abnormals" ${s.abnormals ? "checked" : ""}> ${L ? "Hädaolukorrad" : "Abnormals"}</label>` + f("abnormalRate", L ? "Hädaolukordi/h" : "Abnormals/h", s.abnormalRate, 'type="number"') + f("score", L ? "Eesmärk: skoor ≥" : "Goal: score ≥", s.goals.score, 'type="number"') +
      f("missedRb", L ? "Märkamata vigu ≤" : "Missed readbacks ≤", s.goals.missedRb ?? "", 'type="number" placeholder="any"') + f("conflicts", L ? "Konflikte ≤" : "Conflicts ≤", s.goals.conflicts ?? "", 'type="number" placeholder="any"') + f("goArounds", L ? "Kordusringe ≤" : "Go-arounds ≤", s.goals.goArounds ?? "", 'type="number" placeholder="any"') +
      `<label class="wide">${L ? "Sissejuhatus" : "Intro"}<input name="intro" value="${esc(s.intro)}"></label><label class="wide">Intro (et)<input name="introEt" value="${esc(s.introEt)}"></label>` +
      `<div class="wide row"><button type="submit">${L ? "Salvesta" : "Save"}</button><button type="button" id="scenCancel">${L ? "Loobu" : "Cancel"}</button></div></form>`;
    $("scenForm").addEventListener("submit", (e) => {
      e.preventDefault();
      const fd = new FormData(e.target), g = (k) => fd.get(k);
      const ns = normalize({ id: g("id"), name: g("name"), nameEt: g("nameEt"), level: g("level"), icao: g("icao"), rwy: g("rwy"), staff: g("staff"), minutes: g("minutes"), dep: g("dep"), arr: g("arr"), vfr: g("vfr"), wx: g("wx"), lvp: !!g("lvp"), abnormals: !!g("abnormals"), abnormalRate: g("abnormalRate"),
        goals: { score: g("score"), missedRb: g("missedRb") === "" ? null : g("missedRb"), conflicts: g("conflicts") === "" ? null : g("conflicts"), goArounds: g("goArounds") === "" ? null : g("goArounds") }, intro: g("intro"), introEt: g("introEt") });
      if (BUILTIN.some(b => b.id === ns.id)) ns.id += "-my";
      saveScenario(ns); renderScen();
    });
    $("scenCancel").addEventListener("click", () => { $("scenEdit").innerHTML = ""; });
  }
  $("scenTabs").addEventListener("click", (e) => { const b = e.target.closest("[data-tab]"); if (b) { scenTab = b.dataset.tab; renderScen(); } });
  $("scenBtn").addEventListener("click", () => { renderScen(); $("scenDialog").showModal(); });
  $("scenBody").addEventListener("click", (e) => {
    const t = e.target;
    const st = t.closest("[data-start]"); if (st) { $("scenDialog").close(); startScenario(findScenario(st.dataset.start)); return; }
    const ed = t.closest("[data-edit]"); if (ed) { const s = findScenario(ed.dataset.edit); scenForm(s.user ? s : { ...s, id: s.id + "-my", user: true }); return; }
    const dl = t.closest("[data-del]"); if (dl) { if (confirm("Delete this scenario?")) { deleteScenario(dl.dataset.del); renderScen(); } return; }
    if (t.id === "scenNew") { scenForm(normalize({ id: "my-" + Date.now().toString(36), name: "My scenario", staff: settings.staff.mode === "split" ? settings.staff.keys : "combined", dep: settings.dep, arr: settings.arr, vfr: settings.vfr, wx: settings.wx, minutes: 20, goals: { score: 75 } })); return; }
    if (t.id === "scenExport") { download("towertrainer-scenarios.json", exportScenarios()); return; }
    if (t.id === "scenImport") { $("scenFile").click(); return; }
    if (t.id === "rpNow") { $("scenDialog").close(); openReplay(recorder, logs); return; }
    if (t.id === "rpLoadBtn") { $("rpFile").click(); return; }
    if (t.id === "rpExport") { download(`towertrainer-${apt ? apt.icao : "rec"}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.json`, JSON.stringify(recorder.toJSON(logs))); return; }
    if (t.id === "statClear") { if (confirm("Clear the statistics?")) { store.set("tt.history", []); renderScen(); } }
  });
  $("scenBody").addEventListener("change", async (e) => {
    if (e.target.id === "scenFile" && e.target.files[0]) { try { const n = importScenarios(await e.target.files[0].text()); sysLog(`${n} scenario(s) imported.`); } catch (err) { alert(err.message); } renderScen(); }
    if (e.target.id === "rpFile" && e.target.files[0]) { try { const rec = Recorder.fromJSON(JSON.parse(await e.target.files[0].text())); $("scenDialog").close(); openReplay(rec, rec.logs || {}); } catch (err) { alert(err.message); } }
  });
  async function startScenario(s) {
    if (!s) return;
    Object.assign(settings, scenarioSettings(s)); save(); updateStaffBtn();
    if (s.icao && (!apt || apt.icao !== s.icao)) await loadAirport(s.icao); else createSim();
    if (!sim) return;
    if (s.rwy && apt.findRunwayEnd(s.rwy)) { $("rwySel").value = s.rwy; sim.setRunway(s.rwy); renderAtis(); applyProcs(); }
    applyWeather();
    for (const k of Object.keys(coachStats)) delete coachStats[k];
    scenario = s; scenarioEndsAt = sim.t + s.minutes * 60; setSpeed(1);
    sysLog(`▶ ${scenName(s)} — ${s.minutes} min. ${scenIntro(s)}`);
    alertBox(`${scenName(s)}: ${s.minutes} min`);
  }
  function endScenario() {
    const s = scenario; scenario = null;
    if (!s || !sim) return;
    const score = overallScore(coachStats);
    const res = evaluate(s, sim.stats, score, settings.lang);
    recordResult(s, { passed: res.passed, score });
    addHistory({ date: new Date().toISOString().slice(0, 10), icao: apt.icao, scenario: scenName(s), minutes: s.minutes, departures: sim.stats.departures, arrivals: sim.stats.arrivals, goArounds: sim.stats.goArounds, conflicts: sim.stats.conflicts, missedRb: sim.stats.missedRb, alerts: sim.stats.alerts, score, passed: res.passed });
    setSpeed(0);
    openDebrief({ scenario: s, score, ...res });
  }
  function openReplay(rec, rlogs) {
    if (!rec || !rec.frames.length) { sysLog("Nothing recorded yet."); return; }
    replay.on = true; replay.rec = rec; replay.logs = rlogs || {}; replay.i = 0; replay.playing = true; replay.speedBefore = speed; replay.acc = 0; replay.lastShown = -1;
    setSpeed(0);
    $("replayBar").classList.remove("hidden"); $("rpPos").max = String(rec.frames.length - 1); $("rpPos").value = "0";
    $("rpInfo").textContent = `${rec.meta && rec.meta.icao ? rec.meta.icao + " · " : ""}${Math.round(rec.seconds / 60)} min · ${rec.frames.length} frames`;
    sysLog("Replay: the simulation is paused while you scrub. Close replay to continue.");
  }
  function closeReplay() { replay.on = false; replay.rec = null; $("replayBar").classList.add("hidden"); setSpeed(replay.speedBefore || 1); renderLog(); }
  function drawReplay(dt) {
    const rec = replay.rec, n = rec.frames.length;
    if (replay.playing) { replay.acc += dt; while (replay.acc >= 1 && replay.i < n - 1) { replay.acc -= 1; replay.i++; } if (replay.i >= n - 1) replay.playing = false; }
    const f = rec.frames[replay.i];
    radar.draw({ ac: frameAircraft(f), arrEnd: apt ? apt.findRunwayEnd(f.arr) : null, closed: new Set(), lvp: false }, selectedId);
    if ($("rpPos").value !== String(replay.i)) $("rpPos").value = String(replay.i);
    const t = f.t - rec.frames[0].t; $("rpTime").textContent = `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
    $("rpPlay").textContent = replay.playing ? "❚❚" : "▶";
    if (replay.lastShown !== replay.i) { replay.lastShown = replay.i; renderLog(); $("status").textContent = `REPLAY ${f.t} s · ${f.ac.length} targets · RWY ${f.rwy}`; }
  }
  $("rpPos").addEventListener("input", (e) => { replay.i = +e.target.value; replay.playing = false; });
  $("rpPlay").addEventListener("click", () => { replay.playing = !replay.playing; if (replay.playing && replay.i >= replay.rec.frames.length - 1) replay.i = 0; });
  $("rpClose").addEventListener("click", closeReplay);
  $("rpSave").addEventListener("click", () => download(`towertrainer-${apt ? apt.icao : "rec"}-replay.json`, JSON.stringify(replay.rec.toJSON ? replay.rec.toJSON(replay.logs) : replay.rec)));

  // ---------- main loop ----------
  let last = performance.now(), slowT = 0, bcT = 0;
  function frame(now) {
    const dt = Math.min(0.1, (now - last) / 1000); last = now;
    if (sim && speed > 0) for (let i = 0; i < speed; i++) sim.step(dt);
    if (sim) {
      recorder.tick(sim, logs);
      if (replay.on) drawReplay(dt);
      else radar.draw({ ac: sim.snapshot(selectedId), arrEnd: sim.arrEnd, closed: sim.closedRunways, lvp: sim.lvp }, selectedId);
      slowT += dt; bcT += dt;
      if (slowT > 0.5) {
        slowT = 0;
        if (scenario && sim.t >= scenarioEndsAt) endScenario();
        renderBoard(); renderDel(); renderTabs(); renderCoach(); renderInfo(); renderSeq();
        const st = sim.stats;
        if (!replay.on) $("status").textContent = `${fmtClock(sim)}  DEP ${st.departures}  ARR ${st.arrivals}  G/A ${st.goArounds}  ALERTS ${st.alerts}  AC ${sim.ac.length}` +
          (speed === 0 ? "  [PAUSED]" : speed > 1 ? `  [${speed}×]` : "");
      }
      if (bcT > 0.25) { bcT = 0; broadcast(false); }
    } else radar.draw({ ac: [], arrEnd: null }, null);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  // Animation frames stop when this window is hidden (minimised, or covered on another monitor) but the
  // pop-outs, remote controllers and XRadio pilots still need the simulation: step it on a timer meanwhile.
  setInterval(() => {
    const now = performance.now();
    if (!sim || now - last < 400) return;
    const dt = Math.min(0.1, (now - last) / 1000); last = now;
    if (speed > 0) for (let i = 0; i < speed; i++) sim.step(dt);
    recorder.tick(sim, logs);
    if (scenario && sim.t >= scenarioEndsAt) endScenario();
    bcT += dt; if (bcT > 0.25) { bcT = 0; broadcast(false); }
    slowT += dt; if (slowT > 1) { slowT = 0; renderBoard(); renderDel(); renderTabs(); renderInfo(); }
  }, 100);
  loadAirport(params.get("icao") || store.get("tt.icao", "EETN"));
  // for debugging and automated tests
  window.TT = { get sim() { return sim; }, get apt() { return apt; }, get positions() { return positions; }, get procs() { return procs; }, transmit, parse, radio, radar, guide, app,
    settings, setActive, setView, select: (id) => select(sim && sim.ac.find(a => a.id === id)), openDebrief, bridges, loadAirport, refreshVoices, get mp() { return mp; }, broadcast,
    scenarios: { start: startScenario, end: endScenario, list: allScenarios, get current() { return scenario; } }, recorder, replay, openReplay, closeReplay, renderScen, get coachStats() { return coachStats; },
    applyStaffing: (mode, keys) => { settings.staff = { mode, keys }; save(); updateStaffBtn(); createSim(); } };
}

function fmtClock(sim) {
  const s = Math.floor(sim.t), mm = Math.floor(s / 60), ss = String(s % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

// =====================================================================================
//  POP-OUT / REMOTE WINDOW: one position of the main window (?popout=GND), a single panel of it
//  (?popout=TWR&panel=strips), or a controller who joined another host's session over the relay
//  (?join=CODE&role=guest|spectator|instructor|board). The simulation runs in the host's main window;
//  this window renders the state it receives and sends back what its controller does.
// =====================================================================================
async function bootPopout() {
  const JOIN = (params.get("join") || "").toUpperCase();
  const remote = !!JOIN;
  const role = remote ? (params.get("role") || "guest") : "popout";     // popout | guest | spectator | instructor | board
  const panel = (params.get("panel") || "").toLowerCase();
  let pos = (POPOUT || params.get("pos") || "").toUpperCase() || (remote ? "TWR" : "ALL");
  const key = panel ? `${pos}:${panel}` : pos;
  const saved = store.get("tt.settings", {});
  const nick = (params.get("name") || saved.nick || (role === "board" ? "board" : "guest")).slice(0, 24);
  document.body.classList.add("popout");
  if (panel) document.body.classList.add("panel-only", "p-" + panel);
  if (role === "board") document.body.classList.add("board");
  if (remote) document.body.classList.add("remote");
  document.querySelectorAll(".main-only").forEach(e => e.classList.add("hidden"));
  $("restorePop").classList.add("hidden");
  $("assignSq").classList.add("hidden");
  document.title = `Tower Trainer — ${remote ? `${nick} (${role})` : pos}${panel ? " · " + panel : ""}`;
  // audio: a pop-out of the main window never plays (the main window does); a remote controller hears their own frequency
  const radio = new Radio();
  radio.muted = !remote;
  radio.onFrequency = () => [];
  if (remote) Object.assign(radio, { accents: saved.accents || "natural", rate: +saved.rate || 1, effect: saved.effect ?? 0.85, preset: saved.preset || "good", tts: saved.voices !== false, blocked: false });
  let apt = null, state = null, selectedId = null, aptIcao = null, myPos = remote ? "" : pos, claims = {}, roster = [], chat = [], hostHere = true, statusText = "";
  const view = () => (remote ? myPos || pos : pos);
  const canTx = () => (role === "guest" ? !!myPos : !remote);
  async function load(icao) {
    if (!icao || icao === aptIcao) return;
    aptIcao = icao;
    const d = await (await fetch(`/api/airport/${icao}`)).json();
    apt = new Airport(d);
    radar.setAirport(apt);
    radio.airport = icao;
    radar.setView(VIEWS[view()] ? view() : (DEFAULT_VIEW[view()] || "GND"));
  }
  if (params.get("icao")) await load(params.get("icao"));
  // ---------- the link to the host: BroadcastChannel (same browser) or the relay (another computer) ----------
  let relay = null, intercom = null;
  const link = { id: null, send(m) { if (remote) { if (relay) relay.send(m); } else if (channel) channel.postMessage(m); } };
  function alertMsg(text, ms = 12000) { const d = document.createElement("div"); d.textContent = text; $("alerts").appendChild(d); setTimeout(() => d.remove(), ms); }
  function setStatus(t, warn) { statusText = t; renderBar(); if (warn) alertMsg(t); }
  if (remote) {
    relay = new Relay({ code: JOIN, role, name: nick, pos: role === "guest" ? pos : "",
      onStatus: (st, m) => {
        if (st === "connected") {
          link.id = m.id; hostHere = m.host !== false; chat = m.chat || chat; roster = m.roster || roster;
          link.send({ type: "hello", pos });
          if (role === "guest" && POS_ORDER.includes(pos)) link.send({ type: "claim", pos });
          setStatus(`in session ${m.name || m.code}`); renderChat();
        } else if (st === "kicked") setStatus(m.reason || m.error || "removed from the session", true);
        else if (st === "closed") setStatus("connection lost — reconnecting…");
        renderBar();
      },
      onMessage: onLink });
    intercom = new Intercom({ send: (m) => relay.send(m), log: (t) => alertMsg(t) });
  } else if (channel) channel.onmessage = (ev) => onLink(ev.data);
  /** Call everybody who can talk (the host and the other controllers), once the intercom is on. */
  function callAll() {
    if (!intercom || !intercom.enabled) return;
    for (const id of ["host", ...roster.filter(r => r.id !== link.id && r.role !== "board").map(r => r.id)]) if (!intercom.peers.has(id)) intercom.call(id);
  }
  // ---------- the bar of a remote window: who I am, what I work, instructor tools, intercom, leave ----------
  const bar = document.createElement("div"); bar.className = "guestbar";
  if (remote) $("posTabs").parentElement.insertBefore(bar, $("posTabs"));
  const EVENTS = ["medical", "birdstrike", "rto", "breakdown", "fod", "incursion", "unstable", "pan", "mayday", "7500", "7600", "7700"];
  function renderBar() {
    if (!remote) return;
    bar.innerHTML = `<b>${esc(nick)}</b> <span class="muted">${esc(role)}${myPos ? " · working " + esc(myPos) : role === "guest" ? " · click a position tab to claim it" : ""}</span>` +
      (hostHere ? "" : ' <span class="warnline">host away</span>') + ` <span class="muted">${esc(statusText)}</span><span class="sp"></span>` +
      (role === "instructor" ? `<select id="insEv" title="Abnormal event to trigger in the host's simulation">${EVENTS.map(k => `<option>${k}</option>`).join("")}</select><button type="button" id="insGo">Trigger</button>` +
        `<select id="insTo" title="Send a private note to">${roster.filter(r => r.id !== link.id).map(r => `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join("")}<option value="host">host</option></select><input id="insNote" placeholder="private note" size="14"><button type="button" id="insSend">Note</button>` : "") +
      (role !== "board" ? `<button type="button" id="icBtn2" class="${intercom && intercom.keyed ? "live" : ""}" title="Intercom to the other controllers: hold (or Alt+Shift)">🎧</button>` : "") +
      `<button type="button" id="gstLeave" title="Leave the session">Leave</button>`;
  }
  bar.addEventListener("click", (e) => {
    if (e.target.id === "gstLeave") { if (relay) relay.close(); location.href = `/?icao=${aptIcao || ""}`; }
    if (e.target.id === "insGo") link.send({ type: "event", kind: $("insEv").value });
    if (e.target.id === "insSend") { const t = $("insNote").value.trim(); if (t) { const to = $("insTo").value; if (to === "host") link.send({ type: "note", text: t }); else link.send({ type: "note", to, text: t }); $("insNote").value = ""; alertMsg("note sent"); } }
  });
  let icDown = false;
  const icKey = (on) => {
    if (!intercom || icDown === on) return;
    icDown = on;
    if (on && !intercom.enabled) { intercom.enabled = true; callAll(); }
    intercom.key(on);
    const b = $("icBtn2"); if (b) b.classList.toggle("live", on);
  };
  bar.addEventListener("mousedown", (e) => { if (e.target.id === "icBtn2") icKey(true); });
  window.addEventListener("mouseup", () => icKey(false));
  window.addEventListener("keydown", (e) => { if (e.altKey && e.shiftKey && !e.repeat) icKey(true); });
  window.addEventListener("keyup", (e) => { if (!(e.altKey && e.shiftKey)) icKey(false); });
  // ---------- tabs: the position this window shows; a controller claims one by clicking it ----------
  function renderTabs() {
    const keys = state && state.split ? POS_ORDER : ["ALL"];
    const v = view();
    $("posTabs").innerHTML = keys.map(k => {
      const who = state && state.remoteStaff ? state.remoteStaff[k] : null;
      const ai = state && state.split && !state.staffed.includes(k);
      const mine = remote && k === myPos;
      const title = mine ? "you work this position" : who ? `worked by ${who}` : ai ? (role === "guest" ? "AI controller — click to claim" : "AI controller") : "the host";
      return `<div class="tab${k === v ? " on" : ""}${ai ? " ai" : ""}${who && !mine ? " remote" : ""}${mine ? " mine" : ""}" data-pos="${k}" title="${esc(title)}">${k === "ALL" ? "DEL/GND/TWR" : k}${who && !mine ? `<span class="who">${esc(who)}</span>` : ""}</div>`;
    }).join("");
  }
  function onPosChange() {
    if (!panel || panel === "radar") radar.setView(VIEWS[view()] ? view() : (DEFAULT_VIEW[view()] || "GND"));
    if (remote) radio.audible = new Set([view(), "GUARD", "ALL"]);
    document.title = `Tower Trainer — ${remote ? `${nick} (${role === "guest" && myPos ? myPos : role})` : pos}${panel ? " · " + panel : ""}`;
    renderTabs(); renderBar();
  }
  $("posTabs").addEventListener("click", (e) => {
    const t = e.target.closest("[data-pos]"); if (!t) return;
    const k = t.dataset.pos;
    if (role === "guest" && k !== myPos && k !== "ALL") link.send({ type: "claim", pos: k });   // the host answers with the claims
    pos = k; onPosChange();
  });
  $("viewTabs").innerHTML = Object.keys(VIEWS).map(v => `<button data-view="${v}">${VIEWS[v]}</button>`).join("");
  $("viewTabs").addEventListener("click", (e) => { const b = e.target.closest("[data-view]"); if (b) radar.setView(b.dataset.view); });
  radar.onSelect = (id) => { selectedId = id; if (!remote) link.send({ type: "select", id }); };
  // ---------- chat and coordination (remote windows and the chat panel pop-out) ----------
  function renderChat() {
    const el = $("chatLog"); if (!el) return;
    $("chatPanel").classList.toggle("hidden", !(remote || panel === "chat"));
    const html = chat.slice(-40).map(m => `<div><b>${esc(m.name)}</b> ${esc(m.text)}</div>`).join("");
    if (el._last !== html) { el.innerHTML = html; el._last = html; el.scrollTop = el.scrollHeight; }
  }
  $("chatForm").addEventListener("submit", (e) => { e.preventDefault(); const t = $("chatIn").value.trim(); if (t) link.send({ type: "chat", text: t }); $("chatIn").value = ""; });
  $("coordBtn").addEventListener("click", () => {
    if (!state || !state.split) { alertMsg("Coordination needs split positions."); return; }
    if (remote && role !== "guest") { alertMsg("Only a controller working a position coordinates."); return; }
    const a = state.ac.find(x => x.id === selectedId);
    const to = prompt("Coordinate with which position? (DEL, GND, TWR, APP, CTR)", view() === "TWR" ? "GND" : "TWR"); if (!to) return;
    const kind = prompt("Request: release / crossing / approval / point-out", "release") || "approval";
    link.send({ type: "coord", to: to.trim().toUpperCase(), kind: kind.trim().toLowerCase(), ac: a ? a.cs : "", text: "" });
  });
  function renderCoord(coords) {
    const el = $("coordPanel");
    const mine = coords.filter(c => c.state === "open" && c.to === view() && (remote ? role === "guest" && c.to === myPos : true));
    const sent = coords.filter(c => c.fromId === link.id && c.state !== "open");
    if (!mine.length && !sent.length) { el.classList.add("hidden"); return; }
    el.classList.remove("hidden");
    const html = mine.map(c => `<div class="coord"><b>${esc(c.from)}</b> (${esc(c.fromPos)}) asks ${esc(c.to)}: <b>${esc(c.kind)}</b> ${esc(c.ac)} ${esc(c.text)} <button type="button" data-ok="${c.id}">Approve</button><button type="button" data-no="${c.id}">Deny</button></div>`).join("") +
      sent.map(c => `<div class="coord muted">${esc(c.to)} ${esc(c.state)} ${esc(c.kind)} ${esc(c.ac)}</div>`).join("");
    if (el._last !== html) { el.innerHTML = html; el._last = html; }
  }
  $("coordPanel").addEventListener("click", (e) => {
    const ok = e.target.closest("[data-ok]"), no = e.target.closest("[data-no]");
    if (ok) link.send({ type: "coordReply", id: +ok.dataset.ok, ok: true });
    if (no) link.send({ type: "coordReply", id: +no.dataset.no, ok: false });
  });
  // ---------- messages from the host ----------
  const acCache = new Map();
  async function onLink(m) {
    if (!m || typeof m !== "object") return;
    switch (m.type) {
      case "airport": aptIcao = null; await load(m.icao); return;
      case "alert": alertMsg(m.msg); return;
      case "note": alertMsg(`✉ ${m.from}: ${m.text}`, 20000); return;
      case "coordResult": alertMsg(`☎ ${m.by || m.to || ""}: ${m.kind} ${m.ac} ${m.ok ? "APPROVED" : "DENIED"}`, 15000); return;
      case "chat": chat.push(m); if (chat.length > 80) chat.shift(); renderChat(); return;
      case "claims": claims = m.claims || {}; if (m.roster) roster = m.roster; applyClaims(); renderTabs(); renderBar(); return;
      case "roster": roster = m.roster || []; renderBar(); callAll(); return;
      case "hostLeft": hostHere = false; renderBar(); return;
      case "hostBack": hostHere = true; renderBar(); link.send({ type: "hello", pos }); if (role === "guest" && (myPos || pos)) link.send({ type: "claim", pos: myPos || pos }); return;
      case "rtc": if (intercom) intercom.onSignal(m); return;
      case "radio": if (remote && m.m && m.m.by !== nick && radio.isAudible(m.m.pos)) { if (m.m.ac) { const c = acCache.get(m.m.ac.id) || {}; Object.assign(c, m.m.ac); acCache.set(c.id, c); m.m.ac = c; } radio.enqueue(m.m, m.m.from === "atc" && !m.m.ai ? 0.3 : undefined); } return;
      case "state": break;
      default: return;
    }
    if (m.icao !== aptIcao) await load(m.icao);
    state = m;
    if (!remote) selectedId = m.selectedId ?? selectedId;
    if (m.claims) { claims = m.claims; applyClaims(); }
    if (m.roster) roster = m.roster;
    const v = view();
    const p = m.split && m.positions[v];
    const worker = m.remoteStaff && m.remoteStaff[v];
    $("posHead").innerHTML = p ? `<b>${esc(p.cs)}</b> · ${esc(p.name)} · <b>${p.freq}</b>${m.staffed.includes(v) ? (worker && worker !== nick ? ` · <i>${esc(worker)}</i>` : "") : " · <i>AI controller</i>"}` : `<b>combined DEL/GND/TWR</b>${m.hostNick ? " · " + esc(m.hostNick) : ""}`;
    $("txOn").textContent = canTx() ? `TX ${v === "ALL" ? "" : v} ${p ? p.freq : ""}` : "RX";
    $("atisBox").innerHTML = m.atis;
    $("status").textContent = m.t;
    if (m.wx != null) { $("wxPanel").innerHTML = m.wx; $("wxPanel").classList.toggle("hidden", !(panel === "wx" || (!panel && radar.view === "TWR"))); }
    if (m.seq != null) { $("seqPanel").innerHTML = m.seq; $("seqPanel").classList.toggle("hidden", !(panel === "seq" || (!panel && m.seqOn))); }
    if (m.del != null) $("clrList").innerHTML = m.del;
    $("delPanel").classList.toggle("hidden", !(panel === "del" || (!panel && (v === "DEL" || radar.view === "DEL"))));
    const lg = (m.logs[m.split ? v : "ALL"] || []);
    const box = $("log");
    const html = lg.map(e => `<div class="${e.cls}">${e.html}</div>`).join("");
    if (box._last !== html) { box.innerHTML = html; box._last = html; box.parentElement.scrollTop = box.parentElement.scrollHeight; }
    renderStrips({ el: $("stripBoard"), ac: m.ac, pos: m.split ? v : "ALL", selectedId, split: m.split, touch: role === "board" || "ontouchstart" in window,
      onSelect: (id) => { selectedId = id; if (!remote) link.send({ type: "select", id }); },
      onMove: (id, bay) => link.send({ type: "strip", id, bay }),
      onEdit: (id, field, value) => link.send({ type: "strip", id, field, value }),
      onAccept: (id) => link.send({ type: "strip", id, accept: true }) });
    renderCoord(m.coords || []);
    if (m.chat && !remote) { chat = m.chat; renderChat(); }
    renderTabs();
  }
  function applyClaims() {
    if (!remote || !link.id) return;
    const mine = claims[link.id] || "";
    if (mine !== myPos) { myPos = mine; if (mine) pos = mine; onPosChange(); if (mine) alertMsg(`You now work ${mine}.`); }
  }
  // ---------- transmitting: typed, or push-to-talk (Ctrl+Space / the mic button) in a remote window ----------
  $("cmdForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const text = $("cmd").value.trim(); $("cmd").value = "";
    if (!text) return;
    if (!canTx()) { alertMsg(role === "guest" ? "Claim a position first (click its tab)." : "This window does not transmit."); return; }
    link.send({ type: "tx", pos: remote ? myPos : pos, text });
  });
  if (remote && role === "guest") {
    const ptt = new Ptt({ onText: (t) => { if (canTx()) link.send({ type: "tx", pos: myPos, text: t }); }, onPartial: (t) => { $("cmd").value = t; }, onInfo: alertMsg, cmd: $("cmd"),
      phrases: () => (state ? state.ac.filter(a => a.freq === myPos).flatMap(a => [a.cs, `${a.tel} ${a.num}`.trim()]) : []) });
    const down = (on) => { if (!canTx()) return; $("mic").classList.toggle("live", on); if (on) { radio.burst && radio.burst(0.03, 0.2); ptt.start(); } else ptt.stop(); };
    $("mic").addEventListener("mousedown", () => down(true));
    window.addEventListener("mouseup", () => down(false));
    window.addEventListener("keydown", (e) => { if (e.code === "Space" && e.ctrlKey && !e.repeat) { e.preventDefault(); down(true); } });
    window.addEventListener("keyup", (e) => { if (e.code === "Space" || e.key === "Control") down(false); });
  } else $("mic").classList.add("hidden");
  // ---------- window placement: a pop-out tells the main window where it sits (restored by the layout) ----------
  if (!remote) {
    let last = "";
    setInterval(() => {
      const b = { x: window.screenX, y: window.screenY, w: window.outerWidth, h: window.outerHeight };
      const s = JSON.stringify(b);
      if (s !== last && b.w > 100) { last = s; link.send({ type: "bounds", key, bounds: b }); }
    }, 2000);
    window.addEventListener("beforeunload", () => link.send({ type: "closed", pos: key }));
    link.send({ type: "hello", pos });
  }
  const fs = document.createElement("button"); fs.className = "fsbtn"; fs.type = "button"; fs.title = "Full screen (Esc leaves it)"; fs.textContent = "⛶";
  fs.addEventListener("click", () => { if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen().catch(() => {}); });
  document.body.appendChild(fs);
  renderChat(); renderBar(); renderTabs();
  if (!panel || panel === "radar") {
    function frame() {
      if (state && apt) {
        const arrEnd = apt.findRunwayEnd(state.arrEnd);
        radar.draw({ ac: state.ac, arrEnd }, selectedId);
      } else radar.draw({ ac: [], arrEnd: null }, null);
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }
  window.TT = { get state() { return state; }, get pos() { return view(); }, get myPos() { return myPos; }, role, remote, key, radio,
    get id() { return link.id; }, send: (m) => link.send(m), get chat() { return chat; }, get claims() { return claims; }, get roster() { return roster; } };
}
