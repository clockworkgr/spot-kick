// Closest-approach analysis: for every shot, how close each keeper limb's
// body surface (not the collision margin) came to the ball before the ball
// crossed the line, and when. Writes one JSON line per shot for
// tools/reach-verdict.mjs to judge against a realistic-keeper model.
//
//   node tools/reach-analysis.mjs --shots 300000 --seed 11 --out rows.jsonl
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { createWriteStream } from 'node:fs';
import * as P from '../src/physics.js';

const KINDS = ['glove', 'arm', 'torso', 'leg', 'head'];
const SUB = 6; // samples per recorded frame interval near the keeper

function shotInput(seed, i) {
  const rnd = P.mulberry32((Math.imul(seed ^ 0x51ed27, 31) + Math.imul(i, 0x85ebca6b)) >>> 0);
  const HW = P.GOAL.HW;
  const H = P.GOAL.H;
  const ang = rnd() * 2 * Math.PI;
  const rad = P.KICK.MAX_CONTACT * Math.sqrt(rnd());
  return {
    aim: { x: -HW - 0.3 + rnd() * (2 * HW + 0.6), y: rnd() * (H + 0.6) },
    contact: { x: rad * Math.cos(ang), y: rad * Math.sin(ang) },
    power: rnd(),
  };
}

const lerp = (a, b, u) => a + (b - a) * u;
function lerpPose(a, b, u) {
  const n2 = (x, y) => {
    const s = lerp(x.s, y.s, u);
    const c = lerp(x.c, y.c, u);
    const l = Math.hypot(s, c);
    return { s: s / l, c: c / l };
  };
  const n3 = (x, y) => {
    const v = { x: lerp(x.x, y.x, u), y: lerp(x.y, y.y, u), z: lerp(x.z, y.z, u) };
    const l = Math.hypot(v.x, v.y, v.z);
    return { x: v.x / l, y: v.y / l, z: v.z / l };
  };
  return {
    pos: { x: lerp(a.pos.x, b.pos.x, u), y: lerp(a.pos.y, b.pos.y, u), z: lerp(a.pos.z, b.pos.z, u) },
    lean: n2(a.lean, b.lean),
    arms: { l: n3(a.arms.l, b.arms.l), r: n3(a.arms.r, b.arms.r) },
    plant: a.plant && b.plant ? a.plant : null,
  };
}

function segGap(p, c) {
  const ab = { x: c.b.x - c.a.x, y: c.b.y - c.a.y, z: c.b.z - c.a.z };
  const L = ab.x * ab.x + ab.y * ab.y + ab.z * ab.z;
  let u = L ? ((p.x - c.a.x) * ab.x + (p.y - c.a.y) * ab.y + (p.z - c.a.z) * ab.z) / L : 0;
  u = Math.max(0, Math.min(1, u));
  return Math.hypot(p.x - c.a.x - ab.x * u, p.y - c.a.y - ab.y * u, p.z - c.a.z - ab.z * u) - c.r - P.BALL.R;
}

// Closest approach per limb kind until the ball crosses the line, is held,
// or is first touched (a touch is gap <= collision margin, so we stop there).
function approach(sim) {
  const fr = sim.frames;
  const lineZ = P.GOAL.Z - P.GOAL.POST_R - P.BALL.R;
  const firstTouch = sim.result.contacts.length ? sim.result.contacts[0].t : Infinity;
  const best = {};
  for (const k of KINDS) best[k] = { gap: Infinity, t: 0, speed: 0, y: 0, x: 0 };
  for (let i = 1; i < fr.length; i++) {
    const a = fr[i - 1];
    const b = fr[i];
    if (!a.k || a.held || a.t > firstTouch + 1e-9) break;
    if (a.b[2] < lineZ) break;
    const speed = Math.hypot(b.b[0] - a.b[0], b.b[1] - a.b[1], b.b[2] - a.b[2]) / (b.t - a.t);
    const nearKeeper = Math.abs(a.b[2] - a.k.pos.z) < 2.5;
    const n = nearKeeper ? SUB : 1;
    for (let j = 0; j < n; j++) {
      const u = j / n;
      const p = { x: lerp(a.b[0], b.b[0], u), y: lerp(a.b[1], b.b[1], u), z: lerp(a.b[2], b.b[2], u) };
      if (p.z < lineZ) break;
      const caps = P.keeperCapsules(lerpPose(a.k, b.k, u));
      for (const c of caps) {
        const g = segGap(p, c);
        const bk = best[c.kind];
        if (g < bk.gap) Object.assign(bk, { gap: g, t: lerp(a.t, b.t, u), speed, y: p.y, x: p.x });
      }
    }
  }
  return best;
}

function analyse(seed, i) {
  const { plan, strikeSeed } = P.decodeRound(P.roundBytesFromSeed(seed, i));
  const input = { ...shotInput(seed, i), seed: strikeSeed };
  const empty = P.simulateShot(input, null);
  const sim = P.simulateShot(input, plan);
  const r = sim.result;
  const ref = empty.result.lineCross;
  const mode = P.planMode(plan);
  const commits = r.keeper.commits;
  const near = approach(sim);
  const r3 = (x) => Math.round(x * 1000) / 1000;
  const g = {};
  for (const k of KINDS) {
    const b = near[k];
    g[k] = Number.isFinite(b.gap) ? [r3(b.gap), r3(b.t), r3(b.speed), r3(b.y), r3(b.x)] : null;
  }
  return {
    i,
    power: r3(input.power),
    curl: r3(input.contact.x),
    lift: r3(input.contact.y),
    on: empty.result.outcome === 'goal',
    refX: ref ? r3(ref.x) : null,
    refY: ref ? r3(ref.y) : null,
    refT: ref ? r3(ref.t) : null,
    mode,
    lat: mode === 'dive' ? r3(P.keeperLaunchVelocity(plan).x) : 0,
    jump: r3(plan.jump),
    reaction: r3(plan.reaction),
    commit0: commits.length ? r3(commits[0].t0) : null,
    outcome: r.outcome,
    kc: r.keeperContact,
    how: r.caught ? r.caught.how : null,
    touch: r.contacts.length ? { kind: r.contacts[0].kind, t: r.contacts[0].t, rel: r3(r.contacts[0].relSpeed), dec: r.contacts[0].decision } : null,
    g,
  };
}

if (!isMainThread) {
  const { seed, from, to } = workerData;
  let buf = [];
  for (let i = from; i < to; i++) {
    buf.push(JSON.stringify(analyse(seed, i)));
    if (buf.length === 500) {
      parentPort.postMessage({ lines: buf });
      buf = [];
    }
  }
  parentPort.postMessage({ lines: buf, done: true });
}

if (isMainThread) {
  const arg = (n, d) => {
    const i = process.argv.indexOf(`--${n}`);
    return i > 0 ? process.argv[i + 1] : d;
  };
  const N = Number(arg('shots', 300000));
  const seed = Number(arg('seed', 11)) >>> 0;
  const W = Number(arg('workers', availableParallelism()));
  const out = createWriteStream(arg('out', 'reach-rows.jsonl'));
  const t0 = performance.now();
  let done = 0;
  const chunk = Math.ceil(N / W);
  await Promise.all(Array.from({ length: W }, (_, w) => new Promise((resolve, reject) => {
    const from = w * chunk;
    const to = Math.min(N, from + chunk);
    if (from >= to) return resolve();
    const wk = new Worker(new URL(import.meta.url), { workerData: { seed, from, to } });
    wk.on('message', (m) => {
      for (const l of m.lines) out.write(l + '\n');
      done += m.lines.length;
      if (m.done) resolve();
    });
    wk.on('error', reject);
  })));
  await new Promise((r) => out.end(r));
  console.error(`${done} shots in ${((performance.now() - t0) / 1000).toFixed(0)} s`);
}
