// SID suggestions for Delivery and the AI controllers, from /api/procedures (CIFP / EuroScope / fallback).

const bearing = (lat1, lon1, lat2, lon2) => {
  const r = Math.PI / 180, p1 = lat1 * r, p2 = lat2 * r, dl = (lon2 - lon1) * r;
  const y = Math.sin(dl) * Math.cos(p2), x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (Math.atan2(y, x) / r + 360) % 360;
};
const angDiff = (a, b) => Math.abs(((b - a + 540) % 360) - 180);

export function runwayMatches(tag, rwy) {
  const t = String(tag).toUpperCase().replace(/^RW/, ""), r = String(rwy).toUpperCase();
  return t === r || (t.endsWith("B") && t.slice(0, 2) === r.slice(0, 2));
}

/**
 * Suggested departure for a flight.
 * procs: /api/procedures result; rwy: active runway; apt: {lat, lon, icao}; dest: [icao, name, lat, lon]
 * Returns { sid, climb, exit, generic, note }
 */
export function suggestSid(procs, rwy, apt, dest, region) {
  const fallbackClimb = region === "US" ? 5000 : 4000;
  const sids = (procs && procs.sids || []).filter(p => p.runways.some(r => runwayMatches(r, rwy)));
  const want = dest && dest[2] != null ? bearing(apt.lat, apt.lon, dest[2], dest[3]) : null;
  if (sids.length) {
    let best = sids[0], bd = Infinity;
    for (const p of sids) {
      const d = want != null && p.bearing != null ? angDiff(want, p.bearing) : 180;
      if (d < bd) { bd = d; best = p; }
    }
    return { sid: best.name, climb: best.climb || fallbackClimb, exit: best.exit, generic: false,
      note: procs.source && procs.source.label || "" };
  }
  // fallback: generic "<first fix> 1<letter>" style name when we know nothing, else radar vectors
  return { sid: null, climb: fallbackClimb, exit: null, generic: true,
    note: (procs && procs.source && procs.source.label) || "No procedures — radar vectors" };
}

/** Polylines for the radar: [{kind, name, pts:[[lat,lon],...], fixes:[{id,lat,lon}]}] for the active runway. */
export function procLines(procs, rwy) {
  const out = [];
  if (!procs) return out;
  for (const [kind, list] of [["sid", procs.sids || []], ["star", procs.stars || []]]) {
    for (const p of list) {
      if (kind === "sid" && !p.runways.some(r => runwayMatches(r, rwy))) continue;
      const rw = Object.entries(p.rwy || {}).find(([k]) => runwayMatches(k, rwy));
      const legs = kind === "sid" ? [...(rw ? rw[1] : []), ...p.common] : [...p.common, ...(rw ? rw[1] : [])];
      const pts = legs.filter(l => l.lat != null).map(l => ({ id: l.fix, lat: l.lat, lon: l.lon, alt: l.alt }));
      if (pts.length) out.push({ kind, name: p.name, pts });
    }
  }
  return out;
}

const routeTokens = (route) => String(route || "").toUpperCase().split(/\s+/).map(t => t.replace(/\/.*$/, "")).filter(Boolean);
const legsFor = (p, rwy, sid) => {
  const rw = Object.entries(p.rwy || {}).find(([k]) => runwayMatches(k, rwy));
  return sid ? [...(rw ? rw[1] : []), ...p.common] : [...p.common, ...(rw ? rw[1] : [])];
};

/** F4: the SID whose last fix is the first fix of the filed route ("LAKUT UL602 …" -> LAKUT1A), for runway `rwy`. */
export function sidByRoute(procs, rwy, route) {
  const toks = routeTokens(route);
  if (!toks.length || !procs) return null;
  const sids = (procs.sids || []).filter(p => p.runways.some(r => runwayMatches(r, rwy)));
  const named = sids.find(p => toks.includes(p.name));
  if (named) return named;
  for (const t of toks) {
    const hit = sids.find(p => p.exit === t);
    if (hit) return hit;
  }
  return null;
}

/**
 * F4: arrival suggestion from the real procedures: the STAR whose entry fix is on the route (else the one whose
 * entry is nearest the inbound bearing), and the approach to the runway (ILS first).
 * Returns { star, entry, app, appTitle, generic }
 */
export function suggestStar(procs, rwy, route, apt, from) {
  const stars = (procs && procs.stars || []);
  const toks = routeTokens(route);
  const usable = stars.filter(p => !p.runways.length || p.runways.some(r => runwayMatches(r, rwy)) || Object.keys(p.rwy || {}).length === 0);
  let star = usable.find(p => toks.includes(p.name)) || usable.find(p => p.common[0] && toks.includes(p.common[0].fix)) || null;
  if (!star && usable.length && from && from[2] != null && apt) {
    const want = bearing(apt.lat, apt.lon, from[2], from[3]);
    let bd = 400;
    for (const p of usable) {
      const e = p.common.find(l => l.lat != null);
      if (!e) continue;
      const d = angDiff(want, bearing(apt.lat, apt.lon, e.lat, e.lon));
      if (d < bd) { bd = d; star = p; }
    }
  }
  const apps = (procs && procs.apps || []).filter(p => p.runways.some(r => runwayMatches(r, rwy)));
  const app = apps.find(p => /^I/.test(p.name)) || apps.find(p => /^[RH]/.test(p.name)) || apps[0] || null;
  return { star: star ? star.name : null, entry: star && star.common[0] ? star.common[0].fix : null, app: app ? app.name : null,
    appTitle: app ? approachTitle(app.name) : "ILS", generic: !star };
}

export function approachTitle(name) {
  const m = /^([IRLVNDBGHJPQSTUX])(\d{2}[LRC]?)-?([A-Z])?$/.exec(String(name || ""));
  if (!m) return String(name || "");
  const k = { I: "ILS", R: "RNAV", L: "LOC", V: "VOR", N: "NDB", D: "VOR DME", B: "LOC back course", G: "IGS", H: "RNP", J: "GLS", P: "GPS", Q: "NDB DME", S: "VOR", T: "TACAN", X: "LDA", U: "SDF" }[m[1]];
  return `${k}${m[3] ? " " + m[3] : ""}`;
}

/** Legs with positions of a named SID / STAR for runway `rwy`: [{id, lat, lon, alt, desc}] */
export function procPoints(procs, kind, name, rwy) {
  const p = procs && (procs[kind === "sid" ? "sids" : "stars"] || []).find(x => x.name === name);
  if (!p) return [];
  return legsFor(p, rwy, kind === "sid").filter(l => l.lat != null).map(l => ({ id: l.fix, lat: l.lat, lon: l.lon, alt: l.alt, desc: l.desc }));
}
