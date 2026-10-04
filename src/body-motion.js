// Display-only locomotion and ground recovery sampled at absolute phase.
import * as THREE from 'three';
import { bodyMotion } from './body-motion-data.js';
import { kickModel } from './kick-motion.js?v=2';

export const motionClips = bodyMotion;

export function sampleBodyMotion(name, phase) {
  const clip = bodyMotion[name];
  const u = clip.loop ? ((phase % 1) + 1) % 1 : THREE.MathUtils.clamp(phase, 0, 1);
  const f = u * (clip.samples - 1), a = Math.floor(f), b = Math.min(clip.samples - 1, a + 1);
  const pose = {};
  for (const [key, data] of Object.entries(clip.channels)) {
    pose[key] = new THREE.Vector3().fromArray(data, a * 3).lerp(new THREE.Vector3().fromArray(data, b * 3), f - a);
    if (!/^(pelvis|ankle|wrist)/.test(key)) pose[key].normalize();
  }
  return pose;
}

export function capturedBodyPose(name, phase, fr, {scale = 1, handOffset = .075, ball, grip = .3} = {}) {
  const capture = sampleBodyMotion(name, phase), UP = new THREE.Vector3(0, 1, 0);
  const vector = v => fr.l.clone().multiplyScalar(v.x).addScaledVector(UP, v.y).addScaledVector(fr.f, v.z);
  const point = v => fr.g.clone().addScaledVector(vector(v), scale);
  const pelvis = point(capture.pelvis), up = vector(capture.up), fwd = vector(capture.fwd);
  const chestUp = vector(capture.chestUp), chestFwd = vector(capture.chestFwd);
  const chestLeft = new THREE.Vector3().crossVectors(chestUp, chestFwd).normalize();
  const hands = {}, feet = {}, toe = {}, footUp = {}, elbowPole = {}, kneePole = {}, palm = {},handBend={},handDirection={},palmLock={},groundHands={};
  for (const [key, side, sign] of [['l', 'L', 1], ['r', 'R', -1]]) {
    const shoulder = pelvis.clone().addScaledVector(chestLeft, sign * kickModel.shoulder[0] * scale)
      .addScaledVector(chestUp, kickModel.shoulder[1] * scale).addScaledVector(chestFwd, kickModel.shoulder[2] * scale);
    const upper = vector(capture['upper' + side]), fore = vector(capture['fore' + side]);
    hands[key] = shoulder.clone().addScaledVector(upper, kickModel.upperArm * scale)
      .addScaledVector(fore, (kickModel.foreArm + handOffset) * scale);
    feet[key] = point(capture['ankle' + side]);
    toe[key] = vector(capture['toe' + side]);
    footUp[key] = UP.clone().addScaledVector(toe[key], -UP.dot(toe[key])).normalize();
    elbowPole[key] = upper;
    kneePole[key] = vector(capture['thigh' + side]);
    palm[key] = chestLeft.clone().multiplyScalar(-sign).addScaledVector(chestFwd, .25).normalize();
    if (name === 'getup') {
      const wrist = point(capture['wrist' + side]);
      const support = 1 - THREE.MathUtils.smoothstep(wrist.y / scale, .15, .32);
      const target = wrist.addScaledVector(fore, handOffset * scale).setY((.035+.18*(1-support))*scale);
      const reach = (kickModel.upperArm + kickModel.foreArm + handOffset - .005) * scale;
      const delta = target.clone().sub(shoulder);
      if (delta.length() > reach) target.copy(shoulder).addScaledVector(delta.normalize(), reach);
      hands[key].lerp(target, support);
      palm[key].lerp(new THREE.Vector3(0, -1, 0), support).normalize();
      handBend[key]=support;handDirection[key]=fr.f.clone();palmLock[key]=support;groundHands[key]=1;
    }
  }
  const head = pelvis.clone().addScaledVector(chestUp, kickModel.head[1] * scale).addScaledVector(chestFwd, kickModel.head[2] * scale);
  const gaze = vector(capture.headFwd);
  const look = head.addScaledVector(gaze, 3);
  if (ball && name !== 'getup') look.lerp(ball, .2);
  return {pelvis, up, fwd, chestUp, chestFwd, hands, feet, toe, footUp, elbowPole, kneePole, palm,
    look, grip: {l: grip, r: grip},handBend,handDirection,palmLock,groundHands};
}
