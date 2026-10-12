// Electronic flight strips: bays per position, drag between bays, editable fields, highlight on call.
// Works on sim snapshots so the same code renders strips in pop-out windows.
import { STATE_SHORT } from "./render.js";

export const BAYS = {
  pending: "Pending", clearance: "Clearance", push: "Push", taxi: "Taxi", holding: "Holding", runway: "Runway",
  airborne: "Airborne", approach: "Approach", final: "Final", landed: "Runway (arr)", taxiin: "Taxi in", enroute: "Enroute", live: "Live (XRadio)",
};
const POS_BAYS = {
  ALL: ["pending", "clearance", "push", "taxi", "holding", "runway", "airborne", "approach", "final", "landed", "taxiin", "live"],
  DEL: ["pending", "clearance"],
  GND: ["clearance", "push", "taxi", "holding", "taxiin", "live"],
  TWR: ["holding", "runway", "airborne", "final", "landed", "taxiin", "live"],
  APP: ["approach", "final", "airborne", "live"],
  CTR: ["enroute", "airborne", "approach", "live"],
};

/** Natural bay for an aircraft's state. */
export function autoBay(a) {
  if (a.human) return "live";
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
    (pos === "DEL" && a.kind === "dep" && ["parked", "clr_req"].includes(a.state)));
  el.innerHTML = bays.map(b => {
    const list = visible.filter(a => bayOf(a) === b || (!bays.includes(bayOf(a)) && b === bays[bays.length - 1] && false));
    return `<div class="bay" data-bay="${b}"><h4>${BAYS[b]} ${list.length ? "(" + list.length + ")" : ""}</h4>${list.map(a => strip(a, selectedId, now)).join("")}</div>`;
  }).join("") + otherFreq(ac, visible, pos, split);
  if (!el._wired) wire(el, opts);
  el._opts = opts;
}

function strip(a, selectedId, now) {
  const d = a.stripData || {};
  const route = a.kind === "dep" ? `${a.other[0] === "VFR" ? "VFR " + esc(a.other[1]) : "→" + esc(a.other[0])}` : a.kind === "arr" ? `${esc(a.other[0])}→` : a.kind === "ovf" ? `${esc(a.other[0])}→${esc(a.other[1])}` : "";
  const sq = d.sq || a.assignedSq || "";
  const calling = a.callingUntil && a.callingUntil > Date.now();
  const cls = `strip ${a.human ? "human" : a.kind}${a.id === selectedId ? " sel" : ""}${calling ? " calling" : ""}`;
  const ed = (f, v, ph) => `<span contenteditable="true" spellcheck="false" data-f="${f}" title="${ph}">${esc(v)}</span>`;
  return `<div class="${cls}" draggable="true" data-id="${a.id}">` +
    `<span class="cs">${esc(a.cs)}</span>` +
    `<span>${esc(a.type)}/${a.wtc}</span>` +
    `<span>${route} ${a.kind === "dep" ? ed("sid", d.sid ?? a.sid ?? "", "SID") : ""} ${ed("cfl", d.cfl ?? (a.cfl ? (a.cfl >= 6000 ? "F" + a.cfl / 100 : a.cfl) : ""), "CFL")}` +
    `${a.warn && a.warn.length ? ` <span class="w">${esc(a.warn.join(" "))}</span>` : ""}</span>` +
    `<span>${ed("sq", sq, "squawk")} ${ed("stand", d.stand ?? a.stand ?? "", "stand")}</span>` +
    `<span class="st x5">${STATE_SHORT[a.state] || a.state}${a.kind === "dep" && a.rwy ? " " + ed("hp", d.hp ?? a.rwy, "holding point / runway") : ""}</span></div>`;
}

function otherFreq(all, visible, pos, split) {
  if (!split || pos === "ALL") return "";
  const others = all.filter(a => !visible.includes(a) && !a.human).length;
  return others ? `<div class="other">${others} aircraft on other frequencies</div>` : "";
}

function wire(el, opts0) {
  el._wired = true;
  el.addEventListener("click", (e) => {
    const s = e.target.closest(".strip");
    if (s && !e.target.isContentEditable) el._opts.onSelect(+s.dataset.id);
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
