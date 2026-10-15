// Command-line autocomplete: callsigns on the frequency while the first word is typed, then the next logical
// instruction for that aircraft (from advisor.js) and the usual options for its state. Tab accepts.
import { parse } from "./commands.js";
import { nextExpected, callsignText } from "./advisor.js";
import { statePhrase } from "./labels.js";

/** Candidate instructions for an aircraft in its state, before the advisor's own first choice. */
export function optionsFor(sim, a, pos, app) {
  const rwyDep = (a.depEnd || sim.depEnd).name, rwyArr = (a.end || sim.arrEnd).name;
  const out = [];
  const add = (...xs) => xs.forEach(x => x && !out.includes(x) && out.push(x));
  if (a.veh) { add(`cross runway ${rwyDep}`, "hold position", "continue"); return out; }
  if (a.human) { add("cleared to", `runway ${rwyDep} cleared for takeoff`, `runway ${rwyArr} cleared to land`, "contact"); return out; }
  const s = a.state;
  if (a.kind === "dep") {
    if (["parked", "clr_req"].includes(s)) add(app && app.clearanceText ? app.clearanceText(a).replace(/^\S+ \S* ?/, "") : "cleared to");
    if (["cleared", "push_req"].includes(s)) add("push and start approved", "push and start approved, facing east", "hold position");
    if (["pushed", "taxi_req", "deicing"].includes(s)) add(app && app.taxiText ? app.taxiText(a).replace(/^\S+ \S* ?/, "") : `taxi to holding point runway ${rwyDep}`, "de-icing approved on stand");
    if (s === "taxi") add(`hold short of runway ${rwyDep}`, "hold position", "continue taxi", `cross runway ${rwyDep}`, "give way to the");
    if (["holding", "cond_lineup"].includes(s)) add(`runway ${rwyDep} line up and wait`, `runway ${rwyDep} cleared for takeoff`, `behind the landing traffic, line up and wait runway ${rwyDep} behind`, "hold position");
    if (["lineup", "lining", "lined_up"].includes(s)) add(`runway ${rwyDep} cleared for takeoff`, `runway ${rwyDep} cleared for immediate takeoff`, "cancel takeoff clearance", "vacate the runway");
    if (s === "roll") add("cancel takeoff clearance");
    if (s === "airborne") add(sim.split && sim.positions && sim.positions.APP ? `contact ${sim.positions.APP.cs.replace(/_/g, " ")} ${sim.positions.APP.freq}` : "contact approach", "report passing 2000 feet");
  } else if (a.kind === "arr") {
    if (["final", "goaround", "circuit", "inbound"].includes(s)) add(`runway ${rwyArr} cleared to land`, "continue approach", "go around", `cleared touch and go runway ${rwyArr}`, `join left downwind runway ${rwyArr}`, "orbit left", `land after the landing traffic, runway ${rwyArr}`);
    if (["rollout", "vacating"].includes(s)) add("vacate", "expedite vacating");
    if (["vacated", "holding_short", "taxi"].includes(s)) add(app && app.taxiInText ? app.taxiInText(a).replace(/^\S+ \S* ?/, "") : "taxi to stand", "hold position", "continue taxi", `cross runway ${rwyDep}`);
  }
  if (a.nordo) add("light green flashing", "light green steady", "light red steady", "send follow-me");
  add("squawk ident", "say again", "contact");
  return out;
}

/**
 * Suggestions for what is typed. Returns [{label, insert, hint}] (insert replaces the whole command line).
 */
export function suggestions({ text, sim, pos, selected, app, max = 7 }) {
  if (!sim) return [];
  const raw = String(text || "");
  const typed = raw.trimStart();
  const hears = (a) => sim.hears(a, pos) || a.human;
  const first = typed.indexOf(" ") < 0;
  if (first) {
    const q = typed.toUpperCase();
    const list = sim.ac.filter(a => hears(a) && !(a.veh && a.state === "idle") && (!q || a.cs.toUpperCase().startsWith(q) || `${a.tel} ${a.num}`.toUpperCase().startsWith(q)));
    list.sort((p, qq) => (qq.callingUntil || 0) - (p.callingUntil || 0) || (p.reqAt != null ? -1 : 0) - (qq.reqAt != null ? -1 : 0));
    const out = list.slice(0, max).map(a => ({ label: `${a.cs}  ${a.veh ? "" : a.type + " · "}${statePhrase(a)}`, insert: `${callsignText(a)} `, hint: callsignText(a) }));
    if (!q && selected && !list.includes(selected)) out.unshift({ label: `${selected.cs} (selected)`, insert: `${callsignText(selected)} `, hint: "" });
    return out;
  }
  const pp = parse(typed, sim.ac, selected || null);
  const a = pp.ac;
  if (!a) return [];
  // the command line is normalised before the callsign is matched, so the typed head is replaced by the
  // canonical callsign and the rest (already normalised, lower case) is what the options are matched against
  const head = callsignText(a);
  const tail = String(pp.ins && pp.rest !== undefined ? pp.rest : typed.slice(typed.indexOf(" ") + 1)).trim().toLowerCase();
  const nx = nextExpected(sim, a, pos);
  const cands = [];
  if (nx.atc) cands.push({ label: `${nx.atc}  — next expected`, text: nx.atc });
  for (const o of optionsFor(sim, a, pos, app)) cands.push({ label: o, text: o });
  const seen = new Set();
  return cands.filter(c => !seen.has(c.text) && seen.add(c.text)).filter(c => !tail || c.text.toLowerCase().includes(tail) || c.text.toLowerCase().startsWith(tail))
    .slice(0, max).map(c => ({ label: c.label, insert: `${head} ${c.text}`, hint: c.text }));
}
