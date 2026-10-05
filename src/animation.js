// Display-only body animation. Every function here is a pure function of time
// and of data the physics already produced (keeper pose per frame, launch,
// outcome); nothing feeds back into the simulation.
//
// Time convention: t = seconds relative to the moment of contact (negative
// during the run-up), or null while the player is still aiming.
import * as THREE from 'three';
import * as P from './physics.js?v=19';
import { sampleKick, captureTime, kickModel } from './kick-motion.js?v=2';
import { capturedBodyPose, sampleBodyMotion, motionClips } from './body-motion.js';
import { torsoFrame } from './pose-math.js';

const { KEEPER, GOAL } = P;
const KS = KEEPER.SCALE;
export const RUNUP = 0.85; // seconds from the first stride to contact

const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const UP = V(0, 1, 0);
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (x) => {
  const u = clamp01(x);
  return u * u * (3 - 2 * u);
};
const bump = (t, a, b) => (t <= a || t >= b ? 0 : Math.sin((Math.PI * (t - a)) / (b - a)));

function slerpDir(a, b, u) {
  const ang = a.angleTo(b);
  if (ang < 1e-5) return b.clone();
  const axis = V().crossVectors(a, b);
  if (axis.lengthSq() < 1e-10) axis.crossVectors(a, Math.abs(a.y) < .9 ? UP : V(1, 0, 0));
  return a.clone().applyAxisAngle(axis.normalize(), ang * u);
}

const lerpPair = (a, b, u) => a && b && { l: a.l.clone().lerp(b.l, u), r: a.r.clone().lerp(b.r, u) };
function blendHands(a,b,u) {
  const hands=lerpPair(a.hands,b.hands,u);
  const forward=a.fwd.clone().lerp(b.fwd,u).setY(0);
  if(forward.lengthSq()<1e-6)forward.copy(V(0,0,1));forward.normalize();
  for(const key of ['l','r']){
    const arc=Math.min(.28,a.hands[key].distanceTo(b.hands[key])*.4)*Math.sin(Math.PI*u);
    hands[key].addScaledVector(forward,arc);
  }
  return hands;
}
const directionPair = (p, name) => ({l:p[name]?.l||p.fwd,r:p[name]?.r||p.fwd});
const blendDirections = (a, b, name, u) => {
  const x=directionPair(a,name), y=directionPair(b,name);
  return {l:slerpDir(x.l.clone().normalize(),y.l.clone().normalize(),u),r:slerpDir(x.r.clone().normalize(),y.r.clone().normalize(),u)};
};

function chestAxes(p) {
  return torsoFrame(p,p.articulatedTorso?KS:1);
}

export function blendPose(a, b, u) {
  if (u <= 0) return a;
  if (u >= 1) return b;
  return {
    pelvis: a.pelvis.clone().lerp(b.pelvis, u),
    up: slerpDir(a.up, b.up, u),
    fwd: slerpDir(a.fwd, b.fwd, u),
    bend: (a.bend || 0) + ((b.bend || 0) - (a.bend || 0)) * u,
    twist: (a.twist || 0) + ((b.twist || 0) - (a.twist || 0)) * u,
    breath: (a.breath || 0) + ((b.breath || 0) - (a.breath || 0)) * u,
    hands: blendHands(a,b,u),
    feet: lerpPair(a.feet, b.feet, u),
    look: a.look.clone().lerp(b.look, u),
    palm: blendDirections(a,b,'palm',u),
    toe: blendDirections(a,b,'toe',u),
    elbowPole: blendDirections(a,b,'elbowPole',u),
    kneePole: blendDirections(a,b,'kneePole',u),
    footUp: {l:slerpDir(a.footUp?.l||UP,b.footUp?.l||UP,u),r:slerpDir(a.footUp?.r||UP,b.footUp?.r||UP,u)},
    grip: {l:(a.grip?.l??.25)+((b.grip?.l??.25)-(a.grip?.l??.25))*u,
      r:(a.grip?.r??.25)+((b.grip?.r??.25)-(a.grip?.r??.25))*u},
    palmLock:{l:(a.palmLock?.l||0)+((b.palmLock?.l||0)-(a.palmLock?.l||0))*u,
      r:(a.palmLock?.r||0)+((b.palmLock?.r||0)-(a.palmLock?.r||0))*u},
    groundHands:{l:(a.groundHands?.l||0)+((b.groundHands?.l||0)-(a.groundHands?.l||0))*u,
      r:(a.groundHands?.r||0)+((b.groundHands?.r||0)-(a.groundHands?.r||0))*u},
    spread:{l:(a.spread?.l||0)+((b.spread?.l||0)-(a.spread?.l||0))*u,
      r:(a.spread?.r||0)+((b.spread?.r||0)-(a.spread?.r||0))*u},
    shoulderReach:(a.shoulderReach||0)+((b.shoulderReach||0)-(a.shoulderReach||0))*u,
    legTransport:(a.legTransport||0)+((b.legTransport||0)-(a.legTransport||0))*u,
    articulatedTorso:a.articulatedTorso||b.articulatedTorso,
    anatomicalArms:a.anatomicalArms||b.anatomicalArms,
    handBend:{l:(a.handBend?.l||0)+((b.handBend?.l||0)-(a.handBend?.l||0))*u,
      r:(a.handBend?.r||0)+((b.handBend?.r||0)-(a.handBend?.r||0))*u},
    handDirection:blendDirections(a,b,'handDirection',u),
    ...((a.chestUp || b.chestUp) ? {chestUp:slerpDir(chestAxes(a).up,chestAxes(b).up,u),
      chestFwd:slerpDir(chestAxes(a).fwd,chestAxes(b).fwd,u)} : {}),
  };
}

// A body frame standing at ground point g facing `fwd` (horizontal).
function frame(g, fwd) {
  const f = V(fwd.x, 0, fwd.z).normalize();
  return { g, f, l: V().crossVectors(UP, f) };
}
// Point in that frame: x along the person's left, y absolute height, z forward.
const at = (fr, x, y, z) => fr.g.clone().addScaledVector(fr.l, x).addScaledVector(fr.f, z).setY(y);

// Turn or settle by lifting one foot at a time while the other supports weight.
function stepBlend(a,b,u,S=1) {
  const p=blendPose(a,b,u);
  if(u<=0||u>=1)return p;
  for(const [key,offset] of [['l',0],['r',.4]]){
    const w=smooth((u-offset)/.6);
    p.feet[key]=a.feet[key].clone().lerp(b.feet[key],w);
    p.feet[key].y+=Math.sin(Math.PI*w)*.09*S;
  }
  return p;
}

// ===================================================================== keeper

function byName(caps, name) {
  return caps.find((c) => c.name === name);
}

// The rig's left is the keeper's own left, i.e. world +x (it faces +z).
export function keeperFromPhysics(k) {
  const caps = P.keeperCapsules(k);
  const g = (n) => V(byName(caps, n).a.x, byName(caps, n).a.y, byName(caps, n).a.z);
  const foot = (n) => {
    const c = byName(caps, n);
    return V(c.b.x, c.b.y + 0.012, c.b.z);
  };
  return {
    pelvis: V(k.pos.x, k.pos.y, k.pos.z),
    up: V(k.lean.s, k.lean.c, 0),
    fwd: V(0, 0, 1),
    hands: { l: g('right glove'), r: g('left glove') },
    feet: { l: foot('right leg'), r: foot('left leg') },
  };
}

// ctx: { k, t, clock, ball, plan, outcome, endT, endK, catchState, motionState }
export function keeperPose(ctx) {
  const catching=ctx.catchState && ctx.t!=null && ctx.t>=ctx.catchState.t;
  const ground=catching && ctx.catchState.ground;
  const scramble=!catching && ctx.t!=null && ctx.motionState?.scrambles?.find(s=>ctx.t>=s.t && ctx.t<s.endT);
  const fall=!catching && ctx.t!=null && ctx.motionState?.falls?.find(f=>ctx.t>=f.t && ctx.t<f.until);
  // Once possession is confirmed there are no further ball collisions. Give
  // the caught-ball recovery time to protect it and rise through a real get-up.
  const pose=ground && ctx.t>ground.t
    ? keeperGroundRecovery({...ctx,outcome:'held'},ground)
    : scramble ? keeperRedive(ctx,scramble)
    : fall ? keeperGroundRecovery(ctx,fall)
    : ctx.t!=null && ctx.endT!=null && ctx.t>ctx.endT
      ? keeperAfter(catching?{...ctx,outcome:'held'}:ctx) : keeperLive(ctx);
  pose.articulatedTorso=true;pose.anatomicalArms=true;
  keeperContactResponse(pose,ctx);
  return ctx.catchState ? catchPose(pose,ctx) : pose;
}

// Sample only recorded data when building display metadata. The impact point
// can lie between render frames; rounded event times must not shift the catch.
function recordedSample(sim,t) {
  const frames=sim.frames,index=frames.findIndex(f=>f.t>=t);
  const b=frames[index<0?frames.length-1:index],a=frames[Math.max(0,(index<0?frames.length-1:index)-1)];
  const u=clamp01((t-a.t)/(b.t-a.t||1));
  const position=V(a.k.pos.x,a.k.pos.y,a.k.pos.z).lerp(V(b.k.pos.x,b.k.pos.y,b.k.pos.z),u);
  const lean=new THREE.Vector2(a.k.lean.s,a.k.lean.c).lerp(new THREE.Vector2(b.k.lean.s,b.k.lean.c),u).normalize();
  const arm=key=>{const x=a.k.arms[key],y=b.k.arms[key],v=V(x.x,x.y,x.z).lerp(V(y.x,y.y,y.z),u).normalize();return{x:v.x,y:v.y,z:v.z}};
  return {k:{pos:position,lean:{s:lean.x,c:lean.y},arms:{l:arm('l'),r:arm('r')},
    plant:a.k.plant&&b.k.plant&&a.k.plant.side===b.k.plant.side?a.k.plant:null,
    act:b.k.act&&b.k.act.t0<=t?b.k.act:a.k.act},
    ball:V().fromArray(a.b).lerp(V().fromArray(b.b),u),
    rotation:new THREE.Quaternion().fromArray(a.q).slerp(new THREE.Quaternion().fromArray(b.q),u)};
}

// Locate each return from a dive in the recorded motion. Absolute intervals
// let display arms recover with the body without stateful smoothing or
// changing the engine's delayed arm targets.
export function createKeeperAnimation(sim) {
  const groups=[];
  for(const f of sim.frames){
    if(!f.k.act)continue;
    let group=groups.at(-1);
    if(!group||group.actT0!==f.k.act.t0){group={actT0:f.k.act.t0,frames:[]};groups.push(group);}
    group.frames.push(f);
  }
  const recoveries=[];
  for(const [i,group] of groups.entries()){
    let lowest=0;
    for(let j=1;j<group.frames.length;j++)if(group.frames[j].k.lean.c<group.frames[lowest].k.lean.c)lowest=j;
    const low=group.frames[lowest];
    if(low.k.lean.c>.94||lowest===group.frames.length-1)continue;
    const rise=group.frames.slice(lowest+1).find(f=>f.k.lean.c>low.k.lean.c+.004);
    if(!rise)continue;
    const upright=group.frames.slice(lowest+1).find(f=>f.k.lean.c>.985);
    recoveries.push({t:low.t,actT0:group.actT0,lean:low.k.lean.c,bank:Math.atan2(low.k.lean.s,low.k.lean.c),
      uprightT:upright?.t??sim.frames.at(-1).t,until:groups[i+1]?.actT0??Infinity});
  }
  const touches=(sim.result.contacts||[]).filter(c=>c.t<=sim.frames.at(-1).t);
  const contacts=[...new Set([...sim.events.filter(e=>e.type==='keeper'||e.type==='catch').map(e=>e.t),...touches.map(c=>c.t)])].sort((a,b)=>a-b);
  const impacts=touches.filter(c=>c.decision==='parry').map(c=>{
    const incoming=recordedSample(sim,c.t-.004).ball.sub(recordedSample(sim,c.t-.016).ball).normalize();
    const outgoing=recordedSample(sim,c.t+.028).ball.sub(recordedSample(sim,c.t+.012).ball).normalize();
    const twoHands=c.kind==='glove' && c.how==='with both hands';
    return {...structuredClone(c),twoHands,incoming:incoming.toArray(),outgoing:outgoing.toArray()};
  });
  const falls=[];
  if(!sim.result.caught)for(const [i,group] of groups.entries()){
    // Start after the last touch in this dive, before the engine's quick rise.
    // A clear window can fit a complete weight-bearing recovery. Short
    // windows use the low brace/plant sequence below before the next dive.
    const until=groups[i+1]?.actT0??Infinity;
    const landing=group.frames.find(f=>f.t>group.actT0+.22 && f.k.lean.c<.86 &&
      f.k.pos.y<=KS*(.15*Math.abs(f.k.lean.s)+.85*f.k.lean.c+.08)+.012);
    if(!landing)continue;
    const lastContact=contacts.filter(t=>t>=group.actT0 && t<until).at(-1)??-Infinity;
    const start=Math.max(landing.t,lastContact+.025);
    const low=group.frames.find(f=>f.t>=start);
    const rise=recoveries.find(r=>r.actT0===group.actT0);
    if(!low || (rise && low.t>rise.t+.008 && low.k.lean.c>.70) || until-low.t<3.7)continue;
    falls.push({t:low.t,k:structuredClone(low.k),ball:low.b.slice(),until,slide:Math.min(.16,Math.abs(low.k.act.vx)*.025)*KS});
  }
  const starts=groups.map((group,i)=>{
    const previous=groups[i-1],recovery=previous&&recoveries.find(r=>r.actT0===previous.actT0);
    const reach=previous ? smooth((group.actT0-previous.actT0+.025)/.19)*(1-(recovery?smooth((group.actT0-recovery.t)/.34):0)) : 0;
    return {t0:group.actT0,reach};
  });
  const scrambles=[];
  for(let i=0;i<groups.length-1;i++){
    const group=groups[i],next=groups[i+1],launch=next.frames[0];
    if(Math.abs(launch.k.act.vx)<KEEPER.STAR_SPEED)continue;
    const landing=group.frames.find(f=>f.t>group.actT0+.22 && f.k.lean.c<.7 &&
      f.k.pos.y<=KS*(.15*Math.abs(f.k.lean.s)+.85*f.k.lean.c+.08)+.012);
    if(!landing)continue;
    const lastTouch=contacts.filter(t=>t>=group.actT0&&t<next.actT0).at(-1)??-Infinity;
    const source=group.frames.find(f=>f.t>=Math.max(landing.t,lastTouch+.025));
    const nextTouch=contacts.find(t=>t>=next.actT0)??Infinity;
    const endT=Math.min(next.actT0+.30,nextTouch-.035);
    if(!source || next.actT0-source.t<.13 || endT<next.actT0+.10)continue;
    const side=Math.sign(launch.k.act.vx),pushKey=side>0?'r':'l';
    const loadT=next.actT0+.030,releaseT=Math.min(next.actT0+.24,endT);
    const destination=recordedSample(sim,endT);
    scrambles.push({t:source.t,k:structuredClone(source.k),ball:source.b.slice(),
      nextT:next.actT0,nextK:structuredClone(launch.k),endT,endK:structuredClone(destination.k),endBall:destination.ball.toArray(),
      loadT,launchT:next.actT0+.045,pushUntil:Math.max(loadT+.015,releaseT-.08),releaseT,pushKey,
      pushFoot:[launch.k.pos.x-side*.10*KS,.094*KS,launch.k.pos.z+.055*KS]});
  }
  return {recoveries,contacts,starts,falls,scrambles,impacts};
}

// Immutable display metadata. Nothing is added to a recorded physics frame.
export function createCatchAnimation(sim) {
  const caught=sim.result.caught;
  if(!caught)return null;
  const sample=recordedSample(sim,caught.t),body=keeperFromPhysics(sample.k);
  const rotation=bodyQuaternion(body.up,body.fwd),inverse=rotation.clone().invert();
  const ball=sample.ball;
  const hands=Object.fromEntries(['l','r'].map(key=>[key,body.hands[key].clone().sub(body.pelvis).applyQuaternion(inverse)]));
  const diving=sample.k.act && !sample.k.act.star && Math.abs(sample.k.lean.s)>.4 && sample.k.pos.y<.95*KS;
  const ground=diving?{t:caught.t,k:sample.k,b:ball.toArray()}:sim.frames.find(f=>f.t>=caught.t && f.k.lean.c<.65 && f.k.pos.y<.5*KS);
  const touch=sim.result.contacts?.find(c=>c.decision==='catch' && Math.abs(c.t-caught.t)<.002);
  const kind=touch?.kind || (/glove/.test(caught.part)?'glove':/leg/.test(caught.part)?'leg':/arm/.test(caught.part)?'arm':'torso');
  const method=kind==='leg'?'feet':kind==='arm'?'arms':kind==='torso'?'chest':caught.how.startsWith('one-handed')?'onehand':caught.how==='smothered on the ground'?'smother':'twohand';
  const lead=kind==='glove' ? (caught.part.startsWith('right')?'l':'r') : body.hands.l.distanceTo(ball)<=body.hands.r.distanceTo(ball)?'l':'r';
  return {t:caught.t,part:caught.part,kind,method,lead,relSpeed:caught.relSpeed,
    oneHanded:method==='onehand',worldBall:ball.clone(),
    low:ball.clone().sub(body.pelvis).dot(body.up)<.08*KS,
    contactBall:ball.clone().sub(body.pelvis).applyQuaternion(inverse),contactHands:hands,
    ground:ground?{t:ground.t,k:structuredClone(ground.k),ball:ground.b.slice()}:null,
    localRotation:inverse.clone().multiply(sample.rotation)};
}

function bodyQuaternion(up,forward) {
  const f=forward.clone().addScaledVector(up,-forward.dot(up)).normalize();
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(V().crossVectors(up,f),up,f));
}

// A contact reaction never chooses a save or changes the recorded ball. Keep
// the collision pose exact, then let the struck limb absorb the impulse. A
// giving limb folds further; a successful glove parry finishes out and wide.
function keeperContactResponse(p,ctx) {
  if(ctx.t==null || ctx.catchState && ctx.t>=ctx.catchState.t)return;
  const impacts=ctx.motionState?.impacts;
  if(!impacts?.length)return;
  const contactClear=1-(ctx.motionState.contacts||[]).reduce((w,t)=>Math.max(w,1-smooth((Math.abs(ctx.t-t)-.008)/.030)),0);
  for(const impact of impacts){
    const age=ctx.t-impact.t,falloff=impact.gaveWay?.30:.22;
    const landing=ctx.motionState.falls?.find(f=>ctx.t>=f.t&&ctx.t<f.until);
    const settling=landing?1-smooth((ctx.t-landing.t)/.16):1;
    const weight=smooth(age/.065)*(1-smooth((age-.14)/falloff))*contactClear*settling;
    if(weight<=0)continue;
    const key=impact.part.startsWith('right')?'l':'r',incoming=V().fromArray(impact.incoming),outgoing=V().fromArray(impact.outgoing);
    const strength=THREE.MathUtils.clamp(impact.relSpeed/24,.35,1);
    const amount=weight*strength,axes=chestAxes(p);
    const upright=smooth((p.up.y-.25)/.55);
    const flinch=(impact.gaveWay?.11:.035)*amount*upright;
    p.bend=(p.bend||0)-flinch;
    if(p.chestUp){p.chestUp.applyAxisAngle(axes.left,-flinch);p.chestFwd.applyAxisAngle(axes.left,-flinch);}
    if(impact.kind==='glove'||impact.kind==='arm'){
      const keys=impact.twoHands?['l','r']:[key];
      for(const hand of keys){
        const support=p.groundHands?.[hand]||0,share=hand===key?1:.75;
        const move=amount*share*(1-support);
        if(move<=0)continue;
        p.hands[hand].addScaledVector(incoming,(impact.gaveWay?.18:.075)*KS*move);
        if(impact.gaveWay){
          const shoulder=axes.origin.clone().addScaledVector(axes.up,.5*KS).addScaledVector(axes.left,(hand==='l'?1:-1)*.24*KS);
          p.hands[hand].addScaledVector(shoulder.sub(p.hands[hand]).normalize(),.07*KS*move);
        }else if(impact.kind==='glove')p.hands[hand].addScaledVector(outgoing,.055*KS*move);
        p.hands[hand].y+=Math.max(0,.14*KS-p.hands[hand].y)*move;
        const pole=axes.fwd.clone().addScaledVector(axes.up,-.8).normalize();
        p.elbowPole[hand]=slerpDir(p.elbowPole[hand].clone().normalize(),pole,.45*move);
        const normal=impact.gaveWay?incoming.clone().negate():outgoing.clone();
        p.palm[hand]=slerpDir(p.palm[hand].clone().normalize(),normal,.45*move);
        const fingers=axes.up.clone().addScaledVector(incoming,impact.gaveWay?.6:0).normalize();
        p.handDirection[hand]=slerpDir(p.handDirection[hand].clone().normalize(),fingers,.35*move);
        p.handBend[hand]=(p.handBend[hand]||0)+.28*move;
        p.spread ||= {l:0,r:0};p.spread[hand]=Math.max(p.spread[hand],(impact.gaveWay?.55:.9)*move);
        p.grip[hand]=THREE.MathUtils.lerp(p.grip[hand],.06,move);
      }
      p.physicsReachWeight=0;
    }else if(impact.kind==='leg'){
      if(impact.gaveWay && impact.phase==='air'){
        p.feet[key].addScaledVector(incoming,.13*KS*amount).addScaledVector(UP,.035*KS*amount);
        p.kneePole[key]=slerpDir(p.kneePole[key].clone().normalize(),axes.fwd,.35*amount);
      }else{
        const lifted=p.fwd.clone().addScaledVector(UP,.28).normalize();
        p.toe[key]=slerpDir(p.toe[key],lifted,.45*amount);
      }
    }
    p.contactResponse={t:impact.t,part:impact.part,kind:impact.kind,gaveWay:impact.gaveWay,weight};
  }
}

function catchPose(p,ctx) {
  const state=ctx.catchState,method=state.method;
  const age=ctx.t==null?-Infinity:ctx.t-ctx.catchState.t;
  if(age<-.22)return p;
  const prepare=smooth((age+.22)/.18);
  p.palm ||= {l:p.fwd.clone(),r:p.fwd.clone()};
  const scoopFade=method==='feet'?1-smooth((age-.75)/.70):1-smooth((age-.10)/.4);
  const scoop=ctx.catchState.low ? .43*prepare*scoopFade*smooth((p.up.y-.7)/.25) : 0;
  const squat=.14*KS*scoop/.43;
  p.pelvis.y-=squat;
  p.bend=(p.bend||0)+scoop;
  if(p.chestUp&&scoop){
    const axis=V().crossVectors(p.chestUp,p.chestFwd).normalize();
    p.chestUp.applyAxisAngle(axis,scoop);p.chestFwd.applyAxisAngle(axis,scoop);
  }
  // Meet the shot with open fingers and wrists facing it. Catch knowledge only
  // styles the recorded reach; it never decides whether a catch happens.
  const axes=chestAxes(p);
  const supportDirections=p.handDirection;
  const supportLocks=p.palmLock;
  const reception=Object.fromEntries(['l','r'].map(key=>[key,prepare*(state.oneHanded&&key!==state.lead?.35:1)]));
  p.palmLock={l:.7*reception.l,r:.7*reception.r};
  p.handDirection={l:axes.up.clone().multiplyScalar(ctx.catchState.low?-1:1),r:axes.up.clone().multiplyScalar(ctx.catchState.low?-1:1)};
  p.spread={...reception};
  if(age<0){
    for(const key of ['l','r']){
      const normal=ctx.ball.clone().sub(p.hands[key]);
      if(normal.lengthSq()>1e-8)p.palm[key]=slerpDir(p.palm[key],normal.normalize(),prepare);
      p.grip[key]=.12-.07*reception[key];
    }
    return p;
  }

  // A foot trap stays on the turf while the hands arrive. Rise only after
  // securing it; lifting with the first hand made these new gathers float.
  const footGather=method==='feet' && !state.ground;
  const crouch=footGather?smooth(age/.26)*(1-smooth((age-.65)/.85)):0;
  if(crouch>0){
    p.pelvis.y-=.36*KS*crouch;p.bend+=.30*crouch;
    if(p.chestUp){const axis=V().crossVectors(p.chestUp,p.chestFwd).normalize();p.chestUp.applyAxisAngle(axis,.30*crouch);p.chestFwd.applyAxisAngle(axis,.30*crouch);}
    p.legTransport=(p.legTransport||0)*(1-crouch);
    for(const [key,sign] of [['l',1],['r',-1]])p.kneePole[key]=slerpDir(p.kneePole[key].clone().normalize(),V(sign*.75,.15,.65).normalize(),crouch);
  }
  if(footGather){
    // Open a space for both arms between the knees, with staggered short
    // steps. A narrow squat sent the forearms straight through the thighs.
    for(const [key,sign,offset] of [['l',1,0],['r',-1,.08]]){
      const open=smooth((age-offset)/.14),close=smooth((age-.95-offset)/.25),stance=open*(1-close);
      p.feet[key].x+=sign*.15*KS*stance;p.feet[key].z-=.10*KS*stance;
      p.feet[key].y+=.045*KS*Math.sin(Math.PI*open)*(1-close)+.025*KS*Math.sin(Math.PI*close);
      p.toe[key]=p.fwd.clone().multiplyScalar(Math.cos(.20*stance)).addScaledVector(V(1,0,0),sign*Math.sin(.20*stance)).normalize();
    }
  }
  const delay=method==='feet'?.40:method==='arms'?.12:.025;
  const duration=method==='feet'?.72:method==='onehand'?.50:method==='arms'?.56:method==='smother'?.55:.42;
  const gather=smooth((age-delay)/duration);
  const cushion=(.055+.055*clamp01(state.relSpeed/25))*bump(age,0,.32);
  p.bend=(p.bend||0)+cushion;
  if(p.chestUp&&cushion){
    const axis=V().crossVectors(p.chestUp,p.chestFwd).normalize();
    p.chestUp.applyAxisAngle(axis,cushion);p.chestFwd.applyAxisAngle(axis,cushion);
  }
  p.twist=(p.twist||0)*(1-gather);
  if(age>1 && p.up.y>.9){
    p.bend+=.006*Math.sin(ctx.t*2.1)*smooth((age-1)/.6);
    p.breath=.25*Math.sin(ctx.t*2.1);
  }
  const chest=chestAxes(p),across=V().crossVectors(chest.up,chest.fwd).normalize();
  const lead=state.lead;
  const carrier=ctx.catchState.ground ? (ctx.catchState.ground.k.lean.s>0?'r':'l') : lead;
  const sideHold=ctx.catchState.ground ? 1-smooth((chest.up.y-.35)/.45) : 0;
  const cradle=chest.origin.clone().addScaledVector(chest.up,.29*KS)
    .addScaledVector(chest.fwd,(.29-.12*sideHold)*KS).addScaledVector(across,(carrier==='l'?1:-1)*.30*KS*sideHold);
  cradle.y=Math.max(P.BALL.R+.04*KS,cradle.y);
  const carryRotation=bodyQuaternion(p.up,p.fwd);
  const receivingRoot=p.pelvis.clone().addScaledVector(UP,squat);
  const origin=ctx.catchState.contactBall.clone().applyQuaternion(carryRotation).add(receivingRoot);
  if(method==='feet')origin.copy(state.worldBall);
  const ball=origin.lerp(cradle,gather);
  if(method!=='feet')ball.addScaledVector(chest.fwd,-.025*KS*bump(age,0,.24));
  const carry=smooth((age-(method==='feet'?.40:0))/.16);
  const shoulder=chest.origin.clone().addScaledVector(across,(carrier==='l'?1:-1)*kickModel.shoulder[0]*KS)
    .addScaledVector(chest.up,kickModel.shoulder[1]*KS).addScaledVector(chest.fwd,kickModel.shoulder[2]*KS);
  const reach=ball.clone().sub(shoulder),limit=(kickModel.upperArm+kickModel.foreArm+.11)*KS-P.BALL.R;
  if(reach.length()>limit)ball.lerp(shoulder.add(reach.setLength(limit)),carry);
  // Keep the held ball outside the clothed torso as the chest rolls relative
  // to the hips. A hip-local receiving point can otherwise pass through the
  // shirt during a low arm gather, even with both palms correctly attached.
  const centre=chest.origin.clone().addScaledVector(chest.up,.27*KS),delta=ball.clone().sub(centre);
  const x=delta.dot(across),y=delta.dot(chest.up),z=delta.dot(chest.fwd);
  const rx=.23*KS+P.BALL.R+.012*KS,ry=.36*KS+P.BALL.R+.012*KS,rz=.16*KS+P.BALL.R+.012*KS;
  const clearance=Math.hypot(x/rx,y/ry,z/rz);
  if(clearance<1){
    const outside=clearance>1e-6?centre.clone().addScaledVector(delta,1/clearance):centre.clone().addScaledVector(chest.fwd,rz);
    if(outside.y<P.BALL.R){
      const depth=rz*Math.sqrt(Math.max(.05,1-(x/rx)**2-(y/ry)**2));
      outside.copy(centre).addScaledVector(across,x).addScaledVector(chest.up,y).addScaledVector(chest.fwd,depth);
    }
    ball.lerp(outside,carry);
  }
  ball.y=Math.max(P.BALL.R,ball.y);
  const rotation=bodyQuaternion(chest.up,chest.fwd).multiply(ctx.catchState.localRotation);
  p.ballPosition=ball;
  p.ballRotation=rotation;
  p.ballRotationWeight=gather;
  p.ballGrip={center:ball,radius:P.BALL.R,weight:{}};
  p.shoulderReach=1;
  const recoveryStart=ctx.catchState.ground ? ctx.catchState.ground.t+.35 : ctx.endT;
  const postRecovery=recoveryStart!=null && ctx.t>recoveryStart && chest.up.y<.8;
  // Keep one supporting hand available during a ground get-up; the other
  // secures the ball against the body, then the second hand rejoins it.
  const support=postRecovery ? sideHold*smooth((ctx.t-recoveryStart)/.22) : 0;
  for(const [key,sign] of [['l',1],['r',-1]]){
    const lag=method==='onehand'&&key!==lead?.13:method==='feet'?.20:method==='arms'?.08:method==='smother'&&key!==lead?.09:0;
    const duration=method==='feet'?.26:method==='onehand'?(key===lead?.10:.26):method==='arms'?.22:method==='chest'?.20:method==='smother'?.20:.13;
    const secure=smooth((age-lag)/duration);
    const weight=secure*(key===carrier?1:1-support);
    const radial=across.clone().multiplyScalar(sign*.88).addScaledVector(chest.up,-.08).addScaledVector(chest.fwd,.46).normalize();
    const radius=P.BALL.R+.032*KS,minY=(ctx.catchState.ground ? .16 : .045)*KS;
    if(ball.y+radial.y*radius<minY){
      const y=THREE.MathUtils.clamp((minY-ball.y)/radius,-.98,.98),horizontal=Math.hypot(radial.x,radial.z);
      radial.set(radial.x*Math.sqrt(1-y*y)/(horizontal||1),y,radial.z*Math.sqrt(1-y*y)/(horizontal||1));
    }
    const target=ball.clone().addScaledVector(radial,radius),normal=radial.clone().negate();
    const start=ctx.catchState.contactHands[key].clone().applyQuaternion(carryRotation).add(receivingRoot);
    if(key===lead && method!=='feet' && method!=='arms')start.add(ball.clone().sub(ctx.catchState.contactBall.clone().applyQuaternion(carryRotation).add(receivingRoot)));
    if(!postRecovery||key===carrier)p.hands[key].copy(start);
    p.hands[key].lerp(target,weight);
    if(ctx.catchState.ground && (!postRecovery||key===carrier))p.hands[key].y+=Math.max(0,minY-p.hands[key].y)*smooth((age-.01)/.11);
    p.palm[key]=slerpDir(p.palm[key].clone().normalize(),normal,weight);
    const fingerUp=ctx.catchState.low ? chest.up.clone().multiplyScalar(-Math.cos(Math.PI*gather)).addScaledVector(chest.fwd,Math.sin(Math.PI*gather)) : chest.up.clone();
    const fingers=fingerUp.addScaledVector(normal,-fingerUp.dot(normal)).normalize();
    p.handDirection[key]=postRecovery && key!==carrier && supportDirections?.[key]
      ? slerpDir(supportDirections[key],fingers,weight) : fingers;
    p.palmLock[key]=postRecovery && key!==carrier ? (supportLocks?.[key]||0)*(1-weight)+weight : .7*reception[key]+(1-.7*reception[key])*weight;
    if(p.groundHands)p.groundHands[key]*=1-weight;
    if(p.handBend?.[key])p.handBend[key]*=1-weight;
    p.grip[key]=THREE.MathUtils.lerp(.12-.07*reception[key],.45,weight);
    p.spread[key]=THREE.MathUtils.lerp(reception[key],.3,weight);
    p.ballGrip.weight[key]=weight;
    const pole=across.clone().multiplyScalar(sign).addScaledVector(chest.up,-.65).addScaledVector(chest.fwd,.15).normalize();
    p.elbowPole[key]=slerpDir(p.elbowPole[key].clone().normalize(),pole,weight);
  }
  const head=chest.origin.clone().addScaledVector(chest.up,kickModel.head[1]*KS);
  const look=head.clone().addScaledVector(chest.fwd,3);
  if(!ctx.catchState.ground || !p.chestUp)p.look=ball.clone().lerp(look,smooth((age-.6)/1.1));
  return p;
}

function keeperLive({ k, t, clock, ball, plan, kvx = 0, motionState }) {
  const p = keeperFromPhysics(k);
  p.articulatedTorso=true;p.anatomicalArms=true;
  const pre = t == null ? -10 : t;
  clock=t==null?clock:t+RUNUP;

  // Idle sway and bounce, fading out as the taker closes in.
  const w = t == null ? 1 : smooth((-0.25 - t) / 0.4);
  const sway = 0.035 * Math.sin(clock * 1.7) * w;
  const bob = (-0.02 + 0.012 * Math.sin(clock * 5.2)) * w;
  // Split-step hop just before contact, then a loaded crouch into the dive.
  const hop = 0.045 * bump(pre, -0.32, -0.1);
  // The recorded pelvis remains exact after the kick. Hand styling below
  // preserves the recorded glove centres in ball-contact range.
  const crouch = pre < 0 ? -0.04 * bump(pre, -0.22, 0) : 0;
  const off = V(sway, bob + hop + crouch, 0);
  p.pelvis.add(off);
  p.hands.l.add(off).y += 0.02 * Math.sin(clock * 2.1) * w;
  p.hands.r.add(off).y += 0.02 * Math.sin(clock * 2.1 + 1.3) * w;
  p.feet.l.y += hop * 0.8;
  p.feet.r.y += hop * 0.8;

  // Styling follows what the keeper actually did (its latest commitment:
  // the planned dive, a read dive, or a second dive after recovering).
  const act = k.act;
  const tau = t == null || !act ? -1 : t - act.t0;
  const returning=motionState?.recoveries.find(r=>r.actT0===act?.t0 && t>=r.t && t<r.until);
  const recovery=returning?smooth((t-returning.t)/.34):0;
  // Dive styling fades as the keeper gets back up.
  const tilt = smooth((Math.abs(k.lean.s) - 0.15) / 0.3);
  const r = smooth(tau / 0.25) * (act && !act.star ? tilt : 1);
  // Wider, athletic stance while set; it narrows as the legs drive the dive.
  const widen = 0.05 * KS * (1 - r);
  p.feet.l.x += widen;
  p.feet.r.x -= widen;

  // Alternate between stationary world-space footholds and a short swing.
  // Deriving phase from hip distance also works when replaying or reversing.
  const shuffle = smooth((Math.abs(kvx) - 0.25) / 0.5) * smooth((k.lean.c - 0.85) / 0.1);
  if (shuffle > 0) {
    const stride = 0.28 * KS;
    for (const [side, offset, sign] of [['l', 0, 1], ['r', 0.5, -1]]) {
      const q = k.pos.x / stride + offset, cell = Math.floor(q), phase = q - cell;
      const swing = smooth((phase - 0.6) / 0.4);
      const x = (cell - offset + 0.3 + swing) * stride + sign * 0.17 * KS;
      p.feet[side].x += (x - p.feet[side].x) * shuffle;
      p.feet[side].y += 0.065 * KS * Math.sin(Math.PI * clamp01((phase - 0.6) / 0.4)) ** 2 * shuffle;
    }
  }

  p.look = ball.clone();
  p.breath = Math.sin(clock * 2.4) * w;
  p.palm = { l: ball.clone().sub(p.hands.l).normalize(), r: ball.clone().sub(p.hands.r).normalize() };
  p.bend = 0.13 * (1 - r);
  p.grip = {l:.12,r:.12};
  p.shoulderReach=1;
  p.kneePole = {l:p.fwd.clone().addScaledVector(p.up,.15),r:p.fwd.clone().addScaledVector(p.up,.15)};
  p.elbowPole = {l:p.fwd.clone().addScaledVector(p.up,-.65),r:p.fwd.clone().addScaledVector(p.up,-.65)};
  p.toe = {l:p.fwd.clone(),r:p.fwd.clone()};
  p.footUp = {l:UP.clone(),r:UP.clone()};

  if (act && tau > 0) {
    if (!act.star && Math.abs(act.vx) >= KEEPER.STAR_SPEED) {
      const lead = act.vx > 0 ? 'l' : 'r';
      const trail = lead === 'l' ? 'r' : 'l';
      // Lead leg drives long; the trailing knee tucks up behind once its
      // foot has left the grass (physics pins it during push-off).
      const side=act.vx>0?1:-1;
      const groundLevel=KS*(.15*Math.abs(p.up.x)+.85*p.up.y+.08);
      const lift=smooth((tau-.12)/.2)*(1-recovery), landing=smooth((groundLevel+.10*KS-p.pelvis.y)/(.10*KS))*smooth((tau-.18)/.18)*tilt*(1-recovery);
      const gather=lift*(1-landing*.6), tuck=k.plant?0:gather;
      p.feet[lead].addScaledVector(p.up,-.035*KS*r).addScaledVector(p.fwd,.10*KS*landing);
      p.feet[trail].addScaledVector(p.up,.22*KS*tuck).addScaledVector(p.fwd,-.13*KS*tuck);
      p.kneePole[lead].addScaledVector(p.up,.32*landing);
      p.kneePole[trail].addScaledVector(p.up,.65*gather);
      p.bend=(act.jump>2?-.035:.055)*r*(1-recovery)+.06*landing+.13*recovery;
      p.twist=side*.045*r*(1-recovery);
      const toe=p.fwd.clone().addScaledVector(p.up,-.35*lift).normalize();
      p.toe={l:toe.clone(),r:toe.clone()};
      const bootUp=p.up.clone().addScaledVector(toe,-p.up.dot(toe)).normalize();
      p.footUp={l:UP.clone().lerp(bootUp,lift*(1-landing)).normalize(),r:UP.clone().lerp(bootUp,lift*(1-landing)).normalize()};
      if(k.plant){
        const planted=k.plant.side>0?'l':'r';
        p.feet[planted].set(k.plant.x,k.plant.y+.012,k.plant.z);
        p.footUp[planted]=UP.clone();p.toe[planted]=p.fwd.clone();
      }else if(tau<KEEPER.PUSH_TIME+KEEPER.PLANT_EXTRA+.12){
        const release=smooth((tau-KEEPER.PUSH_TIME-KEEPER.PLANT_EXTRA)/.12);
        const sign=trail==='l'?1:-1,travel=Math.max(0,tau-KEEPER.PUSH_TIME*.5);
        const anchor=V(k.pos.x-act.vx*travel+sign*.15*KS,.094*KS,k.pos.z-Math.abs(act.vx)*.12*travel);
        const hip=p.pelvis.clone().addScaledVector(V().crossVectors(p.up,p.fwd),sign*kickModel.hip[0]*KS)
          .addScaledVector(p.up,kickModel.hip[1]*KS).addScaledVector(p.fwd,kickModel.hip[2]*KS);
        const reach=anchor.clone().sub(hip),length=(kickModel.thigh+kickModel.shin)*KS*.98;
        if(reach.length()>length)anchor.copy(hip).add(reach.setLength(length));
        p.feet[trail].lerp(anchor,1-release);p.footUp[trail].lerp(UP,1-release).normalize();
      }
      // Keep the elbows in front of the chest while reaching with both hands.
      // The standing pole would fold the far arm up behind the shoulder.
      p.elbowPole = {
        l: p.fwd.clone().addScaledVector(p.up, -.5+.3*landing),
        r: p.fwd.clone().addScaledVector(p.up, -.5+.3*landing),
      };
    } else if (act.star) {
      // Star jump: legs and arms spread wide.
      p.feet.l.x += 0.12 * KS * r;
      p.feet.r.x -= 0.12 * KS * r;
      p.bend = -0.05 * r;
      p.kneePole.l.addScaledVector(p.up,.35*r);p.kneePole.r.addScaledVector(p.up,.35*r);
      p.grip={l:.05,r:.05};
    }
    if(!act.star){
      const vertical=Math.max(.15,act.jump-.3),expected=vertical/Math.hypot(act.vx,vertical);
      const progress=smooth((k.lean.c-expected)/Math.max(.1,1-expected));
      const scramble=recovery*(1-smooth((k.lean.c-.94)/.06));
      if(scramble>0){
        // Use the captured knee-under-body motion during the recorded scramble.
        // Root and glove targets stay entirely controlled by the simulation.
        const capture=sampleBodyMotion('getup',.58+.42*progress);
        const sourceFwd=capture.fwd.clone().addScaledVector(capture.up,-capture.fwd.dot(capture.up)).normalize();
        const sourceLeft=V().crossVectors(capture.up,sourceFwd),left=V().crossVectors(p.up,p.fwd);
        const map=v=>left.clone().multiplyScalar(v.dot(sourceLeft)).addScaledVector(p.up,v.dot(capture.up)).addScaledVector(p.fwd,v.dot(sourceFwd));
        for(const [key,side,sign] of [['l','L',1],['r','R',-1]]){
          const thigh=map(capture['thigh'+side]),shin=map(capture['shin'+side]);
          const hip=p.pelvis.clone().addScaledVector(left,sign*kickModel.hip[0]*KS).addScaledVector(p.up,kickModel.hip[1]*KS).addScaledVector(p.fwd,kickModel.hip[2]*KS);
          const ankle=hip.addScaledVector(thigh,kickModel.thigh*KS).addScaledVector(shin,kickModel.shin*KS);
          p.feet[key].lerp(ankle,.65*scramble);p.kneePole[key]=slerpDir(p.kneePole[key].normalize(),thigh.normalize(),scramble);
          p.footUp[key].lerp(UP,scramble).normalize();p.toe[key].lerp(p.fwd,scramble).normalize();
        }
        p.bend+=.10*scramble;p.twist*=1-scramble;
      }
    }
  }
  // A small shoulder lead during takeoff, then a bounded lag while rising,
  // articulates the spine instead of tilting a single rigid torso slab.
  const bank=Math.atan2(p.up.x,p.up.y);
  const lead=act&&!act.star ? Math.sign(act.vx)*.08*bump(tau,0,.36)*(1-recovery) : 0;
  const riseBank=returning ? returning.bank*(1-smooth((t-returning.t)/.34)) : bank;
  const chestBank=bank+THREE.MathUtils.clamp((riseBank-bank)*recovery+lead,-.20,.20);
  const bankUp=V(Math.sin(chestBank),Math.cos(chestBank),0);
  p.chestUp=bankUp.clone().multiplyScalar(Math.cos(p.bend)).addScaledVector(p.fwd,Math.sin(p.bend));
  p.chestFwd=p.fwd.clone().multiplyScalar(Math.cos(p.bend)).addScaledVector(bankUp,-Math.sin(p.bend)).applyAxisAngle(p.chestUp,p.twist||0);

  // A keeper waits with bent elbows and compact hands in front of the hips.
  // Return to that guard as the torso rises, rather than preserving the
  // engine's stale overhead reach until the simulation stops.
  const contact=motionState?.contacts.reduce((w,time)=>Math.max(w,1-smooth((Math.abs(t-time)-.045)/.10)),0)||0;
  const near=smooth((2.2-Math.abs(ball.z-k.pos.z))/1.0);
  const startReach=motionState?.starts.find(s=>s.t0===act?.t0)?.reach||0;
  const reach=Math.max(act?startReach+(1-startReach)*smooth((tau+.025)/.19):0,near,contact);
  const ready=(1-reach)+reach*recovery*(1-contact)*(1-near);
  p.physicsReachWeight=1-ready;
  const chest=chestAxes(p);
  for(const [key,sign] of [['l',1],['r',-1]]){
    const guard=p.pelvis.clone().addScaledVector(chest.left,sign*.34*KS).addScaledVector(UP,.045*KS).addScaledVector(p.fwd,.27*KS);
    guard.y=Math.max(.14*KS,guard.y);
    p.hands[key].lerp(guard,ready);
    const arc=Math.sin(Math.PI*ready);
    p.hands[key].addScaledVector(chest.left,sign*.13*KS*arc).addScaledVector(chest.fwd,.13*KS*arc);
    const out=chest.left.clone().multiplyScalar(sign*.60).addScaledVector(chest.up,-1).addScaledVector(chest.fwd,-.20).normalize();
    const reachPole=chest.left.clone().multiplyScalar(sign*.25).addScaledVector(chest.up,-.7).addScaledVector(chest.fwd,.15).normalize();
    p.elbowPole[key]=slerpDir(reachPole,out,ready);
    p.palm[key]=slerpDir(p.palm[key].normalize(),chest.fwd,ready);
    // Keep a slight elbow bend while reaching for a distant shot. Extend to
    // the exact recorded glove centre as the ball enters contact range.
    const shoulder=chest.origin.clone().addScaledVector(chest.left,sign*kickModel.shoulder[0]*KS)
      .addScaledVector(chest.up,kickModel.shoulder[1]*KS).addScaledVector(chest.fwd,kickModel.shoulder[2]*KS);
    const delta=p.hands[key].clone().sub(shoulder),limit=(kickModel.upperArm+kickModel.foreArm+.11)*KS*.96;
    const free=1-Math.max(near,contact);
    if(delta.length()>limit&&free>0){
      p.hands[key].lerp(shoulder.add(delta.setLength(limit)),free);
      p.physicsReachWeight*=1-free;
    }
  }
  // Relaxed wrists continue the forearm, with a small lift of the fingertips.
  // Locking a downward finger axis here made the gloves hang at a right angle.
  const fingers=chest.fwd.clone().addScaledVector(chest.up,.15).normalize();
  p.handDirection={l:fingers.clone(),r:fingers.clone()};
  p.handBend={l:.12*ready,r:.12*ready};
  p.palmLock={l:0,r:0};
  // Cushion the visible landing while preserving the recorded glove targets.
  p.feet.l.y = Math.max(0.088 * KS, p.feet.l.y);
  p.feet.r.y = Math.max(0.088 * KS, p.feet.r.y);
  return p;
}

function keeperStand(fr, ball, extra = {}) {
  const S = KS;
  return {
    pelvis: at(fr, 0, .94 * S, 0), up: UP.clone(), fwd: fr.f.clone(), bend:.04,
    articulatedTorso:true,anatomicalArms:true,
    hands: {l:at(fr,.25*S,.90*S,.10*S),r:at(fr,-.25*S,.90*S,.10*S)},
    feet: {l:at(fr,.15*S,.094*S,.04*S),r:at(fr,-.15*S,.094*S,-.04*S)},
    toe:{l:fr.f.clone(),r:fr.f.clone()},footUp:{l:UP.clone(),r:UP.clone()},
    elbowPole:{l:fr.l.clone().addScaledVector(fr.f,.65).addScaledVector(UP,-.5),r:fr.l.clone().negate().addScaledVector(fr.f,.65).addScaledVector(UP,-.5)},
    kneePole:{l:fr.f.clone(),r:fr.f.clone()},grip:{l:.25,r:.25},look:ball.clone(),...extra,
  };
}

function temples(p,S) {
  const axes=chestAxes(p),left=V().crossVectors(axes.up,axes.fwd).normalize();
  const head=axes.origin.clone().addScaledVector(axes.up,(kickModel.head[1]+.06)*S).addScaledVector(axes.fwd,kickModel.head[2]*S);
  return {l:head.clone().addScaledVector(left,.14*S),r:head.clone().addScaledVector(left,-.14*S)};
}

function keeperMood(fr,outcome,te,ball) {
  const S=KS,taker=V(0,1.4,.5),base=keeperStand(fr,taker);
  base.breath=.4*Math.sin(te*1.9);
  if(outcome==='held')return base;
  if(outcome==='save'){
    const gesture=smooth(te/.35)*(1-smooth((te-2)/.7));
    const pump=bump(te,.35,1.05)+.6*bump(te,1.15,1.75);
    const hands={l:at(fr,.3*S,(1.27+.15*pump)*S,.18*S),r:at(fr,-.3*S,1.20*S,.15*S)};
    base.hands=blendHands(base,{...base,hands},gesture);
    base.grip={l:.25+.73*gesture,r:.25+.63*gesture};
    base.bend=-.025*gesture;
    return base;
  }
  if(outcome==='goal'){
    const toBall=ball.clone().sub(fr.g).setY(0);
    const target=toBall.lengthSq()>.01?slerpDir(fr.f,toBall.normalize(),.75):fr.f;
    const turned=keeperStand(frame(fr.g,target),ball);
    const p=stepBlend(base,turned,smooth(te/1.4),S);
    const gesture=smooth((te-.25)/.45)*(1-smooth((te-2.4)/.65));
    p.bend=.04+.16*gesture;
    p.hands=blendHands(p,{...p,hands:temples(p,S)},gesture);
    const left=V().crossVectors(UP,p.fwd);
    p.elbowPole={l:left.clone().addScaledVector(p.fwd,.65).addScaledVector(UP,-.5+.6*gesture),
      r:left.clone().negate().addScaledVector(p.fwd,.65).addScaledVector(UP,-.5+.6*gesture)};
    p.grip={l:.12,r:.12};p.look=ball.clone();
    return p;
  }
  const clap=Math.abs(Math.sin(Math.PI*2.8*Math.max(0,te-.2)));
  const gesture=smooth(te/.3)*(1-smooth((te-1.8)/.5));
  const hands={l:at(fr,(.035+.08*clap)*S,1.31*S,.32*S),r:at(fr,-(.035+.08*clap)*S,1.31*S,.32*S)};
  base.hands=blendHands(base,{...base,hands},gesture);
  base.palm={l:slerpDir(fr.f,fr.l.clone().negate(),gesture),r:slerpDir(fr.f,fr.l,gesture)};
  base.grip={l:.15,r:.15};
  return base;
}

// An orthonormal body/chest rotation is essential when rolling onto the front.
// Interpolating their axes separately can shear the torso halfway through.
function recoveryBlend(a,b,u,clearKnees=false) {
  const p=blendPose(a,b,u);
  if(u<=0||u>=1)return p;
  const q=bodyQuaternion(a.up,a.fwd).slerp(bodyQuaternion(b.up,b.fwd),u);
  p.up=UP.clone().applyQuaternion(q);p.fwd=V(0,0,1).applyQuaternion(q);
  const x=chestAxes(a),y=chestAxes(b),chest=bodyQuaternion(x.up,x.fwd).slerp(bodyQuaternion(y.up,y.fwd),u);
  p.chestUp=UP.clone().applyQuaternion(chest);p.chestFwd=V(0,0,1).applyQuaternion(chest);
  if(clearKnees)groundKneePoles(p,u);
  return p;
}

function groundKneePoles(p,amount=1) {
  const guard=(1-smooth((p.pelvis.y/KS-.32)/.38))*amount;
  if(guard<=0)return;
  for(const key of ['l','r'])p.kneePole[key]=p.kneePole[key].clone().normalize()
    .lerp(UP.clone().addScaledVector(p.fwd,.20).normalize(),guard).normalize();
}

function groundedCapture(phase,fr,ball) {
  const p=capturedBodyPose('getup',phase,fr,{scale:KS,handOffset:.11,ball,grip:.12});
  p.articulatedTorso=true;p.anatomicalArms=true;p.shoulderReach=1;
  const axes=chestAxes(p),head=axes.origin.clone().addScaledVector(axes.up,kickModel.head[1]*KS).addScaledVector(axes.fwd,kickModel.head[2]*KS);
  // Allow the hips and chest to stay low without sinking the thicker athlete
  // into the grass. The supporting hands and feet stay at their world points.
  const clearance=Math.max(0,.17*KS-p.pelvis.y,.19*KS-head.y);
  p.pelvis.y+=clearance;p.look.y+=clearance;
  return p;
}

// A second save uses a quick low recovery, not a compressed full stand-up.
// The visual root, supporting palm and drive foot can move independently in
// this clear interval; the complete recorded pose takes over before contact.
function keeperRedive(ctx,s) {
  const source=keeperLive({...ctx,k:s.k,t:s.t,kvx:0,ball:V().fromArray(s.ball)});
  const firstSide=Math.sign(s.k.lean.s)||1,braceKey=firstSide>0?'l':'r';
  const lead=s.pushKey==='l'?'r':'l',side=Math.sign(s.nextK.act.vx);
  const push=V().fromArray(s.pushFoot),forward=V(0,0,1);
  const braced=keeperStand(frame(V(s.nextK.pos.x,0,s.nextK.pos.z),forward),ctx.ball);
  braced.pelvis.copy(source.pelvis).lerp(V(s.nextK.pos.x,source.pelvis.y,s.nextK.pos.z),.45).setY(.37*KS);
  braced.up=V(firstSide*.83,.56,0).normalize();braced.bend=.30;
  braced.legTransport=firstSide===side?0:1;
  const bank=V(firstSide*.70,.714,0).normalize();
  braced.chestUp=bank.clone().multiplyScalar(Math.cos(braced.bend)).addScaledVector(forward,Math.sin(braced.bend));
  braced.chestFwd=forward.clone().multiplyScalar(Math.cos(braced.bend)).addScaledVector(bank,-Math.sin(braced.bend));
  const axes=chestAxes(braced),across=axes.left;
  for(const [key,sign] of [['l',1],['r',-1]]){
    braced.hands[key]=axes.origin.clone().addScaledVector(axes.up,.14*KS)
      .addScaledVector(axes.fwd,.32*KS).addScaledVector(across,sign*.22*KS);
    braced.elbowPole[key]=axes.fwd.clone().addScaledVector(axes.up,-.65).addScaledVector(across,sign*.3).normalize();
    braced.kneePole[key]=firstSide===side?UP.clone():V(sign*.08,1,.6).normalize();
  }
  braced.hands[braceKey].set(source.pelvis.x+firstSide*.35*KS,.035*KS,source.pelvis.z+.36*KS);
  braced.palm={l:forward.clone(),r:forward.clone()};braced.palm[braceKey]=V(0,-1,0);
  braced.handDirection={l:forward.clone(),r:forward.clone()};
  braced.handBend={l:0,r:0};braced.handBend[braceKey]=1;
  braced.palmLock={l:0,r:0};braced.palmLock[braceKey]=1;
  braced.groundHands={l:0,r:0};braced.groundHands[braceKey]=1;
  braced.grip={l:.10,r:.10};braced.grip[braceKey]=0;
  braced.feet[s.pushKey]=push.clone().add(V(-firstSide*.30*KS,0,-.08*KS));
  braced.feet[lead]=V(braced.pelvis.x+side*(firstSide===side?-.20:.06)*KS,.16*KS,braced.pelvis.z+(firstSide===side?.12:-.27)*KS);
  braced.toe[lead]=V(0,-.55,.835).normalize();
  braced.footUp[lead]=UP.clone().addScaledVector(braced.toe[lead],-braced.toe[lead].y).normalize();

  const loaded=keeperStand(frame(V(s.nextK.pos.x,0,s.nextK.pos.z),forward),ctx.ball);
  loaded.pelvis.y=(firstSide===side?.48:.58)*KS;loaded.bend=.35;loaded.shoulderReach=1;
  // Chasing a rebound in the same direction needs a low lateral push, rather
  // than rotating upright and immediately folding back into the same dive.
  if(firstSide===side){const c=Math.max(.55,s.nextK.lean.c);loaded.up=V(side*Math.sqrt(1-c*c),c,0);}
  loaded.legTransport=firstSide===side?0:1;
  loaded.feet[s.pushKey]=push.clone();
  loaded.feet[lead]=V(s.nextK.pos.x+side*(firstSide===side?-.22:.16)*KS,.094*KS,s.nextK.pos.z+.065*KS);
  loaded.handDirection={l:V(0,.12,1).normalize(),r:V(0,.12,1).normalize()};
  loaded.handBend={l:.12,r:.12};loaded.palm={l:forward.clone(),r:forward.clone()};
  const loadAxes=chestAxes(loaded);
  for(const [key,sign] of [['l',1],['r',-1]]){
    loaded.hands[key]=loadAxes.origin.clone().addScaledVector(loadAxes.left,sign*.30*KS)
      .addScaledVector(loadAxes.up,.08*KS).addScaledVector(loadAxes.fwd,.32*KS);
    loaded.elbowPole[key]=V(sign*.55,-1,.2).normalize();
    loaded.kneePole[key]=firstSide===side?UP.clone():V(sign*.10,.2,1).normalize();
  }
  const settle=Math.min(.12,(s.loadT-s.t)*(firstSide===side?.60:.45)),settleT=s.t+settle,braceEnd=settleT+.022;
  let p;
  if(ctx.t<settleT){
    const u=smooth((ctx.t-s.t)/settle);
    p=recoveryBlend(source,braced,u);p.recoveryPhase='brace';
    p.legTransport=firstSide===side?0:smooth((ctx.t-s.t)/.035);
    for(const key of ['l','r']){
      if(key===s.pushKey)p.feet[key].addScaledVector(forward,.22*KS*Math.sin(Math.PI*u));
      p.feet[key].y+=(key===s.pushKey ? .13 : .08)*KS*Math.sin(Math.PI*u);
    }
  }else if(ctx.t<braceEnd){p=braced;p.recoveryPhase='brace';}
  else if(ctx.t<s.loadT){
    const u=smooth((ctx.t-braceEnd)/(s.loadT-braceEnd));
    p=recoveryBlend(braced,loaded,u);p.recoveryPhase='load';
    // Draw both feet underneath before placing the outside drive foot.
    p.feet[s.pushKey].y+=.045*KS*Math.sin(Math.PI*u);
    p.feet[lead].y+=.065*KS*Math.sin(Math.PI*u);
  }else{
    const live=keeperLive(ctx),u=smooth((ctx.t-s.launchT)/(s.endT-s.launchT));
    p=recoveryBlend(loaded,live,u);p.recoveryPhase=u===0?'load':'redive';
    const destination=keeperLive({...ctx,k:s.endK,t:s.endT,kvx:0,ball:V().fromArray(s.endBall)});
    // The engine can release a collision foot in a single frame. Aim the
    // visual swing at its recorded destination, rather than a moving target
    // that jumps from the planted point halfway through our foot release.
    p.feet[lead]=loaded.feet[lead].clone().lerp(destination.feet[lead],u);
    p.toe[lead]=slerpDir(loaded.toe[lead],destination.toe[lead],u);
    p.footUp[lead]=slerpDir(loaded.footUp[lead],destination.footUp[lead],u);
    // Preserve the short spring from a crouch instead of lifting to full height.
    const spring=live.pelvis.y-(s.nextK.pos.y-loaded.pelvis.y)*(1-u);
    p.pelvis.y=THREE.MathUtils.lerp(loaded.pelvis.y,spring,smooth((ctx.t-s.loadT)/.035));
    const reach=smooth((ctx.t-s.loadT)/Math.max(.08,s.endT-s.loadT));
    p.hands=blendHands(loaded,live,reach);
    const release=smooth((ctx.t-s.pushUntil)/(s.releaseT-s.pushUntil));
    const ankle=push.clone(),roll=.45*smooth((ctx.t-s.loadT)/.12)*(1-release);
    const toe=V(0,-Math.sin(roll),Math.cos(roll)),bootUp=V(0,Math.cos(roll),Math.sin(roll));
    const pivot=push.clone().setY(.001).addScaledVector(forward,.16*KS);
    ankle.copy(pivot).addScaledVector(bootUp,.093*KS).addScaledVector(toe,-.16*KS);
    p.feet[s.pushKey]=ankle.lerp(destination.feet[s.pushKey],release);
    p.toe[s.pushKey]=slerpDir(toe,destination.toe[s.pushKey],release);
    p.footUp[s.pushKey]=slerpDir(bootUp,destination.footUp[s.pushKey],release);
    const frame=chestAxes(p);
    for(const [key,sign] of [['l',1],['r',-1]]){
      const shoulder=frame.origin.clone().addScaledVector(frame.left,sign*kickModel.shoulder[0]*KS)
        .addScaledVector(frame.up,kickModel.shoulder[1]*KS).addScaledVector(frame.fwd,kickModel.shoulder[2]*KS);
      const delta=p.hands[key].clone().sub(shoulder),limit=(kickModel.upperArm+kickModel.foreArm+.11)*KS*.98;
      if(delta.length()>limit)p.hands[key].lerp(shoulder.add(delta.setLength(limit)),1-u);
    }
  }
  p.physicsReachWeight=0;p.shoulderReach=1;p.look=ctx.ball.clone();
  return p;
}

function keeperGroundRecovery(ctx,landing) {
  const age=ctx.t-landing.t,side=Math.sign(landing.k.lean.s)||Math.sign(landing.k.act?.vx)||1;
  const source=keeperLive({...ctx,k:landing.k,t:landing.t,kvx:0,ball:landing.ball?V().fromArray(landing.ball):ctx.ball});
  // Absorb impact onto the outer thigh and shoulder. Keep a bent top leg and
  // draw the reaching hands towards the chest before planting a support palm.
  const settle=.26,hold=.10,roll=.52,rise=2.15,turn=.7;
  const slide=landing.slide??.07*KS;
  const pelvis=source.pelvis.clone().add(V(side*slide,0,.025*KS)).setY(.235*KS);
  const up=V(side*.993,.118,0).normalize(),fwd=V(0,0,1),left=V().crossVectors(up,fwd);
  const lying={
    pelvis,up,fwd,chestUp:V(side*.997,.077,0).normalize(),chestFwd:fwd.clone(),
    articulatedTorso:true,anatomicalArms:true,shoulderReach:1,
    hands:{},feet:{},palm:{l:V(0,-1,0),r:V(0,-1,0)},
    handDirection:{l:fwd.clone(),r:fwd.clone()},handBend:{l:.8,r:.8},
    elbowPole:{},kneePole:{},toe:{},footUp:{},grip:{l:.08,r:.08},
    look:ctx.ball.clone(),physicsReachWeight:0,
  };
  for(const [key,sign] of [['l',1],['r',-1]]){
    const bottom=sign===side;
    lying.hands[key]=pelvis.clone().addScaledVector(up,(bottom ? .36 : .40)*KS)
      .addScaledVector(fwd,(bottom ? .31 : .20)*KS).addScaledVector(left,sign*.12*KS);
    lying.hands[key].y=(bottom ? .105 : .39)*KS;
    lying.feet[key]=pelvis.clone().addScaledVector(up,(bottom ? -.65 : -.49)*KS)
      .addScaledVector(fwd,(bottom ? .06 : -.22)*KS).setY((bottom ? .094 : .24)*KS);
    lying.elbowPole[key]=fwd.clone().addScaledVector(up,-.65).addScaledVector(UP,.25).normalize();
    lying.kneePole[key]=UP.clone().addScaledVector(fwd,.20).normalize();
    lying.toe[key]=fwd.clone();lying.footUp[key]=UP.clone();
  }
  if(age<settle){
    const p=recoveryBlend(source,lying,smooth(age/settle),true);p.physicsReachWeight=0;
    p.recoveryPhase='landing';return p;
  }
  if(age<settle+hold){lying.recoveryPhase='side';return lying;}

  // Match the prone capture to the landing's head direction. Its world-space
  // feet and support wrists follow the captured knee/foot push-up.
  const first=sampleBodyMotion('getup',0);
  const yaw=Math.atan2(up.x,up.z)-Math.atan2(first.up.x,first.up.z);
  const forward=V(0,0,1).applyAxisAngle(UP,yaw),across=V().crossVectors(UP,forward);
  const firstHip=across.clone().multiplyScalar(first.pelvis.x*KS).addScaledVector(forward,first.pelvis.z*KS);
  const fr=frame(pelvis.clone().setY(0).sub(firstHip),forward);
  const rollAge=age-settle-hold;
  if(rollAge<roll){
    const prone=groundedCapture(0,fr,ctx.ball),p=recoveryBlend(lying,prone,smooth(rollAge/roll));
    p.physicsReachWeight=0;p.recoveryPhase='roll';return p;
  }
  const riseAge=rollAge-roll;
  if(riseAge<rise){
    const p=groundedCapture(clamp01(riseAge/rise),fr,ctx.ball);
    p.physicsReachWeight=0;p.recoveryPhase='getup';return p;
  }
  const finish=groundedCapture(1,fr,ctx.ball);
  const standing=frame(finish.pelvis.clone().setY(0),V(0,0,1));
  // Reorient by stepping after the foot-supported rise, then react to the shot.
  const reaction=keeperMood(standing,ctx.outcome,Math.max(0,riseAge-rise-turn),ctx.ball);
  const p=stepBlend(finish,reaction,smooth((riseAge-rise)/turn),KS);
  p.physicsReachWeight=0;p.recoveryPhase=riseAge<rise+turn?'stand':'ready';
  // A long live interval may contain another commitment. Rejoin its recorded
  // body with foot placements before that action starts, never at a contact.
  if(Number.isFinite(landing.until) && ctx.t>landing.until-.55){
    const target=keeperLive(ctx),u=smooth((ctx.t-landing.until+.55)/.55);
    return stepBlend(p,target,u,KS);
  }
  return p;
}

function keeperAfter(ctx) {
  const endPose=keeperLive({...ctx,k:ctx.endK,t:ctx.endT,kvx:0});
  const te=ctx.t-ctx.endT,lying=endPose.up.y<.65;
  if(!lying){
    const fr=frame(endPose.pelvis.clone().setY(0),V(0,0,1));
    const pose=stepBlend(endPose,keeperMood(fr,ctx.outcome,Math.max(0,te-.6),ctx.ball),smooth(te/.65),KS);
    const axes=chestAxes(pose),left=V().crossVectors(axes.up,axes.fwd).normalize();
    // As the hands lower from an overhead reach, carry the elbows outside
    // the shoulders instead of allowing the IK bend plane to pass through zero.
    pose.elbowPole={};
    for(const [key,sign] of [['l',1],['r',-1]]){
      const relaxed=left.clone().multiplyScalar(sign).addScaledVector(axes.fwd,.15).addScaledVector(axes.up,-.15).normalize();
      pose.elbowPole[key]=slerpDir(endPose.elbowPole[key].clone().normalize(),relaxed,smooth(te/.18));
    }
    return pose;
  }
  return keeperGroundRecovery(ctx,{t:ctx.endT,k:ctx.endK,until:Infinity});
}

// ====================================================================== taker

const ANK = 0.088; // ankle height when the boot is flat on the grass

export function takerGeometry(launch) {
  const f = V(launch.footDir.x, launch.footDir.y, launch.footDir.z);
  const fh = V(f.x, 0, f.z).normalize();
  const right = V(-fh.z, 0, fh.x);
  const plant = V(0, ANK, 0).addScaledVector(right, -0.3).addScaledVector(fh, 0.03);
  const approach = fh.clone().multiplyScalar(0.82).addScaledVector(right, 0.57).normalize();
  const start = plant.clone().addScaledVector(right, 0.12).addScaledVector(approach, -2.6).setY(0);
  const cp = V(launch.contactPoint.x, launch.contactPoint.y, launch.contactPoint.z);
  const strike = cp.clone().addScaledVector(fh, -0.11).addScaledVector(UP, 0.075);
  const plantPelvis = plant.clone().addScaledVector(right, 0.17).addScaledVector(fh, -0.18).setY(0);
  return { f, fh, right, plant, approach, start, strike, plantPelvis };
}

// ctx: { t, clock, launch, ball, outcome, decidedAt, charging }
export function takerPose(ctx) {
  const G = takerGeometry(ctx.launch), idle = ctx.t == null;
  const t = idle ? -RUNUP : ctx.t;
  const capture = sampleKick(captureTime(t));
  const turn = idle ? 0 : smooth((t + RUNUP) / 0.4);
  const forward = slerpDir(V(0, 0, -1), G.fh, turn);
  const left = V().crossVectors(UP, forward), base = V(0.3, 0, -0.03).lerp(G.plant.clone().setY(0), turn);
  const vector = v => left.clone().multiplyScalar(v.x).addScaledVector(UP, v.y).addScaledVector(forward, v.z);
  const point = v => base.clone().add(vector(v));
  const pelvis = point(capture.pelvis), up = vector(capture.up).normalize(), fwd = vector(capture.fwd).normalize();
  const chestUp = vector(capture.chestUp).normalize(), chestFwd = vector(capture.chestFwd).normalize();
  const chestLeft = V().crossVectors(chestUp, chestFwd).normalize();
  const hands = {}, feet = {}, elbowPole = {}, kneePole = {}, toe = {}, palm = {}, footUp = {};
  const handOffset = .075;
  for (const [key, side, sign] of [['l','L',1],['r','R',-1]]) {
    const shoulder = pelvis.clone().addScaledVector(chestLeft, sign * kickModel.shoulder[0])
      .addScaledVector(chestUp, kickModel.shoulder[1]).addScaledVector(chestFwd, kickModel.shoulder[2]);
    const upper = vector(capture['upper' + side]), fore = vector(capture['fore' + side]);
    hands[key] = shoulder.addScaledVector(upper, kickModel.upperArm).addScaledVector(fore, kickModel.foreArm + handOffset);
    elbowPole[key] = upper;
    kneePole[key] = vector(capture['thigh' + side]);
    feet[key] = point(capture['ankle' + side]);
    toe[key] = vector(capture['toe' + side]);
    footUp[key] = UP.clone().addScaledVector(toe[key],-UP.dot(toe[key])).normalize();
    palm[key] = chestFwd.clone().multiplyScalar(.35).addScaledVector(chestLeft, -sign * .65).addScaledVector(chestUp, -.3).normalize();
  }
  // The support forefoot stays planted while the ankle rolls over it.
  const plantWeight = smooth((t + .27) / .1) * (1 - smooth((t - .32) / .15));
  const supportToe=vector(sampleKick(captureTime(-.15)).toeL);
  const horizontal=V(supportToe.x,0,supportToe.z).normalize();
  const pivot=G.plant.clone().setY(.001).addScaledVector(horizontal,.12);
  const planted= pivot.clone().addScaledVector(footUp.l,.093).addScaledVector(toe.l,-.12);
  feet.l.lerp(planted, plantWeight);
  // Correct the captured striking ankle, smoothly, to the unchanged contact key.
  const contact = point(sampleKick(0).ankleR);
  const correction = G.strike.clone().sub(contact);
  feet.r.addScaledVector(correction, Math.exp(-Math.pow(t / .13, 2)));
  if (t === 0) feet.r.copy(G.strike);
  const breath = idle || t > .85 ? Math.sin((idle?ctx.clock:t+RUNUP) * 2.1) : 0;
  pelvis.y += breath * .003;
  const head = pelvis.clone().addScaledVector(chestUp, kickModel.head[1]).addScaledVector(chestFwd, kickModel.head[2]);
  const capturedLook = vector(capture.headFwd).normalize();
  const aimLook = (idle ? V(0, 1.2, GOAL.Z) : ctx.ball).clone().sub(head).normalize();
  const gaze = slerpDir(capturedLook, aimLook, idle ? .65 : .2);
  let pose = {pelvis, up, fwd, chestUp, chestFwd, hands, feet, elbowPole, kneePole, toe, palm, footUp,
    look: head.addScaledVector(gaze, 2), breath, grip:{l:.24,r:.24}};
  if (ctx.outcome && ctx.decidedAt != null) {
    const te = t - Math.max(ctx.decidedAt, .8);
    if (te > 0) {
      const fr = frame(pelvis.clone().setY(0), fwd);
      pose = blendPose(pose, takerMood(pose, fr, ctx.outcome, te, ctx.ball), smooth(te / .55));
    }
  }
  return pose;
}

function takerStand(fr,ball) {
  return {pelvis:at(fr,0,.96,0),up:UP.clone(),fwd:fr.f.clone(),bend:.035,
    hands:{l:at(fr,.25,.92,.05),r:at(fr,-.25,.92,.05)},
    feet:{l:at(fr,.13,.094,.04),r:at(fr,-.13,.094,-.04)},
    toe:{l:fr.f.clone(),r:fr.f.clone()},footUp:{l:UP.clone(),r:UP.clone()},
    kneePole:{l:fr.f.clone(),r:fr.f.clone()},
    elbowPole:{l:fr.l.clone().addScaledVector(UP,-.7),r:fr.l.clone().negate().addScaledVector(UP,-.7)},
    grip:{l:.25,r:.25},look:ball.clone()};
}

function takerMood(base,fr,outcome,te,ball) {
  const g0=base.pelvis.clone().setY(0);
  if(outcome==='goal'){
    const dir=V(-1,0,.55).normalize(),distance=4.6*smooth((te-.2)/2.75);
    const moving=frame(g0.clone().addScaledVector(dir,distance),dir);
    const run=capturedBodyPose('jog',distance/motionClips.jog.stride,moving,{ball,grip:.42});
    const finish=frame(g0.clone().addScaledVector(dir,4.6),V(0,0,1));
    const standing=takerStand(finish,V(0,1.6,8));
    const p=stepBlend(run,standing,smooth((te-2.65)/.95));
    const gesture=smooth((te-3.55)/.3)*(1-smooth((te-4.65)/.6));
    const pump=.10*bump(te,3.8,4.5);
    const hands={l:at(finish,.28,1.88+pump,.10),r:at(finish,-.28,1.09,.13)};
    p.hands=lerpPair(p.hands,hands,gesture);
    p.grip={l:.42+.55*gesture,r:.35};
    p.breath=.35*Math.sin(te*2)*(smooth((te-3)/.5));
    return p;
  }
  const dir=V(-1,0,.7).normalize(),distance=4*smooth((te-1.15)/4.2);
  const moving=frame(g0.clone().addScaledVector(dir,distance),dir);
  const walk=capturedBodyPose('walk',distance/motionClips.walk.stride,moving,{ball,grip:.25});
  const finish=frame(g0.clone().addScaledVector(dir,4),dir);
  const standing=takerStand(finish,at(finish,0,.3,2));
  const p=stepBlend(walk,standing,smooth((te-5.05)/.85));
  const gesture=smooth(te/.3)*(1-smooth((te-1.5)/.6));
  p.hands=lerpPair(p.hands,temples(p,1),gesture);
  const left=V().crossVectors(p.up,p.fwd).normalize();
  const out={l:left.clone().addScaledVector(UP,.25),r:left.clone().negate().addScaledVector(UP,.25)};
  p.elbowPole={l:slerpDir(p.elbowPole.l,out.l.normalize(),gesture),r:slerpDir(p.elbowPole.r,out.r.normalize(),gesture)};
  p.grip={l:.18,r:.18};
  p.look=ball.clone().lerp(at(moving,0,.2,2),smooth((te-1.1)/.9));
  return p;
}
