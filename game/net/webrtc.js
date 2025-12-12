// Simple 2-player WebRTC helper (Host/Client) with reliable/fast channels.
// Exposes callbacks for chat/control/input/state; no game logic here.

const ICE_CONF = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    {
      urls: "turn:relay1.expressturn.com:3480?transport=tcp",
      username: "000000002077866298",
      credential: "I1hhD86oxGbKHoCJr2Uy2LHo6a8="
    },
    {
      urls: "turns:relay1.expressturn.com:5349",
      username: "000000002077866298",
      credential: "I1hhD86oxGbKHoCJr2Uy2LHo6a8="
    }
  ],
  iceTransportPolicy: "relay"
};

export class WebRTCClient {
  constructor(cb = {}) {
    this.ws = null;
    this.selfId = null;
    this.hostId = null;
    this.selfNick = "Player";
    this.mode = "client";
    this.peer = null; // { id, nickname, mode, pc, reliable, fast }
    this.cb = {
      log: cb.log || (() => {}),
      onOpen: cb.onOpen || (() => {}),
      onClose: cb.onClose || (() => {}),
      onPeerReady: cb.onPeerReady || (() => {}),
      onHostChanged: cb.onHostChanged || (() => {}),
      onChat: cb.onChat || (() => {}),
      onControl: cb.onControl || (() => {}),
      onState: cb.onState || (() => {}),
      onInput: cb.onInput || (() => {}),
      onDelta: cb.onDelta || (() => {}),
      onFire: cb.onFire || (() => {}),
      onDamage: cb.onDamage || (() => {})
    };
  }

  log(msg) {
    this.cb.log(msg);
  }

  connect({ wsUrl, room, nickname, mode }) {
    this.disconnect();
    this.selfNick = nickname || "Player";
    this.mode = mode === "host" ? "host" : "client";
    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      this.log("Signaling connected");
      this.ws.send(JSON.stringify({ type: "join", room, nickname: this.selfNick, mode: this.mode }));
    };

    this.ws.onmessage = async (e) => {
      const m = JSON.parse(e.data);
      if (m.type === "room-full") {
        this.log("Room full (2-player limit)");
        this.disconnect();
        return;
      }
      if (m.type === "welcome") {
        this.selfId = m.selfId;
        this.hostId = m.hostId;
        this.log(`Self ID ${this.selfId}, host ${this.hostId}`);
        if (m.peers && m.peers.length) {
          const peerInfo = m.peers[0];
          this.ensurePeer(peerInfo.id, true, peerInfo.nickname, peerInfo.mode);
        }
      } else if (m.type === "new-peer") {
        this.log(`Peer joined: ${m.nickname || m.id}`);
        this.ensurePeer(m.id, true, m.nickname, m.mode);
      } else if (m.type === "leave") {
        this.log(`Peer left: ${m.id}`);
        this.closePeer();
      } else if (m.type === "host-changed") {
        this.hostId = m.hostId;
        this.cb.onHostChanged(m.hostId, m.hostNickname);
      } else if (m.type === "offer") {
        await this.handleOffer(m);
      } else if (m.type === "answer") {
        await this.handleAnswer(m);
      } else if (m.type === "candidate") {
        await this.handleCandidate(m);
      }
    };

    this.ws.onclose = () => {
      this.log("Signaling closed");
      this.disconnect();
    };
    this.ws.onerror = () => {
      this.log("Signaling error");
    };
  }

  disconnect() {
    this.closePeer();
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
    this.selfId = null;
    this.hostId = null;
  }

  ensurePeer(peerId, initiator, nickname = "Peer", mode = "client") {
    if (this.peer) return this.peer;
    const pc = new RTCPeerConnection(ICE_CONF);
    const peer = { id: peerId, nickname, mode, pc, reliable: null, fast: null };
    this.peer = peer;

    pc.onicecandidate = (e) => {
      if (e.candidate) this.ws?.send(JSON.stringify({ type: "candidate", to: peerId, candidate: e.candidate }));
    };
    pc.onconnectionstatechange = () => this.log(`ICE(${nickname}): ${pc.connectionState}`);
    pc.ondatachannel = (e) => this.handleDataChannel(peer, e.channel);

    if (initiator) {
      peer.reliable = pc.createDataChannel("reliable");
      this.setupReliable(peer, peer.reliable);
      peer.fast = pc.createDataChannel("fast", { ordered: false, maxRetransmits: 0 });
      this.setupFast(peer, peer.fast);
      this.startOffer(peer);
    }

    return peer;
  }

  async startOffer(peer) {
    const offer = await peer.pc.createOffer();
    await peer.pc.setLocalDescription(offer);
    this.ws?.send(JSON.stringify({ type: "offer", to: peer.id, sdp: peer.pc.localDescription }));
  }

  async handleOffer(msg) {
    const peer = this.ensurePeer(msg.from, false);
    if (!peer) return;
    await peer.pc.setRemoteDescription(msg.sdp);
    const answer = await peer.pc.createAnswer();
    await peer.pc.setLocalDescription(answer);
    this.ws?.send(JSON.stringify({ type: "answer", to: peer.id, sdp: peer.pc.localDescription }));
  }

  async handleAnswer(msg) {
    const peer = this.peer;
    if (!peer) return;
    await peer.pc.setRemoteDescription(msg.sdp);
  }

  async handleCandidate(msg) {
    const peer = this.peer;
    if (!peer || !msg.candidate) return;
    await peer.pc.addIceCandidate(msg.candidate);
  }

  handleDataChannel(peer, ch) {
    if (ch.label === "reliable") {
      peer.reliable = ch;
      this.setupReliable(peer, ch);
    } else if (ch.label === "fast") {
      peer.fast = ch;
      this.setupFast(peer, ch);
    } else {
      this.log(`Unknown DataChannel: ${ch.label}`);
    }
  }

  setupReliable(peer, ch) {
    ch.onopen = () => {
      this.log(`Reliable open ↔ ${peer.nickname}`);
      this.cb.onPeerReady(peer);
    };
    ch.onclose = () => this.log(`Reliable closed ↔ ${peer.nickname}`);
    ch.onerror = (e) => this.log(`Reliable error: ${e?.message || e}`);
    ch.onmessage = (e) => this.handleReliableMessage(peer, e.data);
  }

  setupFast(peer, ch) {
    ch.onopen = () => this.log(`Fast open ↔ ${peer.nickname}`);
    ch.onclose = () => this.log(`Fast closed ↔ ${peer.nickname}`);
    ch.onerror = (e) => this.log(`Fast error: ${e?.message || e}`);
    ch.onmessage = (e) => this.handleFastMessage(peer, e.data);
  }

  handleReliableMessage(peer, data) {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    switch (msg.type) {
      case "chat": this.cb.onChat(msg, peer); break;
      case "control": this.cb.onControl(msg, peer); break;
      case "state": this.cb.onState(msg, peer); break;
      case "damage": this.cb.onDamage(msg, peer); break;
      default: break;
    }
  }

  handleFastMessage(peer, data) {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    switch (msg.type) {
      case "input": this.cb.onInput(msg, peer); break;
      case "delta": this.cb.onDelta(msg, peer); break;
      case "fire": this.cb.onFire(msg, peer); break;
      default: break;
    }
  }

  sendReliable(payload) {
    if (this.peer?.reliable?.readyState === "open") {
      this.peer.reliable.send(JSON.stringify(payload));
    }
  }

  sendFast(payload) {
    if (this.peer?.fast?.readyState === "open") {
      this.peer.fast.send(JSON.stringify(payload));
    }
  }

  closePeer() {
    if (!this.peer) return;
    try { this.peer.reliable?.close(); } catch {}
    try { this.peer.fast?.close(); } catch {}
    try { this.peer.pc?.close(); } catch {}
    this.peer = null;
  }
}
