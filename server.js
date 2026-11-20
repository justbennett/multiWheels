const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const Sim = require('./public/sim.js');

/**
 * The port the server listens on.
 * @type {number}
 */
const PORT = process.env.PORT || 3000;
/**
 * Directory containing the static browser assets.
 * @type {string}
 */
const PUBLIC = path.join(__dirname, 'public');
/**
 * MIME types used for serving static files.
 * @type {Record<string, string>}
 */
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
/**
 * Maximum number of players allowed in a match.
 * @type {number}
 */
const MAX_PLAYERS = 4;
/**
 * Countdown duration in milliseconds before simulation ticks start.
 * @type {number}
 */
const COUNTDOWN_MS = 3000;

/**
 * Create the HTTP server and serve static files from the public folder.
 * @type {http.Server}
 */
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

/**
 * WebSocket server used for lobby and gameplay synchronization.
 * @type {WebSocketServer}
 */
const wss = new WebSocketServer({ server, maxPayload: 1024 });

/**
 * Send a JSON message through a socket if it is still open.
 * @param {WebSocket | null | undefined} ws
 * @param {object} msg
 */
const send = (ws, msg) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); };

/**
 * Available world options sent to lobby clients.
 * @type {{ index: number, name: string }[]}
 */
const worldOptions = Sim.WORLDS.map((w, index) => ({ index, name: w.name }));

/**
 * Resolve the starting world index from WORLD env var if valid, else 0.
 * @returns {number}
 */
function resolveInitialWorldIndex() {
  const pinnedWorld = Number(process.env.WORLD);
  if (Number.isInteger(pinnedWorld) && pinnedWorld >= 0 && pinnedWorld < Sim.WORLDS.length) {
    return pinnedWorld;
  }
  return 0;
}

/**
 * Create a fresh pre-match lobby state.
 * @returns {{ worldIndex: number, players: WebSocket[] }}
 */
function createLobby() {
  return {
    worldIndex: resolveInitialWorldIndex(),
    players: [],
  };
}

let lobby = createLobby();

/**
 * Broadcast current lobby state to all sockets in the lobby.
 */
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

/**
 * Start a match with a 3-second countdown before the simulation begins stepping.
 * @param {{ worldIndex: number, players: WebSocket[] }} currentLobby
 */
function launchMatch(currentLobby) {
  const players = currentLobby.players.filter((ws) => ws.readyState === 1);
  if (players.length === 0) return;

  const worldIndex = currentLobby.worldIndex;
  const room = {
    world: Sim.createWorld(worldIndex, players.length),
    players,
    timer: null,
    over: false,
    started: false,
    countdownMs: COUNTDOWN_MS,
    lastShownSec: Math.ceil(COUNTDOWN_MS / 1000),
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
      countdownMs: room.countdownMs,
    });
  });

  let last = Date.now(), acc = 0, countdownTick = 0, simTick = 0;
  room.timer = setInterval(() => {
    const now = Date.now();
    const elapsed = Math.min(now - last, 250);
    last = now;

    if (!room.started) {
      room.countdownMs = Math.max(0, room.countdownMs - elapsed);
      const shownSec = Math.ceil(room.countdownMs / 1000);
      if (shownSec !== room.lastShownSec && shownSec > 0) {
        room.lastShownSec = shownSec;
        for (const ws of room.players) {
          send(ws, { type: 'countdown', seconds: shownSec, remainingMs: room.countdownMs });
        }
      }

      if (room.countdownMs <= 0) {
        room.started = true;
        acc = 0;
        simTick = 0;
        for (const wheel of room.world.wheels) {
          wheel.input.boostPressed = false;
          wheel.boostQueued = false;
          wheel.boostWait = 0;
        }
        for (const ws of room.players) {
          send(ws, { type: 'go' });
        }
      }

      if (countdownTick++ % 12 === 0) {
        const msg = {
          type: 'state',
          serverTime: 0,
          wheels: Sim.snapshot(room.world),
          countdownMs: room.countdownMs,
        };
        for (const ws of room.players) send(ws, msg);
      }
      return;
    }

    acc = Math.min(acc + elapsed, 250);
    while (acc >= Sim.STEP_MS) {
      Sim.step(room.world);
      acc -= Sim.STEP_MS;
      simTick++;
      if (simTick % 2 === 0) { // 30 Hz snapshots
        const msg = {
          type: 'state',
          serverTime: simTick * Sim.STEP_MS,
          wheels: Sim.snapshot(room.world),
        };
        for (const ws of room.players) send(ws, msg);
      }
    }
  }, 8);
}

/**
 * Remove a socket from the active lobby and notify remaining players.
 * @param {WebSocket} ws
 */
function removeFromLobby(ws) {
  const idx = lobby.players.indexOf(ws);
  if (idx === -1) return;
  lobby.players.splice(idx, 1);
  ws.lobby = null;
  ws.slot = null;
  broadcastLobby();
}

/**
 * Mark a departing player's seat inactive without renumbering other seats.
 * @param {object} room
 * @param {WebSocket} ws
 */
function handlePlayerLeaveRoom(room, ws) {
  if (room.over) return;
  const seatSlot = ws.slot;
  ws.room = null;
  ws.slot = null;

  if (typeof seatSlot === 'number' && room.world.wheels[seatSlot]) {
    const wheel = room.world.wheels[seatSlot];
    wheel.active = false;
    wheel.vx = 0;
    wheel.vy = 0;
    wheel.spin = 0;
    wheel.input = { left: false, right: false, boost: false, boostPressed: false };
  }

  const activeCount = room.world.wheels.filter((w) => w.active).length;
  for (const p of room.players) {
    if (p && p.readyState === 1) {
      send(p, { type: 'player_left', leftSlot: seatSlot, playerCount: activeCount });
    }
  }

  if (activeCount === 0) {
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
    ws.close();
  }

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }

    if (ws.lobby) {
      if (m.type === 'select_world' && ws.slot === 0) {
        if (Number.isInteger(m.worldIndex) && m.worldIndex >= 0 && m.worldIndex < Sim.WORLDS.length) {
          ws.lobby.worldIndex = m.worldIndex;
          broadcastLobby();
        }
      } else if (m.type === 'start_game' && ws.slot === 0 && ws.lobby.players.length >= 1) {
        const startingLobby = ws.lobby;
        if (startingLobby === lobby) lobby = createLobby();
        launchMatch(startingLobby);
      }
      return;
    }

    if (!ws.room || ws.room.over) return;
    if (m.type === 'input') {
      const wheel = ws.room.world.wheels[ws.slot];
      if (!wheel || !wheel.active) return;
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

/**
 * Start the game server and log the listening URL.
 */
server.listen(PORT, () => console.log(`http://localhost:${PORT}`));