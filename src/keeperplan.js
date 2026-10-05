// Turns "dive to this spot" into a keeper plan the round bytes can express.
//
// The player picks a point on the goal plane; we search a table of plans
// (dive speeds x jumps, plus slow star jumps) for the one that covers it
// best while the ball is likely to arrive. The table is built from P.previewKeeper, the real
// keeper physics with no ball in play, for dives to the taker's right only:
// the keeper is symmetric, so a target on the left mirrors it. Every plan
// returned has been through P.encodePlan and P.decodePlan, so it is exactly
// what four uint16s decode to. Nothing here affects a simulation beyond
// choosing the plan.
import * as P from './physics.js?v=20';

const { PLAN } = P;
// Heading of every dive, degrees off the goal line towards the taker.
export const DIVE_FORWARD = 8;
// When the ball is likely to arrive, in seconds after contact: a well struck
// kick takes ~0.4 s, a soft one ~0.7 s.
export const WINDOW = [0.3, 0.75];
const EVERY = 20;       // physics steps per sample (50 Hz)
const DIVE_STEPS = 24;
const STAR_STEPS = 8;
const JUMP_STEPS = 24;

let table = null;
let building = null;

function entries() {
  const out = [];
  for (let j = 0; j < JUMP_STEPS; j++) {
    const jump = PLAN.JUMP_MIN + ((PLAN.JUMP_MAX - PLAN.JUMP_MIN) * j) / (JUMP_STEPS - 1);
    for (let s = 0; s < DIVE_STEPS; s++) {
      const speed = PLAN.DIVE_MIN_SPEED + ((PLAN.DIVE_MAX_SPEED - PLAN.DIVE_MIN_SPEED) * s) / (DIVE_STEPS - 1);
      out.push({ mode: 'dive', direction: DIVE_FORWARD, speed, jump });
    }
    for (let s = 0; s < STAR_STEPS; s++) {
      out.push({ mode: 'star', direction: 0, speed: (PLAN.STAR_MAX_SPEED * 0.98 * s) / (STAR_STEPS - 1), jump });
    }
  }
  return out;
}

// Every collision shape in the x-y plane (ax, ay, bx, by, hit radius) per
// sample, after a time stamp relative to the commit.
const PARTS = P.keeperCapsules(P.keeperPose(P.keeperInitialState())).length;
const STRIDE = 1 + PARTS * 5;
function shapes(plan) {
  const poses = P.previewKeeper(plan, WINDOW[1], EVERY);
  const out = [];
  for (const pose of poses) {
    if (pose.t < plan.reaction) continue;
    out.push(pose.t - plan.reaction);
    for (const c of P.keeperCapsules(pose)) out.push(c.a.x, c.a.y, c.b.x, c.b.y, c.hit + P.BALL.R);
  }
  return Float32Array.from(out);
}

function row(e) {
  const raw = P.encodePlan({ ...e, reaction: PLAN.REACTION_MIN });
  return { raw, path: shapes(P.planFromRaw(raw)) };
}

// Builds the table a slice at a time so the page stays responsive.
export function buildReachTable() {
  if (table) return Promise.resolve(table);
  if (building) return building;
  const todo = entries();
  const rows = [];
  building = new Promise((resolve) => {
    const step = () => {
      const until = performance.now() + 12;
      while (rows.length < todo.length && performance.now() < until) rows.push(row(todo[rows.length]));
      if (rows.length < todo.length) setTimeout(step, 0);
      else resolve((table = rows));
    };
    step();
  });
  return building;
}

function reachTableNow() {
  if (!table) table = entries().map(row);
  return table;
}

function segGap(px, py, p, i) {
  const ax = p[i], ay = p[i + 1];
  const ex = p[i + 2] - ax, ey = p[i + 3] - ay;
  const L = ex * ex + ey * ey;
  let u = L > 0 ? ((px - ax) * ex + (py - ay) * ey) / L : 0;
  u = u < 0 ? 0 : u > 1 ? 1 : u;
  return Math.hypot(px - ax - ex * u, py - ay - ey * u) - p[i + 4];
}

// The plan that best covers the target while the ball is likely to arrive:
// the smallest gap between a ball there and any part of the keeper, and among
// plans that touch it, the one that covers it longest.
export function solvePlan(target, reaction) {
  const rows = reachTableNow();
  const flip = target.x < 0;
  const tx = flip ? -target.x : target.x;
  const ty = target.y;
  const lo = WINDOW[0] - reaction;
  const hi = WINDOW[1] - reaction;
  let best = null;
  for (const r of rows) {
    const p = r.path;
    let gap = Infinity;
    let cover = 0;
    let first = 0;
    let last = 0;
    let closest = 0;
    for (let i = 0; i < p.length; i += STRIDE) {
      const t = p[i];
      if (t < lo || t > hi) continue;
      let g = Infinity;
      for (let j = i + 1; j < i + STRIDE; j += 5) g = Math.min(g, segGap(tx, ty, p, j));
      if (g <= 0) {
        if (!cover) first = t;
        last = t;
        cover++;
      }
      if (g < gap) (gap = g), (closest = t);
    }
    gap = Math.max(0, gap);
    const at = (cover ? (first + last) / 2 : closest) + reaction;
    if (!best || gap < best.gap - 1e-6 || (gap < best.gap + 1e-6 && cover > best.cover)) best = { r, gap, cover, at };
  }
  const raw = [...best.r.raw];
  if (flip) raw[0] = 65535 - raw[0];
  raw[3] = P.encodePlan({ direction: 90, speed: 0, mode: 'dive', reaction })[3];
  // at: seconds after contact when it covers the spot best (for previews).
  return { raw, plan: P.planFromRaw(raw), miss: best.gap, cover: best.cover * EVERY * P.SIM.DT, at: best.at };
}

// A wait-and-read plan with the given reaction.
export function readPlan(reaction) {
  const raw = P.encodePlan({ mode: 'read', direction: 90, speed: 0, jump: 0, reaction });
  return { raw, plan: P.planFromRaw(raw), miss: 0, cover: 0, at: 0 };
}
