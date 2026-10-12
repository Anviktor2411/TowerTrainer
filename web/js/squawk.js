// Squawk (SSR code) allocation: local code blocks per country, never reserved/emergency codes or
// codes in use, and a released code is not reused for ~10 minutes.
import { SQUAWK_RANGES, RESERVED_SQUAWKS } from "./data.js";

const oct = (s) => parseInt(s, 8);
const str = (n) => n.toString(8).padStart(4, "0");
export const validCode = (c) => /^[0-7]{4}$/.test(String(c));

export function rangesFor(icao) {
  icao = String(icao || "").toUpperCase();
  for (const len of [4, 3, 2, 1]) {
    const r = SQUAWK_RANGES[icao.slice(0, len)];
    if (r) return r;
  }
  return SQUAWK_RANGES[""];
}

export class SquawkAllocator {
  constructor(icao, { reuseDelay = 600 } = {}) {
    this.ranges = rangesFor(icao);
    this.inUse = new Set();
    this.released = new Map(); // code -> time released
    this.reuseDelay = reuseDelay;
    this.cursor = 0;
  }

  codes() {
    const out = [];
    for (const [a, b] of this.ranges) for (let n = oct(a); n <= oct(b); n++) out.push(str(n));
    return out;
  }

  isReserved(code) { return RESERVED_SQUAWKS.has(code) || /^(75|76|77)00$/.test(code) || code.endsWith("00") && code !== "0100"; }

  available(code, now) {
    if (!validCode(code) || this.isReserved(code) || this.inUse.has(code)) return false;
    const r = this.released.get(code);
    return r === undefined || now - r >= this.reuseDelay;
  }

  /** Next free code (round-robin through the local blocks). Does not reserve it. */
  peek(now = 0) {
    const all = this.codes();
    for (let i = 0; i < all.length; i++) {
      const c = all[(this.cursor + i) % all.length];
      if (this.available(c, now)) return c;
    }
    return null;
  }

  /** Allocate and mark in use. */
  next(now = 0) {
    const c = this.peek(now);
    if (c) { this.take(c); this.cursor = (this.codes().indexOf(c) + 1) % this.codes().length; }
    return c;
  }

  take(code) { if (validCode(code)) { this.inUse.add(code); this.released.delete(code); } }

  release(code, now = 0) {
    if (this.inUse.delete(code)) this.released.set(code, now);
  }
}
