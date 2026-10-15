// Learning content (G1): scenarios, the career path and session statistics.
// A scenario is a plain object the editor can change; the built-in ones form the career path. Everything the
// user makes or achieves lives in localStorage (tt.scenarios, tt.career, tt.history) and can be exported.

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};

/** The career path: Delivery → Ground → Tower → operations → Approach → everything combined. */
export const BUILTIN = [
  { id: "del-first", level: 1, name: "Delivery: first clearances", nameEt: "Delivery: esimesed load", staff: ["DEL"], dep: 10, arr: 0, vfr: 0, minutes: 15,
    goals: { score: 80, missedRb: 1 }, intro: "Give IFR clearances: destination, SID or heading, initial climb, squawk. Catch the wrong readbacks.", introEt: "Anna IFR-lube: sihtkoht, SID või kurss, algne tõus, squawk. Püüa valed kordused kinni." },
  { id: "gnd-push", level: 2, name: "Ground: push and taxi", nameEt: "Ground: tagasilükkamine ja ruleerimine", staff: ["GND"], dep: 10, arr: 8, vfr: 0, minutes: 20,
    goals: { score: 80, conflicts: 0 }, intro: "Pushback, taxi via named taxiways, hold short, give way, hand off to Tower at the holding point.", introEt: "Tagasilükkamine, ruleerimine nimeliste ruleerimisteede kaudu, oota enne rada, anna teed, anna Towerile üle ootealal." },
  { id: "twr-quiet", level: 3, name: "Tower: a quiet hour", nameEt: "Tower: vaikne tund", staff: ["TWR"], dep: 8, arr: 6, vfr: 1, minutes: 25,
    goals: { score: 80, missedRb: 2, goArounds: 1 }, intro: "Line up, takeoff and landing clearances, runway occupancy, wake turbulence.", introEt: "Rajale sõidu, õhkutõusu ja maandumise load, raja hõivatus, jälgturbulents." },
  { id: "twr-rush", level: 3, name: "Tower: evening rush", nameEt: "Tower: õhtune tipptund", staff: ["TWR"], dep: 18, arr: 16, vfr: 2, minutes: 30,
    goals: { score: 75, conflicts: 0 }, intro: "Keep the runway moving: conditional line-ups, land-after, sequencing departures between arrivals.", introEt: "Hoia rada liikumas: tingimuslikud rajale sõidud, land after, väljumised saabujate vahele." },
  { id: "twr-lvp", level: 4, name: "Tower: fog and LVP", nameEt: "Tower: udu ja LVP", staff: ["TWR", "GND"], dep: 10, arr: 10, vfr: 0, wx: "fog", lvp: true, minutes: 30,
    goals: { score: 75, conflicts: 0 }, intro: "Low visibility procedures: stop bars, CAT II/III holding points, one movement at a time.", introEt: "Halva nähtavuse protseduurid: stop barid, CAT II/III ootealad, üks liikumine korraga." },
  { id: "twr-wind", level: 4, name: "Runway change in a gale", nameEt: "Raja vahetus tormituulega", staff: ["TWR", "GND"], dep: 10, arr: 10, vfr: 0, wx: "veer", minutes: 30,
    goals: { score: 75 }, intro: "The wind veers: pilots refuse the tailwind, change the runway in use and re-sequence everybody.", introEt: "Tuul pöördub: piloodid keelduvad taganttuulest, vaheta kasutatav rada ja järjesta kõik ümber." },
  { id: "twr-abnormal", level: 5, name: "Tower: when things go wrong", nameEt: "Tower: kui asjad lähevad viltu", staff: ["TWR"], dep: 10, arr: 10, vfr: 1, abnormals: true, abnormalRate: 6, minutes: 30,
    goals: { score: 70 }, intro: "Emergencies, radio failures, rejected takeoffs, FOD and bird strikes — follow the checklists.", introEt: "Hädaolukorrad, raadiorikked, katkestatud õhkutõusud, FOD ja linnutabamused — järgi kontroll-lehti." },
  { id: "app-seq", level: 5, name: "Approach: sequencing", nameEt: "Approach: järjestamine", staff: ["APP"], dep: 6, arr: 14, vfr: 0, minutes: 30,
    goals: { score: 75, goArounds: 0 }, intro: "Vectors, descents and speeds to build 3–5 nm spacing on final, then hand off to Tower.", introEt: "Kursid, laskumised ja kiirused, et saada lõpplähenemisel 3–5 NM vahed, siis anna Towerile üle." },
  { id: "combined-all", level: 6, name: "Everything at once", nameEt: "Kõik korraga", staff: "combined", dep: 14, arr: 12, vfr: 3, abnormals: true, abnormalRate: 3, minutes: 40,
    goals: { score: 75, conflicts: 0 }, intro: "Delivery, Ground and Tower on one frequency with vehicles, VFR and the odd emergency.", introEt: "Delivery, Ground ja Tower ühel sagedusel koos sõidukite, VFR-i ja mõne hädaolukorraga." },
];

export const WX_CHOICES = ["live", "veer", "gusts", "fog", "snow"];

export function userScenarios() { return store.get("tt.scenarios", []); }
export function allScenarios() { return [...BUILTIN, ...userScenarios()]; }
export function findScenario(id) { return allScenarios().find(s => s.id === id) || null; }
export function saveScenario(s) {
  const list = userScenarios().filter(x => x.id !== s.id);
  list.push(s); store.set("tt.scenarios", list); return s;
}
export function deleteScenario(id) { store.set("tt.scenarios", userScenarios().filter(x => x.id !== id)); }
export function exportScenarios() { return JSON.stringify({ towertrainer: "scenarios", v: 1, scenarios: userScenarios() }, null, 2); }
export function importScenarios(text) {
  const j = JSON.parse(text);
  const list = Array.isArray(j) ? j : j.scenarios;
  if (!Array.isArray(list)) throw new Error("not a scenario file");
  let n = 0;
  for (const s of list) { if (s && s.id && s.name) { saveScenario(normalize({ ...s, id: BUILTIN.some(b => b.id === s.id) ? s.id + "-copy" : s.id })); n++; } }
  return n;
}
/** A clean scenario object from the editor's form values. */
export function normalize(s) {
  const n = (v, d) => (isFinite(+v) ? +v : d);
  const staff = s.staff === "combined" || !s.staff ? "combined" : (Array.isArray(s.staff) ? s.staff : String(s.staff).split(/[ ,]+/)).map(k => k.toUpperCase()).filter(k => ["DEL", "GND", "TWR", "APP", "CTR"].includes(k));
  return { id: String(s.id || "s" + Date.now()).replace(/[^a-z0-9-]/gi, "").toLowerCase(), level: n(s.level, 0), name: String(s.name || "Scenario").slice(0, 60), nameEt: s.nameEt ? String(s.nameEt).slice(0, 60) : "",
    icao: s.icao ? String(s.icao).toUpperCase().slice(0, 4) : "", rwy: s.rwy ? String(s.rwy).toUpperCase() : "", staff: staff.length ? staff : "combined",
    dep: n(s.dep, 10), arr: n(s.arr, 8), vfr: n(s.vfr, 0), wx: WX_CHOICES.includes(s.wx) ? s.wx : "live", lvp: !!s.lvp, abnormals: !!s.abnormals, abnormalRate: n(s.abnormalRate, 2),
    minutes: Math.max(5, n(s.minutes, 20)), goals: { score: n(s.goals && s.goals.score, 75), missedRb: s.goals && s.goals.missedRb != null ? n(s.goals.missedRb, 99) : null, conflicts: s.goals && s.goals.conflicts != null ? n(s.goals.conflicts, 99) : null, goArounds: s.goals && s.goals.goArounds != null ? n(s.goals.goArounds, 99) : null },
    intro: String(s.intro || "").slice(0, 300), introEt: String(s.introEt || "").slice(0, 300), user: !BUILTIN.some(b => b.id === s.id) };
}

/** The settings patch that starts a scenario (the caller loads the airport and creates the sim). */
export function scenarioSettings(s) {
  return { staff: s.staff === "combined" ? { mode: "combined", keys: ["TWR"] } : { mode: "split", keys: s.staff }, dep: s.dep, arr: s.arr, vfr: s.vfr, wx: s.wx || "live",
    lvp: !!s.lvp, abnormals: !!s.abnormals, abnormalRate: s.abnormalRate || 2 };
}

/** Pass / fail against the goals. stats = sim.stats, score = overall phraseology score 0..100. */
export function evaluate(s, stats, score, lang = "en") {
  const g = s.goals || {}, L = lang === "et";
  const reasons = [];
  if (g.score != null && score < g.score) reasons.push(L ? `fraseoloogia skoor ${score} < ${g.score}` : `phraseology score ${score} < ${g.score}`);
  if (g.missedRb != null && stats.missedRb > g.missedRb) reasons.push(L ? `märkamata kordusvigu ${stats.missedRb} > ${g.missedRb}` : `missed readback errors ${stats.missedRb} > ${g.missedRb}`);
  if (g.conflicts != null && stats.conflicts > g.conflicts) reasons.push(L ? `konflikte ${stats.conflicts} > ${g.conflicts}` : `conflicts ${stats.conflicts} > ${g.conflicts}`);
  if (g.goArounds != null && stats.goArounds > g.goArounds) reasons.push(L ? `kordusringe ${stats.goArounds} > ${g.goArounds}` : `go-arounds ${stats.goArounds} > ${g.goArounds}`);
  return { passed: reasons.length === 0, reasons };
}

export function career() { return store.get("tt.career", { passed: {} }); }
export function recordResult(s, result) {
  const c = career();
  const prev = c.passed[s.id];
  if (result.passed && (!prev || prev.score < result.score)) c.passed[s.id] = { score: result.score, date: new Date().toISOString().slice(0, 10) };
  c.last = { id: s.id, passed: result.passed, score: result.score, date: new Date().toISOString().slice(0, 10) };
  store.set("tt.career", c);
  return c;
}
/** Levels unlock one at a time: level n is open when something of level n-1 was passed. */
export function levelOpen(level) {
  if (level <= 1) return true;
  const c = career();
  return BUILTIN.some(b => b.level === level - 1 && c.passed[b.id]);
}

export function history() { return store.get("tt.history", []); }
export function addHistory(rec) {
  const h = history(); h.push(rec);
  while (h.length > 200) h.shift();
  store.set("tt.history", h); return h;
}
/** Overall phraseology score from the per-position coach counters. */
export function overallScore(coachStats) {
  let tx = 0, warn = 0;
  for (const v of Object.values(coachStats || {})) { tx += v.tx; warn += v.warn; }
  return tx ? Math.max(0, Math.round(100 * (1 - warn / (tx + warn)))) : 100;
}
/** A tiny inline SVG line of the last scores (no library). */
export function sparkline(values, w = 220, h = 44) {
  if (!values.length) return "";
  const n = values.length, pts = values.map((v, i) => [n === 1 ? w / 2 : (i / (n - 1)) * (w - 6) + 3, h - 3 - (Math.max(0, Math.min(100, v)) / 100) * (h - 6)]);
  const d = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><line x1="3" y1="${h - 3 - 0.75 * (h - 6)}" x2="${w - 3}" y2="${h - 3 - 0.75 * (h - 6)}" stroke="#2f6b45" stroke-dasharray="3 3"/><path d="${d}" fill="none" stroke="#7fd48a" stroke-width="1.5"/>${pts.map(p => `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="2" fill="#7fd48a"/>`).join("")}</svg>`;
}
