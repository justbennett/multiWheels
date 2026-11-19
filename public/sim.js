// Shared physics. Plain JS with no p5, so the same file runs in the browser and in Node.
(function (root) {
  const W = 600, H = 270, GROUND = 15; // 20:9 world, like a wide phone in landscape. Every device scales this same area to fit.
  const STEP_MS = 1000 / 60; // fixed timestep: one step() = one 60 Hz tick

  // ===========================================================================================
  // TUNING: every number that controls how the wheel feels lives in this block.
  // Distances are in world pixels, speeds in pixels per tick (1 tick = 1/60 s, so 1 px/tick = 60 px/s),
  // and spins in radians per tick. Change one value at a time and play.
  // ===========================================================================================

  // --- Gravity and speed limit ---
  const GRAVITY = 0.175;    // Downward pull, added to the vertical speed every tick.
  const MAX_SPEED = 9;    // Top speed in any direction. Keep it below the wheel radius (10) so a fast wheel can't pass through a thin wall in a single tick.

  // --- Motor: the left and right keys spin the wheel ---
  const SPIN_ACCEL = 0.05;  // How quickly a held key speeds up the spin. Higher = punchier take-off, but the wheel can skid if it exceeds what the grip allows.
  const MAX_SPIN = 0.5;     // Spin limit. Top rolling speed is MAX_SPIN x radius (0.5 x 10 = 5 px/tick).
  const SPIN_DRAG = 0.97;   // Each tick the spin keeps this fraction of itself. Lower = the wheel stops spinning sooner when you let go of the keys. 1 = never slows on its own.

  // --- Grip: how the rim interacts with walls ---
  const WHEEL_FRICTION = 0.8; // Grip. 0 = ice, 1 = sticky rubber. Caps how hard the rim can push against a wall, so it limits both traction and climbing.
  const WHEEL_INERTIA = 0.5;  // How the wheel's mass is spread. 0.5 = solid disc (spins up easily), 1 = hollow hoop (slower to start and to stop).
  const WALL_BOUNCE = 0.35;    // How bouncy walls are. 0 = dead landing, 1 = perfect bounce. Low values give the wheel more grip after a landing.
  const REST_SPEED = 0.5;     // Impacts slower than this don't bounce at all, so a wheel at rest doesn't vibrate on a surface.

  // --- Air ---
  const AIR_DRAG = 0.975;     // Each tick the sideways speed keeps this fraction of itself. This is what slows a coasting wheel and a falling one. 1 = no air resistance.
  const AIR_SPIN_PUSH = 0.15; // While airborne, a spinning wheel nudges itself sideways by (spin x this) each tick. Keep it small; 0 = spin has no effect in the air.
  const STOP_SPEED = 0.01;    // A wheel with no key held that is moving slower than this (px/tick) while touching a surface counts as stopped, so it really stops instead of creeping.

  // --- Boost: a thruster pulse that fires once per press ---
  const BOOST_STRENGTH = 3.5;        // Speed added by one pulse (px/tick). Straight up with gravity 0.2 lifts the wheel about 35 px.
  const BOOST_COOLDOWN_TICKS = 15; // Minimum ticks between pulses. 60 ticks = 1 second, so 15 = 4 boosts per second. Raise it to slow tapping down.
  const BOOST_BUFFER_TICKS = 6;    // A press made up to this many ticks before the cooldown ends is remembered and fires the moment it ends. 0 = a press during cooldown is ignored.

  // Wrapping: a wheel that leaves one side of the screen re-enters from the other. It lives in a
  // range WRAP_MARGIN wider than the screen on each side, so it is fully off-screen (hidden) for a
  // moment before it reappears. WRAP_MARGIN must be at least the wheel radius (10), or the wheel
  // would still be visible when it jumps. A bigger margin means a longer time out of sight.
  const WRAP_MARGIN = 20;
  const WRAP_PERIOD = W + 2 * WRAP_MARGIN;

  /**
   * A straight wall segment.
   * @typedef {object} Wall
   * @property {number} x1 - Start x.
   * @property {number} y1 - Start y.
   * @property {number} x2 - End x.
   * @property {number} y2 - End y.
   * @property {string} type - Kind of wall, for example "solid".
   */

  /**
   * A map: its walls and one spawn point per player slot.
   * @typedef {object} WorldDefinition
   * @property {string} name - Display name.
   * @property {Wall[]} walls - The walls in this world.
   * @property {object[]} spawnPoints - Objects with x and y, one per player slot.
   */

  // A world is plain data: walls plus one spawn point per player slot (up to 4).
  // Every wall has a type so hazards and other kinds can be added later.
  const WORLDS = [
    {
      name: 'Ledge',
      walls: [
        { x1: -WRAP_MARGIN, y1: H - GROUND, x2: W + WRAP_MARGIN, y2: H - GROUND, type: 'solid' }, // floor
        { x1: -WRAP_MARGIN, y1: 0,          x2: W + WRAP_MARGIN, y2: 0,          type: 'solid' }, // ceiling
        { x1: W / 4, y1: H / 3,      x2: W * 3 / 4, y2: H / 2,      type: 'ice' }, // ledge
      ],
      spawnPoints: [
        { x: W / 2 - 30, y: H / 2 - 30 }, { x: W / 2 + 30, y: H / 2 - 30 },
        { x: W / 2 - 90, y: H / 2 - 30 }, { x: W / 2 + 90, y: H / 2 - 30 },
      ],
    },
    {
      name: 'Three Ledges',
      walls: [
        { x1: -WRAP_MARGIN, y1: H - GROUND, x2: W + WRAP_MARGIN, y2: H - GROUND, type: 'solid' }, // floor
        { x1: -WRAP_MARGIN, y1: 0,          x2: W + WRAP_MARGIN, y2: 0,          type: 'fire' }, // ceiling
        { x1: W * 0.1,   y1: H * 0.55, x2: W * 0.25, y2: H * 0.65, type: 'solid' }, // left ledge
        { x1: W * 0.1,   y1: H * 0.55, x2: W * 0.1, y2: H * 0.65, type: 'solid' }, // verticl
        { x1: W * 0.575, y1: H * 0.65, x2: W * 0.9,   y2: H * 0.65, type: 'grip' }, // right ledge
        { x1: W * 0.375, y1: H * 0.35, x2: W * 0.625, y2: H * 0.35, type: 'ice' }, // high middle ledge
      ],
      spawnPoints: [
        { x: W / 2 - 30, y: H * 0.25 }, { x: W / 2 + 30, y: H * 0.25 },
        { x: W / 2 - 90, y: H * 0.25 }, { x: W / 2 + 90, y: H * 0.25 },
      ],
    },
  ];

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  /**
   * What a player is asking for right now. Filled in from the keyboard locally, or from the network on the server.
   * @typedef {object} WheelInput
   * @property {boolean} left - Spin counterclockwise (drive left).
   * @property {boolean} right - Spin clockwise (drive right).
   * @property {boolean} boost - True while the boost control is held down.
   * @property {boolean} boostPressed - A press the server noticed, kept until the sim uses it so a quick tap is never lost.
   */

  /**
   * One player's wheel.
   * @typedef {object} Wheel
   * @property {number} id - Player slot.
   * @property {number} x - Center x.
   * @property {number} y - Center y.
   * @property {number} vx - Horizontal speed in px per tick.
   * @property {number} vy - Vertical speed in px per tick.
   * @property {number} spin - Spin in radians per tick. Positive is clockwise, which rolls the wheel right.
   * @property {number} angle - Rotation in radians, for drawing.
   * @property {number} radius - Wheel radius.
   * @property {number} restitution - Bounciness in wheel-against-wheel hits.
   * @property {boolean} touching - True if the wheel touched a wall during the last tick.
   * @property {number} boostCooldown - Ticks until the next boost may fire.
   * @property {boolean} boostQueued - True if a press is waiting for the cooldown to end.
   * @property {number} boostWait - Ticks a queued press will keep waiting.
   * @property {boolean} boostWasDown - Whether boost was held on the previous tick.
   * @property {WheelInput} input - The current controls.
   */

  /**
   * Make a wheel at rest.
   * @param {number} id - Player slot.
   * @param {number} x - Starting x.
   * @param {number} y - Starting y.
   * @returns {Wheel}
   */
  function createWheel(id, x, y) {
    return {
      id, x, y, vx: 0, vy: 0, spin: 0, angle: 0,
      radius: 10, restitution: 0.85,
      touching: false,
      boostCooldown: 0, boostQueued: false, boostWait: 0, boostWasDown: false,
      // Inputs are data. Locally they come from the keyboard, on the server from the network.
      input: { left: false, right: false, boost: false, boostPressed: false },
    };
  }

  /**
   * The state of one match.
   * @typedef {object} WorldState
   * @property {number} worldIndex - Which entry of WORLDS this is.
   * @property {Wall[]} walls - The walls in play.
   * @property {Wheel[]} wheels - One wheel per player.
   */

  /**
   * Build a world. worldIndex picks an entry from WORLDS, and playerCount is how many wheels to create (1 to 4).
   * @param {number} [worldIndex=0] - Which map to use.
   * @param {number} [playerCount=2] - How many wheels to create.
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
   * Fire a boost pulse when one is due. A press fires at once if the cooldown is over, and otherwise
   * waits briefly (BOOST_BUFFER_TICKS) so a tap just before the cooldown ends isn't lost.
   *  {number} steer - -1 for left, 1 for right, 0 for neither <-was removed, now just straight up boost
   * @param {Wheel} w - The wheel.
   */
  function updateBoost(w) {
    // A press is either a fresh up-to-down change, or one the server latched in boostPressed.
    const pressed = w.input.boostPressed || (w.input.boost && !w.boostWasDown);
    w.input.boostPressed = false;
    w.boostWasDown = w.input.boost;

    if (pressed) { w.boostQueued = true; w.boostWait = BOOST_BUFFER_TICKS; }
    if (w.boostCooldown > 0) w.boostCooldown--;
    if (!w.boostQueued) return;

    if (w.boostCooldown === 0) {
      // Straight up with no direction held, otherwise 45 degrees up and toward the held side.
      //const sidewaysShare = steer * Math.SQRT1_2;
      //const upwardShare = steer === 0 ? 1 : Math.SQRT1_2;
      //w.vx += sidewaysShare * BOOST_STRENGTH;
      //w.vy -= upwardShare * BOOST_STRENGTH; test without 45 degree boost 
      w.vy -= BOOST_STRENGTH;
      w.boostCooldown = BOOST_COOLDOWN_TICKS;
      w.boostQueued = false;
    } else if (w.boostWait-- <= 0) {
      w.boostQueued = false; // waited too long, drop the press
    }
  }

  /**
   * Apply the player's controls and the air for one tick: motor, spin drag, air drag and boost.
   * @param {Wheel} w - The wheel.
   */
  function applyInput(w) {
    const steer = (w.input.right ? 1 : 0) - (w.input.left ? 1 : 0);

    // Motor and spin drag. With no key held the spin simply bleeds away.
    w.spin = clamp((w.spin + steer * SPIN_ACCEL) * SPIN_DRAG, -MAX_SPIN, MAX_SPIN);

    // In the air a spinning wheel nudges itself sideways a little. Air resistance slows sideways speed everywhere.
    if (!w.touching) w.vx += w.spin * AIR_SPIN_PUSH;
    w.vx *= AIR_DRAG;

    // A wheel with no key held that is barely moving on a surface comes to a complete stop.
    if (steer === 0 && w.touching && Math.abs(w.vx) < STOP_SPEED && Math.abs(w.spin) * w.radius < STOP_SPEED) {
      w.vx = 0;
      w.spin = 0;
    }

    updateBoost(w);
  }

  /**
   * Move a wheel for one tick: gravity, speed limit, position, rotation and screen wrap.
   * @param {Wheel} w - The wheel.
   */
  function integrate(w) {
    w.vy += GRAVITY;

    const speed = Math.hypot(w.vx, w.vy);
    if (speed > MAX_SPEED) {
      w.vx *= MAX_SPEED / speed;
      w.vy *= MAX_SPEED / speed;
    }

    w.x += w.vx;
    w.y += w.vy;
    w.angle += w.spin;
    // Wrap through the hidden margin. Both ends of the jump are off-screen, so it can't be seen.
    if (w.x < -WRAP_MARGIN) w.x += WRAP_PERIOD;
    if (w.x >= W + WRAP_MARGIN) w.x -= WRAP_PERIOD;
  }

  /**
   * Push a wheel out of a wall it overlaps, bounce it, and let the rim grip the wall. Grip works
   * on the difference between how fast the rim moves and how fast the wall slides past it, and
   * it changes both the wheel's velocity and its spin.
   * @param {Wheel} w - The wheel.
   * @param {Wall} wall - The wall to test against.
   */
  function collideWall(w, wall) {
    const dx = wall.x2 - wall.x1, dy = wall.y2 - wall.y1;
    const t = clamp(((w.x - wall.x1) * dx + (w.y - wall.y1) * dy) / (dx * dx + dy * dy), 0, 1);
    const cx = wall.x1 + t * dx, cy = wall.y1 + t * dy;  //cx and cy are the closest point on the wall to the wheel center
    const overHeadFactor = cy <= w.y ? 0.4 : 1 ; // if the wall is above the wheel, false if below
    let nx = w.x - cx, ny = w.y - cy;  // nx and ny are the vector from the closest point on the wall to the wheel center
    const d = Math.hypot(nx, ny);
    if (d > w.radius) return;
    w.touching = true;
    if (d === 0) { nx = 0; ny = -1; } else { nx /= d; ny /= d; } // nx and ny are now the unit normal vector from the wall to the wheel center

    w.x = cx + nx * w.radius; // push the wheel out of the wall so it is just touching
    w.y = cy + ny * w.radius;

    // Normal direction: bounce, or just stop pressing into the wall if the impact is slow.
    const vn = w.vx * nx + w.vy * ny; // negative means moving into the wall
    if (vn >= 0) return;
    const bounce = -vn > REST_SPEED ? WALL_BOUNCE * overHeadFactor  : 0;
    const normalImpulse = -(1 + bounce) * vn;
    w.vx += nx * normalImpulse;
    w.vy += ny * normalImpulse;

    // Friction calculation: the rim is moving relative to the wall, and the wheel can push back against it. 
    // The friction impulse is capped by the normal impulse, so a hard landing gives more grip than a light one. 
    // The wheel's spin is affected too, so it can be spun up or slowed down by the wall.
    
    // make a variable wallFriction that is determined by the wall.type, and multiply the frictionImpulse by that variable. ice = 0.1, grip = 1, solid = 0.8
    let wallFriction;
    switch (wall.type) {
      case 'ice':
        wallFriction = 0.1;
        break;
      case 'grip':
        wallFriction = 1.5;
        break;
      case 'solid':
        wallFriction = 1;
        break;
      case 'fire':
      default:
        wallFriction = 1;
    }
    const surfaceCoefficient = overHeadFactor * wallFriction; // reduce friction when the wall is above the wheel and apply the wall type friction coefficient
    const tangentX = -ny, tangentY = nx;
    const inertia = WHEEL_INERTIA * w.radius * w.radius;
    const slipSpeed = w.vx * tangentX + w.vy * tangentY - w.spin * w.radius; // positive means the rim is sliding down the wall
    const gripNeeded = -slipSpeed / (1 + (w.radius * w.radius) / inertia); // impulse needed to stop the slip in one tick
    const gripLimit = WHEEL_FRICTION * normalImpulse;
    const  frictionImpulse = clamp(gripNeeded, -gripLimit, gripLimit) * overHeadFactor * surfaceCoefficient; // reduce grip when the wall is above the wheel
    w.vx += tangentX * frictionImpulse;
    w.vy += tangentY * frictionImpulse;
    w.spin -= (w.radius * frictionImpulse) / inertia;
  }

  /**
   * Bounce two overlapping wheels off each other.
   * @param {Wheel} a - One wheel.
   * @param {Wheel} b - The other wheel.
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
   * @param {WorldState} world - The world to advance.
   */
  function step(world) {
    for (const w of world.wheels) { applyInput(w); integrate(w); }
    for (const w of world.wheels) {
      w.touching = false; // collideWall sets it again if the wheel is in contact this tick
      for (const wall of world.walls) collideWall(w, wall);
    }
    for (let i = 0; i < world.wheels.length; i++)
      for (let j = i + 1; j < world.wheels.length; j++)
        collideWheels(world.wheels[i], world.wheels[j]);
  }

  const r2 = (n) => Math.round(n * 100) / 100;

  /**
   * One wheel's position, as sent to clients.
   * @typedef {object} WheelSnapshot
   * @property {number} x - Center x.
   * @property {number} y - Center y.
   * @property {number} angle - Rotation in radians.
   */

  /**
   * Wheel positions and rotations, ready to send to clients.
   * @param {WorldState} world - The world to read.
   * @returns {WheelSnapshot[]}
   */
  function snapshot(world) {
    return world.wheels.map((w) => ({ x: r2(w.x), y: r2(w.y), angle: r2(w.angle) }));
  }

  /**
   * The API shared by the server and the browser client.
   * @type {object}
   * @property {number} W - World width.
   * @property {number} H - World height.
   * @property {number} STEP_MS - Milliseconds per simulation tick.
   * @property {number} WRAP_MARGIN - How far past each edge a wheel travels before wrapping.
   * @property {number} WRAP_PERIOD - Width of the wrap-around range: W plus the margin on both sides.
   * @property {WorldDefinition[]} WORLDS - Every available world.
   * @property {function(number=, number=): WorldState} createWorld - Build a world from a world index and player count.
   * @property {function(WorldState): void} step - Advance the world by one tick.
   * @property {function(WorldState): WheelSnapshot[]} snapshot - Wheel positions for sending to clients.
   */
  const Sim = { W, H, STEP_MS, WRAP_MARGIN, WRAP_PERIOD, WORLDS, createWorld, step, snapshot };
  if (typeof module !== 'undefined' && module.exports) module.exports = Sim;
  else root.Sim = Sim;
})(typeof window !== 'undefined' ? window : globalThis);