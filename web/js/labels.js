// Plain-language state phrases for labels, strips, tooltips and the info panel. Works on sim snapshots
// (pop-outs, multiplayer) and on live aircraft alike.

const NM = 1852;

const stand = (a) => (a.stand && a.stand.name) || (typeof a.stand === "string" ? a.stand : "") || a.standName || "";
const rwy = (a) => a.rwy || (a.depEnd && a.depEnd.name) || (a.end && a.end.name) || "";
const dest = (a) => (a.other && a.other[0] !== "VFR" ? a.other[0] : "") || "";
const via = (a) => (a.viaText || a.via) ? ` via ${a.viaText || a.via}` : "";

/** One line, like a real tower's electronic strip would show it. */
export function statePhrase(a) {
  let p;
  if (a.human) p = a.onGround ? "Live pilot · on the ground" : "Live pilot";
  else if (a.veh) p = vehiclePhrase(a);
  else if (a.kind === "ovf") p = `Enroute FL${String(Math.round((a.alt || 0) / 100)).padStart(3, "0")}${a.other && a.other[1] ? " → " + a.other[1] : ""}`;
  else if (a.kind === "dep") p = depPhrase(a);
  else p = arrPhrase(a);
  if (a.mayday) p = "MAYDAY · " + p;
  else if (a.nordo) p = "RCF · " + p;
  else if (a.squawk === "7500") p = "HIJACK · " + p;
  return p;
}

function depPhrase(a) {
  const s = a.state, r = rwy(a), d = dest(a), st = stand(a);
  switch (s) {
    case "parked": return a.returned ? `Returned to stand ${st}` : a.ifr && a.cfl ? `Cleared IFR → ${d}` : `On stand ${st}`;
    case "clr_req": return `Requests clearance → ${d}`;
    case "cleared": return `Cleared IFR → ${d}${st ? " · stand " + st : ""}`;
    case "push_req": return `Ready for push${st ? " stand " + st : ""}`;
    case "pushing": return "Pushing back";
    case "pushed": return "Push complete";
    case "taxi_req": return a.ga ? `Requests taxi VFR` : "Requests taxi";
    case "taxi": return a.taxiTo === "stand" ? `Taxi → stand ${st}${via(a)}` : a.holdPos ? `Holding position${a.holdRwy ? " short of " + a.holdRwy : ""}` : a.atStop && a.holdRwy ? `Holding short RWY ${a.holdRwy}` : `Taxi → HP ${r}${via(a)}`;
    case "holding": return `Ready for departure RWY ${r}`;
    case "lineup": case "lining": return `Lining up RWY ${r}`;
    case "lined_up": return `Lined up RWY ${r}`;
    case "roll": return `Takeoff roll RWY ${r}`;
    case "airborne": return `Airborne RWY ${r}${d ? " → " + d : ""}`;
    case "circuit": return `In the circuit RWY ${r}`;
    case "rto": return `Rejected takeoff RWY ${r}`;
    default: return s;
  }
}

function arrPhrase(a) {
  const s = a.state, r = rwy(a), st = stand(a);
  switch (s) {
    case "final": {
      const nm = a.dthr != null ? ` ${(a.dthr / NM).toFixed(1)} NM` : "";
      return `Final ${r}${nm}${a.landClr ? " · cleared to land" : ""}`;
    }
    case "goaround": return "Going around";
    case "circuit": return `Circuit RWY ${r}${a.circuitLeg ? " · " + a.circuitLeg : ""}`;
    case "rollout": return `Landed RWY ${r}`;
    case "vacating": return `Vacating${a.exitName || a.exit ? " via " + (a.exitName || a.exit) : ""}`;
    case "vacated": return `Vacated${a.exitName || a.exit ? " (" + (a.exitName || a.exit) + ")" : ""} · request taxi`;
    case "holding_short": return `Holding short RWY ${a.holdRwy || ""}`.trim();
    case "taxi": return a.holdPos ? "Holding position" : a.atStop && a.holdRwy ? `Holding short RWY ${a.holdRwy}` : `Taxi → stand ${st}${via(a)}`;
    case "parked": return `On stand ${st}`;
    default: return s;
  }
}

function vehiclePhrase(a) {
  const t = a.targetCs || (a.target && a.target.cs) || "";
  switch (a.state) {
    case "toAircraft": return `Follow-me → ${t}`;
    case "leading": return `Leading ${t} → stand ${a.standTo || stand(a.target || {}) || ""}`.trim();
    case "aside": return "Clear of the stand";
    case "home": return "Returning to base";
    case "task": return a.task || "Working";
    case "idle": return "Standing by";
    default: return a.state;
  }
}

/** Short bay label for strips. */
export function shortState(a) {
  if (a.human) return "LIVE";
  if (a.veh) return a.state === "leading" ? "LEADING" : a.state === "toAircraft" ? "EN ROUTE" : "VEHICLE";
  const M = {
    parked: "On stand", clr_req: "Clr req", cleared: "Cleared", push_req: "Push req", pushing: "Pushing", pushed: "Pushed",
    taxi_req: "Taxi req", taxi: "Taxiing", holding: "Ready", lineup: "Line up", lining: "Line up", lined_up: "Lined up",
    roll: "T/O roll", airborne: "Airborne", final: "Final", goaround: "Go-around", rollout: "Landed", vacating: "Vacating",
    vacated: "Vacated", holding_short: "Hold short", cruise: "Enroute", circuit: "Circuit", rto: "RTO",
  };
  return M[a.state] || a.state;
}

/**
 * Open issues a controller should notice: missed/pending readback error, a call waiting too long, old ATIS.
 * Returns [{t, level}] with level "warn" (amber) or "alert" (red).
 */
export function issueMarkers(a, now) {
  const out = [];
  const rb = a.rb || (a.rbError && !a.rbError.fixed ? { label: a.rbError.label, missed: a.rbError.missed } : null);
  if (rb) out.push({ t: rb.missed ? `RB ${rb.label.toUpperCase()} MISSED` : `RB ${rb.label.toUpperCase()}?`, level: rb.missed ? "alert" : "warn" });
  const waiting = a.waiting != null ? a.waiting : (a.reqAt != null && now != null ? now - a.reqAt : null);
  if (waiting != null && waiting > 45 && !a.nordo) out.push({ t: `WAIT ${Math.round(waiting)}s`, level: waiting > 120 ? "alert" : "warn" });
  if (a.atisReported) out.push({ t: "OLD ATIS", level: "warn" });
  if (a.nordo && a.lastWant) out.push({ t: "NO RADIO", level: "warn" });
  if (a.human && a.typeUnknown) out.push({ t: "type?", level: "warn" });            // C3: XRadio could not tell
  if (a.tcasRa) out.push({ t: "RA", level: "alert" });                                // D4: red RA on the label
  else if (a.tcasTa) out.push({ t: "TA", level: "warn" });
  return out;
}

/** Squawk line of the data block: code + mode, and whether it differs from the assigned code. */
export function squawkText(a) {
  const mode = a.xpdr === "C" ? "C" : a.xpdr === "A" ? "A" : a.xpdr === "S" ? "SBY" : a.xpdr === "O" ? "" : a.xpdr || "";
  const mismatch = !!(a.assignedSq && a.squawk !== a.assignedSq && !["7500", "7600", "7700"].includes(a.squawk));
  return { t: a.squawk ? `${a.squawk}${mode ? " " + mode : ""}` : "", mismatch, ident: !!a.ident };
}
