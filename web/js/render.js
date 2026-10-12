// Radar canvas: ground radar (ASDE-X / vSMR style) for Ground, tower radar ~10 nm, approach/centre radar with
// range rings. Draws a world snapshot ({ac:[...], arrEnd}) so pop-out windows can render without the sim.
import { dist } from "./airport.js";

const NM = 1852;
const C = {
  bg: "#0a0f14", pave: "#1e252d", rwy: "#0d1013", rwyEdge: "#c9d1d9", taxiLine: "#6b5d1f", hold: "#d8b330",
  graph: "#2c5d8a", label: "#8fa3b5", stand: "#5d6f80", dep: "#7fd1ff", arr: "#ffd27f", ovf: "#c7a6ff", human: "#ff7fd8",
  sel: "#7CFC9A", route: "#3fb96d", warn: "#ff5d5d", ring: "#1c2833",
};

export const VIEWS = { GND: "Ground", TWR: "Tower", APP: "Approach", CTR: "Centre" };

export class Radar {
  constructor(canvas) {
    this.cv = canvas;
    this.ctx = canvas.getContext("2d");
    this.scale = 0.2; this.cx = 0; this.cy = 0;
    this.view = "GND";
    this.showGraph = false;
    this.onSelect = () => {};
    this.bindMouse();
    new ResizeObserver(() => { this.resize(); }).observe(canvas);
  }

  resize() {
    const r = this.cv.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    this.cv.width = Math.round(r.width * dpr); this.cv.height = Math.round(r.height * dpr);
    this.dpr = dpr; this.w = r.width; this.h = r.height;
  }

  setAirport(apt) {
    this.apt = apt;
    const d = apt.d;
    const pave = new Path2D();
    for (const poly of d.pavement) for (const ring of poly) {
      ring.forEach((p, i) => i ? pave.lineTo(p[0], p[1]) : pave.moveTo(p[0], p[1])); pave.closePath();
    }
    this.pave = pave;
    const line = (list) => { const p = new Path2D(); for (const l of list) l.forEach((q, i) => i ? p.lineTo(q[0], q[1]) : p.moveTo(q[0], q[1])); return p; };
    this.taxiLines = line(d.lines);
    this.holdLines = line(d.holdLines);
    this.graph = line(apt.edges.map(e => [apt.nodes[e.a], apt.nodes[e.b]]));
    this.labels = [];
    for (const e of apt.edges) {
      if (!e.name || e.runway || e.len < 30) continue;
      const a = apt.nodes[e.a], b = apt.nodes[e.b];
      const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      if (this.labels.some(l => l.t === e.name && dist(l.p, m) < 300)) continue;
      this.labels.push({ t: e.name, p: m });
    }
    this.setView(this.view);
  }

  /** Frame the view for a position. */
  setView(view) {
    this.view = VIEWS[view] ? view : "GND";
    if (!this.apt) return;
    this.resize();
    const apt = this.apt;
    if (this.view === "GND") {
      const xs = [], ys = [];
      for (const r of apt.runways) for (const e of r.ends) { xs.push(e.pos[0]); ys.push(e.pos[1]); }
      for (const s of apt.stands) { xs.push(s.pos[0]); ys.push(s.pos[1]); }
      const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
      this.cx = (x0 + x1) / 2; this.cy = (y0 + y1) / 2;
      this.scale = Math.min(this.w / (x1 - x0 + 400), this.h / (y1 - y0 + 400));
    } else {
      const R = { TWR: 10, APP: 30, CTR: 60 }[this.view] * NM;
      this.cx = 0; this.cy = 0;
      this.scale = Math.min(this.w, this.h) / (2 * R);
    }
  }

  toScreen(p) { return [this.w / 2 + (p[0] - this.cx) * this.scale, this.h / 2 - (p[1] - this.cy) * this.scale]; }
  toWorld(x, y) { return [this.cx + (x - this.w / 2) / this.scale, this.cy - (y - this.h / 2) / this.scale]; }

  bindMouse() {
    let drag = null;
    this.cv.addEventListener("wheel", (e) => {
      e.preventDefault();
      const r = this.cv.getBoundingClientRect();
      const before = this.toWorld(e.clientX - r.left, e.clientY - r.top);
      this.scale *= Math.exp(-e.deltaY * 0.0015);
      this.scale = Math.max(0.0005, Math.min(8, this.scale));
      const after = this.toWorld(e.clientX - r.left, e.clientY - r.top);
      this.cx += before[0] - after[0]; this.cy += before[1] - after[1];
    }, { passive: false });
    this.cv.addEventListener("mousedown", (e) => { drag = { x: e.clientX, y: e.clientY, cx: this.cx, cy: this.cy, moved: false }; });
    window.addEventListener("mousemove", (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      this.cx = drag.cx - dx / this.scale; this.cy = drag.cy + dy / this.scale;
    });
    window.addEventListener("mouseup", (e) => {
      if (drag && !drag.moved && this.world && e.target === this.cv) {
        const r = this.cv.getBoundingClientRect();
        const x = e.clientX - r.left, y = e.clientY - r.top;
        let best = null, bd = 18;
        for (const a of this.world.ac) {
          const s = this.toScreen(a.pos); const d = Math.hypot(s[0] - x, s[1] - y);
          if (d < bd) { bd = d; best = a; }
        }
        this.onSelect(best ? best.id : null);
      }
      drag = null;
    });
  }

  /** world: { ac: snapshot[], arrEnd, depEnd }  selectedId: aircraft id */
  draw(world, selectedId) {
    this.world = world;
    const ctx = this.ctx, apt = this.apt, k = this.scale, dpr = this.dpr || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = C.bg; ctx.fillRect(0, 0, this.w, this.h);
    if (!apt) return;
    ctx.setTransform(k * dpr, 0, 0, -k * dpr, (this.w / 2 - this.cx * k) * dpr, (this.h / 2 + this.cy * k) * dpr);
    // range rings for radar views
    if (this.view === "APP" || this.view === "CTR" || this.view === "TWR") {
      const step = { TWR: 2, APP: 5, CTR: 10 }[this.view] * NM;
      ctx.strokeStyle = C.ring; ctx.lineWidth = 1 / k;
      for (let r = step; r <= 80 * NM; r += step) { ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.stroke(); }
    }
    ctx.fillStyle = C.pave; ctx.fill(this.pave, "evenodd");
    for (const r of apt.runways) {
      const [e0, e1] = r.ends, n = [e0.v[1] * r.width / 2, -e0.v[0] * r.width / 2];
      ctx.beginPath();
      ctx.moveTo(e0.pos[0] + n[0], e0.pos[1] + n[1]); ctx.lineTo(e1.pos[0] + n[0], e1.pos[1] + n[1]);
      ctx.lineTo(e1.pos[0] - n[0], e1.pos[1] - n[1]); ctx.lineTo(e0.pos[0] - n[0], e0.pos[1] - n[1]); ctx.closePath();
      ctx.fillStyle = C.rwy; ctx.fill();
      ctx.strokeStyle = C.rwyEdge; ctx.lineWidth = Math.max(1.2 / k, this.view === "GND" ? 0 : 2.5 / k); ctx.stroke();
      ctx.setLineDash([30, 20]); ctx.lineWidth = 0.8 / k; ctx.globalAlpha = 0.6;
      ctx.beginPath(); ctx.moveTo(...e0.pos); ctx.lineTo(...e1.pos); ctx.stroke();
      ctx.setLineDash([]); ctx.globalAlpha = 1;
      for (const e of r.ends) if (e.displaced > 0) {
        ctx.beginPath(); ctx.moveTo(e.thr[0] + n[0], e.thr[1] + n[1]); ctx.lineTo(e.thr[0] - n[0], e.thr[1] - n[1]);
        ctx.lineWidth = 2 / k; ctx.stroke();
      }
    }
    if (k > 0.03) {
      ctx.strokeStyle = C.taxiLine; ctx.lineWidth = 1 / k; ctx.stroke(this.taxiLines);
      ctx.strokeStyle = C.hold; ctx.lineWidth = 1.5 / k; ctx.stroke(this.holdLines);
    }
    if (this.showGraph) { ctx.strokeStyle = C.graph; ctx.lineWidth = 1 / k; ctx.stroke(this.graph); }
    // extended centreline with 1 nm ticks
    const ae = world.arrEnd;
    if (ae) {
      ctx.strokeStyle = "#2a3a48"; ctx.lineWidth = 1 / k; ctx.setLineDash([8 / k, 8 / k]);
      ctx.beginPath(); ctx.moveTo(...ae.thr); ctx.lineTo(ae.thr[0] - ae.v[0] * 25 * NM, ae.thr[1] - ae.v[1] * 25 * NM); ctx.stroke();
      ctx.setLineDash([]);
      for (let i = 1; i <= 25; i++) {
        const p = [ae.thr[0] - ae.v[0] * i * NM, ae.thr[1] - ae.v[1] * i * NM], t = (i % 5 ? 120 : 300) / Math.max(1, k * 4);
        ctx.beginPath(); ctx.moveTo(p[0] + ae.v[1] * t, p[1] - ae.v[0] * t); ctx.lineTo(p[0] - ae.v[1] * t, p[1] + ae.v[0] * t); ctx.stroke();
      }
    }
    const sel = world.ac.find(a => a.id === selectedId);
    if (sel && sel.path && sel.path.length && sel.onGround) {
      ctx.strokeStyle = C.route; ctx.lineWidth = 2.5 / k; ctx.globalAlpha = 0.7;
      ctx.beginPath(); ctx.moveTo(...sel.pos);
      for (const p of sel.path) ctx.lineTo(p[0], p[1]);
      ctx.stroke(); ctx.globalAlpha = 1;
    }

    // ---- screen-space overlays ----
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.textBaseline = "middle"; ctx.textAlign = "center";
    ctx.font = "600 11px ui-monospace, Consolas, monospace";
    for (const r of apt.runways) for (const e of r.ends) {
      const s = this.toScreen([e.pos[0] - e.v[0] * 40 / Math.min(1, k * 5 + 0.01), e.pos[1] - e.v[1] * 40 / Math.min(1, k * 5 + 0.01)]);
      ctx.fillStyle = C.rwyEdge; ctx.fillText(e.name, s[0], s[1]);
    }
    if (k > 0.12) {
      ctx.font = "10px ui-monospace, Consolas, monospace";
      for (const l of this.labels) {
        const s = this.toScreen(l.p);
        const w = ctx.measureText(l.t).width + 6;
        ctx.fillStyle = "#11161c"; ctx.fillRect(s[0] - w / 2, s[1] - 7, w, 14);
        ctx.fillStyle = "#d9c45a"; ctx.fillText(l.t, s[0], s[1]);
      }
    }
    if (k > 0.45) {
      ctx.fillStyle = C.stand; ctx.font = "9px ui-monospace, Consolas, monospace";
      for (const st of apt.stands) { const s = this.toScreen(st.pos); ctx.fillText(st.name, s[0], s[1] + 9); }
    }
    if (this.view !== "GND") {
      ctx.fillStyle = "#3d4d5c"; ctx.font = "10px ui-monospace, Consolas, monospace";
      const step = { TWR: 2, APP: 5, CTR: 10 }[this.view];
      for (let r = step; r <= 80; r += step) { const s = this.toScreen([0, r * NM]); if (s[1] > 10) ctx.fillText(`${r}`, s[0] + 10, s[1] + 6); }
    }
    // arrivals sequence: distance to the threshold and spacing to the one ahead
    const finals = world.ac.filter(a => a.dthr != null).sort((a, b) => a.dthr - b.dthr);
    finals.forEach((a, i) => { a._gap = i ? (a.dthr - finals[i - 1].dthr) / NM : null; });
    for (const a of world.ac) this.drawAircraft(a, a.id === selectedId);
  }

  drawAircraft(a, sel) {
    const ctx = this.ctx;
    const s = this.toScreen(a.pos);
    if (s[0] < -200 || s[1] < -200 || s[0] > this.w + 200 || s[1] > this.h + 200) return;
    if (this.view === "GND" && !a.onGround && (a.alt || 0) > 2500) return;
    const base = a.human ? C.human : a.kind === "dep" ? C.dep : a.kind === "ovf" ? C.ovf : C.arr;
    const col = sel ? C.sel : base;
    const blink = a.ident && Math.floor(performance.now() / 400) % 2;
    ctx.save(); ctx.translate(s[0], s[1]);
    ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = 1.5;
    if (a.onGround) {
      const len = Math.max(6, Math.min(26, (a.wtc === "H" ? 65 : a.wtc === "L" ? 12 : 38) * this.scale));
      ctx.rotate(a.hdg * Math.PI / 180);
      ctx.beginPath();
      ctx.moveTo(0, -len / 2); ctx.lineTo(len * 0.38, len * 0.1); ctx.lineTo(len * 0.1, len * 0.1);
      ctx.lineTo(len * 0.12, len / 2); ctx.lineTo(-len * 0.12, len / 2); ctx.lineTo(-len * 0.1, len * 0.1);
      ctx.lineTo(-len * 0.38, len * 0.1); ctx.closePath();
      ctx.globalAlpha = 0.85; ctx.fill(); ctx.globalAlpha = 1;
      ctx.rotate(-a.hdg * Math.PI / 180);
    } else {
      if (a.xpdr === "C" || a.human) { ctx.beginPath(); ctx.moveTo(0, -5); ctx.lineTo(5, 0); ctx.lineTo(0, 5); ctx.lineTo(-5, 0); ctx.closePath(); ctx.stroke(); }
      else { ctx.beginPath(); ctx.arc(0, 0, 4, 0, Math.PI * 2); ctx.stroke(); } // primary only
      const v = [Math.sin(a.hdg * Math.PI / 180), -Math.cos(a.hdg * Math.PI / 180)];
      const lead = Math.min(60, Math.max(14, a.spd * 60 * this.scale)); // 1-minute speed vector
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(v[0] * lead, v[1] * lead); ctx.stroke();
    }
    if (blink) { ctx.beginPath(); ctx.arc(0, 0, 10, 0, Math.PI * 2); ctx.stroke(); }
    // data block
    ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
    ctx.font = `${sel ? "700" : "600"} 11px ui-monospace, Consolas, monospace`;
    const kt = Math.round(a.spd / 0.5144);
    const altTxt = a.alt >= 6000 ? "F" + String(Math.round(a.alt / 100)).padStart(3, "0") : "A" + String(Math.round(a.alt / 100)).padStart(3, "0");
    const lines = [a.cs];
    if (a.onGround) lines.push(`${a.type} ${kt}kt`, `${STATE_SHORT[a.state] || a.state}${a.rwy && a.kind === "dep" ? " " + a.rwy : ""}`);
    else {
      lines.push(`${altTxt} ${String(kt).padStart(3, "0")}`);
      lines.push(`${a.type} ${a.squawk || ""}${a.dthr != null ? " " + (a.dthr / NM).toFixed(1) + "nm" : ""}${a._gap != null ? " Δ" + a._gap.toFixed(1) : ""}`);
    }
    ctx.fillStyle = col;
    ctx.fillText(lines[0], 12, -10);
    ctx.font = "10px ui-monospace, Consolas, monospace";
    ctx.fillStyle = sel ? C.sel : "#a9b8c6";
    ctx.fillText(lines[1], 12, 2);
    ctx.fillText(lines[2], 12, 13);
    if (a.warn && a.warn.length) { ctx.fillStyle = C.warn; ctx.font = "700 10px ui-monospace, Consolas, monospace"; ctx.fillText(a.warn.join(" "), 12, 24); }
    ctx.restore();
  }
}

export const STATE_SHORT = {
  parked: "STAND", clr_req: "CLR REQ", cleared: "CLRD", push_req: "PUSH REQ", pushing: "PUSH", pushed: "PUSHED",
  taxi_req: "TAXI REQ", taxi: "TAXI", holding: "READY", lineup: "LUP", lining: "LUP", lined_up: "LUW",
  roll: "T/O", airborne: "AIRB", final: "FINAL", goaround: "G/A", rollout: "LAND", vacating: "VACATE",
  vacated: "VACATED", holding_short: "HLD SHT", cruise: "ENR", human: "LIVE",
};
