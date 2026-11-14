const INTERP_DELAY = 100; // ms. Draw the world this far in the past so there are always two snapshots to blend.
const COLORS = ['#4a90d9', '#e8833a'];

let ws;
let myIndex = null;
let status = 'Connecting...';
let snapshots = [];
let lastSent = '';
let currentWalls = Sim.WORLDS[0].walls;
const touchInput = { left: false, right: false, flap: false };

function setup() {
  createCanvas(windowWidth, windowHeight);
  setupTouchControls();
  connect();
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);

  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type === 'waiting') {
      status = "Waiting for an opponent...Have someone else go to http://<THIS COMPUTER'S IP>:3000 to join.";
    } else if (m.type === 'start') {
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
      snapshots.push({ t: performance.now(), wheels: m.wheels });
      if (snapshots.length > 30) snapshots.shift();
    } else if (m.type === 'opponent_left') {
      status = 'Opponent left. Refresh to find a new match.';
      myIndex = null;
    }
  };
  ws.onclose = () => {
    if (!status.startsWith('Opponent')) status = 'Disconnected. Refresh to reconnect.';
    myIndex = null;
  };
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
}

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

  for (const w of currentWalls) line(w.x1, w.y1, w.x2, w.y2);

  // Each wheel is drawn once. When it wraps it slides fully off one side, is hidden by the clip
  // while it crosses the margin, then slides in from the other side.
  if (wheels) wheels.forEach((w, i) => drawWheel(w, COLORS[i], i === myIndex));

  drawingContext.restore();
  pop();

  if (status) {
    noStroke(); fill(0); textAlign(CENTER, CENTER); textSize(16);
    text(status, width / 2, height / 4);
    stroke(0);
  }
}

// On-screen buttons (defined in index.html). Each button flips one flag in touchInput while a
// finger is on it. Pointer events handle several fingers at once, so steering and flapping can
// happen together. Add ?touch to the URL to show the buttons on a desktop for mouse testing.
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

// Send inputs only when they change. TCP delivers in order, so nothing needs resending.
function sendInput() {
  if (myIndex === null || ws.readyState !== WebSocket.OPEN) return;
  const msg = JSON.stringify({
    type: 'input',
    left:  keyIsDown('KeyA') || keyIsDown('ArrowLeft') || touchInput.left,
    right: keyIsDown('KeyD') || keyIsDown('ArrowRight') || touchInput.right,
    flap:  keyIsDown('KeyW') || keyIsDown('ArrowUp') || keyIsDown('Space') || touchInput.flap,
  });
  if (msg !== lastSent) { ws.send(msg); lastSent = msg; }
}

// Blend the two snapshots that surround (now - INTERP_DELAY).
function sampleState() {
  if (snapshots.length === 0) return null;
  const renderT = performance.now() - INTERP_DELAY;
  while (snapshots.length > 2 && snapshots[1].t <= renderT) snapshots.shift();
  if (snapshots.length === 1) return snapshots[0].wheels;

  const [a, b] = snapshots;
  const k = constrain((renderT - a.t) / (b.t - a.t), 0, 1); // clamped: never extrapolate
  return a.wheels.map((wa, i) => {
    const wb = b.wheels[i];
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

function keyPressed() {
  if ([' ', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(key)) return false; // stop page scroll
}