// Absolute-time sampling keeps live shots and replays identical.
import * as THREE from 'three';
import { kickMotion } from './kick-motion-data.js?v=2';

export const kickModel = kickMotion.model;

export function sampleKick(time) {
  const t = THREE.MathUtils.clamp(time, kickMotion.start, kickMotion.end);
  const f = (t - kickMotion.start) * kickMotion.fps;
  const count = kickMotion.channels.pelvis.length / 3;
  const a = Math.min(count - 1, Math.floor(f)), b = Math.min(count - 1, a + 1), u = f - a;
  const pose = {};
  for (const [name, data] of Object.entries(kickMotion.channels)) {
    pose[name] = new THREE.Vector3().fromArray(data, a * 3).lerp(new THREE.Vector3().fromArray(data, b * 3), u);
    if (name !== 'pelvis' && !name.startsWith('ankle')) pose[name].normalize();
  }
  return pose;
}

export function captureTime(t) {
  if (t < 0) {
    const u = THREE.MathUtils.clamp((t + .85) / .85, 0, 1);
    // Start from rest and reach the original captured speed at contact.
    return -.85 + .85 * u * u * (2 - u);
  }
  if (t > .6) {
    const u = THREE.MathUtils.clamp((t - .6) / .25, 0, 1);
    return .6 + .25 * (u + u * u - u * u * u);
  }
  return t;
}
