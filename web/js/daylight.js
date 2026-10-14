// Sun position for day/night on the map: a compact NOAA-style solar elevation, good to a degree or so.

/** Solar elevation angle in degrees at (lat, lon) for a UTC timestamp (ms). */
export function sunElevation(lat, lon, utcMs) {
  const d = new Date(utcMs);
  const dayOfYear = Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(d.getUTCFullYear(), 0, 0)) / 86400000);
  const hours = d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600;
  const g = 2 * Math.PI / 365 * (dayOfYear - 1 + (hours - 12) / 24);
  const eqTime = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  const tst = (hours * 60 + eqTime + 4 * lon) % 1440;
  const ha = (tst / 4 < 0 ? tst / 4 + 180 : tst / 4 - 180) * Math.PI / 180;
  const latR = lat * Math.PI / 180;
  const cosZ = Math.sin(latR) * Math.sin(decl) + Math.cos(latR) * Math.cos(decl) * Math.cos(ha);
  return 90 - Math.acos(Math.max(-1, Math.min(1, cosZ))) * 180 / Math.PI;
}

/** "day" | "dusk" | "night" (civil twilight at -6°). */
export function daylight(lat, lon, utcMs) {
  const e = sunElevation(lat, lon, utcMs);
  return e > 0 ? "day" : e > -6 ? "dusk" : "night";
}
