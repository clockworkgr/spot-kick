// Articulated humanoid, for display only. It is posed purely from world-space
// targets (pelvis, body axes, hand and foot positions, a look-at point) using
// analytic two-bone IK. Contact targets come from physics; guard and recovery
// poses can relax away from the ball. Nothing in this rig affects gameplay.
import * as THREE from 'three';
import { surfaceTexture, contactShadow } from './visuals.js';
import { torsoFrame } from './pose-math.js';

const Y = new THREE.Vector3(0, 1, 0);
const _m = new THREE.Matrix4();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _d = new THREE.Vector3();

const weave = surfaceTexture('fabric');
weave.repeat.set(4, 6);
const pores = surfaceTexture('leather');
pores.repeat.set(2, 2);

function bootGeometry(S, sole = false) {
  const sections = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0.005, -0.075, 0.010), new THREE.Vector3(0.037, -0.055, 0.032),
    new THREE.Vector3(0.045, 0.015, 0.045), new THREE.Vector3(0.048, 0.105, 0.029),
    new THREE.Vector3(0.046, 0.17, 0.024), new THREE.Vector3(0.023, 0.215, 0.013),
    new THREE.Vector3(0.001, 0.226, 0.001),
  ]);
  const pos = [], uv = [], index = [], rows = 28, cols = 20;
  for (let j = 0; j <= rows; j++) {
    const p = sections.getPoint(j / rows);
    for (let i = 0; i <= cols; i++) {
      const a = i / cols * Math.PI * 2;
      pos.push(p.x * Math.cos(a) * S, (sole ? -0.077 + Math.sin(a) * 0.006 : -0.047 + Math.sin(a) * p.z) * S, p.y * S);
      uv.push(i / cols, j / rows);
      if (j < rows && i < cols) {
        const k = j * (cols + 1) + i;
        index.push(k, k + 1, k + cols + 1, k + 1, k + cols + 2, k + cols + 1);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(index); geo.computeVertexNormals();
  return geo;
}

function kitBadge() {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#c8b57b';
  g.beginPath(); g.moveTo(27, 18); g.lineTo(101, 18); g.lineTo(98, 77);
  g.quadraticCurveTo(64, 125, 30, 77); g.closePath(); g.fill();
  g.fillStyle = '#183653';
  g.beginPath(); g.moveTo(35, 27); g.lineTo(93, 27); g.lineTo(89, 74);
  g.quadraticCurveTo(64, 109, 39, 74); g.closePath(); g.fill();
  g.fillStyle = '#e5e9e9'; g.font = 'bold 30px serif'; g.textAlign = 'center'; g.fillText('SK', 64, 66);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

function numberTexture(text, fg, bg) {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 256;
  const g = c.getContext('2d');
  g.clearRect(0, 0, 256, 256);
  g.fillStyle = fg;
  g.font = '800 170px Inter, Arial, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  if (bg) {
    g.lineWidth = 10;
    g.strokeStyle = bg;
    g.strokeText(text, 128, 140);
  }
  g.fillText(text, 128, 140);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const fabric = (color, extra = {}) => new THREE.MeshPhysicalMaterial({
  color, bumpMap: weave, bumpScale: 0.0007, roughness: 0.88, sheen: 0.35,
  sheenRoughness: 0.8, sheenColor: new THREE.Color(0xc1c9d1), ...extra,
});

function printKit(material, kit, scale) {
  // Print into the jersey's rest surface, so badges and numbers bend with cloth.
  const number = numberTexture(kit.number, kit.numberColor), badge = kitBadge();
  material.onBeforeCompile = shader => {
    shader.uniforms.kitNumber = {value: number}; shader.uniforms.kitBadge = {value: badge};
    shader.uniforms.kitShirtColor = {value: new THREE.Color(kit.shirt)};
    shader.uniforms.kitSleeveColor = {value: new THREE.Color(kit.sleeve ?? kit.shirt)};
    shader.vertexShader = shader.vertexShader.replace('#include <common>',
      '#include <common>\nvarying vec3 kitPosition; varying vec3 kitNormal; attribute float armBlend; varying float sleeveBlend;');
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>',
      `#include <begin_vertex>\nkitPosition = position / ${scale.toFixed(8)}; kitNormal = normal; sleeveBlend = armBlend;`);
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>',
      '#include <common>\nvarying vec3 kitPosition; varying vec3 kitNormal; varying float sleeveBlend; uniform vec3 kitShirtColor; uniform vec3 kitSleeveColor; uniform sampler2D kitNumber; uniform sampler2D kitBadge;');
    shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', `
      #include <color_fragment>
      diffuseColor.rgb *= mix(kitShirtColor, kitSleeveColor, smoothstep(0.35, 0.36, sleeveBlend));
      vec2 numberUV = vec2(0.5 - kitPosition.x / 0.19, (kitPosition.y - 0.22) / 0.22);
      if (kitNormal.z < -0.35 && all(greaterThan(numberUV, vec2(0.0))) && all(lessThan(numberUV, vec2(1.0)))) {
        vec4 ink = texture2D(kitNumber, numberUV); diffuseColor.rgb = mix(diffuseColor.rgb, ink.rgb, ink.a);
      }
      vec2 badgeUV = vec2((kitPosition.x - 0.055) / 0.045, (kitPosition.y - 0.405) / 0.055);
      if (kitNormal.z > 0.35 && all(greaterThan(badgeUV, vec2(0.0))) && all(lessThan(badgeUV, vec2(1.0)))) {
        vec4 ink = texture2D(kitBadge, badgeUV); diffuseColor.rgb = mix(diffuseColor.rgb, ink.rgb, ink.a);
      }
    `);
  };
  material.customProgramCacheKey = () => `printed-kit-${scale}`;
}

// x, y, z must be orthonormal and right-handed (x = y × z).
function placeBasis(obj, pos, x, y, z) {
  _m.makeBasis(x, y, z);
  obj.quaternion.setFromRotationMatrix(_m);
  obj.position.copy(pos);
}

// Analytic two-bone IK: returns the middle joint for root -> target with bone
// lengths l1, l2, bending towards `pole`. Writes into `out`.
export function solveTwoBone(root, target, l1, l2, pole, out) {
  const d = _b.subVectors(target, root);
  let dist = d.length();
  const dir = d.divideScalar(dist || 1);
  dist = Math.min(Math.max(dist, Math.abs(l1 - l2) + 1e-4), l1 + l2 - 1e-4);
  const a = (l1 * l1 + dist * dist - l2 * l2) / (2 * dist);
  const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
  const p = _c.copy(pole).addScaledVector(dir, -pole.dot(dir));
  if (p.lengthSq() < 1e-10) p.set(0, 0, 1).addScaledVector(dir, -dir.z);
  p.normalize();
  return out.copy(root).addScaledVector(dir, a).addScaledVector(p, h);
}

function keepKneeAboveGround(hip,ankle,knee,height) {
  if(knee.y>=height)return;
  const direction=ankle.clone().sub(hip).normalize();
  const center=hip.clone().addScaledVector(direction,knee.clone().sub(hip).dot(direction));
  const radius=knee.clone().sub(center),length=radius.length();
  const vertical=Y.clone().addScaledVector(direction,-direction.y);
  if(vertical.lengthSq()<1e-8||length<1e-5)return;
  vertical.normalize();
  const sideways=new THREE.Vector3().crossVectors(direction,vertical).normalize();
  const amount=THREE.MathUtils.clamp((height-center.y)/(length*vertical.y),-1,1);
  const sign=radius.dot(sideways)<0?-1:1;
  knee.copy(center).addScaledVector(vertical,length*amount).addScaledVector(sideways,length*sign*Math.sqrt(Math.max(0,1-amount*amount)));
}

function keepElbowClearOfBall(shoulder,wrist,elbow,ball,radius,weight) {
  const direction=wrist.clone().sub(shoulder).normalize();
  const center=shoulder.clone().addScaledVector(direction,elbow.clone().sub(shoulder).dot(direction));
  const away=center.clone().sub(ball).addScaledVector(direction,-center.clone().sub(ball).dot(direction));
  if(away.lengthSq()<1e-8)return;
  away.normalize();
  const distance=(a,b)=>{
    const delta=b.clone().sub(a),u=THREE.MathUtils.clamp(ball.clone().sub(a).dot(delta)/delta.lengthSq(),0,1);
    return a.clone().addScaledVector(delta,u).distanceTo(ball);
  };
  // Rotate on the IK solution circle: both arm lengths and the locked wrist
  // stay fixed while the clothed forearm moves clear of the held ball.
  const gap=Math.min(distance(shoulder,elbow),distance(elbow,wrist));
  if(gap>=radius)return;
  const radial=elbow.clone().sub(center),unit=radial.clone().normalize();
  const angle=Math.atan2(direction.dot(new THREE.Vector3().crossVectors(unit,away)),unit.dot(away));
  const correction=THREE.MathUtils.clamp(angle,-.35,.35)*THREE.MathUtils.smoothstep(radius-gap,0,.03)*weight;
  elbow.copy(center).add(radial.applyAxisAngle(direction,correction));
}

import { playerAssets } from './player-assets.js';

function basisQuaternion(y, forward = new THREE.Vector3(0, 0, 1)) {
  const z = forward.clone().addScaledVector(y, -forward.dot(y));
  if (z.lengthSq() < 1e-8) z.set(0, 1, 0).addScaledVector(y, -y.y);
  z.normalize();
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3().crossVectors(y, z), y, z));
}

function hingeQuaternion(y, planeNormal) {
  const x = planeNormal.clone().addScaledVector(y, -planeNormal.dot(y)).normalize();
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, new THREE.Vector3().crossVectors(x, y)));
}

function hingePlane(root, target, pole, lateral, sign = 1) {
  const direction = target.clone().sub(root).normalize();
  const normal = new THREE.Vector3().crossVectors(direction, pole);
  if (normal.lengthSq() < 1e-8) normal.copy(lateral).addScaledVector(direction, -lateral.dot(direction));
  else normal.multiplyScalar(sign);
  return normal.normalize();
}

function armFrame(direction,side) {
  // Carry roll from an outward, forward reach. This keeps the reference's
  // singular direction behind the opposite shoulder, outside ordinary reach.
  // References based on arm azimuth can spin when an arm passes overhead.
  const reference=new THREE.Vector3(side*.35,-.15,.925).normalize();
  return new THREE.Quaternion().setFromUnitVectors(reference,direction)
    .multiply(basisQuaternion(reference));
}

export class Humanoid {
  constructor({ scale = 1, kit }) {
    const S = this.S = scale;
    this.group = new THREE.Group();
    this.pelvis = new THREE.Group(); this.torso = new THREE.Group(); this.head = new THREE.Group();
    this.group.add(this.pelvis, this.torso, this.head);
    this.joints = {};
    this.rest = {};
    const bones = playerAssets.bones.map(spec => {
      const bone = new THREE.Bone(); bone.name = spec.name;
      const start = new THREE.Vector3().fromArray(spec.start).multiplyScalar(S);
      const end = new THREE.Vector3().fromArray(spec.end).multiplyScalar(S);
      const dir = end.clone().sub(start).normalize();
      bone.position.copy(start); bone.quaternion.copy(basisQuaternion(dir));
      this.group.add(bone); this.joints[spec.name] = bone;
      this.rest[spec.name] = {start, end, length: start.distanceTo(end)};
      return bone;
    });
    // Bind elbow and knee roll to their anatomical hinge planes. Facing a
    // limb toward a world axis can flip its roll as the limb crosses that axis.
    for (const side of ['L', 'R']) {
      for (const [upper, lower] of [['upper.', 'fore.'], ['thigh.', 'shin.']]) {
        const a = this.rest[upper+side], b = this.rest[lower+side];
        const plane = a.end.clone().sub(a.start).cross(b.end.clone().sub(b.start)).normalize();
        if (plane.x < 0) plane.negate();
        for (const name of [upper+side, lower+side]) {
          const rest = this.rest[name];
          this.joints[name].quaternion.copy(hingeQuaternion(rest.end.clone().sub(rest.start).normalize(), plane));
        }
      }
    }
    this.group.updateMatrixWorld(true);
    this.skeleton = new THREE.Skeleton(bones);
    this.skeleton.calculateInverses();
    this.bindRotation = Object.fromEntries(bones.map(b => [b.name, b.quaternion.clone()]));
    this.palmLocal={};this.palmOffset={};
    for(const side of ['L','R']){
      const wrist=this.rest['hand.'+side].start;
      const middle=this.rest['finger3-1.'+side].start.clone().sub(wrist);
      const across=this.rest['finger5-1.'+side].start.clone().sub(this.rest['finger2-1.'+side].start);
      const palm=middle.cross(across).normalize();
      if(palm.x*(side==='L'?1:-1)>0)palm.negate();
      palm.applyQuaternion(this.bindRotation['hand.'+side].clone().invert()).setY(0).normalize();
      this.palmLocal[side]=palm;
      const centre=new THREE.Vector3();
      for(let finger=2;finger<=5;finger++)centre.add(this.rest[`finger${finger}-1.${side}`].start);
      this.palmOffset[side]=centre.multiplyScalar(.25).sub(wrist).multiplyScalar(.55);
    }
    this.armCorrection = Object.fromEntries(bones.filter(b=>/^(upper|fore|hand)\./.test(b.name)).map(b => {
      const rest=this.rest[b.name],direction=rest.end.clone().sub(rest.start).normalize();
      return [b.name,armFrame(direction,b.name.endsWith('L')?1:-1).invert().multiply(b.quaternion)];
    }));
    this.armHingeNormal={};this.elbowRest={};
    for(const side of ['L','R']){
      const upper=this.rest['upper.'+side],fore=this.rest['fore.'+side];
      const a=upper.end.clone().sub(upper.start).normalize(),b=fore.end.clone().sub(fore.start).normalize();
      const normal=new THREE.Vector3().crossVectors(a,b).normalize();
      const reach=this.rest['hand.'+side].start.clone().sub(upper.start).normalize();
      this.elbowRest[side]={pole:a.clone().applyQuaternion(new THREE.Quaternion().setFromUnitVectors(reach,new THREE.Vector3(0,0,1)))};
      for(const part of ['upper','fore']){
        const name=part+'.'+side;
        this.armHingeNormal[name]=normal.clone().applyQuaternion(this.bindRotation[name].clone().invert());
      }
    }
    this.handOffset = (kit.gloves ? .11 : .075)*S;
    this.dim = {
      hipW: this.rest['thigh.L'].start.x, thigh: this.rest['thigh.L'].length, shin: this.rest['shin.L'].length,
      spine: this.rest['upper.L'].start.y, shoulderW: this.rest['upper.L'].start.x, shoulderDrop: 0,
      upperArm: this.rest['upper.L'].length, foreArm: this.rest['fore.L'].length + this.handOffset, headUp: this.rest.head.start.y,
    };
    const add = (geo, mat, parent = this.group) => {
      const m = new THREE.Mesh(geo, mat); m.castShadow = true; parent.add(m); return m;
    };
    const skin = new THREE.MeshPhysicalMaterial({map: playerAssets.textures.skin,
      color: new THREE.Color(kit.skin).lerp(new THREE.Color(0xffffff), .82),
      bumpMap: playerAssets.textures.relief, bumpScale: .0003*S, roughness: .63,
      sheen: .12, sheenColor: new THREE.Color(0xca8770), sheenRoughness: .7});
    const shirt = fabric(0xffffff, {side: THREE.DoubleSide});
    printKit(shirt, kit, S);
    const shorts = fabric(kit.shorts, {side: THREE.DoubleSide});
    const socks = fabric(kit.socks);
    const glove = new THREE.MeshPhysicalMaterial({color: kit.gloves ?? kit.skin,
      bumpMap: pores, bumpScale: .0004, roughness: .72});
    const skinned = (name, mat, extra = 0) => {
      const g = playerAssets.geometries[name].clone();
      if (extra) {
        const p=g.attributes.position, n=g.attributes.normal;
        for(let i=0;i<p.count;i++)p.setXYZ(i,p.getX(i)+n.getX(i)*extra,p.getY(i)+n.getY(i)*extra,p.getZ(i)+n.getZ(i)*extra);
      }
      g.scale(S,S,S);
      const m = new THREE.SkinnedMesh(g, mat);
      m.castShadow = true; m.receiveShadow = true; m.frustumCulled = false;
      this.group.add(m); m.bind(this.skeleton, new THREE.Matrix4());
      this.meshes.push(m); return m;
    };
    this.meshes=[];
    const body=skinned('skin',skin);
    // Garments cover the body; the keeper's sleeves and gloves cover bare arms.
    if(kit.longSleeves){
      const g=body.geometry, ids=g.index.array, sw=g.attributes.skinWeight, si=g.attributes.skinIndex;
      const filtered=[];
      for(let j=0;j<ids.length;j+=3){
        let arm=0;
        for(let c=0;c<3;c++)for(let k=0;k<4;k++){
          const b=bones[si.array[ids[j+c]*4+k]].name;
          if(b.startsWith('upper.')||b.startsWith('fore.')||b.startsWith('hand.')||b.startsWith('finger'))arm+=sw.array[ids[j+c]*4+k];
        }
        if(arm<.7)filtered.push(ids[j],ids[j+1],ids[j+2]);
      }
      g.setIndex(filtered);
    }
    const jersey=skinned(kit.longSleeves?'shirt-long':'shirt-short',shirt,.001);
    const armBlend=[];
    const sw=jersey.geometry.attributes.skinWeight, si=jersey.geometry.attributes.skinIndex;
    for(let i=0;i<sw.count;i++){
      let arm=0;
      for(let k=0;k<4;k++){const n=bones[si.array[i*4+k]].name;if(n.startsWith('upper.')||n.startsWith('fore.'))arm+=sw.array[i*4+k];}
      armBlend.push(arm);
    }
    jersey.geometry.setAttribute('armBlend',new THREE.Float32BufferAttribute(armBlend,1));
    skinned('shorts',shorts,.002);skinned('socks',socks,.0013);
    if(kit.gloves){
      const gm=skinned('gloves',glove,.0045),p=gm.geometry.attributes.position,colors=[];
      const latex=new THREE.Color(kit.gloves),strap=new THREE.Color(kit.gloveStrap??kit.sleeve);
      for(let i=0;i<p.count;i++){
        const side=p.getX(i)>0?'L':'R',rest=this.rest['hand.'+side];
        const axis=rest.end.clone().sub(rest.start).normalize();
        const distance=new THREE.Vector3(p.getX(i),p.getY(i),p.getZ(i)).sub(rest.start).dot(axis)/S;
        const color=distance<.024?strap:latex;colors.push(color.r,color.g,color.b);
      }
      glove.color.set(0xffffff);glove.vertexColors=true;
      gm.geometry.setAttribute('color',new THREE.Float32BufferAttribute(colors,3));
    }
    skinned('eyes',new THREE.MeshPhysicalMaterial({map:playerAssets.textures.eyes,alphaTest:.1,
      roughness:.22,clearcoat:1,clearcoatRoughness:.12}));
    const hairName=kit.gloves?'hair-crop':'hair-short';
    skinned(hairName,new THREE.MeshStandardMaterial({map:playerAssets.textures[hairName],
      color:new THREE.Color(kit.hair).lerp(new THREE.Color(0xffffff),.22),alphaTest:.2,
      alphaToCoverage:true,side:THREE.DoubleSide,roughness:.92}));
    skinned('brows',new THREE.MeshStandardMaterial({map:playerAssets.textures.brows,color:kit.hair,
      alphaTest:.2,alphaToCoverage:true,side:THREE.DoubleSide,roughness:1}));
    const bootMat = new THREE.MeshPhysicalMaterial({color:kit.boots,bumpMap:pores,bumpScale:.0006,
      roughness:.43,clearcoat:.25,clearcoatRoughness:.48});
    const soleMat=new THREE.MeshStandardMaterial({color:0x3a3d45,roughness:.6});
    this.arms = [0,1].map(()=>({hand:new THREE.Group()}));
    this.arms.forEach(a=>this.group.add(a.hand));
    this.legs = [0,1].map(()=>({boot:this.buildBoot(bootMat,soleMat,add)}));
    this.elbows=[new THREE.Vector3(),new THREE.Vector3()];this.knees=[new THREE.Vector3(),new THREE.Vector3()];
    this.groundShadows=[contactShadow(.24),contactShadow(.24),contactShadow(.55)];
    this.group.add(...this.groundShadows);
  }
  buildBoot(bootMat, soleMat, add) {
    const S = this.S;
    const g = new THREE.Group();
    this.group.add(g);
    add(bootGeometry(S), bootMat, g);
    add(bootGeometry(S, true), soleMat, g);
    const ankle = add(new THREE.SphereGeometry(0.045 * S, 12, 10), bootMat, g);
    ankle.scale.set(1, 1.1, 1);
    ankle.position.z = -0.023 * S;
    const laceMat = new THREE.MeshStandardMaterial({ color: 0xdedfd6, roughness: 0.9 });
    for (let j = 0; j < 5; j++) {
      for (const s of [-1, 1]) {
        const a = new THREE.Vector3(-s * 0.024 * S, -0.006 * S - j * 0.002 * S, (0.018 + j * 0.019) * S);
        const b = new THREE.Vector3(s * 0.024 * S, a.y - 0.001 * S, a.z + 0.014 * S);
        const lace = add(new THREE.CylinderGeometry(0.0018 * S, 0.0018 * S, a.distanceTo(b), 5), laceMat, g);
        lace.position.copy(a).lerp(b, 0.5); lace.quaternion.setFromUnitVectors(Y, b.sub(a).normalize());
      }
    }
    for (const z of [-0.045, 0.08, 0.16]) {
      for (const s of [-1, 1]) {
        const stud = add(new THREE.CylinderGeometry(0.008 * S, 0.006 * S, 0.012 * S, 8), soleMat, g);
        stud.position.set(s * 0.028 * S, -0.087 * S, z * S);
      }
    }
    const heel = add(new THREE.SphereGeometry(0.039 * S, 16, 10), soleMat, g);
    heel.scale.set(1, 0.55, 0.23); heel.position.set(0, -0.037 * S, -0.064 * S);
    return g;
  }

  transportRotation(name,direction,bodyRotation,forward) {
    const local=direction.clone().applyQuaternion(bodyRotation.clone().invert());
    return bodyRotation.clone().multiply(armFrame(local,name.endsWith('L')?1:-1)).multiply(this.armCorrection[name]);
  }

  armHingeRotation(name,direction,normal,chestRotation) {
    const rotation=this.transportRotation(name,direction,chestRotation);
    const current=this.armHingeNormal[name].clone().applyQuaternion(rotation);
    const sine=direction.dot(new THREE.Vector3().crossVectors(current,normal));
    // Near full extension the elbow plane is poorly defined. Bound skin roll
    // around the shared hinge instead of spinning a sleeve to follow that
    // plane through 180 degrees. This is stateless and continuous at wraparound.
    return rotation.premultiply(new THREE.Quaternion().setFromAxisAngle(direction,.8*sine));
  }

  anatomicalElbowPole(side,shoulder,target,chestRotation,requested) {
    const axis=target.clone().sub(shoulder).normalize(),rest=this.elbowRest[side];
    const local=axis.clone().applyQuaternion(chestRotation.clone().invert());
    const turn=new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0,0,1),local);
    const base=rest.pole.clone().applyQuaternion(turn).applyQuaternion(chestRotation);
    base.addScaledVector(axis,-base.dot(axis)).normalize();
    if(!requested)return base;
    const desired=requested.clone().addScaledVector(axis,-requested.dot(axis));
    const length=desired.length();
    if(length<1e-5)return base;
    // A fixed world pole becomes singular when the arm passes through it.
    // Transport the native elbow bend with the shoulder, then allow a bounded
    // contribution from the authored pole. The bend cannot change sides.
    const authored=.35*THREE.MathUtils.smoothstep(length,.05,.35);
    base.multiplyScalar(1-authored).addScaledVector(desired.divideScalar(length),authored).normalize();
    const floor=Y.clone().addScaledVector(axis,-axis.y);
    if(floor.lengthSq()>1e-6){
      const support=.3*(1-THREE.MathUtils.smoothstep(Math.max(shoulder.y,target.y)/this.S,.20,.55));
      base.lerp(floor.normalize(),support).normalize();
    }
    return base;
  }

  // Carry the native forward knee bend with the hip-to-ankle direction. A
  // world-space pole alone can reverse the knee as the foot passes underneath.
  transportedKneePole(hip,ankle,bodyRotation,requested,weight) {
    const axis=ankle.clone().sub(hip).normalize(),local=axis.clone().applyQuaternion(bodyRotation.clone().invert());
    const turn=new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0,-1,0),local);
    const base=new THREE.Vector3(0,0,1).applyQuaternion(turn).applyQuaternion(bodyRotation);
    const desired=requested.clone().addScaledVector(axis,-requested.dot(axis)),length=desired.length();
    if(length>1e-5)base.multiplyScalar(.75).addScaledVector(desired.divideScalar(length),.25).normalize();
    const original=requested.clone().addScaledVector(axis,-requested.dot(axis));
    if(original.lengthSq()<1e-8)return base;
    return original.normalize().lerp(base,weight).normalize();
  }

  segment(name, a, b, forward, plane, bodyRotation) {
    const bone=this.joints[name],delta=b.clone().sub(a),length=delta.length();
    delta.divideScalar(length||1);
    bone.position.copy(a);
    if(bodyRotation){
      bone.quaternion.copy(this.transportRotation(name,delta,bodyRotation,forward));
    }else bone.quaternion.copy(plane ? hingeQuaternion(delta, plane) : basisQuaternion(delta,forward));
    bone.scale.set(1,length/this.rest[name].length,1);
  }

  poseFingers(side, palm, grip, spread=0,ballGrip,ground=0) {
    const hand = this.joints['hand.' + side], wrist = this.rest['hand.' + side].start;
    const base = hand.quaternion.clone().multiply(this.bindRotation['hand.' + side].clone().invert());
    for (let finger = 1; finger <= 5; finger++) {
      let transform = base.clone(), end = null, previous = null;
      for (let segment = 1; segment <= 3; segment++) {
        const name = `finger${finger}-${segment}.${side}`, bone = this.joints[name], rest = this.rest[name];
        const start = end ? end.clone().add(rest.start.clone().sub(previous.end).applyQuaternion(transform))
          : hand.position.clone().add(rest.start.clone().sub(wrist).applyQuaternion(transform));
        let direction = rest.end.clone().sub(rest.start).applyQuaternion(transform).normalize();
        if(finger>1&&segment===1&&spread){
          transform.premultiply(new THREE.Quaternion().setFromAxisAngle(palm,(3.5-finger)*.07*spread*(side==='L'?1:-1)));
          direction=rest.end.clone().sub(rest.start).applyQuaternion(transform).normalize();
        }
        if(finger===1&&segment===1){
          const opposed=this.rest['finger3-1.'+side].start.clone().sub(rest.start).applyQuaternion(base).normalize();
          const turn=new THREE.Quaternion().setFromUnitVectors(direction,opposed);
          transform.premultiply(new THREE.Quaternion().slerp(turn,grip*.7));
          direction=rest.end.clone().sub(rest.start).applyQuaternion(transform).normalize();
        }
        const normal = palm.clone().applyQuaternion(transform.clone().multiply(base.clone().invert()));
        const axis = new THREE.Vector3().crossVectors(direction, normal).normalize();
        const angle = grip * [0, .95, 1.25, .85][segment] * (finger === 1 ? .55 : 1);
        transform.premultiply(new THREE.Quaternion().setFromAxisAngle(axis, angle));
        const weight=ballGrip?.weight[side==='L'?'l':'r']||0;
        if(weight){
          const radial=start.clone().sub(ballGrip.center),radius=ballGrip.radius+(finger===1?.031:.019)*this.S;
          if(radial.length()<radius)start.addScaledVector(radial.clone().normalize(),(radius-radial.length())*weight);
          radial.copy(start).sub(ballGrip.center);
          const length=radial.length(),unit=radial.divideScalar(length||1);
          const curled=rest.end.clone().sub(rest.start).applyQuaternion(transform).normalize();
          const minimum=-Math.sqrt(Math.max(0,1-(radius/Math.max(radius,length))**2));
          const dot=curled.dot(unit);
          if(dot<minimum){
            const tangent=curled.clone().addScaledVector(unit,-dot).normalize();
            const safe=tangent.multiplyScalar(Math.sqrt(1-minimum*minimum)).addScaledVector(unit,minimum);
            const corrected=curled.clone().lerp(safe,weight).normalize();
            transform.premultiply(new THREE.Quaternion().setFromUnitVectors(curled,corrected));
          }
        }
        if(ground){
          // Flatten the thumb as well as the fingers when bearing weight.
          // Its native opposed rest pose otherwise points through the turf.
          const floor=.018*this.S,length=rest.end.distanceTo(rest.start);
          start.y+=Math.max(0,floor-start.y)*ground;
          const minimum=THREE.MathUtils.clamp((floor-start.y)/length,-1,1);
          const current=rest.end.clone().sub(rest.start).applyQuaternion(transform).normalize();
          if(current.y<minimum){
            const flat=current.clone().setY(0).normalize().multiplyScalar(Math.sqrt(1-minimum*minimum)).setY(minimum);
            const desired=current.clone().lerp(flat,ground).normalize();
            transform.premultiply(new THREE.Quaternion().setFromUnitVectors(current,desired));
          }
        }
        bone.position.copy(start);bone.quaternion.copy(transform).multiply(this.bindRotation[name]);
        end = start.clone().add(rest.end.clone().sub(rest.start).applyQuaternion(transform));
        previous = rest;
      }
    }
  }

  setPose(p) {
    const d=this.dim,S=this.S;
    const up=p.up.clone().normalize(),fwd=p.fwd.clone().addScaledVector(up,-p.fwd.dot(up)).normalize();
    const left=new THREE.Vector3().crossVectors(up,fwd);
    placeBasis(this.pelvis,p.pelvis,left,up,fwd);
    placeBasis(this.joints.pelvis,p.pelvis,left,up,fwd);
    const spine=torsoFrame(p,S),cUp=spine.up,cFwd=spine.fwd,cLeft=spine.left;
    const chestRotation=new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(cLeft,cUp,cFwd));
    placeBasis(this.torso,spine.origin,cLeft,cUp,cFwd);
    placeBasis(this.joints.chest,spine.origin,cLeft,cUp,cFwd);
    const aUp=spine.abdomenUp,aFwd=spine.abdomenFwd;
    placeBasis(this.joints.abdomen,spine.abdomenOrigin,new THREE.Vector3().crossVectors(aUp,aFwd).normalize(),aUp,aFwd);
    this.joints.chest.scale.set(1+(p.breath||0)*.005,1,1+(p.breath||0)*.008);
    const shoulders=['L','R'].map(side=>{
      const rest=this.rest['upper.'+side].start;
      return spine.origin.clone().addScaledVector(cLeft,rest.x).addScaledVector(cUp,rest.y).addScaledVector(cFwd,rest.z);
    });
    if(p.shoulderReach)for(const [i,key] of [[0,'l'],[1,'r']]){
      const reach=p.hands[key].clone().sub(shoulders[i]),distance=reach.length();
      const protraction=Math.min(.06*S,Math.max(0,distance-(d.upperArm+d.foreArm-.02*S)))*p.shoulderReach;
      shoulders[i].addScaledVector(reach.divideScalar(distance||1),protraction);
    }
    const neck=spine.origin.clone().addScaledVector(cUp,this.rest.neck.start.y).addScaledVector(cFwd,this.rest.neck.start.z);
    const headC=spine.origin.clone().addScaledVector(cUp,d.headUp).addScaledVector(cFwd,this.rest.head.start.z);
    let look=p.look?p.look.clone().sub(headC).normalize():cFwd.clone();
    const angle=look.angleTo(cFwd);
    if(angle>1.1){const axis=new THREE.Vector3().crossVectors(cFwd,look);if(axis.lengthSq()<1e-8)axis.copy(cUp);look=cFwd.clone().applyAxisAngle(axis.normalize(),1.1);}
    const hUp=cUp.clone().addScaledVector(look,-cUp.dot(look)).normalize(),hLeft=new THREE.Vector3().crossVectors(hUp,look);
    placeBasis(this.head,headC,hLeft,hUp,look);placeBasis(this.joints.head,headC,hLeft,hUp,look);
    this.segment('neck',neck,headC,cFwd);
    for(let i=0;i<2;i++){
      const side=i?'R':'L',s=i?-1:1,key=i?'r':'l',target=p.hands[key];
      const authoredPole=p.elbowPole?.[key]||cLeft.clone().multiplyScalar(s*.55).addScaledVector(cFwd,-.45).addScaledVector(cUp,-.7);
      const pole=p.anatomicalArms?this.anatomicalElbowPole(side,shoulders[i],target,chestRotation,authoredPole):authoredPole;
      // Any reach correction is shared by both segments, preserving proportion.
      const stretch=Math.max(1,shoulders[i].distanceTo(target)/(d.upperArm+d.foreArm-.002*S));
      const elbow=solveTwoBone(shoulders[i],target,d.upperArm*stretch,d.foreArm*stretch,pole,this.elbows[i]);
      const axis=target.clone().sub(elbow).normalize(),wrist=target.clone().addScaledVector(axis,-this.handOffset);
      const wristBend=p.handBend?.[key]||0;
      const handAxis=axis.clone().lerp(p.handDirection?.[key]||axis,wristBend).normalize();
      const desiredPalm=(p.palm?.[key]||cFwd).clone().addScaledVector(handAxis,-(p.palm?.[key]||cFwd).dot(handAxis));
      const armPlane=hingePlane(shoulders[i],target,pole,cLeft);
      // Transport the native wrist frame with the arm, then add bounded
      // pronation. A palm target passing through the forearm axis cannot flip it.
      const hand=this.joints['hand.'+side],handName='hand.'+side;
      hand.position.copy(wrist);
      if(p.anatomicalArms){
        const upper=elbow.clone().sub(shoulders[i]).normalize(),fore=wrist.clone().sub(elbow).normalize();
        const normal=new THREE.Vector3().crossVectors(upper,fore).normalize();
        const foreRotation=this.armHingeRotation('fore.'+side,fore,normal,chestRotation).multiply(this.bindRotation['fore.'+side].clone().invert());
        hand.quaternion.copy(foreRotation).multiply(this.bindRotation[handName]);
        const nativeAxis=Y.clone().applyQuaternion(hand.quaternion);
        hand.quaternion.premultiply(new THREE.Quaternion().setFromUnitVectors(nativeAxis,handAxis));
      }else hand.quaternion.copy(this.transportRotation(handName,handAxis,chestRotation,cFwd));
      const palm=this.palmLocal[side].clone().applyQuaternion(hand.quaternion).normalize();
      let pronation=0;
      if(desiredPalm.lengthSq()>1e-8){
        desiredPalm.normalize();
        const sine=handAxis.dot(new THREE.Vector3().crossVectors(palm,desiredPalm));
        pronation=.8*sine;
      }
      hand.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(handAxis,pronation));
      if(wristBend&&desiredPalm.lengthSq()>1e-8){
        const local=this.palmLocal[side],roll=new THREE.Quaternion().setFromAxisAngle(Y,Math.atan2(-local.x,local.z));
        hand.quaternion.slerp(basisQuaternion(handAxis,desiredPalm).multiply(roll),wristBend);
      }
      const lock=p.palmLock?.[key]||0;
      if(lock){
        const fingers=(p.handDirection?.[key]||cUp).clone().normalize();
        const normal=(p.palm?.[key]||cFwd).clone().addScaledVector(fingers,-(p.palm?.[key]||cFwd).dot(fingers)).normalize();
        const local=this.palmLocal[side],roll=new THREE.Quaternion().setFromAxisAngle(Y,Math.atan2(-local.x,local.z));
        hand.quaternion.slerp(basisQuaternion(fingers,normal).multiply(roll),lock);
        const offset=this.palmOffset[side].clone().applyQuaternion(this.bindRotation[handName].clone().invert()).applyQuaternion(hand.quaternion);
        const contactWrist=target.clone().sub(offset);
        wrist.lerp(contactWrist,lock);
        const upper=d.upperArm,fore=d.foreArm-this.handOffset;
        const reach=Math.max(1,shoulders[i].distanceTo(wrist)/(upper+fore-.002*S));
        solveTwoBone(shoulders[i],wrist,upper*reach,fore*reach,pole,elbow);
        if(p.ballGrip)keepElbowClearOfBall(shoulders[i],wrist,elbow,p.ballGrip.center,p.ballGrip.radius+.06*S,p.ballGrip.weight[key]);
        hand.position.copy(wrist);
      }
      if(p.anatomicalArms)keepKneeAboveGround(shoulders[i],wrist,elbow,.10*S);
      this.segment('upper.'+side,shoulders[i],elbow,cFwd,armPlane,chestRotation);
      this.segment('fore.'+side,elbow,wrist,cFwd,armPlane,chestRotation);
      if(p.anatomicalArms){
        const upper=elbow.clone().sub(shoulders[i]).normalize(),fore=wrist.clone().sub(elbow).normalize();
        const normal=new THREE.Vector3().crossVectors(upper,fore).normalize();
        // Both segments use the same elbow bend plane, with bounded skin roll
        // when that plane becomes ill-defined near full extension.
        this.joints['upper.'+side].quaternion.copy(this.armHingeRotation('upper.'+side,upper,normal,chestRotation));
        this.joints['fore.'+side].quaternion.copy(this.armHingeRotation('fore.'+side,fore,normal,chestRotation));
      }
      palm.copy(this.palmLocal[side]).applyQuaternion(hand.quaternion);
      this.arms[i].hand.position.copy(target);this.arms[i].hand.quaternion.copy(hand.quaternion);
      this.joints['fore.'+side].quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(wrist.clone().sub(elbow).normalize(),pronation*.35*(1-lock)));
      this.poseFingers(side,palm,(p.grip?.[key]??.25)*(1-wristBend),p.spread?.[key]||0,p.ballGrip,p.groundHands?.[key]||0);
      const ankle=p.feet[key].clone();
      const hipRest=this.rest['thigh.'+side].start;
      const hip=p.pelvis.clone().addScaledVector(left,hipRest.x).addScaledVector(up,hipRest.y).addScaledVector(fwd,hipRest.z);
      let kneePole=p.kneePole?.[key]||fwd.clone().addScaledVector(left,s*.12);
      if(p.legTransport)kneePole=this.transportedKneePole(hip,ankle,this.pelvis.quaternion,kneePole,p.legTransport);
      const legStretch=Math.max(1,hip.distanceTo(ankle)/(d.thigh+d.shin-.002*S));
      const knee=solveTwoBone(hip,ankle,d.thigh*legStretch,d.shin*legStretch,kneePole,this.knees[i]);
      keepKneeAboveGround(hip,ankle,knee,.075*S);
      let legPlane=hingePlane(hip,ankle,knee.clone().sub(hip),left,-1);
      this.segment('thigh.'+side,hip,knee,fwd,legPlane);this.segment('shin.'+side,knee,ankle,fwd,legPlane);
      const shinUp=knee.clone().sub(ankle).normalize(),bootUp=p.footUp?.[key]?.clone().normalize() || (ankle.y<=.105*S?Y:shinUp);
      const toe=(p.toe?.[key]||fwd).clone().addScaledVector(bootUp,-(p.toe?.[key]||fwd).dot(bootUp));
      if(toe.lengthSq()<1e-8)toe.copy(fwd);toe.normalize();
      const bx=new THREE.Vector3().crossVectors(bootUp,toe);
      placeBasis(this.legs[i].boot,ankle,bx,bootUp,toe);
      // Solve sole clearance before finalizing the leg. This permits an ankle
      // roll over a planted toe without sending the heel through the turf.
      const boot=this.legs[i].boot,sole=new THREE.Vector3();
      let lowest=Infinity;
      for(const x of [-.05,.05])for(const z of [-.075,.226]){
        sole.set(x*S,-.093*S,z*S).applyQuaternion(boot.quaternion).add(ankle);
        lowest=Math.min(lowest,sole.y);
      }
      if(lowest<.001){
        ankle.y+=.001-lowest;boot.position.copy(ankle);
        const stretch=Math.max(1,hip.distanceTo(ankle)/(d.thigh+d.shin-.002*S));
        solveTwoBone(hip,ankle,d.thigh*stretch,d.shin*stretch,kneePole,knee);
        keepKneeAboveGround(hip,ankle,knee,.075*S);
        legPlane=hingePlane(hip,ankle,knee.clone().sub(hip),left,-1);
        this.segment('thigh.'+side,hip,knee,fwd,legPlane);this.segment('shin.'+side,knee,ankle,fwd,legPlane);
      }
      // The anatomical feet are covered by the studded boots.
      const foot=this.joints['foot.'+side];foot.position.copy(ankle);foot.quaternion.copy(basisQuaternion(toe,bootUp));
      const shadow=this.groundShadows[i];shadow.position.set(ankle.x,.009,ankle.z+toe.z*.05);shadow.scale.set(.65,1.1,1);
      shadow.material.opacity=.75*Math.exp(-Math.max(0,ankle.y-.09*S)*7);
    }
    const shadow=this.groundShadows[2];shadow.position.set(p.pelvis.x,.008,p.pelvis.z);shadow.scale.set(1.2,.75,1);shadow.material.opacity=.2*Math.exp(-Math.max(0,p.pelvis.y-.7)*2);
  }
}
