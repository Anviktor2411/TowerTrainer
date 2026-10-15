// Coach mode: after each controller transmission, say what was good or missing, with the reference phrase.
// Texts in English and Estonian (radio phraseology itself always stays English).

const REF = {
  ICAO: { twr: "ICAO Doc 4444 ch. 12 (aerodrome control)", del: "ICAO Doc 4444 ch. 12 (ATC clearances)", gen: "ICAO Doc 4444 ch. 12 / Annex 10 vol. II" },
  UK: { twr: "CAP 413 ch. 4 (aerodrome)", del: "CAP 413 ch. 4 (departure clearance)", gen: "CAP 413 ch. 2 (general)" },
  US: { twr: "FAA JO 7110.65 ch. 3 (airport traffic control)", del: "FAA JO 7110.65 ch. 4 (IFR clearances)", gen: "FAA JO 7110.65 ch. 2 (general)" },
};

const T = {
  en: {
    noCallsign: "Callsign missing — start every transmission with the callsign.",
    notOnFreq: (cs, f) => `${cs} is not on your frequency (on ${f}). Nobody answered.`,
    takeoffRwy: "Runway not stated in the takeoff clearance.",
    landRwy: "Runway not stated in the landing clearance.",
    lineupRwy: "Runway not stated in the line-up instruction.",
    taxiLimit: "Taxi clearance should state the clearance limit (holding point / runway).",
    clrDest: "IFR clearance should contain the clearance limit (destination).",
    clrSq: "IFR clearance is missing a squawk.",
    clrAlt: "IFR clearance is missing the initial climb (altitude/level).",
    sqInUse: (c, who) => `Squawk ${c} is already in use by ${who}.`,
    sqReserved: (c) => `Squawk ${c} is a reserved/special code — never assign it.`,
    sqRange: (c) => `Squawk ${c} is outside the local code block; use "Assign squawk".`,
    rwyOccupied: (r) => `Runway ${r} is occupied — check before clearing.`,
    arrClose: (cs, nm) => `${cs} is on a ${nm} nm final — too close for a takeoff clearance.`,
    wrongPos: (what, who) => `${what} is normally ${who}'s job — hand the aircraft over.`,
    handDel: "Readback correct — now hand off to Ground (\"contact Ground …\").",
    handGnd: "Approaching the holding point — hand off to Tower.",
    handTwrDep: "Airborne — hand off to Approach/Departure.",
    handTwrArr: "Vacated — hand off to Ground.",
    handApp: "Inside 10 nm — hand off to Tower.",
    freqWrong: (f) => `Frequency ${f} does not belong to any position.`,
    atisOld: (l) => `The pilot reported an old ATIS — tell them information ${l} is current.`,
    unparsed: "Not understood as standard phraseology — the pilot will ask you to say again.",
    good: "Good: standard phraseology.",
    abbrevTooEarly: "Abbreviate a callsign only after the pilot has made first contact with you.",
    readyWaiting: (s) => `ready for ${s} s with the runway free — clear for takeoff or line up (ICAO 4444 §7.9).`,
    landLate: (nm) => `${nm} nm final without a landing clearance — clear to land or send around (ICAO 4444 §7.10).`,
    wakeWait: (cs, s) => `wake turbulence behind ${cs} (heavy): ${s} s more before a lighter departure (ICAO 4444 §5.8, 2 min).`,
    spacing: (cs, nm, need) => `${nm} nm behind ${cs}, ${need} nm needed — reduce speed or break off the approach.`,
    rwyBusy: (cs) => `${cs} still on the runway with the next landing close — expedite vacating or send around.`,
    planDest: (d) => `The filed plan goes to ${d} — the clearance limit should match the flight plan.`,
    planSid: (s) => `The OFP plans SID ${s}; a different departure is fine if it fits the runway, but say so clearly.`,
    planLevel: (l) => `Cleared above the filed cruise level (${l} ft) — the initial climb is normally below it.`,
    planOk: "Clearance matches the filed plan (destination, SID, level).",
  },
  et: {
    noCallsign: "Kutsung puudub — alusta iga saadet kutsungiga.",
    notOnFreq: (cs, f) => `${cs} ei ole sinu sagedusel (on ${f}). Keegi ei vastanud.`,
    takeoffRwy: "Õhkutõusuloas puudub rada.",
    landRwy: "Maandumisloas puudub rada.",
    lineupRwy: "Rajale sõidu korralduses puudub rada.",
    taxiLimit: "Ruleerimisloas peab olema loa piir (ooteala / rada).",
    clrDest: "IFR-loas peab olema loa piir (sihtkoht).",
    clrSq: "IFR-loas puudub transponderikood (squawk).",
    clrAlt: "IFR-loas puudub algne tõusukõrgus.",
    sqInUse: (c, who) => `Kood ${c} on juba kasutusel (${who}).`,
    sqReserved: (c) => `Kood ${c} on reserveeritud/erikood — seda ei anta.`,
    sqRange: (c) => `Kood ${c} on väljaspool kohalikku plokki; kasuta nuppu „Assign squawk“.`,
    rwyOccupied: (r) => `Rada ${r} on hõivatud — kontrolli enne luba.`,
    arrClose: (cs, nm) => `${cs} on ${nm} NM lõpplähenemisel — liiga lähedal õhkutõusuloaks.`,
    wrongPos: (what, who) => `${what} on tavaliselt ${who} töö — anna õhusõiduk üle.`,
    handDel: "Kordus õige — nüüd anna üle Groundile („contact Ground …“).",
    handGnd: "Läheneb ootealale — anna üle Towerile.",
    handTwrDep: "Õhus — anna üle Approachile/Departure'ile.",
    handTwrArr: "Rada vabastatud — anna üle Groundile.",
    handApp: "10 NM sees — anna üle Towerile.",
    freqWrong: (f) => `Sagedus ${f} ei kuulu ühelegi positsioonile.`,
    atisOld: (l) => `Piloot teatas vana ATIS-e — ütle, et kehtib informatsioon ${l}.`,
    unparsed: "Ei tundnud standardfraseoloogiat ära — piloot palub korrata.",
    good: "Hea: standardne fraseoloogia.",
    abbrevTooEarly: "Kutsungit lühenda alles pärast seda, kui piloot on sinuga esmase ühenduse võtnud.",
    readyWaiting: (s) => `valmis ${s} s, rada vaba — anna õhkutõusuluba või rajale sõidu korraldus (ICAO 4444 §7.9).`,
    landLate: (nm) => `${nm} NM lõpplähenemisel ilma maandumisloata — anna luba või saada kordusringile (ICAO 4444 §7.10).`,
    wakeWait: (cs, s) => `jälgturbulents ${cs} (heavy) järel: veel ${s} s enne kergema väljumist (ICAO 4444 §5.8, 2 min).`,
    spacing: (cs, nm, need) => `${nm} NM ${cs} taga, vaja ${need} NM — vähenda kiirust või katkesta lähenemine.`,
    rwyBusy: (cs) => `${cs} on veel rajal ja järgmine maanduja lähedal — kiirenda vabastamist või saada kordusringile.`,
    planDest: (d) => `Esitatud plaan läheb ${d} — loa piir peab plaaniga klappima.`,
    planSid: (s) => `OFP-s on SID ${s}; teine väljumine sobib, kui see on selle raja oma, aga ütle see selgelt.`,
    planLevel: (l) => `Luba on üle esitatud reisilennutasandi (${l} ft) — algne tõus on tavaliselt sellest madalamal.`,
    planOk: "Luba klapib esitatud plaaniga (sihtkoht, SID, tasand).",
  },
};

const POS_JOB = { push: "GND", taxi: "GND", taxiStand: "GND", cross: "GND", clearance: "DEL", takeoff: "TWR", land: "TWR", lineup: "TWR" };
const POS_NAME = { DEL: "Delivery", GND: "Ground", TWR: "Tower", APP: "Approach", CTR: "Centre" };

/**
 * Notes for one transmission.
 *  {text, parsed:{ac, explicit, ins, normalized}, sim, pos, lang}
 * Returns [{level: "good"|"warn"|"info", msg, ref}]
 */
export function coach({ text, parsed, sim, pos, lang = "en" }) {
  const L = T[lang] || T.en;
  const ref = REF[sim.region] || REF.ICAO;
  const out = [];
  const warn = (msg, r = ref.gen) => out.push({ level: "warn", msg, ref: r });
  const info = (msg, r = ref.gen) => out.push({ level: "info", msg, ref: r });
  const { ac, explicit, ins } = parsed;
  const s = parsed.normalized || "";
  if (!explicit) warn(L.noCallsign, ref.gen);
  if (!ac) return out;
  if (sim.split && pos && pos !== "ALL" && !sim.hears(ac, pos)) {
    warn(L.notOnFreq(ac.cs, ac.freq === "LOST" ? "?" : sim.positions[ac.freq] ? `${sim.positions[ac.freq].unit} ${sim.positions[ac.freq].freq}` : ac.freq));
    return out;
  }
  if (!ins.length && !/\b(negative|correction|affirm|roger|standby|say again)\b/.test(s)) { warn(L.unparsed); return out; }
  for (const i of ins) {
    if (i.t === "takeoff" && !i.rwy) warn(L.takeoffRwy, ref.twr);
    if (i.t === "land" && !i.rwy) warn(L.landRwy, ref.twr);
    if (i.t === "lineup" && !i.rwy) warn(L.lineupRwy, ref.twr);
    if (i.t === "taxi" && !i.rwy && !/holding point/.test(s)) warn(L.taxiLimit, ref.twr);
    if (i.t === "clearance") {
      if (ac.plan) {   // S2: the clearance against the pilot's filed (SimBrief) plan
        const pd = (ac.plan.destination || {}).icao || "", ps = ac.plan.sid || "", pl = ac.plan.initial_alt_ft || 0;
        let fine = true;
        if (i.dest && pd && String(i.dest).toUpperCase() !== pd && !String(ac.other && ac.other[1] || "").toLowerCase().startsWith(String(i.dest).toLowerCase())) { warn(L.planDest(pd), ref.del); fine = false; }
        if (i.sid && ps && i.sid !== "flight planned route" && String(i.sid).toUpperCase().replace(/ DEPARTURE$/, "") !== ps.toUpperCase()) { info(L.planSid(ps), ref.del); fine = false; }
        const clearedFt = (() => { const m = String(i.alt || "").match(/flight level (\d+)/); if (m) return +m[1] * 100; const n = parseInt(String(i.alt || ""), 10); return isNaN(n) ? 0 : n; })();
        if (clearedFt && pl && clearedFt > pl) { warn(L.planLevel(pl), ref.del); fine = false; }
        if (fine && i.dest) info(L.planOk, ref.del);
      }
      if (!i.dest) warn(L.clrDest, ref.del);
      if (!i.squawk) warn(L.clrSq, ref.del);
      if (!i.alt) warn(L.clrAlt, ref.del);
    }
    const code = i.squawk || i.code;
    if (code && (i.t === "clearance" || i.t === "squawk")) {
      const user = sim.ac.find(o => o !== ac && (o.assignedSq === code || o.squawk === code));
      if (sim.squawks.isReserved(code)) warn(L.sqReserved(code), ref.gen);
      else if (user) warn(L.sqInUse(code, user.cs), ref.gen);
      else if (!sim.squawks.codes().includes(code)) info(L.sqRange(code), ref.gen);
    }
    if (i.t === "takeoff" || i.t === "lineup") {
      const e = ac.depEnd || sim.depEnd;
      if (i.t === "takeoff" && !sim.runwayFree(e.rwy, ac)) warn(L.rwyOccupied(e.name), ref.twr);
      if (i.t === "takeoff") {
        const near = sim.ac.find(o => o.kind === "arr" && o.state === "final" && o.end && o.end.rwy === e.rwy && sim.distToThr(o) < 2 * 1852);
        if (near) warn(L.arrClose(near.cs, (sim.distToThr(near) / 1852).toFixed(1)), ref.twr);
      }
    }
    if (i.t === "land" && ac.end && !sim.runwayFree(ac.end.rwy, ac)) warn(L.rwyOccupied(ac.end.name), ref.twr);
    if (i.t === "contact" && i.freq && sim.split && !Object.values(sim.positions).some(p => Math.abs(p.mhz - parseFloat(i.freq)) < 0.003))
      warn(L.freqWrong(i.freq), ref.gen);
    if (sim.split && pos && pos !== "ALL" && POS_JOB[i.t] && POS_JOB[i.t] !== pos && sim.positions[POS_JOB[i.t]])
      info(L.wrongPos(i.t, POS_NAME[POS_JOB[i.t]]), ref.gen);
  }
  if (ac.atisReported && !ins.some(i => i.t === "atis")) info(L.atisOld(sim.atis()), ref.gen);
  // what to do next (handoffs)
  if (sim.split && pos && pos !== "ALL") {
    const has = (k) => !!sim.positions[k];
    const told = ins.some(i => i.t === "contact");
    if (!told) {
      if (pos === "DEL" && ins.some(i => i.t === "clearance") && has("GND") && !/contact/.test(s)) info(L.handDel, ref.del);
      if (pos === "TWR" && ac.kind === "dep" && !ac.onGround && has("APP")) info(L.handTwrDep, ref.twr);
      if (pos === "TWR" && ac.kind === "arr" && ac.state === "vacated" && has("GND")) info(L.handTwrArr, ref.twr);
    }
  }
  if (!out.some(o => o.level === "warn")) out.unshift({ level: "good", msg: L.good, ref: "" });
  return out;
}

/** Proactive hints between transmissions (handoff due, etc.). */
export function coachHints(sim, lang = "en") {
  const L = T[lang] || T.en;
  const out = [];
  if (!sim.split) return out;
  for (const a of sim.ac) {
    if (!sim.userWorks(a.freq)) continue;
    if (a.freq === "GND" && a.kind === "dep" && a.state === "taxi" && a.distToStop < 250 && sim.positions.TWR) out.push({ ac: a, msg: L.handGnd });
    if (a.freq === "TWR" && a.kind === "dep" && a.state === "airborne" && a.alt > 1000 && sim.positions.APP) out.push({ ac: a, msg: L.handTwrDep });
    if (a.freq === "TWR" && a.kind === "arr" && a.state === "vacated" && sim.positions.GND) out.push({ ac: a, msg: L.handTwrArr });
    if (a.freq === "APP" && a.kind === "arr" && a.state === "final" && sim.distToThr(a) < 10 * 1852 && sim.positions.TWR) out.push({ ac: a, msg: L.handApp });
  }
  return out.concat(timingHints(sim, lang));
}

/** Timing and separation (G2): a ready departure waiting with a free runway, a late landing clearance,
 *  wake turbulence behind a heavy, arrival spacing on final, a runway not vacated before the next landing. */
export function timingHints(sim, lang = "en") {
  const L = T[lang] || T.en;
  const out = [];
  const NM = 1852;
  const works = (a) => !sim.split || sim.userWorks(a.freq);
  const heavy = (w) => w === "H" || w === "J";
  for (const a of sim.ac) {
    if (!works(a)) continue;
    if (a.kind === "dep" && a.state === "holding" && a.holdAt != null && !a.toClr && !a.cond) {
      const wait = sim.t - a.holdAt, rwy = (a.depEnd || sim.depEnd).rwy;
      const short = sim.ac.some(o => o.kind === "arr" && o.state === "final" && o.end && o.end.rwy === rwy && sim.distToThr(o) < 4 * NM);
      const wake = sim.lastTakeoff && heavy(sim.lastTakeoff.wtc) && !heavy(a.wtc) && sim.t - sim.lastTakeoff.t < 120;
      if (wait > 60 && sim.runwayFree(rwy, a) && !short && !wake && !sim.closedRunways.has(rwy)) out.push({ ac: a, msg: L.readyWaiting(Math.round(wait)) });
    }
    if (a.kind === "arr" && a.state === "final" && !a.landClr && !a.nordo && !a.landAfter) {
      const d = sim.distToThr(a) / NM;
      if (d < 4 && d > 0.3) out.push({ ac: a, msg: L.landLate(d.toFixed(1)) });
    }
  }
  const lt = sim.lastTakeoff;
  if (lt && heavy(lt.wtc) && sim.t - lt.t < 120) {
    const next = sim.ac.find(a => a.kind === "dep" && ["holding", "lineup", "lining", "lined_up"].includes(a.state) && (a.depEnd || sim.depEnd).rwy === lt.rwy && !heavy(a.wtc) && works(a));
    if (next) out.push({ ac: next, msg: L.wakeWait(lt.cs, Math.round(120 - (sim.t - lt.t))) });
  }
  const finals = sim.ac.filter(a => a.kind === "arr" && a.state === "final" && a.end).sort((p, q) => sim.distToThr(p) - sim.distToThr(q));
  for (let i = 1; i < finals.length; i++) {
    const a = finals[i], b = finals[i - 1];
    if (a.end.rwy !== b.end.rwy || !works(a)) continue;
    const gap = (sim.distToThr(a) - sim.distToThr(b)) / NM;
    const need = heavy(b.wtc) ? (heavy(a.wtc) ? 4 : 5) : 3;
    if (gap < need - 0.3 && gap > 0) out.push({ ac: a, msg: L.spacing(b.cs, gap.toFixed(1), need) });
  }
  for (const b of finals) {
    if (sim.distToThr(b) > 2 * NM || !works(b)) continue;
    const occ = sim.ac.find(o => o !== b && o.onGround && (o.state === "rollout" || o.state === "vacating") && o.end && o.end.rwy === b.end.rwy);
    if (occ) out.push({ ac: occ, msg: L.rwyBusy(occ.cs) });
  }
  return out;
}

export const COACH_TEXT = T;
