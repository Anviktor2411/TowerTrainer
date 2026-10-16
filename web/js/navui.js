// Nav data in the page (F1-F4, B2): one search box (Ctrl+K) over airports, fixes, navaids, airways, procedures and
// frequencies; the result on the map with its details; the NAV pill with folder, cycle and indexing progress;
// the nav settings (X-Plane installs, sector package, OpenAIP key, "Reload nav data"); VFR reporting points with
// a click-on-the-map editor. Talks only to the local server (/api/nav/*, /api/vfr/*).
import { setNavVocab } from "./commands.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};
const getJson = async (url, opts) => { const r = await fetch(url, opts); if (!r.ok) throw new Error(r.statusText); return r.json(); };
const KIND_ICON = { airport: "✈", fix: "△", navaid: "⬡", airway: "═", procedure: "↗", freq: "📻" };

/**
 * hooks: { radar, apt(), sim(), loadAirport(icao), sysLog(text), onVfr(points, info) }
 */
export function installNavUi(hooks) {
  const ui = { status: null, vfr: null, editing: false, airportIcao: null };
  injectDom();
  const box = $("navSearch"), list = $("navResults"), detail = $("navDetail");
  let results = [], pick = 0, timer = null;

  // ---------------------------------------------------------------- search
  const near = () => { const a = hooks.apt(); return a ? { lat: a.d.lat ?? a.lat, lon: a.d.lon ?? a.lon } : null; };
  async function search(q) {
    const n = near();
    if (!q.trim()) { showList(await nearestAndRecent()); return; }
    try {
      results = await getJson(`/api/nav/search?q=${encodeURIComponent(q)}${n ? `&lat=${n.lat}&lon=${n.lon}` : ""}&limit=25`);
    } catch { results = []; }
    showList(results);
  }
  async function nearestAndRecent() {
    const recent = store.get("tt.navRecent", []).map(r => ({ ...r, recent: true }));
    const n = near();
    let nearest = [];
    if (n) try { nearest = (await getJson(`/api/nav/nearest?lat=${n.lat}&lon=${n.lon}&n=8`)).slice(1); } catch { /* no index yet */ }
    return [...recent.slice(0, 6), ...nearest.map(x => ({ ...x, nearest: true }))];
  }
  function showList(items) {
    results = items; pick = 0;
    if (!items.length) {
      const st = ui.status;
      list.innerHTML = `<div class="muted small nr">${st && st.state === "building" ? `Indexing nav data… ${Math.round(st.progress * 100)}%` : st && st.state !== "ready" ? "No nav database (see Settings → Navigation data)" : "Nothing found"}</div>`;
    } else {
      list.innerHTML = items.map((r, i) => `<div class="nr${i === pick ? " pick" : ""}" data-i="${i}"><span class="ico">${KIND_ICON[r.kind] || "•"}</span>${esc(r.label || r.ident)}` +
        `${r.nm != null ? `<span class="muted"> ${r.nm} NM</span>` : ""}${r.recent ? '<span class="muted"> · recent</span>' : r.nearest ? '<span class="muted"> · nearest</span>' : ""}</div>`).join("");
    }
    list.classList.remove("hidden");
  }
  function movePick(d) {
    if (!results.length) return;
    pick = (pick + d + results.length) % results.length;
    list.querySelectorAll(".nr").forEach((el, i) => el.classList.toggle("pick", i === pick));
  }
  box.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(() => search(box.value), 140); });
  box.addEventListener("focus", () => search(box.value));
  box.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); movePick(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); movePick(-1); }
    else if (e.key === "Enter") { e.preventDefault(); if (results[pick]) choose(results[pick]); }
    else if (e.key === "Escape") { list.classList.add("hidden"); box.blur(); }
  });
  list.addEventListener("mousedown", (e) => { const el = e.target.closest(".nr[data-i]"); if (el) { e.preventDefault(); choose(results[+el.dataset.i]); } });
  box.addEventListener("blur", () => setTimeout(() => list.classList.add("hidden"), 150));
  window.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); box.focus(); box.select(); }
  });

  async function choose(r) {
    list.classList.add("hidden");
    const recent = store.get("tt.navRecent", []).filter(x => !(x.kind === r.kind && x.id === r.id));
    recent.unshift({ kind: r.kind, id: r.id, ident: r.ident, label: r.label, lat: r.lat, lon: r.lon });
    store.set("tt.navRecent", recent.slice(0, 12));
    let item = r;
    const n = near();
    if (["airport", "fix", "navaid", "airway"].includes(r.kind)) {
      try { item = { ...r, ...(await getJson(`/api/nav/item?kind=${r.kind}&id=${encodeURIComponent(r.kind === "airport" || r.kind === "airway" ? r.id : r.ident)}${n ? `&lat=${n.lat}&lon=${n.lon}` : ""}`)) }; } catch { /* keep the search row */ }
    }
    if (r.kind === "airway" && item.segments && item.segments.length) { item.lat = item.segments[0].a[0]; item.lon = item.segments[0].a[1]; }
    item.label = r.label || item.ident;
    hooks.radar.showItem(item);
    showDetail(item);
  }

  function showDetail(it) {
    const rows = [];
    if (it.kind === "airport") {
      rows.push(`<b>${esc(it.ident)}${it.iata ? " / " + esc(it.iata) : ""}</b> ${esc(it.name || "")}${it.city ? ", " + esc(it.city) : ""}${it.country ? " (" + esc(it.country) + ")" : ""}`);
      if (it.elev != null) rows.push(`Elevation ${it.elev} ft`);
      if (it.runways && it.runways.length) rows.push("Runways: " + it.runways.map(r => `${r.ends.join("/")} ${r.len_m ? r.len_m + " m" : ""}`).join(" · "));
      if (it.freqs && it.freqs.length) rows.push("Frequencies: " + it.freqs.map(f => `${f.kind} ${f.mhz.toFixed(3)}`).join(" · "));
      if (it.procedures && it.procedures.length) rows.push("Procedures: " + it.procedures.slice(0, 40).map(p => esc(p.title)).join(", "));
      rows.push(`<button type="button" id="navLoadApt">Load airport ${esc(it.ident)}</button>`);
    } else if (it.kind === "fix" || it.kind === "navaid") {
      rows.push(`<b>${esc(it.ident)}</b> ${it.kind === "navaid" ? esc(it.type || "") + " " + (it.freq ? (it.type === "NDB" ? Math.round(it.freq) + " kHz" : it.freq.toFixed(2) + " MHz") : "") : "fix"} ${esc(it.name && it.name !== it.ident ? it.name : "")}`);
      if (it.spoken) rows.push(`Spoken: “${esc(it.spoken)}”`);
      if (it.airways && it.airways.length) rows.push("Airways: " + it.airways.map(a => `${esc(a.name)} (${a.level === "H" ? "high" : "low"} FL${String(a.base).padStart(3, "0")}-FL${String(a.top).padStart(3, "0")})`).join(", "));
      if (it.holds && it.holds.length) rows.push("Holding: " + it.holds.map(h => `inbound ${Math.round(h.inbound)}°, ${h.turn === "L" ? "left" : "right"} turns, ${h.legdist ? h.legdist + " NM" : (h.legtime || 1) + " min"} legs${h.min ? ", min " + h.min + " ft" : ""}`).join("; "));
      if (it.procedures && it.procedures.length) rows.push("Procedures: " + it.procedures.map(p => `${esc(p.title)} (${esc(p.airport)})`).join(", "));
    } else if (it.kind === "airway") {
      rows.push(`<b>${esc(it.ident)}</b> airway`);
      if (it.segments) rows.push(it.segments.map(s => `${esc(s.from)}–${esc(s.to)} ${s.level === "H" ? "high" : "low"} FL${String(s.base).padStart(3, "0")}-FL${String(s.top).padStart(3, "0")}`).join("<br>"));
    } else if (it.kind === "procedure") {
      rows.push(`<b>${esc(it.title)}</b> ${it.proc === "APPCH" ? "approach" : esc(it.proc)} at ${esc(it.airport)}${it.runways && it.runways.length ? ", runway " + it.runways.join("/") : ""}`);
      rows.push(`<span id="navLegs" class="muted">loading legs…</span>`);
      if (hooks.apt() && hooks.apt().icao !== it.airport) rows.push(`<button type="button" id="navLoadApt">Load airport ${esc(it.airport)}</button>`);
    } else if (it.kind === "freq") {
      rows.push(`<b>${esc(it.ident)}</b> ${esc(it.name)}`);
    }
    detail.innerHTML = `<button type="button" class="small close" id="navDetailClose">×</button>` + rows.map(r => `<div>${r}</div>`).join("");
    detail.classList.remove("hidden");
    $("navDetailClose").onclick = () => { detail.classList.add("hidden"); hooks.radar.highlight = null; };
    const load = $("navLoadApt");
    if (load) load.onclick = () => { detail.classList.add("hidden"); hooks.radar.highlight = null; hooks.loadAirport(it.kind === "procedure" ? it.airport : it.ident); };
    if (it.kind === "procedure") procedureLegs(it);
  }
  async function procedureLegs(it) {
    try {
      const p = await getJson(`/api/procedures/${it.airport}`);
      const key = { SID: "sids", STAR: "stars", APPCH: "apps" }[it.proc];
      const proc = (p[key] || []).find(x => x.name === it.ident);
      if (!proc) { $("navLegs").textContent = "no legs"; return; }
      const legs = [...Object.values(proc.rwy || {}).flat(), ...proc.common];
      $("navLegs").innerHTML = legs.map(l => `${esc(l.fix)}${l.alt ? ` <span class="muted">${l.desc === "+" ? "≥" : l.desc === "-" ? "≤" : l.desc === "@" ? "" : ""}${l.alt >= 10000 ? "FL" + Math.round(l.alt / 100) : l.alt}</span>` : ""}`).join(" → ") +
        (proc.missed && proc.missed.length ? `<br>missed: ${proc.missed.map(l => esc(l.fix)).join(" → ")}` : "");
      const pts = legs.filter(l => l.lat != null);
      if (pts.length) { hooks.radar.showItem({ lat: pts[0].lat, lon: pts[0].lon, label: it.title, kind: "procedure", segments: pts.slice(1).map((l, i) => ({ a: [pts[i].lat, pts[i].lon], b: [l.lat, l.lon] })) }); }
    } catch { $("navLegs").textContent = "legs only on the host PC"; }
  }

  // ---------------------------------------------------------------- status / NAV pill
  async function pollStatus() {
    try { ui.status = await getJson("/api/nav/status"); } catch { ui.status = null; }
    renderPill();
    if (ui.status && ui.status.state === "building") setTimeout(pollStatus, 1000);
    else if (ui.status && ui.status.state === "ready" && ui.waitingForIndex) { ui.waitingForIndex = false; if (hooks.apt()) airportLoaded(hooks.apt()); }
    if ($("settings") && $("settings").open) renderSettings();
  }
  function renderPill() {
    const pill = $("navPill"), st = ui.status;
    if (!pill || !st) return;
    const bar = $("navBar");
    if (st.state === "building") {
      bar.classList.remove("hidden"); bar.querySelector("i").style.width = Math.round(st.progress * 100) + "%";
      bar.title = `Indexing nav data: ${st.step} (${Math.round(st.progress * 100)}%)`;
    } else bar.classList.add("hidden");
    const lines = [pill.dataset.base || pill.title || ""];
    lines.push(`Folder: ${st.folder || "none"}${st.airac ? ` · AIRAC ${st.airac}` : ""}${st.current ? ` (current ${st.current})` : ""}`);
    if (st.outdated) lines.push(`⚠ AIRAC ${st.airac} is older than the current cycle ${st.current}: update Navigraph data`);
    lines.push(`Index: ${st.state}${st.state === "building" ? " " + Math.round(st.progress * 100) + "%" : ""}${st.counts && st.counts.airports != null ? ` · ${st.counts.airports} airports, ${st.counts.fixes} fixes, ${st.counts.navaids} navaids, ${st.counts.airways} airway segments, ${st.counts.procs} procedures` : ""}`);
    if (ui.vfr) lines.push(ui.vfr.label + (ui.vfr.attribution ? " " + ui.vfr.attribution : ""));
    pill.title = lines.filter(Boolean).join("\n");
  }
  /** Called by main.js after it set the pill from the procedures: keep its text as the first tooltip line. */
  function decoratePill() {
    const pill = $("navPill");
    if (!pill) return;
    pill.dataset.base = pill.title;
    renderPill();
  }

  // ---------------------------------------------------------------- an airport was loaded
  async function airportLoaded(apt) {
    ui.airportIcao = apt.icao;
    const lat = apt.d.lat ?? apt.lat, lon = apt.d.lon ?? apt.lon;
    if (!ui.status || ui.status.state !== "ready") ui.waitingForIndex = true;     // airport loading never waits for the index
    loadVfr(apt);
    if (ui.status && ui.status.state === "ready") {
      try { hooks.radar.setNavLayers(await getJson(`/api/nav/area?lat=${lat}&lon=${lon}&r=80`)); } catch { /* remote player */ }
      try { setNavVocab(await getJson(`/api/nav/vocab?lat=${lat}&lon=${lon}&icao=${apt.icao}`)); } catch { setNavVocab(null); }
    }
  }
  async function loadVfr(apt) {
    let info = null;
    try { info = await getJson(`/api/vfr/${apt.icao}`); } catch { /* remote */ }
    ui.vfr = info || { source: "generic", label: "VFR points: generic", points: [] };
    if (hooks.apt() !== apt) return;
    hooks.onVfr(ui.vfr.points.map(p => ({ ...p, p: apt.toXY(p.lat, p.lon) })), ui.vfr);
    renderPill();
    if ($("settings") && $("settings").open) renderVfrEditor();
  }

  // ---------------------------------------------------------------- settings: installs, sources, VFR editor
  function renderSettings() {
    const el = $("navSettings"), st = ui.status;
    if (!el) return;
    if (!st) { el.innerHTML = '<div class="small muted">Nav data is read on the host PC only.</div>'; return; }
    const s = st.settings || {};
    const installs = (st.installs || []).map(i => `<label class="small"><input type="radio" name="navXp" value="${esc(i.path)}" ${i.valid ? "" : "disabled"} ${(s.xplane || st.xplane) === i.path ? "checked" : ""}>
      ${esc(i.path)} — ${i.valid ? `X-Plane ${i.version}${i.navigraph ? ", Navigraph" : ""}${i.airac ? " AIRAC " + i.airac : ""}` : `<span class="warnc">not used: ${esc(i.why || "")}</span>`}</label>`).join("");
    el.innerHTML = `
      <div class="small">${esc(st.label || "")}${st.outdated ? ' <span class="warnc">— outdated</span>' : ""}</div>
      <div class="small muted">Index: ${esc(st.state)}${st.state === "building" ? " " + Math.round(st.progress * 100) + "% (" + esc(st.step) + ")" : ""}${st.error ? " — " + esc(st.error) : ""}</div>
      <div class="small"><b>X-Plane installs found</b> (the best one is used automatically):</div>
      <label class="small"><input type="radio" name="navXp" value="" ${!s.xplane ? "checked" : ""}> Automatic (Navigraph data and the newest AIRAC first)</label>${installs || '<div class="small muted">none found</div>'}
      <label class="small">Data <select id="navMode"><option value="auto">Navigraph → X-Plane default (merged)</option><option value="navigraph">Navigraph Custom Data only</option><option value="default">X-Plane default data only</option></select></label>
      <label class="small">EuroScope sector package folder <input id="navSector" value="${esc(s.sector || "")}" placeholder="C:\\Users\\…\\EuroScope\\EE-FIR" size="34"></label>
      <label class="small">OpenAIP API key (optional, your own) <input id="navOpenaip" type="password" placeholder="${ui.status.openaip ? "saved" : ""}" size="24"></label>
      <div><button type="button" id="navReload">Reload nav data</button> <span class="small muted">detects X-Plane again; rebuilds the index only when the data changed</span></div>
      <div id="vfrEditor"></div>`;
    $("navMode").value = s.mode || "auto";
    const saveNav = async (extra = {}) => {
      const xp = (document.querySelector('input[name="navXp"]:checked') || {}).value || "";
      const body = { xplane: xp, mode: $("navMode").value, sector: $("navSector").value.trim(), ...extra };
      if ($("navOpenaip").value.trim()) body.openaip_key = $("navOpenaip").value.trim();
      try { ui.status = await getJson("/api/nav/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); } catch { /* */ }
      pollStatus();
      if (hooks.apt()) { hooks.reloadProcedures && hooks.reloadProcedures(); loadVfr(hooks.apt()); }
    };
    el.querySelectorAll('input[name="navXp"]').forEach(r => r.onchange = () => saveNav());
    $("navMode").onchange = () => saveNav();
    $("navSector").onchange = () => saveNav();
    $("navOpenaip").onchange = () => saveNav();
    $("navReload").onclick = async () => {
      try { ui.status = await getJson("/api/nav/reload", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }); } catch { /* */ }
      hooks.sysLog("Nav data: detection repeated" + (ui.status ? ` — ${ui.status.label}` : ""));
      pollStatus();
      if (hooks.apt()) { hooks.reloadProcedures && hooks.reloadProcedures(); airportLoaded(hooks.apt()); }
    };
    renderVfrEditor();
  }

  function renderVfrEditor() {
    const el = $("vfrEditor");
    if (!el) return;
    const apt = hooks.apt(), v = ui.vfr;
    if (!apt) { el.innerHTML = ""; return; }
    const pts = v && v.source === "user" ? v.points : [];
    el.innerHTML = `<div class="small"><b>VFR reporting points ${esc(apt.icao)}</b> — now: ${esc(v ? v.label : "?")}${v && v.attribution ? " " + esc(v.attribution) : ""}</div>
      <div class="small muted">Order: sector file → your file vfr_points/${esc(apt.icao)}.json → OpenAIP (with your key) → generic placeholders.
      Copy points from the eAIP VFR chart: press “Add on the map”, then click each point.</div>
      <table class="small vfrt">${pts.map((p, i) => `<tr><td><input data-i="${i}" data-k="name" value="${esc(p.name)}" size="10"></td><td><input data-i="${i}" data-k="alt" value="${p.alt}" size="5"> ft</td>
        <td><select data-i="${i}" data-k="type"><option value="compulsory" ${p.type !== "on-request" ? "selected" : ""}>compulsory</option><option value="on-request" ${p.type === "on-request" ? "selected" : ""}>on request</option></select></td>
        <td class="muted">${p.lat.toFixed(4)} ${p.lon.toFixed(4)}</td><td><button type="button" data-del="${i}" class="small">✕</button></td></tr>`).join("")}</table>
      <button type="button" id="vfrAdd" class="small">${ui.editing ? "Stop adding" : "Add on the map"}</button>
      ${v && v.source !== "user" && v.points.length ? '<button type="button" id="vfrCopy" class="small">Copy the current points into my file</button>' : ""}`;
    const userPts = () => (ui.vfr && ui.vfr.source === "user" ? ui.vfr.points : []).map(p => ({ ...p }));
    el.querySelectorAll("input[data-i], select[data-i]").forEach(inp => inp.onchange = () => {
      const list = userPts(); const p = list[+inp.dataset.i]; p[inp.dataset.k] = inp.dataset.k === "alt" ? +inp.value || 1500 : inp.value; saveVfr(list);
    });
    el.querySelectorAll("button[data-del]").forEach(b => b.onclick = () => { const list = userPts(); list.splice(+b.dataset.del, 1); saveVfr(list); });
    $("vfrAdd").onclick = () => setEditing(!ui.editing);
    if ($("vfrCopy")) $("vfrCopy").onclick = () => saveVfr(ui.vfr.points.map(p => ({ name: p.name, lat: p.lat, lon: p.lon, alt: p.alt, type: p.type })));
  }
  function setEditing(on) {
    ui.editing = on;
    hooks.radar.onMapClick = on ? (w) => {
      const apt = hooks.apt(); if (!apt) return;
      const name = prompt("Name of the VFR reporting point (as on the chart, e.g. Bravo, Harku):");
      if (!name) return;
      const alt = +prompt("Altitude (ft):", "1500") || 1500;
      const [lat, lon] = apt.toLatLon(w);
      saveVfr([...(ui.vfr && ui.vfr.source === "user" ? ui.vfr.points : []), { name, lat, lon, alt, type: "compulsory" }]);
    } : null;
    if (on) { $("settings").close(); hooks.sysLog("VFR point editor: click on the map to add a point (Settings → Navigation data → Stop adding)."); }
    renderVfrEditor();
  }
  async function saveVfr(points) {
    const apt = hooks.apt(); if (!apt) return;
    try {
      ui.vfr = await getJson(`/api/vfr/${apt.icao}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ points }) });
      if (!ui.vfr.points.length) ui.vfr = await getJson(`/api/vfr/${apt.icao}`);
    } catch { return; }
    hooks.onVfr(ui.vfr.points.map(p => ({ ...p, p: apt.toXY(p.lat, p.lon) })), ui.vfr);
    renderVfrEditor(); renderPill();
  }

  $("settingsBtn").addEventListener("click", () => { renderSettings(); pollStatus(); });
  pollStatus();
  return { airportLoaded, decoratePill, pollStatus, choose, search: (q) => search(q), get status() { return ui.status; }, get vfr() { return ui.vfr; },
    validateRoute: async (route, dep, dest) => { try { return await getJson("/api/nav/route", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ route, dep, dest }) }); } catch { return null; } } };
}

function injectDom() {
  const pill = $("navPill");
  if (pill && !$("navSearch")) {
    const wrap = document.createElement("span");
    wrap.className = "navsearch main-only";
    wrap.innerHTML = `<input id="navSearch" placeholder="Search airports, fixes, airways… (Ctrl+K)" spellcheck="false" autocomplete="off"><div id="navResults" class="navresults hidden"></div>`;
    pill.parentNode.insertBefore(wrap, pill);
    const bar = document.createElement("span");
    bar.id = "navBar"; bar.className = "navbar hidden"; bar.innerHTML = "<i></i>";
    pill.parentNode.insertBefore(bar, pill.nextSibling);
  }
  if (!$("navDetail")) {
    const d = document.createElement("div");
    d.id = "navDetail"; d.className = "navdetail hidden";
    (document.querySelector(".scope") || document.body).appendChild(d);
  }
  const grid = document.querySelector("#settings .grid2");
  if (grid && !$("navSettings")) {
    const fs = document.createElement("fieldset");
    fs.className = "span2";
    fs.innerHTML = `<legend>Navigation data (X-Plane / Navigraph / sector files)</legend><div id="navSettings" class="small"></div>`;
    grid.appendChild(fs);
  }
  if (!$("navCss")) {
    const st = document.createElement("style");
    st.id = "navCss";
    st.textContent = `.navsearch{position:relative}.navsearch input{width:230px;font:12px system-ui,sans-serif}
.navresults{position:absolute;top:26px;left:0;z-index:40;width:420px;max-height:60vh;overflow:auto;background:var(--panel,#111a22);border:1px solid var(--line,#2a3644);border-radius:6px;padding:4px 0}
.navresults .nr{padding:3px 10px;cursor:pointer;font:12px system-ui,sans-serif;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.navresults .nr.pick,.navresults .nr:hover{background:#1d3a2a}
.navresults .ico{display:inline-block;width:18px;color:#7CFC9A}.navbar{display:inline-block;width:60px;height:6px;border:1px solid #2f6b45;border-radius:3px;overflow:hidden}.navbar i{display:block;height:100%;width:0;background:#3fb96d}
.navdetail{position:absolute;right:10px;top:42px;z-index:15;max-width:420px;max-height:70%;overflow:auto;background:rgba(13,21,28,.95);border:1px solid #2f6b45;border-radius:6px;padding:8px 10px;font:12px system-ui,sans-serif;color:#d5dee7}
.navdetail div{margin:2px 0}.navdetail .close{float:right}.warnc{color:#ffb347}.vfrt td{padding:1px 4px}`;
    document.head.appendChild(st);
  }
}
