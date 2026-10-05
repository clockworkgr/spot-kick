// Rendering and input. All outcomes come from physics.js: when the ball is
// struck the whole shot is simulated up front, and this file only replays the
// recorded frames. three.js is used purely for drawing, and the body animation
// in animation.js is cosmetic: it never feeds back into the simulation.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import * as P from './physics.js?v=21';
import { buildWorld, addHitbox, hitboxes, capsuleGeometry, placeSegment } from './scene.js';
import { Humanoid } from './rig.js?v=4';
import { keeperPose, takerPose, createCatchAnimation, createKeeperAnimation, RUNUP } from './animation.js?v=21';
import * as KP from './keeperplan.js?v=21';
import * as SO from './shootout.js?v=21';
import * as CP from './chainplay.js?v=21';
import * as C from './chain.js?v=21';
import { initLobby, showLobby, hideLobby, toast, txStatus, refreshBalance } from './lobby.js?v=21';

const { BALL, GOAL, NET, KICK, SIM } = P;

const $ = (id) => document.getElementById(id);
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const lerp = (a, b, t) => a + (b - a) * t;
const DEG = 180 / Math.PI;
const Y_AXIS = new THREE.Vector3(0, 1, 0);

// ------------------------------------------------------------------ renderer

const canvas = $('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(46, 1, 0.1, 400);

// Bloom makes floodlights, LED boards and flashes glow; OutputPass applies
// tone mapping and colour-space conversion at the end of the chain.
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
// Threshold sits above anything merely lit, so only HDR emitters glow.
const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.6, 0.5, 2.0);
composer.addPass(bloom);
composer.addPass(new OutputPass());

function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h, false);
  composer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  composer.setSize(w, h);
  camera.aspect = w / h;
  // Keep the whole goal in frame on narrow screens.
  camera.fov = w / h < 1 ? 64 : 46;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

const world = buildWorld(scene, renderer);
const { ball, updateNet } = world;

// ------------------------------------------------------------------- players

const keeperRig = new Humanoid({
  scale: P.KEEPER.SCALE,
  kit: {
    shirt: 0x12b39b, sleeve: 0x0c7f70, longSleeves: true, shorts: 0x15171c, socks: 0x12b39b,
    boots: 0x16181d, skin: 0xc58c62, hair: 0x2a1a10, gloves: 0xf2f5f8, gloveStrap: 0x12b39b,
    number: '1', numberColor: '#15171c',
  },
});
const takerRig = new Humanoid({
  scale: 1,
  kit: {
    shirt: 0xf2f4f8, sleeve: 0x1d3f8f, longSleeves: false, shorts: 0x1d3f8f, socks: 0xf2f4f8,
    boots: 0xff2e7a, skin: 0xe0ac85, hair: 0x5a3a20, number: '10', numberColor: '#1d3f8f',
  },
});
scene.add(keeperRig.group, takerRig.group);

// The keeper's true collision shapes, shown with the Hitboxes toggle.
const keeperHitboxes = P.keeperCapsules(P.keeperPose(P.keeperInitialState())).map((c) => {
  const g = new THREE.Group();
  addHitbox(g, capsuleGeometry({ ...c, r: c.hit })); // collision size, not body size
  scene.add(g);
  return g;
});
function poseKeeperHitboxes(pose) {
  P.keeperCapsules(pose).forEach((c, i) => placeSegment(keeperHitboxes[i], c.a, c.b));
}

// Aim reticle on the goal plane.
const reticle = new THREE.Group();
{
  const m = new THREE.MeshBasicMaterial({ color: 0xc6ff3d, transparent: true, opacity: 0.9, depthTest: false });
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.17, 0.21, 40), m);
  const dot = new THREE.Mesh(new THREE.CircleGeometry(0.035, 16), m);
  const bars = [[0.3, 0], [-0.3, 0], [0, 0.3], [0, -0.3]].map(([x, y]) => {
    const b = new THREE.Mesh(new THREE.PlaneGeometry(x ? 0.14 : 0.03, x ? 0.03 : 0.14), m);
    b.position.set(x, y, 0);
    return b;
  });
  reticle.add(ring, dot, ...bars);
  reticle.renderOrder = 20;
  reticle.children.forEach((c) => (c.renderOrder = 20));
}
scene.add(reticle);

// Flight paths: dashed preview (empty goal) and the actual path after a shot.
function makePathLine(color, dashed) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(4000 * 3), 3));
  geo.setDrawRange(0, 0);
  const mat = dashed
    ? new THREE.LineDashedMaterial({ color, dashSize: 0.25, gapSize: 0.18, transparent: true, opacity: 0.85 })
    : new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9 });
  const line = new THREE.Line(geo, mat);
  line.frustumCulled = false;
  line.visible = false;
  scene.add(line);
  return line;
}
const previewLine = makePathLine(0x4dd2ff, true);
const pathLine = makePathLine(0xc6ff3d, false);

function setPath(line, frames) {
  const arr = line.geometry.attributes.position.array;
  const n = Math.min(frames.length, arr.length / 3);
  for (let i = 0; i < n; i++) arr.set(frames[i].b, i * 3);
  line.geometry.attributes.position.needsUpdate = true;
  line.geometry.setDrawRange(0, n);
  line.geometry.computeBoundingSphere();
  if (line.material.isLineDashedMaterial) line.computeLineDistances();
}

const markers = new THREE.Group();
scene.add(markers);
function setMarkers(events) {
  markers.clear();
  const colors = { keeper: 0xff9a3d, woodwork: 0x4dd2ff, goal: 0xc6ff3d };
  for (const e of events) {
    if (!colors[e.type] || !e.pos) continue;
    const m = new THREE.Mesh(
      new THREE.SphereGeometry(0.05, 12, 8),
      new THREE.MeshBasicMaterial({ color: colors[e.type], depthTest: false }),
    );
    m.renderOrder = 15;
    m.position.set(e.pos.x, e.pos.y, e.pos.z);
    markers.add(m);
  }
}

// Keeper planning: a translucent keeper at the moment its plan covers the
// chosen spot best, and the paths of both gloves through the dive.
const ghost = new THREE.Group();
ghost.visible = false;
scene.add(ghost);
const ghostMat = new THREE.MeshBasicMaterial({
  color: 0x4dd2ff, transparent: true, opacity: 0.28, depthWrite: false, toneMapped: false,
});
const ghostParts = P.keeperCapsules(P.keeperPose(P.keeperInitialState())).map(() => {
  const m = new THREE.Mesh(new THREE.BufferGeometry(), ghostMat);
  m.renderOrder = 12;
  ghost.add(m);
  return m;
});
const gloveTrails = [makePathLine(0x4dd2ff, true), makePathLine(0x4dd2ff, true)];
gloveTrails.forEach((l) => scene.remove(l) || ghost.add(l));

function showGhost(plan, at) {
  const poses = P.previewKeeper(plan, KP.WINDOW[1] + 0.1);
  const trails = [[], []];
  for (const pose of poses) {
    if (pose.t < plan.reaction) continue;
    P.keeperCapsules(pose).filter((c) => c.kind === 'glove').forEach((c, i) => trails[i].push({ b: [c.a.x, c.a.y, c.a.z] }));
  }
  trails.forEach((t, i) => setPath(gloveTrails[i], t));
  const pose = poses.reduce((a, b) => (Math.abs(b.t - at) < Math.abs(a.t - at) ? b : a));
  P.keeperCapsules(pose).forEach((c, i) => {
    const m = ghostParts[i];
    m.geometry.dispose();
    m.geometry = capsuleGeometry(c);
    placeSegment(m, c.a, c.b);
  });
}

// ---------------------------------------------------------------- game state

const params = new URLSearchParams(location.search);
// ?seed=N makes every round's bytes reproducible; otherwise they come from
// the browser's cryptographic random source.
const fixedSeed = params.has('seed') ? parseInt(params.get('seed'), 10) >>> 0 : null;
// Practice's margin (?winBy=1..3), as a game's creator would choose it.
const practiceWinBy = [1, 2, 3].includes(Number(params.get('winBy'))) ? Number(params.get('winBy')) : SO.DEFAULT_WIN_BY;

const POWER_SWEEP = 0.85; // seconds for the meter to go 0 -> 100%

// One shootout at a time; the player shoots and then keeps in every round.
// Each kick gets its own 32 round bytes: on the player's kicks they are the
// computer's keeper plan and the player's mishit seed, on the computer's
// kicks they are its whole kick (picked from its mix, src/chainplay.js), as on chain.
const game = {
  mode: 'practice',   // 'practice' (offline, sealed local bytes) | 'chain' (a realm game)
  chain: null,        // chain mode: { game, session, after } (after = session once the kick lands)
  kick: 0,            // live kicks so far this session (indexes ?seed= bytes)
  shootoutNo: 1,
  shootout: SO.createShootout(practiceWinBy),
  outcomes: { player: [], cpu: [] }, // 'goal' | 'save' | 'miss' | 'post' per kick
  side: 'player',     // who kicks now: 'player' (you shoot) | 'cpu' (you keep)
  bytes: null, commit: '',
  plan: null, strikeSeed: null, // your kicks
  cpu: null,                    // its kicks: { input, ints }
};
// Your keeper plan while the computer's kick waits, sealed.
const keep = { mode: 'guess', target: { x: 1.9, y: 0.7 }, locked: false, reaction: 0.06, solved: null, key: '' };
// What the taker's body shows before a sealed kick: nothing about its aim.
const NEUTRAL_LAUNCH = P.computeLaunch({ aim: { x: 0, y: 1.1 }, contact: { x: 0, y: -0.15 }, power: 0.75 });
const aim = { x: 1.6, y: 1.1 };
const contact = { x: 0, y: -0.15 };
const toggles = { hitboxes: false, preview: false };
let power = 0;
let charging = false;
let chargeStart = 0;
let state = 'lobby'; // lobby | aim | plan | pending | kicking | flight | result
let shot = null;
let kickT = 0;
let playT = 0;
let playSpeed = 1;
let camMode = 'taker';
let isReplay = false;
let bannerShown = false;

// ------------------------------------------------------------------ modes

function startPractice() {
  hideLobby();
  game.mode = 'practice';
  game.chain = null;
  game.shootout = SO.createShootout(practiceWinBy);
  game.outcomes = { player: [], cpu: [] };
  $('match').hidden = false;
  $('match-title').innerHTML = 'Practice · <b>offline</b>';
  newRound();
}

// The scoreboard's view of a chain session.
const chainOutcome = (o) => (o === 'woodwork' ? 'post' : o);

// An ended shootout keeps only its score on chain (impl/v2 clears its kicks,
// refunding their storage): the page shows it with the kicks it saw played.
function settledView(s, kicks) {
  if (!s || s.status === 'playing' || s.kicks.length) return s;
  return { ...s, kicks };
}
function syncFromSession(s) {
  game.shootout = SO.createShootout(game.chain?.winBy ?? 1);
  game.outcomes = { player: [], cpu: [] };
  for (const k of s.kicks) {
    const side = k.kicker === 'player' ? 'player' : 'cpu';
    game.shootout[side].push(k.result.outcome === 'goal');
    game.outcomes[side].push(chainOutcome(k.result.outcome));
  }
}

function startChain(g, s) {
  hideLobby();
  game.mode = 'chain';
  game.chain = { game: g, session: s, after: null, winBy: g.winBy ?? 1 };
  syncFromSession(s);
  $('match').hidden = false;
  renderMatch();
  newRound();
}

function renderMatch() {
  const { game: g, session: s } = game.chain;
  $('match-title').innerHTML = `Game <b>#${g.id}</b> · pot <b>${C.gnot(g.pot)}</b> · challenger ${s.no}`;
}

function backToLobby() {
  if (state === 'pending') return;
  state = 'lobby';
  shot = null;
  charging = false;
  reticle.visible = false;
  ghost.visible = false;
  previewLine.visible = false;
  $('report').hidden = true;
  hideBanner();
  showLobby();
}

function newRound() {
  if (game.mode === 'chain') return newChainRound();
  if (SO.winner(game.shootout)) {
    game.shootout = SO.createShootout(practiceWinBy);
    game.outcomes = { player: [], cpu: [] };
    game.shootoutNo++;
  }
  game.side = SO.nextSide(game.shootout);
  // All of the kick's randomness: the computer's move (picked by bytes 0-1,
  // as the chain picks its own) and a 24-byte mishit seed.
  game.bytes = fixedSeed != null
    ? P.roundBytesFromSeed(fixedSeed, game.kick)
    : crypto.getRandomValues(new Uint8Array(P.ROUND_BYTES));
  game.commit = P.commitHash(game.bytes);
  const pill = $('commit');
  pill.classList.remove('revealed');
  if (game.side === 'player') {
    ({ plan: game.plan, strikeSeed: game.strikeSeed } = CP.keeperFromBytes(game.bytes));
    game.cpu = null;
    pill.innerHTML = `<span class="dot"></span>Keeper's plan and your mishit are sealed · <code>#${game.commit}</code>`;
  } else {
    game.cpu = CP.kickFromBytes(game.bytes);
    game.plan = null;
    game.strikeSeed = null;
    pill.innerHTML = `<span class="dot"></span>The computer's kick is sealed · <code>#${game.commit}</code>`;
  }
  resetForKick();
}

// The chain decides the next kick when it lands: nothing is sealed up front.
function newChainRound() {
  const s = game.chain.session;
  if (s.status !== 'playing') return backToLobby();
  game.side = s.next === 'shoot' ? 'player' : 'cpu';
  game.plan = null;
  game.cpu = null;
  game.strikeSeed = null;
  const pill = $('commit');
  pill.classList.remove('revealed');
  pill.innerHTML = `<span class="dot"></span>${game.side === 'player' ? "The chain's keeper and your mishit come" : "The chain's kick comes"} from the block your move lands in · seed = SHA-256(block time)`;
  resetForKick();
}

function resetForKick() {
  state = game.side === 'player' ? 'aim' : 'plan';
  shot = null;
  power = 0;
  charging = false;
  camMode = game.side === 'player' ? 'taker' : 'keeper';
  keep.locked = false;
  keep.key = '';
  ball.position.set(0, BALL.R, 0);
  ball.quaternion.identity();
  keeperK = P.keeperPose(P.keeperInitialState());
  poseKeeperHitboxes(keeperK);
  updateNet(ball.position, false);
  excitement = 0;
  reticle.visible = true;
  reticle.scale.setScalar(1);
  pathLine.visible = false;
  markers.clear();
  $('report').hidden = true;
  $('dock').style.visibility = 'visible';
  $('dock').classList.remove('waiting');
  $('shoot-cards').hidden = game.side !== 'player';
  $('keeper-card').hidden = game.side === 'player';
  document.body.dataset.side = game.side;
  hideBanner();
  renderScore();
  drawPicker();
  lastPreviewKey = '';
}

function renderScore() {
  const so = game.shootout;
  const sc = SO.score(so);
  const n = Math.max(SO.REGULATION, so.player.length, so.cpu.length + (state === 'plan' ? 1 : 0));
  const live = !SO.winner(so) && (state === 'aim' || state === 'plan' || state === 'pending');
  const dots = (side) => Array.from({ length: n }, (_, i) => {
    const k = game.outcomes[side][i];
    const cls = k ?? (live && side === game.side && i === so[side].length ? 'next' : '');
    return `<i class="${cls}${i >= SO.REGULATION ? ' sd' : ''}"></i>`;
  }).join('');
  $('dots-player').innerHTML = dots('player');
  $('dots-cpu').innerHTML = dots('cpu');
  $('score-player').textContent = sc.player;
  $('score-cpu').textContent = sc.cpu;
  const label = game.mode === 'chain' ? `Game <b>#${game.chain.game.id}</b>` : `Shootout <b>${game.shootoutNo}</b>`;
  const stage = SO.winner(so) ? 'Final' : SO.suddenDeath(so) ? 'Sudden death'
    : `Round <b>${Math.min(SO.round(so), SO.REGULATION)}</b>${so.winBy > 1 ? ` · win by ${so.winBy}` : ''}`;
  $('round-label').innerHTML = `${label} · ${stage}`;
  const w = SO.winner(so);
  $('turn').className = w ? `over ${w}` : game.side;
  const cpu = game.mode === 'chain' ? 'Chain' : 'CPU';
  document.querySelector('#dots-cpu').previousElementSibling.textContent = cpu;
  $('turn').textContent = w ? (w === 'player' ? 'You win!' : `${cpu} wins`) : game.side === 'player' ? 'You shoot' : 'You keep';
}
// --------------------------------------------------------------------- input

const shotInput = (p = power) => ({ aim: { ...aim }, contact: { ...contact }, power: p });

function startCharge() {
  if (state !== 'aim' || charging) return;
  charging = true;
  chargeStart = performance.now();
}

function releaseCharge() {
  if (!charging) return;
  charging = false;
  shoot();
}

function shoot() {
  if (game.mode === 'chain') return chainMove();
  strike({ ...shotInput(), seed: game.strikeSeed }, game.plan);
}

// ------------------------------------------------------------- chain moves

// Your shot in the realm's integer units: mm, milli-radii, per-mille.
function shotInts() {
  const r = Math.hypot(contact.x, contact.y);
  const k = r > KICK.MAX_CONTACT ? KICK.MAX_CONTACT / r : 1;
  return {
    aimX: Math.round(clamp(aim.x, -6, 6) * 1000),
    aimY: Math.round(clamp(aim.y, 0, 4) * 1000),
    contactX: Math.trunc(contact.x * k * 1000),
    contactY: Math.trunc(contact.y * k * 1000),
    power: Math.round(clamp(power, 0, 1) * 1000),
  };
}

// Sends your move; the chain settles the kick in that block and returns it,
// and the 3-D replay plays the same ten inputs through the browser engine.
async function chainMove() {
  const shooting = game.side === 'player';
  const prev = state;
  state = 'pending';
  charging = false;
  $('dock').classList.add('waiting');
  const id = game.chain.game.id;
  try {
    // Catch up first if a move landed that this page did not see through
    // (only forwards: a node behind the others can answer with older books).
    const fresh = await C.getSession(id, game.chain.session.no);
    const seen = game.chain.session.kicks.length;
    if (fresh && (fresh.kicks.length > seen || fresh.status !== 'playing')) {
      game.chain.session = settledView(fresh, game.chain.session.kicks);
      syncFromSession(game.chain.session);
      renderScore();
      $('dock').classList.remove('waiting');
      toast('Your previous move had already landed on chain: caught up with it.', 'info', 5000);
      state = prev;
      newRound();
      return;
    }
    const at = { no: game.chain.session.no, kicks: game.chain.session.kicks.length };
    const kick = shooting
      ? await C.takeShot(id, shotInts(), txStatus('Your kick'), at)
      : await C.submitKeeperPlan(id, keep.solved.raw, txStatus('Your keeper plan'), at);
    toast(`In block ${kick.height.toLocaleString()} · seed ${kick.seed.slice(0, 10)}…`, 'good', 2500);
    // The books as of the kick's block (not whatever a lagging node holds).
    const atKick = { height: kick.height };
    const [g, s] = await Promise.all([C.getGame(id, atKick), C.getSession(id, game.chain.session.no, atKick)]);
    game.chain.after = { game: g, session: settledView(s, [...game.chain.session.kicks, kick]) };
    const sh = kick.shot;
    const input = {
      aim: { x: sh.aimX / 1000, y: sh.aimY / 1000 },
      contact: { x: sh.contactX / 1000, y: sh.contactY / 1000 },
      power: sh.power / 1000,
      seed: C.hexToBytes(kick.mishit),
    };
    const pl = kick.plan;
    const plan = P.planFromRaw([pl.direction, pl.speed, pl.jump, pl.reaction]);
    if (!shooting) game.cpu = { input, ints: { ...sh } };
    $('dock').classList.remove('waiting');
    strike(input, plan, kick);
    refreshBalance();
  } catch (e) {
    toast(String(e.message).replace(/</g, '&lt;'), 'bad', 8000);
    $('dock').classList.remove('waiting');
    state = prev;
    // The move may have landed even if waiting for it failed.
    C.getSession(id, game.chain.session.no).then((s) => {
      if (s && (s.kicks.length > game.chain.session.kicks.length || s.status !== 'playing')) {
        game.chain.session = settledView(s, game.chain.session.kicks);
        syncFromSession(game.chain.session);
        newRound();
      }
    }).catch(() => {});
  }
}

// ------------------------------------------------------------- keeper plan

function setKeepMode(mode) {
  keep.mode = mode;
  document.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
  keep.key = '';
}
function setReaction(r) {
  keep.reaction = clamp(r, P.PLAN.REACTION_MIN, P.PLAN.REACTION_MAX);
  $('reaction').value = Math.round(keep.reaction * 1000);
  keep.key = '';
}

// Re-solves the plan when the target, mode or reaction changed.
function updateKeeperPlan() {
  const key = [keep.mode, keep.reaction, keep.target.x.toFixed(3), keep.target.y.toFixed(3)].join();
  if (key === keep.key) return;
  keep.key = key;
  keep.solved = keep.mode === 'read' ? KP.readPlan(keep.reaction) : KP.solvePlan(keep.target, keep.reaction);
  const { plan, raw, miss, cover, at } = keep.solved;
  $('reaction-value').textContent = `${Math.round(plan.reaction * 1000)} ms`;
  let what;
  if (keep.mode === 'read') {
    what = `Stays set, then dives at where it expects the ball <b>${P.planCommitTime(plan).toFixed(2)} s</b> after contact. ` +
      'Beaten by pace and fooled by curl.';
  } else {
    const lv = P.keeperLaunchVelocity(plan);
    const side = lv.x > 0.3 ? 'right' : lv.x < -0.3 ? 'left' : null;
    const move = plan.mode === 'star'
      ? (Math.abs(lv.x) < 0.2 ? 'Set in the middle' : `Shuffle ${side}`)
      : `Dive ${side} <b>${plan.speed.toFixed(1)} m/s</b>`;
    const height = plan.jump < -0.3 ? 'collapse low' : plan.jump < 1.2 ? 'stay low' : plan.jump < 2.6 ? 'mid-height spring' : 'high spring';
    what = `${move}, ${height} (<b>${plan.jump.toFixed(1)}</b> m/s up), ${Math.round(plan.reaction * 1000)} ms after contact. ` +
      (miss > 0.005 ? `<span class="warn">Can't reach it: ${Math.round(miss * 100)} cm short.</span>`
        : `Covers it for <b>${cover.toFixed(2)} s</b> of the usual arrival window.`);
  }
  // The misread: drawn when the kick is struck, wider the earlier you go.
  const sg = P.misreadSigmas(plan);
  const err = keep.mode === 'read'
    ? `misreads the line by ±<b>${Math.round(sg.x * 100)}</b> cm across, ±<b>${Math.round(sg.y * 100)}</b> cm in height`
    : `dive off by ±<b>${sg.vx.toFixed(2)}</b> m/s across, ±<b>${sg.jump.toFixed(2)}</b> m/s in the jump`;
  $('keep-readout').innerHTML = `${what}<br><span class="misread">Going at ${Math.round(plan.reaction * 1000)} ms: ${err} (1σ).</span>` +
    `<br><span class="raw">u16 ${raw.join(' · ')}</span>`;
  if (keep.mode === 'guess') showGhost(plan, at); // where it covers the spot, or comes closest
}

function keeperReady() {
  if (state !== 'plan') return;
  updateKeeperPlan();
  if (game.mode === 'chain') return chainMove();
  ghost.visible = false;
  strike(game.cpu.input, keep.solved.plan);
}

function strike(input, plan, chainKick = null) {
  const t0 = performance.now();
  const sim = P.simulateShot(input, plan);
  const ms = performance.now() - t0;
  const again = P.simulateShot(structuredClone(input), structuredClone(plan));
  shot = {
    side: game.side, input, sim, ms, verified: again.hash === sim.hash, chain: chainKick,
    catchAnimation: createCatchAnimation(sim), keeperAnimation: createKeeperAnimation(sim),
  };
  state = 'kicking';
  kickT = 0;
  playSpeed = 1;
  isReplay = false;
  bannerShown = false;
  reticle.visible = false;
  ghost.visible = false;
  previewLine.visible = false;
  $('dock').style.visibility = 'hidden';
  setPath(pathLine, sim.frames);
  renderScore();
  drawPicker();
}

const ray = new THREE.Raycaster();
const ndc = new THREE.Vector2();
const goalPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -GOAL.Z);
const hit = new THREE.Vector3();

// Where you aim, or (keeping) the spot your keeper should cover.
const TARGET_X = GOAL.HW + 0.1;
const TARGET_Y = GOAL.H + 0.05;
function aimFromPointer(e, lock = false) {
  if (state !== 'aim' && !(state === 'plan' && (lock || !keep.locked))) return;
  const r = canvas.getBoundingClientRect();
  ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  if (!ray.ray.intersectPlane(goalPlane, hit)) return;
  if (state === 'aim') {
    aim.x = clamp(hit.x, -KICK.AIM_X, KICK.AIM_X);
    aim.y = clamp(hit.y, 0, KICK.AIM_Y);
  } else {
    keep.target.x = clamp(hit.x, -TARGET_X, TARGET_X);
    keep.target.y = clamp(hit.y, BALL.R, TARGET_Y);
    if (lock) keep.locked = true;
  }
}

canvas.addEventListener('pointermove', (e) => aimFromPointer(e));
canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  if (state === 'plan') {
    if (keep.mode !== 'guess') setKeepMode('guess');
    aimFromPointer(e, true);
    return;
  }
  aimFromPointer(e);
  canvas.setPointerCapture(e.pointerId);
  startCharge();
});
canvas.addEventListener('pointerup', releaseCharge);
canvas.addEventListener('pointercancel', () => (charging = false));

const held = new Set();
window.addEventListener('keydown', (e) => {
  // Space/Enter would otherwise also "click" whichever HUD button has focus.
  if (state === 'lobby' || document.querySelector('dialog[open]')) return;
  if (e.code === 'Space' || e.code === 'Enter') e.preventDefault();
  if (e.code === 'Escape' && !e.repeat) return backToLobby();
  if (state === 'plan' && !e.repeat) {
    if (e.code === 'Space' || e.code === 'Enter') return keeperReady();
    if (e.code === 'Digit1') return setKeepMode('guess');
    if (e.code === 'Digit2') return setKeepMode('read');
    if (e.code === 'KeyL') return void (keep.locked = !keep.locked);
  }
  if (e.code === 'Space') {
    if (!e.repeat) startCharge();
    return;
  }
  if (e.repeat) {
    held.add(e.code);
    return;
  }
  held.add(e.code);
  if (e.code === 'Enter' && (state === 'result' || (isReplay && state !== 'plan'))) newRound();
  else if (e.code === 'KeyR' && (state === 'result' || state === 'flight') && shot) replay('goal');
  else if (e.code === 'KeyH') toggle('hitboxes');
  else if (e.code === 'KeyP') toggle('preview');
  if (e.code.startsWith('Arrow')) e.preventDefault();
});
window.addEventListener('keyup', (e) => {
  held.delete(e.code);
  if (e.code === 'Space' && state !== 'lobby') e.preventDefault(); // no click on a focused button
  if (e.code === 'Space') releaseCharge();
});
window.addEventListener('blur', () => {
  held.clear();
  charging = false;
});

function handleHeldKeys(dt) {
  if (state === 'plan') {
    const a = 2.5 * dt;
    const t = keep.target;
    const was = `${t.x},${t.y}`;
    if (held.has('ArrowLeft')) t.x -= a;
    if (held.has('ArrowRight')) t.x += a;
    if (held.has('ArrowUp')) t.y += a;
    if (held.has('ArrowDown')) t.y -= a;
    t.x = clamp(t.x, -TARGET_X, TARGET_X);
    t.y = clamp(t.y, BALL.R, TARGET_Y);
    if (`${t.x},${t.y}` !== was) {
      keep.locked = true;
      if (keep.mode !== 'guess') setKeepMode('guess');
    }
    const r = 0.08 * dt;
    if (held.has('KeyQ')) setReaction(keep.reaction - r);
    if (held.has('KeyE')) setReaction(keep.reaction + r);
    return;
  }
  if (state !== 'aim') return;
  const a = 2.5 * dt;
  const c = 0.9 * dt;
  if (held.has('ArrowLeft')) aim.x -= a;
  if (held.has('ArrowRight')) aim.x += a;
  if (held.has('ArrowUp')) aim.y += a;
  if (held.has('ArrowDown')) aim.y -= a;
  aim.x = clamp(aim.x, -KICK.AIM_X, KICK.AIM_X);
  aim.y = clamp(aim.y, 0, KICK.AIM_Y);
  let moved = false;
  if (held.has('KeyA')) (contact.x -= c), (moved = true);
  if (held.has('KeyD')) (contact.x += c), (moved = true);
  if (held.has('KeyW')) (contact.y += c), (moved = true);
  if (held.has('KeyS')) (contact.y -= c), (moved = true);
  if (moved) setContact(contact.x, contact.y);
}

function toggle(name) {
  toggles[name] = !toggles[name];
  document.querySelector(`[data-toggle="${name}"]`).classList.toggle('on', toggles[name]);
  if (name === 'hitboxes') hitboxes.forEach((h) => (h.visible = toggles.hitboxes));
  if (name === 'preview') lastPreviewKey = '';
}
const onClick = (el, fn) => el.addEventListener('click', () => {
  el.blur();
  fn();
});
document.querySelectorAll('[data-toggle]').forEach((b) => onClick(b, () => toggle(b.dataset.toggle)));
document.querySelectorAll('[data-replay]').forEach((b) => onClick(b, () => replay(b.dataset.replay)));
onClick($('next'), newRound);
onClick($('ready'), () => keeperReady());
document.querySelectorAll('[data-mode]').forEach((b) => onClick(b, () => setKeepMode(b.dataset.mode)));
$('reaction').addEventListener('input', (e) => setReaction(Number(e.target.value) / 1000));

// ------------------------------------------------------------ contact picker

const picker = $('picker');
const pctx = picker.getContext('2d');
{
  const dpr = Math.min(window.devicePixelRatio, 2);
  picker.width = 150 * dpr;
  picker.height = 150 * dpr;
}

function setContact(x, y) {
  const r = Math.hypot(x, y);
  const m = KICK.MAX_CONTACT;
  contact.x = r > m ? (x / r) * m : x;
  contact.y = r > m ? (y / r) * m : y;
  drawPicker();
}

// The widget is a zoomed lens on the centre of the ball: its dashed ring is
// the selectable range (KICK.MAX_CONTACT) and the outer edge ~1.25x that.
const PICKER_VIEW = KICK.MAX_CONTACT * 1.25; // ball radii shown from centre to edge of the lens
const pickerPxPerR = (size) => (size * 0.46) / PICKER_VIEW;

function pickerEvent(e) {
  const r = picker.getBoundingClientRect();
  const k = pickerPxPerR(r.width);
  setContact((e.clientX - r.left - r.width / 2) / k, -(e.clientY - r.top - r.height / 2) / k);
}
picker.addEventListener('pointerdown', (e) => {
  picker.setPointerCapture(e.pointerId);
  pickerEvent(e);
});
picker.addEventListener('pointermove', (e) => {
  if (e.buttons) pickerEvent(e);
});

function drawPicker() {
  const s = picker.width;
  const c = s / 2;
  const u = s / 150;
  const k = pickerPxPerR(s);
  const lens = s * 0.46;
  const g = pctx;
  g.clearRect(0, 0, s, s);
  g.save();
  g.beginPath();
  g.arc(c, c, lens, 0, Math.PI * 2);
  g.clip();
  // Shade as the middle of a much larger sphere.
  const grd = g.createRadialGradient(c - k * 0.35, c - k * 0.4, 0, c, c, k);
  grd.addColorStop(0, '#ffffff');
  grd.addColorStop(1, '#8e98ab');
  g.fillStyle = grd;
  g.fillRect(0, 0, s, s);
  g.strokeStyle = 'rgba(10,16,30,0.18)';
  g.lineWidth = u;
  for (let r = 0.1; r < PICKER_VIEW; r += 0.1) {
    g.beginPath();
    g.arc(c, c, r * k, 0, Math.PI * 2);
    g.stroke();
  }
  g.strokeStyle = 'rgba(10,16,30,0.3)';
  g.beginPath();
  g.moveTo(0, c);
  g.lineTo(s, c);
  g.moveTo(c, 0);
  g.lineTo(c, s);
  g.stroke();
  g.strokeStyle = 'rgba(10,16,30,0.55)';
  g.setLineDash([4 * u, 4 * u]);
  g.beginPath();
  g.arc(c, c, KICK.MAX_CONTACT * k, 0, Math.PI * 2);
  g.stroke();
  g.setLineDash([]);
  g.restore();
  g.strokeStyle = 'rgba(255,255,255,0.25)';
  g.lineWidth = u;
  g.beginPath();
  g.arc(c, c, lens, 0, Math.PI * 2);
  g.stroke();

  const dot = (p, fill) => {
    g.beginPath();
    g.arc(c + p.x * k, c - p.y * k, 6.5 * u, 0, Math.PI * 2);
    g.lineWidth = 2 * u;
    g.strokeStyle = fill ? '#fff' : '#ffb03d';
    if (fill) {
      g.fillStyle = '#ff2e7a';
      g.fill();
    }
    g.stroke();
  };
  // After a shot, also show where the boot actually landed.
  if (shot && state !== 'aim') {
    const a = shot.sim.launch.contact;
    g.strokeStyle = 'rgba(255,176,61,0.8)';
    g.lineWidth = 1.5 * u;
    g.beginPath();
    g.moveTo(c + contact.x * k, c - contact.y * k);
    g.lineTo(c + a.x * k, c - a.y * k);
    g.stroke();
    dot(a, false);
  }
  dot(contact, true);
  updateContactReadout();
}

function spinParts(launch) {
  const rpm = (w) => Math.round(Math.abs(w) * 60 / (2 * Math.PI));
  // +y spin curls the ball left (Magnus: w x v with v towards -z).
  const side = launch.spin.y;
  const right = new THREE.Vector3(launch.footDir.x, launch.footDir.y, launch.footDir.z).cross(Y_AXIS).normalize();
  const back = launch.spin.x * right.x + launch.spin.y * right.y + launch.spin.z * right.z;
  return { side, back, sideRpm: rpm(side), backRpm: rpm(back) };
}

function launchAngles(L) {
  const h = Math.hypot(L.vel.x, L.vel.z);
  return { elev: Math.atan2(L.vel.y, h) * DEG, yaw: Math.atan2(L.vel.x, -L.vel.z) * DEG };
}

function updateContactReadout() {
  const L = P.computeLaunch(shotInput(charging ? power : 0.75));
  const s = spinParts(L);
  const { elev } = launchAngles(L);
  const curl = s.sideRpm < 15 ? 'no curl' : `curls ${s.side > 0 ? 'left' : 'right'} <b>${s.sideRpm}</b>`;
  const lift = s.backRpm < 15 ? 'no lift/dip' : `${s.back > 0 ? 'backspin' : 'topspin'} <b>${s.backRpm}</b>`;
  $('contact-readout').innerHTML =
    `lift <b>${elev.toFixed(1)}°</b> · eff <b>${Math.round(L.efficiency * 100)}%</b><br>${curl}<br>${lift} rpm`;
}

// ------------------------------------------------------------------- preview

let lastPreviewKey = '';
function updatePreview() {
  if (!toggles.preview || state !== 'aim') {
    previewLine.visible = false;
    return;
  }
  const p = charging ? power : 0.75;
  const key = [aim.x, aim.y, contact.x, contact.y, p].map((x) => x.toFixed(3)).join();
  if (key !== lastPreviewKey) {
    lastPreviewKey = key;
    setPath(previewLine, P.simulateShot(shotInput(p), null).frames);
  }
  previewLine.visible = true;
}

// ------------------------------------------------------------------ playback

const qa = new THREE.Quaternion();
const qb = new THREE.Quaternion();

function sampleFrame(frames, t) {
  const dtF = SIM.DT * SIM.RECORD_EVERY;
  const i = Math.floor(t / dtF);
  if (i >= frames.length - 1) return frames[frames.length - 1];
  const a = frames[Math.max(0, i)];
  const b = frames[Math.max(0, i) + 1];
  const u = clamp((t - a.t) / (b.t - a.t), 0, 1);
  qa.fromArray(a.q).slerp(qb.fromArray(b.q), u);
  const nl2 = (x, y) => {
    const s = lerp(x.s, y.s, u);
    const c = lerp(x.c, y.c, u);
    const l = Math.hypot(s, c);
    return { s: s / l, c: c / l };
  };
  const nl3 = (x, y) => {
    const v = new THREE.Vector3(lerp(x.x, y.x, u), lerp(x.y, y.y, u), lerp(x.z, y.z, u)).normalize();
    return { x: v.x, y: v.y, z: v.z };
  };
  return {
    t,
    b: a.b.map((x, k) => lerp(x, b.b[k], u)),
    q: qa.toArray(),
    k: a.k && {
      pos: { x: lerp(a.k.pos.x, b.k.pos.x, u), y: lerp(a.k.pos.y, b.k.pos.y, u), z: lerp(a.k.pos.z, b.k.pos.z, u) },
      lean: nl2(a.k.lean, b.k.lean),
      arms: { l: nl3(a.k.arms.l, b.k.arms.l), r: nl3(a.k.arms.r, b.k.arms.r) },
      plant: a.k.plant && b.k.plant && a.k.plant.side === b.k.plant.side ? a.k.plant : null,
      act: b.k.act && b.k.act.t0 <= t ? b.k.act : a.k.act,
    },
    inGoal: a.inGoal,
    held: a.held,
  };
}

function applyFrame(f) {
  ball.position.fromArray(f.b);
  ball.quaternion.fromArray(f.q);
  if (f.k) {
    keeperK = f.k;
    poseKeeperHitboxes(f.k);
  }
  updateNet(ball.position, f.inGoal);
}

// ---------------------------------------------------------------- bodies

let keeperK = P.keeperPose(P.keeperInitialState()); // the keeper's current physics pose
let excitement = 0;   // crowd energy after a goal, purely cosmetic

const currentLaunch = () => (shot ? shot.sim.launch
  : game.side === 'cpu' || state === 'lobby' ? NEUTRAL_LAUNCH : P.computeLaunch(shotInput(charging ? power : 0.75)));

// Seconds relative to contact for the body animation; null before the kick.
function animTime() {
  if (state === 'aim' || state === 'plan' || state === 'pending' || state === 'lobby') return null;
  if (state === 'kicking') return kickT - RUNUP;
  return playT;
}

function updateBodies(clock) {
  const t = animTime();
  const sim = shot && shot.sim;
  const frames = sim && sim.frames;
  const r = sim && sim.result;
  // Reactions to the outcome only start once it has happened on screen.
  const known = !!sim && t != null && t >= r.decidedAt;
  // After possession or simulation end, the display can protect the ball and
  // recover freely. Recorded collision shapes would then misrepresent it.
  const simOver = !!frames && t != null && t > frames[frames.length - 1].t;
  const catching=!!shot?.catchAnimation && t!=null && t>=shot.catchAnimation.t;
  for (const g of keeperHitboxes) g.children[0].visible = toggles.hitboxes && !simOver && !catching;
  // Keeper's sideways speed from the recorded frames, for footwork only.
  let kvx = 0;
  if (frames && t != null && t > 0.03) {
    const a = sampleFrame(frames, t - 0.03).k;
    const b = sampleFrame(frames, t).k;
    if (a && b) kvx = (b.pos.x - a.pos.x) / 0.03;
  }
  // Always sample the immutable recorded ball. The held-ball presentation is
  // derived afresh, so result idle and replay seeking cannot accumulate drift.
  const recorded=frames && t!=null && t>=0 ? sampleFrame(frames,t) : null;
  const sourceBall=recorded ? new THREE.Vector3().fromArray(recorded.b) : ball.position.clone();
  const keeperBody=keeperPose({
    k: keeperK, t, clock, kvx, ball: sourceBall, plan: sim ? sim.plan : game.plan,
    outcome: known ? r.outcome : null,
    endT: frames ? frames[frames.length - 1].t : null,
    endK: frames ? frames[frames.length - 1].k : null,
    catchState:shot?.catchAnimation,
    motionState:shot?.keeperAnimation,
  });
  keeperRig.setPose(keeperBody);
  if(keeperBody.ballPosition){
    ball.position.copy(keeperBody.ballPosition);
    ball.quaternion.fromArray(recorded.q).slerp(keeperBody.ballRotation,keeperBody.ballRotationWeight);
  }
  takerRig.setPose(takerPose({
    t, clock, launch: currentLaunch(), ball: ball.position,
    outcome: known ? r.outcome : null, decidedAt: r ? r.decidedAt : null, charging,
  }));
}

function replay(mode) {
  if (!shot) return;
  camMode = mode;
  playSpeed = mode === 'side' ? 0.3 : mode === 'follow' ? 0.5 : 0.6;
  isReplay = true;
  bannerShown = false;
  hideBanner();
  markers.clear();
  pathLine.visible = false;
  $('report').hidden = true;
  // Rewind to the last strides of the run-up so the strike is in the replay.
  applyFrame(shot.sim.frames[0]);
  kickT = RUNUP - 0.6;
  playT = 0;
  state = 'kicking';
}

// -------------------------------------------------------------------- camera

const AIM_CAM = new THREE.Vector3(0.3, 1.95, 5.6);
const camPos = AIM_CAM.clone();
const camLook = new THREE.Vector3(0, 1.0, GOAL.Z);
const wantPos = new THREE.Vector3();
const wantLook = new THREE.Vector3();

function updateCamera(dt) {
  const b = ball.position;
  // Wide or high shots fly into the stands; don't let the static cameras chase them.
  const bx = clamp(b.x, -4.5, 4.5);
  const by = clamp(b.y, 0, 3);
  if (state === 'lobby') {
    // A slow drift around the box while the lobby is up.
    const a = performance.now() / 1000 * 0.05;
    wantPos.set(Math.sin(a) * 9, 3.2 + Math.sin(a * 1.7) * 0.6, GOAL.Z + 9 + Math.cos(a) * 4);
    wantLook.set(0, 1.0, GOAL.Z);
  } else if (camMode === 'goal') {
    wantPos.set(1.4, 1.8, NET.BACK_Z - 5);
    wantLook.set(bx * 0.4, 1.0, GOAL.Z + 4);
  } else if (camMode === 'side') {
    wantPos.set(14, 2.4, GOAL.Z + 5.5);
    wantLook.set(0, 1.0, GOAL.Z + 4.5);
  } else if (camMode === 'follow') {
    wantPos.set(b.x * 0.9, Math.max(0.5, b.y + 0.45), Math.max(b.z + 1.8, GOAL.Z + 1.2));
    wantLook.set(b.x, b.y, b.z - 3);
  } else if (camMode === 'keeper') {
    if (state === 'plan') {
      // Facing the goal, close enough to pick a spot precisely, with the goal
      // framed right of the keeper card. Narrow screens stack the card below.
      const side = camera.aspect >= 1 ? 1 : 0;
      // Far enough back that both posts fit a portrait screen too.
      const back = side ? 9.6 : clamp(6.4 / camera.aspect, 9.6, 17);
      wantPos.set(-1.1 * side, 1.7 + 0.08 * (back - 9.6), GOAL.Z + back);
      wantLook.set(-1.7 * side, side ? 1.0 : 0.6, GOAL.Z);
    } else if (state === 'kicking' || state === 'flight' || state === 'pending') {
      // Behind the net and above the bar: the keeper's view of the taker.
      const f = state === 'flight' ? 1 : 0;
      // Far enough back to frame the whole goal mouth, keeper and taker.
      wantPos.set(0.2 + bx * 0.15 * f, 3.6, NET.BACK_Z - 4.2);
      wantLook.set(bx * 0.25 * f, 0.6 + by * 0.1 * f, -2);
    } else {
      // Afterwards, from in front of the goal, left of the report panel.
      const panel = $('report').hidden ? 0 : 1;
      wantPos.set(0.3 * panel, 2.0, GOAL.Z + 10);
      wantLook.set(bx * 0.25 + 1.6 * panel, 0.9, GOAL.Z);
    }
  } else {
    wantPos.copy(AIM_CAM);
    wantLook.set(0, 1.05, GOAL.Z);
    if (state === 'flight') {
      wantPos.set(bx * 0.15 + 0.6, 1.85, 4.6);
      wantLook.set(bx * 0.5, 1.0 + by * 0.15, GOAL.Z);
    } else if (state === 'result') {
      // Frame the goal left of the report panel.
      const panel = $('report').hidden ? 0 : 1;
      wantPos.set(0.6 + 1.0 * panel, 2.1, 5.4);
      wantLook.set(bx * 0.35 + 2.2 * panel, 0.95, GOAL.Z);
    }
  }
  const k = camMode === 'follow' ? 1 - Math.exp(-dt * 14) : 1 - Math.exp(-dt * 5);
  camPos.lerp(wantPos, k);
  camLook.lerp(wantLook, k);
  camera.position.copy(camPos);
  camera.lookAt(camLook);
}

// ------------------------------------------------------------------- results

function showBanner(r) {
  const el = $('banner');
  el.className = `${r.outcome} show`;
  el.querySelector('.title').textContent = r.title;
  el.querySelector('.detail').textContent = r.detail;
}
function hideBanner() {
  $('banner').className = '';
}

// The banner from your side: when you keep, a goal is the computer's. On
// chain the realm's verdict stands; the replay is the browser engine's.
function headline(r, side, chainKick = null) {
  let out = r;
  if (chainKick) {
    const o = chainOutcome(chainKick.result.outcome);
    if (o !== r.outcome) {
      const title = { goal: 'GOAL!', save: 'SAVED!', miss: 'MISSED', post: 'WOODWORK!' }[o];
      // The realm runs this same engine, so this means the page and the
      // realm's engine have drifted apart (different versions or constants).
      out = { outcome: o, title, detail: `The chain's verdict. This page's engine replayed ${r.outcome === 'goal' ? 'a goal' : `a ${r.outcome}`}: it is out of step with the realm's (custom constants or another version).` };
    }
  }
  if (side === 'player') return out;
  const cpu = game.mode === 'chain' ? 'CHAIN' : 'CPU';
  const t = { goal: `${cpu} SCORES`, save: 'SAVED!', miss: `${cpu} MISSES`, post: 'WOODWORK!' }[out.outcome];
  return { ...out, title: t, detail: out.outcome === 'save' ? out.detail.replace("the keeper's", 'your') : out.detail };
}

// The sealed bytes, if they give exactly what was played (else zeros, so the
// commit check fails).
function revealedBytes() {
  const seedOf = (x) => [...x];
  let same;
  if (shot.side === 'player') {
    const again = CP.keeperFromBytes(game.bytes);
    same = JSON.stringify(again.plan.raw) === JSON.stringify(shot.sim.plan.raw) &&
      JSON.stringify(seedOf(again.strikeSeed)) === JSON.stringify(seedOf(shot.input.seed));
  } else {
    const again = CP.kickFromBytes(game.bytes).input;
    same = JSON.stringify({ ...again, seed: seedOf(again.seed) }) === JSON.stringify({ ...shot.input, seed: seedOf(shot.input.seed) });
  }
  return same ? game.bytes : new Uint8Array(P.ROUND_BYTES);
}

function onDecided() {
  const r = shot.sim.result;
  const h = headline(r, shot.side, shot.chain);
  showBanner(h);
  const good = shot.side === 'player' ? h.outcome === 'goal' : h.outcome !== 'goal';
  if (good) excitement = 1;
  if (!isReplay && shot.chain && game.chain.after) {
    // The chain has already recorded it; show its books now.
    game.chain.game = game.chain.after.game;
    game.chain.session = game.chain.after.session;
    game.chain.after = null;
    syncFromSession(game.chain.session);
    renderMatch();
    renderScore();
    const k = shot.chain;
    const pill = $('commit');
    pill.classList.add('revealed');
    pill.innerHTML = `<span class="dot"></span>Block <b>${k.height.toLocaleString()}</b> · seed <code>${k.seed.slice(0, 16)}…</code> · <a href="${C.webLink(`game/${game.chain.game.id}/${game.chain.session.no}`)}" target="_blank" rel="noopener">on gnoweb ↗</a>`;
  } else if (!isReplay && !shot.chain) {
    SO.record(game.shootout, shot.side, r.outcome === 'goal');
    game.outcomes[shot.side].push(r.outcome);
    game.kick++;
    renderScore();
    const pill = $('commit');
    pill.classList.add('revealed');
    const check = P.commitHash(revealedBytes());
    const what = shot.side === 'player' ? 'Plan and mishit seed revealed' : "The computer's kick revealed";
    pill.innerHTML = `<span class="dot"></span>${what} · <code>#${check}</code> ${
      check === game.commit ? 'matches the sealed commit' : 'DOES NOT MATCH'}`;
  }
}

function onFinished() {
  state = 'result';
  playSpeed = 1;
  pathLine.visible = true;
  setMarkers(shot.sim.events);
  setTimeout(() => {
    if (state === 'result') hideBanner();
  }, 1400);
  // Shows your intended vs actual contact; nothing to show after keeping.
  $('dock').style.visibility = shot.side === 'player' ? 'visible' : 'hidden';
  drawPicker();
  if (!$('report').hidden) return;
  fillReport();
  $('report').hidden = false;
}

function fillReport() {
  const { sim, ms, verified, side } = shot;
  const r = sim.result;
  const L = sim.launch;
  const s = spinParts(L);
  const { elev, yaw } = launchAngles(L);
  const h = headline(r, side, shot.chain);
  const w = SO.winner(game.shootout);
  const sc = SO.score(game.shootout);
  const onChain = game.mode === 'chain' && !!shot.chain;
  let status;
  const margin = game.shootout.winBy;
  const twoNeeded = margin > 1 && sc.player >= sc.cpu ? ` A win needs a ${margin}-goal margin.` : '';
  if (onChain && game.chain.session.status === 'won') {
    const pot = game.chain.game.pot;
    const cut = Math.floor((pot * C.CREATOR_PERCENT) / 100);
    status = `You beat the chain ${sc.player}–${sc.cpu} and won ${C.gnot(pot - cut)} (the ${C.gnot(pot)} pot less ${C.CREATOR_PERCENT}% for its creator)!`;
  } else if (onChain && game.chain.session.status !== 'playing') {
    status = `${sc.player}–${sc.cpu}: the chain keeps the pot, and your fee stays in it.${twoNeeded}`;
  } else if (w) status = `${w === 'player' ? 'You win' : 'The computer wins'} the shootout ${sc.player}–${sc.cpu}.${w === 'cpu' ? twoNeeded : ''}`;
  else status = `${sc.player}–${sc.cpu}. Next: ${SO.nextSide(game.shootout) === 'player' ? 'you shoot' : 'you keep'}.`;

  $('report-title').className = h.outcome;
  $('report-title').textContent = h.title;
  $('report-detail').textContent = `${h.detail} ${status}`;
  const over = onChain ? game.chain.session.status !== 'playing' : !!w;
  $('next').innerHTML = `${over ? (onChain ? 'Back to the lobby' : 'New shootout')
    : SO.nextSide(game.shootout) === 'player' ? 'Next: take your kick' : 'Next: in goal'} <kbd>Enter</kbd>`;

  const line = r.lineCross
    ? `t=${r.lineCross.t.toFixed(3)} s at x=${r.lineCross.x.toFixed(2)}, y=${r.lineCross.y.toFixed(2)} m`
    : 'never';
  const fmt = (n, d = 2) => n.toFixed(d);
  const strike = `
    <dl>
      <dt>${side === 'player' ? 'Intended contact' : 'Contact'}</dt><dd>x ${fmt(L.intended.x)} · y ${fmt(L.intended.y)} R</dd>
      <dt>Actual contact</dt><dd>x ${fmt(L.contact.x)} · y ${fmt(L.contact.y)} R</dd>
      <dt>Mishit</dt><dd>Δx ${fmt(L.fuzz.x, 3)} · Δy ${fmt(L.fuzz.y, 3)} R</dd>
      ${side === 'cpu' ? `<dt>Aimed at</dt><dd>x ${fmt(shot.input.aim.x)} · y ${fmt(shot.input.aim.y)} m</dd>` : ''}
      <dt>Power · efficiency</dt><dd>${Math.round(L.power * 100)}% · ${Math.round(L.efficiency * 100)}%</dd>
      <dt>Launch speed</dt><dd>${fmt(L.speed, 1)} m/s (${fmt(L.speed * 3.6, 0)} km/h)</dd>
      <dt>Launch angle</dt><dd>${fmt(elev, 1)}° up, ${fmt(Math.abs(yaw), 1)}° ${yaw >= 0 ? 'right' : 'left'}</dd>
      <dt>Sidespin</dt><dd>${s.sideRpm} rpm ${s.sideRpm >= 15 ? (s.side > 0 ? '(curls left)' : '(curls right)') : ''}</dd>
      <dt>${s.back >= 0 ? 'Backspin' : 'Topspin'}</dt><dd>${s.backRpm} rpm</dd>
      <dt>Reached goal line</dt><dd>${line}</dd>
    </dl>`;
  // What the seeded misread did this time.
  const m = r.keeper.misread;
  const sg = P.misreadSigmas(sim.plan);
  const sgn = (x, d = 2) => `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(d)}`;
  const misread = !m ? '' : P.planMode(sim.plan) === 'read'
    ? `<dt>Misread at commit</dt><dd>${sgn(m.x * sg.x)} m across · ${sgn(m.y * sg.y)} m up</dd>`
    : `<dt>Dive misjudged</dt><dd>${sgn(m.vx * sg.vx)} m/s across · ${sgn(m.jump * sg.jump)} m/s jump</dd>`;
  const plan = `<dl><dt>Plan uint16s</dt><dd>${sim.plan.raw.join(' · ')}</dd>${misread}</dl>`;
  const k = shot.chain;
  const onChainHtml = k ? `
    <h4>On chain</h4>
    <dl>
      <dt>Verdict</dt><dd>${k.result.outcome} at x ${k.result.x}, y ${k.result.y} mm · ${k.result.arrivalMs} ms · ${(k.result.ballSpeed / 1000).toFixed(1)} m/s</dd>
      <dt>Chain keeper</dt><dd>${k.result.keeper}</dd>
      <dt>3-D replay</dt><dd>${chainOutcome(k.result.outcome) === r.outcome && (!r.lineCross || (Math.round(r.lineCross.x * 1000) === k.result.x && Math.round(r.lineCross.y * 1000) === k.result.y)) ? '✓ identical to the chain' : '✗ differs from the chain (custom constants or another engine version)'}</dd>
      <dt>Block · time</dt><dd>${k.height} · ${new Date(k.time / 1e6).toISOString().replace('T', ' ').replace('.000Z', ' UTC')}</dd>
      <dt>Seed = SHA-256</dt><dd class="hex">${k.seed}</dd>
      <dt>Your move</dt><dd>${k.kicker === 'player' ? `aim ${k.shot.aimX}, ${k.shot.aimY} mm · contact ${k.shot.contactX}, ${k.shot.contactY} mR · power ${k.shot.power}‰` : `plan ${[k.plan.direction, k.plan.speed, k.plan.jump, k.plan.reaction].join(' · ')}`}</dd>
    </dl>` : '';
  const sealed = k
    ? (side === 'player'
      ? `${onChainHtml}<h4>Your strike</h4>${strike}<h4>The chain's keeper (its mix, picked by seed bytes 0–1)</h4><p>${P.describePlan(sim.plan)}.</p>${plan}`
      : `${onChainHtml}<h4>Your keeper</h4><p>${P.describePlan(sim.plan)}.</p>${plan}<h4>The chain's kick (its mix, picked by seed bytes 0–1)</h4>${strike}`)
    : side === 'player'
    ? `<h4>Your strike</h4>${strike}
    <h4>Sealed before the shot</h4>
    <p>Keeper: ${P.describePlan(sim.plan)}.</p>
    <dl>
      <dt>Plan uint16s</dt><dd>${sim.plan.raw.join(' · ')}</dd>
      ${misread}
      <dt>Mishit seed</dt><dd class="hex">${P.toHex(shot.input.seed)}</dd>
      <dt>Round bytes</dt><dd class="hex">${P.toHex(game.bytes)}</dd>
      <dt>Commit</dt><dd>#${game.commit}</dd>
    </dl>`
    : `<h4>Your keeper</h4>
    <p>${P.describePlan(sim.plan)}.</p>${plan}
    <h4>The computer's kick, sealed before you chose</h4>${strike}
    <dl>
      <dt>Kick ints</dt><dd>aim ${game.cpu.ints.aimX}, ${game.cpu.ints.aimY} mm · power ${game.cpu.ints.power}‰ · contact ${game.cpu.ints.contactX}, ${game.cpu.ints.contactY} mR</dd>
      <dt>Round bytes</dt><dd class="hex">${P.toHex(game.bytes)}</dd>
      <dt>Commit</dt><dd>#${game.commit}</dd>
    </dl>`;
  $('report-body').innerHTML = `
    ${sealed}
    <h4>Timeline</h4>
    <ol class="timeline">${sim.events.map((e) => `<li class="${e.type}"><time>${e.t.toFixed(3)} s</time><span>${e.text}</span></li>`).join('')}</ol>
    <h4>Simulation</h4>
    <dl>
      <dt>Steps</dt><dd>${sim.steps} × ${SIM.DT * 1000} ms</dd>
      <dt>Computed in</dt><dd>${fmt(ms, 1)} ms, before the ball moved</dd>
      <dt>State hash</dt><dd>${sim.hash}</dd>
    </dl>
    <p class="verify ${verified ? '' : 'bad'}">${verified ? '✓ independent re-simulation reproduced the same hash' : '✗ re-simulation diverged'}</p>
  `;
}

// ---------------------------------------------------------------------- loop

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  handleHeldKeys(dt);

  if (state === 'aim') {
    if (charging) {
      const ph = ((now - chargeStart) / 1000 / POWER_SWEEP) % 2;
      power = ph < 1 ? ph : 2 - ph;
    }
    $('power-fill').style.width = `${(power * 100).toFixed(1)}%`;
    $('power-value').innerHTML = `<b>${Math.round(power * 100)}%</b> power${charging ? '' : ' · hold to charge'}`;
    reticle.position.set(aim.x, aim.y, GOAL.Z + 0.03);
    updatePreview();
    updateContactReadout();
  } else if (state === 'plan') {
    updateKeeperPlan();
    const guess = keep.mode === 'guess';
    reticle.visible = guess;
    ghost.visible = guess;
    reticle.position.set(keep.target.x, keep.target.y, GOAL.Z + 0.35);
    reticle.scale.setScalar(keep.locked ? 1 : 0.8 + 0.06 * Math.sin(now / 160));
    $('keeper-card').classList.toggle('locked', keep.locked);
  } else if (state === 'kicking') {
    kickT += dt * playSpeed;
    if (kickT >= RUNUP) {
      state = 'flight';
      playT = kickT - RUNUP;
    }
  } else if (state === 'flight') {
    playT += dt * playSpeed;
    const frames = shot.sim.frames;
    applyFrame(sampleFrame(frames, playT));
    if (!bannerShown && playT >= shot.sim.result.decidedAt) {
      bannerShown = true;
      onDecided();
    }
    if (playT >= frames[frames.length - 1].t) onFinished();
  } else if (state === 'result') {
    playT += dt; // keeps the players' reactions going
  }

  excitement = Math.max(0, excitement - dt * 0.12);
  updateBodies(now / 1000);
  world.update(dt, excitement);
  updateCamera(dt);
  composer.render();
  requestAnimationFrame(frame);
}

// Expose the simulator for anyone who wants to poke at it from the console.
window.spotKick = {
  physics: P, camera, game, keep,
  get lastShot() { return shot && shot.sim; },
  get state() { return state; },
};

drawPicker();
initLobby({ onPlay: startChain, onPractice: startPractice });
onClick($('to-lobby'), backToLobby);
if (params.has('practice')) startPractice();
else backToLobby();
requestAnimationFrame(frame);
// Ready for the first time you keep, without stalling a frame then.
KP.buildReachTable();
