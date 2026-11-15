const INTERP_DELAY = 100; // ms. Draw the world this far in the past so there are always two snapshots to blend.
const COLORS = ['#4a90d9', '#e8833a'];

let ws;
let myIndex = null;
let status = 'Connecting...';
let snapshots = [];
let lastSent = '';
let currentWalls = Sim.WORLDS[0].walls;
let clockOffset = null;
const touchInput = { left: false, right: false, boost: false };

function setup() {
  createCanvas(windowWidth, windowHeight);
  setupTouchControls();
  setupFullscreenButton();
  setupSteeringZone();
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
      const arrivalTime = performance.now();
      const rawOffset = arrivalTime - m.serverTime; // network delay plus the gap between the two clocks
      if (clockOffset === null || rawOffset < clockOffset) clockOffset = rawOffset; // fastest packet reads truest
      else clockOffset += (rawOffset - clockOffset) * 0.01;                        // creep up if delay really rises
      snapshots.push({ t: m.serverTime, wheels: m.wheels });
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
    push();
    fill(200,200,200,150);
    rectMode(CENTER); 
    noStroke(); rect(width / 2, height / 4, 1000, 60, 10);
    noStroke(); fill(0); textAlign(CENTER, CENTER); textSize(16);
    text(status, width / 2, height / 4);
    stroke(0);
    pop();
  }
}

// On-screen buttons (defined in index.html). Each button flips one flag in touchInput while a
// finger is on it. Pointer events handle several fingers at once, so steering and boostping can
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
    boost:  keyIsDown('KeyW') || keyIsDown('ArrowUp') || keyIsDown('Space') || touchInput.boost,
  });
  if (msg !== lastSent) { ws.send(msg); lastSent = msg; }
}

// Blend the two snapshots that surround (now - INTERP_DELAY).
function sampleState() {
  if (snapshots.length === 0 || clockOffset === null) return null;
  const renderT = performance.now() - clockOffset - INTERP_DELAY;
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

const STEER_DEADZONE_PX = 10;    // slide less than this and the wheel doesn't steer
const STEER_MAX_TRAVEL_PX = 45;  // past this, the starting point follows the finger so reversing is quick

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

function keyPressed() {
  if ([' ', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(key)) return false; // stop page scroll
}