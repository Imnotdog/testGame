import { loadAssets } from "./core/assetLoader.js";
import { Engine } from "./core/engine.js";
import { Input } from "./core/input.js";
import { GameState } from "./states/gamestate.js";
import { UIManager } from "./states/ui_manager.js";
import { WebRTCClient } from "./net/webrtc.js";
import { GAME_CONFIG } from "./config.js";

let canvas;
let ctx;
let game;
let net;
const netState = {
  lastStateSend: 0,
  remoteGhost: null, // client ship simulated on host; host ghost shown on client via state
  hostGhost: null,   // host ship snapshot for client view
  remoteInput: null
};

function resizeCanvas() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  if (game) {
    game.centerPlayer();
  }
}

async function init() {
  canvas = document.getElementById("gameCanvas");
  ctx = canvas.getContext("2d");
  resizeCanvas();

  Input.init();

  await loadAssets();

  game = new GameState(canvas, ctx);

  UIManager.onDifficultyChange((value) => game.setDifficulty(value));
  UIManager.onFactionChange((value) => game.setFaction(value));
  UIManager.onDeathToggle((enabled) => game.setDeathAllowed(enabled));
  UIManager.setDeathAllowed(game.allowDeath);

  Engine.init({
    update: (dt) => {
      game.update(dt);
      tickNet(dt);
    },
    render: () => {
      game.render();
    }
  });
  Engine.start();

  setupNetUI();
}

window.addEventListener("resize", resizeCanvas);
window.addEventListener("load", init);

// ---- Networking UI wiring (dual-player) ----
function setupNetUI() {
  const el = (id) => document.getElementById(id);
  const netLog = el("netLog");
  const log = (t) => {
    if (!netLog) return;
    netLog.textContent += t + "\n";
    netLog.scrollTop = netLog.scrollHeight;
  };
  const setStatus = (self, host, peer) => {
    el("netSelf").textContent = self || "-";
    el("netHost").textContent = host || "-";
    el("netPeer").textContent = peer || "-";
  };

  net = new WebRTCClient({
    log,
    onPeerReady: (peer) => {
      el("netSend").disabled = false;
      updateControlButtons();
      setStatus(net.selfId, net.hostId, `${peer.nickname} (${peer.id})`);
    },
    onHostChanged: (hostId, hostNick) => {
      setStatus(net.selfId, `${hostNick || hostId}`, el("netPeer").textContent);
      updateControlButtons();
    },
    onChat: (msg, peer) => log(`對方(${peer.nickname || peer.id})：${msg.text}`),
    onControl: (msg, peer) => log(`控制：${msg.action} from ${peer.nickname || peer.id}`),
    onState: (msg) => handleState(msg),
    onInput: (msg) => handleRemoteInput(msg),
    onDelta: () => {},
    onFire: () => {},
    onDamage: () => {}
  });

  const connectBtn = el("netConnect");
  const sendBtn = el("netSend");
  const chatInput = el("netChat");
  const startBtn = el("netStart");
  const pauseBtn = el("netPause");
  const resumeBtn = el("netResume");
  const endBtn = el("netEnd");

  connectBtn?.addEventListener("click", () => {
    setStatus("-", "-", "-");
    log("---- 重新連線 ----");
    net.connect({
      wsUrl: el("netWs").value,
      room: el("netRoom").value,
      nickname: el("netNick").value,
      mode: document.querySelector("input[name='netMode']:checked")?.value || "client"
    });
  });

  sendBtn?.addEventListener("click", () => {
    const text = chatInput.value.trim();
    if (!text) return;
    net.sendReliable({ type: "chat", text, from: net.selfId, nickname: net.selfNick, ts: Date.now() });
    log(`我：${text}`);
    chatInput.value = "";
  });

  startBtn?.addEventListener("click", () => {
    net.sendReliable({ type: "control", action: "start", ts: Date.now(), from: net.selfId });
    log("開始（已廣播）");
  });
  pauseBtn?.addEventListener("click", () => {
    net.sendReliable({ type: "control", action: "pause", ts: Date.now(), from: net.selfId });
    log("暫停（已廣播）");
  });
  resumeBtn?.addEventListener("click", () => {
    net.sendReliable({ type: "control", action: "resume", ts: Date.now(), from: net.selfId });
    log("續玩（已廣播）");
  });
  endBtn?.addEventListener("click", () => {
    net.sendReliable({ type: "control", action: "end", ts: Date.now(), from: net.selfId });
    log("結束（已廣播）");
  });

  function updateControlButtons() {
    const isHost = net && net.selfId && net.hostId && net.selfId === net.hostId;
    const peerReady = !!(net && net.peer && net.peer.reliable && net.peer.reliable.readyState === "open");
    startBtn.disabled = !(isHost && peerReady);
    pauseBtn.disabled = !isHost;
    resumeBtn.disabled = !isHost;
    endBtn.disabled = !isHost;
  }
}

// ---- Net sync skeleton (host authoritative, placeholder rendering) ----
function tickNet(dt) {
  if (!net || !net.peer) return;
  const isHost = net.selfId && net.hostId && net.selfId === net.hostId;
  if (isHost) {
    // integrate remote ghost based on last remote input
    if (netState.remoteInput) {
      if (!netState.remoteGhost) {
        netState.remoteGhost = {
          x: canvas.width / 2,
          y: canvas.height * 0.25,
          angle: 0,
          vx: 0,
          vy: 0,
          color: "#e04545",
          nickname: net.peer?.nickname || "Client"
        };
      }
      integrateGhost(netState.remoteGhost, netState.remoteInput, dt);
    }
    // send host + remote ghost state at 20Hz
    netState.lastStateSend += dt;
    if (netState.lastStateSend >= 0.05) {
      netState.lastStateSend = 0;
      const hostSnap = snapshotPlayer(game.player, net.selfNick);
      const clientSnap = netState.remoteGhost ? snapshotGhost(netState.remoteGhost) : null;
      game.setRemotePlayer(clientSnap && { ...clientSnap, color: "#e04545" });
      net.sendReliable({
        type: "state",
        ts: Date.now(),
        host: hostSnap,
        client: clientSnap
      });
    }
  } else {
    // client sends input fast
    const input = collectLocalInput();
    net.sendFast({
      type: "input",
      ts: Date.now(),
      ...input
    });
  }
}

function collectLocalInput() {
  const thrustForward = Input.isThrustForward();
  const thrustBackward = Input.isThrustBackward();
  const turnLeft = Input.isTurnLeft();
  const turnRight = Input.isTurnRight();
  const moveAngle = Input.getDirectionAngle();
  return { thrustForward, thrustBackward, turnLeft, turnRight, moveAngle };
}

function integrateGhost(ghost, input, dt) {
  const speed = GAME_CONFIG.player.baseMoveSpeed || 220;
  const turnSpeed = 3;
  if (input.turnLeft) ghost.angle -= turnSpeed * dt;
  if (input.turnRight) ghost.angle += turnSpeed * dt;
  let thrust = 0;
  if (input.thrustForward) thrust += 1;
  if (input.thrustBackward) thrust -= 0.6;
  const moveAng = input.moveAngle != null ? input.moveAngle : ghost.angle - Math.PI / 2;
  ghost.vx = Math.cos(moveAng) * speed * thrust;
  ghost.vy = Math.sin(moveAng) * speed * thrust;
  ghost.x += ghost.vx * dt;
  ghost.y += ghost.vy * dt;
  // clamp to canvas
  ghost.x = Math.max(20, Math.min(canvas.width - 20, ghost.x));
  ghost.y = Math.max(20, Math.min(canvas.height - 20, ghost.y));
}

function snapshotPlayer(p, nickname = "") {
  if (!p) return null;
  return {
    x: p.x,
    y: p.y,
    angle: p.angle,
    hp: p.hp ?? 0,
    shield: getShieldValue(p),
    radius: GAME_CONFIG.player.radius || 18,
    nickname
  };
}

function snapshotGhost(g) {
  if (!g) return null;
  return {
    x: g.x,
    y: g.y,
    angle: g.angle,
    hp: g.hp ?? 0,
    nickname: g.nickname || "",
    radius: g.radius || 18
  };
}

function handleRemoteInput(msg) {
  netState.remoteInput = msg;
}

function handleState(msg) {
  const isHost = net && net.selfId && net.hostId && net.selfId === net.hostId;
  if (isHost) return; // host不用處理自己的下行
  netState.hostGhost = msg.host || null;
  netState.remoteGhost = msg.client || null;
  const snap = msg.host ? { ...msg.host, color: "#2d7bff", nickname: msg.host.nickname || "Host" } : null;
  game.setRemotePlayer(snap);
}

function getShieldValue(player) {
  if (!player) return 0;
  if (Array.isArray(player.shieldSectors)) {
    return player.shieldSectors.reduce((sum, v) => sum + v, 0);
  }
  return player.shield || 0;
}
