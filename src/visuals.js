// Procedural scenery and surface detail. These assets never enter physics.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function surfaceTexture(kind = 'fabric') {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  const r = random(182);
  g.fillStyle = '#888';
  g.fillRect(0, 0, 256, 256);
  if (kind === 'fabric') {
    for (let y = 0; y < 256; y += 4) {
      for (let x = 0; x < 256; x += 4) {
        g.fillStyle = (x + y) % 8 ? '#a5a5a5' : '#686868';
        g.fillRect(x, y, 3, 1);
        g.fillRect(x + 1, y + 1, 1, 3);
      }
    }
  } else {
    for (let i = 0; i < 24000; i++) {
      const v = 65 + r() * 110;
      g.fillStyle = `rgb(${v},${v},${v})`;
      const x = r() * 256, y = r() * 256;
      if (kind === 'grass') g.fillRect(x, y, 0.6 + r(), 2 + r() * 6);
      else g.fillRect(x, y, 1, 1);
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

export function contactShadow(radius = 0.3) {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const fade = g.createRadialGradient(32, 32, 4, 32, 32, 32);
  fade.addColorStop(0, 'rgba(8,16,10,0.6)');
  fade.addColorStop(0.45, 'rgba(8,16,10,0.24)');
  fade.addColorStop(1, 'rgba(8,16,10,0)');
  g.fillStyle = fade;
  g.fillRect(0, 0, 64, 64);
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(radius * 2, radius * 2),
    new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1 }));
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = 0.009;
  return mesh;
}

export function addTurf(scene, goalZ, animated) {
  // Instancing keeps thousands of individual, tapered blades in one draw call.
  const r = random(821);
  const blade = new THREE.BufferGeometry();
  blade.setAttribute('position', new THREE.Float32BufferAttribute([
    -0.002, 0, 0, 0.002, 0, 0, -0.001, 0.018, 0.004,
    0.002, 0, 0, 0.001, 0.018, 0.004, -0.001, 0.018, 0.004,
    -0.001, 0.018, 0.004, 0.001, 0.018, 0.004, 0, 0.032, 0.01,
  ], 3));
  blade.computeVertexNormals();
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 0.95, side: THREE.DoubleSide,
  });
  const wind = { value: 0 };
  material.onBeforeCompile = (shader) => {
    shader.uniforms.turfTime = wind;
    shader.vertexShader = 'uniform float turfTime;\n' + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `
      #include <begin_vertex>
      transformed.z += pow(position.y / 0.032, 2.0) * 0.004 *
        sin(turfTime * 1.6 + instanceMatrix[3].x * 0.8 + instanceMatrix[3].z);
    `);
  };
  const count = 42000;
  const grass = new THREE.InstancedMesh(blade, material, count);
  const dummy = new THREE.Object3D();
  const color = new THREE.Color();
  for (let i = 0; i < count; i++) {
    const x = (r() - 0.5) * 27, z = goalZ - 2 + r() * (8 - goalZ + 2);
    // Bare goalmouth and the actual painted markings remain readable.
    const sparse = Math.abs(x) < 2.3 && z < goalZ + 2 && r() < 0.76;
    const onLine = Math.abs(z - goalZ) < 0.075 || Math.abs(z - goalZ - 5.5) < 0.075 ||
      (Math.abs(Math.abs(x) - 9.16) < 0.075 && z < goalZ + 5.5) || (x * x + z * z < 0.018);
    dummy.position.set(x, onLine || sparse ? -0.08 : 0.001, z);
    dummy.rotation.set(0, r() * Math.PI * 2, (r() - 0.5) * 0.3);
    dummy.scale.setScalar(0.6 + r() * 0.65);
    dummy.updateMatrix();
    grass.setMatrixAt(i, dummy.matrix);
    color.setHSL(0.24 + r() * 0.065, 0.28 + r() * 0.15, 0.18 + r() * 0.16);
    grass.setColorAt(i, color);
  }
  grass.receiveShadow = true;
  grass.computeBoundingSphere();
  scene.add(grass);
  animated.push((dt, t) => { wind.value = t; });
}

export function crowdTier(group, width, y0, z0, len, angle, seed, animated) {
  const r = random(seed);
  const rows = Math.floor(len / 0.82), cols = Math.floor(width / 0.57);
  const count = rows * cols;
  const concrete = new THREE.MeshStandardMaterial({ color: 0x373d45, roughness: 0.98 });
  const seats = new THREE.InstancedMesh(new THREE.BoxGeometry(0.43, 0.45, 0.12),
    new THREE.MeshStandardMaterial({ color: 0x253d53, roughness: 0.6 }), count);
  const crowdTime = { value: 0 }, crowdEnergy = { value: 0 };
  const animateMaterial = (mat, hasArms = false) => {
    mat.customProgramCacheKey = () => hasArms ? 'crowd-arms' : 'crowd-rest';
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.crowdTime = crowdTime;
      shader.uniforms.crowdEnergy = crowdEnergy;
      shader.vertexShader = 'uniform float crowdTime; uniform float crowdEnergy;\n' +
        (hasArms ? 'attribute float cheerSide;\n' : '') + shader.vertexShader;
      if (hasArms) shader.vertexShader = shader.vertexShader.replace('#include <beginnormal_vertex>', `
        #include <beginnormal_vertex>
        float cheerAngle = cheerSide * crowdEnergy * 2.45;
        objectNormal.xy = vec2(cos(cheerAngle) * objectNormal.x - sin(cheerAngle) * objectNormal.y,
          sin(cheerAngle) * objectNormal.x + cos(cheerAngle) * objectNormal.y);
      `);
      shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `
        #include <begin_vertex>
        ${hasArms ? `
          if (abs(cheerSide) > 0.5) {
            vec2 pivot = vec2(cheerSide * 0.65, 0.48);
            vec2 limb = transformed.xy - pivot;
            float a = cheerSide * crowdEnergy * 2.45;
            transformed.xy = pivot + vec2(cos(a) * limb.x - sin(a) * limb.y, sin(a) * limb.x + cos(a) * limb.y);
          }
        ` : ''}
        float phase = instanceMatrix[3].x * 2.8 + instanceMatrix[3].z * 4.1;
        transformed.y += (0.012 + crowdEnergy * 0.09) * sin(crowdTime * (2.0 + crowdEnergy * 5.0) + phase);
        transformed.x += 0.014 * sin(crowdTime * 1.3 + phase);
      `);
    };
    return mat;
  };
  const armAttribute = (geo, side) => {
    geo.setAttribute('cheerSide', new THREE.Float32BufferAttribute(new Float32Array(geo.attributes.position.count).fill(side), 1));
    return geo;
  };
  const parts = [armAttribute(new THREE.CylinderGeometry(0.76, 0.61, 1.6, 8), 0)];
  for (const s of [-1, 1]) {
    const shoulder = new THREE.SphereGeometry(0.29, 6, 4);
    shoulder.translate(s * 0.65, 0.48, 0); parts.push(armAttribute(shoulder, 0));
    const arm = new THREE.CapsuleGeometry(0.19, 0.82, 3, 6);
    arm.rotateZ(s * 0.13); arm.translate(s * 0.83, -0.12, 0.18); parts.push(armAttribute(arm, s));
  }
  const bodyGeometry = mergeGeometries(parts);
  parts.forEach((g) => g.dispose());
  const bodies = new THREE.InstancedMesh(bodyGeometry,
    animateMaterial(new THREE.MeshStandardMaterial({ color: 0x9ca8b4, roughness: 0.94 }), true), count);
  const heads = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 8, 6),
    animateMaterial(new THREE.MeshStandardMaterial({ color: 0xe4d5c7, roughness: 0.85 })), count);
  const hair = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 8, 4, 0, Math.PI * 2, 0, Math.PI * 0.53),
    animateMaterial(new THREE.MeshStandardMaterial({ roughness: 1 })), count);
  const dummy = new THREE.Object3D(), col = new THREE.Color();
  const steps = [];
  const shirts = [0xced4d8, 0x254566, 0x8e3238, 0x333944, 0xb8a17b, 0x657773, 0x687c91, 0xd2d4d0];
  const skins = [0xd7aa89, 0xae7b5c, 0x744d38, 0xe1ba9b, 0xb88968];
  let n = 0;
  for (let row = 0; row < rows; row++) {
    const d = (row + 0.5) * len / rows;
    const y = y0 + Math.sin(angle) * d, z = z0 - Math.cos(angle) * d;
    const step = new THREE.Mesh(new THREE.BoxGeometry(width, 0.17, len / rows * Math.cos(angle)), concrete);
    step.position.set(0, y - 0.16, z);
    step.updateMatrix(); step.geometry.applyMatrix4(step.matrix); steps.push(step.geometry);
    for (let c = 0; c < cols; c++) {
      const x = (c + 0.5) * width / cols - width / 2;
      const aisle = Math.abs(((x + width / 2) % 18) - 9) < 0.82;
      if (aisle) continue;
      const occupied = r() > 0.045;
      dummy.position.set(x, y + 0.36, z - 0.06);
      dummy.scale.set(1, 1, 1); dummy.rotation.set(0, 0, 0); dummy.updateMatrix();
      seats.setMatrixAt(n, dummy.matrix);
      const size = 0.9 + r() * 0.2;
      dummy.position.set(x + (r() - 0.5) * 0.07, occupied ? y + 0.59 : -20, z + 0.04);
      dummy.rotation.set(0.08 + r() * 0.14, (r() - 0.5) * 0.45, (r() - 0.5) * 0.14);
      dummy.scale.set(0.18 * size, 0.28 * size, 0.13);
      dummy.updateMatrix(); bodies.setMatrixAt(n, dummy.matrix);
      col.setHex(shirts[(r() * shirts.length) | 0]); bodies.setColorAt(n, col);
      dummy.position.y = occupied ? y + 0.93 * size : -20;
      dummy.position.z = z + 0.09;
      dummy.scale.set(0.086 * size, 0.112 * size, 0.09 * size);
      dummy.updateMatrix(); heads.setMatrixAt(n, dummy.matrix);
      col.setHex(skins[(r() * skins.length) | 0]); heads.setColorAt(n, col);
      dummy.position.y += 0.012;
      dummy.scale.multiplyScalar(1.035); dummy.updateMatrix(); hair.setMatrixAt(n, dummy.matrix);
      col.setHex(r() < 0.25 ? 0x8d7965 : 0x28221e); hair.setColorAt(n, col);
      n++;
    }
  }
  for (const m of [seats, bodies, heads, hair]) { m.count = n; m.computeBoundingSphere(); group.add(m); }
  group.add(new THREE.Mesh(mergeGeometries(steps), concrete));
  steps.forEach((g) => g.dispose());
  // Railings at each gangway give the terraces a real sense of scale.
  const steel = new THREE.MeshStandardMaterial({ color: 0x85939c, roughness: 0.5, metalness: 0.65 });
  for (let x = -width / 2 + 9; x < width / 2; x += 18) {
    for (const s of [-1, 1]) {
      const rail = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.028, len, 6), steel);
      rail.rotation.x = Math.PI / 2 - angle;
      rail.position.set(x + s * 0.8, y0 + Math.sin(angle) * len / 2 + 0.9, z0 - Math.cos(angle) * len / 2);
      group.add(rail);
    }
  }
  animated.push((dt, time, energy) => { crowdTime.value = time; crowdEnergy.value = energy; });
  return { topY: y0 + Math.sin(angle) * len, topZ: z0 - Math.cos(angle) * len };
}

export function roofStructure(group, width, y, z) {
  const steel = new THREE.MeshStandardMaterial({ color: 0x737e89, roughness: 0.48, metalness: 0.7 });
  const beams = [];
  const rod = (a, b, radius = 0.055) => {
    const start = new THREE.Vector3(...a), end = new THREE.Vector3(...b);
    const m = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, start.distanceTo(end), 8), steel);
    m.position.copy(start).lerp(end, 0.5);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), end.sub(start).normalize());
    m.updateMatrix(); m.geometry.applyMatrix4(m.matrix); beams.push(m.geometry);
  };
  for (let x = -width / 2 + 4; x < width / 2; x += 12) {
    rod([x, y - 2, z], [x, y - 2, z + 21], 0.08);
    rod([x, y - 0.4, z], [x, y - 0.4, z + 21], 0.08);
    for (let j = 0; j < 7; j++) {
      rod([x, y - 2, z + j * 3], [x, y - 0.4, z + (j + 1) * 3]);
      rod([x, y - 0.4, z + j * 3], [x, y - 2, z + (j + 1) * 3]);
    }
    rod([x, 0, z - 0.5], [x, y, z - 0.5], 0.14);
  }
  for (let d = 0; d <= 21; d += 7) rod([-width / 2, y - 1, z + d], [width / 2, y - 1, z + d], 0.07);
  group.add(new THREE.Mesh(mergeGeometries(beams), steel));
  beams.forEach((g) => g.dispose());
}
