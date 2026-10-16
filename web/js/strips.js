// Electronic flight strips: bays per position, drag between bays, editable fields, highlight on call.
// Works on sim snapshots so the same code renders strips in pop-out windows.
import { shortState, statePhrase, issueMarkers } from "./labels.js";

export const BAYS = {
  incoming: "Incoming (accept)", pending: "Pending", clearance: "Clearance", push: "Push", taxi: "Taxi", holding: "Holding", runway: "Runway",
  airborne: "Airborne", approach: "Approach", final: "Final", landed: "Runway (arr)", taxiin: "Taxi in", enroute: "Enroute", live: "Live (XRadio)",
  vehicles: "Vehicles",
};
const POS_BAYS = {
  ALL: ["pending", "clearance", "push", "taxi", "holding", "runway", "airborne", "approach", "final", "landed", "taxiin", "vehicles", "live"],
  DEL: ["incoming", "pending", "clearance"],
  GND: ["incoming", "clearance", "push", "taxi", "holding", "taxiin", "vehicles", "live"],
  TWR: ["incoming", "holding", "runway", "airborne", "final", "landed", "taxiin", "vehicles", "live"],
  APP: ["incoming", "approach", "final", "airborne", "live"],
  CTR: ["incoming", "enroute", "airborne", "approach", "live"],
};

/** A strip handed to this position and not yet accepted sits in the Incoming bay, flashing. */
export function incomingFor(a, pos) { return !!(a.handoff && !a.handoff.accepted && a.handoff.to === pos); }

/** Natural bay for an aircraft's state. */
export function autoBay(a) {
  if (a.human) return "live";
  if (a.veh) return "vehicles";
  if (a.kind === "ovf") return "enroute";
  const s = a.state;
  if (a.kind === "dep") {
    if (s === "parked" || s === "clr_req") return a.ga ? "taxi" : "pending";
    if (s === "cleared") return "clearance";
    if (s === "push_req" || s === "pushing" || s === "pushed") return "push";
    if (s === "taxi_req" || s === "taxi") return "taxi";
    if (s === "holding") return "holding";
    if (["lineup", "lining", "lined_up", "roll"].includes(s)) return "runway";
    return "airborne";
  }
  if (s === "final" || s === "goaround") return a.freq === "APP" ? "approach" : "final";
  if (s === "rollout" || s === "vacating") return "landed";
  return "taxiin";
}
/** Bay shown: the controller's manual placement until the aircraft changes state. */
export function bayOf(a) {
  const m = a.strip;
  if (m && m.bay && m.state === a.state) return m.bay;
  return autoBay(a);
}

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/**
 * Render the board for a position.
 * opts: { el, ac:[snapshot], pos, selectedId, split, onSelect(id), onMove(id, bay), onEdit(id, field, value) }
 */
export function renderStrips(opts) {
  const { el, ac, pos, selectedId, split } = opts;
  const bays = POS_BAYS[split ? pos : "ALL"] || POS_BAYS.ALL;
  // keep focus while editing a field
  if (el.contains(document.activeElement) && document.activeElement.isContentEditable) return;
  const now = performance.now();
  const visible = ac.filter(a => !split || pos === "ALL" || a.freq === pos || (a.human && pos !== "DEL") ||
    (pos === "DEL" && a.kind === "dep" && ["parked", "clr_req"].includes(a.state)) || incomingFor(a, pos))
    .filter(a => !(a.veh && a.state === "idle"));
  // a strip just handed off stays, greyed, on the board that gave it away until the other side accepts it
  const outgoing = split && pos !== "ALL" ? ac.filter(a => a.handoff && !a.handoff.accepted && a.handoff.from === pos && !visible.includes(a)) : [];
  el.innerHTML = bays.map(b => {
    const list = b === "incoming" ? visible.filter(a => incomingFor(a, pos)) : visible.filter(a => !incomingFor(a, pos) && bayOf(a) === b);
    const out = b !== "incoming" ? outgoing.filter(a => bayOf(a) === b) : [];
    if (b === "incoming" && !list.length) return "";
    return `<div class="bay" data-bay="${b}"><h4>${BAYS[b]} ${list.length ? "(" + list.length + ")" : ""}</h4>${list.map(a => strip(a, selectedId, now, pos)).join("")}${out.map(a => strip(a, selectedId, now, pos, true)).join("")}</div>`;
  }).join("") + otherFreq(ac, visible, pos, split);
  if (!el._wired) wire(el, opts);
  el._opts = opts;
}

function strip(a, selectedId, now, pos, handedOff = false) {
  const d = a.stripData || {};
  const route = a.kind === "dep" ? `${a.other[0] === "VFR" ? "VFR " + esc(a.other[1]) : "→" + esc(a.other[0])}` : a.kind === "arr" ? `${esc(a.other[0])}→` : a.kind === "ovf" ? `${esc(a.other[0])}→${esc(a.other[1])}` : "";
  const sq = d.sq || a.assignedSq || "";
  const calling = a.callingUntil && a.callingUntil > Date.now();
  const incoming = incomingFor(a, pos);
  const cls = `strip ${a.human ? "human" : a.veh ? "veh" : a.kind}${a.id === selectedId ? " sel" : ""}${calling ? " calling" : ""}${a.nordo ? " nordo" : ""}${a.mayday ? " mayday" : ""}${incoming ? " incoming" : ""}${handedOff ? " handedoff" : ""}`;
  const ed = (f, v, ph) => `<span contenteditable="true" spellcheck="false" data-f="${f}" title="${ph}">${esc(v)}</span>`;
  const ho = incoming ? `<button class="accept" data-accept="${a.id}" title="Accept the handoff from ${esc(a.handoff.from)}">ACCEPT ${esc(a.handoff.from)}→</button>` :
    handedOff ? `<span class="w" title="handed off, waiting for ${esc(a.handoff.to)} to accept">→${esc(a.handoff.to)} ${a.handoff.age}s</span>` : "";
  return `<div class="${cls}" draggable="true" data-id="${a.id}">` +
    `<span class="cs">${esc(a.cs)}${ho}</span>` +
    (a.human && a.typeUnknown ? `<span class="warnline" title="XRadio could not tell the type: medium / default values">type?</span>` : `<span>${esc(a.type)}/${a.wtc}</span>`) +
    `<span>${route} ${a.kind === "dep" ? ed("sid", d.sid ?? a.sid ?? "", "SID") : ""} ${ed("cfl", d.cfl ?? (a.cfl ? (a.cfl >= 6000 ? "F" + a.cfl / 100 : a.cfl) : ""), "CFL")}` +
    `${a.warn && a.warn.length ? ` <span class="w">${esc(a.warn.join(" "))}</span>` : ""}${issueMarkers(a).map(i => ` <span class="w ${i.level}">${esc(i.t)}</span>`).join("")}` +
    `${a.ctot ? ` <span class="w ${a.ctot.ok ? "ok" : "warn"}" title="CTOT (slot)">CTOT ${esc(a.ctot.text)}</span>` : ""}${a.hot != null ? ` <span class="w ${a.hot > 0 ? "ok" : "warn"}" title="de-icing holdover time left">HOT ${Math.max(0, Math.round(a.hot / 60))}m</span>` : ""}` +
    `${a.cond ? ` <span class="w ok" title="conditional clearance">${esc(a.cond)}</span>` : ""}${a.priority ? ` <span class="w warn">${esc(String(a.priority).toUpperCase())}</span>` : ""}${a.broken ? ' <span class="w warn">BROKEN</span>' : ""}${a.towing ? ' <span class="w ok">TOW</span>' : ""}${a.rwyChanged ? ' <span class="w warn">RWY CHG</span>' : ""}` +
    `${a.human && a.fpStatus ? ` <span class="w ${a.fpStatus === "filed" ? "warn" : "ok"}" title="flight plan from the pilot (XRadio)">FPL ${esc(a.fpStatus)}</span>` : ""}${a.liveTx ? ' <span class="w ok">TX</span>' : ""}${a.simbrief ? ` <span class="w ok" title="${esc((a.reg ? a.reg + ' · ' : '') + 'OFP route: ' + (a.route || '') + (a.rfl ? ' · RFL ' + (a.rfl >= 6000 ? 'FL' + Math.round(a.rfl / 100) : a.rfl + ' ft') : '') + (a.eobt ? ' · EOBT ' + a.eobt + 'z' : ''))}">OFP${a.eobt ? ' ' + esc(a.eobt) : ''}</span>` : ""}</span>` +
    `<span>${ed("sq", sq, "squawk")} ${ed("stand", d.stand ?? a.stand ?? "", "stand")}</span>` +
    `<span class="st x5" title="${esc(statePhrase(a))}">${esc(shortState(a))}${a.kind === "dep" && a.rwy ? " " + ed("hp", d.hp ?? a.rwy, "holding point / runway") : ""}</span></div>`;
}

function otherFreq(all, visible, pos, split) {
  if (!split || pos === "ALL") return "";
  const others = all.filter(a => !visible.includes(a) && !a.human).length;
  return others ? `<div class="other">${others} aircraft on other frequencies</div>` : "";
}

function wire(el, opts0) {
  el._wired = true;
  el.addEventListener("click", (e) => {
    const acc = e.target.closest("[data-accept]");
    if (acc) { e.stopPropagation(); if (el._opts.onAccept) el._opts.onAccept(+acc.dataset.accept); return; }
    const mv = e.target.closest("[data-moveto]");
    if (mv) { e.stopPropagation(); el._opts.onMove(+mv.dataset.id, mv.dataset.moveto); el.querySelectorAll(".baymenu").forEach(x => x.remove()); return; }
    const s = e.target.closest(".strip");
    if (!s || e.target.isContentEditable) return;
    el._opts.onSelect(+s.dataset.id);
    // touch boards cannot drag: a tap opens a bay menu under the strip
    if (el._opts.touch) {
      el.querySelectorAll(".baymenu").forEach(x => x.remove());
      const bays = (POS_BAYS[el._opts.split ? el._opts.pos : "ALL"] || POS_BAYS.ALL).filter(b => b !== "incoming");
      const menu = document.createElement("div"); menu.className = "baymenu";
      menu.innerHTML = bays.map(b => `<button type="button" data-moveto="${b}" data-id="${s.dataset.id}">${BAYS[b]}</button>`).join("");
      s.after(menu);
    }
  });
  el.addEventListener("dragstart", (e) => {
    const s = e.target.closest(".strip"); if (!s) return;
    e.dataTransfer.setData("text/plain", s.dataset.id); e.dataTransfer.effectAllowed = "move";
  });
  el.addEventListener("dragover", (e) => { const b = e.target.closest(".bay"); if (b) { e.preventDefault(); b.classList.add("drop"); } });
  el.addEventListener("dragleave", (e) => { const b = e.target.closest(".bay"); if (b) b.classList.remove("drop"); });
  el.addEventListener("drop", (e) => {
    const b = e.target.closest(".bay"); if (!b) return;
    e.preventDefault(); b.classList.remove("drop");
    el._opts.onMove(+e.dataTransfer.getData("text/plain"), b.dataset.bay);
  });
  el.addEventListener("focusout", (e) => {
    const f = e.target.dataset && e.target.dataset.f; if (!f) return;
    const s = e.target.closest(".strip");
    el._opts.onEdit(+s.dataset.id, f, e.target.textContent.trim());
  });
  el.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.isContentEditable) { e.preventDefault(); e.target.blur(); } });
}

/** One strip as HTML (tests). */
export const stripHtml = (a, pos = "ALL") => strip(a, null, 0, pos);
