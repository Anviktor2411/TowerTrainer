// SimBrief in the page (Phase S1): the OFP panel, the route on the map, and the few calls to server.py
// (/api/simbrief/*). The server does the fetching the official way and caches the last OFP; this file only
// asks for it when the pilot presses a button (plus one automatic load when a session starts).
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

export async function fetchOfp({ user, refresh = false }) {
  const r = await fetch(`/api/simbrief/latest?user=${encodeURIComponent(user || "")}&refresh=${refresh ? 1 : 0}`);
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j.plan || null;
}
export async function importOfp(rawJson) {
  const r = await fetch("/api/simbrief/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: rawJson });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j.plan;
}
export async function planUrl(params, apiKey) {
  const r = await fetch("/api/simbrief/plan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ params, api_key: apiKey || "" }) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j.url;
}

export const fl = (ft) => (ft >= 6000 ? `FL${String(Math.round(ft / 100)).padStart(3, "0")}` : `${ft} ft`);
const mins = (s) => `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}`;
const kg = (v, plan) => `${Math.round(v).toLocaleString("en")} ${plan.units}`;
const hhmm = (t) => (t && t.hhmm ? t.hhmm.slice(0, 2) + ":" + t.hhmm.slice(2) + "z" : "—");

/** The panel's HTML. */
export function renderOfp(plan, opts = {}) {
  if (!plan) return `<p class="muted small">${opts.user ? "No OFP loaded yet — press Fetch latest OFP." : "Enter your SimBrief username or pilot ID in Settings → SimBrief, then Fetch latest OFP."}</p>`;
  const a = plan.aircraft, w = plan.weights, f = plan.fuel, t = plan.times;
  const bad = (k) => (w.ok && w.ok[k] === false ? ' class="warn"' : "");
  const age = plan.fetched ? Math.round((Date.now() / 1000 - plan.fetched) / 60) : null;
  return `<div class="ofp">
    <div class="ofphead"><b>${esc(plan.callsign)}</b> ${esc(a.type)}/${esc(a.wtc)} ${esc(a.reg_display || a.reg)} · <b>${esc(plan.origin.icao)}</b> ${esc(plan.origin.rwy ? "RWY " + plan.origin.rwy : "")} → <b>${esc(plan.destination.icao)}</b> ${esc(plan.destination.rwy ? "RWY " + plan.destination.rwy : "")}${plan.alternate.icao ? " · ALTN " + esc(plan.alternate.icao) : ""}
      <span class="muted small">${age != null ? (age < 1 ? "just fetched" : age + " min ago") : ""}${plan.airac ? " · AIRAC " + esc(plan.airac) : ""}</span></div>
    <div class="ofprow"><span>Route</span><span>${esc(plan.sid ? plan.sid + " " : "")}${esc(plan.route)}${plan.star ? " " + esc(plan.star) : ""}</span></div>
    <div class="ofprow"><span>Level</span><span>${esc(fl(plan.initial_alt_ft))}${plan.steps && plan.steps.length > 1 ? " · steps " + plan.steps.map(s => `${s.fix}/${fl(s.alt_ft)}`).join(" ") : ""} · ${plan.cruise_tas ? "TAS " + plan.cruise_tas : ""} ${plan.cruise_mach ? "M" + plan.cruise_mach.toFixed(2) : ""} · CI ${esc(plan.cost_index)}</span></div>
    <div class="ofprow"><span>Times</span><span>EOBT ${hhmm(t.eobt)} · ETD ${hhmm(t.etd)} · ETA ${hhmm(t.eta)} · enroute ${mins(t.enroute_s)} · block ${mins(t.block_s)}</span></div>
    <div class="ofprow"><span>Fuel</span><span>block ${kg(f.block, plan)} · trip ${kg(f.trip, plan)} · altn ${kg(f.alternate, plan)} · reserve ${kg(f.reserve, plan)} · extra ${kg(f.extra, plan)} · min T/O ${kg(f.min_takeoff, plan)}</span></div>
    <div class="ofprow"><span>Weights</span><span><span${bad("zfw")}>ZFW ${kg(w.zfw, plan)}/${kg(w.max_zfw, plan)}</span> · <span${bad("tow")}>TOW ${kg(w.tow, plan)}/${kg(w.max_tow, plan)}</span> · <span${bad("ldw")}>LW ${kg(w.ldw, plan)}/${kg(w.max_ldw, plan)}</span> · ${w.pax} pax · cargo ${kg(w.cargo, plan)}</span></div>
    <div class="ofprow"><span>Equip</span><span>${esc(a.equip)}${a.pbn ? " · PBN/" + esc(a.pbn) : ""}${a.selcal ? " · SELCAL " + esc(a.selcal) : ""}</span></div>
    <div class="ofprow"><span>WX ${esc(plan.origin.icao)}</span><span class="mono">${esc(plan.origin.metar)}<br>${esc(plan.origin.taf)}</span></div>
    <div class="ofprow"><span>WX ${esc(plan.destination.icao)}</span><span class="mono">${esc(plan.destination.metar)}<br>${esc(plan.destination.taf)}</span></div>
    ${plan.alternate.icao && plan.alternate.metar ? `<div class="ofprow"><span>WX ${esc(plan.alternate.icao)}</span><span class="mono">${esc(plan.alternate.metar)}</span></div>` : ""}
    <details><summary>ICAO flight plan</summary><pre class="mono">${esc(plan.fpl)}</pre></details>
    <details><summary>Waypoints (${plan.fixes.length})</summary><table class="score small"><tr><th>Fix</th><th>Via</th><th>Alt</th><th>Wind</th><th>Time</th><th>Fuel</th></tr>${plan.fixes.map(x => `<tr><td>${esc(x.ident)}</td><td>${esc(x.airway)}</td><td>${esc(fl(x.alt_ft))}</td><td>${String(x.wind_dir).padStart(3, "0")}/${x.wind_spd}</td><td>${mins(x.time_total_s)}</td><td>${x.fuel_onboard}</td></tr>`).join("")}</table></details>
    <div class="row">${plan.links.pdf ? `<a href="${esc(plan.links.pdf)}" target="_blank" rel="noopener">Open full OFP ↗</a>` : ""}${plan.links.skyvector ? ` <a href="${esc(plan.links.skyvector)}" target="_blank" rel="noopener">SkyVector ↗</a>` : ""}</div>
  </div>`;
}

/** The route as map points for the radar: [{p:[x,y], id, alt}] in the airport's local metres. */
export function routePoints(plan, apt) {
  if (!plan || !apt) return [];
  return plan.fixes.filter(x => x.lat && x.lon && x.type !== "ltlg").map(x => ({ p: apt.toXY(x.lat, x.lon), id: x.ident, alt: x.alt_ft, sidstar: x.sidstar }));
}
