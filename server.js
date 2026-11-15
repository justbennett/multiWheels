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
 * WebSocket server used for matchmaking and gameplay synchronization.
 * @type {WebSocketServer}
 */
const wss = new WebSocketServer({ server, maxPayload: 1024 });
/**
 * The first waiting player queued for a match.
 * @type {WebSocket | null}
 */
let waiting = null;

/**
 * Send a JSON message through a socket if it is still open.
 * @param {WebSocket} ws
 * @param {object} msg
 */
const send = (ws, msg) => { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); };

/**
 * Handle a new client connection and either pair it with an existing waiting player or queue it.
 */
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

/**
 * Choose the world used for a room. Set WORLD=1 to pin a specific map during testing.
 * @returns {number}
 */
function chooseWorldIndex() {
  const pinnedWorld = Number(process.env.WORLD);
  if (Number.isInteger(pinnedWorld) && pinnedWorld >= 0 && pinnedWorld < Sim.WORLDS.length) return pinnedWorld;
  return Math.floor(Math.random() * Sim.WORLDS.length);
}

/**
 * Start a new match between two players and begin the simulation loop.
 * @param {WebSocket} a
 * @param {WebSocket} b
 */
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

/**
 * A running match between two players.
 * @typedef {object} Room
 * @property {object} world - Simulation state from Sim.createWorld.
 * @property {WebSocket[]} players - The two player connections, indexed by player slot.
 * @property {NodeJS.Timeout | null} timer - The setInterval handle for the tick loop.
 * @property {boolean} over - True once the room has been torn down.
 */

/**
 * Tear down a room and disconnect both players.
 * @param {Room} room - The room to end.
 */
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

/**
 * Start the game server and log the listening URL.
 */
server.listen(PORT, () => console.log(`http://localhost:${PORT}`));