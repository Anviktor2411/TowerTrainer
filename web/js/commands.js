// Parse controller phraseology (typed or speech-recognised) into instructions.
import { PHONETIC, DIGIT_WORDS } from "./data.js";
import { abbreviatedCallsign } from "./phrase.js";

const RWY = "(\\d{1,2}[lrc]?)";
const STOP_WORDS = new Set(["hold", "holding", "cross", "contact", "monitor", "runway", "and", "then", "behind",
  "give", "way", "line", "cleared", "expect", "short", "of", "to", "stand", "gate", "squawk", "climb", "via", "for"]);

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
  return out.join(" ").replace(/[#~]/g, "").toLowerCase().replace(/ , /g, ", ").replace(/\s+,\s*$/, "");
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
    if (!/^[a-z]{1,2}\d{0,2}$/.test(w)) break;
    out.push(w.toUpperCase());
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
  add(/\bcleared (?!(?:to )?land\b)(?!for\b)(?!take)(?!(?:to )?cross)(?!(?:for )?(?:ils|vor|rnav|rnp|visual|approach|direct|via)\b)(?:to )?([a-z0-9]+)/, (m) => {
    const tail = s.slice(m.index);
    const sid = tail.match(/\bvia ([a-z0-9 ]+?)(?: departure)?(?=,| climb| initial| squawk| maintain|$)/);
    const sq = tail.match(/squawk (\d{4})/);
    return { t: "clearance", dest: /^[a-z]{4}$/.test(m[1]) ? m[1].toUpperCase() : m[1], sid: sid ? sid[1].trim().toUpperCase() : null,
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
  add(new RegExp(`\\bcross(?:ing)?(?: runway)? ${RWY}`), (m) => ({ t: "cross", rwy: m[1].toUpperCase() }));
  add(/\bhold position\b/, () => ({ t: "hold" }));
  add(/\bcontinue taxi\b/, () => ({ t: "continue" }));
  add(new RegExp(`\\bline up(?: and wait)?(?: runway ${RWY})?`), (m) => ({ t: "lineup", rwy: m[1] ? m[1].toUpperCase() : rwyNear(m.index) }));
  add(new RegExp(`\\bcleared (?:for )?take ?off(?: runway ${RWY})?`), (m) => ({ t: "takeoff", rwy: m[1] ? m[1].toUpperCase() : rwyNear(m.index) }));
  add(new RegExp(`\\bcleared (?:to )?land(?: runway ${RWY})?`), (m) => ({ t: "land", rwy: m[1] ? m[1].toUpperCase() : rwyNear(m.index) }));
  add(/\bgo around\b/, () => ({ t: "goaround" }));
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
  add(/\bcleared (?:for )?(?:the )?(?:ils|rnav|rnp|vor|visual)(?: approach)?/, () => ({ t: "approach" }));
  add(/\bidentified\b/, () => ({ t: "identified" }));
  if (!isClearance) add(/\b(climb|descend)(?: and maintain| to)* (?:(?:flight level|fl) ?(\d{2,3})|(\d{3,5})(?: feet| ft)?)/, (m) =>
    ({ t: "alt", verb: m[1], ft: m[2] ? +m[2] * 100 : +m[3], fl: !!m[2] }));

  // a "line up" that is part of "cleared for takeoff" sequences is fine; drop duplicates of the same type
  found.sort((a, b) => a.at - b.at);
  const seen = new Set();
  return found.filter(f => { if (seen.has(f.t)) return false; seen.add(f.t); return true; });
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
  return { ac, explicit, abbrev, ins: parseInstructions(rest), normalized: s, neg: /\b(negative|correction)\b/.test(s) };
}
