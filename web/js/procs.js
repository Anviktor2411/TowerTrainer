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
