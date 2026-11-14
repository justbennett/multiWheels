// Shared physics. Plain JS with no p5, so the same file runs in the browser and in Node.
(function (root) {
  const W = 600, H = 270, GROUND = 15; // 20:9 world, like a wide phone in landscape. Every device scales this same area to fit.
  const GRAVITY = 0.2, MOVE_ACCEL = 0.1, MAX_SPEED_X = 5, AIR_DRAG = 0.985, FLAP = 1.5;
  const STEP_MS = 1000 / 60; // fixed timestep: one step() = one 60 Hz tick

  // Wrapping: a wheel that leaves one side of the screen re-enters from the other. It lives in a
  // range WRAP_MARGIN wider than the screen on each side, so it is fully off-screen (hidden) for a
  // moment before it reappears. WRAP_MARGIN must be at least the wheel radius (10), or the wheel
  // would still be visible when it jumps. A bigger margin means a longer time out of sight.
  const WRAP_MARGIN = 20;
  const WRAP_PERIOD = W + 2 * WRAP_MARGIN;

  // A world is plain data: walls plus one spawn point per player slot (up to 4).
  // Every wall has a type so hazards and other kinds can be added later.
  const WORLDS = [
    {
      name: 'Ledge',
      walls: [
        { x1: -WRAP_MARGIN, y1: H - GROUND, x2: W + WRAP_MARGIN, y2: H - GROUND, type: 'solid' }, // floor
        { x1: -WRAP_MARGIN, y1: 0,          x2: W + WRAP_MARGIN, y2: 0,          type: 'solid' }, // ceiling
        { x1: W / 4, y1: H / 2,      x2: W * 3 / 4, y2: H / 2,      type: 'solid' }, // ledge
      ],
      spawnPoints: [
        { x: W / 2 - 30, y: H / 2 - 30 }, { x: W / 2 + 30, y: H / 2 - 30 },
        { x: W / 2 - 90, y: H / 2 - 30 }, { x: W / 2 + 90, y: H / 2 - 30 },
      ],
    },
    {
      name: 'Two Ledges',
      walls: [
        { x1: -WRAP_MARGIN, y1: H - GROUND, x2: W + WRAP_MARGIN, y2: H - GROUND, type: 'solid' }, // floor
        { x1: -WRAP_MARGIN, y1: 0,          x2: W + WRAP_MARGIN, y2: 0,          type: 'solid' }, // ceiling
        { x1: W * 0.1,   y1: H * 0.65, x2: W * 0.425, y2: H * 0.65, type: 'solid' }, // left ledge
        { x1: W * 0.575, y1: H * 0.65, x2: W * 0.9,   y2: H * 0.65, type: 'solid' }, // right ledge
        { x1: W * 0.375, y1: H * 0.35, x2: W * 0.625, y2: H * 0.35, type: 'solid' }, // high middle ledge
      ],
      spawnPoints: [
        { x: W / 2 - 30, y: H * 0.25 }, { x: W / 2 + 30, y: H * 0.25 },
        { x: W / 2 - 90, y: H * 0.25 }, { x: W / 2 + 90, y: H * 0.25 },
      ],
    },
  ];

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  function createWheel(id, x, y) {
    return {
      id, x, y, vx: 0, vy: 0, angle: 0,
      radius: 10, restitution: 0.75,
      // Inputs are data. Locally they come from the keyboard, on the server from the network.
      input: { left: false, right: false, flap: false },
    };
  }

  // worldIndex picks an entry from WORLDS. playerCount is how many wheels to create (1 to 4).
  function createWorld(worldIndex = 0, playerCount = 2) {
    const worldDefinition = WORLDS[worldIndex];
    const wheels = [];
    for (let i = 0; i < playerCount; i++) {
      const spawnPoint = worldDefinition.spawnPoints[i];
      wheels.push(createWheel(i, spawnPoint.x, spawnPoint.y));
    }
    return { worldIndex, walls: worldDefinition.walls, wheels };
  }

  function applyInput(w) {
    if (w.input.left)  w.vx -= MOVE_ACCEL;
    if (w.input.right) w.vx += MOVE_ACCEL;
    if (w.input.flap)  w.vy = -FLAP;
    w.vx *= AIR_DRAG;
    w.vx = clamp(w.vx, -MAX_SPEED_X, MAX_SPEED_X);
    w.angle += (w.vx / 90) * Math.PI;
  }

  function integrate(w) {
    w.vy += GRAVITY;
    w.x += w.vx;
    w.y += w.vy;
    // Wrap through the hidden margin. Both ends of the jump are off-screen, so it can't be seen.
    if (w.x < -WRAP_MARGIN) w.x += WRAP_PERIOD;
    if (w.x >= W + WRAP_MARGIN) w.x -= WRAP_PERIOD;
  }

  function collideWall(w, wall) {
    const dx = wall.x2 - wall.x1, dy = wall.y2 - wall.y1;
    const t = clamp(((w.x - wall.x1) * dx + (w.y - wall.y1) * dy) / (dx * dx + dy * dy), 0, 1);
    const cx = wall.x1 + t * dx, cy = wall.y1 + t * dy;
    let nx = w.x - cx, ny = w.y - cy;
    const d = Math.hypot(nx, ny);
    if (d > w.radius) return;
    if (d === 0) { nx = 0; ny = -1; } else { nx /= d; ny /= d; }

    w.x = cx + nx * w.radius;
    w.y = cy + ny * w.radius;

    const vn = w.vx * nx + w.vy * ny;
    if (vn < 0) {
      const j = (1 + w.restitution) * vn;
      w.vx -= nx * j;
      w.vy -= ny * j;
    }
    if (Math.abs(w.vy) < 0.5 && ny < -0.9) w.vy = 0;
    if (ny < -0.98) w.vx *= 0.98;
  }

  function collideWheels(a, b) {
    let dx = b.x - a.x;
    const dy = b.y - a.y;
    // Distance is measured the short way around the wrap.
    if (dx > WRAP_PERIOD / 2) dx -= WRAP_PERIOD;
    else if (dx < -WRAP_PERIOD / 2) dx += WRAP_PERIOD;
    const d = Math.hypot(dx, dy);
    const minD = a.radius + b.radius;
    if (d >= minD) return;
    const nx = d === 0 ? 1 : dx / d;
    const ny = d === 0 ? 0 : dy / d;

    const half = (minD - d) / 2;
    a.x -= nx * half; a.y -= ny * half;
    b.x += nx * half; b.y += ny * half;

    const approach = (a.vx - b.vx) * nx + (a.vy - b.vy) * ny;
    if (approach <= 0) return;
    const e = (a.restitution + b.restitution) / 2; // average, so e stays at 0.75
    const j = (1 + e) * approach / 2;
    a.vx -= nx * j; a.vy -= ny * j;
    b.vx += nx * j; b.vy += ny * j;
  }

  // Advance the world by exactly one fixed tick.
  function step(world) {
    for (const w of world.wheels) { applyInput(w); integrate(w); }
    for (const w of world.wheels) for (const wall of world.walls) collideWall(w, wall);
    for (let i = 0; i < world.wheels.length; i++)
      for (let j = i + 1; j < world.wheels.length; j++)
        collideWheels(world.wheels[i], world.wheels[j]);
  }

  const r2 = (n) => Math.round(n * 100) / 100;
  function snapshot(world) {
    return world.wheels.map((w) => ({ x: r2(w.x), y: r2(w.y), angle: r2(w.angle) }));
  }

  const Sim = { W, H, STEP_MS, WRAP_MARGIN, WRAP_PERIOD, WORLDS, createWorld, step, snapshot };
  if (typeof module !== 'undefined' && module.exports) module.exports = Sim;
  else root.Sim = Sim;
})(typeof window !== 'undefined' ? window : globalThis);