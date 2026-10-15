// Radar canvas: Delivery/apron picture, ground radar (ASDE-X / vSMR style), tower radar ~10 nm, approach/centre
// radar with range rings. Draws a world snapshot ({ac:[...], arrEnd}) so pop-out and multiplayer windows render
// without the sim.
//
// Aircraft: top-down silhouettes at real wingspan/length when zoomed in; radar symbology (position symbol,
// history dots, 1-minute speed vector, label on a draggable leader line) when zoomed out or on radar views.
// Labels are full data blocks in plain language and never overlap (greedy placement, manual drags win).
// Static layers (pavement, markings, labels of the airport) are cached in an offscreen canvas and only
// redrawn when the view moves, so 150+ targets stay at 60 fps.
import { dist } from "./airport.js";
import { AC_DIM } from "./data.js";
import { statePhrase, issueMarkers, squawkText } from "./labels.js";

const NM = 1852;
const DAY = {
  bg: "#0a0f14", pave: "#1e252d", concrete: "#232a32", grass: "#101a12", rwy: "#0d1013", rwyEdge: "#c9d1d9", taxiLine: "#8a7a2a",
  lead: "#6f6322", edge: "#2d3339", white: "#6a737b", hold: "#d8b330", ilsHold: "#e08a2e", graph: "#2c5d8a", link: "#3d7fb8",
  road: "#36414b", label: "#8fa3b5", stand: "#5d6f80", dep: "#7fd1ff", arr: "#ffd27f", ovf: "#c7a6ff", human: "#ff7fd8", veh: "#ffd04a",
  sel: "#7CFC9A", route: "#3fb96d", warn: "#ff5d5d", ring: "#1c2833", sid: "#3d8f6a", star: "#9a7a3a", fix: "#6f8597",
  text: "#a9b8c6", amber: "#ffb347", credit: "#4b5a68",
};
const NIGHT = { ...DAY, bg: "#05080b", pave: "#121820", concrete: "#141a22", grass: "#080d09", rwy: "#070a0d", taxiLine: "#4d4418",
  lead: "#3f3814", edge: "#1a2026", white: "#454d55", stand: "#3f4c58", ring: "#141c24", text: "#9aa9b7" };

export const VIEWS = { DEL: "Delivery", GND: "Ground", TWR: "Tower", APP: "Approach", CTR: "Centre" };
const RADAR_VIEWS = new Set(["TWR", "APP", "CTR"]);
const VEH_COL = { followme: "#ffd04a", fire: "#ff5a3c", ops: "#e8eef4", tug: "#9aa7b4", snow: "#8fd3ff", fuel: "#d9a53d", bus: "#7fc7ff", catering: "#b0e07a", baggage: "#c8c8c8" };
const LABEL_OFFSETS = [[14, -22], [14, 16], [-14, -22], [-14, 16], [16, -44], [-16, -44], [16, 36], [-16, 36], [0, -58], [0, 48]];

export class Radar {
  constructor(canvas) {
    this.cv = canvas;
    this.ctx = canvas.getContext("2d");
    this.scale = 0.2; this.cx = 0; this.cy = 0;
    this.view = "GND";
    this.showGraph = false;
    this.showProcs = true;
    this.night = false;
    this.wx = null;                 // { vis (m), rain, snow, fog, lvp }
    this.stopBars = [];             // [{p:[x,y], v:[dx,dy], lit:bool, id}] (D2)
    this.filter = { ground: true, air: true, maxAlt: 99999 };
    this.procs = [];
    this.vfrPoints = [];            // VFR reporting points [{name, p, alt}] (D5)
    this.history = new Map();       // id -> [{p, t}]
    this.labelOff = new Map();      // id -> [dx, dy] screen offset of the data block (manual drags)
    this.autoOff = new Map();       // id -> offset chosen by the overlap solver
    this.labelBoxes = [];
    this.widthCache = new Map();
    this.hover = null;
    this.mouse = null;
    this.onSelect = () => {};
    this.onEdgeClick = null;        // (edge) => {} for click-to-instruct
    this.onStopBar = null;          // (bar) => {} toggle
    this.credit = "";
    this.osm = null;                // { buildings: [{pts, kind, name}] } (C3)
    this.staticKey = null;
    this.bindMouse();
    new ResizeObserver(() => { this.resize(); }).observe(canvas);
    this.watchDpr();
  }

  get C() { return this.night ? NIGHT : DAY; }

  /** Crisp canvas on mixed-DPI monitors: re-measure when the window moves to a screen with another scale. */
  watchDpr() {
    if (!window.matchMedia) return;
    const mq = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    const on = () => { this.resize(); this.watchDpr(); };
    if (mq.addEventListener) mq.addEventListener("change", on, { once: true });
    else if (mq.addListener) mq.addListener(on);
  }

  resize() {
    const r = this.cv.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    this.cv.width = Math.max(1, Math.round(r.width * dpr)); this.cv.height = Math.max(1, Math.round(r.height * dpr));
    this.dpr = dpr; this.w = r.width; this.h = r.height;
    this.staticKey = null;
  }

  setAirport(apt) {
    this.apt = apt;
    const d = apt.d;
    const SURF = (code) => (code === 2 ? "concrete" : (code === 3 || code === 4 || code === 5 || code === 12 || code === 13 || code === 14 || code === 15) ? "grass" : "pave");
    this.paveBy = { pave: new Path2D(), concrete: new Path2D(), grass: new Path2D() };
    d.pavement.forEach((poly, i) => {
      const p = this.paveBy[SURF((d.pavementSurf || [])[i] || 1)];
      for (const ring of poly) { ring.forEach((q, j) => j ? p.lineTo(q[0], q[1]) : p.moveTo(q[0], q[1])); p.closePath(); }
    });
    const line = (list) => { const p = new Path2D(); for (const l of list || []) l.forEach((q, i) => i ? p.lineTo(q[0], q[1]) : p.moveTo(q[0], q[1])); return p; };
    this.taxiLines = line(d.lines);
    this.leadLines = line(d.leadLines);
    this.edgeLines = line(d.edgeLines);
    this.whiteLines = line(d.whiteLines);
    this.holdLines = line(d.holdLines);
    this.ilsHoldLines = line(d.ilsHoldLines);
    this.boundary = line(d.boundary);
    this.graph = line(apt.edges.filter(e => !e.generated).map(e => [apt.nodes[e.a], apt.nodes[e.b]]));
    this.links = line(apt.standLinks.map(([a, b]) => [apt.nodes[a], apt.nodes[b]]));
    this.roads = line(apt.roads.map(e => [apt.nodes[e.a], apt.nodes[e.b]]));
    this.centrePts = (d.lines || []).flatMap(l => l.filter((q, i) => i % 2 === 0));   // taxiway centreline lights at night
    this.edgePts = (d.edgeLines || []).flatMap(l => l.filter((q, i) => i % 3 === 0));   // blue taxiway edge lights at night
    this.labels = [];
    for (const e of apt.edges) {
      if (!e.name || e.runway || e.len < 30 || e.generated) continue;
      const a = apt.nodes[e.a], b = apt.nodes[e.b];
      const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      if (this.labels.some(l => l.t === e.name && dist(l.p, m) < 300)) continue;
      this.labels.push({ t: e.name, p: m });
    }
    this.history.clear(); this.autoOff.clear(); this.labelOff.clear();
    this.staticKey = null;
    this.setView(this.view);
  }

  /** OSM buildings etc. (C3): [{pts:[[x,y]...], kind:"terminal"|"hangar"|"tower"|"building"|"apron", name}] */
  setOsm(osm) { this.osm = osm; this.staticKey = null; }

  /** SID/STAR polylines from procs.js procLines() (lat/lon). */
  setProcs(lines) {
    this.procs = this.apt ? lines.map(l => ({ ...l, xy: l.pts.map(p => ({ ...p, p: this.apt.toXY(p.lat, p.lon) })) })) : [];
    this.staticKey = null;
  }

  /** Frame the view for a position. */
  setView(view) {
    this.view = VIEWS[view] ? view : "GND";
    if (!this.apt) return;
    this.resize();
    const apt = this.apt;
    if (this.view === "GND" || this.view === "DEL") {
      const [x0, y0, x1, y1] = this.view === "DEL" ? apt.apronBounds(80) : apt.bounds(200);
      this.cx = (x0 + x1) / 2; this.cy = (y0 + y1) / 2;
      this.scale = Math.min(this.w / (x1 - x0 + 1), this.h / (y1 - y0 + 1));
    } else {
      const R = { TWR: 10, APP: 30, CTR: 60 }[this.view] * NM;
      this.cx = 0; this.cy = 0;
      this.scale = Math.min(this.w, this.h) / (2 * R);
    }
    this.staticKey = null;
  }
  getViewState() { return { view: this.view, cx: this.cx, cy: this.cy, scale: this.scale, filter: this.filter }; }
  setViewState(s) { if (!s) return; this.view = s.view || this.view; this.cx = s.cx; this.cy = s.cy; this.scale = s.scale; if (s.filter) this.filter = s.filter; this.staticKey = null; }
  get radarView() { return RADAR_VIEWS.has(this.view); }

  toScreen(p) { return [this.w / 2 + (p[0] - this.cx) * this.scale, this.h / 2 - (p[1] - this.cy) * this.scale]; }
  toWorld(x, y) { return [this.cx + (x - this.w / 2) / this.scale, this.cy - (y - this.h / 2) / this.scale]; }

  bindMouse() {
    let drag = null;
    const local = (e) => { const r = this.cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    this.cv.addEventListener("wheel", (e) => {
      e.preventDefault();
      const [x, y] = local(e);
      const before = this.toWorld(x, y);
      this.scale *= Math.exp(-e.deltaY * 0.0015);
      this.scale = Math.max(0.0005, Math.min(8, this.scale));
      const after = this.toWorld(x, y);
      this.cx += before[0] - after[0]; this.cy += before[1] - after[1];
      this.staticKey = null;
    }, { passive: false });
    this.cv.addEventListener("mousedown", (e) => {
      const [x, y] = local(e);
      const box = this.labelBoxes.find(b => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h);
      if (box) { drag = { label: box.id, x, y, off: [...(this.labelOff.get(box.id) || this.autoOff.get(box.id) || [14, -22])], moved: false }; return; }
      drag = { x: e.clientX, y: e.clientY, cx: this.cx, cy: this.cy, moved: false };
    });
    this.cv.addEventListener("mousemove", (e) => { this.mouse = local(e); });
    this.cv.addEventListener("mouseleave", () => { this.mouse = null; this.hover = null; });
    window.addEventListener("mousemove", (e) => {
      if (!drag) return;
      if (drag.label != null) {
        const [x, y] = local(e);
        this.labelOff.set(drag.label, [drag.off[0] + x - drag.x, drag.off[1] + y - drag.y]);
        drag.moved = true;
        return;
      }
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      this.cx = drag.cx - dx / this.scale; this.cy = drag.cy + dy / this.scale;
      this.staticKey = null;
    });
    window.addEventListener("mouseup", (e) => {
      if (drag && !drag.moved && this.world && e.target === this.cv) {
        if (drag.label != null) { this.onSelect(drag.label); drag = null; return; }
        const [x, y] = local(e);
        const bar = this.stopBarAt(x, y);
        if (bar && this.onStopBar) { this.onStopBar(bar); drag = null; return; }
        const best = this.targetAt(x, y);
        if (!best && this.onEdgeClick && this.apt && this.scale > 0.05) {
          const ne = this.apt.nearestEdge(this.toWorld(x, y), 12 / this.scale);
          if (ne) { this.onEdgeClick(ne.e); drag = null; return; }
        }
        this.onSelect(best ? best.id : null);
      }
      drag = null;
    });
  }

  targetAt(x, y) {
    let best = null, bd = 18;
    for (const a of this.world ? this.world.ac : []) {
      const s = this.toScreen(a.pos); const d = Math.hypot(s[0] - x, s[1] - y);
      if (d < bd) { bd = d; best = a; }
    }
    return best;
  }
  stopBarAt(x, y) {
    for (const b of this.stopBars) { const s = this.toScreen(b.p); if (Math.hypot(s[0] - x, s[1] - y) < 10) return b; }
    return null;
  }

  // ---------------------------------------------------------------- static layer
  worldTransform(ctx) {
    const k = this.scale, dpr = this.dpr || 1;
    ctx.setTransform(k * dpr, 0, 0, -k * dpr, (this.w / 2 - this.cx * k) * dpr, (this.h / 2 + this.cy * k) * dpr);
  }

  drawStatic(arrEnd) {
    const key = [this.cx, this.cy, this.scale, this.w, this.h, this.dpr, this.view, this.night, this.showGraph, this.showProcs, arrEnd ? arrEnd.name : "", !!this.osm].join("|");
    if (key === this.staticKey && this.staticCv) return;
    this.staticKey = key;
    if (!this.staticCv) this.staticCv = document.createElement("canvas");
    const cv = this.staticCv;
    cv.width = this.cv.width; cv.height = this.cv.height;
    const ctx = cv.getContext("2d"), C = this.C, apt = this.apt, k = this.scale, dpr = this.dpr || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = C.bg; ctx.fillRect(0, 0, this.w, this.h);
    this.worldTransform(ctx);
    const radarView = this.radarView;
    if (radarView) {
      const step = { TWR: 2, APP: 5, CTR: 10 }[this.view] * NM;
      ctx.strokeStyle = C.ring; ctx.lineWidth = 1 / k;
      for (let r = step; r <= 80 * NM; r += step) { ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.stroke(); }
    }
    if (this.showProcs && radarView && this.procs.length) {
      ctx.lineWidth = 1 / k; ctx.setLineDash([6 / k, 4 / k]);
      for (const l of this.procs) {
        ctx.strokeStyle = l.kind === "sid" ? C.sid : l.kind === "star" ? C.star : C.fix;
        ctx.beginPath();
        if (l.kind === "sid") ctx.moveTo(0, 0);
        l.xy.forEach((p, i) => (i || l.kind === "sid") ? ctx.lineTo(...p.p) : ctx.moveTo(...p.p));
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }
    // airport surfaces
    if (this.boundary && k > 0.01) { ctx.fillStyle = this.night ? "#080c0a" : "#0e1512"; ctx.fill(this.boundary); }
    ctx.fillStyle = C.grass; ctx.fill(this.paveBy.grass, "evenodd");
    ctx.fillStyle = C.pave; ctx.fill(this.paveBy.pave, "evenodd");
    ctx.fillStyle = C.concrete; ctx.fill(this.paveBy.concrete, "evenodd");
    // OSM buildings (C3)
    if (this.osm && k > 0.02) this.drawOsm(ctx);
    for (const r of apt.runways) {
      const [e0, e1] = r.ends, n = [e0.v[1] * r.width / 2, -e0.v[0] * r.width / 2];
      ctx.beginPath();
      ctx.moveTo(e0.pos[0] + n[0], e0.pos[1] + n[1]); ctx.lineTo(e1.pos[0] + n[0], e1.pos[1] + n[1]);
      ctx.lineTo(e1.pos[0] - n[0], e1.pos[1] - n[1]); ctx.lineTo(e0.pos[0] - n[0], e0.pos[1] - n[1]); ctx.closePath();
      ctx.fillStyle = C.rwy; ctx.fill();
      ctx.strokeStyle = C.rwyEdge; ctx.lineWidth = Math.max(1.2 / k, radarView ? 2.5 / k : 0); ctx.stroke();
      ctx.setLineDash([30, 20]); ctx.lineWidth = 0.8 / k; ctx.globalAlpha = 0.6;
      ctx.beginPath(); ctx.moveTo(...e0.pos); ctx.lineTo(...e1.pos); ctx.stroke();
      ctx.setLineDash([]); ctx.globalAlpha = 1;
      for (const e of r.ends) if (e.displaced > 0) {
        ctx.beginPath(); ctx.moveTo(e.thr[0] + n[0], e.thr[1] + n[1]); ctx.lineTo(e.thr[0] - n[0], e.thr[1] - n[1]);
        ctx.lineWidth = 2 / k; ctx.stroke();
      }
      if (this.night && k > 0.04) {           // runway edge lights
        ctx.fillStyle = "#e8e8d0";
        const L = r.len, step = 60;
        for (let s = 0; s <= L; s += step) for (const sgn of [1, -1]) {
          const p = [e0.pos[0] + e0.v[0] * s + sgn * n[0], e0.pos[1] + e0.v[1] * s + sgn * n[1]];
          ctx.fillRect(p[0] - 0.8, p[1] - 0.8, 1.6, 1.6);
        }
      }
    }
    if (k > 0.03) {
      if (k > 0.08) { ctx.strokeStyle = C.edge; ctx.lineWidth = 0.8 / k; ctx.stroke(this.edgeLines); }
      if (k > 0.15) { ctx.strokeStyle = C.white; ctx.lineWidth = 0.8 / k; ctx.stroke(this.whiteLines); }
      ctx.strokeStyle = C.taxiLine; ctx.lineWidth = 1 / k; ctx.stroke(this.taxiLines);
      if (k > 0.1) { ctx.strokeStyle = C.lead; ctx.lineWidth = 0.9 / k; ctx.stroke(this.leadLines); }
      ctx.strokeStyle = C.hold; ctx.lineWidth = 1.5 / k; ctx.stroke(this.holdLines);
      ctx.strokeStyle = C.ilsHold; ctx.lineWidth = 1.5 / k; ctx.setLineDash([4 / k, 2 / k]); ctx.stroke(this.ilsHoldLines); ctx.setLineDash([]);
      if (this.night && k > 0.12) {            // green taxiway centreline lights, blue edge lights
        ctx.fillStyle = "#4dff7a"; const px = Math.max(0.7, 1.2 / k);
        for (const q of this.centrePts) ctx.fillRect(q[0] - px / 2, q[1] - px / 2, px, px);
        ctx.fillStyle = "#4f7dff";
        for (const q of this.edgePts) ctx.fillRect(q[0] - px / 2, q[1] - px / 2, px, px);
      }
    }
    if (this.showGraph) {
      ctx.strokeStyle = C.road; ctx.lineWidth = 0.7 / k; ctx.stroke(this.roads);
      ctx.strokeStyle = C.graph; ctx.lineWidth = 1 / k; ctx.stroke(this.graph);
      ctx.strokeStyle = C.link; ctx.lineWidth = 1 / k; ctx.setLineDash([4 / k, 3 / k]); ctx.stroke(this.links); ctx.setLineDash([]);
    }
    // stand markings: a box the size of the stand at high zoom
    if (k > 0.35 && !radarView) {
      ctx.strokeStyle = C.stand; ctx.lineWidth = 0.6 / k; ctx.globalAlpha = 0.6;
      for (const st of apt.stands) {
        const sz = { A: 15, B: 24, C: 36, D: 52, E: 65, F: 80 }[st.size] || (st.types && st.types.includes("heavy") ? 65 : st.types && st.types.every(t => t === "props") ? 14 : 36);
        const h = st.hdg * Math.PI / 180, vx = Math.sin(h), vy = Math.cos(h);
        const nx = vy, ny = -vx, L = sz * 1.1, W = sz;
        const c = [st.pos[0] + vx * L * 0.35, st.pos[1] + vy * L * 0.35];
        ctx.beginPath();
        ctx.moveTo(c[0] + vx * L / 2 + nx * W / 2, c[1] + vy * L / 2 + ny * W / 2);
        ctx.lineTo(c[0] + vx * L / 2 - nx * W / 2, c[1] + vy * L / 2 - ny * W / 2);
        ctx.lineTo(c[0] - vx * L / 2 - nx * W / 2, c[1] - vy * L / 2 - ny * W / 2);
        ctx.lineTo(c[0] - vx * L / 2 + nx * W / 2, c[1] - vy * L / 2 + ny * W / 2);
        ctx.closePath(); ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
    // extended centreline with 1 nm ticks
    if (arrEnd) {
      const ae = arrEnd;
      ctx.strokeStyle = "#2a3a48"; ctx.lineWidth = 1 / k; ctx.setLineDash([8 / k, 8 / k]);
      ctx.beginPath(); ctx.moveTo(...ae.thr); ctx.lineTo(ae.thr[0] - ae.v[0] * 25 * NM, ae.thr[1] - ae.v[1] * 25 * NM); ctx.stroke();
      ctx.setLineDash([]);
      for (let i = 1; i <= 25; i++) {
        const p = [ae.thr[0] - ae.v[0] * i * NM, ae.thr[1] - ae.v[1] * i * NM], t = (i % 5 ? 120 : 300) / Math.max(1, k * 4);
        ctx.beginPath(); ctx.moveTo(p[0] + ae.v[1] * t, p[1] - ae.v[0] * t); ctx.lineTo(p[0] - ae.v[1] * t, p[1] + ae.v[0] * t); ctx.stroke();
      }
    }
    // ---- screen-space airport text ----
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.textBaseline = "middle"; ctx.textAlign = "center";
    ctx.font = "600 11px ui-monospace, Consolas, monospace";
    for (const r of apt.runways) for (const e of r.ends) {
      const off = 40 / Math.min(1, k * 5 + 0.01);
      const s = this.toScreen([e.pos[0] - e.v[0] * off, e.pos[1] - e.v[1] * off]);
      ctx.fillStyle = C.rwyEdge; ctx.fillText(e.name, s[0], s[1]);
    }
    if (this.showProcs && radarView) {
      ctx.font = "9px ui-monospace, Consolas, monospace"; ctx.fillStyle = C.fix; ctx.strokeStyle = C.fix;
      const seen = new Set();
      for (const l of this.procs) for (const p of l.xy) {
        if (seen.has(p.id)) continue; seen.add(p.id);
        const s = this.toScreen(p.p);
        ctx.beginPath(); ctx.moveTo(s[0], s[1] - 4); ctx.lineTo(s[0] + 4, s[1] + 3); ctx.lineTo(s[0] - 4, s[1] + 3); ctx.closePath(); ctx.stroke();
        ctx.fillText(p.id, s[0], s[1] + 11);
      }
      ctx.textAlign = "left";
      for (const l of this.procs) { const last = l.xy[l.kind === "sid" ? l.xy.length - 1 : 0]; const s = this.toScreen(last.p); ctx.fillStyle = l.kind === "sid" ? C.sid : C.star; ctx.fillText(l.name, s[0] + 6, s[1] - 8); }
      ctx.textAlign = "center";
    }
    // VFR reporting points (D5): hollow triangles with name and altitude on the Tower / Approach pictures
    if (radarView && this.view !== "CTR" && this.vfrPoints && this.vfrPoints.length) {
      ctx.font = "9px ui-monospace, Consolas, monospace"; ctx.fillStyle = "#8fc7ff"; ctx.strokeStyle = "#8fc7ff"; ctx.lineWidth = 1;
      for (const pt of this.vfrPoints) {
        const s = this.toScreen(pt.p);
        ctx.beginPath(); ctx.moveTo(s[0], s[1] - 6); ctx.lineTo(s[0] + 6, s[1] + 5); ctx.lineTo(s[0] - 6, s[1] + 5); ctx.closePath(); ctx.stroke();
        ctx.fillText(`${pt.name} ${pt.alt}`, s[0], s[1] + 16);
      }
    }
    if (k > 0.12) {
      ctx.font = "10px ui-monospace, Consolas, monospace";
      for (const l of this.labels) {
        const s = this.toScreen(l.p);
        if (s[0] < -20 || s[1] < -20 || s[0] > this.w + 20 || s[1] > this.h + 20) continue;
        const w = ctx.measureText(l.t).width + 6;
        ctx.fillStyle = "#11161c"; ctx.fillRect(s[0] - w / 2, s[1] - 7, w, 14);
        ctx.fillStyle = "#d9c45a"; ctx.fillText(l.t, s[0], s[1]);
      }
    }
    if (k > 0.45 || (this.view === "DEL" && k > 0.2)) {
      ctx.fillStyle = C.stand; ctx.font = "9px ui-monospace, Consolas, monospace";
      for (const st of apt.stands) { const s = this.toScreen(st.pos); if (s[0] > -20 && s[0] < this.w + 20 && s[1] > -20 && s[1] < this.h + 20) ctx.fillText(st.name, s[0], s[1] + 9); }
    }
    if (this.osm && k > 0.1) {
      ctx.font = "9px system-ui, sans-serif"; ctx.fillStyle = "#6c7f91";
      for (const b of this.osm.buildings || []) if (b.name && b.c) { const s = this.toScreen(b.c); if (s[0] > 0 && s[0] < this.w && s[1] > 0 && s[1] < this.h) ctx.fillText(b.name, s[0], s[1]); }
    }
    if (radarView) {
      ctx.fillStyle = "#3d4d5c"; ctx.font = "10px ui-monospace, Consolas, monospace";
      const step = { TWR: 2, APP: 5, CTR: 10 }[this.view];
      for (let r = step; r <= 80; r += step) { const s = this.toScreen([0, r * NM]); if (s[1] > 10) ctx.fillText(`${r}`, s[0] + 10, s[1] + 6); }
    }
    this.drawCompassAndScale(ctx);
  }

  drawOsm(ctx) {
    const C = this.C, k = this.scale;
    const FILL = { terminal: this.night ? "#2a3240" : "#3a4556", pier: this.night ? "#2a3240" : "#3a4556", hangar: this.night ? "#262c34" : "#343d48",
      tower: "#5a4a2a", building: this.night ? "#1f252d" : "#2b333c", apron: C.concrete, parking: "#1a1f26" };
    for (const b of this.osm.buildings || []) {
      if (!b.pts || b.pts.length < 3) continue;
      ctx.beginPath(); b.pts.forEach((q, i) => i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1])); ctx.closePath();
      ctx.fillStyle = FILL[b.kind] || FILL.building; ctx.fill();
      if (k > 0.08) { ctx.strokeStyle = "#55657a"; ctx.lineWidth = 0.6 / k; ctx.stroke(); }
    }
  }

  drawCompassAndScale(ctx) {
    const C = this.C;
    // compass rose, top-left under the status overlay
    const cx = 44, cy = 92, R = 22;
    ctx.save(); ctx.globalAlpha = 0.85;
    ctx.strokeStyle = "#5a6b7c"; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = "#c9d1d9"; ctx.beginPath(); ctx.moveTo(cx, cy - R); ctx.lineTo(cx - 5, cy); ctx.lineTo(cx + 5, cy); ctx.closePath(); ctx.fill();
    ctx.fillStyle = "#5a6b7c"; ctx.beginPath(); ctx.moveTo(cx, cy + R); ctx.lineTo(cx - 5, cy); ctx.lineTo(cx + 5, cy); ctx.closePath(); ctx.fill();
    ctx.font = "600 10px ui-monospace, Consolas, monospace"; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillStyle = "#c9d1d9";
    ctx.fillText("N", cx, cy - R - 8);
    for (let a = 0; a < 360; a += 30) { const r = a * Math.PI / 180; ctx.beginPath(); ctx.moveTo(cx + Math.sin(r) * (R - 3), cy - Math.cos(r) * (R - 3)); ctx.lineTo(cx + Math.sin(r) * R, cy - Math.cos(r) * R); ctx.stroke(); }
    // scale bar, bottom-right
    const k = this.scale;
    const metres = [50, 100, 200, 500, 1000, 2000, 5000, NM * 5, NM * 10, NM * 20, NM * 50].find(m => m * k >= 60) || 100;
    const px = metres * k, x1 = this.w - 20, y = this.h - 18;
    ctx.strokeStyle = "#c9d1d9"; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(x1 - px, y); ctx.lineTo(x1, y); ctx.moveTo(x1 - px, y - 4); ctx.lineTo(x1 - px, y + 4); ctx.moveTo(x1, y - 4); ctx.lineTo(x1, y + 4); ctx.stroke();
    ctx.fillStyle = "#c9d1d9"; ctx.textAlign = "right"; ctx.font = "10px ui-monospace, Consolas, monospace";
    ctx.fillText(metres >= NM * 2 ? `${Math.round(metres / NM)} NM` : metres >= 1000 ? `${metres / 1000} km` : `${metres} m`, x1, y - 9);
    if (this.credit) { ctx.textAlign = "left"; ctx.fillStyle = C.credit; ctx.font = "9px system-ui, sans-serif"; ctx.fillText(this.credit, 8, this.h - 10); }
    ctx.restore();
  }

  // ---------------------------------------------------------------- frame
  /** world: { ac: snapshot[], arrEnd }  selectedId: aircraft id */
  draw(world, selectedId) {
    this.world = world;
    const ctx = this.ctx, apt = this.apt, k = this.scale, dpr = this.dpr || 1, C = this.C;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!apt) { ctx.fillStyle = C.bg; ctx.fillRect(0, 0, this.w, this.h); return; }
    this.drawStatic(world.arrEnd);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.staticCv, 0, 0);
    this.worldTransform(ctx);
    // stop bars (D2)
    for (const b of this.stopBars) {
      ctx.strokeStyle = b.lit ? "#ff2d2d" : "#4a2a2a"; ctx.lineWidth = Math.max(2 / k, 1.5);
      ctx.beginPath(); ctx.moveTo(b.p[0] - b.v[1] * b.len / 2, b.p[1] + b.v[0] * b.len / 2); ctx.lineTo(b.p[0] + b.v[1] * b.len / 2, b.p[1] - b.v[0] * b.len / 2); ctx.stroke();
    }
    // closed runways (D7): red band and crosses at both ends
    if (world.closed && world.closed.size) {
      for (const r of world.closed) {
        const R = apt.runways[r]; if (!R) continue;
        const e = R.ends[0], v = e.v, n = [-v[1], v[0]], w = (R.width || 45) / 2;
        ctx.save(); ctx.globalAlpha = 0.35; ctx.fillStyle = "#ff3b3b";
        ctx.beginPath(); ctx.moveTo(e.pos[0] + n[0] * w, e.pos[1] + n[1] * w); ctx.lineTo(e.pos[0] + v[0] * R.len + n[0] * w, e.pos[1] + v[1] * R.len + n[1] * w);
        ctx.lineTo(e.pos[0] + v[0] * R.len - n[0] * w, e.pos[1] + v[1] * R.len - n[1] * w); ctx.lineTo(e.pos[0] - n[0] * w, e.pos[1] - n[1] * w); ctx.closePath(); ctx.fill();
        ctx.globalAlpha = 0.9; ctx.strokeStyle = "#ff3b3b"; ctx.lineWidth = Math.max(3 / k, 2);
        for (const along of [120, R.len - 120]) {
          const c = [e.pos[0] + v[0] * along, e.pos[1] + v[1] * along], s = Math.max(w * 1.6, 40);
          ctx.beginPath(); ctx.moveTo(c[0] - (v[0] + n[0]) * s, c[1] - (v[1] + n[1]) * s); ctx.lineTo(c[0] + (v[0] + n[0]) * s, c[1] + (v[1] + n[1]) * s);
          ctx.moveTo(c[0] - (v[0] - n[0]) * s, c[1] - (v[1] - n[1]) * s); ctx.lineTo(c[0] + (v[0] - n[0]) * s, c[1] + (v[1] - n[1]) * s); ctx.stroke();
        }
        ctx.restore();
      }
    }
    const sel = world.ac.find(a => a.id === selectedId);
    if (sel && sel.path && sel.path.length && sel.onGround) {
      ctx.strokeStyle = C.route; ctx.lineWidth = 2.5 / k; ctx.globalAlpha = 0.7;
      ctx.beginPath(); ctx.moveTo(...sel.pos);
      for (const p of sel.path) ctx.lineTo(p[0], p[1]);
      ctx.stroke(); ctx.globalAlpha = 1;
    }
    // weather tint (C5)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (this.wx && (this.wx.fog || this.wx.rain || this.wx.snow)) {
      ctx.fillStyle = this.wx.snow ? "rgba(220,228,240,0.07)" : this.wx.fog ? "rgba(180,190,200,0.10)" : "rgba(60,90,130,0.10)";
      ctx.fillRect(0, 0, this.w, this.h);
    }
    ctx.textBaseline = "middle"; ctx.textAlign = "center";
    // arrivals sequence: distance to the threshold and spacing to the one ahead
    const finals = world.ac.filter(a => a.dthr != null).sort((a, b) => a.dthr - b.dthr);
    finals.forEach((a, i) => { a._gap = i ? (a.dthr - finals[i - 1].dthr) / NM : null; a._gapS = i && a.spd > 1 ? (a.dthr - finals[i - 1].dthr) / a.spd : null; });
    this.recordHistory(world.ac);
    this.labelBoxes = [];
    const visible = [];
    const visLimit = this.view === "TWR" && this.wx && this.wx.vis != null && this.wx.vis < 8000 ? this.wx.vis : null;
    const tower = apt.towerPos();
    for (const a of world.ac) {
      if (a.onGround ? !this.filter.ground : (!this.filter.air || a.alt > this.filter.maxAlt)) continue;
      if (this.view === "GND" && !a.onGround && (a.alt || 0) > 2500) continue;
      if (this.view === "DEL" && !a.onGround) continue;
      const s = this.toScreen(a.pos);
      if (s[0] < -200 || s[1] < -200 || s[0] > this.w + 200 || s[1] > this.h + 200) continue;
      // low visibility hides distant targets on the tower (visual) picture: the radar views still show them
      a._dim = visLimit != null && dist(a.pos, tower) > visLimit * 1.4 ? 0.25 : 1;
      visible.push({ a, s });
    }
    for (const { a, s } of visible) this.drawTarget(a, s, a.id === selectedId);
    this.layoutLabels(visible, selectedId);
    for (const { a, s } of visible) this.drawLabel(a, s, a.id === selectedId);
    this.hover = this.mouse ? this.targetAt(this.mouse[0], this.mouse[1]) : null;
    if (this.hover) this.drawTooltip(this.hover);
  }

  recordHistory(list) {
    const now = performance.now();
    const ids = new Set();
    for (const a of list) {
      ids.add(a.id);
      let h = this.history.get(a.id);
      if (!h) { h = []; this.history.set(a.id, h); }
      if (!h.length || now - h[h.length - 1].t > 4000) { h.push({ p: [...a.pos], t: now }); if (h.length > 7) h.shift(); }
    }
    for (const id of [...this.history.keys()]) if (!ids.has(id)) { this.history.delete(id); this.labelOff.delete(id); this.autoOff.delete(id); }
  }

  /** Silhouette when it would be big enough on screen and we're on a ground/tower picture. */
  useSilhouette(a) {
    const dim = AC_DIM[a.type] || [35, 38, "airliner"];
    if (this.radarView && this.view !== "TWR") return false;
    if (!a.onGround && (a.alt || 0) > 300 && this.view !== "TWR") return false;
    if (this.view === "TWR" && !a.onGround) return false;
    return dim[1] * this.scale >= 7;
  }

  colorFor(a, sel) {
    const C = this.C;
    if (sel) return C.sel;
    if (a.human) return C.human;
    if (a.veh) return VEH_COL[a.vtype] || C.veh;
    if (a.mayday || a.squawk === "7700" || a.squawk === "7500") return Math.floor(performance.now() / 500) % 2 ? C.warn : "#ffb0b0";
    if (a.nordo) return "#ff9f5d";
    if (a.kind === "ovf") return C.ovf;
    const s = a.state;
    if (a.kind === "dep") {
      if (["parked", "clr_req", "cleared"].includes(s)) return "#4e8fb3";
      if (["holding"].includes(s)) return "#bfe6ff";
      if (["lineup", "lining", "lined_up", "roll"].includes(s)) return "#ffffff";
      return C.dep;
    }
    if (s === "final") return a.landClr ? "#ffe3a3" : C.arr;
    if (s === "rollout" || s === "vacating") return "#fff2cc";
    if (s === "parked") return "#8c7a4a";
    if (["vacated", "holding_short", "taxi"].includes(s)) return "#d9a94f";
    return C.arr;
  }

  drawTarget(a, s, sel) {
    const ctx = this.ctx;
    const col = this.colorFor(a, sel);
    const blink = a.ident && Math.floor(performance.now() / 400) % 2;
    ctx.save(); ctx.translate(s[0], s[1]);
    ctx.globalAlpha = a._dim || 1;
    ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = 1.5;
    if (a.veh) this.drawVehicle(a, col);
    else if (this.useSilhouette(a)) { if (a.gear && a.gear.length && this.scale > 0.3) this.drawEquipment(a); this.drawSilhouette(a, col); }
    else this.drawRadarSymbol(a, col);
    if (blink) { ctx.beginPath(); ctx.arc(0, 0, 12, 0, Math.PI * 2); ctx.stroke(); }
    ctx.restore();
  }

  /** Turnaround equipment around a parked aircraft (metres, in the aircraft's frame): jet bridge or stairs at the
   *  left front door, fuel truck under the right wing, catering at the right front door, baggage carts behind the
   *  left wing, a bus by the stairs, the pushback tug at the nose. */
  drawEquipment(a) {
    const ctx = this.ctx, k = this.scale;
    const [S, L, shape] = AC_DIM[a.type] || [35, 38, "airliner"];
    const fw = shape === "widebody" ? 6 : shape === "ga" ? 1.3 : 4;
    ctx.save(); ctx.rotate(a.hdg * Math.PI / 180); ctx.scale(k, k);
    const box = (x, y, w, h, col, border) => { ctx.fillStyle = col; ctx.fillRect(x - w / 2, y - h / 2, w, h); if (border) { ctx.strokeStyle = border; ctx.lineWidth = 0.3; ctx.strokeRect(x - w / 2, y - h / 2, w, h); } };
    for (const g of a.gear) {
      if (g === "bridge") { box(-fw / 2 - 9, -L * 0.3, 18, 3.6, this.night ? "#2a3240" : "#3f4b5c", "#6a7a8e"); box(-fw / 2 - 18, -L * 0.3, 4, 6, "#4b5869"); }
      else if (g === "stairs") box(-fw / 2 - 2.6, -L * 0.3, 4.2, 2.2, "#aab4bf");
      else if (g === "fuel") box(S * 0.22, L * 0.08, 9, 2.8, "#d9a53d");
      else if (g === "catering") box(fw / 2 + 2.8, -L * 0.3, 7, 2.6, "#b0e07a");
      else if (g === "baggage") { for (let i = 0; i < 3; i++) box(-S * 0.18, L * 0.14 + i * 3.4, 3, 1.6, "#c8c8c8"); box(-S * 0.18, L * 0.14 - 3.6, 3.6, 2, "#8c96a0"); }
      else if (g === "bus") box(-S * 0.3, -L * 0.46, 11, 2.6, "#7fc7ff");
      else if (g === "tug") box(0, -L / 2 - 3.2, 2.6, 4.4, "#ffd04a", "#111");
    }
    ctx.restore();
  }

  drawVehicle(a, col) {
    const ctx = this.ctx, k = this.scale;
    const L = Math.max(6, 5.5 * k), W = Math.max(3, 2.4 * k);
    ctx.save(); ctx.rotate(a.hdg * Math.PI / 180);
    ctx.fillStyle = col; ctx.fillRect(-W / 2, -L / 2, W, L);
    if (a.vtype === "followme") { ctx.fillStyle = "#111"; for (let i = 0; i < 3; i++) ctx.fillRect(-W / 2 + (i % 2) * W / 2, -L / 2 + i * L / 3, W / 2, L / 3); }
    ctx.fillStyle = "#fff"; ctx.fillRect(-W / 2, -L / 2, W, Math.max(1, L * 0.12));   // windscreen / nose
    ctx.restore();
  }

  drawSilhouette(a, col) {
    const ctx = this.ctx;
    const [span, len, shape] = AC_DIM[a.type] || [35, 38, "airliner"];
    const k = this.scale;
    ctx.save();
    ctx.rotate(a.hdg * Math.PI / 180);
    ctx.scale(k, k);              // metres; nose towards -y on screen
    const L = len, S = span, fw = shape === "widebody" ? 6 : shape === "ga" ? 1.3 : shape === "heli" ? 2 : 4;
    ctx.globalAlpha = 0.9 * (a._dim || 1);
    ctx.beginPath();
    if (shape === "heli") {
      ctx.ellipse(0, -L * 0.15, fw, L * 0.3, 0, 0, Math.PI * 2);
      ctx.rect(-0.4, -L * 0.05, 0.8, L * 0.55);
      ctx.fill();
      ctx.globalAlpha = 0.35; ctx.beginPath(); ctx.arc(0, -L * 0.15, S / 2, 0, Math.PI * 2); ctx.fill();
    } else {
      ctx.ellipse(0, 0, fw / 2, L / 2, 0, 0, Math.PI * 2); ctx.fill();
      const wy = shape === "ga" ? -L * 0.12 : shape === "turboprop" ? -L * 0.05 : L * 0.02;
      const sweep = shape === "ga" || shape === "turboprop" ? 0 : shape === "regional" ? L * 0.1 : L * 0.16;
      const chordRoot = shape === "ga" ? L * 0.18 : L * 0.2, chordTip = shape === "ga" ? L * 0.16 : L * 0.07;
      ctx.beginPath();
      ctx.moveTo(-fw / 2, wy - chordRoot / 2); ctx.lineTo(-S / 2, wy - chordRoot / 2 + sweep); ctx.lineTo(-S / 2, wy - chordRoot / 2 + sweep + chordTip);
      ctx.lineTo(-fw / 2, wy + chordRoot / 2); ctx.lineTo(fw / 2, wy + chordRoot / 2);
      ctx.lineTo(S / 2, wy - chordRoot / 2 + sweep + chordTip); ctx.lineTo(S / 2, wy - chordRoot / 2 + sweep); ctx.lineTo(fw / 2, wy - chordRoot / 2);
      ctx.closePath(); ctx.fill();
      const ts = shape === "ga" ? S * 0.32 : S * 0.33, ty = L * 0.4, tc = L * 0.08;
      ctx.beginPath();
      ctx.moveTo(-fw / 4, ty - tc / 2); ctx.lineTo(-ts / 2, ty + (sweep ? tc * 0.6 : 0)); ctx.lineTo(-ts / 2, ty + tc / 2 + (sweep ? tc * 0.6 : 0));
      ctx.lineTo(ts / 2, ty + tc / 2 + (sweep ? tc * 0.6 : 0)); ctx.lineTo(ts / 2, ty + (sweep ? tc * 0.6 : 0)); ctx.lineTo(fw / 4, ty - tc / 2);
      ctx.closePath(); ctx.fill();
      ctx.globalAlpha = 1; ctx.fillStyle = this.C.bg;
      if (shape === "turboprop") for (const x of [-S * 0.22, S * 0.22]) ctx.fillRect(x - 0.7, wy - chordRoot / 2 - 2.5, 1.4, 4);
      else if (shape === "airliner" || shape === "widebody") for (const x of [-S * 0.18, S * 0.18]) ctx.fillRect(x - fw * 0.25, wy - chordRoot / 2 + sweep * 0.35 - 2.5, fw * 0.5, 4);
      else if (shape === "regional" && a.type.startsWith("CRJ")) for (const x of [-fw * 0.9, fw * 0.9]) ctx.fillRect(x - 0.8, L * 0.25, 1.6, 4);
      else if (shape === "regional") for (const x of [-S * 0.17, S * 0.17]) ctx.fillRect(x - 0.9, wy - chordRoot / 2 + sweep * 0.35 - 2, 1.8, 3.5);
    }
    ctx.restore();
    // nose marker (screen size so it's always visible)
    const v = [Math.sin(a.hdg * Math.PI / 180), -Math.cos(a.hdg * Math.PI / 180)];
    const nose = (L / 2) * k;
    ctx.fillStyle = "#ffffff";
    ctx.beginPath(); ctx.arc(v[0] * nose, v[1] * nose, Math.max(1.5, Math.min(3, k * 1.2)), 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = col;
  }

  drawRadarSymbol(a, col) {
    const ctx = this.ctx;
    const h = this.history.get(a.id) || [];
    ctx.save(); ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = col; ctx.globalAlpha = 0.5 * (a._dim || 1);
    const me = this.toScreen(a.pos);
    for (let i = 0; i < h.length - 1; i++) { const s = this.toScreen(h[i].p); if (Math.hypot(s[0] - me[0], s[1] - me[1]) > 2) ctx.fillRect(s[0] - 1.2, s[1] - 1.2, 2.4, 2.4); }
    ctx.restore();
    ctx.globalAlpha = a._dim || 1;
    // position symbol: square = mode C, circle = primary only, filled when on ground
    if (a.xpdr === "C" || a.human) { if (a.onGround) ctx.fillRect(-3.5, -3.5, 7, 7); else ctx.strokeRect(-3.5, -3.5, 7, 7); }
    else { ctx.beginPath(); ctx.arc(0, 0, 3.5, 0, Math.PI * 2); ctx.stroke(); }
    // 1-minute speed vector
    if (a.spd > 1) {
      const v = [Math.sin(a.hdg * Math.PI / 180), -Math.cos(a.hdg * Math.PI / 180)];
      const lead = Math.max(6, a.spd * 60 * this.scale);
      ctx.beginPath(); ctx.moveTo(v[0] * 4, v[1] * 4); ctx.lineTo(v[0] * lead, v[1] * lead); ctx.stroke();
    }
  }

  // ---------------------------------------------------------------- labels
  textWidth(t, font) {
    const key = font + "|" + t;
    let w = this.widthCache.get(key);
    if (w == null) { this.ctx.font = font; w = this.ctx.measureText(t).width; if (this.widthCache.size > 4000) this.widthCache.clear(); this.widthCache.set(key, w); }
    return w;
  }

  /** Data block lines for a target: [{t, col, font}] */
  labelLines(a, col, sel) {
    const C = this.C;
    const F = "10px ui-monospace, Consolas, monospace", FB = `${sel ? "700" : "600"} 11px ui-monospace, Consolas, monospace`;
    const kt = Math.round(a.spd / 0.5144);
    const lines = [{ t: `${a.cs}${a.wtc && a.wtc !== "L" && !a.veh ? "/" + a.wtc : ""}${a.human ? " LIVE" : ""}`, col, font: FB }];
    const hovered = this.hover && this.hover.id === a.id;
    if (a.quiet && !sel && !hovered) return [];      // service vehicles: name on hover only
    if (a.state === "parked" && !sel && !hovered && !a.nordo && !a.mayday && (this.scale < 0.25 || a.dormant)) return this.scale > 0.08 ? [lines[0]] : [];
    // parked / ground targets on a radar picture or a zoomed-out ground picture: callsign only, like a real label filter
    if (!sel && !hovered && a.onGround && (this.radarView || this.scale < 0.05) && !a.nordo && !a.mayday && !(a.warn && a.warn.length)) return lines;
    const compact = this.scale < 0.05 && !sel && !this.radarView;
    if (a.veh) {
      lines.push({ t: `${a.vtype.toUpperCase()}  ${kt} kt`, col: sel ? C.sel : C.text, font: F });
      lines.push({ t: statePhrase(a), col: sel ? C.sel : C.text, font: F });
    } else if (a.onGround) {
      lines.push({ t: `${a.type}  ${kt} kt`, col: sel ? C.sel : C.text, font: F });
      const sq = squawkText(a);
      if (sq.t && !compact) lines.push({ t: sq.t + (sq.ident ? " IDENT" : ""), col: sq.mismatch ? C.amber : (sel ? C.sel : C.text), font: F });
      if (!compact) lines.push({ t: trunc(statePhrase(a), 34), col: sel ? C.sel : C.text, font: F });
    } else {
      const alt = String(Math.round((a.alt || 0) / 100)).padStart(3, "0");
      const hdg = this.view === "APP" || this.view === "CTR" ? ` H${String(Math.round(a.hdg) % 360).padStart(3, "0")}` : "";
      lines.push({ t: `${a.type}${hdg}  A${alt}  ${String(kt).padStart(3, "0")}`, col: sel ? C.sel : C.text, font: F });
      const sq = squawkText(a);
      if (sq.t) lines.push({ t: sq.t + (sq.ident ? " IDENT" : ""), col: sq.mismatch ? C.amber : (sel ? C.sel : C.text), font: F });
      const gap = a._gap != null ? `  Δ${a._gap.toFixed(1)}${a._gapS != null ? "/" + Math.round(a._gapS) + "s" : ""}` : "";
      lines.push({ t: trunc(statePhrase(a), 30) + gap, col: sel ? C.sel : C.text, font: F });
    }
    const issues = issueMarkers(a);
    const warn = [...(a.warn || []), ...issues.map(i => i.t)];
    if (warn.length) lines.push({ t: warn.join(" "), col: issues.some(i => i.level === "alert") || (a.warn || []).length ? C.warn : C.amber, font: "700 10px ui-monospace, Consolas, monospace" });
    return lines;
  }

  boxFor(s, off, lines) {
    let w = 0;
    for (const l of lines) w = Math.max(w, this.textWidth(l.t, l.font));
    const x = s[0] + off[0], y = s[1] + off[1];
    return { x: off[0] < 0 ? x - w : x, y: y - 10, w, h: lines.length * 11 + 2 };
  }

  /** Greedy overlap solver: manual offsets are fixed; others keep their previous slot while it is free. */
  layoutLabels(visible, selectedId) {
    const placed = [];
    const offscreen = (b) => b.x < 2 || b.y < 2 || b.x + b.w > this.w - 2 || b.y + b.h > this.h - 2;
    const overlaps = (b) => offscreen(b) || placed.some(p => b.x < p.x + p.w + 4 && b.x + b.w + 4 > p.x && b.y < p.y + p.h + 2 && b.y + b.h + 2 > p.y);
    const order = [...visible].sort((p, q) => (q.a.id === selectedId) - (p.a.id === selectedId) || (q.a.onGround ? 0 : 1) - (p.a.onGround ? 0 : 1));
    for (const v of order) {
      const a = v.a, sel = a.id === selectedId;
      const lines = this.labelLines(a, this.colorFor(a, sel), sel);
      v.lines = lines;
      const manual = this.labelOff.get(a.id);
      if (manual) { v.off = manual; v.box = this.boxFor(v.s, manual, lines); placed.push(v.box); continue; }
      const prev = this.autoOff.get(a.id);
      let chosen = null;
      if (prev) { const b = this.boxFor(v.s, prev, lines); if (!overlaps(b)) { chosen = prev; v.box = b; } }
      const fits = (offsets, ls, k = 1) => { for (const off of offsets) { const o = k === 1 ? off : [off[0] * k, off[1] * k]; const b = this.boxFor(v.s, o, ls); if (!overlaps(b)) { chosen = o; v.box = b; v.lines = ls; return true; } } return false; };
      if (!chosen) fits(LABEL_OFFSETS, lines);
      if (!chosen) fits(LABEL_OFFSETS, lines, 1.6) || fits(LABEL_OFFSETS, lines, 2.3);                    // a longer leader line
      if (!chosen && (a.state === "parked" || a.quiet) && !sel) { v.lines = []; v.off = prev || LABEL_OFFSETS[0]; v.box = { x: 0, y: 0, w: 0, h: 0 }; continue; }   // no room: a parked aircraft keeps quiet
      if (!chosen && lines.length > 1 && !sel) fits(LABEL_OFFSETS, lines.slice(0, 1)) || fits(LABEL_OFFSETS, lines.slice(0, 1), 1.6);   // the callsign alone
      if (!chosen) { chosen = prev || LABEL_OFFSETS[0]; v.box = this.boxFor(v.s, chosen, lines); }
      this.autoOff.set(a.id, chosen);
      v.off = chosen; placed.push(v.box);
    }
    this._layout = new Map(visible.map(v => [v.a.id, v]));
  }

  drawLabel(a, s, sel) {
    const ctx = this.ctx, C = this.C;
    const v = this._layout && this._layout.get(a.id);
    if (!v || !v.lines.length) return;
    const { off, lines, box } = v;
    const x = s[0] + off[0], y = s[1] + off[1];
    ctx.save(); ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.globalAlpha = a._dim || 1;
    ctx.strokeStyle = sel ? C.sel : "#5f7487"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(s[0] + Math.sign(off[0] || 1) * 5, s[1]); ctx.lineTo(x - (off[0] < 0 ? -2 : 2), y + 6); ctx.stroke();
    ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
    if (sel || a.id === (this.hover && this.hover.id)) { ctx.fillStyle = "rgba(10,15,20,0.75)"; ctx.fillRect(box.x - 3, box.y, box.w + 6, box.h + 2); }
    lines.forEach((l, i) => {
      ctx.font = l.font; ctx.fillStyle = l.col;
      ctx.fillText(l.t, off[0] < 0 ? x - this.textWidth(l.t, l.font) : x, y + i * 11);
    });
    this.labelBoxes.push({ id: a.id, x: box.x, y: box.y, w: box.w, h: box.h });
    ctx.restore();
  }

  drawTooltip(a) {
    const ctx = this.ctx, C = this.C, m = this.mouse;
    const kt = Math.round(a.spd / 0.5144);
    const lines = [
      `${a.cs}  ${a.type || ""}${a.wtc ? "/" + a.wtc : ""}${a.nat ? "  " + a.nat : ""}`,
      a.veh ? statePhrase(a) : a.kind === "dep" ? `${a.other ? a.other[0] + " " + (a.other[1] || "") : ""}` : a.kind === "arr" ? `from ${a.other ? a.other[1] || a.other[0] : ""}` : "",
      statePhrase(a),
      `${a.onGround ? kt + " kt" : "A" + String(Math.round((a.alt || 0) / 100)).padStart(3, "0") + "  " + kt + " kt"}${a.squawk ? "  sq " + a.squawk + (a.assignedSq && a.assignedSq !== a.squawk ? " (assigned " + a.assignedSq + ")" : "") : ""}`,
      a.freq && a.freq !== "ALL" ? `on ${a.freq}` : "",
      a.lastWant ? `would call: ${a.lastWant}` : "",
    ].filter(Boolean);
    ctx.save(); ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.font = "11px system-ui, sans-serif";
    const w = Math.max(...lines.map(t => ctx.measureText(t).width)) + 16, h = lines.length * 15 + 10;
    let x = m[0] + 16, y = m[1] + 12;
    if (x + w > this.w) x = m[0] - w - 8;
    if (y + h > this.h) y = this.h - h - 4;
    ctx.fillStyle = "rgba(13,21,28,0.94)"; ctx.strokeStyle = "#2f6b45"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x, y, w, h, 5) : ctx.rect(x, y, w, h); ctx.fill(); ctx.stroke();
    ctx.textAlign = "left"; ctx.textBaseline = "top";
    lines.forEach((t, i) => { ctx.fillStyle = i === 0 ? C.sel : "#d5dee7"; ctx.font = i === 0 ? "600 11px system-ui, sans-serif" : "11px system-ui, sans-serif"; ctx.fillText(t, x + 8, y + 6 + i * 15); });
    ctx.restore();
  }
}

const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** Legacy export (strips used it); plain text now lives in labels.js. */
export const STATE_SHORT = {
  parked: "STAND", clr_req: "CLR REQ", cleared: "CLRD", push_req: "PUSH REQ", pushing: "PUSH", pushed: "PUSHED",
  taxi_req: "TAXI REQ", taxi: "TAXI", holding: "READY", lineup: "LUP", lining: "LUP", lined_up: "LUW",
  roll: "T/O", airborne: "AIRB", final: "FINAL", goaround: "G/A", rollout: "LAND", vacating: "VACATE",
  vacated: "VACATED", holding_short: "HLD SHT", cruise: "ENR", human: "LIVE",
};
