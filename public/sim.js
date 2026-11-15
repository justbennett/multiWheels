// Shared physics. Plain JS with no p5, so the same file runs in the browser and in Node.
(function (root) {
  /**
   * World dimensions and ground height.
   * @const {number}
   */
  const W = 600, H = 270, GROUND = 15; // 20:9 world, like a wide phone in landscape. Every device scales this same area to fit.
  /**
   * Physics tuning values for movement, gravity, and boost behavior.
   * @const {number}
   */
  const GRAVITY = 0.2, MOVE_ACCEL = 0.1, MAX_SPEED_X = 5, AIR_DRAG = 0.985, BOOST = 1.5;
  /**
   * Fixed simulation timestep in milliseconds: one step() call equals one 60 Hz tick.
   * @const {number}
   */
  const STEP_MS = 1000 / 60;

  /**
   * Extra off-screen space used so wheels can wrap cleanly without being visible mid-transition.
   * The wheel remains hidden for a moment before reappearing on the other side.
   * @const {number}
   */
  const WRAP_MARGIN = 20;
  /**
   * Total horizontal span used when wrapping around the world.
   * @const {number}
   */
  const WRAP_PERIOD = W + 2 * WRAP_MARGIN;

  /**
   * @typedef {Object} Wall
   * @property {number} x1
   * @property {number} y1
   * @property {number} x2
   * @property {number} y2
   * @property {string} type
   */

  /**
   * @typedef {Object} WheelInput
   * @property {boolean} left
   * @property {boolean} right
   * @property {boolean} boost
   */

  /**
   * @typedef {Object} Wheel
   * @property {number} id
   * @property {number} x
   * @property {number} y
   * @property {number} vx
   * @property {number} vy
   * @property {number} angle
   * @property {number} radius
   * @property {number} restitution
   * @property {WheelInput} input
   */

  /**
   * @typedef {Object} SpawnPoint
   * @property {number} x
   * @property {number} y
   */

  /**
   * @typedef {Object} WorldDefinition
   * @property {string} name
   * @property {Wall[]} walls
   * @property {SpawnPoint[]} spawnPoints
   */

  /**
   * @typedef {Object} WorldState
   * @property {number} worldIndex
   * @property {Wall[]} walls
   * @property {Wheel[]} wheels
   */

  /**
   * A world is plain data: walls plus one spawn point per player slot (up to 4).
   * Every wall has a type so hazards and other kinds can be added later.
   * @type {WorldDefinition[]}
   */
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

  /**
   * Clamp a value to the inclusive range [lo, hi].
   * @param {number} v
   * @param {number} lo
   * @param {number} hi
   * @returns {number}
   */
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  /**
   * Create a wheel entity at a spawn point.
   * @param {number} id
   * @param {number} x
   * @param {number} y
   * @returns {Wheel}
   */
  function createWheel(id, x, y) {
    return {
      id, x, y, vx: 0, vy: 0, angle: 0,
      radius: 10, restitution: 0.75,
      // Inputs are data. Locally they come from the keyboard, on the server from the network.
      input: { left: false, right: false, boost: false },
    };
  }

  /**
   * Create a world state for a selected map and player count.
   * @param {number} [worldIndex=0] - Index into WORLDS.
   * @param {number} [playerCount=2] - Number of wheels to spawn, up to four.
   * @returns {WorldState}
   */
  function createWorld(worldIndex = 0, playerCount = 2) {
    const worldDefinition = WORLDS[worldIndex];
    const wheels = [];
    for (let i = 0; i < playerCount; i++) {
      const spawnPoint = worldDefinition.spawnPoints[i];
      wheels.push(createWheel(i, spawnPoint.x, spawnPoint.y));
    }
    return { worldIndex, walls: worldDefinition.walls, wheels };
  }

  /**
   * Apply the current input to a wheel's motion and rotation for one tick.
   * @param {Wheel} w
   */
  function applyInput(w) {
    if (w.input.left)  w.vx -= MOVE_ACCEL;
    if (w.input.right) w.vx += MOVE_ACCEL;
    if (w.input.boost)  w.vy = -BOOST;
    w.vx *= AIR_DRAG;
    w.vx = clamp(w.vx, -MAX_SPEED_X, MAX_SPEED_X);
    w.angle += (w.vx / 90) * Math.PI;
  }

  /**
   * Advance a wheel forward through one physics tick using gravity and wraparound.
   * @param {Wheel} w
   */
  function integrate(w) {
    w.vy += GRAVITY;
    w.x += w.vx;
    w.y += w.vy;
    // Wrap through the hidden margin. Both ends of the jump are off-screen, so it can't be seen.
    if (w.x < -WRAP_MARGIN) w.x += WRAP_PERIOD;
    if (w.x >= W + WRAP_MARGIN) w.x -= WRAP_PERIOD;
  }

  /**
   * Resolve a collision between a wheel and a wall segment.
   * @param {Wheel} w
   * @param {Wall} wall
   */
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

  /**
   * Resolve a collision between two wheels, taking wraparound into account.
   * @param {Wheel} a
   * @param {Wheel} b
   */
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

  /**
   * Advance the world by exactly one fixed tick.
   * @param {WorldState} world
   */
  function step(world) {
    for (const w of world.wheels) { applyInput(w); integrate(w); }
    for (const w of world.wheels) for (const wall of world.walls) collideWall(w, wall);
    for (let i = 0; i < world.wheels.length; i++)
      for (let j = i + 1; j < world.wheels.length; j++)
        collideWheels(world.wheels[i], world.wheels[j]);
  }

  /**
   * Round a number to a readable precision for network snapshots.
   * @param {number} n
   * @returns {number}
   */
  const r2 = (n) => Math.round(n * 100) / 100;

  /**
   * Produce a compact snapshot of wheel positions for sending to the client.
   * @param {WorldState} world
   * @returns {{x:number, y:number, angle:number}[]}
   */
  function snapshot(world) {
    return world.wheels.map((w) => ({ x: r2(w.x), y: r2(w.y), angle: r2(w.angle) }));
  }

  /**
   * Shared simulation API exposed to both the browser and Node.
   * @type {{
   *   W: number,
   *   H: number,
   *   STEP_MS: number,
   *   WRAP_MARGIN: number,
   *   WRAP_PERIOD: number,
   *   WORLDS: WorldDefinition[],
   *   createWorld: (worldIndex?: number, playerCount?: number) => WorldState,
   *   step: (world: WorldState) => void,
   *   snapshot: (world: WorldState) => {x:number, y:number, angle:number}[]
   * }}
   */
  const Sim = { W, H, STEP_MS, WRAP_MARGIN, WRAP_PERIOD, WORLDS, createWorld, step, snapshot };
  if (typeof module !== 'undefined' && module.exports) module.exports = Sim;
  else root.Sim = Sim;
})(typeof window !== 'undefined' ? window : globalThis);