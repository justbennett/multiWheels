/**
 * Delay used when sampling past snapshots for interpolation.
 * @const {number}
 */
const INTERP_DELAY = 100; // ms. Draw the world this far in the past so there are always two snapshots to blend.
/**
 * Player colors used for rendering up to 4 wheels.
 * @const {string[]}
 */
const COLORS = ['#4a90d9', '#e8833a', '#38a169', '#9b59b6'];

/**
 * Active WebSocket connection to the game server.
 * @type {WebSocket | null}
 */
let ws;
/**
 * Local player index in the current match.
 * @type {number | null}
 */
let myIndex = null;
/**
 * Status text displayed above the game area.
 * @type {string}
 */
let status = 'Connecting...';
/**
 * Current lobby state while waiting before the match starts, or null once in-game.
 * @type {{ worldIndex: number, worlds: { index: number, name: string }[], playerCount: number, maxPlayers: number, isHost: boolean } | null}
 */
let lobbyState = null;
/**
 * Recent network snapshots used for interpolation.
 * @type {{ t: number, wheels: { x: number, y: number, angle: number }[] }[]}
 */
let snapshots = [];
/**
 * Last serialized input message sent to the server.
 * @type {string}
 */
let lastSent = '';
/**
 * The wall segments for the current map.
 * @type {Array<{ x1: number, y1: number, x2: number, y2: number, type: string }>}
 */
let currentWalls = Sim.WORLDS[0].walls;
/**
 * Estimated offset between the client's clock and the server clock.
 * @type {number | null}
 */
let clockOffset = null;
/**
 * Virtual input state for touch controls.
 * @type {{ left: boolean, right: boolean, boost: boolean }}
 */
const touchInput = { left: false, right: false, boost: false };

/**
 * DOM container for pre-match lobby controls (world picker & start button).
 * @type {HTMLElement | null}
 */
let lobbyUiEl = null;

/**
 * Initialize the drawing canvas, lobby UI, and input listeners, then connect to the server.
 */
function setup() {
  createCanvas(windowWidth, windowHeight);
  setupLobbyUi();
  setupTouchControls();
  setupFullscreenButton();
  setupSteeringZone();
  connect();
}

/**
 * Create a lightweight floating overlay for selecting the world and starting the match.
 */
function setupLobbyUi() {
  lobbyUiEl = document.createElement('div');
  lobbyUiEl.id = 'lobby-ui';
  Object.assign(lobbyUiEl.style, {
    position: 'fixed',
    top: '50%',
    left: '50%',
    transform: 'translate(-50%, -50%)',
    background: 'rgba(255, 255, 255, 0.94)',
    color: '#111',
    padding: '20px 24px',
    borderRadius: '12px',
    boxShadow: '0 8px 28px rgba(0, 0, 0, 0.35)',
    display: 'none',
    flexDirection: 'column',
    gap: '12px',
    minWidth: '260px',
    zIndex: '20',
    fontFamily: 'sans-serif',
  });

  const title = document.createElement('div');
  title.id = 'lobby-players';
  title.style.fontWeight = 'bold';

  const label = document.createElement('label');
  label.textContent = 'World: ';
  label.htmlFor = 'world-select';

  const select = document.createElement('select');
  select.id = 'world-select';
  Sim.WORLDS.forEach((w, idx) => {
    const opt = document.createElement('option');
    opt.value = String(idx);
    opt.textContent = w.name;
    select.appendChild(opt);
  });
  select.addEventListener('change', () => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'select_world', worldIndex: Number(select.value) }));
  });

  const startBtn = document.createElement('button');
  startBtn.id = 'start-match-btn';
  startBtn.textContent = 'Start Match';
  startBtn.style.padding = '8px 14px';
  startBtn.style.cursor = 'pointer';
  startBtn.addEventListener('click', () => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'start_game' }));
  });

  label.appendChild(select);
  lobbyUiEl.append(title, label, startBtn);
  document.body.appendChild(lobbyUiEl);
}

/**
 * Sync the lobby overlay visibility and controls with `lobbyState`.
 */
function renderLobbyUi() {
  if (!lobbyUiEl) return;
  if (!lobbyState || myIndex !== null) {
    lobbyUiEl.style.display = 'none';
    return;
  }

  lobbyUiEl.style.display = 'flex';
  const playersEl = document.getElementById('lobby-players');
  const selectEl = document.getElementById('world-select');
  const startBtn = document.getElementById('start-match-btn');

  playersEl.textContent = `Players in lobby: ${lobbyState.playerCount} / ${lobbyState.maxPlayers} (You: P${lobbyState.you + 1})`;
  selectEl.value = String(lobbyState.worldIndex);
  selectEl.disabled = !lobbyState.isHost;
  startBtn.style.display = lobbyState.isHost ? 'block' : 'none';
}

/**
 * Open a WebSocket connection to the game server and route gameplay messages.
 */
function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);

  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type === 'lobby') {
      lobbyState = m;
      if (Sim.WORLDS[m.worldIndex]) currentWalls = Sim.WORLDS[m.worldIndex].walls;
      status = m.isHost
        ? 'Select a world and press Start Match (or wait for up to 4 players).'
        : `Waiting for host to start (${Sim.WORLDS[m.worldIndex]?.name ?? 'World'})...`;
      renderLobbyUi();
    } else if (m.type === 'start') {
      lobbyState = null;
      renderLobbyUi();
      myIndex = m.you;
      status = '';
      if (Sim.WORLDS[m.world]) currentWalls = Sim.WORLDS[m.world].walls;
      // Node loads sim.js once at startup, so an old server process keeps running old physics
      // after the files change. An old server sends no world or size, which gives it away.
      const sizeMatches = m.size && m.size.width === Sim.W && m.size.height === Sim.H;
      if (m.world === undefined || !sizeMatches) {
        status = 'Server and page are out of sync. Restart the server, then refresh.';
      }
      snapshots = [];
      lastSent = '';
    } else if (m.type === 'state') {
      const arrivalTime = performance.now();
      const rawOffset = arrivalTime - m.serverTime; // network delay plus the gap between the two clocks
      if (clockOffset === null || rawOffset < clockOffset) clockOffset = rawOffset; // fastest packet reads truest
      else clockOffset += (rawOffset - clockOffset) * 0.01;                        // creep up if delay really rises
      snapshots.push({ t: m.serverTime, wheels: m.wheels });
      if (snapshots.length > 30) snapshots.shift();
    } else if (m.type === 'player_left') {
      myIndex = m.you;
      snapshots = [];
      lastSent = '';
      status = `Player ${m.leftSlot + 1} left (${m.playerCount} remaining).`;
      setTimeout(() => {
        if (myIndex !== null && status.startsWith('Player ')) status = '';
      }, 2500);
    } else if (m.type === 'full') {
      lobbyState = null;
      renderLobbyUi();
      status = 'Room is full (4/4 players). Try again shortly.';
      myIndex = null;
    } else if (m.type === 'opponent_left') {
      lobbyState = null;
      renderLobbyUi();
      status = 'Match ended. Refresh to join a new lobby.';
      myIndex = null;
    }
  };
  ws.onclose = () => {
    lobbyState = null;
    renderLobbyUi();
    if (!status.startsWith('Match ended') && !status.startsWith('Room is full')) {
      status = 'Disconnected. Refresh to reconnect.';
    }
    myIndex = null;
  };
}

/**
 * Resize the canvas when the browser window changes size.
 */
function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
}

/**
 * Set up the fullscreen button if the browser supports it.
 */
function setupFullscreenButton() {
  const fullscreenButton = document.getElementById('fullscreen-button');
  const page = document.documentElement;
  const enterFullscreen = page.requestFullscreen || page.webkitRequestFullscreen;
  const alreadyFullscreen = window.matchMedia('(display-mode: fullscreen), (display-mode: standalone)').matches
    || navigator.standalone;

  // Hide the button where it can't work (iPhone) or isn't needed (installed app).
  if (!enterFullscreen || alreadyFullscreen) { fullscreenButton.style.display = 'none'; return; }

  fullscreenButton.addEventListener('click', async () => {
    try {
      if (document.fullscreenElement || document.webkitFullscreenElement) {
        (document.exitFullscreen || document.webkitExitFullscreen).call(document);
      } else {
        await enterFullscreen.call(page);
        if (screen.orientation && screen.orientation.lock) {
          await screen.orientation.lock('landscape').catch(() => {}); // not every browser allows it
        }
      }
    } catch (error) {
      console.warn('Fullscreen was refused', error);
    }
  });
}

/**
 * Render the current frame, including interpolated world state and HUD overlays.
 */
function draw() {
  background(30); // the bars around the game area when the window's shape differs from the world's

  // Fit the whole world inside the window without stretching it, so every player sees the same area.
  const zoom = Math.min(width / Sim.W, height / Sim.H);
  const offsetX = (width - Sim.W * zoom) / 2;
  const offsetY = (height - Sim.H * zoom) / 2;

  sendInput();
  const wheels = sampleState();

  push();
  translate(offsetX, offsetY);
  scale(zoom);

  // Clip to the world so nothing draws out in the bars.
  drawingContext.save();
  drawingContext.beginPath();
  drawingContext.rect(0, 0, Sim.W, Sim.H);
  drawingContext.clip();

  push();
  noStroke();
  fill(220);
  rect(0, 0, Sim.W, Sim.H);
  pop();

  for (const w of currentWalls) {
    push();
    switch (w.type) {
      case 'solid': stroke(100); break;
      case 'grip':  stroke('#07144F'); fill('#000000'); break;
      case 'ice':   stroke('#00C8C8'); fill('#08AAAA'); break;
      case 'fire':  stroke('#840202'); fill('#FF7300'); break;
      default:      stroke(150); break;
    }
    let dy = w.y2 - w.y1;
    let dx = w.x2 - w.x1;
    let angle = Math.atan2(dy, dx);
    let length = Math.sqrt(dx * dx + dy * dy);
    translate(w.x1, w.y1);
    rotate(angle);
    strokeWeight(1);
    rect(0, 0, length, 2, 0.5);
    pop();
  }
  if (wheels) wheels.forEach((w, i) => drawWheel(w, COLORS[i] || '#666', i === myIndex));

  drawingContext.restore();
  pop();

  if (status && !lobbyState) {
    push();
    fill(200, 200, 200, 150);
    rectMode(CENTER);
    noStroke(); rect(width / 2, height / 4, 1000, 60, 10);
    noStroke(); fill(0); textAlign(CENTER, CENTER); textSize(16);
    text(status, width / 2, height / 4);
    stroke(0);
    pop();
  }
}

/**
 * Attach pointer events to the on-screen touch controls and update the virtual input state.
 */
function setupTouchControls() {
  if (new URLSearchParams(location.search).has('touch')) document.body.classList.add('show-controls');

  for (const button of document.querySelectorAll('#controls button')) {
    const action = button.dataset.action;

    const press = (event) => {
      event.preventDefault();
      button.setPointerCapture(event.pointerId); // keep receiving events even if the finger slides off
      touchInput[action] = true;
      button.classList.add('held');
    };
    const release = () => {
      touchInput[action] = false;
      button.classList.remove('held');
    };

    button.addEventListener('pointerdown', press);
    button.addEventListener('pointerup', release);
    button.addEventListener('pointercancel', release);
    button.addEventListener('lostpointercapture', release);
    button.addEventListener('contextmenu', (event) => event.preventDefault()); // no long-press menu
  }
}

/**
 * Send the player's current input to the server when it changes.
 */
function sendInput() {
  if (myIndex === null || !ws || ws.readyState !== WebSocket.OPEN) return;
  const msg = JSON.stringify({
    type: 'input',
    left:  keyIsDown('KeyA') || keyIsDown('ArrowLeft') || touchInput.left,
    right: keyIsDown('KeyD') || keyIsDown('ArrowRight') || touchInput.right,
    boost: keyIsDown('KeyW') || keyIsDown('ArrowUp') || keyIsDown('Space') || touchInput.boost,
  });
  if (msg !== lastSent) { ws.send(msg); lastSent = msg; }
}

/**
 * Blend the two snapshots that surround the current render time.
 * @returns {{ x: number, y: number, angle: number }[] | null}
 */
function sampleState() {
  if (snapshots.length === 0 || clockOffset === null) return null;
  const renderT = performance.now() - clockOffset - INTERP_DELAY;
  while (snapshots.length > 2 && snapshots[1].t <= renderT) snapshots.shift();
  if (snapshots.length === 1) return snapshots[0].wheels;

  const [a, b] = snapshots;
  const k = constrain((renderT - a.t) / (b.t - a.t), 0, 1); // clamped: never extrapolate
  return a.wheels.map((wa, i) => {
    const wb = b.wheels[i];
    if (!wb) return wa;
    // x wraps around, so blend the shorter way around, which may cross the wrap.
    let deltaX = wb.x - wa.x;
    if (deltaX > Sim.WRAP_PERIOD / 2) deltaX -= Sim.WRAP_PERIOD;
    else if (deltaX < -Sim.WRAP_PERIOD / 2) deltaX += Sim.WRAP_PERIOD;
    let blendedX = wa.x + deltaX * k;
    if (blendedX < -Sim.WRAP_MARGIN) blendedX += Sim.WRAP_PERIOD;
    if (blendedX >= Sim.W + Sim.WRAP_MARGIN) blendedX -= Sim.WRAP_PERIOD;
    return { x: blendedX, y: lerp(wa.y, wb.y, k), angle: lerp(wa.angle, wb.angle, k) };
  });
}

/**
 * Draw a single wheel including its facing marker and self-label.
 * @param {{ x: number, y: number, angle: number }} w
 * @param {string} col
 * @param {boolean} isMe
 */
function drawWheel(w, col, isMe) {
  const r = 10;
  push();
  translate(w.x, w.y);
  fill(col);
  circle(0, 0, r * 2);
  noFill();
  circle(0, 0, r * 1.7);
  rotate(w.angle);
  for (let i = 0; i <= 8; i++) {
    line(-r, 0, 0, 0);
    rotate(QUARTER_PI);
  }
  pop();
  if (isMe) { noStroke(); fill(0); textAlign(CENTER); textSize(10); text('YOU', w.x, w.y - 16); stroke(0); }
}

/**
 * Steering zone sensitivity settings.
 * @const {number}
 */
const STEER_DEADZONE_PX = 10;    // slide less than this and the wheel doesn't steer
/**
 * Maximum distance the steering knob can travel before its anchor follows the finger.
 * @const {number}
 */
const STEER_MAX_TRAVEL_PX = 45;  // past this, the starting point follows the finger so reversing is quick

/**
 * Initialize the virtual steering pad for touch controls.
 */
function setupSteeringZone() {
  const steerZone = document.getElementById('steer-zone');
  const ring = steerZone.querySelector('.ring');
  const knob = steerZone.querySelector('.knob');
  let activePointerId = null;
  let anchorX = 0;

  steerZone.addEventListener('pointerdown', (event) => {
    if (activePointerId !== null) return; // already steering with another finger
    event.preventDefault();
    activePointerId = event.pointerId;
    steerZone.setPointerCapture(event.pointerId);
    anchorX = event.clientX;
    for (const element of [ring, knob]) {
      element.style.left = event.clientX + 'px';
      element.style.top = event.clientY + 'px';
    }
    steerZone.classList.add('active');
  });

  steerZone.addEventListener('pointermove', (event) => {
    if (event.pointerId !== activePointerId) return;
    let slideX = event.clientX - anchorX;

    // Past the max travel, drag the anchor along so the finger is never far from it.
    if (slideX > STEER_MAX_TRAVEL_PX) { anchorX = event.clientX - STEER_MAX_TRAVEL_PX; slideX = STEER_MAX_TRAVEL_PX; }
    else if (slideX < -STEER_MAX_TRAVEL_PX) { anchorX = event.clientX + STEER_MAX_TRAVEL_PX; slideX = -STEER_MAX_TRAVEL_PX; }

    touchInput.left = slideX < -STEER_DEADZONE_PX;
    touchInput.right = slideX > STEER_DEADZONE_PX;
    ring.style.left = anchorX + 'px';
    knob.style.left = (anchorX + slideX) + 'px';
  });

  const stopSteering = (event) => {
    if (event.pointerId !== activePointerId) return;
    activePointerId = null;
    touchInput.left = false;
    touchInput.right = false;
    steerZone.classList.remove('active');
    for (const element of [ring, knob]) { element.style.left = ''; element.style.top = ''; } // back to the resting spot
  };
  steerZone.addEventListener('pointerup', stopSteering);
  steerZone.addEventListener('pointercancel', stopSteering);
  steerZone.addEventListener('lostpointercapture', stopSteering);
  steerZone.addEventListener('contextmenu', (event) => event.preventDefault());
}

/**
 * Prevent the page from scrolling while arrow keys or space are used for steering.
 * @returns {boolean}
 */
function keyPressed() {
  if ([' ', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(key)) return false; // stop page scroll
}