// Keeper behaviour analysis: how shots of each type fare against each kind of
// keeper plan, and how every keeper touch is decided (catch or parry).
//
//   node tools/save-analysis.mjs [--shots 120000] [--seed 7] [--workers N] [--json out.json]
//
// Every shot is also simulated against an empty goal, which gives where and how
// fast it would have arrived; shots are grouped by that, not by the aim.
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { writeFileSync } from 'node:fs';
import * as P from '../src/physics.js';

function shotInput(seed, i) {
  const rnd = P.mulberry32((Math.imul(seed ^ 0x2545f491, 31) + Math.imul(i, 0x9e3779b1)) >>> 0);
  const HW = P.GOAL.HW;
  const H = P.GOAL.H;
  const ang = rnd() * 2 * Math.PI;
  const rad = P.KICK.MAX_CONTACT * Math.sqrt(rnd());
  return {
    aim: { x: -HW - 0.5 + rnd() * (2 * HW + 1), y: rnd() * (H + 0.6) },
    contact: { x: rad * Math.cos(ang), y: rad * Math.sin(ang) },
    power: rnd(),
  };
}

// Closest the ball came to the keeper's collision surface, and how it was
// moving there (from the recorded frames).
function closest(sim) {
  let best = { d: Infinity, speed: 0, y: 0, t: 0 };
  const fr = sim.frames;
  for (let i = 1; i < fr.length; i++) {
    const f = fr[i];
    if (!f.k || f.held) continue;
    const b = { x: f.b[0], y: f.b[1], z: f.b[2] };
    let d = Infinity;
    for (const c of P.keeperCapsules(f.k)) {
      const ab = { x: c.b.x - c.a.x, y: c.b.y - c.a.y, z: c.b.z - c.a.z };
      const L = ab.x * ab.x + ab.y * ab.y + ab.z * ab.z;
      let u = L ? ((b.x - c.a.x) * ab.x + (b.y - c.a.y) * ab.y + (b.z - c.a.z) * ab.z) / L : 0;
      u = Math.max(0, Math.min(1, u));
      const dx = b.x - c.a.x - ab.x * u;
      const dy = b.y - c.a.y - ab.y * u;
      const dz = b.z - c.a.z - ab.z * u;
      d = Math.min(d, Math.hypot(dx, dy, dz) - c.hit - P.BALL.R);
    }
    if (d < best.d) {
      const p = fr[i - 1].b;
      const dt = f.t - fr[i - 1].t;
      best = { d, speed: Math.hypot(f.b[0] - p[0], f.b[1] - p[1], f.b[2] - p[2]) / dt, y: f.b[1], t: f.t };
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
  const refFrame = ref ? empty.frames.find((f) => f.t >= ref.t) : null;
  const refPrev = refFrame ? empty.frames[empty.frames.indexOf(refFrame) - 1] : null;
  const refSpeed = refFrame && refPrev
    ? Math.hypot(refFrame.b[0] - refPrev.b[0], refFrame.b[1] - refPrev.b[1], refFrame.b[2] - refPrev.b[2]) / (refFrame.t - refPrev.t)
    : 0;
  const mode = P.planMode(plan);
  let lateral = 0;
  if (mode === 'dive') lateral = P.keeperLaunchVelocity(plan).x;
  return {
    i,
    power: input.power,
    curl: Math.abs(input.contact.x),
    onTarget: empty.result.outcome === 'goal',
    refX: ref ? ref.x : null,
    refY: ref ? ref.y : null,
    refSpeed,
    mode,
    lateral,
    jump: plan.jump,
    outcome: r.outcome,
    detail: r.detail,
    contact: r.keeperContact,
    caught: r.caught ? { how: r.caught.how, relSpeed: r.caught.relSpeed, quality: r.caught.quality } : null,
    touches: r.contacts.map((c) => ({ kind: c.kind, decision: c.decision, relSpeed: c.relSpeed, quality: c.quality, phase: c.phase, y: c.point.y })),
    commits: r.keeper.commits.length,
    near: closest(sim),
  };
}

if (!isMainThread) {
  const { seed, from, to } = workerData;
  const out = [];
  for (let i = from; i < to; i++) {
    out.push(analyse(seed, i));
    if ((i - from) % 2000 === 1999) parentPort.postMessage({ progress: 2000 });
  }
  parentPort.postMessage({ done: true, out });
}

if (isMainThread) {
  const arg = (n, d) => {
    const i = process.argv.indexOf(`--${n}`);
    return i > 0 ? process.argv[i + 1] : d;
  };
  const N = Number(arg('shots', 120000));
  const seed = Number(arg('seed', 7)) >>> 0;
  const W = Number(arg('workers', availableParallelism()));
  const jsonOut = arg('json', null);
  const t0 = performance.now();
  const chunk = Math.ceil(N / W);
  const parts = await Promise.all(Array.from({ length: W }, (_, w) => new Promise((resolve, reject) => {
    const from = w * chunk;
    const to = Math.min(N, from + chunk);
    if (from >= to) return resolve([]);
    const wk = new Worker(new URL(import.meta.url), { workerData: { seed, from, to } });
    wk.on('message', (m) => m.done && resolve(m.out));
    wk.on('error', reject);
  })));
  const rows = parts.flat();
  const secs = ((performance.now() - t0) / 1000).toFixed(0);

  const pct = (x, n) => (n ? ((100 * x) / n).toFixed(1).padStart(5) + '%' : '    –');
  const lines = [];
  const out = (s = '') => lines.push(s);
  const table = (title, cols, groups) => {
    out(`\n### ${title}\n`);
    out(`| | n | ${cols.map((c) => c[0]).join(' | ')} |`);
    out(`|---|---:|${cols.map(() => '---:').join('|')}|`);
    for (const [label, set] of groups) {
      if (!set.length) continue;
      out(`| ${label} | ${set.length} | ${cols.map(([, f]) => pct(set.filter(f).length, set.length)).join(' | ')} |`);
    }
  };
  const outcomeCols = [
    ['goal', (r) => r.outcome === 'goal'],
    ['save', (r) => r.outcome === 'save'],
    ['caught', (r) => r.contact === 'caught'],
    ['parried', (r) => r.contact === 'parried'],
    ['goal off keeper', (r) => r.outcome === 'goal' && r.contact],
    ['miss/post', (r) => r.outcome === 'miss' || r.outcome === 'post'],
  ];

  const keeperClass = (r) => {
    if (r.mode !== 'dive') return r.mode;
    if (Math.abs(r.refX) < 0.8) return 'dive, shot central';
    return Math.sign(r.lateral) === Math.sign(r.refX) ? 'dive right way' : 'dive wrong way';
  };
  const band = (v, edges, names) => names[edges.findIndex((e) => v < e)] ?? names[names.length - 1];
  const powerBand = (r) => band(r.power, [0.3, 0.6, 0.85, 9], ['weak <30%', 'medium 30-60%', 'strong 60-85%', 'blast 85%+']);
  const height = (r) => band(r.refY, [0.3, 0.8, 1.6, 9], ['ground', 'low', 'mid', 'high']);
  const side = (r) => band(Math.abs(r.refX), [0.8, 2.0, 9], ['centre', 'inner', 'corner']);

  const on = rows.filter((r) => r.onTarget);
  out(`# Keeper analysis: ${N.toLocaleString()} shots (seed ${seed}, ${secs} s)`);
  out(`\nOn target against an empty goal: ${on.length.toLocaleString()} (${pct(on.length, N)}). Tables below use those.`);
  out(`HIT_MARGIN ${JSON.stringify(P.KEEPER.HIT_MARGIN)} · catch ${P.KEEPER.CATCH_SPEED_MIN}-${P.KEEPER.CATCH_SPEED_MAX} m/s`);

  table('Overall', outcomeCols, [['all fuzzed shots', rows], ['on target', on]]);
  table('By keeper', outcomeCols, ['star', 'read', 'dive right way', 'dive wrong way', 'dive, shot central']
    .map((k) => [k, on.filter((r) => keeperClass(r) === k)]));
  table('By power', outcomeCols, ['weak <30%', 'medium 30-60%', 'strong 60-85%', 'blast 85%+']
    .map((k) => [k, on.filter((r) => powerBand(r) === k)]));
  const zones = [];
  for (const h of ['high', 'mid', 'low', 'ground']) {
    for (const s of ['centre', 'inner', 'corner']) zones.push([`${h} ${s}`, on.filter((r) => height(r) === h && side(r) === s)]);
  }
  table('By arrival zone', outcomeCols, zones);
  table('Curl (|contact x| > 0.25 R) vs straight, against reading keepers', outcomeCols, [
    ['straight', on.filter((r) => r.mode === 'read' && r.curl <= 0.25)],
    ['curled', on.filter((r) => r.mode === 'read' && r.curl > 0.25)],
  ]);

  // Every first touch of a shot.
  const touches = rows.flatMap((r) => r.touches.map((t, k) => ({ ...t, r, first: k === 0 })));
  const firsts = touches.filter((t) => t.first);
  const tCols = [
    ['caught', (t) => t.decision === 'catch'],
    ['then goal', (t) => t.decision === 'parry' && t.r.outcome === 'goal'],
    ['then saved', (t) => t.decision === 'parry' && t.r.outcome === 'save'],
    ['then gathered', (t) => t.decision === 'parry' && t.r.contact === 'caught'],
  ];
  const speedBand = (v) => band(v, [3, 6, 10, 15, 20, 25, 99], ['<3 m/s', '3-6', '6-10', '10-15', '15-20', '20-25', '25+']);
  table('First touch by relative speed (all parts)', tCols, ['<3 m/s', '3-6', '6-10', '10-15', '15-20', '20-25', '25+']
    .map((k) => [k, firsts.filter((t) => speedBand(t.relSpeed) === k)]));
  table('First touch by part', tCols, ['glove', 'arm', 'torso', 'leg', 'head']
    .map((k) => [k, firsts.filter((t) => t.kind === k)]));
  table('First glove/chest touch by positioning quality', tCols, [[0, 0.25], [0.25, 0.5], [0.5, 0.75], [0.75, 1.01]]
    .map(([a, b]) => [`${a}-${Math.min(1, b)}`, firsts.filter((t) => (t.kind === 'glove' || t.kind === 'torso') && t.quality >= a && t.quality < b)]));
  table('First touch by keeper phase', tCols, ['ready', 'push', 'air', 'ground', 'recover']
    .map((k) => [k, firsts.filter((t) => t.phase === k)]));

  // Suspicious cases.
  out('\n### Suspicious cases\n');
  const slowParry = firsts.filter((t) => t.decision === 'parry' && t.relSpeed < 6);
  const slowParryGoal = slowParry.filter((t) => t.r.outcome === 'goal');
  out(`- Slow touches (< 6 m/s) that were **parried**: ${slowParry.length} (${pct(slowParry.length, firsts.length)} of first touches), ` +
    `of which ${slowParryGoal.length} still ended as goals. By part: ` +
    ['glove', 'arm', 'torso', 'leg', 'head'].map((k) => `${k} ${slowParry.filter((t) => t.kind === k).length}`).join(', '));
  const fastCatch = rows.filter((r) => r.caught && r.caught.relSpeed > 22);
  out(`- Catches above 22 m/s (79 km/h): ${fastCatch.length}`);
  const oneHandFast = rows.filter((r) => r.caught && r.caught.how.startsWith('one-handed') && r.caught.relSpeed > 15);
  out(`- One-handed catches above 15 m/s: ${oneHandFast.length}`);
  const slipped = on.filter((r) => r.outcome === 'goal' && !r.contact && r.near.d < 0.15 && r.near.speed < 12);
  out(`- Slow balls (< 12 m/s) that went in passing within 15 cm of the keeper untouched: ${slipped.length} (${pct(slipped.length, on.filter((r) => r.outcome === 'goal').length)} of goals)`);
  out('  - by keeper: ' + ['star', 'read', 'dive right way', 'dive wrong way', 'dive, shot central']
    .map((k) => `${k} ${slipped.filter((r) => keeperClass(r) === k).length}`).join(', '));
  const feet = slipped.filter((r) => r.near.y < 0.4);
  out(`  - of which at foot height (ball centre < 0.4 m): ${feet.length}`);
  const slowGoals = on.filter((r) => r.refSpeed < 12 && r.outcome === 'goal');
  out(`- On-target shots arriving under 12 m/s (43 km/h): ${on.filter((r) => r.refSpeed < 12).length}, goals ${pct(slowGoals.length, on.filter((r) => r.refSpeed < 12).length)}`);
  const ex = (set, label) => {
    if (!set.length) return;
    out(`\n  ${label} — examples (shot index: details):`);
    for (const r of set.slice(0, 5)) {
      out(`  - #${r.i}: power ${r.power.toFixed(2)}, arrives (${r.refX.toFixed(2)}, ${r.refY.toFixed(2)}) at ${r.refSpeed.toFixed(1)} m/s, ` +
        `keeper ${keeperClass(r)}, ${r.outcome}${r.contact ? ' (' + r.contact + ')' : ''}, closest ${(r.near.d * 100).toFixed(0)} cm at ${r.near.speed.toFixed(1)} m/s, y ${r.near.y.toFixed(2)}` +
        (r.touches[0] ? `, first touch ${r.touches[0].kind} ${r.touches[0].relSpeed.toFixed(1)} m/s q ${r.touches[0].quality.toFixed(2)}` : ''));
    }
  };
  ex(slowParryGoal.map((t) => t.r), 'Slow parries that ended as goals');
  ex(feet, 'Slow balls past the feet');
  ex(feet.filter((r) => keeperClass(r) === 'read'), 'Slow balls past a reading keeper\'s feet');
  ex(feet.filter((r) => keeperClass(r) === 'dive right way'), 'Slow balls past a keeper who dived the right way');
  ex(fastCatch, 'Fast catches');

  const report = lines.join('\n');
  console.log(report);
  if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ seed, N, report }, null, 2));
}
