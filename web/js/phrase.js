// Radio phraseology: region rules (ICAO Doc 4444 / UK CAP 413 / US FAA 7110.65), how numbers and
// callsigns are spoken, and the template variants pilots use. Every phrase has a display form
// (what the frequency log shows) and a spoken form (what the TTS voice says).
import { LETTER_WORD, TYPE_SPOKEN, TYPE_MAKER, ENGLISH_NATIVE, rnd } from "./data.js";

// K... and C... = US (FAA), EG.. and EI.. = UK (CAP 413), everything else ICAO.
export function regionOf(icao) {
  const i = String(icao || "").toUpperCase();
  if (i[0] === "K" || i[0] === "C" || i.startsWith("PA") || i.startsWith("PH")) return "US";
  if (i.startsWith("EG") || i.startsWith("EI")) return "UK";
  return "ICAO";
}

/**
 * Speaking style of one flight crew.
 *  strict:   ICAO-strict number words (tree, fife, fower, tousand)
 *  group:    groups flight numbers ("twelve thirty-four"), native English habit
 *  nine:     says "nine" instead of "niner" (many US pilots)
 *  cbFirst:  probability of putting the callsign first in a readback (US mix)
 */
export function makeStyle(region, nat) {
  const native = !!ENGLISH_NATIVE[nat];
  const finnicBaltic = ["EE", "FI", "LV", "LT"].includes(nat);
  return {
    region, nat, native,
    strict: !native && Math.random() < (finnicBaltic ? 0.55 : 0.3),
    group: native && Math.random() < (region === "US" ? 0.85 : nat === "US" || nat === "CA" ? 0.7 : 0.25),
    nine: native && (nat === "US" || nat === "CA") && Math.random() < 0.7,
    point: region === "US",
    cbFirst: region === "US" ? 0.45 : 0,
    chatty: native ? 0.5 : finnicBaltic ? 0.08 : 0.25,
  };
}
export const NEUTRAL_STYLE = { region: "ICAO", nat: "", native: true, strict: false, group: false, nine: false,
  point: false, cbFirst: 0, chatty: 0 };

const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve",
  "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

/** One digit as spoken under a style. */
export function digitWord(d, st = NEUTRAL_STYLE) {
  d = +d;
  if (d === 9) return st.nine ? "nine" : "niner";
  if (st.strict) return ["zero", "wun", "too", "tree", "fower", "fife", "six", "seven", "ait", "niner"][d];
  return ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "niner"][d];
}
export const digits = (s, st) => [...String(s)].map(c => /\d/.test(c) ? digitWord(c, st) : c).join(" ");

function twoDigit(n) {
  if (n < 20) return ONES[n];
  return TENS[Math.floor(n / 10)] + (n % 10 ? "-" + ONES[n % 10] : "");
}
/** Grouped flight number the way native speakers say it: 1234 -> twelve thirty-four, 905 -> nine oh five. */
export function groupNumber(numStr) {
  const n = +numStr;
  if (!/^\d+$/.test(numStr) || numStr.startsWith("0")) return digits(numStr);
  if (n < 100) return twoDigit(n);
  if (n % 1000 === 0 && n < 10000) return ONES[n / 1000] + " thousand";
  if (n < 1000) {
    const h = Math.floor(n / 100), r = n % 100;
    return r === 0 ? `${ONES[h]} hundred` : `${ONES[h]} ${r < 10 ? "oh " + ONES[r] : twoDigit(r)}`;
  }
  if (n < 10000) {
    const a = Math.floor(n / 100), r = n % 100;
    return `${twoDigit(a)} ${r === 0 ? "hundred" : r < 10 ? "oh " + ONES[r] : twoDigit(r)}`;
  }
  return digits(numStr);
}

function altitude(n, st) {
  const th = Math.floor(n / 1000), h = Math.floor((n % 1000) / 100);
  const thousand = st.strict ? "tousand" : "thousand";
  let s = th ? `${digits(String(th), st)} ${thousand}` : "";
  if (h) s += `${s ? " " : ""}${digitWord(h, st)} hundred`;
  return s || "zero";
}

/** Convert remaining numbers in a phrase to spoken words for a style. */
export function sayNumbers(text, st = NEUTRAL_STYLE) {
  const dec = st.point ? "point" : "decimal";
  return text
    .replace(/\bflight level (\d{2,3})\b/gi, (_, n) => `flight level ${digits(n, st)}`)
    .replace(/\bFL ?(\d{2,3})\b/g, (_, n) => `flight level ${digits(n, st)}`)
    .replace(/\b(\d{1,2}),?(\d{3}) (feet|ft)\b/g, (_, a, b, u) => `${altitude(+(a + b), st)} feet`)
    .replace(/\b(\d{3,5}) (feet|ft)\b/g, (_, n) => `${(+n) % 100 === 0 ? altitude(+n, st) : digits(n, st)} feet`)
    .replace(/\b(\d{3})\.(\d{1,3})\b/g, (_, a, b) => `${digits(a, st)} ${dec} ${digits(b.replace(/0+$/, "") || "0", st)}`)
    .replace(/\b(\d{1,2})([LRC])\b/g, (_, n, s) => `${digits(n, st)} ${{ L: "left", R: "right", C: "center" }[s]}`)
    .replace(/\b(\d{1,2}) (miles?|nm)\b/g, (_, n, u) => `${(+n) < 20 ? ONES[+n] : twoDigit(+n)} ${u === "nm" ? "miles" : u}`)
    .replace(/\b([A-Z])(\d{1,3})\b/g, (_, l, d) => `${LETTER_WORD[l]} ${digits(d, st)}`)
    .replace(/\b([A-Z])\b(?![a-z'])/g, (m, l) => LETTER_WORD[l] || m)
    .replace(/\d+/g, (n) => digits(n, st));
}

/** Tagged template: plain parts and {d, s} parts -> {d: display, s: spoken}. */
export function ph(st) {
  return (strings, ...vals) => {
    let d = "", s = "";
    strings.forEach((str, i) => {
      d += str; s += sayNumbers(str, st);
      if (i < vals.length) {
        const v = vals[i];
        if (v && typeof v === "object") { d += v.d; s += v.s; } else { d += v ?? ""; s += sayNumbers(String(v ?? ""), st); }
      }
    });
    return { d: tidy(d), s: tidy(s) };
  };
}
const tidy = (x) => x.replace(/\s+,/g, ",").replace(/,\s*,/g, ",").replace(/\s{2,}/g, " ").replace(/^,\s*/, "").trim();
export const cap = (x) => x.charAt(0).toUpperCase() + x.slice(1);
export const join = (parts) => ({ d: parts.map(p => p.d ?? p).join(", "), s: parts.map(p => p.s ?? p).join(", ") });

// ---------- callsigns ----------
/** Spoken/display callsign. GA uses full registration until ATC has abbreviated it. */
export function callsign(a, st = NEUTRAL_STYLE, { abbreviated = a.abbrev } = {}) {
  if (a.ga) {
    const reg = a.cs;
    if (abbreviated) {
      if (reg.startsWith("N")) { // US: maker + last three
        const tail = reg.slice(-3);
        const w = [...tail].map(c => /\d/.test(c) ? c : cap(LETTER_WORD[c])).join(" ");
        const d = `${TYPE_MAKER[a.type] || "November"} ${w}`;
        return { d, s: sayNumbers(d, st) };
      }
      const short = reg[0] + reg.slice(-2);
      const d = [...short].map(c => cap(LETTER_WORD[c])).join(" ");
      return { d, s: d };
    }
    const d = [...reg].map(c => /\d/.test(c) ? c : cap(LETTER_WORD[c])).join(" ").replace(/(\d) (?=\d)/g, "$1");
    return { d, s: sayNumbers(d, st) };
  }
  const d = `${a.tel} ${a.num}`;
  const numSpoken = st.group && Math.random() < 0.85 ? groupNumber(a.num) : digits(a.num, st);
  return { d, s: `${a.tel} ${numSpoken}` };
}
/** The abbreviated form the controller may use (for matching / coach). */
export function abbreviatedCallsign(a) { return a.ga ? callsign(a, NEUTRAL_STYLE, { abbreviated: true }).d : null; }

export function spokenType(type) {
  const v = TYPE_SPOKEN[type];
  return v ? rnd(v) : type;
}

// ---------- greetings & flavour ----------
/** Local solar hour at the airport (UTC + lon/15). */
export function localHour(utcMs, lon) {
  const h = (new Date(utcMs).getUTCHours() + new Date(utcMs).getUTCMinutes() / 60 + lon / 15 + 48) % 24;
  return h;
}
export function greeting(st, hour, aptIcao) {
  if (Math.random() > 0.35 + st.chatty * 0.5) return "";
  if (st.nat === "FR" && Math.random() < 0.5) return "bonjour";
  const g = hour < 5 ? "good evening" : hour < 12 ? "good morning" : hour < 18 ? "good afternoon" : "good evening";
  if (st.nat === "US" && Math.random() < 0.3) return "hello";
  return g;
}
/** Sign-off after a frequency change readback. */
export function signOff(st, aptIcao, voiceIsNative) {
  const r = Math.random();
  if (r > st.chatty + 0.15) return "";
  if (st.nat === "GB" || st.nat === "IE" || st.nat === "AU") return rnd(["cheers", "good day", "bye"]);
  if (st.nat === "US" || st.nat === "CA") return rnd(["good day", "have a good one", "see ya"]);
  if (st.nat === "EE" && aptIcao.startsWith("EE") && voiceIsNative && Math.random() < 0.3) return "head aega";
  if (st.nat === "FR") return rnd(["merci", "merci, au revoir"]);
  if ((st.nat === "DE" || st.nat === "AT") && aptIcao.startsWith("ED") && Math.random() < 0.3) return "tschüss";
  if (["FI", "EE", "LV", "LT"].includes(st.nat)) return Math.random() < 0.3 ? "bye" : "";
  return rnd(["good day", "bye", ""]);
}

// ---------- pilot templates ----------
// ctx: { st, cs:{d,s}, unit, type, stand, atis, dest, rwy, dist, alt, cfl, exit, freq, greet, region }
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const g = (c) => c.greet ? `${c.greet}, ` : "";

export const TEMPLATES = {
  clearanceRequest: {
    ICAO: [
      (p, c) => p`${c.unit}, ${c.cs}, ${g(c)}stand ${c.stand}, information ${c.atis}, request IFR clearance to ${c.dest}`,
      (p, c) => p`${c.unit}, ${g(c)}${c.cs}, ${c.typeSp} at stand ${c.stand}, information ${c.atis}, request clearance to ${c.dest}`,
      (p, c) => p`${c.unit}, ${c.cs}, stand ${c.stand} with information ${c.atis}, ready to copy clearance to ${c.dest}`,
    ],
    UK: [
      (p, c) => p`${c.unit}, ${g(c)}${c.cs}, stand ${c.stand}, ${c.typeSp}, information ${c.atis}, request clearance to ${c.dest}`,
      (p, c) => p`${c.unit}, ${c.cs}, on stand ${c.stand} with ${c.atis}, request clearance`,
    ],
    US: [
      (p, c) => p`${c.unit}, ${c.cs}, IFR to ${c.dest} with ${c.atis}`,
      (p, c) => p`${c.unit}, ${g(c)}${c.cs} at gate ${c.stand}, with information ${c.atis}, IFR to ${c.dest}`,
      (p, c) => p`${c.unit}, ${c.cs}, request clearance to ${c.dest}, we have ${c.atis}`,
    ],
  },
  stillWaiting: {
    ICAO: [(p, c) => p`${c.unit}, ${c.cs}, still waiting for our clearance`, (p, c) => p`${c.unit}, ${c.cs}, request clearance, how long is the delay?`],
    US: [(p, c) => p`${c.unit}, ${c.cs}, any word on our clearance?`, (p, c) => p`${c.unit}, ${c.cs}, still standing by for clearance`],
  },
  stillWaitingGeneric: {
    ICAO: [(p, c) => p`${c.unit}, ${c.cs}, ${c.what}`, (p, c) => p`${c.unit}, ${c.cs}, how do you read? ${c.what}`],
  },
  push: {
    ICAO: [
      (p, c) => p`${c.unit}, ${c.cs}, ${g(c)}stand ${c.stand}, request push and start`,
      (p, c) => p`${c.unit}, ${c.cs}, stand ${c.stand}, ready for push and start`,
      (p, c) => p`${c.unit}, ${c.cs}, request pushback, stand ${c.stand}`,
    ],
    UK: [(p, c) => p`${c.unit}, ${c.cs}, stand ${c.stand}, request push and start`, (p, c) => p`${c.unit}, ${g(c)}${c.cs}, ready for push and start, stand ${c.stand}`],
    US: [(p, c) => p`${c.unit}, ${c.cs}, gate ${c.stand}, ready to push`, (p, c) => p`${c.unit}, ${c.cs} at ${c.stand}, request push with ${c.atis}`],
  },
  taxi: {
    ICAO: [(p, c) => p`${c.unit}, ${c.cs}, request taxi`, (p, c) => p`${c.unit}, ${c.cs}, ready to taxi`],
    US: [(p, c) => p`${c.unit}, ${c.cs}, ready to taxi with ${c.atis}`, (p, c) => p`${c.unit}, ${c.cs}, ready to taxi`],
  },
  gaTaxi: {
    ICAO: [
      (p, c) => p`${c.unit}, ${c.cs}, ${c.typeSp} at ${c.stand}, information ${c.atis}, VFR to ${c.dest}, request taxi`,
      (p, c) => p`${c.unit}, ${g(c)}${c.cs}, ${c.typeSp}, ${c.stand}, VFR departure to ${c.dest} with ${c.atis}, request taxi`,
    ],
    US: [(p, c) => p`${c.unit}, ${c.cs}, ${c.stand}, ready to taxi VFR ${c.dest}bound with ${c.atis}`],
  },
  ready: {
    ICAO: [
      (p, c) => p`${c.unit}, ${c.cs}, holding point runway ${c.rwy}, ready for departure`,
      (p, c) => p`${c.unit}, ${c.cs}, ready for departure runway ${c.rwy}`,
      (p, c) => p`${c.unit}, ${g(c)}${c.cs}, fully ready runway ${c.rwy}`,
    ],
    UK: [(p, c) => p`${c.unit}, ${c.cs}, ready for departure`, (p, c) => p`${c.unit}, ${c.cs}, holding point runway ${c.rwy}, ready`],
    US: [(p, c) => p`${c.unit}, ${c.cs}, holding short ${c.rwy}, ready for departure`, (p, c) => p`${c.unit}, ${c.cs}, ready to go runway ${c.rwy}`],
  },
  approachingHold: {
    ICAO: [(p, c) => p`${c.unit}, ${c.cs}, ${g(c)}approaching holding point runway ${c.rwy}`, (p, c) => p`${c.unit}, ${c.cs}, taxiing to holding point runway ${c.rwy}`],
    US: [(p, c) => p`${c.unit}, ${c.cs}, taxiing to ${c.rwy}`],
  },
  established: {
    ICAO: [
      (p, c) => p`${c.unit}, ${c.cs}, established ILS runway ${c.rwy}`,
      (p, c) => p`${c.unit}, ${c.cs}, ${c.dist} miles final runway ${c.rwy}`,
      (p, c) => p`${c.unit}, ${g(c)}${c.cs}, ILS runway ${c.rwy}, ${c.dist} miles`,
    ],
    UK: [(p, c) => p`${c.unit}, ${g(c)}${c.cs}, ${c.dist} miles, ILS runway ${c.rwy}`, (p, c) => p`${c.unit}, ${c.cs}, established localiser runway ${c.rwy}`],
    US: [(p, c) => p`${c.unit}, ${c.cs}, ${c.dist} mile final runway ${c.rwy}`, (p, c) => p`${c.unit}, ${c.cs}, with you on the ILS ${c.rwy}`],
  },
  gaFinal: {
    ICAO: [(p, c) => p`${c.unit}, ${c.cs}, final runway ${c.rwy}`, (p, c) => p`${c.unit}, ${c.cs}, ${c.typeSp}, long final runway ${c.rwy}, full stop`],
    US: [(p, c) => p`${c.unit}, ${c.cs}, ${c.dist} mile final ${c.rwy}, full stop`],
  },
  approachInitial: {
    ICAO: [
      (p, c) => p`${c.unit}, ${g(c)}${c.cs}, descending ${c.alt}, information ${c.atis}`,
      (p, c) => p`${c.unit}, ${c.cs}, passing ${c.alt}, with ${c.atis}`,
    ],
    UK: [(p, c) => p`${c.unit}, ${g(c)}${c.cs}, descending ${c.alt}, information ${c.atis}`],
    US: [(p, c) => p`${c.unit}, ${c.cs}, descending ${c.alt} with ${c.atis}`, (p, c) => p`${c.unit}, ${g(c)}${c.cs}, ${c.alt}, we have ${c.atis}`],
  },
  vacated: {
    ICAO: [(p, c) => p`${c.cs}, runway vacated${c.exit ? " via " + c.exit : ""}`, (p, c) => p`${c.cs}, vacated${c.exit ? " via " + c.exit : ""}`],
    US: [(p, c) => p`${c.unit}, ${c.cs}, clear of ${c.rwy}${c.exit ? " at " + c.exit : ""}`],
  },
  vacatedTaxi: {
    ICAO: [(p, c) => p`${c.cs}, runway vacated${c.exit ? " via " + c.exit : ""}, request taxi to stand ${c.stand}`,
      (p, c) => p`${c.cs}, vacated${c.exit ? " via " + c.exit : ""}, request taxi to stand ${c.stand}`],
    US: [(p, c) => p`${c.cs}, clear of ${c.rwy}${c.exit ? " at " + c.exit : ""}, taxi to the gate ${c.stand}`],
  },
  groundArrival: {
    ICAO: [(p, c) => p`${c.unit}, ${g(c)}${c.cs}, vacated${c.exit ? " via " + c.exit : ""}, request taxi to stand ${c.stand}`,
      (p, c) => p`${c.unit}, ${c.cs}, request taxi to stand ${c.stand}`],
    US: [(p, c) => p`${c.unit}, ${c.cs}, clear of ${c.rwy}${c.exit ? " at " + c.exit : ""}, taxi to the gate ${c.stand}`],
  },
  departureInitial: {
    ICAO: [(p, c) => p`${c.unit}, ${g(c)}${c.cs}, passing ${c.alt} climbing ${c.cfl}`, (p, c) => p`${c.unit}, ${c.cs}, airborne, passing ${c.alt} for ${c.cfl}`],
    US: [(p, c) => p`${c.unit}, ${c.cs}, ${c.alt} for ${c.cfl}`, (p, c) => p`${c.unit}, ${g(c)}${c.cs}, climbing through ${c.alt} for ${c.cfl}`],
  },
  overflight: {
    ICAO: [(p, c) => p`${c.unit}, ${g(c)}${c.cs}, ${c.cfl}`, (p, c) => p`${c.unit}, ${c.cs}, maintaining ${c.cfl}`],
    US: [(p, c) => p`${c.unit}, ${c.cs}, ${c.cfl}`],
  },
  freqChange: {
    ICAO: [(p, c) => p`${c.cs}, request frequency change`, (p, c) => p`${c.cs}, passing ${c.alt}, request frequency change`],
    US: [(p, c) => p`${c.unit}, ${c.cs}, want us to switch to departure?`, (p, c) => p`${c.cs}, request frequency change`],
  },
  holdingShort: {
    ICAO: [(p, c) => p`${c.cs}, holding short runway ${c.rwy}`, (p, c) => p`${c.cs}, holding short of runway ${c.rwy}`],
    US: [(p, c) => p`${c.cs}, holding short ${c.rwy}`],
  },
  goingAround: {
    ICAO: [(p, c) => p`${c.cs}, going around`, (p, c) => p`${c.cs}, go around`],
    US: [(p, c) => p`${c.cs}, going around`, (p, c) => p`Going around, ${c.cs}`],
  },
  sayAgain: {
    ICAO: [(p, c) => p`${c.cs}, say again`, (p, c) => p`Say again please, ${c.cs}`, (p, c) => p`${c.cs}, say again the last part`],
    US: [(p, c) => p`Say again for ${c.cs}`, (p, c) => p`${c.cs}, say again?`],
  },
  confirmTakeoff: {
    ICAO: [(p, c) => p`${c.cs}, confirm cleared for takeoff? We have traffic on the runway`, (p, c) => p`${c.cs}, confirm cleared for takeoff, traffic on the runway?`],
  },
  noReply: { ICAO: [(p, c) => p`${c.unit}, ${c.cs}, no reply on ${c.freq}`, (p, c) => p`${c.unit}, ${c.cs}, nobody on ${c.freq}, back with you`] },
  mayday: { ICAO: [(p, c) => p`Mayday, mayday, mayday, ${c.unit}, ${c.cs}, engine failure, request priority landing runway ${c.rwy}`] },
};

/** Build a pilot call. Falls back from region-specific to ICAO variants. */
export function pilotCall(kind, c) {
  const set = TEMPLATES[kind];
  const list = (c.st.region === "US" && set.US) || (c.st.region === "UK" && set.UK) || set.ICAO;
  return capFirst(pick(list)(ph(c.st), c));
}
const capFirst = (r) => ({ d: cap(r.d), s: cap(r.s) });

/** Readback: ICAO/UK put the callsign at the end; US pilots mix both forms. */
export function readback(items, cs, st, extra = "") {
  const body = join(items.map(i => typeof i === "string" ? { d: i, s: sayNumbers(i, st) } : i));
  const tail = extra ? `, ${extra}` : "";
  if (Math.random() < st.cbFirst) return capFirst({ d: `${cs.d}, ${body.d}${tail}`, s: `${cs.s}, ${body.s}${tail}` });
  return capFirst({ d: `${body.d}, ${cs.d}${tail}`, s: `${body.s}, ${cs.s}${tail}` });
}
