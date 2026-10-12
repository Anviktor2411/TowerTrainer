// Pilot voices: pick a Web Speech voice per crew member from their nationality, and respell
// English aviation words for non-native voices so the accent comes through but stays intelligible.
import { ENGLISH_NATIVE, NAT_LANG } from "./data.js";

// ---- respelling tables (spoken English -> that language's spelling) ----
const ET = {
  runway: "ränvei", cleared: "kliird", clear: "kliir", squawk: "skvook", thousand: "tausend", tousand: "tausend",
  feet: "fiit", flight: "flait", level: "levl", taxi: "täksi", taxiing: "täksiing", holding: "hoolding",
  ready: "redi", departure: "dipaartšör", takeoff: "teikoff", take: "teik", land: "länd", landing: "ländin",
  approach: "äpproutš", tower: "tauer", ground: "graund", delivery: "diliveri", request: "rikvest",
  clearance: "kliirens", information: "informeišon", via: "vaia", stand: "ständ", push: "puš", pushback: "pušbäk",
  and: "änd", wait: "ueit", line: "lain", up: "ap", contact: "kontakt", radar: "reidar", control: "kontrol",
  climb: "klaim", climbing: "klaiming", descend: "disend", descending: "disending", established: "estäblišt",
  final: "fainal", miles: "mails", vacated: "veikeitid", going: "gouing", around: "eraund",
  frequency: "friikventsi", change: "tšeindž", say: "sei", again: "egen", affirm: "äfööm", negative: "negativ",
  roger: "rodžer", wilco: "uilko", short: "šoort", hold: "hould", cross: "kross", behind: "bihaind",
  good: "gud", morning: "mooning", afternoon: "aftenuun", evening: "iivning", day: "dei", bye: "bai",
  with: "uiz", you: "juu", to: "tu", for: "foor", we: "uii", have: "häv", passing: "paasing", decimal: "desimal",
  left: "left", right: "rait", center: "senter", hundred: "handred", copy: "kopi", start: "start",
  zero: "siiro", one: "uan", wun: "uan", two: "tuu", too: "tuu", three: "trii", tree: "trii", four: "foor",
  fower: "fauer", five: "faiv", fife: "faif", six: "siks", seven: "seven", eight: "eit", ait: "eit",
  nine: "nain", niner: "nainer",
  alpha: "alfa", charlie: "tšarli", echo: "ekko", foxtrot: "fokstrot", juliett: "džuliett", mike: "maik",
  november: "novemba", quebec: "kebek", romeo: "romio", uniform: "juniform", victor: "viktor",
  whiskey: "uiski", "x-ray": "eksrei", xray: "eksrei", yankee: "jänki",
};
const FI = Object.fromEntries(Object.entries(ET).map(([k, v]) => [k, v.replace(/tš/g, "ts").replace(/dž/g, "dz").replace(/[šž]/g, "s")]));
Object.assign(FI, { you: "juu", departure: "dipaartsör", change: "tseints" });
const LV = {
  runway: "ranvej", cleared: "klīrd", clear: "klīr", squawk: "skvok", thousand: "tauzend", tousand: "tauzend",
  feet: "fīt", flight: "flait", taxi: "teksi", holding: "holding", ready: "redī", departure: "dipārčer",
  takeoff: "teikof", take: "teik", land: "lend", tower: "tauer", ground: "graund", delivery: "deliveri",
  request: "rikvest", clearance: "klīrens", information: "informeišn", via: "vaja", stand: "stend", push: "puš",
  and: "end", wait: "veit", line: "lain", up: "ap", contact: "kontakt", climb: "klaim", established: "establišt",
  final: "fainal", miles: "mailz", vacated: "veikeitid", frequency: "frīkvensī", change: "čeinč", say: "sei",
  again: "egen", roger: "rodžer", hold: "hould", short: "šort", good: "gud", day: "dei", approach: "eprouč",
  descending: "disending", passing: "pāsing", decimal: "desimal",
  zero: "zīro", one: "van", two: "tū", three: "trī", tree: "trī", four: "for", five: "faiv", fife: "faif",
  six: "siks", eight: "eit", niner: "nainer", nine: "nain",
  charlie: "čarlī", juliett: "džuliet", mike: "maik", whiskey: "viskī", yankee: "jenkī", xray: "eksrei",
  "x-ray": "eksrei", quebec: "kebek", uniform: "juniform",
};
const LT = {
  runway: "ranvėj", cleared: "klyrd", clear: "klyr", squawk: "skvok", thousand: "tauzend", tousand: "tauzend",
  feet: "fyt", taxi: "teksi", ready: "redi", departure: "diparčer", takeoff: "teikof", land: "lend",
  tower: "tauer", ground: "graund", request: "rikvest", clearance: "klyrens", information: "informeišn",
  via: "vaja", stand: "stend", push: "puš", wait: "veit", line: "lain", climb: "klaim", final: "fainal",
  frequency: "frykvensi", change: "čeinč", say: "sei", again: "egen", roger: "rodžer", hold: "hould",
  short: "šort", and: "end", up: "ap", flight: "flait", approach: "eprouč", decimal: "desimal",
  zero: "zyro", one: "van", two: "tū", three: "try", tree: "try", four: "for", five: "faiv", fife: "faif",
  eight: "eit", niner: "nainer", nine: "nain",
  charlie: "čarli", juliett: "džuliet", mike: "maik", whiskey: "viski", yankee: "jenki", xray: "eksrei",
};
const DE = {
  runway: "ränwäi", cleared: "klierd", clear: "klier", squawk: "skwohk", thousand: "tausend", tousand: "tausend",
  feet: "fiet", flight: "flait", level: "lewel", taxi: "täxi", holding: "hoolding", ready: "reddi",
  departure: "dipartscher", takeoff: "täikoff", take: "täik", land: "länd", approach: "äprootsch", tower: "tauer",
  ground: "graund", delivery: "deliweri", request: "riquest", clearance: "klierens", information: "informäischen",
  via: "waia", stand: "ständ", push: "pusch", and: "änd", wait: "wäit", line: "lain", up: "ap",
  contact: "kontäkt", radar: "räidar", climb: "klaim", descend: "dissend", descending: "dissending",
  established: "istäblischt", final: "fainel", miles: "mails", vacated: "wäikäitid", going: "gouing",
  around: "eraund", frequency: "friekwenzi", change: "tschäinsch", say: "säi", again: "egän", roger: "rodscher",
  hold: "hould", short: "schort", cross: "kross", with: "wiz", good: "gud", day: "däi", bye: "bai",
  passing: "pahsing", decimal: "dessimal",
  zero: "siro", one: "wan", two: "tuh", three: "srie", tree: "trie", four: "for", five: "faif", fife: "faif",
  seven: "sewen", eight: "äit", niner: "nainer", nine: "nain",
  charlie: "tscharli", juliett: "dschuliett", mike: "maik", whiskey: "wiski", yankee: "jänki", xray: "ex-räi",
  "x-ray": "ex-räi", victor: "wiktor", quebec: "kebeck", uniform: "juniform", echo: "ecko", hotel: "hotell",
  november: "nowember", romeo: "romio", zulu: "sulu",
};
export const RESPELL = { et: ET, fi: FI, lv: LV, lt: LT, de: DE };

/** Respell an English phrase for a voice language ("et-EE" -> Estonian table). Unknown words stay. */
export function respell(text, lang) {
  const table = RESPELL[String(lang || "").slice(0, 2).toLowerCase()];
  if (!table) return text;
  return text.replace(/[A-Za-z][A-Za-z'-]*/g, (w) => {
    const r = table[w.toLowerCase()];
    if (!r) return w;
    return w[0] === w[0].toUpperCase() ? r[0].toUpperCase() + r.slice(1) : r;
  });
}

// ---- voice selection ----
const quality = (v) => (/natural/i.test(v.name) ? 4 : 0) + (/online/i.test(v.name) ? 2 : 0) + (v.localService === false ? 1 : 0);
const langIs = (v, lang) => v.lang && v.lang.toLowerCase().replace("_", "-").startsWith(lang.toLowerCase());

function chooseFrom(cands, seed) {
  if (!cands.length) return null;
  const best = Math.max(...cands.map(quality));
  const top = cands.filter(v => quality(v) === best);
  return top[Math.abs(seed) % top.length];
}

function englishVoice(voices, prefLang, seed) {
  for (const l of [prefLang, "en-GB", "en-US", "en-IE", "en-AU", "en"].filter(Boolean)) {
    const v = chooseFrom(voices.filter(x => langIs(x, l)), seed);
    if (v) return v;
  }
  return null;
}

/**
 * Pick a voice for a crew member.
 *  mode: "off" (English voices only) | "natural" (native-language voice when a respelling table exists)
 *        | "strong" (native-language voice for every non-native crew if installed)
 * Returns { voice, lang, respell: bool, native: bool, fallback: bool }.
 */
export function pickVoice(voices, nat, seed, mode = "natural") {
  const engLang = ENGLISH_NATIVE[nat];
  if (engLang) {
    const v = englishVoice(voices, engLang, seed);
    return { voice: v, lang: v ? v.lang : engLang, respell: false, native: !!v && langIs(v, engLang), fallback: !v || !langIs(v, engLang) };
  }
  const own = NAT_LANG[nat];
  const hasTable = !!(own && RESPELL[own.slice(0, 2)]);
  if (own && mode !== "off" && (hasTable || mode === "strong")) {
    const v = chooseFrom(voices.filter(x => langIs(x, own)) .concat(voices.filter(x => langIs(x, own.slice(0, 2)) && !langIs(x, own))), seed);
    if (v) return { voice: v, lang: v.lang, respell: hasTable, native: true, fallback: false };
  }
  const v = englishVoice(voices, seed % 2 ? "en-GB" : "en-US", seed);
  return { voice: v, lang: v ? v.lang : "en-GB", respell: false, native: false, fallback: true };
}

/** Two-person crew with fixed voices; the pilot monitoring (index 0) makes most calls. */
export function makeCrew(nat) {
  const m = () => ({ seed: Math.floor(Math.random() * 1e6), pitch: 0.85 + Math.random() * 0.35, rate: 0.95 + Math.random() * 0.2 });
  const slow = ["EE", "FI", "LV", "LT"].includes(nat) ? 0.92 : 1;
  const crew = [m(), m()];
  for (const c of crew) c.rate *= slow;
  return crew;
}
