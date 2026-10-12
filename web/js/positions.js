// ATC positions of an airport: frequency, login callsign and radio name for DEL/GND/TWR/APP/CTR.
import { POSITION_KEYS, POSITION_UNIT, POSITION_FALLBACK_MHZ, CTR_NAME } from "./data.js";

const KIND = { DEL: "delivery", GND: "ground", TWR: "tower", APP: "approach", CTR: null };

export const fmtFreq = (mhz) => mhz.toFixed(3).replace(/(\.\d\d[1-9]?)0*$/, "$1");

/** Build the position table. staffing: Set of keys the user works ("ALL" = combined, legacy). */
export function buildPositions(apt) {
  const used = new Set();
  const out = {};
  for (const k of POSITION_KEYS) {
    let mhz = null, radioName = null;
    const kind = KIND[k];
    const f = kind && apt.freq[kind];
    if (f && !used.has(f.mhz)) mhz = f.mhz;
    if (k === "APP") {
      const dep = apt.d.freqs.find(x => x.kind === "departure");
      if (!mhz && dep) mhz = dep.mhz;
      const nm = (f || dep || {}).name || "";
      radioName = /director|approach|radar|departure/i.test(nm) && /^[A-Za-z]+/.test(nm)
        ? nm.replace(/\s*\d+$/, "").replace(/\b(app|dep)\b/i, "Radar") : `${apt.callName} ${POSITION_UNIT.APP}`;
    }
    if (!mhz || used.has(mhz)) {
      mhz = POSITION_FALLBACK_MHZ[k];
      while ([...used].some(u => Math.abs(u - mhz) < 0.004)) mhz += 0.025;
    }
    used.add(mhz);
    const pre = apt.icao.slice(0, 2);
    const ctrName = CTR_NAME[pre] || CTR_NAME[apt.icao[0]] || apt.callName;
    if (!radioName) radioName = k === "CTR" ? `${ctrName} ${apt.icao[0] === "K" ? "Center" : "Control"}` : `${apt.callName} ${POSITION_UNIT[k]}`;
    out[k] = {
      key: k, mhz, freq: fmtFreq(mhz), name: radioName, unit: POSITION_UNIT[k],
      cs: k === "CTR" ? `${pre}_CTR` : `${apt.icao}_${k}`,
    };
  }
  return out;
}

/** Map spoken unit/frequency in "contact X 123.45" to a position key. */
export function positionFor(unit, freq, positions) {
  if (freq) {
    const f = parseFloat(freq);
    for (const p of Object.values(positions)) if (Math.abs(p.mhz - f) < 0.003) return { key: p.key, exact: true };
  }
  const u = String(unit || "").toLowerCase();
  if (/deliver|clearance/.test(u)) return { key: "DEL" };
  if (/ground|apron|ramp/.test(u)) return { key: "GND" };
  if (/tower/.test(u)) return { key: "TWR" };
  if (/radar|approach|departure|director|arrival/.test(u)) return { key: "APP" };
  if (/control|center|centre/.test(u)) return { key: "CTR" };
  return null;
}
