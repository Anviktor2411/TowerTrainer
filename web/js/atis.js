// ATIS: a METAR decoded into the spoken information, the way a real ATIS reads it.
// parseMetar() understands the common groups (wind, gusts, variable wind, visibility, RVR, present weather,
// clouds, CAVOK, temperature/dew point, QNH in hPa or inHg); buildAtis() turns it into the broadcast text.
import { LETTER_WORD } from "./data.js";

const WX = { RA: "rain", DZ: "drizzle", SN: "snow", SG: "snow grains", GR: "hail", GS: "small hail", PL: "ice pellets", FG: "fog",
  BR: "mist", HZ: "haze", FU: "smoke", DU: "dust", SA: "sand", TS: "thunderstorm", SH: "showers", FZ: "freezing", BC: "patches of",
  MI: "shallow", PR: "partial", BL: "blowing", DR: "drifting", VC: "in the vicinity", SQ: "squalls", PO: "dust devils", UP: "unknown precipitation" };
const CLOUD = { FEW: "few", SCT: "scattered", BKN: "broken", OVC: "overcast", VV: "vertical visibility", NSC: "no significant cloud", NCD: "no cloud detected" };

export function parseMetar(raw) {
  const m = { raw: raw || "", wind: null, vis: null, cavok: false, rvr: [], wx: [], clouds: [], temp: null, dew: null, qnh: null, qnhInHg: null, time: null, auto: false, remarks: "" };
  if (!raw) return m;
  const parts = raw.replace(/^(METAR|SPECI)\s+/, "").split(/\s+/);
  let i = 0;
  for (const p of parts) {
    i++;
    if (/^[A-Z]{4}$/.test(p) && i === 1) continue;
    if (/^\d{6}Z$/.test(p)) { m.time = p.slice(2, 6); continue; }
    if (p === "AUTO") { m.auto = true; continue; }
    let w;
    if ((w = p.match(/^(VRB|\d{3})(\d{2,3})(?:G(\d{2,3}))?(KT|MPS)$/))) {
      const k = w[4] === "MPS" ? 1.944 : 1;
      m.wind = { dir: w[1] === "VRB" ? null : +w[1], spd: Math.round(+w[2] * k), gust: w[3] ? Math.round(+w[3] * k) : null, vrb: w[1] === "VRB" };
      continue;
    }
    if ((w = p.match(/^(\d{3})V(\d{3})$/)) && m.wind) { m.wind.from = +w[1]; m.wind.to = +w[2]; continue; }
    if (p === "CAVOK") { m.cavok = true; m.vis = 10000; continue; }
    if (/^\d{4}(NDV)?$/.test(p) && m.vis == null) { m.vis = +p.slice(0, 4); continue; }
    if ((w = p.match(/^(\d{1,2})SM$/)) || (w = p.match(/^(\d)\/(\d)SM$/)) || (w = p.match(/^(\d) (\d)\/(\d)SM$/))) {
      m.vis = w.length === 2 ? Math.round(+w[1] * 1609) : w.length === 3 ? Math.round(+w[1] / +w[2] * 1609) : Math.round((+w[1] + +w[2] / +w[3]) * 1609);
      m.visSm = p; continue;
    }
    if ((w = p.match(/^R(\d{2}[LRC]?)\/([PM])?(\d{4})(?:V([PM])?(\d{4}))?([UDN])?$/))) { m.rvr.push({ rwy: w[1], m: +w[3], max: w[5] ? +w[5] : null, trend: w[6] || "" }); continue; }
    if ((w = p.match(/^(FEW|SCT|BKN|OVC|VV)(\d{3})(CB|TCU)?$/))) { m.clouds.push({ cover: w[1], ft: +w[2] * 100, cb: w[3] || "" }); continue; }
    if (p === "NSC" || p === "NCD" || p === "SKC" || p === "CLR") { m.clouds.push({ cover: p, ft: null }); continue; }
    if ((w = p.match(/^(M?\d{2})\/(M?\d{2})?$/))) { const f = (s) => (s ? (s.startsWith("M") ? -+s.slice(1) : +s) : null); m.temp = f(w[1]); m.dew = f(w[2]); continue; }
    if ((w = p.match(/^Q(\d{4})$/))) { m.qnh = +w[1]; continue; }
    if ((w = p.match(/^A(\d{4})$/))) { m.qnhInHg = +w[1] / 100; m.qnh = Math.round(+w[1] / 100 * 33.8639); continue; }
    if (p === "RMK") { m.remarks = parts.slice(i).join(" "); break; }
    if (p === "NOSIG" || p === "BECMG" || p === "TEMPO") { m.trend = (m.trend ? m.trend + " " : "") + p; continue; }
    if ((w = p.match(/^([-+]|VC)?((?:[A-Z]{2}){1,3})$/)) && !/^(RMK|NOSIG|AUTO|TEMPO|BECMG)$/.test(p)) {
      const codes = w[2].match(/[A-Z]{2}/g) || [];
      if (codes.every(c => WX[c])) m.wx.push({ int: w[1] || "", codes });
    }
  }
  return m;
}

export function wxWords(w) {
  const int = w.int === "-" ? "light " : w.int === "+" ? "heavy " : w.int === "VC" ? "" : "";
  const vic = w.int === "VC" ? " in the vicinity" : "";
  const desc = w.codes.filter(c => ["SH", "FZ", "BC", "MI", "PR", "BL", "DR", "TS"].includes(c));
  const phen = w.codes.filter(c => !desc.includes(c)).map(c => WX[c]);
  let s = phen.join(" and ");
  if (desc.includes("SH")) s = `${s ? s + " " : ""}showers`;
  if (desc.includes("TS")) s = `thunderstorm${s ? " with " + s : ""}`;
  for (const d of desc) if (!["SH", "TS"].includes(d)) s = `${WX[d]} ${s}`;
  return `${int}${s}${vic}`.trim();
}

/** Transition level from the transition altitude and the QNH (ICAO Doc 8168 style table). */
export function transitionLevel(taFt, qnh) {
  if (!taFt) return null;
  if (!qnh) return Math.round(taFt / 100) + 10;
  const base = Math.round(taFt / 100);
  if (qnh >= 1051) return base;
  if (qnh >= 1032) return base + 5;
  if (qnh >= 1013) return base + 10;
  if (qnh >= 995) return base + 15;
  if (qnh >= 977) return base + 20;
  return base + 25;
}

/** Transition altitude by region/country (feet). */
export function transitionAltitude(icao) {
  const p = String(icao || "").toUpperCase();
  const T = { EE: 5000, EF: 5000, EV: 5000, EY: 5000, ED: 5000, EH: 3000, EB: 4500, LF: 5000, EG: 6000, EI: 5000, EK: 5000, ES: 5000, EN: 7000,
    LS: 7000, LO: 10000, LE: 6000, LP: 4000, LI: 6000, EP: 6500, LK: 5000, LH: 10000, LT: 10000, OM: 13000, K: 18000, C: 18000, P: 18000, Y: 10000 };
  return T[p.slice(0, 2)] || T[p[0]] || 5000;
}

const sayVis = (m, region) => {
  if (m == null) return "";
  if (region === "US") return m >= 16000 ? "visibility 10 miles or more" : `visibility ${(m / 1609).toFixed(m < 1609 ? 1 : 0)} miles`;
  if (m >= 9999) return "visibility 10 kilometres or more";
  if (m >= 5000) return `visibility ${Math.round(m / 1000)} kilometres`;
  return `visibility ${m} metres`;
};
const sayCloud = (c) => c.ft == null ? CLOUD[c.cover] || c.cover : `${CLOUD[c.cover]} ${c.ft} feet${c.cb ? " " + (c.cb === "CB" ? "cumulonimbus" : "towering cumulus") : ""}`;

/**
 * Build the ATIS text.
 * p: { icao, name (radio name, e.g. "Tallinn"), letter ("B"), rwy ("26"), arrRwy?, metar (object or raw string), region ("ICAO"|"UK"|"US"),
 *      utc ("0920"), lvp?, approach? ("ILS"), remarks? [string] }
 */
export function buildAtis(p) {
  const m = typeof p.metar === "string" ? parseMetar(p.metar) : (p.metar || parseMetar(""));
  const L = LETTER_WORD[p.letter] ? LETTER_WORD[p.letter].replace(/^\w/, c => c.toUpperCase()) : p.letter;
  const us = p.region === "US";
  const time = p.utc || m.time || "";
  const parts = [];
  parts.push(us ? `${p.name} Airport information ${L}, ${time ? time + " Zulu" : ""}`.replace(/,\s*$/, "") : `This is ${p.name} ${us ? "Airport" : ""} information ${L}${time ? ", time " + time : ""}`.replace(/\s+/g, " "));
  const app = p.approach || "ILS";
  if (p.arrRwy && p.arrRwy !== p.rwy) parts.push(`Expect ${app} approach runway ${p.arrRwy}. Departure runway ${p.rwy}`);
  else parts.push(us ? `${app} approach in use runway ${p.rwy}. Departing runway ${p.rwy}` : `Expect ${app} approach runway ${p.rwy}. Runway in use ${p.rwy}`);
  if (p.lvp) parts.push("Low visibility procedures in operation");
  if (!us) { const tl = transitionLevel(transitionAltitude(p.icao), m.qnh); if (tl) parts.push(`Transition level ${tl}`); }
  if (m.wind) {
    let w = m.wind.vrb ? `Wind variable ${m.wind.spd} knots` : m.wind.spd === 0 ? "Wind calm" : `Wind ${String(m.wind.dir).padStart(3, "0")} degrees ${m.wind.spd} knots`;
    if (m.wind.gust) w += `, gusting ${m.wind.gust} knots`;
    if (m.wind.from != null) w += `, varying between ${String(m.wind.from).padStart(3, "0")} and ${String(m.wind.to).padStart(3, "0")} degrees`;
    parts.push(w);
  }
  if (m.cavok) parts.push("CAVOK");
  else {
    const v = sayVis(m.vis, p.region); if (v) parts.push(v.charAt(0).toUpperCase() + v.slice(1));
    for (const r of m.rvr) parts.push(`RVR runway ${r.rwy} ${r.m >= 2000 ? "more than 2000" : r.m} metres`);
    if (m.wx.length) parts.push(m.wx.map(wxWords).join(", ").replace(/^\w/, c => c.toUpperCase()));
    if (m.clouds.length) parts.push(m.clouds.map(sayCloud).join(", ").replace(/^\w/, c => c.toUpperCase()));
    else if (m.vis != null && !m.wx.length) parts.push("No significant cloud");
  }
  if (m.temp != null) parts.push(`Temperature ${m.temp < 0 ? "minus " : ""}${Math.abs(m.temp)}, dew point ${m.dew == null ? "not available" : (m.dew < 0 ? "minus " : "") + Math.abs(m.dew)}`);
  if (m.qnh) parts.push(us && m.qnhInHg ? `Altimeter ${String(Math.round(m.qnhInHg * 100)).split("").join(" ")}` : `QNH ${m.qnh}${m.qnh < 1000 ? "" : ""}`);
  for (const r of p.remarks || []) parts.push(r);
  parts.push(us ? `Advise on initial contact you have information ${L}` : `Acknowledge information ${L} on first contact`);
  return parts.filter(Boolean).join(". ") + ".";
}

/** Short summary for the header pill / panel. */
export function atisSummary(m) {
  if (!m) return "";
  const w = m.wind ? (m.wind.vrb ? `VRB${m.wind.spd}` : `${String(m.wind.dir).padStart(3, "0")}/${m.wind.spd}${m.wind.gust ? "G" + m.wind.gust : ""}`) : "—";
  const v = m.cavok ? "CAVOK" : m.vis == null ? "" : m.vis >= 9999 ? "10km+" : m.vis >= 1000 ? `${(m.vis / 1000).toFixed(m.vis % 1000 ? 1 : 0)}km` : `${m.vis}m`;
  return `${w} · ${v}${m.wx.length ? " · " + m.wx.map(x => x.int + x.codes.join("")).join(" ") : ""}${m.temp != null ? ` · ${m.temp}/${m.dew ?? "—"}` : ""}${m.qnh ? ` · Q${m.qnh}` : ""}`;
}
