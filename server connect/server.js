const WebSocket = require('ws');
const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: PORT });

// rooms: Map<room, { peers: Map<id, ws>, hostId: string }>
const rooms = new Map();

const genId = () => Math.random().toString(16).slice(2, 10);

function joinRoom(ws, data) {
  const room = data.room;
  const nickname = (data.nickname || '').trim() || 'Player';
  const mode = data.mode === 'host' ? 'host' : 'client';
  if (!rooms.has(room)) rooms.set(room, { peers: new Map(), hostId: null });
  const r = rooms.get(room);

  // 限制 2 人房，第三人直接拒絕
  if (r.peers.size >= 2) {
    ws.send(JSON.stringify({ type: 'room-full' }));
    try { ws.close(); } catch {}
    return;
  }

  ws.id = genId();
  ws.room = room;
  ws.nickname = nickname;
  ws.mode = mode;

  if (!r.hostId) r.hostId = ws.id; // first joiner becomes host
  r.peers.set(ws.id, ws);

  // tell the new peer who is in the room and who is host
  ws.send(JSON.stringify({
    type: 'welcome',
    selfId: ws.id,
    hostId: r.hostId,
    hostNickname: r.peers.get(r.hostId)?.nickname || '',
    peers: Array.from(r.peers.entries())
      .filter(([id]) => id !== ws.id)
      .map(([id, peer]) => ({ id, nickname: peer.nickname, mode: peer.mode }))
  }));

  // notify others about the newcomer
  broadcast(room, { type: 'new-peer', id: ws.id, nickname, mode }, ws);
}

function leaveRoom(ws) {
  if (!ws.room) return;
  const r = rooms.get(ws.room);
  if (!r) return;

  r.peers.delete(ws.id);
  broadcast(ws.room, { type: 'leave', id: ws.id }, ws);

  // reassign host if needed
  if (r.hostId === ws.id) {
    const next = r.peers.keys().next().value || null;
    r.hostId = next || null;
    if (r.hostId) {
      const hostPeer = r.peers.get(r.hostId);
      broadcast(ws.room, { type: 'host-changed', hostId: r.hostId, hostNickname: hostPeer?.nickname || '' });
    }
  }

  if (r.peers.size === 0) rooms.delete(ws.room);
}

function broadcast(room, msg, exclude) {
  if (!rooms.has(room)) return;
  const s = JSON.stringify(msg);
  for (const client of rooms.get(room).peers.values()) {
    if (client !== exclude && client.readyState === WebSocket.OPEN) client.send(s);
  }
}

function directSend(room, toId, payload) {
  const r = rooms.get(room);
  if (!r) return;
  const target = r.peers.get(toId);
  if (target && target.readyState === WebSocket.OPEN) target.send(JSON.stringify(payload));
}

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let data;
    try { data = JSON.parse(raw); } catch { return; }

    if (data.type === 'join') { joinRoom(ws, data); return; }
    if (!ws.room) return;

    // signaling messages with explicit target
    if (['offer', 'answer', 'candidate'].includes(data.type) && data.to) {
      data.from = ws.id; // stamp sender to prevent spoof
      directSend(ws.room, data.to, data);
    }
  });

  ws.on('close', () => leaveRoom(ws));
  ws.on('error', () => leaveRoom(ws));
});

console.log(`Signaling server listening on ws://0.0.0.0:${PORT}`);
