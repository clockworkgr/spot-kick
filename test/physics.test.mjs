import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../src/physics.js';

const STAY = { direction: 90, speed: 0, jump: 0, reaction: 0.06 };
const DIVE_LEFT = { direction: 170, speed: 5, jump: 1, reaction: 0.06 };
const seed24 = (i) => P.roundBytesFromSeed(i, 0).slice(8);
const shot = (x, y, cx = 0, cy = 0, power = 0.8) => ({ aim: { x, y }, contact: { x: cx, y: cy }, power });

test('identical inputs give bit-identical simulations', () => {
  const { plan, strikeSeed } = P.decodeRound(P.roundBytesFromSeed(1234, 0));
  const input = { ...shot(2.1, 1.7, 0.3, -0.25, 0.77), seed: strikeSeed };
  const a = P.simulateShot(input, plan);
  const b = P.simulateShot(structuredClone(input), structuredClone(plan));
  assert.equal(a.hash, b.hash);
  assert.deepEqual(a.frames, b.frames);
  assert.deepEqual(a.events, b.events);
});

test('round bytes decode to a plan and a 24-byte mishit seed, and re-encode exactly', () => {
  const bytes = P.roundBytesFromSeed(99, 3);
  const { plan, strikeSeed } = P.decodeRound(bytes);
  assert.equal(strikeSeed.length, 24);
  assert.deepEqual(plan, P.decodeRound(Uint8Array.from(bytes)).plan);
  assert.deepEqual(P.encodeRound(plan.raw, strikeSeed), bytes);
  assert.throws(() => P.decodeRound(bytes.slice(0, 31)));
});

test('uint16 plan values map onto the documented ranges', () => {
  const plan = (d, s, j, r) => P.decodePlan(Uint8Array.from([d >> 8, d & 255, s >> 8, s & 255, j >> 8, j & 255, r >> 8, r & 255]));
  const lo = plan(0, 0, 0, 0);
  const hi = plan(65535, 65535, 65535, 65535);
  assert.equal(lo.direction, 0);
  assert.equal(hi.direction, 180);
  assert.ok(Math.abs(plan(32768, 0, 0, 0).direction - 90) < 0.1);
  assert.equal(lo.speed, 0);
  assert.equal(hi.speed, P.PLAN.DIVE_MAX_SPEED);
  assert.equal(plan(0, 3000, 0, 0).mode, 'star');                 // lowest 6%
  assert.ok(plan(0, 3000, 0, 0).speed < P.KEEPER.STAR_SPEED);
  assert.equal(plan(0, 8500, 0, 0).mode, 'read');                 // next 30%
  assert.equal(plan(0, 26000, 0, 0).mode, 'dive');                // the rest
  assert.ok(plan(0, 26000, 0, 0).speed >= P.PLAN.DIVE_MIN_SPEED);
  assert.equal(lo.jump, P.PLAN.JUMP_MIN);
  assert.equal(hi.jump, P.PLAN.JUMP_MAX);
  assert.equal(lo.reaction, P.PLAN.REACTION_MIN);
  assert.equal(hi.reaction, P.PLAN.REACTION_MAX);
  // Direction is monotonic in its uint16.
  let prev = -1;
  for (let u = 0; u <= 65535; u += 257) {
    const d = plan(u, 0, 0, 0).direction;
    assert.ok(d >= prev);
    prev = d;
  }
});

test('the commit changes if any of the 32 round bytes changes', () => {
  const bytes = P.roundBytesFromSeed(7, 0);
  const h = P.commitHash(bytes);
  for (let i = 0; i < 32; i++) {
    const b = Uint8Array.from(bytes);
    b[i] ^= 1;
    assert.notEqual(P.commitHash(b), h, `byte ${i}`);
  }
});

test('a later keeper reaction lets a shot past that an earlier one saves', () => {
  const input = shot(1.5, 1.5, 0, -0.1, 0.8);
  const base = { direction: 8, speed: 4.2, jump: 2.4 };
  const quick = P.simulateShot(input, { ...base, reaction: P.PLAN.REACTION_MIN }).result.outcome;
  const slow = P.simulateShot(input, { ...base, reaction: P.PLAN.REACTION_MAX }).result.outcome;
  assert.notEqual(quick, slow);
});

test('detSin matches Math.sin closely', () => {
  for (let x = -10; x <= 10; x += 0.37) assert.ok(Math.abs(P.detSin(x) - Math.sin(x)) < 1e-12, `x=${x}`);
});

test('shot into the corner the keeper did not choose is a goal', () => {
  assert.equal(P.simulateShot(shot(2.6, 0.5), DIVE_LEFT).result.outcome, 'goal');
});

test('shot straight at a standing keeper is saved', () => {
  assert.equal(P.simulateShot(shot(0, 1, 0, 0, 0.6), STAY).result.outcome, 'save');
});

test('wide and over shots are misses', () => {
  assert.match(P.simulateShot(shot(5, 1), STAY).result.detail, /Wide of the right post/);
  assert.match(P.simulateShot(shot(0, 3.5, 0, -0.4, 0.9), STAY).result.detail, /Over the bar/);
});

test('aiming at the post centre hits the woodwork', () => {
  const s = P.simulateShot(shot(P.NET.SIDE_X, 1.2, 0, 0, 0.9), null);
  assert.ok(s.events.some((e) => e.type === 'woodwork'));
  assert.equal(s.result.outcome, 'post');
});

test('hitting below centre lifts the ball, above centre dips it', () => {
  const y = (cy) => P.simulateShot(shot(0, 1, 0, cy), null).result.lineCross.y;
  assert.ok(y(-0.4) > y(0) + 0.3);
  assert.ok(y(0.4) < y(0));
});

test('striking the right side of the ball curls it left (Magnus)', () => {
  const s = P.simulateShot(shot(2, 1.2, 0.5, 0), null);
  assert.ok(s.launch.spin.y > 0, 'spin about +y');
  // Without Magnus the ball would continue on its launch line; compare to that.
  const L = s.launch;
  const tLine = (P.GOAL.Z - L.pos.z) / L.vel.z;
  const straightX = L.pos.x + L.vel.x * tLine;
  assert.ok(s.result.lineCross.x < straightX - 0.3);
});

test('a ball in the net is a goal and comes to rest inside it', () => {
  const s = P.simulateShot(shot(-1.5, 1.2), null);
  assert.equal(s.result.outcome, 'goal');
  const last = s.frames.at(-1).b;
  assert.ok(last[2] > P.NET.BACK_Z - 0.3 && last[2] < P.GOAL.Z);
});

test('mishit fuzz is deterministic, absent without a seed, and grows with power', () => {
  const base = shot(1, 1, 0.2, -0.1, 0.9);
  assert.deepEqual(P.computeLaunch(base).fuzz, { x: 0, y: 0 });
  const a = P.computeLaunch({ ...base, seed: seed24(7) });
  assert.deepEqual(a.contact, P.computeLaunch({ ...base, seed: seed24(7) }).contact);
  assert.throws(() => P.computeLaunch({ ...base, seed: new Uint8Array(4) }));
  assert.notDeepEqual(a.contact, a.intended);
  const sd = (power) => {
    let s2 = 0;
    for (let i = 0; i < 400; i++) {
      const f = P.computeLaunch({ ...shot(0, 1, 0, 0, power), seed: seed24(i) }).fuzz;
      s2 += f.x * f.x + f.y * f.y;
    }
    return Math.sqrt(s2 / 800);
  };
  assert.ok(sd(1) > sd(0) * 2);
  assert.ok(Math.abs(sd(1) - (P.KICK.FUZZ_BASE + P.KICK.FUZZ_POWER)) < 0.02);
});

test('chosen contact is limited to MAX_CONTACT', () => {
  const L = P.computeLaunch(shot(0, 1, 0.9, 0));
  assert.ok(Math.abs(L.contact.x - P.KICK.MAX_CONTACT) < 1e-12);
});

test('a moderate off-centre strike bends the ball well over half a metre', () => {
  const s = P.simulateShot(shot(0, 1.2, 0.3, 0, 0.75), null);
  const L = s.launch;
  const straightX = L.vel.x * (P.GOAL.Z / L.vel.z);
  assert.ok(straightX - s.result.lineCross.x > 0.6);
});

const READ = { mode: 'read', direction: 0, speed: 0, jump: 0, reaction: 0.06 };

test('a reading keeper is deterministic and commits at READ_BASE + reaction', () => {
  const input = shot(1.6, 1.0, 0, 0, 0.8);
  const a = P.simulateShot(input, READ);
  const b = P.simulateShot(structuredClone(input), structuredClone(READ));
  assert.equal(a.hash, b.hash);
  assert.deepEqual(a.frames, b.frames);
  const first = a.result.keeper.commits[0];
  assert.ok(first.read);
  assert.ok(Math.abs(first.t0 - (P.KEEPER.READ_BASE + READ.reaction)) < 0.0015);
});

// Ball state a few steps into the flight, read from the recorded frames.
function stateAt(sim, t) {
  const fr = sim.frames;
  const i = fr.findIndex((f) => f.t >= t);
  const [a, b] = [fr[i], fr[i + 1]];
  const dt = b.t - a.t;
  return {
    p: { x: a.b[0], y: a.b[1], z: a.b[2] },
    v: { x: (b.b[0] - a.b[0]) / dt, y: (b.b[1] - a.b[1]) / dt, z: (b.b[2] - a.b[2]) / dt },
    grounded: false,
  };
}

test('the keeper predicts a straight shot well, but curl fools it', () => {
  const zk = P.GOAL.Z + P.KEEPER.LINE_OFFSET;
  const straight = P.simulateShot(shot(1.5, 1.4, 0, 0, 0.8), null);
  const p1 = P.predictCrossing(stateAt(straight, 0.1), zk);
  const at1 = straight.frames.find((f) => f.b[2] <= zk);
  assert.ok(Math.abs(p1.x - at1.b[0]) < 0.06, `straight error ${p1.x - at1.b[0]}`);
  assert.ok(Math.abs(0.1 + p1.tau - at1.t) < 0.02);
  const curl = P.simulateShot(shot(3.6, 1.4, 0.45, 0, 0.8), null);
  const p2 = P.predictCrossing(stateAt(curl, 0.1), zk);
  const at2 = curl.frames.find((f) => f.b[2] <= zk);
  assert.ok(Math.abs(p2.x - at2.b[0]) > 0.3, `curl error ${p2.x - at2.b[0]}`);
});

test('a weak shot gives a reading keeper time to shuffle across and save', () => {
  const weak = { aim: { x: 2.4, y: 0.6 }, contact: { x: 0, y: 0 }, power: 0.15 };
  const s = P.simulateShot(weak, READ);
  assert.equal(s.result.outcome, 'save');
  assert.ok(s.events.some((e) => /shuffles across/.test(e.text)));
  // The same shot struck hard beats the same keeper.
  assert.equal(P.simulateShot({ ...weak, power: 0.95 }, READ).result.outcome, 'goal');
});

test('a keeper that dives the wrong way gets up and goes again for a slow ball', () => {
  const weak = { aim: { x: -1.2, y: 0.6 }, contact: { x: 0, y: 0 }, power: 0.1 };
  const wrongWay = { direction: 8, speed: 3, jump: -1, reaction: 0.06 };
  const s = P.simulateShot(weak, wrongWay);
  assert.equal(s.result.keeper.commits.length, 2);
  assert.ok(s.events.some((e) => /recovers and goes again/.test(e.text)));
  assert.equal(s.result.outcome, 'save');
  // A firm shot to the same spot is in before the keeper can recover.
  const firm = P.simulateShot({ ...weak, power: 0.7 }, wrongWay);
  assert.equal(firm.result.keeper.commits.length, 1);
  assert.equal(firm.result.outcome, 'goal');
});

// ---------------------------------------------------------------- catch or parry

test('a well-placed keeper catches a medium shot and carries the ball', () => {
  const s = P.simulateShot(shot(0.05, 2.2, 0, 0, 0.45), STAY);
  assert.equal(s.result.outcome, 'save');
  assert.equal(s.result.keeperContact, 'caught');
  assert.match(s.result.detail, /^Caught with both hands/);
  const c = s.result.caught;
  assert.ok(c.relSpeed <= c.limit && c.quality > 0.5);
  assert.equal(s.result.decidedAt, c.t, 'the verdict is the catch');
  // From the catch on, every frame has the ball held, in front of the line.
  const after = s.frames.filter((f) => f.t > c.t + 0.01);
  assert.ok(after.length > 0 && after.every((f) => f.held));
  assert.ok(after.every((f) => f.b[2] > P.GOAL.Z && f.b[1] >= P.BALL.R - 1e-9));
  const keeperAt = s.frames.at(-1).k.pos;
  const ball = s.frames.at(-1).b;
  assert.ok(Math.hypot(ball[0] - keeperAt.x, ball[2] - keeperAt.z) < 1.2, 'the ball ends in the keeper\'s hands');
});

test('the same placement struck hard is parried, not caught', () => {
  const s = P.simulateShot(shot(0.05, 1.8, 0, 0, 1), STAY);
  assert.equal(s.result.keeperContact, 'parried');
  assert.equal(s.result.caught, null);
  assert.ok(s.frames.every((f) => !f.held));
});

test('a parried shot can be gathered at a later touch', () => {
  const s = P.simulateShot(shot(0.3, 1.8, 0, 0, 0.6), STAY);
  const parry = s.result.contacts[0];
  const last = s.result.contacts.at(-1);
  assert.equal(parry.decision, 'parry');
  assert.equal(last.decision, 'catch');
  assert.ok(last.t - parry.t > P.KEEPER.TOUCH_GAP);
  assert.equal(s.result.keeperContact, 'caught');
});

test('catch limits: the head never holds, legs and arms only gather a nearly stopped ball, one glove holds less', () => {
  const k = P.keeperInitialState();
  const caps = P.keeperCapsules(k);
  const glove = caps.find((c) => c.name === 'right glove');
  const gl = caps.find((c) => c.name === 'left glove').a;
  const between = { x: (glove.a.x + gl.x) / 2, y: (glove.a.y + gl.y) / 2, z: glove.a.z };
  const G = P.KEEPER.GATHER_SPEED;
  assert.equal(P.catchDecision(caps, caps.find((c) => c.name === 'head'), 1, between).held, false);
  for (const name of ['right arm', 'left leg']) {
    const part = caps.find((c) => c.name === name);
    assert.equal(P.catchDecision(caps, part, G, between).held, true, `${name} gathers at ${G} m/s`);
    assert.equal(P.catchDecision(caps, part, G + 0.01, between).held, false, `${name} parries above it`);
  }
  const good = P.catchDecision(caps, glove, 5, between);
  const far = P.catchDecision(caps, glove, 5, { x: between.x + 1.2, y: between.y, z: between.z });
  assert.ok(good.quality > far.quality && good.limit > far.limit);
  assert.ok(far.limit <= P.KEEPER.ONE_HAND_MAX, 'a lone glove is capped');
  assert.ok(good.limit <= P.KEEPER.CATCH_SPEED_MAX);
  assert.equal(P.catchDecision(caps, glove, good.limit, between).held, true);
  assert.equal(P.catchDecision(caps, glove, good.limit + 0.01, between).held, false);
});

test('a slow ball rolled at a set keeper\'s feet is gathered, a firmer one blocked', () => {
  const soft = P.simulateShot(shot(0.15, 0.2, 0, 0, 0), STAY);
  assert.equal(soft.result.keeperContact, 'caught');
  assert.match(soft.result.caught.how, /gathered at the feet/);
  const firm = P.simulateShot(shot(0.15, 0.2, 0, 0, 0.15), STAY);
  assert.equal(firm.result.contacts[0].kind, 'leg');
  assert.equal(firm.result.contacts[0].decision, 'parry');
});

test('a reading keeper goes down sideways to a slow low ball beside it', () => {
  const s = P.simulateShot(shot(-0.6, 0.5, 0, 0, 0.2), READ);
  const dive = s.result.keeper.commits[0];
  assert.ok(dive.read && dive.vx <= -P.KEEPER.LOW_DROP_SPEED + 1e-9, `dived ${dive.vx} m/s`);
  assert.equal(s.result.outcome, 'save');
  assert.equal(s.result.keeperContact, 'caught');
});

test('hitboxes carry a collision margin over the body size', () => {
  for (const c of P.keeperCapsules(P.keeperInitialState())) {
    assert.equal(c.hit, c.r + P.KEEPER.HIT_MARGIN[c.kind]);
  }
});

test('every touch is logged once with its decision', () => {
  const s = P.simulateShot(shot(0.05, 2.1, 0, 0, 0.7), STAY);
  for (const c of s.result.contacts) {
    assert.ok(['catch', 'parry'].includes(c.decision) && c.relSpeed > 0 && c.limit > 0);
  }
  const ts = s.result.contacts.map((c) => c.t);
  for (let i = 1; i < ts.length; i++) assert.ok(ts[i] - ts[i - 1] > P.KEEPER.TOUCH_GAP);
});

test('catches are deterministic', () => {
  const input = shot(0.05, 2.2, 0, 0, 0.45);
  const a = P.simulateShot(input, STAY);
  const b = P.simulateShot(structuredClone(input), structuredClone(STAY));
  assert.equal(a.hash, b.hash);
  assert.deepEqual(a.frames, b.frames);
});

// ---------------------------------------------------------------- limb give

const DIVE_RIGHT = { direction: 8, speed: 4.5, jump: 2.5, reaction: 0.04 };

test('a full-power shot can push through an outstretched arm and still go in', () => {
  const s = P.simulateShot(shot(2.2, 1.2, 0, -0.1, 1), DIVE_RIGHT);
  const c = s.result.contacts[0];
  assert.equal(c.decision, 'parry');
  assert.equal(c.gaveWay, true);
  assert.equal(s.result.outcome, 'goal');
  assert.ok(s.events.some((e) => /cannot stop it/.test(e.text)));
});

test('the same keeper holds firm against a shot it can stop', () => {
  const s = P.simulateShot(shot(0.05, 2.2, 0, 0, 0.45), STAY);
  assert.equal(s.result.contacts[0].gaveWay, false);
  assert.equal(s.result.keeperContact, 'caught');
});

test('a manageable glove parry goes away from goal, not back in', () => {
  // Two real one-handed parries found by tools/reach-analysis.mjs (seed 11),
  // found before misreads existed, so replayed with a perfect read.
  const cases = [
    [266773, { aim: { x: -2.395880236836383, y: 0.2640368801024742 }, contact: { x: -0.06316093252941467, y: 0.18517956979929417 }, power: 0.2286553776357323 }],
    [266934, { aim: { x: 2.899192070817808, y: 2.8980001003233715 }, contact: { x: 0.23444551114436407, y: 0.07994806630109902 }, power: 0.22728849947452545 }],
  ];
  for (const [i, input] of cases) {
    const { plan, strikeSeed } = P.decodeRound(P.roundBytesFromSeed(11, i));
    const s = P.simulateShot({ ...input, seed: strikeSeed }, plan, { misread: false });
    const c = s.result.contacts.find((k) => k.kind === 'glove' && k.decision === 'parry');
    assert.ok(c && !c.gaveWay && c.relSpeed < P.KEEPER.PARRY_CONTROL, `#${i} should be a controllable parry`);
    const f = s.frames.find((fr) => fr.t > c.t + 0.02);
    const prev = s.frames[s.frames.indexOf(f) - 1];
    assert.ok((f.b[2] - prev.b[2]) / (f.t - prev.t) >= P.KEEPER.PARRY_OUT - 0.5, `#${i} should leave away from goal`);
    assert.equal(s.result.outcome, 'save');
  }
});

test('limb strength and hand reach settings are sane', () => {
  const G = P.KEEPER.GIVE;
  assert.ok(G.hands > G.glove && G.glove > G.arm && G.leg > G.legInAir);
  assert.ok(P.KEEPER.FINGERTIP_GIVE > 0 && P.KEEPER.FINGERTIP_GIVE < 1);
  assert.ok(P.KEEPER.HAND_LATE_MAX > 0 && P.KEEPER.HAND_LATE_MAX <= 0.1);
});

test('catching and giving way stay deterministic', () => {
  for (const [input, plan] of [[shot(2.2, 1.2, 0, -0.1, 1), DIVE_RIGHT], [shot(0.3, 1.8, 0, 0, 0.6), STAY]]) {
    const a = P.simulateShot(input, plan);
    const b = P.simulateShot(structuredClone(input), structuredClone(plan));
    assert.equal(a.hash, b.hash);
  }
});

test('the computer kick decodes from the round bytes exactly as on chain', () => {
  const bytes = (...b) => Uint8Array.from([...b, ...new Array(24).fill(7)]);
  assert.deepEqual(P.decodeTakerShot(bytes(0, 0, 0, 0, 0, 0, 0, 0)).ints,
    { aimX: -3027, aimY: 300, power: 450, contactX: -350, contactY: -350 });
  assert.deepEqual(P.decodeTakerShot(bytes(255, 255, 255, 255, 255, 255, 255, 255)).ints,
    { aimX: 3027, aimY: 2624, power: 1000, contactX: 347, contactY: 347 });
  const mid = P.decodeTakerShot(bytes(128, 0, 64, 0, 200, 0, 128, 128));
  assert.deepEqual(mid.ints, { aimX: 0, aimY: 881, power: 879, contactX: 0, contactY: 0 });
  assert.deepEqual(mid.input.aim, { x: 0, y: 0.881 });
  assert.equal(mid.input.power, 0.879);
  assert.deepEqual(mid.input.seed, new Uint8Array(24).fill(7));
});

test('encodePlan inverts decodePlan', () => {
  for (let i = 0; i < 2000; i++) {
    const plan = P.decodeRound(P.roundBytesFromSeed(7, i)).plan;
    // A read ignores where in its band the speed value lies, so compare plans.
    const { raw, ...again } = P.planFromRaw(P.encodePlan(plan));
    const { raw: _, ...want } = plan;
    assert.deepEqual(again, want);
  }
  const read = P.planFromRaw(P.encodePlan({ mode: 'read', direction: 90, speed: 0, jump: 0, reaction: 0.05 }));
  assert.equal(read.mode, 'read');
  assert.ok(Math.abs(read.reaction - 0.05) < 1e-4);
});

test('previewKeeper replays the plan the simulation would play without a ball', () => {
  const plan = P.planFromRaw(P.encodePlan({ mode: 'dive', direction: 8, speed: 4.5, jump: 1, reaction: 0.05 }));
  const poses = P.previewKeeper(plan, 0.6);
  assert.equal(poses[0].pos.x, 0);
  assert.ok(poses[poses.length - 1].pos.x > 1, 'dives to the taker\'s right');
});

test('the misread is seeded, and larger the earlier the keeper acts', () => {
  const seed = P.roundBytesFromSeed(4, 0).slice(8);
  assert.deepEqual(P.keeperMisread(seed), P.keeperMisread(Uint8Array.from(seed)));
  assert.equal(P.keeperMisread(undefined), null);
  const plan = (mode, reaction) => P.planFromRaw(P.encodePlan({ mode, direction: 8, speed: 4, jump: 1, reaction }));
  const early = P.misreadSigmas(plan('dive', 0.02));
  const late = P.misreadSigmas(plan('dive', 0.12));
  assert.ok(early.vx > 3 * late.vx && early.jump > 3 * late.jump && late.vx > 0);
  const rEarly = P.misreadSigmas(plan('read', 0.02));
  const rLate = P.misreadSigmas(plan('read', 0.12));
  assert.ok(rEarly.x > 3 * rLate.x && rLate.x > 0);
  // Over many seeds the dive actually lands off by about the stated spread.
  const lv = P.keeperLaunchVelocity(plan('dive', 0.02));
  let ss = 0;
  const N = 400;
  for (let i = 0; i < N; i++) {
    const s = P.simulateShot({ ...shot(-2, 1), seed: P.roundBytesFromSeed(9, i).slice(8) }, plan('dive', 0.02));
    ss += (s.result.keeper.commits[0].vx - lv.x) ** 2;
  }
  assert.ok(Math.abs(Math.sqrt(ss / N) - early.vx) < 0.15 * early.vx);
});

test('a perfect read reproduces the keeper without misreads', () => {
  const input = { ...shot(1.5, 1.2), seed: seed24(3) };
  const a = P.simulateShot(input, DIVE_LEFT, { misread: false });
  const b = P.simulateShot({ ...input, seed: undefined }, DIVE_LEFT);
  assert.deepEqual(a.result.keeper.commits, b.result.keeper.commits.map((c) => c));
});

test('a keeper with time pounces on a loose ball; one without it does not', () => {
  // Find fuzzed rebounds the rule decides, and check each one's conditions.
  let found = 0;
  for (let i = 0; i < 4000 && found < 5; i++) {
    const b = P.roundBytesFromSeed(21, i);
    const s = P.simulateShot(P.decodeTakerShot(b).input, P.decodePlan(P.roundBytesFromSeed(22, i)));
    if (!/pounces/.test(s.result.detail)) continue;
    found++;
    assert.equal(s.result.outcome, 'save');
    assert.ok(s.result.touch || s.result.woodwork, 'only a loose ball, after a touch or the woodwork');
    const at = s.frames.find((f) => f.t >= s.result.decidedAt);
    const end = s.frames[s.frames.length - 1];
    assert.deepEqual(end.b, at.b, 'the ball stays where it was smothered');
    const k = at.k.pos;
    assert.ok(Math.hypot(at.b[0] - k.x, at.b[1] - k.y, at.b[2] - k.z) < P.KEEPER.POUNCE_REACH + 0.1);
  }
  assert.ok(found >= 3, `only ${found} pounces found`);
});
