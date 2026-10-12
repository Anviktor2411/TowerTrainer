// Airport model built from the server's parsed apt.dat: runways, taxi graph, routing.

export const KT = 0.514444;
export const FT = 0.3048;

export const hdgOf = (dx, dy) => (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360;
export const angDiff = (a, b) => { let d = (b - a + 540) % 360 - 180; return d; };
export const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
export const vecFromHdg = (h) => [Math.sin(h * Math.PI / 180), Math.cos(h * Math.PI / 180)];

export class Airport {
  constructor(d) {
    this.d = d;
    this.icao = d.icao;
    this.name = d.name;
    this.stands = d.stands;
    this.nodes = d.nodes;

    // --- runways ---
    this.runways = d.runways.map((r, i) => {
      const [e0, e1] = r.ends;
      const len = dist(e0.pos, e1.pos);
      const mk = (a, b) => {
        const hdg = hdgOf(b.pos[0] - a.pos[0], b.pos[1] - a.pos[1]);
        const v = vecFromHdg(hdg);
        return { name: a.name, pos: a.pos, hdg, v, rwy: i, displaced: a.displaced,
          thr: [a.pos[0] + v[0] * a.displaced, a.pos[1] + v[1] * a.displaced], far: b.pos };
      };
      return { id: i, width: r.width, len, ends: [mk(e0, e1), mk(e1, e0)], label: `${e0.name}/${e1.name}` };
    });
    this.rwyEnd = {};
    for (const r of this.runways) for (const e of r.ends) this.rwyEnd[e.name.toUpperCase()] = e;

    // --- taxi graph ---
    this.adj = this.nodes.map(() => []);
    this.edges = d.edges.map((e, i) => {
      const zones = new Set();
      for (const k of ["departure", "arrival"]) for (const n of (e.zones[k] || [])) {
        const re = this.rwyEnd[n.toUpperCase()]; if (re) zones.add(re.rwy);
      }
      let rwy = -1;
      if (e.runway) {
        for (const n of e.name.split("/")) { const re = this.rwyEnd[n.trim().toUpperCase()]; if (re) rwy = re.rwy; }
        if (rwy < 0) rwy = this.nearestRunway(this.nodes[e.a]);
        if (rwy >= 0) zones.add(rwy);
      }
      // ignore zone tags for runways that are far from this edge (data often tags whole areas)
      for (const r of [...zones]) {
        const R = this.runways[r];
        if (Math.min(this.distToRunway(this.nodes[e.a], R), this.distToRunway(this.nodes[e.b], R)) > R.width / 2 + 180) zones.delete(r);
      }
      const ed = { i, a: e.a, b: e.b, oneway: e.oneway, runway: e.runway, rwy, name: e.name.toUpperCase(),
        zones, len: dist(this.nodes[e.a], this.nodes[e.b]) };
      this.adj[e.a].push({ to: e.b, e: ed });
      // one-way flags in Gateway data are often wrong: allow reverse travel, but at a high cost
      this.adj[e.b].push({ to: e.a, e: ed, rev: e.oneway });
      return ed;
    });
    this.taxiNames = new Set(this.edges.filter(e => e.name && !e.runway).map(e => e.name));
    // nodes that sit on a runway edge, per runway
    this.rwyNodes = this.runways.map(() => new Set());
    for (const e of this.edges) if (e.runway && e.rwy >= 0) { this.rwyNodes[e.rwy].add(e.a); this.rwyNodes[e.rwy].add(e.b); }

    this.freq = {};
    for (const f of d.freqs) if (!this.freq[f.kind]) this.freq[f.kind] = f;
    this.callName = Airport.unitName(d);
  }

  /** Radio name of the airport\'s ATC units: "Heathrow" (Tower), from frequency names, else the city. */
  static unitName(d) {
    const UNIT = /\b(tower|twr|ground|gnd|delivery|del|clnc|clearance|apron|information|info|atis|awos|asos|handling|unicom|ctaf|north|south|east|west|centre|center|inner|outer|arrival|departure|\d+)\b/gi;
    const title = (s) => s.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
    for (const kind of ["tower", "ground", "delivery", "atis"]) {
      for (const f of d.freqs.filter(f => f.kind === kind)) {
        const rest = f.name.replace(/\(.*?\)/g, " ").replace(/\S*\d\S*/g, " ").replace(UNIT, " ").replace(/\s+/g, " ").trim();
        if (/^[a-z]{2,}( [a-z]+)?$/i.test(rest) && rest.length >= 4 && !/\b(area|control|radar|approach|app|director)\b/i.test(rest)) return title(rest);
      }
    }
    return title((d.meta.city || d.name.split(" ")[0] || d.icao).split(/[-,/]/)[0].trim());
  }

  // local metres <-> lat/lon (same projection as aptdat.py: kx = cos(lat0)*111320, ky = 110540)
  get kx() { return Math.cos(this.d.lat * Math.PI / 180) * 111320; }
  toLatLon(p) { return [this.d.lat + p[1] / 110540, this.d.lon + p[0] / this.kx]; }
  toXY(lat, lon) { return [(lon - this.d.lon) * this.kx, (lat - this.d.lat) * 110540]; }

  nearestRunway(p) {
    let best = -1, bd = 1e9;
    for (const r of this.runways) {
      const d = this.distToRunway(p, r);
      if (d < bd) { bd = d; best = r.id; }
    }
    return best;
  }

  // lateral distance from runway centreline and along-track from end 0
  rwyCoords(p, r) {
    const e = r.ends[0];
    const dx = p[0] - e.pos[0], dy = p[1] - e.pos[1];
    return { along: dx * e.v[0] + dy * e.v[1], cross: dx * e.v[1] - dy * e.v[0] };
  }

  distToRunway(p, r) {
    const c = this.rwyCoords(p, r);
    const a = Math.max(0, Math.min(r.len, c.along));
    return Math.hypot(c.along - a, c.cross);
  }

  onRunway(p, r, margin = 0) {
    const c = this.rwyCoords(p, r);
    return c.along > -60 && c.along < r.len + 60 && Math.abs(c.cross) < r.width / 2 + margin;
  }

  findRunwayEnd(name) { return name ? this.rwyEnd[String(name).toUpperCase()] : null; }

  nearestNode(p, filter) {
    let best = -1, bd = 1e9;
    this.nodes.forEach((n, i) => {
      if (!this.adj[i].length || (filter && !filter(i))) return;
      const d = dist(n, p); if (d < bd) { bd = d; best = i; }
    });
    return best;
  }

  /**
   * Dijkstra over (node, viaIndex). via: list of taxiway names to follow in order.
   * Off-route named taxiways are only allowed (penalised) before the first / after the last via.
   * Returns Map of reachable state -> {cost, prev} and helper to rebuild paths.
   * opts.avoidRwy: runway id whose runway edges may not be used.
   * opts.firstAvoid: node the first step may not go to (no U-turn after pushback).
   */
  search(start, via, opts = {}) {
    const m = via.length;
    const key = (n, k) => n * 64 + k;
    const best = new Map();
    const prev = new Map();
    const heap = [[0, start, 0]];
    best.set(key(start, 0), 0);
    while (heap.length) {
      let bi = 0;
      for (let i = 1; i < heap.length; i++) if (heap[i][0] < heap[bi][0]) bi = i;
      const [c, n, k] = heap[bi];
      heap[bi] = heap[heap.length - 1]; heap.pop();
      if (c > best.get(key(n, k))) continue;
      for (const { to, e, rev } of this.adj[n]) {
        if (n === start && to === opts.firstAvoid) continue;
        let nk = k, w;
        if (e.runway) {
          if (e.rwy === opts.avoidRwy) continue;
          w = e.len * 3 + 200;
        } else if (!e.name) {
          w = e.len * 1.6;
        } else if (m === 0) {
          w = e.len;
        } else if (k > 0 && e.name === via[k - 1]) {
          w = e.len;
        } else if (k < m && e.name === via[k]) {
          nk = k + 1; w = e.len;
        } else if (k === 0) {
          w = e.len * 2.5; // leaving the apron before joining the first cleared taxiway
        } else if (k === m) {
          w = e.len * 4; // short connector after the last cleared taxiway
        } else continue;
        if (rev) w *= 6;
        const nc = c + w, kk = key(to, nk);
        if (nc < (best.get(kk) ?? Infinity)) {
          best.set(kk, nc); prev.set(kk, key(n, k)); heap.push([nc, to, nk]);
        }
      }
    }
    const path = (n) => {
      let kk = key(n, m);
      if (!best.has(kk)) return null;
      const out = [];
      while (kk !== undefined) { out.push(Math.floor(kk / 64)); kk = prev.get(kk); }
      return out.reverse();
    };
    return { cost: (n) => best.get(key(n, m)), path };
  }

  /** Route to the runway entry for departure end `end`. Returns node list ending ON the runway. */
  routeToRunway(start, end, via, firstAvoid) {
    const s = this.search(start, via, { avoidRwy: end.rwy, firstAvoid });
    const r = this.runways[end.rwy];
    let bestN = -1, bestC = Infinity;
    for (const n of this.rwyNodes[r.id]) {
      const c = s.cost(n);
      if (c === undefined) continue;
      // prefer full-length entries: penalise distance from the departure threshold
      const dx = this.nodes[n][0] - end.pos[0], dy = this.nodes[n][1] - end.pos[1];
      const along = dx * end.v[0] + dy * end.v[1];
      const score = c + Math.abs(along) * 1.5;
      if (score < bestC) { bestC = score; bestN = n; }
    }
    return bestN < 0 ? null : s.path(bestN);
  }

  /** Route to the reachable node closest to `pos` (e.g. a stand), honouring `via`. */
  routeToPos(start, pos, via, firstAvoid) {
    const s = this.search(start, via, { firstAvoid });
    let best = -1, bd = Infinity;
    this.nodes.forEach((p, n) => {
      const c = s.cost(n);
      if (c === undefined) return;
      const d = dist(p, pos) * 4 + c * 0.05;
      if (d < bd) { bd = d; best = n; }
    });
    return best < 0 || dist(this.nodes[best], pos) > 400 ? null : s.path(best);
  }

  edgeBetween(a, b) {
    const x = this.adj[a].find(o => o.to === b);
    return x ? x.e : null;
  }

  /** After landing: from a runway node, find taxiway path until clear of that runway's zones. */
  exitRoute(fromNode, rwy, rwyHdg) {
    const p0 = this.nodes[fromNode];
    let best = null;
    for (const { to, e } of this.adj[fromNode]) {
      if (e.runway) continue;
      const h = hdgOf(this.nodes[to][0] - p0[0], this.nodes[to][1] - p0[1]);
      if (rwyHdg != null && Math.abs(angDiff(rwyHdg, h)) > 120) continue;
      // BFS/Dijkstra outward until a node with no zone/runway edges for rwy
      const seen = new Map([[fromNode, null], [to, fromNode]]);
      const q = [[to, e.len]];
      while (q.length) {
        q.sort((a, b) => a[1] - b[1]);
        const [n, c] = q.shift();
        const touches = this.adj[n].some(o => o.e.zones.has(rwy)) || this.rwyNodes[rwy].has(n);
        if (!touches && !this.reachesStands(n, rwy)) break; // dead-end stub (bad data)
        if (!touches) {
          const path = []; let k = n;
          while (k !== null && k !== undefined) { path.push(k); k = seen.get(k); }
          path.reverse();
          if (!best || c < best.c) best = { c, path };
          break;
        }
        for (const o of this.adj[n]) {
          if (o.e.runway || seen.has(o.to)) continue;
          seen.set(o.to, n); q.push([o.to, c + o.e.len * (o.rev ? 6 : 1)]);
        }
      }
    }
    return best ? best.path : null;
  }

  /** Can node n reach the stand area without going back through runway rwy? (memoised) */
  reachesStands(n, rwy) {
    this._reach ??= new Map();
    const key = n * 16 + rwy;
    if (!this._reach.has(key)) {
      this._nearStand ??= new Set(this.nodes.map((p, i) => i).filter(i => this.stands.some(s => dist(s.pos, this.nodes[i]) < 150)));
      if (!this._nearStand.size) return true;
      const seen = new Set([n]), st = [n];
      let ok = false;
      while (st.length && !ok) {
        const x = st.pop();
        if (this._nearStand.has(x)) ok = true;
        for (const { to, e } of this.adj[x]) {
          if (e.runway || e.zones.has(rwy) || seen.has(to)) continue;
          seen.add(to); st.push(to);
        }
      }
      this._reach.set(key, ok);
    }
    return this._reach.get(key);
  }

  /** Runway exits ahead of along-distance `along` (from end), as [{node, along}] sorted. */
  exitsAhead(end, along, behindOk = false) {
    const out = [];
    for (const n of this.rwyNodes[end.rwy]) {
      if (!this.adj[n].some(o => !o.e.runway)) continue;
      const p = this.nodes[n];
      const a = (p[0] - end.pos[0]) * end.v[0] + (p[1] - end.pos[1]) * end.v[1];
      if (behindOk || a > along) out.push({ node: n, along: a });
    }
    return out.sort((a, b) => a.along - b.along);
  }

  /** Physical runway ids an edge's zone covers (empty set if none). */
  zonesOf(a, b) {
    const e = this.edgeBetween(a, b);
    return e ? e.zones : new Set();
  }
}
