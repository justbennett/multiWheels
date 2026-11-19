const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const Sim = require('./public/sim.js');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const MAX_PLAYERS = 4;

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

const wss = new WebSocketServer({ server, maxPayload: 1024 });

const send = (ws, msg) => {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
};

const worldOptions = Sim.WORLDS.map((w, index) => ({ index, name: w.name }));

function createLobby() {
  return {
    worldIndex: resolveInitialWorldIndex(),
    players: [], // up to MAX_PLAYERS open sockets in lobby
  };
}

function resolveInitialWorldIndex() {
  const pinnedWorld = Number(process.env.WORLD);
  if (Number.isInteger(pinnedWorld) && pinnedWorld >= 0 && pinnedWorld < Sim.WORLDS.length) {
    return pinnedWorld;
  }
  return 0;
}

let lobby = createLobby();

function broadcastLobby() {
  const payload = {
    type: 'lobby',
    worldIndex: lobby.worldIndex,
    worlds: worldOptions,
    playerCount: lobby.players.length,
    maxPlayers: MAX_PLAYERS,
    hostSlot: 0,
  };
  lobby.players.forEach((ws, slot) => {
    ws.slot = slot;
    send(ws, { ...payload, you: slot, isHost: slot === 0 });
  });
}

function launchMatch(currentLobby) {
  const players = currentLobby.players.filter((ws) => ws.readyState === 1);
  if (players.length === 0) return;

  const worldIndex = currentLobby.worldIndex;
  const room = {
    world: Sim.createWorld(worldIndex, players.length),
    players, // index i corresponds to world.wheels[i]
    timer: null,
    over: false,
  };

  players.forEach((ws, i) => {
    ws.lobby = null;
    ws.room = room;
    ws.slot = i;
    send(ws, {
      type: 'start',
      you: i,
      playerCount: players.length,
      world: worldIndex,
      size: { width: Sim.W, height: Sim.H },
    });
  });

  let last = Date.now(), acc = 0, tick = 0;
  room.timer = setInterval(() => {
    const now = Date.now();
    acc = Math.min(acc + (now - last), 250);
    last = now;
    while (acc >= Sim.STEP_MS) {
      Sim.step(room.world);
      acc -= Sim.STEP_MS;
      tick++;
      if (tick % 2 === 0) { // 30 Hz snapshots
        const msg = {
          type: 'state',
          serverTime: tick * Sim.STEP_MS,
          wheels: Sim.snapshot(room.world),
        };
        for (const ws of room.players) send(ws, msg);
      }
    }
  }, 8);
}

function removeFromLobby(ws) {
  const idx = lobby.players.indexOf(ws);
  if (idx === -1) return;
  lobby.players.splice(idx, 1);
  ws.lobby = null;
  ws.slot = null;
  broadcastLobby();
}

function handlePlayerLeaveRoom(room, ws) {
  if (room.over) return;
  const idx = room.players.indexOf(ws);
  if (idx === -1) return;

  room.players.splice(idx, 1);
  ws.room = null;
  ws.slot = null;

  // Remove the departed wheel so snapshot() stays aligned with active players
  if (room.world.wheels[idx]) {
    room.world.wheels.splice(idx, 1);
  }
  // Re-index remaining sockets so ws.slot matches room.world.wheels[ws.slot]
  room.players.forEach((p, i) => {
    p.slot = i;
    send(p, { type: 'player_left', leftSlot: idx, you: i, playerCount: room.players.length });
  });

  if (room.players.length === 0) {
    room.over = true;
    clearInterval(room.timer);
  }
}

wss.on('connection', (ws) => {
  ws.room = null;
  ws.lobby = null;
  ws.slot = null;

  if (lobby.players.length < MAX_PLAYERS) {
    lobby.players.push(ws);
    ws.lobby = lobby;
    broadcastLobby();

    if (lobby.players.length === MAX_PLAYERS) {
      const fullLobby = lobby;
      lobby = createLobby();
      launchMatch(fullLobby);
    }
  } else {
    send(ws, { type: 'full' });
    ws.close();
  }

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }

    // Pre-match messages
    if (ws.lobby) {
      if (m.type === 'select_world' && ws.slot === 0) {
        const nextWorld = Number(m.worldIndex);
        if (Number.isInteger(nextWorld) && nextWorld >= 0 && nextWorld < Sim.WORLDS.length) {
          ws.lobby.worldIndex = nextWorld;
          broadcastLobby();
        }
      } else if (m.type === 'start_game' && ws.slot === 0 && ws.lobby.players.length >= 1) {
        const startingLobby = ws.lobby;
        if (startingLobby === lobby) lobby = createLobby();
        launchMatch(startingLobby);
      }
      return;
    }

    // In-match messages
    if (!ws.room || ws.room.over) return;
    if (m.type === 'input') {
      const wheel = ws.room.world.wheels[ws.slot];
      if (!wheel) return;
      const wasBoosting = wheel.input.boost;
      wheel.input = {
        left: m.left === true,
        right: m.right === true,
        boost: m.boost === true,
        boostPressed: wheel.input.boostPressed || (m.boost === true && !wasBoosting),
      };
    }
  });

  ws.on('close', () => {
    if (ws.lobby) removeFromLobby(ws);
    if (ws.room) handlePlayerLeaveRoom(ws.room, ws);
  });
});

server.listen(PORT, () => console.log(`http://localhost:${PORT}`));