// Static reference data: airlines, aircraft types, destinations, phonetics.

export const AIRLINES = [
  ["RYR", "Ryanair"], ["EZY", "Easy"], ["DLH", "Lufthansa"], ["BAW", "Speedbird"],
  ["AFR", "Airfrans"], ["KLM", "KLM"], ["SAS", "Scandinavian"], ["FIN", "Finnair"],
  ["BTI", "Air Baltic"], ["WZZ", "Wizz Air"], ["NSZ", "Rednose"], ["AUA", "Austrian"],
  ["SWR", "Swiss"], ["THY", "Turkish"], ["UAE", "Emirates"], ["QTR", "Qatari"],
  ["AAL", "American"], ["DAL", "Delta"], ["UAL", "United"], ["ACA", "Air Canada"],
  ["LOT", "LOT"], ["IBE", "Iberia"], ["VLG", "Vueling"], ["TAP", "Air Portugal"],
  ["EIN", "Shamrock"], ["SIA", "Singapore"], ["ETD", "Etihad"], ["NOZ", "Nordic"],
  ["DAT", "Dat Danish"], ["EWG", "Eurowings"], ["BEL", "Beeline"], ["CFG", "Condor"],
];

// type, wake category, stand types it fits, approach speed kt
export const TYPES = [
  ["A320", "M", "jets", 135], ["A20N", "M", "jets", 135], ["A21N", "M", "jets", 140],
  ["B738", "M", "jets", 145], ["B38M", "M", "jets", 145], ["A319", "M", "jets", 130],
  ["E190", "M", "jets", 130], ["E195", "M", "jets", 135], ["CRJ9", "M", "jets", 140],
  ["BCS3", "M", "jets", 135], ["AT76", "M", "turboprops", 115], ["DH8D", "M", "turboprops", 120],
  ["B77W", "H", "heavy", 150], ["A359", "H", "heavy", 145], ["B789", "H", "heavy", 145],
  ["A333", "H", "heavy", 140],
];

// light aircraft for GA fields (and tie-down stands)
export const GA_TYPES = [["C172", "L", "props", 65], ["PA28", "L", "props", 70], ["SR22", "L", "props", 80], ["DA40", "L", "props", 70]];
// registration prefix by ICAO region (first 2 letters, then 1)
export const REG_PREFIX = { EG: "G", ED: "D", EE: "ES", EF: "OH", ES: "SE", EN: "LN", EK: "OY", EH: "PH", EB: "OO",
  EI: "EI", EP: "SP", EV: "YL", EY: "LY", LF: "F", LE: "EC", LI: "I", LO: "OE", LS: "HB", LK: "OK", LH: "HA",
  K: "N", C: "C", Y: "VH", Z: "B" };

export const DESTS = [
  ["EGLL", "London", 51.47, -0.46], ["EHAM", "Amsterdam", 52.31, 4.76], ["EDDF", "Frankfurt", 50.03, 8.57],
  ["LFPG", "Paris", 49.01, 2.55], ["EKCH", "Copenhagen", 55.62, 12.65], ["ESSA", "Stockholm", 59.65, 17.92],
  ["EFHK", "Helsinki", 60.32, 24.96], ["EVRA", "Riga", 56.92, 23.97], ["EYVI", "Vilnius", 54.63, 25.29],
  ["EPWA", "Warsaw", 52.17, 20.97], ["ENGM", "Oslo", 60.19, 11.10], ["EDDM", "Munich", 48.35, 11.79],
  ["LOWW", "Vienna", 48.11, 16.57], ["LSZH", "Zurich", 47.46, 8.55], ["LEMD", "Madrid", 40.47, -3.56],
  ["LEBL", "Barcelona", 41.30, 2.08], ["LIRF", "Rome", 41.80, 12.25], ["LTFM", "Istanbul", 41.26, 28.74],
  ["EIDW", "Dublin", 53.42, -6.27], ["EDDB", "Berlin", 52.36, 13.50], ["LKPR", "Prague", 50.10, 14.26],
  ["LHBP", "Budapest", 47.43, 19.26], ["LPPT", "Lisbon", 38.77, -9.13], ["EBBR", "Brussels", 50.90, 4.48],
  ["OMDB", "Dubai", 25.25, 55.36], ["OTHH", "Doha", 25.27, 51.61], ["KJFK", "Kennedy", 40.64, -73.78],
  ["KORD", "Chicago", 41.98, -87.90], ["KATL", "Atlanta", 33.64, -84.43], ["KLAX", "Los Angeles", 33.94, -118.41],
  ["KBOS", "Boston", 42.36, -71.01], ["KDFW", "Dallas", 32.90, -97.04], ["KSFO", "San Francisco", 37.62, -122.38],
  ["CYYZ", "Toronto", 43.68, -79.63], ["KMIA", "Miami", 25.79, -80.29], ["KDEN", "Denver", 39.86, -104.67],
  ["WSSS", "Singapore", 1.36, 103.99], ["RJTT", "Tokyo", 35.55, 139.78], ["VHHH", "Hong Kong", 22.31, 113.92],
  ["YSSY", "Sydney", -33.95, 151.18], ["FAOR", "Johannesburg", -26.14, 28.24], ["SBGR", "Sao Paulo", -23.43, -46.47],
];

export const PHONETIC = {
  alpha: "A", alfa: "A", bravo: "B", charlie: "C", delta: "D", echo: "E", foxtrot: "F", golf: "G",
  hotel: "H", india: "I", juliet: "J", juliett: "J", kilo: "K", lima: "L", mike: "M", november: "N",
  oscar: "O", papa: "P", quebec: "Q", romeo: "R", sierra: "S", tango: "T", uniform: "U", victor: "V",
  whiskey: "W", xray: "X", "x-ray": "X", yankee: "Y", zulu: "Z",
};
export const LETTER_WORD = {
  A: "alpha", B: "bravo", C: "charlie", D: "delta", E: "echo", F: "foxtrot", G: "golf", H: "hotel",
  I: "india", J: "juliett", K: "kilo", L: "lima", M: "mike", N: "november", O: "oscar", P: "papa",
  Q: "quebec", R: "romeo", S: "sierra", T: "tango", U: "uniform", V: "victor", W: "whiskey", X: "x-ray",
  Y: "yankee", Z: "zulu",
};
export const DIGIT_WORDS = {
  zero: "0", one: "1", two: "2", three: "3", tree: "3", four: "4", fower: "4", five: "5", fife: "5",
  six: "6", seven: "7", eight: "8", nine: "9", niner: "9",
};
export const DIGIT_SAY = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "niner"];

// ---------- crews & accents ----------
// Weighted crew nationalities per airline ICAO code: [[nat, weight], ...]. Nat codes are ISO-ish.
export const AIRLINE_NAT = {
  RYR: [["IE", 4], ["GB", 3], ["ES", 1], ["IT", 1], ["PL", 1]], EZY: [["GB", 8], ["FR", 1], ["DE", 1]],
  DLH: [["DE", 1]], BAW: [["GB", 1]], AFR: [["FR", 1]], KLM: [["NL", 1]],
  SAS: [["DK", 1], ["SE", 1], ["NO", 1]], FIN: [["FI", 1]], BTI: [["LV", 5], ["EE", 2], ["LT", 2]],
  WZZ: [["HU", 3], ["PL", 2], ["RO", 2], ["GB", 1]], NSZ: [["NO", 1]], AUA: [["AT", 1]], SWR: [["CH", 1]],
  THY: [["TR", 1]], UAE: [["GB", 2], ["AU", 1], ["ZA", 1], ["AE", 1], ["DE", 1], ["IE", 1]],
  QTR: [["GB", 2], ["ZA", 1], ["AU", 1], ["IN", 1], ["EE", 1], ["ES", 1]], ETD: [["GB", 2], ["AU", 1], ["AE", 1], ["ZA", 1]],
  AAL: [["US", 1]], DAL: [["US", 1]], UAL: [["US", 1]], ACA: [["CA", 1]], LOT: [["PL", 1]], IBE: [["ES", 1]],
  VLG: [["ES", 1]], TAP: [["PT", 1]], EIN: [["IE", 1]], SIA: [["SG", 1]], NOZ: [["NO", 1]], DAT: [["DK", 1]],
  EWG: [["DE", 1]], BEL: [["BE", 1]], CFG: [["DE", 1]],
};
// Registration prefix -> nationality (GA)
export const REG_NAT = { G: "GB", D: "DE", ES: "EE", OH: "FI", SE: "SE", LN: "NO", OY: "DK", PH: "NL", OO: "BE",
  EI: "IE", SP: "PL", YL: "LV", LY: "LT", F: "FR", EC: "ES", I: "IT", OE: "AT", HB: "CH", OK: "CZ", HA: "HU",
  N: "US", C: "CA", VH: "AU", B: "CN" };
// Native English speakers and the English voice they use
export const ENGLISH_NATIVE = { GB: "en-GB", US: "en-US", IE: "en-IE", AU: "en-AU", CA: "en-CA", ZA: "en-ZA",
  NZ: "en-NZ", SG: "en-SG", IN: "en-IN" };
// Voice language for each non-native nationality (accent source)
export const NAT_LANG = { EE: "et-EE", FI: "fi-FI", LV: "lv-LV", LT: "lt-LT", DE: "de-DE", AT: "de-AT", CH: "de-CH",
  FR: "fr-FR", BE: "fr-BE", NL: "nl-NL", DK: "da-DK", SE: "sv-SE", NO: "nb-NO", PL: "pl-PL", ES: "es-ES",
  IT: "it-IT", PT: "pt-PT", HU: "hu-HU", RO: "ro-RO", TR: "tr-TR", CZ: "cs-CZ", AE: "ar-AE", CN: "zh-CN" };
export const NAT_NAME = { GB: "British", US: "American", IE: "Irish", AU: "Australian", CA: "Canadian", ZA: "South African",
  NZ: "New Zealand", SG: "Singaporean", IN: "Indian", EE: "Estonian", FI: "Finnish", LV: "Latvian", LT: "Lithuanian",
  DE: "German", AT: "Austrian", CH: "Swiss", FR: "French", BE: "Belgian", NL: "Dutch", DK: "Danish", SE: "Swedish",
  NO: "Norwegian", PL: "Polish", ES: "Spanish", IT: "Italian", PT: "Portuguese", HU: "Hungarian", RO: "Romanian",
  TR: "Turkish", CZ: "Czech", AE: "Emirati", CN: "Chinese" };

// How aircraft types are said on the radio (variants)
export const TYPE_SPOKEN = {
  A320: ["Airbus three twenty", "A three twenty"], A20N: ["A three twenty neo", "Airbus three twenty neo"],
  A21N: ["A three twenty-one neo", "Airbus three twenty-one"], A319: ["Airbus three nineteen", "A three nineteen"],
  B738: ["Boeing seven three seven", "seven thirty-seven eight hundred"], B38M: ["seven thirty-seven max", "Boeing max eight"],
  E190: ["Embraer one ninety", "E one ninety"], E195: ["Embraer one ninety-five", "E one ninety-five"],
  CRJ9: ["CRJ nine hundred", "Canadair jet"], BCS3: ["A two twenty", "Airbus two twenty"],
  AT76: ["ATR seventy-two", "ATR"], DH8D: ["Dash eight", "Q four hundred"], B77W: ["triple seven", "Boeing seven seven seven"],
  A359: ["A three fifty", "Airbus three fifty"], B789: ["seven eight seven", "Dreamliner"], A333: ["A three thirty", "Airbus three thirty"],
  C172: ["Cessna one seventy-two", "Cessna"], PA28: ["Piper Cherokee", "Piper"], SR22: ["Cirrus", "Cirrus SR twenty-two"],
  DA40: ["Diamond forty", "Diamond Star"],
};
// Real dimensions for drawing: type -> [wingspan m, length m, silhouette]
export const AC_DIM = {
  A320: [35.8, 37.6, "airliner"], A20N: [35.8, 37.6, "airliner"], A21N: [35.8, 44.5, "airliner"], A319: [35.8, 33.8, "airliner"],
  B738: [35.8, 39.5, "airliner"], B38M: [35.9, 39.5, "airliner"], BCS3: [35.1, 38.7, "airliner"],
  E190: [28.7, 36.2, "regional"], E195: [28.7, 38.7, "regional"], CRJ9: [24.9, 36.2, "regional"],
  AT76: [27.1, 27.2, "turboprop"], DH8D: [28.4, 32.8, "turboprop"],
  B77W: [64.8, 73.9, "widebody"], A359: [64.8, 66.8, "widebody"], B789: [60.1, 62.8, "widebody"], A333: [60.3, 63.7, "widebody"],
  C172: [11.0, 8.3, "ga"], PA28: [10.7, 7.3, "ga"], SR22: [11.7, 7.9, "ga"], DA40: [11.9, 8.1, "ga"],
  H145: [11.0, 13.6, "heli"], EC35: [10.2, 12.2, "heli"],
};
export const TYPE_MAKER ={ C172: "Cessna", PA28: "Piper", SR22: "Cirrus", DA40: "Diamond" };

// ---------- squawk allocation ----------
// Local code blocks by ICAO prefix (longest prefix wins). Ranges are octal codes as strings, inclusive.
export const SQUAWK_RANGES = {
  EE: [["4201", "4277"], ["4301", "4377"]],          // Estonia (local block, style of EETN 42xx)
  EF: [["4401", "4477"], ["5001", "5077"]], EV: [["3601", "3677"]], EY: [["3701", "3777"]],
  EG: [["4601", "4677"], ["7350", "7373"], ["5201", "5260"]], // UK ORCAM-like blocks
  EI: [["4401", "4477"]], ED: [["3301", "3377"], ["2601", "2677"]], EK: [["2101", "2177"]], ES: [["2401", "2477"]],
  EN: [["4501", "4577"]], LF: [["1001", "1077"], ["5701", "5777"]], EH: [["1501", "1577"]],
  K: [["0101", "0477"]], C: [["0101", "0477"]],      // US-style local ranges
  "": [["2001", "2077"], ["3401", "3477"], ["6101", "6177"]],
};
export const RESERVED_SQUAWKS = new Set(["7500", "7600", "7700", "7000", "2000", "1200", "0000", "7777", "1000", "2200", "0021", "0022"]);

// ---------- ATC positions ----------
export const POSITION_KEYS = ["DEL", "GND", "TWR", "APP", "CTR"];
export const POSITION_UNIT = { DEL: "Delivery", GND: "Ground", TWR: "Tower", APP: "Radar", CTR: "Control" };
export const POSITION_FALLBACK_MHZ = { DEL: 121.805, GND: 121.905, TWR: 118.105, APP: 119.405, CTR: 132.805 };
// FIR (centre) radio names by ICAO prefix
export const CTR_NAME = { EE: "Tallinn", EF: "Helsinki", EV: "Riga", EY: "Vilnius", EG: "London", EI: "Shannon",
  ED: "Langen", EK: "Copenhagen", ES: "Sweden", EN: "Norway", LF: "Paris", EH: "Amsterdam", LO: "Wien",
  LS: "Swiss", LE: "Madrid", LI: "Roma", EP: "Warszawa", OM: "Emirates", RJ: "Tokyo", YS: "Melbourne" };

// ICAO location prefix -> nationality of the airport's own staff (controllers, drivers)
export const COUNTRY_NAT = { EE: "EE", EF: "FI", EV: "LV", EY: "LT", ED: "DE", LF: "FR", EG: "GB", EI: "IE", ES: "SE", EN: "NO",
  EK: "DK", EP: "PL", LE: "ES", LI: "IT", EH: "NL", LT: "TR", LO: "AT", LS: "CH", EB: "BE", LK: "CZ", LH: "HU", LP: "PT",
  LR: "RO", OM: "AE", K: "US", C: "CA", Y: "AU", P: "US", Z: "CN", V: "IN", W: "SG", F: "ZA", N: "NZ" };
export const controllerNat = (icao) => COUNTRY_NAT[String(icao).slice(0, 2)] || COUNTRY_NAT[String(icao)[0]] || "GB";

export const rnd = (a) => a[Math.floor(Math.random() * a.length)];
export function weighted(list) {
  const tot = list.reduce((s, x) => s + x[1], 0);
  let r = Math.random() * tot;
  for (const x of list) { r -= x[1]; if (r < 0) return x[0]; }
  return list[list.length - 1][0];
}
export const rint = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));

export function distKm(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180;
  const a = Math.sin((lat2 - lat1) * r / 2) ** 2 +
    Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin((lon2 - lon1) * r / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(a));
}
