// Judges the rows written by tools/reach-analysis.mjs against an independent
// "realistic keeper" model and compares that with what the simulation did.
//
//   node tools/reach-verdict.mjs rows.jsonl
//
// The model: a real keeper can add some reach to the pose the simulation gives
// it -- fingertips and a shoulder stretch always, a late hand adjustment or a
// foot stab if it has seen the ball for long enough -- and a touch keeps the
// ball out with a probability that falls with the ball's speed, the part, a
// fingertip-only touch and closeness to the post. Every assumption is a named
// constant below.
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import * as P from '../src/physics.js';

const M = {
  SEE: 0.18,                 // s after the kick before a keeper reads the ball's line
  HAND_BASE: 0.05,           // m fingertips + shoulder stretch, always
  HAND_LATE: 0.12,           // m extra hand adjustment, at most
  HAND_RATE: 0.35,           // m per second of seeing beyond 0.1 s
  FOOT_BASE: 0.04,           // m for a low ball
  FOOT_LATE: 0.25,           // m foot stab / leg sweep, at most
  FOOT_RATE: 0.6,            // m per second of seeing beyond 0.15 s
  FOOT_LOW: 0.5,             // ball centre below this counts as low (m)
  OTHER: { arm: 0.03, torso: 0.02, head: 0.02, leg: 0.03 },
  NEAR_POST: 0.4,            // m inside the post where a parry can still go in
  SLOW: 10,                  // m/s below which any touch keeps the ball out
};

const SAVE = {
  glove: [[12, 0.95], [18, 0.85], [24, 0.7], [30, 0.55], [99, 0.4]],
  torso: [[12, 0.95], [20, 0.9], [99, 0.8]],
  leg: [[10, 0.9], [18, 0.7], [99, 0.5]],
  arm: [[12, 0.7], [99, 0.55]],
  head: [[99, 0.5]],
};
const lookup = (tab, v) => tab.find(([lim]) => v < lim)[1];

function reach(kind, ts, y, airborne) {
  if (kind === 'glove') return M.HAND_BASE + Math.min(M.HAND_LATE, M.HAND_RATE * Math.max(0, ts - 0.1));
  if (kind === 'leg' && y < M.FOOT_LOW && !airborne) {
    return M.FOOT_BASE + Math.min(M.FOOT_LATE, M.FOOT_RATE * Math.max(0, ts - 0.15));
  }
  return M.OTHER[kind];
}

// Best realistic chance any limb has of keeping the ball out, with details.
export function realistic(row) {
  let best = { p: 0, kind: null, gap: Infinity, reach: 0, speed: 0, ts: 0 };
  for (const [kind, g] of Object.entries(row.g)) {
    if (!g) continue;
    const [gap, t, speed, y, x] = g;
    const ts = Math.max(0, t - M.SEE);
    // A committed diver is in the air or sliding from just after its commit
    // until it has landed and stopped: no foot stab back behind it.
    const airborne = row.mode === 'dive' && row.commit0 != null && t > row.commit0 + 0.12 && t < row.commit0 + 0.7;
    const r = reach(kind, ts, y, airborne);
    if (gap > r) continue;
    let p = lookup(SAVE[kind], speed);
    // A fingertip touch, or one near the post, only fails against a ball with
    // some pace: anything slower than SLOW is kept out by any touch.
    if (speed >= M.SLOW && gap > 0.5 * r && gap > 0) p *= 0.7; // fingertips only
    if (speed >= M.SLOW && Math.abs(x) > P.GOAL.HW - M.NEAR_POST) p *= 0.85; // parried in off the post
    if (p > best.p) best = { p, kind, gap, reach: r, speed, ts };
  }
  return best;
}

const category = (p) => (p >= 0.75 ? 'should save' : p >= 0.45 ? '50/50' : p > 0 ? 'touch, likely goal' : 'out of reach');

if (process.argv[1].endsWith('reach-verdict.mjs')) {
  const file = process.argv[2];
  const rows = [];
  for await (const line of createInterface({ input: createReadStream(file) })) {
    const r = JSON.parse(line);
    if (r.on) rows.push(r);
  }
  for (const r of rows) {
    // Where the simulation touched, the body gap at contact is at most the
    // collision margin plus the slow-ball reaction reach (sampling between
    // frames can miss the exact moment at high speed).
    if (r.touch && r.g[r.touch.kind]) {
      const g = r.g[r.touch.kind];
      const v = g[2];
      const react = r.touch.kind === 'head' || v >= P.KEEPER.REACT_SPEED ? 0
        : P.KEEPER.REACT_REACH * (P.KEEPER.REACT_SPEED - v) / P.KEEPER.REACT_SPEED;
      g[0] = Math.min(g[0], P.KEEPER.HIT_MARGIN[r.touch.kind] + react);
    }
    r.real = realistic(r);
    r.cat = category(r.real.p);
    r.simSave = r.outcome === 'save';
    r.minGap = Math.min(...Object.values(r.g).filter(Boolean).map((g) => g[0]));
    r.handGap = r.g.glove ? r.g.glove[0] : Infinity;
  }
  const N = rows.length;
  const pct = (x, n) => (n ? ((100 * x) / n).toFixed(1).padStart(5) + '%' : '    –');
  const lines = [];
  const out = (s = '') => lines.push(s);
  const keeperClass = (r) => {
    if (r.mode !== 'dive') return r.mode;
    if (Math.abs(r.refX) < 0.8) return 'dive, shot central';
    return Math.sign(r.lat) === Math.sign(r.refX) ? 'dive right way' : 'dive wrong way';
  };
  const band = (v, edges, names) => names[edges.findIndex((e) => v < e)] ?? names[names.length - 1];
  const power = (r) => band(r.power, [0.3, 0.6, 0.85, 9], ['weak', 'medium', 'strong', 'blast']);
  const height = (r) => band(r.refY, [0.3, 0.8, 1.6, 9], ['ground', 'low', 'mid', 'high']);
  const side = (r) => band(Math.abs(r.refX), [0.8, 2.0, 9], ['centre', 'inner', 'corner']);
  const exp = (set) => set.reduce((s, r) => s + r.real.p, 0);

  // Calibration table: realistic expected save rate vs the simulation's.
  const calib = (title, groups) => {
    out(`\n### ${title}\n`);
    out('| | shots | realistic save | sim save | gap | sim saves out of reach | sim goals it should save |');
    out('|---|---:|---:|---:|---:|---:|---:|');
    for (const [label, set] of groups) {
      if (set.length < 30) continue;
      const e = exp(set) / set.length;
      const s = set.filter((r) => r.simSave).length / set.length;
      const over = set.filter((r) => r.simSave && r.cat === 'out of reach').length;
      const under = set.filter((r) => !r.simSave && r.cat === 'should save').length;
      const d = (100 * (s - e)).toFixed(1);
      out(`| ${label} | ${set.length} | ${pct(e * set.length, set.length)} | ${pct(s * set.length, set.length)} | ${d > 0 ? '+' : ''}${d} | ${pct(over, set.length)} | ${pct(under, set.length)} |`);
    }
  };

  out(`# Reach analysis: ${N.toLocaleString()} on-target shots`);
  out(`\nRealistic model: ${JSON.stringify(M)}`);
  out(`\nRealistic expected save rate ${pct(exp(rows), N)} vs simulation ${pct(rows.filter((r) => r.simSave).length, N)}.`);

  out('\n### Closest approach of any limb before the ball crossed, for goals\n');
  const goals = rows.filter((r) => r.outcome === 'goal');
  out('| within | any limb | a glove |\n|---|---:|---:|');
  for (const cm of [5, 10, 20, 30, 50, 100]) {
    out(`| ${cm} cm | ${pct(goals.filter((r) => r.minGap <= cm / 100).length, goals.length)} | ${pct(goals.filter((r) => r.handGap <= cm / 100).length, goals.length)} |`);
  }

  out('\n### Simulation vs realistic verdict\n');
  const cats = ['should save', '50/50', 'touch, likely goal', 'out of reach'];
  out('| sim \\ realistic | ' + cats.join(' | ') + ' |\n|---|' + cats.map(() => '---:').join('|') + '|');
  for (const [label, set] of [['saved', rows.filter((r) => r.simSave)], ['conceded', rows.filter((r) => r.outcome === 'goal')]]) {
    out(`| ${label} (${set.length}) | ${cats.map((c) => pct(set.filter((r) => r.cat === c).length, set.length)).join(' | ')} |`);
  }

  calib('By keeper', ['star', 'read', 'dive right way', 'dive wrong way', 'dive, shot central']
    .map((k) => [k, rows.filter((r) => keeperClass(r) === k)]));
  calib('By power', ['weak', 'medium', 'strong', 'blast'].map((k) => [k, rows.filter((r) => power(r) === k)]));
  const zones = [];
  for (const h of ['high', 'mid', 'low', 'ground']) for (const s of ['centre', 'inner', 'corner']) {
    zones.push([`${h} ${s}`, rows.filter((r) => height(r) === h && side(r) === s)]);
  }
  calib('By arrival zone', zones);
  calib('By closest limb (realistic)', ['glove', 'arm', 'torso', 'leg', 'head']
    .map((k) => [k, rows.filter((r) => r.real.kind === k)]));
  calib('By ball speed at the closest approach', [[0, 8], [8, 12], [12, 18], [18, 24], [24, 30], [30, 99]]
    .map(([a, b]) => [`${a}-${b} m/s`, rows.filter((r) => r.real.kind && r.real.speed >= a && r.real.speed < b)]));
  calib('By time the keeper had seen the ball (touchable shots)', [[0, 0.1], [0.1, 0.2], [0.2, 0.35], [0.35, 0.6], [0.6, 9]]
    .map(([a, b]) => [`${a}-${b} s`, rows.filter((r) => r.real.kind && r.real.ts >= a && r.real.ts < b)]));
  calib('By closest hand gap (all shots)', [[-1, 0.03], [0.03, 0.06], [0.06, 0.1], [0.1, 0.15], [0.15, 0.25], [0.25, 99]]
    .map(([a, b]) => [`${Math.round(a * 100)}-${Math.round(b * 100)} cm`, rows.filter((r) => r.handGap >= a && r.handGap < b)]));
  calib('Curl against reading keepers', [
    ['straight', rows.filter((r) => r.mode === 'read' && Math.abs(r.curl) <= 0.25)],
    ['curled', rows.filter((r) => r.mode === 'read' && Math.abs(r.curl) > 0.25)],
  ]);
  calib('Simulated touch outcome', [
    ['caught', rows.filter((r) => r.kc === 'caught')],
    ['parried', rows.filter((r) => r.kc === 'parried')],
    ['untouched', rows.filter((r) => !r.kc)],
  ]);

  out('\n### Biggest disagreements\n');
  const show = (label, set) => {
    out(`\n**${label}** (${set.length})`);
    for (const r of set.slice(0, 6)) {
      const g = r.g[r.real.kind] || r.g.glove;
      out(`- #${r.i} ${keeperClass(r)}, power ${r.power}, arrives (${r.refX}, ${r.refY}) — sim ${r.outcome}${r.kc ? ' (' + r.kc + ')' : ''}; ` +
        `closest ${r.real.kind || 'glove'} ${(g[0] * 100).toFixed(0)} cm at ${g[2].toFixed(1)} m/s, y ${g[3]}, seen ${(Math.max(0, g[1] - M.SEE)).toFixed(2)} s; realistic p ${r.real.p.toFixed(2)}`);
    }
  };
  show('Simulation conceded, realistic keeper should save', goals.filter((r) => r.cat === 'should save'));
  show('Simulation saved, realistically out of reach', rows.filter((r) => r.simSave && r.cat === 'out of reach'));
  show('Simulation saved, realistically a likely goal', rows.filter((r) => r.simSave && r.cat === 'touch, likely goal'));

  console.log(lines.join('\n'));
}
