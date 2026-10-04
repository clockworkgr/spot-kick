// Shared display-space spine frame. Physics has no dependency on this module.
import * as THREE from 'three';

export function torsoFrame(p, scale = 1) {
  const up=p.up.clone().normalize();
  const fwd=p.fwd.clone().addScaledVector(up,-p.fwd.dot(up)).normalize();
  const bend=p.bend||0;
  const chestUp=p.chestUp?.clone().normalize() || up.clone().multiplyScalar(Math.cos(bend)).addScaledVector(fwd,Math.sin(bend));
  const chestFwd=p.chestFwd?.clone() || fwd.clone().multiplyScalar(Math.cos(bend)).addScaledVector(up,-Math.sin(bend)).applyAxisAngle(chestUp,p.twist||0);
  chestFwd.addScaledVector(chestUp,-chestFwd.dot(chestUp)).normalize();
  const abdomenUp=up.clone().lerp(chestUp,.45).normalize();
  const abdomenFwd=fwd.clone().lerp(chestFwd,.45);
  abdomenFwd.addScaledVector(abdomenUp,-abdomenFwd.dot(abdomenUp)).normalize();
  const abdomenOrigin=p.pelvis.clone(),origin=p.pelvis.clone();
  if(p.articulatedTorso){
    // The source skin's merged spine bones share an origin. Move that origin
    // so each rotation occurs at an anatomical spine pivot, rather than
    // rotating the entire upper body independently around the hips.
    abdomenOrigin.addScaledVector(up,.12*scale).addScaledVector(abdomenUp,-.12*scale);
    origin.copy(abdomenOrigin).addScaledVector(abdomenUp,.28*scale).addScaledVector(chestUp,-.28*scale);
  }
  return {up:chestUp,fwd:chestFwd,left:new THREE.Vector3().crossVectors(chestUp,chestFwd).normalize(),origin,abdomenUp,abdomenFwd,abdomenOrigin};
}
