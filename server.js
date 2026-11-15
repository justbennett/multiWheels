const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const Sim = require('./public/sim.js');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

// ---- Static files (index.html, sim.js, sketch.js) ----
const server = http.createServer((req, res) => {
  const urlPath = req.url.split('?')[0];
  const file = path.normalize(path.join(PUBLIC, urlPath === '/' ? 'index.html' : urlPath));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

// ---- Matchmaking ----
const wss = new WebSocketServer({ server, maxPayload: 1024 });
let waiting = null;

const send = (ws, msg) => { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); };

wss.on('connection', (ws) => {
  ws.room = null;
  ws.index = null;

  if (waiting && waiting.readyState === 1) {
    startRoom(waiting, ws);
    waiting = null;
  } else {
    waiting = ws;
    send(ws, { type: 'waiting' });
  }

  ws.on('message', (raw) => {
    if (!ws.room) return;
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (m.type === 'input') {
      // Only trust booleans, and only write to this socket's own wheel.
      ws.room.world.wheels[ws.index].input = {
        left: m.left === true, right: m.right === true, boost: m.boost === true,
      };
    }
  });

  ws.on('close', () => {
    if (waiting === ws) waiting = null;
    if (ws.room) endRoom(ws.room);
  });
});

// ---- One room = one world + one 60 Hz loop ----

// WORLD=1 node server.js pins a world for testing. Otherwise a random one is picked.
function chooseWorldIndex() {
  const pinnedWorld = Number(process.env.WORLD);
  if (Number.isInteger(pinnedWorld) && pinnedWorld >= 0 && pinnedWorld < Sim.WORLDS.length) return pinnedWorld;
  return Math.floor(Math.random() * Sim.WORLDS.length);
}

function startRoom(a, b) {
  const worldIndex = chooseWorldIndex();
  const room = { world: Sim.createWorld(worldIndex, 2), players: [a, b], timer: null, over: false };
  room.players.forEach((ws, i) => {
    ws.room = room;
    ws.index = i;
    send(ws, { type: 'start', you: i, world: worldIndex, size: { width: Sim.W, height: Sim.H } });
  });

  let last = Date.now(), acc = 0, tick = 0;
  room.timer = setInterval(() => {
    const now = Date.now();
    acc = Math.min(acc + (now - last), 250); // cap so a stall can't trigger a huge catch-up
    last = now;
    while (acc >= Sim.STEP_MS) {
      Sim.step(room.world);
      acc -= Sim.STEP_MS;
      tick++;
      if (tick % 2 === 0) { // snapshots at 30 Hz
        const msg = { type: 'state', serverTime: tick * Sim.STEP_MS, wheels: Sim.snapshot(room.world) };
        room.players.forEach((ws) => send(ws, msg));
      }
    }
  }, 8);
}

function endRoom(room) {
  if (room.over) return;
  room.over = true;
  clearInterval(room.timer);
  for (const ws of room.players) {
    send(ws, { type: 'opponent_left' });
    ws.room = null;
    ws.close();
  }
}

server.listen(PORT, () => console.log(`http://localhost:${PORT}`));