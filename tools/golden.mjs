// Golden vectors for ports of the physics engine (the gno one lives in
// ../gno-shots-realm/gno.land/p/clockwork/penalty/physics/v0). Every float is
// written as its 64 bits in hex, so a port must match bit for bit.
//
//   node tools/golden.mjs --cases 3000 --seed 7 > golden.txt
//   node tools/golden.mjs --cases 120 --seed 8 --gno > golden_test.gno
//
// One kick per line, space-separated:
//   aimX aimY contactX contactY power  mishit|-  d,s,j,r|-  perfectRead
//   => outcome decidedStep decidedAt  touchPart touchStep  woodwork caught
//      line(t,x,y|-) cross(t,x,y|-)  launch(vx,vy,vz,wx,wy,wz,speed,fx,fy,cx,cy)
//      misread(x,y,vx,jump|-)  trace  commits(step:vx:jump:star:read;...|-)
//      contacts(step:part:catch:gave;...|-)
// The trace is an FNV-1a hash of the ball's position, velocity and spin and
// the keeper's position, velocity, lean and arms, folded every 25 steps and at
// the deciding step.
import * as P from '../src/physics.js';

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const N = Number(arg('cases', 2000));
const SEED = Number(arg('seed', 7)) >>> 0;
const GNO = process.argv.includes('--gno');
const EVERY = 25;

const PARTS = ['left leg', 'body', 'left arm', 'left glove', 'right leg', 'right arm', 'right glove', 'head'];
const FRAME = { 'left post': 1, 'right post': 2, crossbar: 3 };

const dv = new DataView(new ArrayBuffer(8));
const bytes8 = new Uint8Array(dv.buffer);
export const hex = (x) => {
  dv.setFloat64(0, x);
  return dv.getBigUint64(0).toString(16).padStart(16, '0');
};
const fold = (h, x) => {
  dv.setFloat64(0, x);
  for (let i = 0; i < 8; i++) {
    h ^= bytes8[i];
    h = Math.imul(h, 0x01000193);
  }
  return h;
};
const foldVec = (h, a) => fold(fold(fold(h, a.x), a.y), a.z);

function foldState(h, ball, keeper) {
  h = foldVec(foldVec(foldVec(h, ball.p), ball.v), ball.w);
  if (keeper) {
    h = foldVec(foldVec(h, keeper.pos), keeper.vel);
    h = fold(fold(h, keeper.lean.s), keeper.lean.c);
    h = foldVec(foldVec(h, keeper.arms.l), keeper.arms.r);
  }
  return h;
}

// A varied kick: chain-style integer inputs half the time, every plan mode,
// sometimes no mishit, an empty goal or a perfect read.
function makeCase(rnd, i) {
  const pick = rnd();
  let aim, contact, power;
  if (pick < 0.5) {
    // As the realm sends them: mm, milli-radii, per-mille.
    aim = { x: Math.round((rnd() * 9 - 4.5) * 1000) / 1000, y: Math.round(rnd() * 3.4 * 1000) / 1000 };
    const a = rnd() * 2 * Math.PI;
    const r = 0.5 * Math.sqrt(rnd());
    contact = { x: Math.trunc(r * Math.cos(a) * 1000) / 1000, y: Math.trunc(r * Math.sin(a) * 1000) / 1000 };
    power = Math.round(rnd() * 1000) / 1000;
  } else if (pick < 0.62) {
    // The chain's own kicks.
    const b = Uint8Array.from({ length: 32 }, () => Math.floor(rnd() * 256));
    ({ aim, contact, power } = P.decodeTakerShot(b).input);
  } else {
    aim = { x: rnd() * 13 - 6.5, y: rnd() * 4.4 - 0.2 };
    contact = { x: rnd() * 1.2 - 0.6, y: rnd() * 1.2 - 0.6 };
    power = rnd() * 1.1 - 0.05;
  }
  const seed = rnd() < 0.93 ? Uint8Array.from({ length: 24 }, () => Math.floor(rnd() * 256)) : undefined;
  const empty = rnd() < 0.05;
  const raw = Array.from({ length: 4 }, () => Math.floor(rnd() * 65536));
  if (!empty && rnd() < 0.3) {
    // Lean on the modes the uniform draw rarely gives: star jumps and reads.
    raw[1] = Math.floor(rnd() * 65535 * 0.3);
  }
  const perfect = rnd() < 0.05;
  return { aim, contact, power, seed, plan: empty ? null : P.planFromRaw(raw), raw: empty ? null : raw, perfect, i };
}

function run(c) {
  const input = { aim: c.aim, contact: c.contact, power: c.power, ...(c.seed ? { seed: c.seed } : {}) };
  let h = 0x811c9dc5;
  let decidedStep = -1;
  let keeperRef = null;
  let commitsAtDecision = 0;
  const sim = P.simulateShot(input, c.plan, {
    misread: c.perfect ? false : undefined,
    trace: (step, ball, keeper, verdict) => {
      keeperRef = keeper;
      if (decidedStep >= 0) return;
      if (!verdict) {
        if (step % EVERY === 0) h = foldState(h, ball, keeper);
      } else {
        decidedStep = step;
        commitsAtDecision = keeper ? keeper.commits.length : 0;
        h = foldState(h, ball, keeper);
      }
    },
  });
  const r = sim.result;
  const at = r.decidedAt;
  const stepOf = (t) => Math.round(t / P.SIM.DT);
  const outcome = { goal: 1, save: 2, miss: 3, post: 4 }[r.outcome];
  const touch = r.touch && r.touch.t <= at ? r.touch : null;
  const wood = r.woodwork && r.woodwork.t <= at ? r.woodwork : null;
  const caught = !!(r.caught && r.caught.t <= Math.round(at * 1000) / 1000);
  const trip = (o) => (o && o.t <= Math.round(at * 1000) / 1000 ? `${hex(o.t)},${hex(o.x)},${hex(o.y)}` : '-');
  const L = sim.launch;
  const launch = [L.vel.x, L.vel.y, L.vel.z, L.spin.x, L.spin.y, L.spin.z, L.speed, L.fuzz.x, L.fuzz.y, L.contact.x, L.contact.y].map(hex).join(',');
  const mis = r.keeper && r.keeper.misread ? [r.keeper.misread.x, r.keeper.misread.y, r.keeper.misread.vx, r.keeper.misread.jump].map(hex).join(',') : '-';
  // The moves made by the deciding step (a keeper moving in 4 ms blocks can
  // make one stamped up to 3 ms after it).
  const commits = keeperRef ? keeperRef.commits.slice(0, commitsAtDecision)
    .map((k) => `${stepOf(k.t0)}:${hex(k.vx)}:${hex(k.jump)}:${k.star ? 1 : 0}:${k.read ? 1 : 0}`).join(';') : '';
  const contacts = r.contacts.filter((k) => stepOf(k.t) <= decidedStep)
    .map((k) => `${stepOf(k.t)}:${PARTS.indexOf(k.part)}:${k.decision === 'catch' ? 1 : 0}:${k.gaveWay ? 1 : 0}`).join(';');
  const inFields = [
    hex(c.aim.x), hex(c.aim.y), hex(c.contact.x), hex(c.contact.y), hex(c.power),
    c.seed ? P.toHex(c.seed) : '-', c.raw ? c.raw.join(',') : '-', c.perfect ? 1 : 0,
  ];
  const outFields = [
    outcome, decidedStep, hex(at),
    touch ? PARTS.indexOf(touch.part) : -1, touch ? stepOf(touch.t) : 0,
    wood ? FRAME[wood.part] : 0, caught ? 1 : 0,
    trip(r.lineCross), trip(r.crossing), launch, mis, (h >>> 0).toString(16).padStart(8, '0'),
    commits || '-', contacts || '-',
  ];
  return { line: `${inFields.join(' ')} => ${outFields.join(' ')}`, outcome: r.outcome, mode: c.plan ? c.plan.mode : 'empty', caught, touch: !!touch, wood: !!wood };
}

const rnd = P.mulberry32(SEED);
const lines = [];
const tally = {};
for (let i = 0; i < N; i++) {
  const c = makeCase(rnd, i);
  const o = run(c);
  lines.push(o.line);
  const key = `${o.mode}/${o.outcome}${o.caught ? '/caught' : o.touch ? '/touched' : ''}${o.wood ? '/woodwork' : ''}`;
  tally[key] = (tally[key] || 0) + 1;
}
console.error(Object.entries(tally).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}: ${n}`).join('\n'));

// Plan decoding: the four uint16 → mode, heading, speed, jump, reaction and
// the launch velocity (which goes through detSin/detCos).
const planLines = [];
const prnd = P.mulberry32(SEED ^ 0x5eed);
const edges = [0, 1, 2, 3931, 3932, 3933, 19660, 19661, 19662, 32767, 32768, 65533, 65534, 65535];
for (let i = 0; i < 400; i++) {
  const raw = i < 56
    ? [edges[i % 14], edges[(i * 5) % 14], edges[(i * 3) % 14], edges[(i * 11) % 14]]
    : Array.from({ length: 4 }, () => Math.floor(prnd() * 65536));
  const pl = P.planFromRaw(raw);
  const lv = P.keeperLaunchVelocity(pl);
  const mode = { star: 1, read: 2, dive: 3 }[pl.mode];
  planLines.push(`${raw.join(',')} => ${mode} ${[pl.direction, pl.speed, pl.jump, pl.reaction, lv.x, lv.y, lv.z].map(hex).join(' ')}`);
}

if (GNO) {
  console.log(`package physics

// Generated by gno-shots/tools/golden.mjs --cases ${N} --seed ${SEED}: the
// browser engine's results, bit for bit. Do not edit.

const goldenSeed = ${SEED}

const goldenCases = \`${lines.join('\n')}\`

const goldenPlans = \`${planLines.join('\n')}\`
`);
} else {
  console.log(lines.join('\n'));
}
