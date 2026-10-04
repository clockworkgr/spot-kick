// Stadium, pitch, goal and ball: everything static or purely decorative.
// The goal frame and net dimensions come from physics.js; nothing here feeds
// back into the simulation.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import * as P from './physics.js?v=18';
import { surfaceTexture, contactShadow, addTurf, crowdTier, roofStructure } from './visuals.js';

const { BALL, GOAL, NET } = P;
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const tmpV = new THREE.Vector3();

// --------------------------------------------------------------- utilities

export function placeSegment(obj, a, b) {
  obj.position.set((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
  tmpV.set(b.x - a.x, b.y - a.y, b.z - a.z);
  const l = tmpV.length();
  if (l > 1e-9) obj.quaternion.setFromUnitVectors(Y_AXIS, tmpV.divideScalar(l));
}

export const capsuleGeometry = (c) => {
  const l = Math.hypot(c.b.x - c.a.x, c.b.y - c.a.y, c.b.z - c.a.z);
  return l < 1e-6 ? new THREE.SphereGeometry(c.r, 20, 14) : new THREE.CapsuleGeometry(c.r, l, 6, 16);
};

const hitboxMat = new THREE.MeshBasicMaterial({
  color: 0xff3b6b, wireframe: true, transparent: true, opacity: 0.6, depthTest: false, toneMapped: false,
});
export const hitboxes = [];
export function addHitbox(parent, geometry) {
  const w = new THREE.Mesh(geometry, hitboxMat);
  w.visible = false;
  w.renderOrder = 10;
  parent.add(w);
  hitboxes.push(w);
  return w;
}

function canvasTex(w, h, draw, { srgb = true, repeat = false } = {}) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

// Small deterministic RNG so the stadium looks the same on every load.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- textures

function skyTexture() {
  const r = rng(7);
  return canvasTex(512, 512, (g, w, h) => {
    const grd = g.createLinearGradient(0, 0, 0, h);
    grd.addColorStop(0, '#010309');
    grd.addColorStop(0.5, '#071124');
    grd.addColorStop(0.8, '#14284a');
    grd.addColorStop(1, '#22385e');
    g.fillStyle = grd;
    g.fillRect(0, 0, w, h);
    for (let i = 0; i < 260; i++) {
      g.fillStyle = `rgba(255,255,255,${0.15 + r() * 0.5})`;
      g.fillRect(r() * w, r() * h * 0.55, 1, 1);
    }
  });
}

function grassTexture(shade) {
  const r = rng(shade ? 11 : 12);
  return canvasTex(512, 512, (g, w, h) => {
    g.fillStyle = shade ? '#476a36' : '#395d2d';
    g.fillRect(0, 0, w, h);
    // Soft mottling.
    for (let i = 0; i < 260; i++) {
      const x = r() * w;
      const y = r() * h;
      const rad = 10 + r() * 40;
      const grd = g.createRadialGradient(x, y, 0, x, y, rad);
      const c = r() > 0.5 ? '255,255,200' : '0,40,0';
      grd.addColorStop(0, `rgba(${c},${0.03 + r() * 0.04})`);
      grd.addColorStop(1, `rgba(${c},0)`);
      g.fillStyle = grd;
      g.fillRect(x - rad, y - rad, rad * 2, rad * 2);
    }
    // Blades.
    for (let i = 0; i < 26000; i++) {
      const light = r() > 0.45;
      g.strokeStyle = light
        ? `rgba(${170 + r() * 60},${220 + r() * 35},${120 + r() * 50},${0.06 + r() * 0.1})`
        : `rgba(0,${25 + r() * 30},0,${0.08 + r() * 0.12})`;
      g.lineWidth = 0.6 + r() * 0.8;
      const x = r() * w;
      const y = r() * h;
      const l = 2 + r() * 5;
      const a = -Math.PI / 2 + (r() - 0.5) * 0.9;
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l);
      g.stroke();
    }
  }, { repeat: true });
}

function wearTexture(seed, strength) {
  const r = rng(seed);
  return canvasTex(256, 256, (g, w, h) => {
    for (let i = 0; i < 900; i++) {
      const ang = r() * Math.PI * 2;
      const dist = Math.pow(r(), 0.7) * w * 0.48;
      const x = w / 2 + Math.cos(ang) * dist;
      const y = h / 2 + Math.sin(ang) * dist * 0.8;
      const fall = 1 - dist / (w * 0.5);
      const rad = 2 + r() * 9;
      const grd = g.createRadialGradient(x, y, 0, x, y, rad);
      const tone = r() > 0.5 ? '120,98,62' : '150,140,80';
      grd.addColorStop(0, `rgba(${tone},${strength * fall * (0.2 + r() * 0.4)})`);
      grd.addColorStop(1, `rgba(${tone},0)`);
      g.fillStyle = grd;
      g.fillRect(x - rad, y - rad, rad * 2, rad * 2);
    }
  });
}

// Classic 32-panel ball: black pentagons at the icosahedron vertices, white
// hexagons at its face centres, recessed seams where neighbouring panels meet.
function ballTextures() {
  const phi = (1 + Math.sqrt(5)) / 2;
  const raw = [
    [0, 1, phi], [0, -1, phi], [0, 1, -phi], [0, -1, -phi],
    [1, phi, 0], [-1, phi, 0], [1, -phi, 0], [-1, -phi, 0],
    [phi, 0, 1], [-phi, 0, 1], [phi, 0, -1], [-phi, 0, -1],
  ];
  const norm = (v) => {
    const l = Math.hypot(v[0], v[1], v[2]);
    return [v[0] / l, v[1] / l, v[2] / l];
  };
  const d2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
  const centres = raw.map((v) => ({ v: norm(v), pent: true }));
  for (let i = 0; i < 12; i++) {
    for (let j = i + 1; j < 12; j++) {
      for (let k = j + 1; k < 12; k++) {
        if (Math.abs(d2(raw[i], raw[j]) - 4) < 1e-6 && Math.abs(d2(raw[j], raw[k]) - 4) < 1e-6 && Math.abs(d2(raw[i], raw[k]) - 4) < 1e-6) {
          centres.push({ v: norm([raw[i][0] + raw[j][0] + raw[k][0], raw[i][1] + raw[j][1] + raw[k][1], raw[i][2] + raw[j][2] + raw[k][2]]), pent: false });
        }
      }
    }
  }
  const W = 1024;
  const H = 512;
  const col = new Uint8ClampedArray(W * H * 4);
  const bump = new Uint8ClampedArray(W * H * 4);
  for (let j = 0; j < H; j++) {
    const theta = ((j + 0.5) / H) * Math.PI;
    const st = Math.sin(theta);
    const ct = Math.cos(theta);
    for (let i = 0; i < W; i++) {
      const ph = ((i + 0.5) / W) * Math.PI * 2;
      const dx = -Math.cos(ph) * st;
      const dz = Math.sin(ph) * st;
      let b1 = -2;
      let b2 = -2;
      let best = null;
      for (const c of centres) {
        const dot = c.v[0] * dx + c.v[1] * ct + c.v[2] * dz;
        if (dot > b1) {
          b2 = b1;
          b1 = dot;
          best = c;
        } else if (dot > b2) b2 = dot;
      }
      const seam = Math.min(1, (b1 - b2) / 0.016);
      const shade = 0.55 + 0.45 * seam;
      const base = best.pent ? [24, 26, 32] : [246, 246, 242];
      const k = (j * W + i) * 4;
      col[k] = base[0] * shade;
      col[k + 1] = base[1] * shade;
      col[k + 2] = base[2] * shade;
      col[k + 3] = 255;
      const bv = 255 * (0.35 + 0.65 * seam);
      bump[k] = bump[k + 1] = bump[k + 2] = bv;
      bump[k + 3] = 255;
    }
  }
  const mk = (data, srgb) => canvasTex(W, H, (g) => g.putImageData(new ImageData(data, W, H), 0, 0), { srgb });
  return { map: mk(col, true), bump: mk(bump, false) };
}

function ledTexture() {
  const t = canvasTex(2048, 96, (g, w, h) => {
    const grd = g.createLinearGradient(0, 0, 0, h);
    grd.addColorStop(0, '#0a2a6a');
    grd.addColorStop(1, '#051538');
    g.fillStyle = grd;
    g.fillRect(0, 0, w, h);
    g.font = '800 60px Inter, Arial, sans-serif';
    g.textBaseline = 'middle';
    const items = [['SPOT KICK', '#c6ff3d'], ['THE BEAUTIFUL GAME', '#ffffff'], ['MATCH NIGHT', '#9fc8df'], ['SPOT KICK ARENA', '#ffffff']];
    let x = 30;
    let i = 0;
    while (x < w) {
      const [txt, c] = items[i++ % items.length];
      g.fillStyle = c;
      g.fillText(txt, x, h / 2 + 3);
      x += g.measureText(txt).width + 80;
      g.fillStyle = 'rgba(255,255,255,0.4)';
      g.fillRect(x - 46, h / 2 - 3, 6, 6);
    }
    // LED pixel grid.
    g.fillStyle = 'rgba(0,0,0,0.28)';
    for (let yy = 0; yy < h; yy += 4) g.fillRect(0, yy, w, 1);
    for (let xx = 0; xx < w; xx += 4) g.fillRect(xx, 0, 1, h);
  }, { repeat: true });
  return t;
}

function lampTexture() {
  return canvasTex(128, 64, (g, w, h) => {
    g.fillStyle = '#1a1d24';
    g.fillRect(0, 0, w, h);
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 8; x++) {
        const cx = 8 + x * 16;
        const cy = 8 + y * 16;
        const r = g.createRadialGradient(cx, cy, 0, cx, cy, 7);
        r.addColorStop(0, '#ffffff');
        r.addColorStop(0.6, '#fff4d8');
        r.addColorStop(1, '#5a5440');
        g.fillStyle = r;
        g.fillRect(cx - 7, cy - 7, 14, 14);
      }
    }
  });
}

function netTexture() {
  return canvasTex(64, 64, (g, w, h) => {
    g.clearRect(0, 0, w, h);
    g.strokeStyle = 'rgba(245,248,252,1)';
    g.lineWidth = 1.35;
    g.beginPath();
    // Diamond mesh: one knot at the cell centre, cords to the corners.
    g.moveTo(0, 0);
    g.lineTo(w, h);
    g.moveTo(w, 0);
    g.lineTo(0, h);
    g.stroke();
    g.fillStyle = '#fff';
    g.beginPath();
    g.arc(w / 2, h / 2, 1.7, 0, Math.PI * 2);
    g.fill();
  }, { repeat: true });
}

function glowTexture() {
  return canvasTex(128, 128, (g) => {
    const r = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    r.addColorStop(0, 'rgba(255,255,255,1)');
    r.addColorStop(0.2, 'rgba(255,248,230,0.6)');
    r.addColorStop(1, 'rgba(255,240,200,0)');
    g.fillStyle = r;
    g.fillRect(0, 0, 128, 128);
  });
}

// ------------------------------------------------------------------- world

export function buildWorld(scene, renderer) {
  scene.background = skyTexture();
  scene.fog = new THREE.Fog(0x152335, 48, 180);
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.22;

  // Floodlight key with shadows, a softer opposite bank, and sky fill.
  scene.add(new THREE.HemisphereLight(0xc0d3ea, 0x303323, 0.65));
  const key = new THREE.DirectionalLight(0xfff5e9, 2.15);
  key.position.set(-10, 24, 8);
  key.target.position.set(0, 0, GOAL.Z + 4);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  Object.assign(key.shadow.camera, { left: -15, right: 15, top: 16, bottom: -16, near: 1, far: 70 });
  key.shadow.bias = -0.0003;
  key.shadow.normalBias = 0.012;
  key.shadow.radius = 3;
  scene.add(key, key.target);
  const bank = new THREE.DirectionalLight(0xdfe8ff, 0.85);
  bank.position.set(14, 20, -20);
  scene.add(bank);
  const rim = new THREE.DirectionalLight(0x9fc4ff, 0.5);
  rim.position.set(0, 8, 20);
  scene.add(rim);

  const animated = [];
  buildPitch(scene);
  addTurf(scene, GOAL.Z, animated);
  const stands = buildStands(scene, animated);
  const goal = buildGoal(scene);
  const ball = buildBall(scene);
  const ballShadow = contactShadow(0.22);
  scene.add(ballShadow);

  let clock = 0;
  return {
    ball,
    updateNet: goal.updateNet,
    // excitement: 0..1, raised by the game after a goal.
    update(dt, excitement = 0) {
      clock += dt;
      ballShadow.position.set(ball.position.x, 0.009, ball.position.z);
      const height = Math.max(0, ball.position.y - BALL.R);
      ballShadow.scale.setScalar(1 + height * 0.55);
      ballShadow.material.opacity = 0.8 * Math.exp(-height * 1.7);
      for (const fn of animated) fn(dt, clock, excitement);
      stands.update(dt, clock, excitement);
    },
  };
}

// ------------------------------------------------------------------- pitch

function rect(scene, w, d, x, z, mat, y) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), mat);
  m.rotation.x = -Math.PI / 2;
  m.position.set(x, y, z);
  m.receiveShadow = true;
  scene.add(m);
  return m;
}

function buildPitch(scene) {
  rect(scene, 300, 300, 0, -20, new THREE.MeshStandardMaterial({ color: 0x14301a, roughness: 1 }), -0.05);
  const track = new THREE.MeshStandardMaterial({ color: 0x333c3c, bumpMap: surfaceTexture('concrete'), bumpScale: 0.004, roughness: 0.98 });
  rect(scene, 76, 5.5, 0, GOAL.Z - 5.7, track, -0.015);
  for (const s of [-1, 1]) rect(scene, 3.5, 92, s * 39.8, GOAL.Z + 26, track, -0.015);
  const mats = [true, false].map((shade) => {
    const map = grassTexture(shade);
    map.repeat.set(18, 1.4);
    const bump = surfaceTexture('grass');
    bump.repeat.copy(map.repeat);
    return new THREE.MeshStandardMaterial({ map, bumpMap: bump, bumpScale: 0.0015, roughness: 0.98, metalness: 0 });
  });
  for (let i = -3; i < 14; i++) rect(scene, 76, 5.5, 0, GOAL.Z + 2.75 + i * 5.5, mats[(i + 100) % 2], 0);

  const line = new THREE.MeshStandardMaterial({ color: 0xdadbd0, roughness: 0.94, bumpMap: surfaceTexture('grass'), bumpScale: 0.002 });
  const W = 0.12;
  const Z = GOAL.Z;
  const L = (w, d, x, z) => rect(scene, w, d, x, z, line, 0.012);
  L(68, W, 0, Z);
  for (const s of [-1, 1]) {
    L(W, 5.5, s * 9.16, Z + 2.75);
    L(W, 16.5, s * 20.16, Z + 8.25);
    L(W, 60, s * 34, Z + 30);
  }
  L(18.32, W, 0, Z + 5.5);
  L(40.32, W, 0, Z + 16.5);
  const spot = new THREE.Mesh(new THREE.CircleGeometry(0.12, 24), line);
  spot.rotation.x = -Math.PI / 2;
  spot.position.y = 0.012;
  scene.add(spot);
  const a = Math.acos((Z + 16.5) / 9.15);
  const arc = new THREE.Mesh(new THREE.RingGeometry(9.15 - W / 2, 9.15 + W / 2, 64, 1, -Math.PI / 2 - a, 2 * a), line);
  arc.rotation.x = -Math.PI / 2;
  arc.position.y = 0.012;
  scene.add(arc);
  for (const s of [-1, 1]) {
    const corner = new THREE.Mesh(new THREE.RingGeometry(1 - W / 2, 1 + W / 2, 16, 1, s < 0 ? -Math.PI / 2 : Math.PI, Math.PI / 2), line);
    corner.rotation.x = -Math.PI / 2;
    corner.position.set(s * 34, 0.012, Z);
    scene.add(corner);
  }

  // Worn patches: the goalmouth, where keepers live, and the penalty spot.
  const decal = (tex, w, d, x, z) => {
    const m = rect(scene, w, d, x, z, new THREE.MeshStandardMaterial({
      map: tex, transparent: true, depthWrite: false, roughness: 1, polygonOffset: true, polygonOffsetFactor: -2,
    }), 0.006);
    return m;
  };
  decal(wearTexture(3, 0.9), 5, 2.6, 0, Z + 0.9);
  decal(wearTexture(4, 0.7), 1.6, 1.6, 0, 0.1);
  decal(wearTexture(5, 0.35), 3, 2.5, 0, 0.9);
}

// ------------------------------------------------------------------ stands

function buildStands(scene, animated) {
  const bandMaps = [];
  const concrete = new THREE.MeshStandardMaterial({ color: 0x2a303c, bumpMap: surfaceTexture('concrete'), bumpScale: 0.004, roughness: 0.95 });
  const roofMat = new THREE.MeshStandardMaterial({ color: 0x1a1f2a, roughness: 0.6, metalness: 0.3 });
  const led = ledTexture();
  const stripMat = new THREE.MeshBasicMaterial({ toneMapped: false });
  stripMat.color.setRGB(5, 4.7, 4.2); // HDR: blooms

  const tier = (g, width, y0, z0, len, angle, idx) =>
    crowdTier(g, width, y0, z0, len, angle, 21 + idx + Math.round(y0 * 10), animated);

  const stand = (width, pos, yaw, idx) => {
    const g = new THREE.Group();
    const wall = new THREE.Mesh(new THREE.BoxGeometry(width, 1.6, 0.5), concrete);
    wall.position.set(0, 0.8, 0.25);
    g.add(wall);
    const lower = tier(g, width, 1.4, 0, 17, 0.58, idx);
    const fascia = new THREE.Mesh(new THREE.BoxGeometry(width, 1.4, 0.3), concrete);
    fascia.position.set(0, lower.topY + 0.7, lower.topZ + 0.1);
    g.add(fascia);
    const bandMap = led.clone();
    bandMap.repeat.set(width / 26, 1);
    bandMap.needsUpdate = true;
    bandMaps.push(bandMap);
    const band = new THREE.Mesh(new THREE.PlaneGeometry(width, 0.9), new THREE.MeshBasicMaterial({ map: bandMap, color: 0xd0d0d0 }));
    band.position.set(0, lower.topY + 0.7, lower.topZ + 0.27);
    g.add(band);
    const upper = tier(g, width, lower.topY + 1.6, lower.topZ - 1, 14, 0.68, 1 - idx);
    const roof = new THREE.Mesh(new THREE.BoxGeometry(width + 4, 0.6, 22), roofMat);
    roof.position.set(0, upper.topY + 3.4, upper.topZ + 9);
    roof.rotation.x = -0.06;
    g.add(roof);
    roofStructure(g, width, upper.topY + 3.4, upper.topZ - 1.5);
    // Access tunnels and a handrail along the front of the lower tier.
    const tunnelMat = new THREE.MeshStandardMaterial({ color: 0x080d14, roughness: 1 });
    const railMat = new THREE.MeshStandardMaterial({ color: 0x66747e, roughness: 0.55, metalness: 0.6 });
    for (let x = -width / 2 + 9; x < width / 2; x += 18) {
      const tunnel = new THREE.Mesh(new THREE.BoxGeometry(1.5, 1.8, 0.15), tunnelMat);
      tunnel.position.set(x, 0.9, 0.57);
      g.add(tunnel);
    }
    const rail = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, width, 8), railMat);
    rail.rotation.z = Math.PI / 2;
    rail.position.set(0, 1.95, 0.4);
    g.add(rail);
    const strip = new THREE.Mesh(new THREE.BoxGeometry(width, 0.12, 0.12), stripMat);
    strip.position.set(0, upper.topY + 3.0, upper.topZ + 19.6);
    g.add(strip);
    const back = new THREE.Mesh(new THREE.PlaneGeometry(width + 4, 12), concrete);
    back.position.set(0, upper.topY - 2, upper.topZ - 0.5);
    g.add(back);
    g.position.copy(pos);
    g.rotation.y = yaw;
    scene.add(g);
  };
  stand(130, new THREE.Vector3(0, 0, GOAL.Z - 8.5), 0, 0);
  stand(150, new THREE.Vector3(-42, 0, GOAL.Z + 30), Math.PI / 2, 1);
  stand(150, new THREE.Vector3(42, 0, GOAL.Z + 30), -Math.PI / 2, 0);

  // Pitch-side LED boards (scrolling).
  const boardsMat = new THREE.MeshBasicMaterial({ map: led.clone(), color: 0xe6e6e6 });
  boardsMat.map.needsUpdate = true;
  boardsMat.map.repeat.set(2.5, 1);
  const boards = new THREE.Mesh(new THREE.BoxGeometry(GOAL.BOARDS_HW * 2, GOAL.BOARDS_H, 0.15), [
    concrete, concrete, concrete, concrete, boardsMat, concrete,
  ]);
  boards.position.set(0, GOAL.BOARDS_H / 2, GOAL.BOARDS_Z - 0.075);
  boards.castShadow = true;
  scene.add(boards);
  for (const s of [-1, 1]) {
    const side = new THREE.Mesh(new THREE.BoxGeometry(0.15, GOAL.BOARDS_H, 40), [concrete, concrete, concrete, concrete, concrete, concrete]);
    side.position.set(s * 37, GOAL.BOARDS_H / 2, GOAL.Z + 14);
    const face = new THREE.Mesh(new THREE.PlaneGeometry(40, GOAL.BOARDS_H), boardsMat);
    face.position.set(s * 36.92, GOAL.BOARDS_H / 2, GOAL.Z + 14);
    face.rotation.y = -s * Math.PI / 2;
    scene.add(side, face);
  }
  animated.push((dt) => {
    boardsMat.map.offset.x = (boardsMat.map.offset.x + dt * 0.035) % 1;
    for (const m of bandMaps) m.offset.x = (m.offset.x - dt * 0.02) % 1;
  });

  // Floodlight towers.
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x3a4250, roughness: 0.5, metalness: 0.4 });
  const lampMat = new THREE.MeshBasicMaterial({ map: lampTexture(), toneMapped: false });
  lampMat.color.setRGB(6, 6, 5.4); // HDR: blooms
  const glow = new THREE.SpriteMaterial({ map: glowTexture(), depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
  glow.color.setRGB(1.6, 1.55, 1.4);
  for (const [x, z] of [[-52, GOAL.Z - 34], [52, GOAL.Z - 34], [-56, 36], [56, 36]]) {
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.9, 46, 10), poleMat);
    pole.position.set(x, 23, z);
    const head = new THREE.Group();
    const panel = new THREE.Mesh(new THREE.BoxGeometry(9, 4.5, 0.5), [poleMat, poleMat, poleMat, poleMat, lampMat, poleMat]);
    head.add(panel);
    head.position.set(x, 47, z);
    head.lookAt(0, 0, GOAL.Z / 2);
    const s = new THREE.Sprite(glow);
    s.scale.set(30, 30, 1);
    s.position.set(x, 47, z);
    scene.add(pole, head, s);
    for (let y = 6; y < 45; y += 6) {
      const brace = new THREE.Mesh(new THREE.TorusGeometry(0.72 - y * 0.006, 0.035, 4, 12), poleMat);
      brace.position.set(x, y, z); brace.rotation.x = Math.PI / 2;
      scene.add(brace);
    }
  }

  // Corner flags that flutter.
  const flagMat = new THREE.MeshStandardMaterial({ color: 0xffd23f, side: THREE.DoubleSide, roughness: 0.8 });
  for (const s of [-1, 1]) {
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 1.6, 8), new THREE.MeshStandardMaterial({ color: 0xf2f2f2 }));
    pole.position.set(s * 34, 0.8, GOAL.Z);
    const geo = new THREE.PlaneGeometry(0.45, 0.32, 8, 4);
    const base = geo.attributes.position.array.slice();
    const flag = new THREE.Mesh(geo, flagMat);
    flag.position.set(s * 34 + 0.23, 1.42, GOAL.Z);
    flag.rotation.y = Math.PI / 2;
    scene.add(pole, flag);
    animated.push((dt, t) => {
      const arr = geo.attributes.position.array;
      for (let i = 0; i < arr.length; i += 3) {
        const u = (base[i] + 0.225) / 0.45;
        arr[i + 2] = base[i + 2] + 0.05 * u * Math.sin(t * 6 + u * 5 + s);
      }
      geo.attributes.position.needsUpdate = true;
    });
  }

  // Camera flashes from the crowd and photographers behind the goal.
  const N = 220;
  const r = rng(99);
  const pos = new Float32Array(N * 3);
  const col = new Float32Array(N * 3);
  const level = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    if (i < 40) {
      pos.set([(r() - 0.5) * 24, 0.5 + r() * 0.6, GOAL.BOARDS_Z - 1 - r() * 1.5], i * 3);
    } else {
      const d = r() * 15;
      pos.set([(r() - 0.5) * 110, 2 + d * 0.55, GOAL.Z - 8.5 - d * 0.84], i * 3);
    }
  }
  const fgeo = new THREE.BufferGeometry();
  fgeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  fgeo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const flashes = new THREE.Points(fgeo, new THREE.PointsMaterial({
    size: 0.38, map: glowTexture(), vertexColors: true, transparent: true, depthWrite: false,
    blending: THREE.AdditiveBlending, toneMapped: false,
  }));
  scene.add(flashes);

  return {
    update(dt, t, excitement) {
      const rate = 0.02 + excitement * 1.6; // flashes per point per second
      for (let i = 0; i < N; i++) {
        level[i] = Math.max(0, level[i] - dt * 9);
        if (Math.random() < rate * dt) level[i] = 1.6;
        col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = level[i] * 3; // HDR: blooms
      }
      fgeo.attributes.color.needsUpdate = true;
    },
  };
}

// -------------------------------------------------------------------- goal

function buildGoal(scene) {
  const white = new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.25, metalness: 0.05, clearcoat: 0.6 });
  for (const c of P.goalFrameCapsules()) {
    const l = Math.hypot(c.b.x - c.a.x, c.b.y - c.a.y, c.b.z - c.a.z);
    const m = new THREE.Mesh(new THREE.CylinderGeometry(c.r, c.r, l + (c.name === 'crossbar' ? 2 * c.r : 0), 28), white);
    placeSegment(m, c.a, c.b);
    m.castShadow = true;
    m.receiveShadow = true;
    scene.add(m);
    const hb = new THREE.Group();
    placeSegment(hb, c.a, c.b);
    addHitbox(hb, capsuleGeometry(c));
    scene.add(hb);
  }
  // Net support frame and ground bar (visual only; the net panels are the physics surface).
  const grey = new THREE.MeshStandardMaterial({ color: 0xd6d9df, roughness: 0.45, metalness: 0.3 });
  const rod = (a, b, r = 0.022) => {
    const l = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, l, 10), grey);
    placeSegment(m, a, b);
    m.castShadow = true;
    scene.add(m);
  };
  const X = NET.SIDE_X;
  const T = NET.ROOF_Y;
  const B = NET.BACK_Z;
  rod({ x: -X, y: 0, z: B }, { x: -X, y: T, z: B });
  rod({ x: X, y: 0, z: B }, { x: X, y: T, z: B });
  rod({ x: -X, y: T, z: B }, { x: X, y: T, z: B });
  rod({ x: -X, y: T, z: GOAL.Z }, { x: -X, y: T, z: B });
  rod({ x: X, y: T, z: GOAL.Z }, { x: X, y: T, z: B });
  rod({ x: -X, y: 0.02, z: B }, { x: X, y: 0.02, z: B }, 0.03);
  rod({ x: -X, y: 0.02, z: GOAL.Z }, { x: -X, y: 0.02, z: B }, 0.03);
  rod({ x: X, y: 0.02, z: GOAL.Z }, { x: X, y: 0.02, z: B }, 0.03);
  // Small ties attach the cords to the crossbar instead of floating beside it.
  for (let x = -X + 0.08; x < X; x += 0.32) {
    const tie = new THREE.Mesh(new THREE.TorusGeometry(GOAL.POST_R + 0.002, 0.003, 4, 12), grey);
    tie.rotation.y = Math.PI / 2;
    tie.position.set(x, T, GOAL.Z);
    scene.add(tie);
  }

  const netMap = netTexture();
  const netMat = new THREE.MeshStandardMaterial({
    map: netMap, alphaTest: 0.06, transparent: true, side: THREE.DoubleSide, depthWrite: false, roughness: 0.9, color: 0xf4f6fa,
  });
  const cell = 0.12; // mesh size of the net
  const res = 0.16; // vertex spacing used for deformation
  const panel = (origin, u, v, outward, penetration, sag) => {
    const lu = Math.hypot(u.x, u.y, u.z);
    const lv = Math.hypot(v.x, v.y, v.z);
    const nu = Math.max(2, Math.round(lu / res));
    const nv = Math.max(2, Math.round(lv / res));
    const pos = new Float32Array((nu + 1) * (nv + 1) * 3);
    const uv = new Float32Array((nu + 1) * (nv + 1) * 2);
    const pinned = new Float32Array((nu + 1) * (nv + 1));
    for (let j = 0; j <= nv; j++) {
      for (let i = 0; i <= nu; i++) {
        const a = i / nu;
        const b = j / nv;
        const s = sag(a, b);
        const k = j * (nu + 1) + i;
        pinned[k] = Math.min(1, i / 2, (nu - i) / 2, j / 2, (nv - j) / 2);
        pos[k * 3] = origin.x + u.x * a + v.x * b + outward.x * s;
        pos[k * 3 + 1] = origin.y + u.y * a + v.y * b + outward.y * s;
        pos[k * 3 + 2] = origin.z + u.z * a + v.z * b + outward.z * s;
        uv[k * 2] = (a * lu) / cell;
        uv[k * 2 + 1] = (b * lv) / cell;
      }
    }
    const idx = [];
    for (let j = 0; j < nv; j++) {
      for (let i = 0; i < nu; i++) {
        const k = j * (nu + 1) + i;
        idx.push(k, k + 1, k + nu + 1, k + 1, k + nu + 2, k + nu + 1);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, netMat);
    mesh.renderOrder = 2;
    scene.add(mesh);
    return { geo, rest: pos.slice(), pinned, outward, penetration, dirty: false };
  };
  const D = GOAL.DEPTH;
  const R = BALL.R;
  const S = Math.sin;
  const PI = Math.PI;
  const panels = [
    panel({ x: -X, y: 0, z: B }, { x: 2 * X, y: 0, z: 0 }, { x: 0, y: T, z: 0 },
      new THREE.Vector3(0, 0, -1), (b) => B - (b.z - R), (a, b) => 0.06 * S(PI * a) * S(PI * b)),
    panel({ x: -X, y: T, z: GOAL.Z }, { x: 2 * X, y: 0, z: 0 }, { x: 0, y: 0, z: -D },
      new THREE.Vector3(0, 1, 0), (b) => b.y + R - T, (a, b) => -0.08 * S(PI * a) * S(PI * b)),
    panel({ x: -X, y: 0, z: GOAL.Z }, { x: 0, y: 0, z: -D }, { x: 0, y: T, z: 0 },
      new THREE.Vector3(-1, 0, 0), (b) => -b.x + R - X, (a, b) => -0.04 * S(PI * a) * S(PI * b)),
    panel({ x: X, y: 0, z: GOAL.Z }, { x: 0, y: 0, z: -D }, { x: 0, y: T, z: 0 },
      new THREE.Vector3(1, 0, 0), (b) => b.x + R - X, (a, b) => -0.04 * S(PI * a) * S(PI * b)),
  ];

  // The net bulges by exactly the penetration the physics spring computed.
  function updateNet(ballPos, inGoal) {
    for (const p of panels) {
      const pen = inGoal ? p.penetration(ballPos) : 0;
      const arr = p.geo.attributes.position.array;
      if (pen <= 0) {
        if (p.dirty) {
          arr.set(p.rest);
          p.geo.attributes.position.needsUpdate = true;
          p.geo.computeVertexNormals();
          p.dirty = false;
        }
        continue;
      }
      const o = p.outward;
      for (let k = 0; k < arr.length; k += 3) {
        const dx = p.rest[k] - ballPos.x;
        const dy = p.rest[k + 1] - ballPos.y;
        const dz = p.rest[k + 2] - ballPos.z;
        const along = dx * o.x + dy * o.y + dz * o.z;
        const d2 = dx * dx + dy * dy + dz * dz - along * along;
        const disp = pen * Math.exp(-d2 / (2 * 0.32 * 0.32)) * p.pinned[k / 3];
        arr[k] = p.rest[k] + o.x * disp;
        arr[k + 1] = p.rest[k + 1] + o.y * disp;
        arr[k + 2] = p.rest[k + 2] + o.z * disp;
      }
      p.geo.attributes.position.needsUpdate = true;
      p.geo.computeVertexNormals();
      p.dirty = true;
    }
  }
  return { updateNet };
}

// -------------------------------------------------------------------- ball

function buildBall(scene) {
  const tex = ballTextures();
  const ball = new THREE.Mesh(
    new THREE.SphereGeometry(BALL.R, 64, 40),
    new THREE.MeshPhysicalMaterial({
      map: tex.map, bumpMap: tex.bump, bumpScale: 0.0025, roughness: 0.57, clearcoat: 0.22, clearcoatRoughness: 0.48,
    }),
  );
  ball.castShadow = true;
  addHitbox(ball, new THREE.SphereGeometry(BALL.R, 16, 10));
  scene.add(ball);
  return ball;
}
