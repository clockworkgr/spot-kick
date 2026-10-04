// Monte Carlo fuzzing of the penalty simulator.
//
//   node tools/fuzz.mjs [--shots 1000000] [--workers N] [--seed S] [--out file.json]
//
// Shot i uses round bytes roundBytesFromSeed(S, i) (keeper plan + mishit seed)
// and taker inputs drawn from a PRNG seeded by (S, i), so any single shot can be
// reproduced from the master seed and its index. Taker inputs:
//   aim     x ~ U[-HW-0.9, HW+0.9], y ~ U[0, H+0.7]   (goal mouth and a margin)
//   contact uniform over the selectable disc (radius KICK.MAX_CONTACT)
//   power   ~ U[0, 1]
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { writeFileSync } from 'node:fs';
import * as P from '../src/physics.js';

const F = {
  AX: 0, AY: 1, CX: 2, CY: 3, POWER: 4, DIR: 5, SPEED: 6, JUMP: 7, REACT: 8,
  OUTCOME: 9, KIND: 10, PART: 11, WOOD: 12, LX: 13, LY: 14, VLAUNCH: 15, DECIDED: 16, FUZZ: 17,
  MODE: 18, COMMITS: 19,
};
const NF = 20;
const MODES = ['star', 'read', 'dive'];
const OUTCOMES = ['goal', 'save', 'miss', 'post'];
const KINDS = [
  'goal: clean', 'goal: off keeper', 'goal: off woodwork', 'goal: keeper + woodwork',
  'miss: wide', 'miss: over', 'miss: never reached goal',
  'save: kept out', 'save: tipped wide/over',
  'post: off woodwork and out', 'post: rebounded out',
];
const PARTS = ['left glove', 'right glove', 'left arm', 'right arm', 'body', 'head', 'left leg', 'right leg'];
const WOOD = ['left post', 'right post', 'crossbar'];

function shotInput(seed, i) {
  const rnd = P.mulberry32((Math.imul(seed ^ 0x5bd1e995, 31) + Math.imul(i, 0x27d4eb2d)) >>> 0);
  const HW = P.GOAL.HW;
  const H = P.GOAL.H;
  const ang = rnd() * 2 * Math.PI;
  const rad = P.KICK.MAX_CONTACT * Math.sqrt(rnd());
  return {
    aim: { x: -HW - 0.9 + rnd() * (2 * HW + 1.8), y: rnd() * (H + 0.7) },
    contact: { x: rad * Math.cos(ang), y: rad * Math.sin(ang) },
    power: rnd(),
  };
}

function kindOf(r) {
  if (r.outcome === 'goal') return (r.touch ? 1 : 0) + (r.woodwork ? 2 : 0);
  if (r.outcome === 'miss') return /^Wide/.test(r.detail) ? 4 : /^Over/.test(r.detail) ? 5 : 6;
  if (r.outcome === 'save') return r.crossing && !r.crossing.inside ? 8 : 7;
  return r.crossing && !r.crossing.inside ? 9 : 10;
}

// ------------------------------------------------------------------ worker

if (!isMainThread) {
  const { seed, from, to, verifyEvery } = workerData;
  const n = to - from;
  const out = new Float32Array(n * NF);
  let verified = 0;
  let mismatches = 0;
  let undecided = 0;
  let nonFinite = 0;
  for (let k = 0; k < n; k++) {
    const i = from + k;
    const { plan, strikeSeed } = P.decodeRound(P.roundBytesFromSeed(seed, i));
    const input = { ...shotInput(seed, i), seed: strikeSeed };
    const sim = P.simulateShot(input, plan);
    const r = sim.result;
    if (!r.outcome) undecided++;
    const last = sim.frames[sim.frames.length - 1].b;
    if (!last.every(Number.isFinite)) nonFinite++;
    if (i % verifyEvery === 0) {
      verified++;
      if (P.simulateShot(structuredClone(input), structuredClone(plan)).hash !== sim.hash) mismatches++;
    }
    const L = sim.launch;
    const at = r.lineCross || r.crossing;
    const o = k * NF;
    out[o + F.AX] = input.aim.x;
    out[o + F.AY] = input.aim.y;
    out[o + F.CX] = L.contact.x;
    out[o + F.CY] = L.contact.y;
    out[o + F.POWER] = input.power;
    out[o + F.DIR] = plan.direction;
    out[o + F.SPEED] = plan.speed;
    out[o + F.JUMP] = plan.jump;
    out[o + F.REACT] = plan.reaction;
    out[o + F.OUTCOME] = OUTCOMES.indexOf(r.outcome);
    out[o + F.KIND] = kindOf(r);
    out[o + F.PART] = r.touch ? PARTS.indexOf(r.touch.part) : -1;
    out[o + F.WOOD] = r.woodwork ? WOOD.indexOf(r.woodwork.part) : -1;
    out[o + F.LX] = at ? at.x : NaN;
    out[o + F.LY] = at ? at.y : NaN;
    out[o + F.VLAUNCH] = L.speed;
    out[o + F.DECIDED] = r.decidedAt;
    out[o + F.FUZZ] = Math.hypot(L.fuzz.x, L.fuzz.y);
    out[o + F.MODE] = MODES.indexOf(P.planMode(plan));
    out[o + F.COMMITS] = r.keeper.commits.length;
    if (k % 5000 === 4999) parentPort.postMessage({ progress: 5000 });
  }
  parentPort.postMessage({ done: true, out, from, verified, mismatches, undecided, nonFinite }, [out.buffer]);
}

// -------------------------------------------------------------------- main

if (isMainThread) {
  const arg = (name, def) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : def;
  };
  const shots = Number(arg('shots', 1_000_000));
  const workers = Number(arg('workers', availableParallelism()));
  const seed = Number(arg('seed', (Math.random() * 2 ** 32) >>> 0)) >>> 0;
  const outFile = arg('out', null);
  const verifyEvery = 500;

  console.error(`fuzzing ${shots.toLocaleString()} shots on ${workers} workers, master seed ${seed}`);
  const t0 = performance.now();
  const data = new Float32Array(shots * NF);
  const stats = { verified: 0, mismatches: 0, undecided: 0, nonFinite: 0 };
  let done = 0;
  let lastPrint = 0;
  const chunk = Math.ceil(shots / workers);
  await Promise.all(Array.from({ length: workers }, (_, w) => new Promise((resolve, reject) => {
    const from = w * chunk;
    const to = Math.min(shots, from + chunk);
    if (from >= to) return resolve();
    const wk = new Worker(new URL(import.meta.url), { workerData: { seed, from, to, verifyEvery } });
    wk.on('message', (m) => {
      if (m.progress) {
        done += m.progress;
        const now = performance.now();
        if (now - lastPrint > 5000) {
          lastPrint = now;
          const rate = done / ((now - t0) / 1000);
          console.error(`  ${done.toLocaleString()} / ${shots.toLocaleString()}  (${Math.round(rate)} shots/s, ~${Math.round((shots - done) / rate)} s left)`);
        }
      } else if (m.done) {
        data.set(m.out, m.from * NF);
        for (const k of Object.keys(stats)) stats[k] += m[k];
        resolve();
      }
    });
    wk.on('error', reject);
  })));
  const secs = (performance.now() - t0) / 1000;

  // ------------------------------------------------------------- analysis
  const N = shots;
  const get = (i, f) => data[i * NF + f];
  const HW = P.GOAL.HW;
  const H = P.GOAL.H;

  const tally = (pred) => {
    const c = [0, 0, 0, 0];
    let n = 0;
    for (let i = 0; i < N; i++) {
      if (!pred(i)) continue;
      c[get(i, F.OUTCOME)]++;
      n++;
    }
    return { n, c };
  };
  const pct = (x, n) => (n ? ((100 * x) / n).toFixed(1).padStart(5) + '%' : '    –');
  const ci = (x, n) => (n ? '±' + (196 * Math.sqrt((x / n) * (1 - x / n) / n)).toFixed(2) : '');
  const row = (label, { n, c }) =>
    `| ${label} | ${n.toLocaleString()} | ${pct(c[0], n)} | ${pct(c[1], n)} | ${pct(c[2], n)} | ${pct(c[3], n)} |`;
  const table = (title, rows) => [
    `\n### ${title}\n`,
    '| | shots | goal | save | miss | woodwork |',
    '|---|---:|---:|---:|---:|---:|',
    ...rows.map(([l, t]) => row(l, t)),
  ].join('\n');

  const inFrame = (i) => Math.abs(get(i, F.AX)) < HW && get(i, F.AY) < H;
  const onTarget = (i) => inFrame(i) && get(i, F.POWER) >= 0.4;
  const all = tally(() => true);
  const lines = [];
  lines.push(`# Fuzz report: ${N.toLocaleString()} shots`);
  lines.push(`\nMaster seed ${seed} · ${workers} workers · ${secs.toFixed(0)} s (${Math.round(N / secs).toLocaleString()} shots/s)`);
  lines.push(`Goal ${(2 * HW).toFixed(2)} × ${H.toFixed(3)} m · keeper scale ${P.KEEPER.SCALE} · reaction ${P.PLAN.REACTION_MIN}–${P.PLAN.REACTION_MAX} s`);
  lines.push(`\n**Integrity:** ${stats.verified.toLocaleString()} re-simulated, ${stats.mismatches} hash mismatches · ` +
    `${stats.undecided} without a verdict · ${stats.nonFinite} non-finite states`);

  lines.push(table('Overall', [
    ['all fuzzed shots', all],
    ['aimed inside the frame', tally(inFrame)],
    ['aimed inside the frame, power ≥ 40%', tally(onTarget)],
    ['… and contact within 0.2 R', tally((i) => onTarget(i) && Math.hypot(get(i, F.CX), get(i, F.CY)) < 0.2)],
  ]));
  lines.push(`\n95% CI half-widths on the full run: goal ${ci(all.c[0], N)} pts, save ${ci(all.c[1], N)} pts.`);

  const kinds = new Array(KINDS.length).fill(0);
  for (let i = 0; i < N; i++) kinds[get(i, F.KIND)]++;
  lines.push('\n### Outcome detail (all shots)\n\n| | shots | share |\n|---|---:|---:|');
  KINDS.forEach((k, j) => lines.push(`| ${k} | ${kinds[j].toLocaleString()} | ${pct(kinds[j], N)} |`));

  // Aim zones (thirds of the goal mouth), on-target power.
  const col = (x) => (x < -HW / 3 ? 'left' : x > HW / 3 ? 'right' : 'centre');
  const lvl = (y) => (y < H / 3 ? 'low' : y > (2 * H) / 3 ? 'high' : 'mid');
  const zones = [];
  for (const v of ['high', 'mid', 'low']) {
    for (const h of ['left', 'centre', 'right']) {
      zones.push([`${v} ${h}`, tally((i) => onTarget(i) && col(get(i, F.AX)) === h && lvl(get(i, F.AY)) === v)]);
    }
  }
  lines.push(table('By aim zone (aimed inside the frame, power ≥ 40%)', zones));

  const bands = (f, edges, label, pred = () => true) => edges.slice(0, -1).map((lo, k) => {
    const hi = edges[k + 1];
    return [label(lo, hi), tally((i) => pred(i) && get(i, f) >= lo && (get(i, f) < hi || (k === edges.length - 2 && get(i, f) <= hi)))];
  });
  lines.push(table('By power (all aims)', bands(F.POWER, [0, 0.2, 0.4, 0.6, 0.8, 1], (a, b) => `${a * 100}–${b * 100}%`)));
  lines.push(table('By power (aimed inside the frame)', bands(F.POWER, [0, 0.2, 0.4, 0.6, 0.8, 1], (a, b) => `${a * 100}–${b * 100}%`, inFrame)));

  const offset = (i) => Math.hypot(get(i, F.CX), get(i, F.CY));
  lines.push(table('By actual contact offset (aimed inside the frame, power ≥ 40%)', [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.8].slice(0, -1).map((lo, k, arr) => {
    const hi = [0.1, 0.2, 0.3, 0.4, 0.5, 0.8][k];
    return [`${lo.toFixed(1)}–${hi.toFixed(1)} R`, tally((i) => onTarget(i) && offset(i) >= lo && offset(i) < hi)];
  })));

  // Keeper guess vs where the ball actually went.
  const side = (i) => {
    const d = get(i, F.DIR);
    const mode = MODES[get(i, F.MODE)];
    if (mode !== 'dive') return mode;
    const lateral = Math.cos((d * Math.PI) / 180);
    if (Math.abs(lateral) < 0.3) return 'rush';
    return lateral > 0 ? 'right' : 'left';
  };
  const shotSide = (i) => {
    const x = get(i, F.LX);
    const xs = Number.isFinite(x) ? x : get(i, F.AX);
    return xs > 0.6 ? 'right' : xs < -0.6 ? 'left' : 'centre';
  };
  lines.push(table('Keeper guess vs shot direction (aimed inside the frame, power ≥ 40%)', [
    ['dived the right way', tally((i) => onTarget(i) && ['left', 'right'].includes(side(i)) && side(i) === shotSide(i))],
    ['dived the wrong way', tally((i) => onTarget(i) && ['left', 'right'].includes(side(i)) && shotSide(i) !== 'centre' && side(i) !== shotSide(i))],
    ['dived, shot down the middle', tally((i) => onTarget(i) && ['left', 'right'].includes(side(i)) && shotSide(i) === 'centre')],
    ['waited and read the shot', tally((i) => onTarget(i) && side(i) === 'read')],
    ['star jump', tally((i) => onTarget(i) && side(i) === 'star')],
    ['rushed out', tally((i) => onTarget(i) && side(i) === 'rush')],
  ]));
  lines.push(table('By keeper reaction time (aimed inside the frame, power ≥ 40%)',
    bands(F.REACT, [0.02, 0.04, 0.06, 0.08, 0.1, 0.12], (a, b) => `${a.toFixed(2)}–${b.toFixed(2)} s`, onTarget)));
  lines.push(table('By keeper mode (aimed inside the frame, power ≥ 40%)', MODES.map((m, j) =>
    [m === 'read' ? 'wait and read' : m === 'star' ? 'star jump' : 'committed dive', tally((i) => onTarget(i) && get(i, F.MODE) === j)])));
  lines.push(table('Keeper went again after recovering (aimed inside the frame, power ≥ 40%)', [
    ['one move', tally((i) => onTarget(i) && get(i, F.COMMITS) <= 1)],
    ['recovered and dived again', tally((i) => onTarget(i) && get(i, F.COMMITS) >= 2)],
  ]));
  lines.push(table('By keeper dive speed (dives only, aimed inside the frame, power ≥ 40%)',
    bands(F.SPEED, [P.PLAN.DIVE_MIN_SPEED, 3.25, 3.9, 4.55, P.PLAN.DIVE_MAX_SPEED], (a, b) => `${a}–${b} m/s`, onTarget)));
  lines.push(table('By planned keeper jump (star and dive plans; aimed inside the frame, power ≥ 40%)',
    bands(F.JUMP, [-1.4, -0.4, 0.6, 1.6, 2.6, 4.0], (a, b) => `${a} – ${b} m/s`, (i) => onTarget(i) && get(i, F.MODE) !== 1)));

  const parts = new Array(PARTS.length).fill(0);
  let saves = 0;
  for (let i = 0; i < N; i++) {
    if (get(i, F.OUTCOME) !== 1) continue;
    saves++;
    const p = get(i, F.PART);
    if (p >= 0) parts[p]++;
  }
  lines.push('\n### Saves by first keeper part touched\n\n| part | saves | share |\n|---|---:|---:|');
  PARTS.forEach((p, j) => lines.push(`| ${p} | ${parts[j].toLocaleString()} | ${pct(parts[j], saves)} |`));

  const wood = [0, 0, 0];
  for (let i = 0; i < N; i++) if (get(i, F.WOOD) >= 0) wood[get(i, F.WOOD)]++;
  lines.push(`\n**Woodwork struck** (any outcome): left post ${wood[0].toLocaleString()}, right post ${wood[1].toLocaleString()}, crossbar ${wood[2].toLocaleString()}.`);

  let vs = 0;
  let dt = 0;
  let fz = 0;
  for (let i = 0; i < N; i++) {
    vs += get(i, F.VLAUNCH);
    dt += get(i, F.DECIDED);
    fz += get(i, F.FUZZ);
  }
  lines.push(`\nMean launch speed ${((vs / N) * 3.6).toFixed(1)} km/h · mean time to verdict ${(dt / N).toFixed(3)} s · mean mishit ${(fz / N).toFixed(3)} R`);

  const report = lines.join('\n');
  console.log(report);
  if (outFile) {
    writeFileSync(outFile, JSON.stringify({ seed, shots: N, workers, seconds: secs, stats, overall: all, kinds, report }, null, 2));
    console.error(`wrote ${outFile}`);
  }
}
