// Parse controller phraseology (typed or speech-recognised) into instructions.
import { PHONETIC, DIGIT_WORDS } from "./data.js";
import { abbreviatedCallsign } from "./phrase.js";

const RWY = "(\\d{1,2}[lrc]?)";
let KNOWN_TAXIWAYS = null;
/** Taxiway / taxilane names of the loaded airport, so "via" accepts apron lane names like "L3A" too. */
export function setTaxiNames(set) { KNOWN_TAXIWAYS = set ? new Set([...set].map(x => String(x).toUpperCase())) : null; }

// ---- VFR reporting points of the airport (B2): real names when there are real points, lower case as normalised
let VFR_NAMES = [], VFR_MAP = new Map();
export function setVfrNames(names, generic = false) {
  VFR_MAP = new Map(generic ? [] : (names || []).map(n => [normalize(String(n)), String(n)]).filter(([k]) => k));
  VFR_NAMES = [...VFR_MAP.keys()];
}
export function vfrNames() { return [...VFR_MAP.values()]; }

// ---- nav data (F3/F4): fixes, navaids and procedures near the airport, by ident and by their spoken name
let NAV = null;
const spokenKey = (s) => normalize(String(s)).replace(/\b(vor|ndb|dme|vortac)\b/g, "").replace(/[^a-z0-9]/g, "");
/** list: [{ident, kind, spoken}] from /api/nav/vocab, or null when there is no nav data. */
export function setNavVocab(list) {
  if (!list || !list.length) { NAV = null; return; }
  const ids = new Map(), spoken = new Map(), procs = new Map();
  for (const x of list) {
    const id = String(x.ident).toUpperCase();
    if (["SID", "STAR", "APPCH"].includes(x.kind)) { procs.set(id, x); procs.set(spokenKey(x.spoken), x); continue; }
    if (!ids.has(id)) ids.set(id, x);
    const k = spokenKey(x.spoken);
    if (k && !spoken.has(k)) spoken.set(k, id);
  }
  NAV = { ids, spoken, procs };
}
export function navVocab() { return NAV; }
/** "lakut" / "tallinn vor" / "t l l" -> {ident, known}. Unknown names keep their letters as the ident. */
export function resolveFix(words) {
  const w = String(words || "").trim();
  const id = w.replace(/\s+/g, "").toUpperCase();
  if (!NAV) return { ident: id, known: null };
  if (NAV.ids.has(id)) return { ident: id, known: true, kind: NAV.ids.get(id).kind };
  const k = spokenKey(w);
  if (NAV.spoken.has(k)) { const ident = NAV.spoken.get(k); return { ident, known: true, kind: NAV.ids.get(ident).kind }; }
  return { ident: id, known: false };
}
export function resolveProc(name) {
  const id = String(name || "").replace(/\s+/g, "").toUpperCase();
  if (!NAV) return { name: id, known: null };
  const p = NAV.procs.get(id) || NAV.procs.get(spokenKey(name));
  return p ? { name: String(p.ident).toUpperCase(), known: true, kind: p.kind } : { name: id, known: false };
}
/** Warnings for nav instructions given to aircraft `a`: unknown fixes, fixes not on its route, unknown procedures. */
export function navWarnings(ins, a) {
  const out = [];
  const route = a && (a.routeFixes || (a.route ? String(a.route).toUpperCase().split(/\s+/) : null));
  for (const i of ins) {
    if ((i.t === "direct" || i.t === "holdAt") && i.known === false) out.push(`${i.fix} is not a known fix or navaid near ${i.t === "holdAt" ? "the airport" : "here"}`);
    else if (i.t === "direct" && i.known && route && route.length && !route.includes(i.fix)) out.push(`${i.fix} is not on ${a.cs}'s route (${route.slice(0, 8).join(" ")}${route.length > 8 ? " …" : ""})`);
    if ((i.t === "star" || i.t === "procedure") && i.known === false) out.push(`${i.name} is not a published procedure at this airport`);
  }
  return out;
}
const STOP_WORDS = new Set(["hold", "holding", "cross", "contact", "monitor", "runway", "and", "then", "behind",
  "give", "way", "line", "cleared", "expect", "short", "of", "to", "stand", "gate", "squawk", "climb", "via", "for", "report", "follow"]);
const TRAFFIC_WORDS = "(?:the |that )?(landing|departing|arriving|crossing|taxiing|next|preceding)?\\s*([a-z0-9 ]{2,30}?)";

/** Normalise spoken/typed text: number words -> digits, phonetic letters -> letters, merge groups. */
export function normalize(text) {
  let t = text.toLowerCase().replace(/[,;.!?]+(?!\d)/g, " , ").replace(/-/g, " ").replace(/\s+/g, " ").trim();
  const raw = t.split(" ");
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    let w = raw[i];
    if (w === "x" && raw[i + 1] === "ray") { w = "xray"; i++; }
    if (DIGIT_WORDS[w] !== undefined) w = DIGIT_WORDS[w];
    else if (PHONETIC[w] !== undefined) w = "#" + PHONETIC[w];
    const prev = out[out.length - 1];
    if (/^\d+$/.test(w) && prev && /^\d+$/.test(prev) && prev.length < 6) {
      out[out.length - 1] = prev + w; continue;
    }
    if (/^\d+$/.test(w) && prev && /^#[A-Z]\d*$/.test(prev)) { out[out.length - 1] = prev + w; continue; }
    if (/^(left|right|center|centre)$/.test(w) && prev && /^\d{1,2}$/.test(prev) && out[out.length - 2] === "runway") {
      out[out.length - 1] = prev + w[0]; continue;
    }
    // "~" marks a finished altitude so following digits are not glued onto it
    if (w === "thousand" && prev && /^\d+$/.test(prev)) { out[out.length - 1] = "~" + (+prev * 1000); continue; }
    if (w === "hundred" && prev && /^\d+$/.test(prev)) {
      const pp = out[out.length - 2];
      if (pp && /^~\d+000$/.test(pp)) { out.splice(-2, 2, "~" + (+pp.slice(1) + +prev * 100)); } else out[out.length - 1] = "~" + (+prev * 100);
      continue;
    }
    if ((w === "decimal" || w === "point") && prev && /^\d{3}$/.test(prev)) { out[out.length - 1] = prev + "."; continue; }
    if (/^\d+$/.test(w) && prev && /^\d{3}\.\d{0,2}$/.test(prev)) { out[out.length - 1] = prev + w; continue; }
    out.push(w);
  }
  return out.join(" ").replace(/[#~]/g, "").toLowerCase().replace(/ , /g, ", ").replace(/\s+,\s*$/, "")
    // speech-recognition homophones: "cleared four takeoff", "cleared two land", "ready four departure"
    .replace(/\bcleared 4 (take ?off)/g, "cleared for $1").replace(/\bcleared 2 (land|cross)/g, "cleared to $1")
    .replace(/\b(ready|request) 4 (departure|push|taxi)/g, "$1 for $2").replace(/\btaxi 2 (holding|stand|gate)/g, "taxi to $1");
}

/** Find which aircraft is addressed. Returns {ac, rest, abbrev}. */
export function matchCallsign(s, aircraft) {
  let best = null, bl = 0, abbrev = false;
  for (const a of aircraft) {
    const forms = [a.cs, `${a.cs.slice(0, 3)} ${a.num}`, `${a.tel} ${a.num}`, `${a.tel.replace(/ /g, "")} ${a.num}`]
      .map(f => normalize(f).toLowerCase());
    const ab = a.ga ? abbreviatedCallsign(a) : null;
    if (ab) forms.push(normalize(ab).toLowerCase());
    forms.forEach((f, i) => {
      if ((s.startsWith(f + " ") || s.startsWith(f + ",") || s === f) && f.length > bl) { best = a; bl = f.length; abbrev = !!ab && i === forms.length - 1; }
    });
  }
  if (!best) return { ac: null, rest: s, abbrev: false };
  return { ac: best, rest: s.slice(bl).replace(/^[\s,]+/, ""), abbrev };
}

function viaList(s, from) {
  const m = s.slice(from).match(/\bvia ([^]*)/);
  if (!m) return [];
  const out = [];
  for (const w of m[1].split(/[\s,]+/)) {
    if (!w) continue;
    if (STOP_WORDS.has(w)) break;
    const W = w.toUpperCase();
    if (!(KNOWN_TAXIWAYS && KNOWN_TAXIWAYS.has(W)) && !/^[a-z]{1,2}\d{0,2}$/.test(w)) break;
    out.push(W);
  }
  return out;
}

function altText(s) {
  let m = s.match(/(?:flight level|fl) ?(\d{2,3})/);
  if (m) return `flight level ${m[1]}`;
  m = s.match(/(?:climb|maintain|altitude)(?: and maintain)?(?: to)? (\d{3,5})(?: feet| ft)?/);
  if (m) return `${m[1]} feet`;
  return null;
}

/** Parse the instruction part of a transmission. */
export function parseInstructions(s) {
  const found = [];
  const add = (re, fn) => {
    const g = new RegExp(re.source, "g");
    let m;
    while ((m = g.exec(s))) { const r = fn(m); if (r) found.push({ at: m.index, ...r }); if (!m[0].length) g.lastIndex++; }
  };
  const rwyNear = (idx) => {
    const m = [...s.matchAll(new RegExp(`runway ${RWY}`, "g"))];
    let best = null;
    for (const x of m) if (Math.abs(x.index - idx) < 40 && (!best || Math.abs(x.index - idx) < Math.abs(best.index - idx))) best = x;
    return best ? best[1].toUpperCase() : null;
  };

  // IFR clearance: "cleared to riga [via X departure] [climb 4000] squawk 4521"
  add(/\bcleared (?!(?:to )?land\b)(?!for\b)(?!take)(?!touch)(?!special)(?!low approach)(?!stop and go)(?!immediate)(?!(?:to )?cross)(?!(?:for )?(?:ils|vor|rnav|rnp|visual|approach|direct|via)\b)(?:to )?([a-z0-9]+)/, (m) => {
    const tail = s.slice(m.index);
    const sid = tail.match(/\bvia ([a-z0-9 ]+?)(?: departure)?(?=,| climb| initial| squawk| maintain|$)/);
    const sq = tail.match(/squawk (\d{4})/);
    const sidTxt = sid ? sid[1].trim() : null;
    const asFiled = sidTxt && /\b(flight planned|planned route|as filed|filed route)\b/.test(sidTxt);
    return { t: "clearance", dest: /^[a-z]{4}$/.test(m[1]) ? m[1].toUpperCase() : m[1],
      sid: asFiled ? "flight planned route" : sidTxt ? sidTxt.toUpperCase() + " departure" : null,
      alt: altText(tail), squawk: sq && /^[0-7]{4}$/.test(sq[1]) ? sq[1] : null };
  });
  const isClearance = found.some(f => f.t === "clearance");

  add(/\bpush(?: ?back)?(?: and start(?: ?up)?)?(?: is)? approved/, (m) => {
    const f = s.match(/fac(?:e|ing) (north|south|east|west)/);
    const tl = s.match(/tail (north|south|east|west)/);
    const opp = { north: "south", south: "north", east: "west", west: "east" };
    return { t: "push", face: f ? f[1] : tl ? opp[tl[1]] : null };
  });
  add(/\btaxi(?: to)? (?:stand|gate|parking|position)\b ?([^,]*?)(?= via\b|,|$)/, (m) => ({
    t: "taxiStand", stand: m[1].trim() || null, via: viaList(s, m.index),
  }));
  add(new RegExp(`\\btaxi(?: to)?(?: the)?(?: (?:holding|hold) (?:point|position))?(?: runway)? ${RWY}\\b`), (m) => ({
    t: "taxi", rwy: m[1].toUpperCase(), via: viaList(s, m.index),
  }));
  add(/\btaxi via\b/, (m) => /taxi(?: to)? (?:stand|gate|parking)/.test(s) ? null : ({ t: "taxi", rwy: null, via: viaList(s, m.index) }));
  add(new RegExp(`\\bhold(?:ing)? short(?: of)?(?: runway)? ${RWY}`), (m) => ({ t: "holdShort", rwy: m[1].toUpperCase() }));
  add(/\bhold(?:ing)? short(?: of)? (?:taxiway )?([a-z]{1,2}\d{0,2})\b(?! ?\d)/, (m) => KNOWN_TAXIWAYS && KNOWN_TAXIWAYS.has(m[1].toUpperCase()) && !/^\d/.test(m[1]) ? { t: "holdShortTwy", twy: m[1].toUpperCase() } : null);
  add(new RegExp(`\\bcross(?:ing)?(?: runway)? ${RWY}`), (m) => ({ t: "cross", rwy: m[1].toUpperCase() }));
  add(/\bhold position\b|\bstop immediately\b/, () => ({ t: "hold" }));
  add(/\bcontinue taxi\b/, () => ({ t: "continue" }));
  add(/\bcontinue approach\b/, () => ({ t: "contApp" }));
  // conditional clearance: "behind the landing A320, line up and wait behind"
  add(new RegExp(`\\bbehind ${TRAFFIC_WORDS}(?=,? (?:line up|cross|enter|hold|taxi)|,|$)`), (m) => ({ t: "condition", phase: m[1] || "", subject: m[2].trim() }));
  add(new RegExp(`\\bline up(?: and wait)?(?: runway ${RWY})?( behind)?`), (m) => ({ t: "lineup", rwy: m[1] ? m[1].toUpperCase() : rwyNear(m.index) }));
  add(new RegExp(`\\bcleared (?:for )?(immediate )?take ?off(?! from present position)(?: runway ${RWY})?`), (m) => ({ t: "takeoff", rwy: m[2] ? m[2].toUpperCase() : rwyNear(m.index), immediate: !!m[1] }));
  add(/\bcancel take ?off(?: clearance)?\b|\btake ?off clearance cancelled\b|\bstop,? stop\b/, () => ({ t: "cancelTakeoff" }));
  add(new RegExp(`\\bcleared (?:to )?land(?: runway ${RWY})?`), (m) => ({ t: "land", rwy: m[1] ? m[1].toUpperCase() : rwyNear(m.index) }));
  add(new RegExp(`\\bcleared (?:for )?(?:the )?option(?: runway ${RWY})?`), (m) => ({ t: "option", rwy: m[1] ? m[1].toUpperCase() : rwyNear(m.index) }));
  add(new RegExp(`\\bcleared (?:for )?(?:touch and go|touch-and-go|low approach|stop and go)(?: runway ${RWY})?`), (m) => ({ t: "touchGo", rwy: m[1] ? m[1].toUpperCase() : rwyNear(m.index) }));
  add(new RegExp(`\\bland after ${TRAFFIC_WORDS}(?=,? runway|,|$)`), (m) => ({ t: "landAfter", phase: m[1] || "landing", subject: m[2].trim() }));
  add(/\bgo around\b/, () => ({ t: "goaround" }));
  add(/\bexpect (?:runway |an? |the |ils )?([a-z0-9 ]{2,40}?)(?=,|$| squawk| climb| contact)/, (m) => ({ t: "expect", what: m[1].trim() }));
  // B2: VFR reporting points by their real names ("report Bravo", "report overhead Kilo", "via Kilo at 1500 feet")
  if (VFR_NAMES.length) {
    const alt = VFR_NAMES.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).sort((a, b) => b.length - a.length).join("|");
    add(new RegExp(`\\breport (?:overhead |over |at )?(${alt})\\b`), (m) => ({ t: "report", what: VFR_MAP.get(m[1]) || m[1], vfrPoint: true }));
    add(new RegExp(`\\b(?:leave|leaving|exit|join|enter|inbound|route)(?: the (?:zone|control zone|ctr))? via (${alt})(?: at (\\d{3,4}) feet)?`), (m) => ({ t: "vfrVia", point: VFR_MAP.get(m[1]) || m[1], alt: m[2] ? +m[2] : null }));
  } else {
    add(/\breport (?:overhead |over )?(november|echo|sierra|whiskey|n|e|s|w)\b(?! ?\d)/, (m) => ({ t: "report", what: m[1], vfrPoint: true, unknownPoint: true }));
  }
  add(/\breport (vacated|vacating|runway vacated|established|localizer established|final|short final|ready|airborne|downwind|base|passing (?:\d{3,5})(?: feet)?|holding short|reaching (?:\d{3,5})(?: feet)?|overhead|the field in sight|field in sight)\b/, (m) => ({ t: "report", what: m[1].replace("runway vacated", "vacated").replace("localizer established", "established").replace("short final", "final").replace("the field in sight", "field in sight") }));
  add(new RegExp(`\\bgive way to ${TRAFFIC_WORDS}(?=,|$| then| and)`), (m) => ({ t: "giveWay", phase: m[1] || "", subject: m[2].trim() }));
  add(new RegExp(`\\bfollow ${TRAFFIC_WORDS}(?=,|$| to| via)`), (m) => /^(me|the follow)/.test(m[2]) ? null : ({ t: "follow", phase: m[1] || "", subject: m[2].trim() }));
  // VFR
  add(new RegExp(`\\bjoin (left|right)?\\s?(downwind|base|final|overhead|crosswind|straight in)(?: runway ${RWY})?`), (m) => ({ t: "join", side: m[1] || null, leg: m[2], rwy: m[3] ? m[3].toUpperCase() : null }));
  add(/\bextend downwind\b/, () => ({ t: "extend" }));
  add(/\b(?:orbit|make a (?:left|right) (?:360|three sixty)) ?(left|right)?/, (m) => ({ t: "orbit", side: m[1] || (/left 360|left three sixty/.test(s) ? "left" : "right") }));
  add(/\bcleared special vfr\b|\bspecial vfr (?:clearance )?(?:approved|granted)\b/, () => ({ t: "svfr" }));
  add(/\bremain outside (?:the )?(?:control zone|controlled airspace|zone)\b|\bhold outside (?:the )?zone\b/, () => ({ t: "remainOutside" }));
  add(/\b(?:lift|hover taxi|air taxi) approved\b|\bcleared for take ?off from present position\b/, () => ({ t: "lift" }));
  add(/\bmake (?:a )?full stop\b|\bfull stop\b/, () => ({ t: "fullStop" }));
  // de-icing, tows, vehicles
  add(/\bde[- ]?icing (?:approved|on stand|on the stand)\b|\btaxi to (?:the )?de[- ]?ic(?:e|ing) (?:pad|area)\b/, (m) => ({ t: "deice", pad: /pad|area/.test(m[0]) }));
  add(/\btow(?:ing)? approved\b/, () => ({ t: "towApproved", via: viaList(s, 0) }));
  add(new RegExp(`\\b(?:enter|proceed onto|cleared to enter|proceed on) runway ${RWY}\\b`), (m) => ({ t: "enterRwy", rwy: m[1].toUpperCase() }));
  add(/\bvacate (?:the )?runway\b|\bvacate immediately\b/, () => ({ t: "vacate" }));
  add(/\brunway (?:is )?(?:closed|unavailable)\b/, () => ({ t: "rwyClosed" }));
  add(/\bstandby for (?:the )?(?:aircraft|arrival|emergency)\b|\blocal standby\b|\bfull emergency\b|\baircraft accident\b/, (m) => ({ t: "rffs", level: /full|accident/.test(m[0]) ? "full" : "local" }));
  add(/\b(?:contact|monitor) ((?:[a-z]+ ){0,2}[a-z]+)(?:,? (?:on )?(\d{3}\.\d{1,3}|1\d{5}))?/, (m) => {
    if (/^(station|me)$/.test(m[1])) return null;
    const f = m[2] && !m[2].includes(".") ? m[2].slice(0, 3) + "." + m[2].slice(3) : m[2];
    const u = m[1].match(/^(.*?\b(?:ground|tower|delivery|radar|approach|departure|director|control|center|centre|apron|clearance|ramp|information))\b/);
    return { t: "contact", unit: (u ? u[1] : m[1].split(" ")[0]).trim(), freq: f || null };
  });
  add(/\bfrequency change approved\b/, () => ({ t: "contact", unit: "frequency change approved", freq: null }));
  if (!isClearance) add(/\bsquawk (\d{4})\b/, (m) => /^[0-7]{4}$/.test(m[1]) ? { t: "squawk", code: m[1] } : null);
  add(/\bsquawk ident\b/, () => ({ t: "ident" }));
  add(/\binformation ([a-z])\b(?: is| now)*(?: current)?/, (m) => /current/.test(s) ? { t: "atis", letter: m[1] } : null);
  add(/\bcleared (?:for )?(?:the )?(?:ils|rnav|rnp|vor|visual|localizer|loc|ndb|gls|gps)(?: [a-z])?(?: approach)?/, () => ({ t: "approach" }));
  add(/\bidentified\b/, () => ({ t: "identified" }));
  // Tower light signals (ICAO Annex 2, appendix 1): "light green flashing", "flashing green", "red steady light"
  const LMODE = (w) => /^(steady|continuous|solid)$/.test(w) ? "steady" : "flashing";
  add(/\b(?:light(?:s|[ -]?gun|[ -]?signal)?\s+)?(green|red|white)\s+(steady|continuous|solid|flashing|flash|flashes|blinking)\b(?:\s+light)?/, (m) => ({ t: "light", color: m[1], mode: LMODE(m[2]) }));
  add(/\b(steady|continuous|solid|flashing|flash|blinking)\s+(green|red|white)\b(?:\s+light)?/, (m) => ({ t: "light", color: m[2], mode: LMODE(m[1]) }));
  add(/\b(?:send(?: the| a)? )?follow[ -]?me(?: (?:car|vehicle|van))?(?: (?:is )?(?:on (?:its|the) way|coming))?\b/, () => ({ t: "followMe" }));
  if (!isClearance) add(/\b(climb|descend)(?: and maintain| to)* (?:(?:flight level|fl) ?(\d{2,3})|(\d{3,5})(?: feet| ft)?)/, (m) =>
    ({ t: "alt", verb: m[1], ft: m[2] ? +m[2] * 100 : +m[3], fl: !!m[2] }));
  // nav data (F4): "direct LAKUT", "proceed direct Tallinn VOR", "hold at TLL", "cleared via LAKUT1T arrival"
  const NAV_END = "(?=,|$| then| and| climb| descend| maintain| expect| contact| as published| inbound| left| right| reduce| speed| when)";
  add(new RegExp(`\\b(?:proceed |fly |route )?direct(?: to)? ([a-z][a-z0-9]*(?: [a-z][a-z0-9]*){0,5}?)${NAV_END}`), (m) => {
    const f = resolveFix(m[1]);
    return { t: "direct", fix: f.ident, known: f.known };
  });
  add(new RegExp(`\\bhold(?:ing)? (?:at|over) ([a-z][a-z0-9]*(?: [a-z][a-z0-9]*){0,5}?)${NAV_END}`), (m) => {
    const f = resolveFix(m[1]);
    return { t: "holdAt", fix: f.ident, known: f.known, turn: /left turns?/.test(s) ? "L" : /right turns?/.test(s) ? "R" : null };
  });
  add(/\b(?:cleared |descend )?via (?:the )?([a-z]{2,5} ?\d ?[a-z])(?: arrival| star)\b/, (m) => {
    const p = resolveProc(m[1]);
    return { t: "star", name: p.name, known: p.known };
  });

  // a "line up" that is part of "cleared for takeoff" sequences is fine; drop duplicates of the same type
  found.sort((a, b) => a.at - b.at);
  const seen = new Set();
  const out = found.filter(f => { if (seen.has(f.t)) return false; seen.add(f.t); return true; });
  // a condition attaches to the instruction that follows it (or precedes it: "line up behind the landing A320")
  const cond = out.find(f => f.t === "condition");
  if (cond) {
    const target = out.find(f => f.at > cond.at && ["lineup", "cross", "takeoff", "taxi", "hold"].includes(f.t)) || out.find(f => ["lineup", "cross"].includes(f.t));
    if (target) target.cond = { phase: cond.phase, subject: cond.subject };
  }
  // "hold short" after a taxi/cross is a limit on that clearance, not a new one; "continue" in "continue approach" is not taxi
  return out.filter(f => f.t !== "condition");
}

/** Canonical form of a stand name for matching ("Gate E2" == "e 2" == "echo two"). */
export function standKey(name) {
  return normalize(String(name)).replace(/^(gate|stand|parking|ramp)\s+/, "").replace(/[^a-z0-9]/g, "");
}

export function parse(text, aircraft, selected) {
  const s = normalize(text);
  let { ac, rest, abbrev } = matchCallsign(s, aircraft);
  const explicit = !!ac;
  if (!ac && selected) ac = selected;
  const ins = parseInstructions(rest);
  // a SID named in a clearance must be one of the airport's ("cleared to Riga via LAKUT1A departure")
  const clr = ins.find(i => i.t === "clearance" && i.sid && i.sid !== "flight planned route");
  if (clr && NAV) { const p = resolveProc(clr.sid.replace(/ departure$/i, "")); clr.sidKnown = p.known; if (p.known) clr.sid = p.name + " departure"; }
  const warnings = navWarnings(ins, ac);
  // B2: the generic placeholder names where the airport has real VFR points
  const gen = VFR_NAMES.length && /\breport (?:overhead )?(n|e|s|w)\b(?! ?\d)/.exec(rest);
  if (gen && !VFR_MAP.has(gen[1])) warnings.push(`${({ n: "November", e: "Echo", s: "Sierra", w: "Whiskey" })[gen[1]]} is not a VFR reporting point here — the points are ${vfrNames().join(", ")}`);
  if (clr && clr.sidKnown === false) warnings.push(`${clr.sid.replace(/ departure$/i, "")} is not a published SID here`);
  return { ac, explicit, abbrev, ins, normalized: s, neg: /\b(negative|correction)\b/.test(s), warnings };
}
