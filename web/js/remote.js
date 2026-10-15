// The multiplayer relay from the browser's side (ws.py on server.py): one WebSocket, JSON messages, automatic
// reconnect. The host sends state and decisions; guests send what a pop-out window would have sent over
// BroadcastChannel (transmissions, strip moves, selections) plus claims, chat and intercom signalling.

export function relayUrl({ code, role, name, pos = "", sname = "", pub = false }) {
  const u = new URL("/ws", location.href);
  u.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  u.searchParams.set("code", code || "");
  u.searchParams.set("role", role);
  u.searchParams.set("name", name || "");
  if (pos) u.searchParams.set("pos", pos);
  if (sname) u.searchParams.set("sname", sname);
  if (pub) u.searchParams.set("public", "1");
  return u.toString();
}

export class Relay {
  constructor(opts) {
    Object.assign(this, { onMessage: () => {}, onStatus: () => {} }, opts);
    this.ws = null; this.id = null; this.code = opts.code || ""; this.closed = false; this.tries = 0;
    this.connect();
  }
  connect() {
    if (this.closed) return;
    const ws = this.ws = new WebSocket(relayUrl(this));
    ws.onopen = () => { this.tries = 0; this.onStatus("connecting"); };
    ws.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.type === "welcome") { this.id = m.id; this.code = m.code; this.sessionName = m.name; this.onStatus("connected", m); }
      if (m.type === "kicked" || (m.type === "error" && /banned|no such/.test(m.error || ""))) { this.closed = true; this.onStatus("kicked", m); }
      this.onMessage(m);
    };
    ws.onclose = () => {
      this.onStatus("closed");
      if (this.closed) return;
      this.tries++;
      setTimeout(() => this.connect(), Math.min(10000, 500 * 2 ** Math.min(this.tries, 4)));
    };
    ws.onerror = () => { /* onclose follows */ };
  }
  send(obj) { if (this.ws && this.ws.readyState === 1) { this.ws.send(JSON.stringify(obj)); return true; } return false; }
  close() { this.closed = true; if (this.ws) this.ws.close(); }
}

/**
 * Intercom between controllers: one WebRTC peer connection per other party, push-to-talk by enabling the
 * microphone track. Signalling goes through the relay as {type:"rtc", to, sdp|ice}.
 */
export class Intercom {
  constructor({ send, log, onSpeaking }) {
    Object.assign(this, { send, log: log || (() => {}), onSpeaking: onSpeaking || (() => {}) });
    this.peers = new Map();        // id -> RTCPeerConnection
    this.stream = null;
    this.ctx = null;
    this.keyed = false;
    this.enabled = false;        // switched on by the first push-to-talk; until then nobody is called
  }
  async mic() {
    if (this.stream) return this.stream;
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    this.stream.getAudioTracks().forEach(t => { t.enabled = false; });
    return this.stream;
  }
  pc(id) {
    let pc = this.peers.get(id);
    if (pc) return pc;
    pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
    this.peers.set(id, pc);
    pc.onicecandidate = (e) => { if (e.candidate) this.send({ type: "rtc", to: id, ice: e.candidate }); };
    pc.ontrack = (e) => {
      const audio = new Audio(); audio.srcObject = e.streams[0]; audio.autoplay = true; audio.play().catch(() => {});
      pc._audio = audio;
      this.onSpeaking(id, true);
    };
    pc.onconnectionstatechange = () => { if (["failed", "closed", "disconnected"].includes(pc.connectionState)) this.drop(id); };
    return pc;
  }
  /** Start a call to `id` (the side that joined later calls). */
  async call(id) {
    try {
      const pc = this.pc(id);
      try { const stream = await this.mic(); stream.getTracks().forEach(t => pc.addTrack(t, stream)); }
      catch (e) { this.log("Intercom: no microphone here (" + e.message + ") — listening only"); }
      const offer = await pc.createOffer({ offerToReceiveAudio: true });
      await pc.setLocalDescription(offer);
      this.send({ type: "rtc", to: id, sdp: pc.localDescription });
    } catch (e) { this.log("Intercom: " + e.message); }
  }
  async onSignal(m) {
    const id = m.from;
    try {
      const pc = this.pc(id);
      if (m.sdp) {
        if (m.sdp.type === "offer") {
          try { const stream = await this.mic(); if (pc.getSenders().length === 0) stream.getTracks().forEach(t => pc.addTrack(t, stream)); }
          catch (e) { this.log("Intercom: no microphone here (" + e.message + ") — listening only"); }
          await pc.setRemoteDescription(m.sdp);
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          this.send({ type: "rtc", to: id, sdp: pc.localDescription });
        } else {
          await pc.setRemoteDescription(m.sdp);
        }
      } else if (m.ice) {
        await pc.addIceCandidate(m.ice).catch(() => {});
      }
    } catch (e) { this.log("Intercom: " + e.message); }
  }
  key(on) {
    this.keyed = on;
    if (this.stream) this.stream.getAudioTracks().forEach(t => { t.enabled = on; });
  }
  drop(id) { const pc = this.peers.get(id); if (pc) { try { pc.close(); } catch { /* */ } this.peers.delete(id); } }
  closeAll() { for (const id of [...this.peers.keys()]) this.drop(id); if (this.stream) this.stream.getTracks().forEach(t => t.stop()); this.stream = null; }
}
