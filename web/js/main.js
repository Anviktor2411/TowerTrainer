import { Airport } from "./airport.js";
import { Sim } from "./sim.js";
import { Radio } from "./radio.js";
import { Radar, STATE_SHORT } from "./render.js";
import { parse } from "./commands.js";

const $ = (id) => document.getElementById(id);
const radar = new Radar($("radar"));
const radio = new Radio();
let sim = null, apt = null, selected = null, speed = 1, metar = null;

const store = { get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } } };

// ---------- log ----------
function log(cls, html) {
  const el = document.createElement("div");
  el.className = cls; el.innerHTML = html;
  const box = $("log"); box.appendChild(el);
  while (box.children.length > 200) box.firstChild.remove();
  box.parentElement.scrollTop = box.parentElement.scrollHeight;
}
const esc = (s) => String(s).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
radio.on((m) => {
  if (m.from === "atc") log("atc", `<b>ATC</b> ${esc(m.text)}`);
  else log(`pilot ${m.ac.kind}`, `<b>${esc(m.ac.cs)}</b> ${esc(m.text)}`);
});

function alertBox(msg) {
  log("err", "⚠ " + esc(msg));
  const d = document.createElement("div"); d.textContent = msg;
  $("alerts").appendChild(d);
  setTimeout(() => d.remove(), 12000);
}

// ---------- airport loading ----------
async function loadAirport(icao) {
  icao = icao.trim().toUpperCase();
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
  store.set("icao", icao);
  $("aptIcao").value = icao;
  const nTaxi = apt.edges.length;
  $("aptName").textContent = `${apt.name}${nTaxi ? "" : " — no taxi routes in Gateway data, aircraft can't taxi here"}`;
  sim = new Sim(apt, {
    onRadio: (m) => radio.pilot(m.ac, m.text),
    onAlert: alertBox,
  });
  sim.depPerHour = +$("depRate").value; sim.arrPerHour = +$("arrRate").value;
  selected = null;
  radar.setAirport(apt);
  $("log").innerHTML = "";

  const sel = $("rwySel"); sel.innerHTML = "";
  for (const r of apt.runways) for (const e of r.ends) sel.add(new Option(e.name, e.name));
  metar = null; $("metar").textContent = "";
  try {
    const m = await (await fetch(`/api/metar/${icao}`)).json();
    if (m) { metar = m; $("metar").textContent = m.rawOb; $("metar").title = m.rawOb; }
  } catch { /* offline */ }
  const best = pickRunway(apt, metar);
  sel.value = best; sim.setRunway(best);
  const tw = apt.freq.tower, gnd = apt.freq.ground;
  log("sys", `${esc(apt.icao)} ${esc(apt.name)} · runway ${esc(best)} in use` +
    (metar && metar.wdir !== undefined ? ` (wind ${esc(metar.wdir)}°/${esc(metar.wspd)} kt)` : "") +
    (tw ? ` · TWR ${tw.mhz.toFixed(3)}` : "") + (gnd ? ` · GND ${gnd.mhz.toFixed(3)}` : "") +
    ` · ${apt.stands.length} stands, ${nTaxi} taxi segments. You are working DEL/GND/TWR combined.`);
}

function pickRunway(apt, m) {
  let best = apt.runways[0].ends[0], bs = -Infinity;
  const wdir = m && typeof m.wdir === "number" ? m.wdir : null, wspd = m ? (m.wspd || 0) : 0;
  for (const r of apt.runways) for (const e of r.ends) {
    let s = r.len / 1000; // tie-break: longest
    if (wdir !== null) s += Math.cos((wdir - e.hdg) * Math.PI / 180) * Math.max(wspd, 1) * 10;
    if (s > bs) { bs = s; best = e; }
  }
  return best.name;
}

// ---------- strips ----------
function strips() {
  if (!sim) return;
  const groups = { stripsDel: [], stripsGnd: [], stripsTwr: [] };
  for (const a of sim.ac) {
    const s = a.state;
    let g = "stripsTwr";
    if (a.kind === "dep" && ["parked", "clr_req"].includes(s)) g = "stripsDel";
    else if (a.kind === "dep" && ["cleared", "push_req", "pushing", "pushed", "taxi_req", "taxi"].includes(s)) g = "stripsGnd";
    else if (a.kind === "arr" && ["vacated", "taxi", "holding_short", "parked"].includes(s)) g = "stripsGnd";
    groups[g].push(a);
  }
  for (const [id, list] of Object.entries(groups)) {
    $(id).innerHTML = list.map(a => {
      const route = a.kind === "dep" ? `→${a.other[0]}` : `${a.other[0]}→`;
      const extra = a.kind === "dep" ? (a.stand ? a.stand.name : a.depEnd ? a.depEnd.name : "") : (a.stand ? a.stand.name : "");
      return `<div class="strip ${a.kind}${a === selected ? " sel" : ""}" data-id="${a.id}">` +
        `<span class="cs">${esc(a.cs)}</span><span>${esc(a.type)}/${a.wtc}</span>` +
        `<span>${route} ${a.squawk ? "A" + a.squawk : ""} ${esc(extra)}</span>` +
        `<span class="st">${STATE_SHORT[s(a)] || s(a)}</span></div>`;
    }).join("");
  }
  function s(a) { return a.state; }
}
for (const id of ["stripsDel", "stripsGnd", "stripsTwr"]) {
  $(id).addEventListener("click", (e) => {
    const el = e.target.closest(".strip"); if (!el || !sim) return;
    select(sim.ac.find(a => a.id === +el.dataset.id));
  });
}
function select(a) {
  selected = a || null;
  const inp = $("cmd");
  if (a) { inp.value = a.cs + " "; inp.focus(); }
  strips();
}
radar.onSelect = select;

// ---------- transmitting ----------
function transmit(text) {
  text = text.trim();
  if (!text || !sim) return;
  radio.controller(text);
  const { ac, explicit, ins } = parse(text, sim.ac, selected);
  if (!ac) { log("sys", "No aircraft on frequency answered (callsign not recognised)."); return; }
  if (!explicit) log("sys", `(no callsign — assumed ${esc(ac.cs)})`);
  radio.pilot(ac, sim.instruct(ac, ins), 1.0);
}
$("cmdForm").addEventListener("submit", (e) => { e.preventDefault(); transmit($("cmd").value); $("cmd").value = selected ? selected.cs + " " : ""; });

// ---------- push-to-talk (browser speech recognition) ----------
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null, recText = "", pttDown = false;
function pttStart() {
  if (!SR || pttDown) { if (!SR) log("sys", "Speech recognition needs Chrome or Edge."); return; }
  pttDown = true; recText = "";
  rec = new SR(); rec.lang = "en-US"; rec.interimResults = true; rec.continuous = true;
  rec.onresult = (e) => {
    recText = [...e.results].map(r => r[0].transcript).join(" ");
    $("cmd").value = recText;
  };
  rec.onend = () => { if (recText) transmit(recText); recText = ""; $("cmd").value = ""; };
  rec.start(); $("mic").classList.add("live");
}
function pttStop() {
  if (!pttDown) return;
  pttDown = false; $("mic").classList.remove("live");
  setTimeout(() => rec && rec.stop(), 350); // let the last word arrive
}
$("mic").addEventListener("mousedown", pttStart);
window.addEventListener("mouseup", pttStop);
window.addEventListener("keydown", (e) => { if (e.code === "Space" && e.ctrlKey && !e.repeat) { e.preventDefault(); pttStart(); } });
window.addEventListener("keyup", (e) => { if (e.code === "Space" || e.key === "Control") pttStop(); });

// ---------- controls ----------
$("aptForm").addEventListener("submit", (e) => { e.preventDefault(); loadAirport($("aptIcao").value); });
$("rwySel").addEventListener("change", (e) => { if (sim) { sim.setRunway(e.target.value); log("sys", `Runway in use: ${esc(e.target.value)}`); } });
$("depRate").addEventListener("change", (e) => { if (sim) sim.depPerHour = +e.target.value; });
$("arrRate").addEventListener("change", (e) => { if (sim) sim.arrPerHour = +e.target.value; });
$("speed").addEventListener("change", (e) => { speed = +e.target.value; });
$("tts").addEventListener("change", (e) => { radio.tts = e.target.checked; if (!radio.tts) speechSynthesis.cancel(); });
$("graph").addEventListener("change", (e) => { radar.showGraph = e.target.checked; });
$("helpBtn").addEventListener("click", () => $("help").showModal());

// ---------- loop ----------
let last = performance.now(), stripT = 0;
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000); last = now;
  if (sim && speed > 0) {
    const n = speed; for (let i = 0; i < n; i++) sim.step(dt);
    if (selected && selected.gone) selected = null;
  }
  radar.draw(sim || { ac: [], arrEnd: null }, selected);
  if (sim) {
    stripT += dt;
    if (stripT > 0.5) {
      stripT = 0; strips();
      const st = sim.stats, mm = Math.floor(sim.t / 60), ss = String(Math.floor(sim.t % 60)).padStart(2, "0");
      $("status").textContent = `${mm}:${ss}  DEP ${st.departures}  ARR ${st.arrivals}  G/A ${st.goArounds}  ALERTS ${st.alerts}` +
        (speed === 0 ? "  [PAUSED]" : speed > 1 ? `  [${speed}×]` : "");
    }
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
loadAirport(new URLSearchParams(location.search).get("icao") || store.get("icao", "EETN"));
// expose for debugging / automated tests
window.TT = { get sim() { return sim; }, get apt() { return apt; }, transmit, parse, radio };
