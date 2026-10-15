// The setup wizard page (G6): detection from /api/setup/status, actions through /api/setup/<action>.
// Nothing here downloads or re-hosts EuroScope or sector packages; the user supplies them. Every action
// honours the "dry run" box and the server logs what it did.
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const dry = () => $("dry").checked;
let st = null;
const light = (ok, text) => `<span class="light ${ok === true ? "ok" : ok === false ? "bad" : "warn"}"></span>${text}`;

async function post(action, body) {
  const r = await fetch(`/api/setup/${action}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, dry_run: dry() }) });
  return r.json();
}
function show(el, res) {
  const t = res.dry_run ? "DRY RUN — would do: " : "";
  el.innerHTML = `<div class="out ${res.ok ? "" : "bad"}">${esc(t + JSON.stringify(res, null, 1))}</div>`;
}

async function load() {
  const xp = $("xpExtra") ? $("xpExtra").value.trim() : "";
  const docs = $("esDocs") ? $("esDocs").value.trim() : "";
  st = await (await fetch(`/api/setup/status?xplane=${encodeURIComponent(xp)}&docs=${encodeURIComponent(docs)}`)).json();
  if (st.error) { document.body.innerHTML = `<p class="wiz bad">${esc(st.error)}</p>`; return; }
  $("logPath").textContent = st.log;
  renderPython(); renderEs(); renderXp(); loadLog();
}
function renderPython() {
  const p = st.python;
  $("pyBody").innerHTML = `<div class="kv"><b>Python</b><span>${light(p.ok, `${p.version} — ${esc(p.executable)}`)}${p.ok ? "" : ` · <a href="${p.download}" target="_blank" rel="noopener">install Python 3.9 or newer ↗</a>`}</span><b>pip</b><span>${light(p.pip, p.pip ? "available" : "missing (python -m ensurepip)")}</span></div>` +
    `<p class="small muted">Everything below is optional: the trainer works with the standard library alone. A package is only ever installed into this Python with its own pip.</p>` +
    `<table class="pk"><tr><th>Package</th><th>For</th><th>Size</th><th>Status</th><th></th></tr>` + st.packages.map(k => `<tr><td><code>${esc(k.pip)}</code></td><td>${esc(k.what)}</td><td>${esc(k.size)}</td><td>${light(k.installed, k.installed ? "installed " + esc(k.version) : "not installed")}</td><td>${k.installed ? "" : `<button type="button" data-pip="${esc(k.pip)}">Install</button>`}</td></tr>`).join("") + `</table><div id="pipOut"></div>`;
}
function renderEs() {
  const e = st.euroscope;
  $("esBody").innerHTML = `<div class="kv"><b>EuroScope</b><span>${light(e.installed, e.installed ? esc(e.exe) : "not found")} · <a href="${e.site}" target="_blank" rel="noopener">euroscope.hu ↗</a> <span class="muted small">(the trainer never bundles or re-hosts EuroScope)</span></span>` +
    `<b>Data folder</b><span><input type="text" id="esDocs" value="${esc(e.docs)}"> ${light(e.docs_exists, e.docs_exists ? "exists" : "will be created")}</span>` +
    `<b>Sector packages there</b><span>${e.packages.length ? e.packages.map(p => `<div>${esc(p.name)} <span class="muted small">${esc((p.sct[0] || "").split(/[\\/]/).pop())}</span></div>`).join("") : '<span class="muted">none yet</span>'}</span></div>` +
    `<h3>Radar files: either way</h3>` +
    `<div class="row"><b>A.</b> I have a sector package (zip from a vACC / sector provider): <input type="file" id="esZip" accept=".zip"> <input type="text" id="esZipName" placeholder="folder name (optional)" style="min-width:160px"> <label><input type="checkbox" id="esOverwrite"> allow overwriting</label> <button type="button" id="esUnpack">Unpack into the data folder</button></div>` +
    `<div class="row"><b>B.</b> Generate from the trainer's own data: airport <select id="esIcao">${st.cached.map(c => `<option>${c}</option>`).join("")}</select> callsign <input type="text" id="esCs" placeholder="EETN_TWR" style="min-width:120px"> <label><input type="checkbox" id="esOverwrite2"> allow overwriting</label> <button type="button" id="esGen">Generate .sct/.ese/.asr + profile</button> <span class="muted small">(runways, taxiways, holding points, stands, OSM buildings, SIDs/STARs when Navigraph data is set up)</span></div>` +
    `<div class="row"><b>C.</b> Desktop shortcut: profile <select id="esPrf">${e.profiles.map(p => `<option>${esc(p)}</option>`).join("")}<option value="">(generated TowerTrainer profile)</option></select> <button type="button" id="esShortcut" ${e.installed ? "" : "disabled"}>Create "TowerTrainer EuroScope" shortcut</button></div>` +
    `<p class="small muted">The generated profile connects to 127.0.0.1 with "Connect to VATSIM" off, so EuroScope talks only to this trainer. In EuroScope: Other Set → Open profile, then Connect.</p><div id="esOut"></div>`;
}
function renderXp() {
  const x = st.xplane;
  $("xpBody").innerHTML = `<div class="row">X-Plane folder: <input type="text" id="xpExtra" placeholder="C:\\X-Plane 12 (if not detected)"> <button type="button" id="xpRescan">Rescan</button></div>` +
    (x.installs.length ? x.installs.map((i, n) => `<div class="kv" data-xp="${esc(i.path)}"><b>Install</b><span>${light(i.valid, esc(i.path))} <span class="muted small">(${i.source})</span></span>` +
      `<b>Navigraph / AIRAC</b><span>${i.navigraph.present ? light(i.navigraph.outdated === false, `Custom Data: AIRAC ${esc(i.navigraph.cycle || "?")} ${i.navigraph.valid_from ? esc(i.navigraph.valid_from + " – " + i.navigraph.valid_to) : ""}${i.navigraph.outdated ? " — older than the current cycle, update with Navigraph Hub" : ""}`) : light(false, "no Custom Data folder — install the Navigraph (or use X-Plane's default) navdata; procedures in the trainer then come from Settings → Navigation data")}</span>` +
      `<b>XRadio plugin</b><span>${light(i.xradio.installed, i.xradio.installed ? `installed (${esc(i.xradio.version || "version unknown")}: ${esc(i.xradio.xpl.join(", ") || "no .xpl?")})` : "not installed")} <button type="button" data-xrcheck="${n}">Check the latest release</button> <span id="xrLatest${n}" class="small muted"></span></span>` +
      `<b></b><span class="row"><input type="text" id="xrSource${n}" placeholder="release zip URL or a local zip path" style="min-width:380px"> <label><input type="checkbox" id="xrBackup${n}" checked> keep a backup of the old plugin</label> <button type="button" data-xrinstall="${n}">Install / update XRadio</button></span>` +
      `<b>XRadio settings</b><span class="row">host <input type="text" id="xrHost${n}" placeholder="127.0.0.1" style="min-width:140px"> port <input type="text" id="xrPort${n}" placeholder="49100" style="min-width:70px"> password <input type="text" id="xrPass${n}" style="min-width:100px"> callsign <input type="text" id="xrCs${n}" placeholder="ESXYZ" style="min-width:90px"> <button type="button" data-xrset="${n}">Write xradio.cfg</button> <span class="muted small">${esc(i.settings)}</span></span></div>`).join("")
      : `<p>${light(false, "X-Plane 12 was not found (installer list and Steam libraries checked). Type the folder above and rescan, or skip this step.")}</p>`) + `<div id="xpOut"></div>`;
}
async function loadLog() {
  try { const j = await (await fetch("/api/setup/log")).json(); $("logOut").textContent = j.log.length ? j.log.join("\n") : "(empty)"; } catch { /* */ }
}
document.addEventListener("click", async (e) => {
  const t = e.target;
  if (t.dataset.pip) { t.disabled = true; $("pipOut").innerHTML = "installing… (this can take minutes)"; show($("pipOut"), await post("pip", { name: t.dataset.pip })); load(); }
  if (t.id === "esUnpack") {
    const f = $("esZip").files[0]; if (!f) { alert("Choose the zip first."); return; }
    $("esOut").innerHTML = "uploading…";
    const b64 = btoa(new Uint8Array(await f.arrayBuffer()).reduce((s, b) => s + String.fromCharCode(b), ""));
    const up = await post("upload", { name: f.name, data: b64 });
    if (!up.ok) { show($("esOut"), up); return; }
    show($("esOut"), await post("unpack", { zip: up.path, docs: $("esDocs").value.trim(), name: $("esZipName").value.trim(), overwrite: $("esOverwrite").checked }));
    if (!dry()) load();
  }
  if (t.id === "esGen") { show($("esOut"), await post("generate", { icao: $("esIcao").value, docs: $("esDocs").value.trim(), callsign: $("esCs").value.trim(), overwrite: $("esOverwrite2").checked })); if (!dry()) load(); }
  if (t.id === "esShortcut") {
    const prf = $("esPrf").value || `${$("esDocs").value.trim()}\\TowerTrainer\\TowerTrainer ${$("esIcao").value}.prf`;
    show($("esOut"), await post("shortcut", { target: st.euroscope.exe, label: "TowerTrainer EuroScope", args: `"${prf}"` }));
  }
  if (t.id === "xpRescan") load();
  if (t.dataset.xrcheck != null) { const n = t.dataset.xrcheck; const j = await post("xradio_latest", {}); $("xrLatest" + n).textContent = j.ok ? `latest: ${j.tag} (${j.zip_name || "no zip asset"})` : `could not check: ${j.error}`; if (j.ok && j.zip) $("xrSource" + n).value = j.zip; $("xrSource" + n).dataset.tag = j.tag || ""; }
  if (t.dataset.xrinstall != null) { const n = t.dataset.xrinstall, xp = t.closest("[data-xp]").dataset.xp; const src = $("xrSource" + n).value.trim(); if (!src) { alert("Check the latest release or give a zip path first."); return; } show($("xpOut"), await post("xradio_install", { xplane: xp, source: src, tag: $("xrSource" + n).dataset.tag || "", backup: $("xrBackup" + n).checked })); if (!dry()) load(); }
  if (t.dataset.xrset != null) {
    const n = t.dataset.xrset, xp = t.closest("[data-xp]").dataset.xp, values = {};
    for (const [k, id] of [["host", "xrHost"], ["port", "xrPort"], ["password", "xrPass"], ["callsign", "xrCs"]]) { const v = $(id + n).value.trim(); if (v) values[k] = v; }
    show($("xpOut"), await post("xradio_settings", { xplane: xp, values }));
  }
  if (t.id === "runTests") runTests();
});
async function runTests() {
  const out = $("testOut"); out.innerHTML = "testing…";
  const j = await post("tests", {});
  const rows = [];
  const v = j.voices || {};
  rows.push(light(!!v.neural, `Voices: ${v.neural ? "neural engine ready (" + esc(v.engine || "") + ")" : "no neural engine — the browser's voices are used"}`) + (v.neural ? "" : ` <span class="muted">fix: install edge-tts (internet) or piper-tts above</span>`));
  const s = j.stt || {};
  rows.push(light(!!(s.whisper || s.vosk || (s.engines && s.engines.length)), `Speech recognition on the server: ${s.engines && s.engines.length ? esc(s.engines.join(", ")) : "none"}`) + ` <span class="muted">needed only for Firefox, remote windows and pilot transcripts</span>`);
  const es = j.euroscope || {};
  rows.push(light(!!es.running, `EuroScope bridge (FSD): ${es.running ? "listening on port " + esc(es.port) + (es.controllers && es.controllers.length ? ", connected: " + es.controllers.map(c => c.cs).join(" ") : ", nobody connected yet") : "off"}`) + (es.running ? "" : ` <span class="muted">fix: start server.py without --fsd-port 0</span>`));
  const x = j.xradio || {};
  rows.push(light(x.connected ? true : x.enabled ? false : null, `XRadio: ${x.connected ? "connected, protocol v" + esc(x.proto) + ", " + (x.pilots || 0) + " pilots" : x.enabled ? "enabled but not connected (" + esc(x.error || x.state || "…") + ")" : "off (Settings → XRadio in the trainer)"}`));
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const ctx = new AudioContext(), src = ctx.createMediaStreamSource(stream), an = ctx.createAnalyser(); src.connect(an);
    await new Promise(r => setTimeout(r, 700));
    const buf = new Float32Array(an.fftSize); an.getFloatTimeDomainData(buf);
    const rms = Math.sqrt(buf.reduce((a, b) => a + b * b, 0) / buf.length);
    stream.getTracks().forEach(t => t.stop()); ctx.close();
    rows.push(light(true, `Microphone: ${stream.getAudioTracks()[0].label || "default"} (level ${rms.toFixed(3)}${rms < 0.001 ? " — silent? say something while testing" : ""})`));
  } catch (err) { rows.push(light(false, `Microphone: ${esc(err.message)}`) + ` <span class="muted">fix: allow the microphone for this site, or pick another device in the browser</span>`); }
  rows.push(light(!!(window.SpeechRecognition || window.webkitSpeechRecognition), `Browser speech recognition: ${window.SpeechRecognition || window.webkitSpeechRecognition ? "available (Chrome/Edge)" : "not in this browser — the server's recogniser is used"}`));
  out.innerHTML = rows.map(r => `<div>${r}</div>`).join("");
}
load();
