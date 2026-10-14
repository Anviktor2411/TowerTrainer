// What happens next: the pilot's next expected call and the controller's next logical instruction for an
// aircraft, as ready-to-send phraseology. Used by the info panel, command autocomplete and the coach.
import { fmtFreq } from "./positions.js";

const NM = 1852;

function csText(a) { return a.ga ? (a.abbrev ? a.cs : a.tel) : `${a.tel} ${a.num}`; }

/** { pilot: "will call: …" | null, atc: "FIN321 …" | null, why: short reason } */
export function nextExpected(sim, a, pos) {
  if (!sim || !a) return { pilot: null, atc: null, why: "" };
  const cs = csText(a);
  const split = sim.split;
  const rwy = (a.depEnd || sim.depEnd).name;
  const contact = (k) => split && sim.positions[k] && !sim.userWorks(k) !== undefined ? sim.contactPhrase(k) : null;
  const handoff = (k) => (split && sim.positions[k] && sim.userWorks(k) === false) || (split && sim.positions[k]) ? `${cs} ${sim.contactPhrase(k)}` : null;
  if (a.veh) {
    if (a.atStop && a.blockedRwy != null) return { pilot: null, atc: `${cs} cross runway ${sim.apt.runways[a.blockedRwy].ends[0].name}`, why: "vehicle holding short" };
    return { pilot: a.state === "toAircraft" ? "will call holding short if a runway is on the way" : null, atc: null, why: "" };
  }
  if (a.nordo) {
    if (!a.onGround && a.kind === "arr") return { pilot: null, atc: `${cs} light green steady`, why: "RCF on final: steady green = cleared to land" };
    if (a.onGround && (a.state === "vacated" || a.state === "holding_short" || (a.state === "taxi" && a.atStop))) return { pilot: null, atc: `${cs} light green flashing`, why: "RCF on the ground: flashing green = cleared to taxi" };
    return { pilot: null, atc: null, why: "RCF: use light signals or send the follow-me" };
  }
  if (a.kind === "dep") {
    switch (a.state) {
      case "parked": return { pilot: a.ga ? "request taxi (VFR)" : `request IFR clearance to ${a.other[1]}`, atc: null, why: "" };
      case "clr_req": {
        const sg = sim.suggestDeparture(a);
        const code = a.assignedSq || sim.squawks.peek(sim.t);
        const gnd = split && sim.positions.GND ? `, ${sim.contactPhrase("GND")}` : "";
        return { pilot: null, atc: `${cs} cleared to ${a.other[1]} via ${sg.sid ? sg.sid + " departure" : "flight planned route"}, climb ${sg.climb} feet, squawk ${code}${gnd}`, why: "clearance requested" };
      }
      case "cleared": return { pilot: "ready for push and start", atc: split && a.freq === "DEL" && sim.positions.GND ? `${cs} ${sim.contactPhrase("GND")}` : null, why: "" };
      case "push_req": return { pilot: null, atc: `${cs} push and start approved`, why: "push requested" };
      case "pushing": case "pushed": return { pilot: "ready to taxi", atc: null, why: "" };
      case "taxi_req": { const via = sim.viaNames(a); return { pilot: null, atc: `${cs} taxi to holding point runway ${rwy}${via.length ? " via " + via.join(" ") : ""}`, why: "taxi requested" }; }
      case "taxi": {
        if (a.atStop && a.blockedRwy != null && a.blockedRwy !== a.depEnd.rwy) return { pilot: null, atc: `${cs} cross runway ${sim.apt.runways[a.blockedRwy].ends[0].name}`, why: "holding short of a crossing runway" };
        if (split && sim.positions.TWR && a.freq === "GND" && a.distToStop != null && a.distToStop < 400) return { pilot: null, atc: `${cs} ${sim.contactPhrase("TWR")}`, why: "approaching the holding point" };
        return { pilot: `holding short runway ${rwy}, ready for departure`, atc: null, why: "" };
      }
      case "holding": return { pilot: null, atc: sim.runwayFree(a.depEnd.rwy, a) ? `${cs} runway ${rwy} cleared for takeoff` : `${cs} runway ${rwy} line up and wait`, why: sim.runwayFree(a.depEnd.rwy, a) ? "ready, runway free" : "ready, runway occupied" };
      case "lineup": case "lining": case "lined_up": return { pilot: null, atc: `${cs} runway ${rwy} cleared for takeoff`, why: "on the runway" };
      case "roll": return { pilot: "airborne / request frequency change", atc: null, why: "" };
      case "airborne": {
        const nx = split ? (sim.positions.APP ? "APP" : sim.positions.CTR ? "CTR" : null) : null;
        return { pilot: null, atc: nx ? `${cs} ${sim.contactPhrase(nx)}` : `${cs} contact ${sim.unitName("APP")} ${sim.positions && sim.positions.APP ? sim.positions.APP.freq : fmtFreq((sim.apt.freq.approach || { mhz: 119.4 }).mhz)}`, why: "airborne: hand off" };
      }
    }
  } else if (a.kind === "arr") {
    switch (a.state) {
      case "final": {
        const d = sim.distToThr(a) / NM;
        if (a.freq === "APP" && split) return { pilot: null, atc: a.appCleared ? `${cs} ${sim.contactPhrase("TWR")}` : `${cs} identified, descend 3000 feet, cleared ILS approach runway ${a.end.name}`, why: "on approach frequency" };
        if (!a.landClr) return { pilot: a.calledIn ? null : `established ILS runway ${a.end.name}`, atc: `${cs} runway ${a.end.name} cleared to land`, why: `${d.toFixed(1)} NM final${sim.runwayFree(a.end.rwy, a) ? "" : " · RUNWAY OCCUPIED"}` };
        return { pilot: "runway vacated", atc: null, why: "cleared to land" };
      }
      case "goaround": return { pilot: "going around", atc: `${cs} climb 3000 feet, ${split && sim.positions.APP ? sim.contactPhrase("APP") : "report downwind"}`, why: "go-around" };
      case "rollout": case "vacating": return { pilot: "runway vacated", atc: null, why: "" };
      case "vacated": case "holding_short": {
        if (a.atStop && a.blockedRwy != null) return { pilot: null, atc: `${cs} cross runway ${sim.apt.runways[a.blockedRwy].ends[0].name}`, why: "holding short" };
        if (split && a.freq === "TWR" && sim.positions.GND) return { pilot: null, atc: `${cs} ${sim.contactPhrase("GND")}`, why: "vacated: hand off to Ground" };
        const st = a.stand || sim.freeStands()[0];
        const via = st ? sim.viaNamesTo(a, st.pos) : [];
        return { pilot: null, atc: st ? `${cs} taxi to stand ${st.name}${via.length ? " via " + via.join(" ") : ""}` : null, why: "requests taxi" };
      }
      case "taxi": return a.atStop && a.blockedRwy != null ? { pilot: null, atc: `${cs} cross runway ${sim.apt.runways[a.blockedRwy].ends[0].name}`, why: "holding short" } : { pilot: null, atc: null, why: "taxiing in" };
    }
  } else if (a.kind === "ovf") {
    return { pilot: a.calledIn ? null : "check in with the level", atc: a.ctrIdent ? null : `${cs} identified`, why: "" };
  }
  return { pilot: null, atc: null, why: "" };
}

/** Callsign forms for autocomplete: display text as typed in the command line. */
export function callsignText(a) { return csText(a); }
