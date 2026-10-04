// Deterministic penalty-kick physics. No dependencies, no graphics.
//
// World frame (metres, seconds, kilograms, radians):
//   +x  right, as seen by the penalty taker
//   +y  up
//   -z  towards the goal; the ball starts on the penalty spot at the origin
//
// Everything inside the simulation loop uses only + - * /, Math.sqrt,
// Math.min/max/abs/round and Math.imul. IEEE-754 requires these to be exactly
// rounded, so the same shot input and keeper plan produce bit-identical output
// on every JavaScript engine. The one place that needs trigonometry (turning
// the keeper's chosen dive angle into a velocity) uses the polynomial detSin
// below instead of Math.sin, whose precision is engine-defined.

// ---------------------------------------------------------------- constants

export const SIM = {
  DT: 0.001,          // fixed integration step: 1 kHz
  RECORD_EVERY: 4,    // store a render frame every 4 steps (250 Hz)
  KEEPER_BLOCK: 20,   // steps per keeper step: it moves at 50 Hz (see keeperBlock)
  BALL_BLOCK: 5,      // steps per ball step in free flight (see freeFlight)
  MAX_T: 2.5,         // hard cap on simulated time before a verdict is forced (bounds the on-chain cost)
  G: 9.81,
};

export const BALL = {
  R: 0.11,            // size-5 ball radius
  M: 0.43,            // mass
  E_GROUND: 0.55,     // vertical restitution on grass
  GROUND_KEEP: 0.85,  // horizontal speed kept through a bounce
  MIN_BOUNCE_VY: 1.0, // below this impact speed the ball settles into rolling
  ROLL_DECEL: 1.2,    // rolling resistance on grass, m/s^2
  SPIN_DECAY: 0.05,   // fraction of spin lost to air per second
};
BALL.I = (2 / 3) * BALL.M * BALL.R * BALL.R; // thin spherical shell

export const AIR = { RHO: 1.2, CD: 0.25, CL: 1.0 };
const AREA = Math.PI * BALL.R * BALL.R;
const DRAG_K = (0.5 * AIR.RHO * AIR.CD * AREA) / BALL.M;          // a = -DRAG_K |v| v
const MAGNUS_K = (0.5 * AIR.RHO * AIR.CL * AREA * BALL.R) / BALL.M; // a = MAGNUS_K (w x v)

export const GOAL = {
  Z: -11,             // goal line (centre of the posts), 11 m from the spot
  HW: 3.2775,         // half the inside width: 6.555 m (regulation 7.32 m)
  H: 2.424,           // inside height, 2424 mm as the realm's config (regulation 2.44 m)
  POST_R: 0.06,       // 12 cm posts and bar
  DEPTH: 2.0,         // net depth behind the line
  E_POST: 0.7,
  NET_K: 2500,        // net spring stiffness, N/m
  NET_C: 40,          // net damping, N s/m
  NET_RECOIL: 0.1,    // spring strength while the net pushes the ball back out
  NET_FRICTION: 3,    // drag while the ball is in the mesh, 1/s
  BOARDS_Z: -16,      // advertising boards behind the goal
  BOARDS_H: 1.0,
  BOARDS_HW: 30,
};
export const NET = {
  SIDE_X: GOAL.HW + GOAL.POST_R,
  ROOF_Y: GOAL.H + GOAL.POST_R,
  BACK_Z: GOAL.Z - GOAL.DEPTH,
};

export const KICK = {
  MIN_SPEED: 10,      // foot-to-ball speed at 0% power (m/s)
  MAX_SPEED: 34,      // ... at 100% power (~122 km/h)
  NORMAL_MIX: 0.18,   // how much the contact normal (vs the swing) steers the ball
  // Fraction of the off-centre angular impulse that becomes spin. The inside of
  // the foot wraps round the ball, so sidespin (about the vertical) transfers
  // far better than back/top spin.
  SIDE_SPIN_TRANSFER: 0.6,
  BACK_SPIN_TRANSFER: 0.25,
  MAX_SPIN: 110,      // rad/s
  MAX_CONTACT: 0.5,   // farthest contact offset you can choose (fraction of radius)
  MAX_STRIKE: 0.8,    // farthest the actual (mishit) contact can land
  FUZZ_BASE: 0.03,    // std-dev of the mishit, in ball radii, at 0% power ...
  FUZZ_POWER: 0.1,    // ... plus this much more at 100% power
  AIM_X: 6,
  AIM_Y: 4,
};

export const KEEPER = {
  LINE_OFFSET: 0.25,  // hip starts this far off the goal line, towards the taker
  SCALE: 1.176,       // the whole body (every hitbox and its reach), relative to a ~1.85 m keeper
  STAND_HIP_Y: 0.93 * 1.176,
  PUSH_TIME: 0.12,    // push-off: velocity ramps to the planned value over this time
  LEAN_RATE: 8,       // how fast the body rotates into the dive (1/s)
  ARM_RATE: 10,
  LEAN_BIAS: -0.3,    // body lean target = normalize(vx, max(LEAN_MIN, jump + LEAN_BIAS))
  LEAN_MIN: 0.15,     // so a low dive ends up almost flat
  SLIDE_DECEL: 8,     // friction once the keeper is on the ground
  STAR_SPEED: 1.2,    // below this lateral speed the keeper spreads into a star jump
  E_GLOVE: 0.25,
  E_BODY: 0.45,
  FRICTION: 0.3,
  SHOULDER_X: 0.24,
  SHOULDER_Y: 0.5,
  ARM_LEN: 0.62,
  GLOVE_REACH: 0.73,
  GLOVE_R: 0.125,     // a spread hand, not a fist
  REACH_PIVOT: 1.8,   // jump speed at which the diving reach is horizontal
  REACH_SPAN: 2.6,    // reach slope = (jump - REACH_PIVOT) / REACH_SPAN
  // Reading the shot. The keeper only ever uses the simulated ball state and
  // predicts its crossing point with straight-line-plus-gravity extrapolation
  // (no spin, no drag), so it is deterministic and curl can still fool it.
  PERCEIVE: 0.16,     // from this long after contact the hands steer towards the predicted point
  READ_EVERY: 20,     // steps between the keeper's reads of the ball (50 Hz); it acts on its last read in between
  ARM_TRACK_RATE: 12,
  READ_BASE: 0.16,    // a "read" plan commits at READ_BASE + plan.reaction
  READ_REACH: 0.75,   // lateral distance the arms cover (x SCALE), so a read dive only carries the hips the rest
  READ_HEIGHT_GAIN: 2.2, // read dive jump = (predicted height - hip-ish height) x gain
  READ_SHUFFLE_T: 0.45,  // with more time than this, a reader shuffles across first and dives late
  // Misreading. Every keeper misjudges a little, and more the earlier it
  // acts. One seeded draw per kick (keeperMisread) is scaled by how long it
  // has watched: its predicted crossing point is off by MISREAD_X/Y
  // [late, early] standard deviations, the early value at or before
  // MISREAD_T[0] after contact, shrinking to the late value by MISREAD_T[1]
  // (the range of a read's commit times). A committed dive is off by
  // MISJUDGE_VX/JUMP, from early at REACTION_MIN to late at REACTION_MAX.
  MISREAD_X: [0.05, 1.2],       // m
  MISREAD_Y: [0.04, 0.5],       // m
  MISREAD_T: [0.18, 0.28],      // s after contact
  MISJUDGE_VX: [0.12, 0.6],     // m/s of the dive's sideways speed
  MISJUDGE_JUMP: [0.12, 0.6],   // m/s of its jump
  PLANT_EXTRA: 0.08,  // the trailing foot stays planted this long after push-off...
  PLANT_STRETCH: 1.15,// ...unless the leg would stretch beyond this x its length
  // Recovery after landing: get up, shuffle towards the predicted point, and
  // allow one more dive if the ball is still coming.
  RECOVER_DELAY: 0.08,
  HOLD_DOWN_T: 0.3,   // stay down while the ball is due within this long
  RECOVER_LEAN_RATE: 9,
  RECOVER_SPEED: 2.6,
  RECOVER_ACCEL: 9,
  REDIVE_WINDOW: 0.38, // dive only once the ball is due within about a dive's duration
  REDIVE_MIN_DX: 0.45,
  MAX_COMMITS: 2,
  // Catch or parry. A glove or chest contact holds the ball if its speed
  // relative to that part is at most a limit set by how well the keeper is
  // behind it: CATCH_SPEED_MIN at full stretch, CATCH_SPEED_MAX with both
  // hands on the ball and the body in line. Arms, legs and head always parry.
  CATCH_SPEED_MIN: 9,     // m/s
  CATCH_SPEED_MAX: 25,    // m/s (90 km/h)
  CATCH_HANDS_GAP: 0.14,  // ball to midpoint of the gloves (x SCALE): both hands on it...
  CATCH_HANDS_SPAN: 0.32, // ...out to here, the hands are not together at all
  CATCH_BODY_NEAR: 0.25,  // ball to torso surface (x SCALE): body right behind it...
  CATCH_BODY_FAR: 0.8,    // ...out to here, the body is no help
  CATCH_HANDS_WEIGHT: 0.65, // positioning = hands share + body share (the rest)
  HOLD_PULL: 25,          // 1/s: how fast a caught ball is drawn into the hands
  TOUCH_GAP: 0.08,        // s: contacts closer together than this are one touch, decided once
  // Collision margin per body part, in metres, added to the body radius for
  // ball contact only (the limbs, and the keeper's clearance off the grass,
  // keep their body size). Stands in for the reach a capsule body misses:
  // spread fingers, a flicked boot, a shirt the ball clips.
  HIT_MARGIN: { glove: 0.03, arm: 0.02, torso: 0.02, leg: 0.02, head: 0.01 },
  // A slow ball gives the keeper time to stick out a foot or a hand: below
  // REACT_SPEED every part except the head reaches further, up to
  // REACT_REACH for a ball that has almost stopped (once the shot is seen).
  REACT_SPEED: 12,        // m/s
  REACT_REACH: 0.12,      // m
  // Any part but the head gathers a ball that arrives slower than this
  // (trickled into the feet, smothered on the ground) instead of bouncing it.
  GATHER_SPEED: 7.5,      // m/s (27 km/h)
  ONE_HAND_MAX: 13,       // m/s: the most a single glove can hold (47 km/h)
  LOW_DROP_SPEED: 1.8,    // m/s: a read dive at a low ball goes down sideways at least this fast
  // Limbs are not rigid. Each can change the ball's speed along the contact
  // normal by at most this much (its strongest impulse / ball mass, m/s); a
  // harder ball pushes through it, slowed and deflected. Two hands together
  // and a braced chest stop a full-power shot, a lone glove or arm at full
  // stretch does not, and a leg trailing in the air is softer than a planted one.
  GIVE: { hands: 36, glove: 31, arm: 14, torso: 30, head: 30, leg: 32, legInAir: 26 },
  // A glove touch with the ball this close to the torso (x SCALE) is a
  // braced reflex block -- hands in front of the body -- with the chest's strength.
  REFLEX_BODY: 0.25,
  // A touch made only through the extra reach (collision margin, slow-ball
  // reaction, late hand adjustment), not the limb itself, is a fingertip or
  // toe-end: it has this share of the limb's strength.
  FINGERTIP_GIVE: 0.75,
  // A glove touch slower than this that cannot be held is pushed away and
  // wide, not back towards the goal.
  PARRY_CONTROL: 16,      // m/s
  PARRY_OUT: 3,           // m/s away from goal at least
  PARRY_WIDE: 2,          // m/s towards the nearer side
  // The hands keep adjusting while the keeper watches the ball: up to
  // HAND_LATE_MAX of extra reach, gained at HAND_LATE_RATE from 0.1 s after it
  // has seen the shot.
  HAND_LATE_MAX: 0.07,    // m
  HAND_LATE_RATE: 0.25,   // m/s
  // A loose ball -- slower than POUNCE_SPEED after a keeper touch or the
  // woodwork, within POUNCE_REACH of the hips and below POUNCE_HEIGHT -- is
  // the keeper's if it gets there first: it needs POUNCE_DELAY to go down on
  // the ball plus the distance beyond POUNCE_NEAR at POUNCE_MOVE, and the ball
  // must need longer than that to be wholly over the line. Not mid-dive.
  POUNCE_SPEED: 3,        // m/s
  POUNCE_REACH: 1.8,      // m
  POUNCE_HEIGHT: 2.2,     // m
  POUNCE_DELAY: 0.2,      // s
  POUNCE_NEAR: 0.9,       // m
  POUNCE_MOVE: 3,         // m/s
};

// ------------------------------------------------------------- vector maths

const v = (x, y, z) => ({ x, y, z });
const add = (a, b) => v(a.x + b.x, a.y + b.y, a.z + b.z);
const sub = (a, b) => v(a.x - b.x, a.y - b.y, a.z - b.z);
const scale = (a, s) => v(a.x * s, a.y * s, a.z * s);
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a, b) => v(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
const len = (a) => Math.sqrt(dot(a, a));
const norm = (a) => {
  const l = len(a);
  return l > 0 ? scale(a, 1 / l) : v(0, 0, 0);
};
const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
const UP = v(0, 1, 0);

const HALF_PI = 1.5707963267948966;
const PI = 3.141592653589793;
const TWO_PI = 6.283185307179586;

// sin via range reduction + Taylor series: only exactly-rounded operations.
export function detSin(x) {
  x -= TWO_PI * Math.round(x / TWO_PI);
  if (x > HALF_PI) x = PI - x;
  else if (x < -HALF_PI) x = -PI - x;
  const x2 = x * x;
  let term = x;
  let sum = x;
  for (let n = 1; n <= 9; n++) {
    term *= -x2 / ((2 * n) * (2 * n + 1));
    sum += term;
  }
  return sum;
}
export const detCos = (x) => detSin(x + HALF_PI);

// ------------------------------------------------------------ seeded random

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fnvBytes(h, bytes) {
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return h;
}

export function hashNumbers(values) {
  const dv = new DataView(new ArrayBuffer(8));
  const bytes = new Uint8Array(dv.buffer);
  let h = 0x811c9dc5;
  for (const x of values) {
    dv.setFloat64(0, x);
    h = fnvBytes(h, bytes);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// ------------------------------------------------------------- round bytes
//
// Everything random about a round is 32 bytes, fixed before the shot:
//   bytes 0-1   uint16 (big-endian)  keeper direction
//   bytes 2-3   uint16               keeper speed
//   bytes 4-5   uint16               keeper jump
//   bytes 6-7   uint16               keeper reaction time
//   bytes 8-31  24 bytes             mishit seed (the taker's contact error)
// Each uint16 u is normalised to v = u / 65535 in [0, 1] and mapped to a
// physical value by the fixed functions below.

export const ROUND_BYTES = 32;
export const STRIKE_SEED_BYTES = 24;

export const PLAN = {
  // direction: v = 0 -> 0° (along the line to your right) ... v = 1 -> 180°
  // (your left). The middle CENTRE_SHARE of the range sweeps the headings in
  // between (coming off the line towards you); the rest is a dive at most
  // FORWARD_MAX degrees off the line.
  FORWARD_MAX: 22,
  CENTRE_SHARE: 0.06,
  // speed: the lowest STAR_SHARE of the range is a near-stationary star jump
  // (below KEEPER.STAR_SPEED); the next READ_SHARE is "wait and read" (the
  // keeper holds its ground and dives at the predicted point once it has seen
  // the shot; the direction and jump values are then unused); the rest is a
  // committed dive between the dive speeds.
  STAR_SHARE: 0.06,
  READ_SHARE: 0.24,
  STAR_MAX_SPEED: 1.15,
  DIVE_MIN_SPEED: 2.6,
  DIVE_MAX_SPEED: 5.2,
  JUMP_MIN: -1.4,     // negative = collapse low off a bent standing leg
  JUMP_MAX: 4.0,
  REACTION_MIN: 0.02,
  REACTION_MAX: 0.12,
};

const u16 = (bytes, i) => (bytes[i] << 8) | bytes[i + 1];
const lin = (vv, lo, hi) => lo + (hi - lo) * vv;

export function planDirection(vv) {
  const s = 2 * vv - 1;                    // -1 (right) .. 1 (left)
  const c = PLAN.CENTRE_SHARE;
  const F = PLAN.FORWARD_MAX;
  if (s <= -c) return (F * (1 + s)) / (1 - c);
  if (s >= c) return 180 - (F * (1 - s)) / (1 - c);
  return 90 + ((90 - F) * s) / c;
}

export function planSpeed(vv) {
  const k = PLAN.STAR_SHARE;
  const r = k + PLAN.READ_SHARE;
  if (vv < k) return (PLAN.STAR_MAX_SPEED * vv) / k;
  if (vv < r) return 0;
  return lin((vv - r) / (1 - r), PLAN.DIVE_MIN_SPEED, PLAN.DIVE_MAX_SPEED);
}

export function planModeOf(vv) {
  if (vv < PLAN.STAR_SHARE) return 'star';
  return vv < PLAN.STAR_SHARE + PLAN.READ_SHARE ? 'read' : 'dive';
}

// 'star' | 'read' | 'dive'. Hand-written plans without a mode are star or dive.
export const planMode = (plan) => plan.mode || (plan.speed < KEEPER.STAR_SPEED ? 'star' : 'dive');

// When the keeper first moves, relative to contact.
export const planCommitTime = (plan) =>
  (planMode(plan) === 'read' ? KEEPER.READ_BASE + plan.reaction : plan.reaction);

// The keeper's plan from the first 8 round bytes (4 x uint16).
export function decodePlan(bytes) {
  const raw = [u16(bytes, 0), u16(bytes, 2), u16(bytes, 4), u16(bytes, 6)];
  const [d, sp, j, r] = raw.map((x) => x / 65535);
  return {
    raw,
    mode: planModeOf(sp),
    direction: planDirection(d),
    speed: planSpeed(sp),
    jump: lin(j, PLAN.JUMP_MIN, PLAN.JUMP_MAX),
    reaction: lin(r, PLAN.REACTION_MIN, PLAN.REACTION_MAX),
  };
}

// Splits 32 round bytes into the keeper's plan and the 24-byte mishit seed.
export function decodeRound(bytes) {
  if (bytes.length !== ROUND_BYTES) throw new Error(`round needs ${ROUND_BYTES} bytes`);
  return { plan: decodePlan(bytes), strikeSeed: Uint8Array.from(bytes.slice(8, 32)) };
}

// Reassembles the round bytes from a plan's raw uint16s and the mishit seed.
export function encodeRound(raw, strikeSeed) {
  const out = new Uint8Array(ROUND_BYTES);
  raw.forEach((x, i) => {
    out[2 * i] = x >>> 8;
    out[2 * i + 1] = x & 0xff;
  });
  out.set(strikeSeed, 8);
  return out;
}

// The inverse of decodePlan: the uint16s whose decoded plan is closest to the
// given one. A plan chosen in the UI goes through this and back through
// decodePlan, so it is exactly what the round bytes can express.
export function encodePlan(plan) {
  const q = (vv) => Math.round(clamp(vv, 0, 1) * 65535);
  const inv = (x, lo, hi) => (x - lo) / (hi - lo);
  const c = PLAN.CENTRE_SHARE;
  const F = PLAN.FORWARD_MAX;
  const a = plan.direction;
  let s;
  if (a <= F) s = (a * (1 - c)) / F - 1;
  else if (a >= 180 - F) s = 1 - ((180 - a) * (1 - c)) / F;
  else s = ((a - 90) * c) / (90 - F);
  const k = PLAN.STAR_SHARE;
  const r = k + PLAN.READ_SHARE;
  const mode = plan.mode || planMode(plan);
  let sp;
  if (mode === 'read') sp = k + PLAN.READ_SHARE / 2;
  else if (mode === 'star') sp = Math.min(k - 1 / 65535, (clamp(plan.speed, 0, PLAN.STAR_MAX_SPEED) * k) / PLAN.STAR_MAX_SPEED);
  else sp = r + inv(clamp(plan.speed, PLAN.DIVE_MIN_SPEED, PLAN.DIVE_MAX_SPEED), PLAN.DIVE_MIN_SPEED, PLAN.DIVE_MAX_SPEED) * (1 - r);
  return [
    q((s + 1) / 2),
    q(sp),
    q(inv(plan.jump ?? 0, PLAN.JUMP_MIN, PLAN.JUMP_MAX)),
    q(inv(plan.reaction ?? PLAN.REACTION_MIN, PLAN.REACTION_MIN, PLAN.REACTION_MAX)),
  ];
}

export const planFromRaw = (raw) => decodePlan(encodeRound(raw, new Uint8Array(STRIKE_SEED_BYTES)));

// When the player keeps, the same 32 bytes supply the computer's kick instead
// of a keeper plan (gno-shots-realm, penalty.Seed.ChainShot): bytes 0-1 aim x
// inside the posts by 25 cm, 2-3 aim y from 0.3 m to 0.2 m over the bar, 4-5
// power 45..100%, 6 and 7 contact x/y (int8, ±0.35 R), 8-31 the mishit seed.
// Integer millimetres, per-mille and milli-radii, as on chain.
export const CPU_SHOT = { AIM_INSET: 250, AIM_MIN_Y: 300, AIM_OVER_Y: 200, POWER_MIN: 450, CONTACT: 350 };
export function decodeTakerShot(bytes) {
  if (bytes.length !== ROUND_BYTES) throw new Error(`round needs ${ROUND_BYTES} bytes`);
  const C = CPU_SHOT;
  const W = Math.round(2 * GOAL.HW * 1000);
  const H = Math.round(GOAL.H * 1000);
  const span = (u, lo, hi) => lo + Math.floor(((hi - lo) * u) / 65535);
  const halfW = Math.floor(W / 2) - C.AIM_INSET;
  let cx = Math.trunc(((bytes[6] - 128) * C.CONTACT) / 128);
  let cy = Math.trunc(((bytes[7] - 128) * C.CONTACT) / 128);
  const m = Math.round(KICK.MAX_CONTACT * 1000);
  const r2 = cx * cx + cy * cy;
  if (r2 > m * m) {
    const r = Math.floor(Math.sqrt(r2));
    cx = Math.trunc((cx * m) / r);
    cy = Math.trunc((cy * m) / r);
  }
  const mm = {
    aimX: span(u16(bytes, 0), -halfW, halfW),
    aimY: span(u16(bytes, 2), C.AIM_MIN_Y, H + C.AIM_OVER_Y),
    power: span(u16(bytes, 4), C.POWER_MIN, 1000),
    contactX: cx,
    contactY: cy,
  };
  return {
    input: {
      aim: { x: mm.aimX / 1000, y: mm.aimY / 1000 },
      contact: { x: mm.contactX / 1000, y: mm.contactY / 1000 },
      power: mm.power / 1000,
      seed: Uint8Array.from(bytes.slice(8, 32)),
    },
    ints: mm,
  };
}

// Reproducible round bytes for tests and ?seed= URLs (not for real play,
// where the bytes should come from a proper random source).
export function roundBytesFromSeed(seed, round) {
  const rnd = mulberry32((Math.imul(seed >>> 0, 0x9e3779b1) + round) >>> 0);
  const out = new Uint8Array(ROUND_BYTES);
  for (let i = 0; i < ROUND_BYTES; i++) out[i] = Math.floor(rnd() * 256);
  return out;
}

export const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

// Seals everything about a round that is decided before the shot: the hash
// of its 32 bytes.
export function commitHash(bytes) {
  return (fnvBytes(0x811c9dc5, bytes) >>> 0).toString(16).padStart(8, '0');
}

export function keeperLaunchVelocity(plan) {
  const a = plan.direction * (PI / 180);
  return v(plan.speed * detCos(a), plan.jump, plan.speed * detSin(a));
}

export function describePlan(plan) {
  if (planMode(plan) === 'read') {
    return `wait and read the shot, then dive at where it expects the ball ` +
      `(${planCommitTime(plan).toFixed(2)} s after contact)`;
  }
  const lv = keeperLaunchVelocity(plan);
  let where;
  if (plan.speed < KEEPER.STAR_SPEED) {
    where = Math.abs(lv.x) < 0.2 ? 'star jump in place' : `star jump drifting to your ${lv.x > 0 ? 'right' : 'left'}`;
  } else if (Math.abs(lv.x) < 0.3 * plan.speed) where = 'rush out at you';
  else if (lv.x > 0) where = 'dive to your right';
  else where = 'dive to your left';
  const fwd = Math.abs(90 - Math.abs(90 - plan.direction));
  return `${where} (heading ${plan.direction.toFixed(1)}°, ${fwd.toFixed(1)}° off the line) at ` +
    `${plan.speed.toFixed(2)} m/s ` +
    (plan.jump < 0
      ? `collapsing low at ${(-plan.jump).toFixed(2)} m/s, `
      : `with a ${plan.jump.toFixed(2)} m/s jump, `) +
    `${plan.reaction.toFixed(2)} s after contact`;
}

// ------------------------------------------------------------------- keeper

// Arm directions are unit vectors in the keeper's body frame (before lean).
const ARMS_READY = { l: norm(v(-0.55, -0.45, 0.7)), r: norm(v(0.55, -0.45, 0.7)) };
const ARMS_STAR = { l: norm(v(-0.9, 0.6, 0.15)), r: norm(v(0.9, 0.6, 0.15)) };
// Ball gathered in: both hands together in front of the chest.
const ARMS_HOLD = { l: norm(v(0.18, 0.12, 0.95)), r: norm(v(-0.18, 0.12, 0.95)) };

// Diving reach in world space: both hands go towards the dive side, angled
// down for a low dive and up for a high one; the trailing hand sits a little
// higher. Expressed in the body frame of the final lean.
function diveArms(side, jump, lean) {
  const toBody = (wx, wy) => norm(v(wx * lean.c - wy * lean.s, wx * lean.s + wy * lean.c, 0.1));
  const reach = (jump - KEEPER.REACH_PIVOT) / KEEPER.REACH_SPAN;
  const lead = toBody(side, reach);
  const trail = toBody(side, reach + 0.45);
  return side > 0 ? { l: trail, r: lead } : { l: lead, r: trail };
}

export function keeperInitialState(misread = null) {
  return {
    misread,               // keeperMisread(seed), or null for a perfect read
    phase: 'ready',
    pushT: 0,
    groundT: 0,
    pos: v(0, KEEPER.STAND_HIP_Y, GOAL.Z + KEEPER.LINE_OFFSET), // hip centre
    vel: v(0, 0, 0),
    lean: { s: 0, c: 1 },  // body axis in the x-y plane, as (sin, cos) of the lean angle
    arms: { l: { ...ARMS_READY.l }, r: { ...ARMS_READY.r } },
    launchVel: null,
    leanTarget: { s: 0, c: 1 },
    armsTarget: { l: { ...ARMS_READY.l }, r: { ...ARMS_READY.r } },
    plant: null,           // trailing foot pinned to the grass during push-off
    plantUntil: 0,
    act: null,             // the latest commitment: { t0, vx, jump, star, read }
    commits: [],
    holding: false,        // it has caught the ball
    read: null,            // its latest read of where the ball will cross
    nextRead: 1,           // the step of its next read
    clr: 0, clrS: NaN, clrC: NaN, // keeperClearance for the lean (clrS, clrC)
  };
}

// The keeper's hitboxes: capsules (segment a-b, radius r); spheres have a === b.
// "left"/"right" are as seen by the taker. The renderer draws exactly these.
export function keeperCapsules(pose) {
  const { pos, lean, arms, plant } = pose;
  const K = KEEPER;
  const S = K.SCALE;
  const w = (x, y, z) => {
    x *= S;
    y *= S;
    return v(pos.x + x * lean.c + y * lean.s, pos.y - x * lean.s + y * lean.c, pos.z + z * S);
  };
  const caps = [];
  for (const side of [-1, 1]) {
    const tag = side < 0 ? 'left' : 'right';
    const sx = K.SHOULDER_X * side;
    const arm = side < 0 ? arms.l : arms.r;
    const g = w(sx + arm.x * K.GLOVE_REACH, K.SHOULDER_Y + arm.y * K.GLOVE_REACH, arm.z * K.GLOVE_REACH);
    const foot = plant && plant.side === side ? v(plant.x, plant.y, plant.z) : w(0.15 * side, -0.85, 0);
    caps.push(
      { name: `${tag} leg`, kind: 'leg', a: w(0.11 * side, 0, 0), b: foot, r: 0.08 * S },
      { name: 'body', kind: 'torso', a: w(0.09 * side, 0.05, 0), b: w(0.09 * side, 0.46, 0), r: 0.14 * S },
      {
        name: `${tag} arm`, kind: 'arm',
        a: w(sx, K.SHOULDER_Y, 0),
        b: w(sx + arm.x * K.ARM_LEN, K.SHOULDER_Y + arm.y * K.ARM_LEN, arm.z * K.ARM_LEN),
        r: 0.055 * S,
      },
      { name: `${tag} glove`, kind: 'glove', a: g, b: g, r: K.GLOVE_R },
    );
  }
  const h = w(0, 0.72, 0);
  caps.push({ name: 'head', kind: 'head', a: h, b: h, r: 0.12 * S });
  for (const c of caps) c.hit = c.r + K.HIT_MARGIN[c.kind];
  return caps;
}

// Hip height at which the lowest body part (legs, torso, head) just touches
// the ground. Arms don't prop the body up: they give way (see armsAboveGround).
function keeperClearance(k) {
  let minY = Infinity;
  for (const c of keeperCapsules({ pos: v(0, 0, 0), lean: k.lean, arms: k.arms, plant: null })) {
    if (c.kind === 'arm' || c.kind === 'glove') continue;
    minY = Math.min(minY, c.a.y - c.r, c.b.y - c.r);
  }
  return -minY;
}

// Flattens an arm that would push its glove into the grass so it lies along
// the ground instead, keeping its horizontal heading.
function armsAboveGround(k) {
  const K = KEEPER;
  const S = K.SCALE;
  const { s, c } = k.lean;
  const fix = (arm, side) => {
    const sx = K.SHOULDER_X * side * S;
    const sy = K.SHOULDER_Y * S;
    const shoulderY = k.pos.y - sx * s + sy * c;
    const minDy = (K.GLOVE_R - shoulderY) / (K.GLOVE_REACH * S);
    const wx = arm.x * c + arm.y * s;   // arm direction in world (x-y plane)
    const wy = -arm.x * s + arm.y * c;
    if (wy >= minDy || minDy >= 1) return arm;
    const h0 = Math.sqrt(wx * wx + arm.z * arm.z);
    const h = Math.sqrt(1 - minDy * minDy);
    const nx = h0 > 0 ? (wx * h) / h0 : h;
    const nz = h0 > 0 ? (arm.z * h) / h0 : 0;
    return v(nx * c - minDy * s, nx * s + minDy * c, nz);
  };
  k.arms = { l: fix(k.arms.l, -1), r: fix(k.arms.r, 1) };
}

// The lean and the arms are unit vectors that each step moves at most a
// quarter or so of the way towards a unit target. Such a blend can fall to
// about half of unit length, and three Newton steps towards 1/length
// (g = 1.5 - 0.5 |v|^2) bring it back to within two per cent at worst and a
// millionth typically, without a square root.
function nlerp2(a, b, f) {
  let s = a.s + (b.s - a.s) * f;
  let c = a.c + (b.c - a.c) * f;
  let g = 1.5 - 0.5 * (s * s + c * c);
  s *= g;
  c *= g;
  g = 1.5 - 0.5 * (s * s + c * c);
  s *= g;
  c *= g;
  g = 1.5 - 0.5 * (s * s + c * c);
  return { s: s * g, c: c * g };
}

function blendUnit(a, b, f) {
  let x = a.x + (b.x - a.x) * f;
  let y = a.y + (b.y - a.y) * f;
  let z = a.z + (b.z - a.z) * f;
  let g = 1.5 - 0.5 * (x * x + y * y + z * z);
  x *= g;
  y *= g;
  z *= g;
  g = 1.5 - 0.5 * (x * x + y * y + z * z);
  x *= g;
  y *= g;
  z *= g;
  g = 1.5 - 0.5 * (x * x + y * y + z * z);
  return v(x * g, y * g, z * g);
}

// Where the keeper expects the ball to cross its own plane z = zk, from the
// ball's current simulated state. It allows for gravity and for the ball
// slowing down (drag, plus rolling resistance on the grass) as a constant
// deceleration along its path, but not for spin, so curl can still fool it.
// Only + - * / and sqrt: deterministic like the rest of the simulation.
export function predictCrossing(b, zk) {
  const { p, v: u } = b;
  if (u.z >= -0.5) return null;
  const dz = zk - p.z;
  if (dz >= 0) return null;
  const sh = Math.sqrt(u.x * u.x + u.z * u.z);
  const sp = ballSpeed(b);
  const dist = (dz / u.z) * sh;                 // horizontal path length to the plane
  const decel = DRAG_K * sp * sh + (b.grounded ? BALL.ROLL_DECEL : 0);
  let tau = dist / sh;
  if (decel > 1e-9) {
    const disc = sh * sh - 2 * decel * dist;
    if (disc <= 0) return null;                 // it will stop before it gets there
    tau = (sh - Math.sqrt(disc)) / decel;
  }
  let y = b.grounded ? BALL.R : p.y + u.y * tau - 0.5 * SIM.G * tau * tau;
  if (y < BALL.R) y = BALL.R;
  return { x: p.x + (u.x / sh) * dist, y, tau };
}

// Launch velocity for a dive decided by reading the ball: carry the hips far
// enough that the hands cover the rest, and go low or high to match.
function readLaunch(k, pred) {
  const K = KEEPER;
  const S = K.SCALE;
  const dx = pred.x - k.pos.x;
  const sgn = dx < 0 ? -1 : 1;
  const ax = dx < 0 ? -dx : dx;
  const T = Math.max(0.15, pred.tau - K.PUSH_TIME * 0.5);
  const need = Math.max(0, ax - K.READ_REACH * S);
  let vx = Math.min(PLAN.DIVE_MAX_SPEED, need / T);
  // A low ball still needs the keeper to go down to it: drop sideways onto
  // it rather than collapsing straight down beside it.
  if (pred.y < 0.6 * S && ax > 0.2) vx = Math.max(vx, K.LOW_DROP_SPEED);
  const jump = clamp((pred.y - 0.9 * S) * K.READ_HEIGHT_GAIN, PLAN.JUMP_MIN, PLAN.JUMP_MAX);
  return v(sgn * vx, jump, 0.12 * vx);
}

function commitLaunch(k, t, lv, read) {
  const K = KEEPER;
  const S = K.SCALE;
  k.phase = 'push';
  k.pushT = 0;
  k.groundT = 0;
  k.launchVel = lv;
  const lx = lv.x;
  const ly = Math.max(K.LEAN_MIN, lv.y + K.LEAN_BIAS);
  const l = Math.sqrt(lx * lx + ly * ly);
  k.leanTarget = { s: lx / l, c: ly / l };
  const ax = lx < 0 ? -lx : lx;
  const star = ax < K.STAR_SPEED && lv.y > 0.5;
  k.armsTarget = star ? ARMS_STAR : diveArms(lx > 0 ? 1 : -1, lv.y, k.leanTarget);
  k.act = { t0: t, vx: lx, jump: lv.y, star, read };
  k.commits.push(k.act);
  // The trailing foot stays on the grass while the other leg drives.
  if (ax >= K.STAR_SPEED) {
    const side = lx > 0 ? -1 : 1;
    const foot = keeperCapsules({ pos: k.pos, lean: k.lean, arms: k.arms, plant: null })[side < 0 ? 0 : 4].b;
    k.plant = { side, x: foot.x, y: foot.y, z: foot.z };
    k.plantUntil = t + K.PUSH_TIME + K.PLANT_EXTRA;
  }
}

// Both hands steer towards the predicted crossing point (body frame).
function trackArms(k, pred) {
  const K = KEEPER;
  const S = K.SCALE;
  const { s, c } = k.lean;
  const aim = (side) => {
    const sx = K.SHOULDER_X * side * S;
    const sy = K.SHOULDER_Y * S;
    const wx = pred.x - (k.pos.x + sx * c + sy * s);
    const wy = pred.y - (k.pos.y - sx * s + sy * c);
    const d = norm(v(wx, wy, 0.25 * S));
    return v(d.x * c - d.y * s, d.x * s + d.y * c, d.z);
  };
  k.armsTarget = { l: aim(-1), r: aim(1) };
}

// Where the keeper thinks the ball will cross: the prediction, off by its
// misread scaled down the longer it has watched.
function perceive(k, pred, t) {
  if (!pred || !k.misread) return pred;
  const f = readEarliness(t);
  const y = pred.y + k.misread.y * lerpRange(KEEPER.MISREAD_Y, f);
  return { x: pred.x + k.misread.x * lerpRange(KEEPER.MISREAD_X, f), y: y < BALL.R ? BALL.R : y, tau: pred.tau };
}

// A committed dive as executed: off by the misjudgement, more if early.
function misjudge(k, lv, reaction) {
  if (!k.misread) return lv;
  const f = diveEarliness(reaction);
  const vx = clamp(lv.x + k.misread.vx * lerpRange(KEEPER.MISJUDGE_VX, f), -PLAN.DIVE_MAX_SPEED, PLAN.DIVE_MAX_SPEED);
  const jump = clamp(lv.y + k.misread.jump * lerpRange(KEEPER.MISJUDGE_JUMP, f), PLAN.JUMP_MIN, PLAN.JUMP_MAX);
  return v(vx, jump, lv.z);
}

function keeperStep(k, plan, step, t, dt, ball) {
  const K = KEEPER;
  const mode = planMode(plan);
  // Once it has the ball the keeper stops reading the shot: no more moves,
  // and the arms gather the ball into the chest. Otherwise it reads the ball
  // every READ_EVERY steps and acts on its latest read in between.
  let fresh = false;
  if (!k.holding && step >= k.nextRead) {
    k.read = perceive(k, predictCrossing(ball, k.pos.z), t);
    k.nextRead = step + K.READ_EVERY;
    fresh = true;
  }
  const pred = k.holding ? null : k.read;
  if (k.holding) k.armsTarget = ARMS_HOLD;

  if (k.phase === 'ready' && !k.holding) {
    if (mode === 'read') {
      if (t >= K.READ_BASE + plan.reaction) {
        if (pred && pred.tau <= K.READ_SHUFFLE_T) commitLaunch(k, t, readLaunch(k, pred), true);
        else k.phase = 'recover'; // on its feet: shuffle across, dive when it is close
      }
    } else if (t >= plan.reaction) {
      commitLaunch(k, t, misjudge(k, keeperLaunchVelocity(plan), plan.reaction), false);
    }
  }
  if (fresh && t >= K.PERCEIVE && pred) trackArms(k, pred);

  let leanRate = K.LEAN_RATE;
  if (k.phase === 'push') {
    k.pushT += dt;
    // Legs drive the planned velocity in over PUSH_TIME while gravity already
    // pulls the hips down (the standing leg bends into the dive).
    const f = Math.min(1, k.pushT / K.PUSH_TIME);
    const lv = k.launchVel;
    k.vel = v(lv.x * f, lv.y * f - SIM.G * k.pushT, lv.z * f);
    if (f >= 1) k.phase = 'air';
  } else if (k.phase === 'air') {
    k.vel = v(k.vel.x, k.vel.y - SIM.G * dt, k.vel.z);
  } else if (k.phase === 'ground') {
    const sp = Math.sqrt(k.vel.x * k.vel.x + k.vel.z * k.vel.z);
    const sc = sp > 0 ? Math.max(0, sp - K.SLIDE_DECEL * dt) / sp : 0;
    k.vel = v(k.vel.x * sc, 0, k.vel.z * sc);
    k.groundT += dt;
    if (k.groundT >= K.RECOVER_DELAY && !(pred && pred.tau < K.HOLD_DOWN_T)) {
      k.phase = 'recover';
      k.leanTarget = { s: 0, c: 1 };
    }
  } else if (k.phase === 'recover') {
    leanRate = K.RECOVER_LEAN_RATE;
    let vx = k.vel.x;
    let vz = 0;
    if (k.lean.c > 0.35) {
      // Scramble, then shuffle, towards where the ball is heading: the more
      // upright, the faster.
      const tx = pred ? clamp(pred.x, -GOAL.HW, GOAL.HW) : k.pos.x;
      const top = K.RECOVER_SPEED * k.lean.c;
      const want = clamp((tx - k.pos.x) * 5, -top, top);
      vx += clamp(want - vx, -K.RECOVER_ACCEL * dt, K.RECOVER_ACCEL * dt);
      vz = clamp((GOAL.Z + K.LINE_OFFSET - k.pos.z) * 3, -1.5, 1.5);
    } else {
      vx = 0;
    }
    k.vel = v(vx, 0, vz);
    if (k.commits.length < K.MAX_COMMITS && k.lean.c > 0.55 && pred && pred.tau < K.REDIVE_WINDOW) {
      const dx = pred.x - k.pos.x;
      if (dx > K.REDIVE_MIN_DX || dx < -K.REDIVE_MIN_DX || pred.y < 0.45 || pred.y > 1.9) {
        commitLaunch(k, t, readLaunch(k, pred), true);
      }
    }
  }
  k.pos = add(k.pos, scale(k.vel, dt));
  k.lean = nlerp2(k.lean, k.leanTarget, Math.min(1, leanRate * dt));
  const fa = Math.min(1, (t >= K.PERCEIVE ? K.ARM_TRACK_RATE : K.ARM_RATE) * dt);
  k.arms = { l: blendUnit(k.arms.l, k.armsTarget.l, fa), r: blendUnit(k.arms.r, k.armsTarget.r, fa) };

  // The clearance depends on the lean alone (cached), and no lean puts it
  // above SCALE: with the hips higher than that, it cannot matter.
  const grounded = k.phase === 'ground' || k.phase === 'recover';
  let clr = -Infinity;
  if (grounded || k.pos.y <= K.SCALE) {
    if (k.clrS !== k.lean.s || k.clrC !== k.lean.c) {
      k.clr = keeperClearance(k);
      k.clrS = k.lean.s;
      k.clrC = k.lean.c;
    }
    clr = k.clr;
  }
  if (grounded || k.pos.y < clr) {
    k.pos = v(k.pos.x, clr, k.pos.z);
    if (k.phase === 'air' && k.vel.y <= 0) {
      k.phase = 'ground';
      k.groundT = 0;
    }
    if (k.vel.y < 0 || grounded) k.vel = v(k.vel.x, 0, k.vel.z);
  }
  armsAboveGround(k);

  if (k.plant) {
    const S = K.SCALE;
    const hx = k.pos.x + 0.11 * k.plant.side * S * k.lean.c;
    const hy = k.pos.y - 0.11 * k.plant.side * S * k.lean.s;
    const dx = k.plant.x - hx;
    const dy = k.plant.y - hy;
    const maxL = 0.85 * S * K.PLANT_STRETCH;
    if (t > k.plantUntil || dx * dx + dy * dy > maxL * maxL) k.plant = null;
  }
}

export function keeperPose(k) {
  return {
    pos: { ...k.pos },
    lean: { ...k.lean },
    arms: { l: { ...k.arms.l }, r: { ...k.arms.r } },
    plant: k.plant ? { ...k.plant } : null,
    act: k.act ? { ...k.act } : null,
  };
}

// The keeper moves at 50 Hz: blocks of SIM.KEEPER_BLOCK steps, each one
// keeper step of that length taken at the block's start, from pose A (the
// block's start) to pose B (its end). A block in which its plan commits is a
// single millisecond instead, so the reaction time keeps 1 ms precision.
// Within a block the shapes the ball meets are interpolated between A's and
// B's, one per millisecond, moving at the block's constant velocity.
function blockLen(k, plan, step) {
  const fine = k.phase === 'ready' && !k.holding &&
    planCommitTime(plan) <= (step + SIM.KEEPER_BLOCK - 1) * SIM.DT;
  return fine ? 1 : SIM.KEEPER_BLOCK;
}

function keeperBlock(k, plan, step, ball, kb) {
  kb.s0 = step;
  kb.len = blockLen(k, plan, step);
  kb.A = kb.B;
  kb.capsA = kb.capsB;
  kb.velA = null;
  const end = step + kb.len - 1;
  keeperStep(k, plan, end, end * SIM.DT, kb.len * SIM.DT, ball);
  kb.B = keeperPose(k);
  kb.capsB = null;
}

function newKeeperBlocks(k) {
  return { s0: 0, len: 0, A: null, B: keeperPose(k), capsA: null, capsB: null, velA: null };
}

const blockCapsA = (kb) => kb.capsA || (kb.capsA = keeperCapsules(kb.A));
const blockCapsB = (kb) => kb.capsB || (kb.capsB = keeperCapsules(kb.B));

// Shape i at `num` steps into the block (num = len is pose B).
function blockCap(kb, i, num) {
  const b = blockCapsB(kb)[i];
  if (num === kb.len) return b;
  const a = blockCapsA(kb)[i];
  const f = num / kb.len;
  return { ...b, a: lerpV(a.a, b.a, f), b: lerpV(a.b, b.b, f) };
}

// All the shapes at `num` steps into the block.
function blockCaps(kb, num) {
  if (num === kb.len) return blockCapsB(kb);
  return blockCapsB(kb).map((_, i) => blockCap(kb, i, num));
}

// The velocity of shape i's end points during the block.
function blockVel(kb, i) {
  if (!kb.velA) kb.velA = [];
  if (!kb.velA[i]) {
    const a = blockCapsA(kb)[i];
    const b = blockCapsB(kb)[i];
    const inv = 1 / (kb.len * SIM.DT);
    kb.velA[i] = { a: scale(sub(b.a, a.a), inv), b: scale(sub(b.b, a.b), inv) };
  }
  return kb.velA[i];
}

const lerpV = (p, q, f) => v(p.x + (q.x - p.x) * f, p.y + (q.y - p.y) * f, p.z + (q.z - p.z) * f);

// The keeper's pose `num` steps into the block, for drawing (not physics).
function blockPose(kb, num) {
  if (num === kb.len || !kb.A) return kb.B;
  const f = num / kb.len;
  const A = kb.A;
  const B = kb.B;
  const unit2 = (s, c) => {
    const l = Math.sqrt(s * s + c * c);
    return { s: s / l, c: c / l };
  };
  return {
    pos: lerpV(A.pos, B.pos, f),
    lean: unit2(A.lean.s + (B.lean.s - A.lean.s) * f, A.lean.c + (B.lean.c - A.lean.c) * f),
    arms: { l: norm(lerpV(A.arms.l, B.arms.l, f)), r: norm(lerpV(A.arms.r, B.arms.r, f)) },
    plant: f < 0.5 ? A.plant : B.plant,
    act: B.act,
  };
}

// The keeper's plan played out with no ball in play, for previews: one pose
// every `every` steps until `duration` seconds after contact. Without a ball
// to watch the arms keep the plan's shape, and a reading keeper only shuffles.
export function previewKeeper(plan, duration = 1.0, every = SIM.RECORD_EVERY) {
  const k = keeperInitialState();
  const still = { p: v(0, BALL.R, 0), v: v(0, 0, 0), grounded: true };
  const out = [{ t: 0, ...keeperPose(k) }];
  const n = Math.round(duration / SIM.DT);
  const kb = newKeeperBlocks(k);
  for (let i = 1; i <= n; i++) {
    const t = i * SIM.DT;
    if (i >= kb.s0 + kb.len) keeperBlock(k, plan, i, still, kb);
    if (i % every === 0) out.push({ t, ...blockPose(kb, i - kb.s0 + 1) });
  }
  return out;
}

// ------------------------------------------------------------ catch or parry

// Distance from p to segment a-b.
function segDist(p, a, b) {
  const ab = sub(b, a);
  const abab = dot(ab, ab);
  const s = abab > 0 ? clamp(dot(sub(p, a), ab) / abab, 0, 1) : 0;
  return len(sub(p, add(a, scale(ab, s))));
}

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

// Whether a keeper contact holds the ball: relSpeed is the ball's speed
// relative to the part it hit, just before impact; caps is the keeper's pose.
export function catchDecision(caps, part, relSpeed, ballP) {
  const K = KEEPER;
  const S = K.SCALE;
  const gl = caps.find((c) => c.name === 'left glove').a;
  const gr = caps.find((c) => c.name === 'right glove').a;
  const mid = scale(add(gl, gr), 0.5);
  // Hands "on the ball" means lined up behind it, in the plane facing the
  // shot: depth is ignored, so a touch a few centimetres early still counts.
  const hx = ballP.x - mid.x;
  const hy = ballP.y - mid.y;
  const hands = 1 - clamp01((Math.sqrt(hx * hx + hy * hy) - K.CATCH_HANDS_GAP * S) /
    ((K.CATCH_HANDS_SPAN - K.CATCH_HANDS_GAP) * S));
  let toBody = Infinity;
  for (const c of caps) {
    if (c.kind === 'torso') toBody = Math.min(toBody, segDist(ballP, c.a, c.b) - c.r);
  }
  const body = 1 - clamp01((toBody - K.CATCH_BODY_NEAR * S) / ((K.CATCH_BODY_FAR - K.CATCH_BODY_NEAR) * S));
  const quality = K.CATCH_HANDS_WEIGHT * hands + (1 - K.CATCH_HANDS_WEIGHT) * body;
  let limit = K.CATCH_SPEED_MIN + (K.CATCH_SPEED_MAX - K.CATCH_SPEED_MIN) * quality;
  let how = part.kind === 'torso' ? 'into the chest' : hands >= 0.5 ? 'with both hands' : `one-handed (${part.name})`;
  if (part.kind === 'glove' && hands < 0.5) limit = Math.min(limit, K.ONE_HAND_MAX);
  let catchable = part.kind === 'glove' || part.kind === 'torso';
  if (part.kind === 'leg' || part.kind === 'arm') {
    // Legs and arms only ever gather a ball that has nearly stopped.
    catchable = true;
    limit = K.GATHER_SPEED;
    how = part.kind === 'leg' ? 'gathered at the feet' : 'gathered in the arms';
  } else if (catchable && relSpeed <= K.GATHER_SPEED && ballP.y < 0.6) {
    limit = Math.max(limit, K.GATHER_SPEED);
    how = 'smothered on the ground';
  }
  return { held: catchable && relSpeed <= limit, quality, hands, toBody, limit, relSpeed, how };
}

// Where a held ball sits: between the gloves, a little in front of them.
function holdPoint(caps) {
  const gl = caps.find((c) => c.name === 'left glove').a;
  const gr = caps.find((c) => c.name === 'right glove').a;
  const p = add(scale(add(gl, gr), 0.5), v(0, 0, 0.06 * KEEPER.SCALE));
  return v(p.x, Math.max(BALL.R, p.y), p.z);
}

// --------------------------------------------------------------------- goal

export function goalFrameCapsules() {
  const px = GOAL.HW + GOAL.POST_R;
  const top = GOAL.H + GOAL.POST_R;
  return [
    { name: 'left post', a: v(-px, 0, GOAL.Z), b: v(-px, top, GOAL.Z), r: GOAL.POST_R },
    { name: 'right post', a: v(px, 0, GOAL.Z), b: v(px, top, GOAL.Z), r: GOAL.POST_R },
    { name: 'crossbar', a: v(-px, top, GOAL.Z), b: v(px, top, GOAL.Z), r: GOAL.POST_R },
  ];
}

// --------------------------------------------------------------------- kick

function clampDisc(x, y, max) {
  const r2 = x * x + y * y;
  if (r2 <= max * max) return { x, y };
  const s = max / Math.sqrt(r2);
  return { x: x * s, y: y * s };
}

// Approximate standard normal from 12 bytes of the mishit seed: six uint16
// uniforms summed (Irwin-Hall, n = 6), using exactly-rounded arithmetic only.
function mishitNormal(seed, offset) {
  if (seed.length !== STRIKE_SEED_BYTES) throw new Error(`mishit seed needs ${STRIKE_SEED_BYTES} bytes`);
  let sum = 0;
  for (let i = 0; i < 6; i++) sum += u16(seed, offset + 2 * i) / 65535;
  return (sum - 3) * 1.4142135623730951;
}

// The keeper's misread for a kick: four standard normals (Irwin-Hall,
// n = 6) from a salted hash of the 24-byte mishit seed, so the same sealed
// bytes fix it, independently of the mishit itself. null without a seed.
const MISREAD_SALT = 0x6b656570; // "keep"
export function keeperMisread(seed) {
  if (seed === undefined || seed === null) return null;
  if (seed.length !== STRIKE_SEED_BYTES) throw new Error(`mishit seed needs ${STRIKE_SEED_BYTES} bytes`);
  const rnd = mulberry32(fnvBytes(0x811c9dc5 ^ MISREAD_SALT, seed) >>> 0);
  const normal = () => {
    let sum = 0;
    for (let i = 0; i < 6; i++) sum += rnd();
    return (sum - 3) * 1.4142135623730951;
  };
  return { x: normal(), y: normal(), vx: normal(), jump: normal() };
}

const lerpRange = ([late, early], f) => late + (early - late) * f;
// 1 when acting as early as possible, 0 when as late as the range allows.
const readEarliness = (t) => clamp((KEEPER.MISREAD_T[1] - t) / (KEEPER.MISREAD_T[1] - KEEPER.MISREAD_T[0]), 0, 1);
const diveEarliness = (reaction) =>
  clamp((PLAN.REACTION_MAX - reaction) / (PLAN.REACTION_MAX - PLAN.REACTION_MIN), 0, 1);

// Standard deviations of the misread for a plan: of a read at its commit
// time (m), and of a committed dive (m/s). For the UI and analysis.
export function misreadSigmas(plan) {
  const K = KEEPER;
  const fr = readEarliness(planCommitTime(plan));
  const fd = diveEarliness(plan.reaction);
  return planMode(plan) === 'read'
    ? { x: lerpRange(K.MISREAD_X, fr), y: lerpRange(K.MISREAD_Y, fr), vx: 0, jump: 0 }
    : { x: lerpRange(K.MISREAD_X, 1), y: lerpRange(K.MISREAD_Y, 1), vx: lerpRange(K.MISJUDGE_VX, fd), jump: lerpRange(K.MISJUDGE_JUMP, fd) };
}

// input: { aim: {x, y} point on the goal plane the foot swings towards,
//          contact: {x, y} intended offset on the ball's back face in ball
//                   radii (+x = right of centre, +y = above centre),
//          power: 0..1,
//          seed:  optional 24-byte mishit seed; if present the boot lands
//                 slightly off the intended contact point }
export function computeLaunch(input) {
  const pos = v(0, BALL.R, 0);
  const target = v(clamp(input.aim.x, -KICK.AIM_X, KICK.AIM_X), clamp(input.aim.y, 0, KICK.AIM_Y), GOAL.Z);
  const f = norm(sub(target, pos));        // swing direction of the foot
  const right = norm(cross(f, UP));
  const up = cross(right, f);

  const power = clamp(input.power, 0, 1);
  const intended = clampDisc(input.contact.x, input.contact.y, KICK.MAX_CONTACT);
  const fuzz = { x: 0, y: 0 };
  if (input.seed !== undefined) {
    const sigma = KICK.FUZZ_BASE + KICK.FUZZ_POWER * power;
    fuzz.x = mishitNormal(input.seed, 0) * sigma;
    fuzz.y = mishitNormal(input.seed, 12) * sigma;
  }
  const { x: cx, y: cy } = clampDisc(intended.x + fuzz.x, intended.y + fuzz.y, KICK.MAX_STRIKE);
  const cz = Math.sqrt(1 - cx * cx - cy * cy);
  // Outward surface normal at the contact point (on the back of the ball).
  const n = add(add(scale(right, cx), scale(up, cy)), scale(f, -cz));

  // A frictionless contact pushes the ball along -n (through its centre); the
  // boot's friction drags it along the swing. Blend the two.
  const dir = norm(add(scale(f, 1 - KICK.NORMAL_MIX), scale(n, -KICK.NORMAL_MIX)));
  const quality = cz;                       // 1 = dead centre, falls off for glancing hits
  const efficiency = 0.55 + 0.45 * quality;
  const speed = (KICK.MIN_SPEED + (KICK.MAX_SPEED - KICK.MIN_SPEED) * power) * efficiency;
  const vel = scale(dir, speed);

  // Angular impulse of the off-centre strike: dL = r x J, w = dL / I.
  const rc = scale(n, BALL.R);
  const dL = scale(cross(rc, scale(vel, BALL.M)), 1 / BALL.I);
  const side = dot(dL, up);
  const backAxis = sub(dL, scale(up, side));
  let spin = add(scale(up, side * KICK.SIDE_SPIN_TRANSFER), scale(backAxis, KICK.BACK_SPIN_TRANSFER));
  const sm = len(spin);
  if (sm > KICK.MAX_SPIN) spin = scale(spin, KICK.MAX_SPIN / sm);

  return {
    pos, vel, spin, speed, efficiency, power,
    footDir: f,
    intended,
    fuzz,
    contact: { x: cx, y: cy },
    contactNormal: n,
    contactPoint: add(pos, rc),
  };
}

// --------------------------------------------------------------------- ball

function rollingSpin(u) {
  // w = (up x v) / R : no slip at the contact patch
  return v(u.z / BALL.R, 0, -u.x / BALL.R);
}

function quatIntegrate(q, w, dt) {
  // q' = q + dt/2 * (0, w) * q, renormalised
  const h = 0.5 * dt;
  const x = q.x + h * (w.x * q.w + w.y * q.z - w.z * q.y);
  const y = q.y + h * (w.y * q.w + w.z * q.x - w.x * q.z);
  const z = q.z + h * (w.z * q.w + w.x * q.y - w.y * q.x);
  const qw = q.w - h * (w.x * q.x + w.y * q.y + w.z * q.z);
  const l = Math.sqrt(x * x + y * y + z * z + qw * qw);
  return { x: x / l, y: y / l, z: z / l, w: qw / l };
}

function netAccel(b) {
  const { p, v: u } = b;
  const R = BALL.R;
  const K = GOAL.NET_K / BALL.M;
  const C = GOAL.NET_C / BALL.M;
  let ax = 0, ay = 0, az = 0, touching = false;

  // Each panel is a damped spring along its inward normal n. Netting gives
  // back little of what it absorbs, so the spring is much weaker while the
  // ball is moving back out (vn > 0) than while it is stretching the mesh.
  const panel = (pen, vn) => {
    if (pen <= 0) return 0;
    touching = true;
    const f = (vn < 0 ? K : K * GOAL.NET_RECOIL) * pen - C * vn;
    return f > 0 ? f : 0;
  };
  az += panel(NET.BACK_Z - (p.z - R), u.z);
  ay -= panel(p.y + R - NET.ROOF_Y, -u.y);
  const sx = p.x > 0 ? -1 : 1;
  ax += sx * panel(Math.abs(p.x) + R - NET.SIDE_X, sx * u.x);
  if (touching) {
    ax -= GOAL.NET_FRICTION * u.x;
    ay -= GOAL.NET_FRICTION * u.y;
    az -= GOAL.NET_FRICTION * u.z;
  }
  return v(ax, ay, az);
}

// The ball's speed for drag: one Newton step from the speed of the previous
// evaluation (b.sp) while the speed has changed by under half a per cent,
// otherwise (the first step, after an impact) a square root. Off by well
// under a millionth, without a root on most steps.
function ballSpeed(b, u = b.v) {
  const s2 = u.x * u.x + u.y * u.y + u.z * u.z;
  const s = b.sp;
  const d = s2 - s * s;
  if (s > 0 && d <= 0.01 * s2 && d >= -0.01 * s2) return 0.5 * (s + s2 / s);
  return Math.sqrt(s2);
}

// Gravity, drag and Magnus lift on a ball in the air at velocity u, spin w,
// drag speed sp.
function airAccel(u, w, sp) {
  return v(
    -DRAG_K * sp * u.x + (w.y * u.z - w.z * u.y) * MAGNUS_K,
    -DRAG_K * sp * u.y - SIM.G + (w.z * u.x - w.x * u.z) * MAGNUS_K,
    -DRAG_K * sp * u.z + (w.x * u.y - w.y * u.x) * MAGNUS_K,
  );
}

// Free flight, away from everything it can touch: one Heun (second-order
// Runge-Kutta) step of dt. Far more accurate than the 1 ms Euler steps used
// near contacts (within a tenth of a millimetre at the goal, against
// millimetres), at a fraction of the work.
function heunBall(b, dt) {
  const u = b.v;
  const s1 = ballSpeed(b);
  b.sp = s1;
  const a1 = airAccel(u, b.w, s1);
  const v1 = v(u.x + a1.x * dt, u.y + a1.y * dt, u.z + a1.z * dt);
  const w1 = scale(b.w, 1 - BALL.SPIN_DECAY * dt);
  const s2 = ballSpeed(b, v1);
  b.sp = s2;
  const a2 = airAccel(v1, w1, s2);
  const h = 0.5 * dt;
  b.p = v(b.p.x + (u.x + v1.x) * h, b.p.y + (u.y + v1.y) * h, b.p.z + (u.z + v1.z) * h);
  b.v = v(u.x + (a1.x + a2.x) * h, u.y + (a1.y + a2.y) * h, u.z + (a1.z + a2.z) * h);
  b.w = w1;
  b.q = quatIntegrate(b.q, b.w, dt);
}

// Whether the ball can take a free-flight step of SIM.BALL_BLOCK from `step`:
// nothing it can touch within reach of it during the step (the keeper, the
// posts, bar and line, the net, landing), and the step inside one keeper
// block. In SIM.BALL_BLOCK ms the ball travels at most 20 cm, less than half
// the depth of the band in which it is found to be in the net.
export function freeFlight(ball, keeper, plan, kb, step, pounced) {
  const B = SIM.BALL_BLOCK;
  if (ball.held || pounced || ball.inGoal) return false;
  if (nearFrame(ball.p, 0.25)) return false;
  if (!ball.grounded && ball.p.y < BALL.R + 0.15) return false;
  if (!keeper) return true;
  const dx = ball.p.x - keeper.pos.x;
  const dy = ball.p.y - keeper.pos.y;
  const dz = ball.p.z - keeper.pos.z;
  const far = ZONES.PROBE + 0.3;
  if (dx * dx + dy * dy + dz * dz < far * far) return false;
  const first = step + 1;
  const end = first >= kb.s0 + kb.len ? first + blockLen(keeper, plan, first) - 1 : kb.s0 + kb.len - 1;
  return first + B - 1 <= end;
}

// Semi-implicit Euler: gravity, quadratic drag, Magnus lift, net springs, rolling.
function integrateBall(b, dt) {
  const u = b.v;
  const sp = ballSpeed(b);
  b.sp = sp;
  let a = v(-DRAG_K * sp * u.x, -DRAG_K * sp * u.y - SIM.G, -DRAG_K * sp * u.z);
  if (!b.grounded) a = add(a, scale(cross(b.w, u), MAGNUS_K));
  if (b.inGoal) a = add(a, netAccel(b));
  if (b.grounded) {
    if (a.y < 0) a = v(a.x, 0, a.z); // the ground's normal force
    const h = Math.sqrt(u.x * u.x + u.z * u.z);
    if (h > 0) {
      const d = Math.min(BALL.ROLL_DECEL, h / dt);
      a = v(a.x - (d * u.x) / h, a.y, a.z - (d * u.z) / h);
    }
  }
  b.v = add(u, scale(a, dt));
  b.p = add(b.p, scale(b.v, dt));
  if (b.grounded) {
    const roll = rollingSpin(b.v);
    b.w = v(roll.x, b.w.y * (1 - 2 * dt), roll.z);
  } else {
    b.w = scale(b.w, 1 - BALL.SPIN_DECAY * dt);
  }
  b.q = quatIntegrate(b.q, b.w, dt);
}

function groundContact(b) {
  if (b.p.y >= BALL.R) return 0;
  b.p = v(b.p.x, BALL.R, b.p.z);
  if (b.v.y >= 0) return 0;
  const vy = -b.v.y;
  if (!b.grounded && vy > BALL.MIN_BOUNCE_VY) {
    const k = BALL.GROUND_KEEP;
    b.v = v(b.v.x * k, vy * BALL.E_GROUND, b.v.z * k);
    b.w = add(scale(b.w, 0.5), scale(rollingSpin(b.v), 0.5));
    return vy;
  }
  b.v = v(b.v.x, 0, b.v.z);
  b.grounded = true;
  return 0;
}

// Ball (sphere) against a capsule whose end points move with velocities va, vb.
// Resolves penetration, then applies restitution e on the normal component and
// friction mu on the tangential one, relative to the surface velocity.
// The contact a capsule would make with the ball, without resolving it.
function probeCapsule(b, a, bb, r, va, vb) {
  const ab = sub(bb, a);
  const abab = dot(ab, ab);
  const s = abab > 0 ? clamp(dot(sub(b.p, a), ab) / abab, 0, 1) : 0;
  const d = sub(b.p, add(a, scale(ab, s)));
  const minD = BALL.R + r;
  const d2 = dot(d, d);
  if (d2 >= minD * minD) return null;
  const dist = Math.sqrt(d2);
  const n = dist > 1e-9 ? scale(d, 1 / dist) : v(0, 0, 1);
  const sv = va ? add(va, scale(sub(vb, va), s)) : v(0, 0, 0);
  const rel = sub(b.v, sv);
  const vn = dot(rel, n);
  if (vn >= 0) return null;
  return { relSpeed: len(rel), vn, dist };
}

// give (optional) caps the change in normal speed the part can impart; a
// ball that needs more pushes through: it keeps its position and loses only
// that much normal speed.
function collideCapsule(b, a, bb, r, va, vb, e, mu, spinKeep, give = Infinity) {
  const ab = sub(bb, a);
  const abab = dot(ab, ab);
  const s = abab > 0 ? clamp(dot(sub(b.p, a), ab) / abab, 0, 1) : 0;
  const q = add(a, scale(ab, s));
  const d = sub(b.p, q);
  const d2 = dot(d, d);
  const minD = BALL.R + r;
  if (d2 >= minD * minD) return null;
  const dist = Math.sqrt(d2);
  const n = dist > 1e-9 ? scale(d, 1 / dist) : v(0, 0, 1);
  const sv = va ? add(va, scale(sub(vb, va), s)) : v(0, 0, 0);
  const rel = sub(b.v, sv);
  const vn = dot(rel, n);
  if (vn >= 0) {
    b.p = add(q, scale(n, minD));
    return null;
  }
  const relN = scale(n, vn);
  const relT = sub(rel, relN);
  const relSpeed = len(rel);
  const needed = -(1 + e) * vn;
  if (needed > give) {
    // The limb gives way: the ball keeps going through it, slowed.
    b.v = add(sv, add(scale(relT, 1 - mu), scale(n, vn + give)));
    b.w = scale(b.w, spinKeep);
    return { impactSpeed: -vn, relSpeed, point: add(q, scale(n, r)), gaveWay: true };
  }
  b.p = add(q, scale(n, minD));
  b.v = add(sv, sub(scale(relT, 1 - mu), scale(relN, e)));
  b.w = scale(b.w, spinKeep);
  return { impactSpeed: -vn, relSpeed, point: add(q, scale(n, r)), gaveWay: false };
}

// ---------------------------------------------------------------- simulate

// Work done only near the keeper or the goal frame, as in the on-chain port
// (which is charged for every operation). A keeper part, at full reach, can
// touch the ball only within about 2.0 m of the hip (the farthest part is a
// glove, 1.29 x SCALE from it, plus 0.35 m of collision margin and reaction
// reach, plus the ball's radius: 1.97 m; the hip used is the block's end
// pose, at most 14 cm from the interpolated one), so contacts are checked from
// PROBE out. Posts and bar are only checked within a centimetre of reach
// (nearFrame). Skipping these
// checks where they would find nothing leaves every result unchanged.
export const ZONES = { PROBE: 2.2 };

// Whether the keeper gets to a loose ball before it is wholly over the line
// (see KEEPER.POUNCE_*).
function pounces(k, ball) {
  const K = KEEPER;
  if (k.holding || k.phase === 'push' || k.phase === 'air' || ball.p.y > K.POUNCE_HEIGHT) return false;
  const dx = ball.p.x - k.pos.x;
  const dy = ball.p.y - k.pos.y;
  const dz = ball.p.z - k.pos.z;
  const d2 = dx * dx + dy * dy + dz * dz;
  if (d2 >= K.POUNCE_REACH * K.POUNCE_REACH) return false;
  const u = ball.v;
  if (u.x * u.x + u.y * u.y + u.z * u.z >= K.POUNCE_SPEED * K.POUNCE_SPEED) return false;
  if (u.z >= 0) return true;
  // The keeper needs POUNCE_DELAY plus (distance - POUNCE_NEAR) / POUNCE_MOVE:
  // it gets there first if the distance is under POUNCE_NEAR plus what it
  // covers in the time the ball leaves it (compared squared: no root).
  const over = GOAL.Z - GOAL.POST_R - BALL.R; // the ball's centre when it is wholly over the line
  const spare = (ball.p.z - over) / -u.z - K.POUNCE_DELAY;
  if (spare <= 0) return false;
  const reach = K.POUNCE_NEAR + spare * K.POUNCE_MOVE;
  return d2 < reach * reach;
}

// Whether a ball at p is within m (beyond touching) of a post or the bar.
function nearFrame(p, m) {
  const reach = BALL.R + GOAL.POST_R + m;
  const dz = p.z - GOAL.Z;
  if (dz > reach || dz < -reach) return false;
  const ax = p.x < 0 ? -p.x : p.x;
  const dx = ax - NET.SIDE_X;
  const dy = p.y - NET.ROOF_Y;
  return (dx < reach && dx > -reach) || (dy < reach && dy > -reach && ax < NET.SIDE_X + reach);
}

// Whether p is more than m outside, on some axis, the box spanned by the end
// points of capsule c0 and capsule c1 (a part at the start and end of a
// keeper block: every interpolated position lies inside it).
function outsideBox4(p, c0, c1, m) {
  for (const k of ['x', 'y', 'z']) {
    let lo = c0.a[k];
    let hi = lo;
    for (const q of [c0.b[k], c1.a[k], c1.b[k]]) {
      if (q < lo) lo = q;
      if (q > hi) hi = q;
    }
    if (p[k] < lo - m || p[k] > hi + m) return true;
  }
  return false;
}

const placement = (x, y) => {
  const h = x < -1.2 ? 'left' : x > 1.2 ? 'right' : 'centre';
  const vtc = y > 1.6 ? 'top' : y < 0.8 ? 'bottom' : 'middle';
  if (h === 'centre') return vtc === 'middle' ? 'straight down the middle' : `${vtc} centre`;
  if (vtc === 'middle') return `${h} side, mid-height`;
  return `${vtc}-${h} corner`;
};

const r3 = (x) => Math.round(x * 1000) / 1000;
const pt = (p) => ({ x: r3(p.x), y: r3(p.y), z: r3(p.z) });

// Runs the whole shot to completion and returns every frame plus the verdict.
// plan === null (or opts.keeper === false) simulates an empty goal.
// opts.trace(step, ball, keeper, verdict), for cross-checking other ports of
// this engine, sees the state after every step (step 0 = at contact).
export function simulateShot(input, plan, opts = {}) {
  const withKeeper = plan != null && opts.keeper !== false;
  const launch = computeLaunch(input);
  const ball = {
    p: { ...launch.pos }, v: { ...launch.vel }, w: { ...launch.spin },
    q: { x: 0, y: 0, z: 0, w: 1 }, grounded: false, inGoal: false, held: false,
    sp: 0, // speed at the last drag evaluation (see ballSpeed)
  };
  // opts.misread === false gives the keeper a perfect read (for analysis).
  const keeper = withKeeper ? keeperInitialState(opts.misread === false ? null : keeperMisread(input.seed)) : null;
  const kb = keeper ? newKeeperBlocks(keeper) : null;
  let pounced = false;
  const frame = goalFrameCapsules();
  const frames = [];
  const events = [];
  const log = (t, type, text, pos) => events.push({ t: r3(t), type, text, pos: pos ? pt(pos) : null });

  let step = 0;
  let t = 0;
  let verdict = null;
  let endT = SIM.MAX_T;
  let touch = null;
  let caught = null;   // { t, part, how, relSpeed, limit, quality } once the keeper holds it
  let lastContact = -1; // time of the latest keeper contact
  const contacts = [];  // one entry per touch: where, how fast, and what was decided
  const gaveWay = {};   // part name -> until when it lets the ball through
  let woodwork = null;
  let lineCross = null;
  let crossing = null;
  let bounces = 0;
  let lastKeeperLog = -1;

  // A render frame at step `at` (default: now), the ball at p.
  const record = (at = step, p = ball.p) => frames.push({
    t: at * SIM.DT,
    b: [p.x, p.y, p.z],
    q: [ball.q.x, ball.q.y, ball.q.z, ball.q.w],
    k: keeper ? keeperPose(blockPose(kb, at - kb.s0 + 1)) : null,
    inGoal: ball.inGoal,
    held: ball.held,
  });
  // Frames for steps first..step of a pass, the ball interpolated between
  // its start p0 and end over a free-flight step.
  const recordPass = (first, p0) => {
    for (let r = first; r <= step; r++) {
      if (r % SIM.RECORD_EVERY) continue;
      if (r === step) record();
      else record(r, lerpV(p0, ball.p, (r - first + 1) / (step - first + 1)));
    }
  };

  const decide = (outcome, title, detail) => {
    if (verdict) return;
    verdict = { outcome, title, detail, decidedAt: t };
    endT = Math.min(SIM.MAX_T + 2, t + (outcome === 'goal' ? 1.6 : 1.1));
    log(t, 'result', `${title} ${detail}`, ball.p);
  };

  const notCrossed = (why) => {
    if (touch) decide('save', 'SAVED!', `${why} — stopped by the keeper's ${touch.part}.`);
    else if (woodwork) decide('post', 'WOODWORK!', `Rebounded off the ${woodwork.part}.`);
    else decide('miss', 'MISSED', 'The ball never reached the goal.');
  };

  log(0, 'kick', `Struck at ${(launch.speed * 3.6).toFixed(1)} km/h`, launch.pos);
  record();

  const trace = opts.trace;
  while (t < endT) {
    if (trace) trace(step, ball, keeper, verdict);
    // In free flight the ball moves in steps of SIM.BALL_BLOCK; this pass
    // then covers steps first..step.
    const adv = freeFlight(ball, keeper, plan, kb, step, pounced) ? SIM.BALL_BLOCK : 1;
    const first = step + 1;
    const p0 = ball.p;
    step += adv;
    t = step * SIM.DT;

    // The keeper's shapes are only needed once the ball is within reach:
    // contacts are checked from ZONES.PROBE out (see ZONES).
    let near = false;
    let num = 0; // steps into the keeper's current block
    if (keeper) {
      const phase = keeper.phase;
      const nCommits = keeper.commits.length;
      if (first >= kb.s0 + kb.len) keeperBlock(keeper, plan, first, ball, kb);
      num = step - kb.s0 + 1;
      const dx = ball.p.x - keeper.pos.x;
      const dy = ball.p.y - keeper.pos.y;
      const dz = ball.p.z - keeper.pos.z;
      near = dx * dx + dy * dy + dz * dz < ZONES.PROBE * ZONES.PROBE;
      if (keeper.commits.length > nCommits) {
        const a = keeper.act;
        const dir = a.star ? 'star jump' : (a.vx > 0.3 ? 'right' : a.vx < -0.3 ? 'left' : 'straight down');
        const what = a.star || dir === 'straight down' ? dir : `dive ${dir} at ${(a.vx < 0 ? -a.vx : a.vx).toFixed(1)} m/s`;
        const why = nCommits ? 'Keeper recovers and goes again' : a.read ? 'Keeper reads the shot' : 'Keeper commits';
        log(t, 'keeper-move', `${why}: ${what}, ${a.jump < 0 ? 'low' : a.jump > 2 ? 'high' : 'mid-height'}`, keeper.pos);
      } else if (phase === 'ready' && keeper.phase === 'recover') {
        log(t, 'keeper-move', 'Keeper reads a slow shot and shuffles across', keeper.pos);
      }
    }

    if (ball.held) {
      // In the keeper's hands: drawn into the hold point and carried with it.
      const target = holdPoint(blockCaps(kb, num));
      const f = Math.min(1, KEEPER.HOLD_PULL * SIM.DT);
      const np = add(ball.p, scale(sub(target, ball.p), f));
      ball.v = scale(sub(np, ball.p), 1 / SIM.DT);
      ball.p = v(np.x, Math.max(BALL.R, np.y), np.z);
      ball.w = scale(ball.w, Math.max(0, 1 - 20 * SIM.DT));
      ball.q = quatIntegrate(ball.q, ball.w, SIM.DT);
      if (step % SIM.RECORD_EVERY === 0) record();
      continue;
    }

    if (pounced) {
      if (step % SIM.RECORD_EVERY === 0) record();
      continue;
    }
    if (adv === 1) integrateBall(ball, SIM.DT);
    else if (ball.grounded) integrateBall(ball, adv * SIM.DT);
    else heunBall(ball, adv * SIM.DT);

    const bounce = groundContact(ball);
    if (bounce > 0 && bounces < 3) {
      bounces++;
      log(t, 'bounce', `Bounced at ${bounce.toFixed(1)} m/s vertical`, ball.p);
    }

    // Posts and bar: only near them.
    if (nearFrame(ball.p, 0.01)) {
      for (const c of frame) {
        const hit = collideCapsule(ball, c.a, c.b, c.r, null, null, GOAL.E_POST, 0.1, 0.7);
        if (hit && hit.impactSpeed > 0.5) {
          if (!woodwork) woodwork = { part: c.name, t };
          log(t, 'woodwork', `Hit the ${c.name} at ${hit.impactSpeed.toFixed(1)} m/s`, hit.point);
        }
      }
    }

    if (keeper && near) {
      // Extra reach against a slow ball the keeper has seen coming, and the
      // hands' late adjustment the longer it has watched the shot.
      const sp = ballSpeed(ball);
      const react = t >= KEEPER.PERCEIVE && sp < KEEPER.REACT_SPEED
        ? KEEPER.REACT_REACH * (KEEPER.REACT_SPEED - sp) / KEEPER.REACT_SPEED
        : 0;
      const late = Math.min(KEEPER.HAND_LATE_MAX, KEEPER.HAND_LATE_RATE * Math.max(0, t - KEEPER.PERCEIVE - 0.1));
      const inAir = keeper.phase === 'air'; // during push-off the legs are still planted
      const capsB = blockCapsB(kb);
      for (let i = 0; i < capsB.length; i++) {
        const cb = capsB[i];
        if (gaveWay[cb.name] > t) continue; // a limb that gave way lets the rest of that touch through
        const reach = cb.hit + (cb.kind === 'head' ? 0 : react) + (cb.kind === 'glove' ? late : 0);
        // Farther than the contact distance outside the box of the part's
        // positions over the block on some axis: the probe could find nothing.
        const ca = num === kb.len ? cb : blockCapsA(kb)[i];
        if (outsideBox4(ball.p, ca, cb, BALL.R + reach + 0.01)) continue;
        const c = blockCap(kb, i, num);
        const { a: va, b: vb } = blockVel(kb, i);
        const probe = probeCapsule(ball, c.a, c.b, reach, va, vb);
        if (!probe) continue;
        const before = len(ball.v);
        if (!touch) touch = { part: c.name, t };
        // Catch or parry: decided once per touch, at its first contact, from
        // the ball's speed relative to the part and how well the keeper is
        // behind it. A ball already wholly over the line cannot be caught back.
        const newTouch = t - lastContact > KEEPER.TOUCH_GAP;
        lastContact = t;
        const d = catchDecision(blockCaps(kb, num), c, probe.relSpeed, ball.p);
        const holds = newTouch && d.held && !verdict && ball.p.z >= GOAL.Z - GOAL.POST_R - BALL.R;
        if (holds) {
          contacts.push({
            t: r3(t), part: c.name, kind: c.kind, decision: 'catch', gaveWay: false,
            relSpeed: d.relSpeed, ballSpeed: before, quality: d.quality, limit: d.limit,
            how: d.how, phase: keeper.phase, point: pt(ball.p),
          });
          caught = { t: r3(t), part: c.name, how: d.how, relSpeed: d.relSpeed, limit: d.limit, quality: d.quality };
          ball.held = true;
          ball.grounded = false;
          keeper.holding = true;
          log(t, 'catch', `Keeper catches it ${d.how} at ${(d.relSpeed * 3.6).toFixed(0)} km/h`, ball.p);
          decide('save', 'SAVED!', `Caught ${d.how}.`);
          break;
        }
        // Parry: the part stops what it can; a harder ball pushes through.
        const G = KEEPER.GIVE;
        let give = c.kind === 'glove' ? (d.hands >= 0.5 ? G.hands : G.glove)
          : c.kind === 'leg' ? (inAir ? G.legInAir : G.leg) : G[c.kind];
        if (probe.dist > BALL.R + c.r) give *= KEEPER.FINGERTIP_GIVE;
        if (c.kind === 'glove' && d.toBody < KEEPER.REFLEX_BODY * KEEPER.SCALE) give = Math.max(give, G.torso);
        const e = c.kind === 'glove' ? KEEPER.E_GLOVE : KEEPER.E_BODY;
        const hit = collideCapsule(ball, c.a, c.b, reach, va, vb, e, KEEPER.FRICTION, 0.4, give);
        if (!hit) continue;
        if (hit.gaveWay) gaveWay[c.name] = t + KEEPER.TOUCH_GAP;
        // A manageable glove touch is pushed away and wide, not back in.
        if (!hit.gaveWay && c.kind === 'glove' && probe.relSpeed < KEEPER.PARRY_CONTROL && ball.v.z < KEEPER.PARRY_OUT) {
          const wide = ball.p.x >= keeper.pos.x ? 1 : -1;
          ball.v = v(ball.v.x + wide * KEEPER.PARRY_WIDE, ball.v.y, KEEPER.PARRY_OUT);
        }
        if (newTouch) {
          contacts.push({
            t: r3(t), part: c.name, kind: c.kind, decision: 'parry', gaveWay: hit.gaveWay,
            relSpeed: d.relSpeed, ballSpeed: before, quality: d.quality, limit: d.limit,
            how: d.how, phase: keeper.phase, point: pt(hit.point),
          });
        }
        if (t - lastKeeperLog > 0.05) {
          lastKeeperLog = t;
          const verb = hit.gaveWay ? 'cannot stop it' : 'parries it';
          log(t, 'keeper', `Keeper's ${c.name} ${verb}: ${(before * 3.6).toFixed(0)} → ${(len(ball.v) * 3.6).toFixed(0)} km/h`, hit.point);
        }
      }
      if (ball.held) {
        if (step % SIM.RECORD_EVERY === 0) record();
        continue;
      }
    }

    if (ball.p.z - BALL.R < GOAL.BOARDS_Z && ball.p.z > GOAL.BOARDS_Z - 0.3 && ball.v.z < 0 &&
        ball.p.y - BALL.R < GOAL.BOARDS_H && Math.abs(ball.p.x) < GOAL.BOARDS_HW) {
      ball.p = v(ball.p.x, ball.p.y, GOAL.BOARDS_Z + BALL.R);
      ball.v = v(ball.v.x * 0.7, ball.v.y * 0.7, -0.3 * ball.v.z);
      log(t, 'boards', 'Thumped into the advertising boards', ball.p);
    }

    if (ball.grounded && (ball.v.y > 0.3 || ball.p.y > BALL.R + 0.005)) ball.grounded = false;

    const { x, y, z } = ball.p;
    if (!lineCross && z <= GOAL.Z) lineCross = { t: r3(t), x: r3(x), y: r3(y) };
    if (!ball.inGoal && z < GOAL.Z - GOAL.POST_R && z > GOAL.Z - GOAL.POST_R - 0.5 &&
        Math.abs(x) < NET.SIDE_X && y < NET.ROOF_Y) {
      ball.inGoal = true;
    }

    // Laws of the Game: a goal needs the whole ball over the whole line.
    if (!crossing && z < GOAL.Z - GOAL.POST_R - BALL.R) {
      crossing = { t: r3(t), x: r3(x), y: r3(y), inside: ball.inGoal };
      if (ball.inGoal) {
        log(t, 'goal', 'Whole ball over the line', ball.p);
        let detail = `${placement(x, y)[0].toUpperCase()}${placement(x, y).slice(1)}.`;
        if (touch && woodwork) detail = `Off the keeper's ${touch.part} and the ${woodwork.part}, and in.`;
        else if (touch) detail = `The keeper got a ${touch.part} to it but couldn't keep it out.`;
        else if (woodwork) detail = `In off the ${woodwork.part}!`;
        decide('goal', 'GOAL!', detail);
      } else {
        const sideMargin = Math.abs(x) - BALL.R - (GOAL.HW + 2 * GOAL.POST_R);
        const overMargin = y - BALL.R - (GOAL.H + 2 * GOAL.POST_R);
        const over = Math.abs(x) <= NET.SIDE_X || (y > NET.ROOF_Y && overMargin > sideMargin);
        const how = over
          ? `over the bar by ${Math.max(0, overMargin * 100).toFixed(0)} cm`
          : `wide of the ${x < 0 ? 'left' : 'right'} post by ${Math.max(0, sideMargin * 100).toFixed(0)} cm`;
        if (touch) decide('save', 'SAVED!', `Tipped ${over ? 'over' : 'round the post'} by the keeper's ${touch.part}.`);
        else if (woodwork) decide('post', 'WOODWORK!', `Off the ${woodwork.part} and ${how}.`);
        else decide('miss', 'MISSED', `${how[0].toUpperCase()}${how.slice(1)}.`);
      }
    }

    if (!verdict) {
      // Touched and moving away from goal 0.8 m out: it is not coming back
      // (of 200,000 fuzzed kicks, 9 such balls still went in).
      if ((touch || woodwork) && ball.v.z > 0 && z > GOAL.Z + 0.8) notCrossed('Parried');
      else if (ball.grounded && len(ball.v) < 0.15) notCrossed('Smothered');
      // Outside a post and moving away from it: it is not coming back (of
      // 26,000 fuzzed kicks where this held before the verdict, none went in).
      else if (Math.abs(x) > NET.SIDE_X + BALL.R && x * ball.v.x >= 0) {
        const post = `${x < 0 ? 'left' : 'right'} post`;
        if (touch) decide('save', 'SAVED!', `Pushed round the ${post} by the keeper's ${touch.part}.`);
        else if (woodwork) decide('post', 'WOODWORK!', `Off the ${woodwork.part} and wide of the ${post}.`);
        else decide('miss', 'MISSED', `Wide of the ${post}.`);
      }
      else if ((touch || woodwork) && keeper && pounces(keeper, ball)) {
        decide('save', 'SAVED!', 'The keeper pounces on the loose ball.');
        // It is smothered where it lies (the replay plays on from here).
        ball.v = v(0, 0, 0);
        ball.w = v(0, 0, 0);
        pounced = true;
      }
      else if (t >= SIM.MAX_T) notCrossed('Kept out');
    }

    recordPass(first, p0);
  }
  if (trace) trace(step, ball, keeper, verdict);
  if (frames[frames.length - 1].t !== t) record();

  const last = frames[frames.length - 1];
  const hash = hashNumbers([
    ...last.b, ...last.q, ball.v.x, ball.v.y, ball.v.z, step,
    ...events.map((e) => e.t),
  ]);

  return {
    input, plan: withKeeper ? plan : null, launch, frames, events,
    result: {
      ...verdict, touch, woodwork, lineCross, crossing,
      // How the keeper dealt with it: 'caught', 'parried' (touched, not held) or null.
      keeperContact: caught ? 'caught' : touch ? 'parried' : null,
      caught,
      contacts,
      keeper: keeper ? {
        mode: planMode(plan),
        commits: keeper.commits.map((c) => ({ ...c, t0: r3(c.t0) })),
        misread: keeper.misread && { ...keeper.misread },
      } : null,
    },
    steps: step,
    hash,
  };
}
