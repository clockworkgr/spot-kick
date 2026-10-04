// Local CC0 anatomical assets. Only the visual rig imports this module.
import * as THREE from 'three';

const root = new URL('../assets/players/', import.meta.url);
const [data, buffer] = await Promise.all([
  fetch(new URL('player.json', root),{cache:'no-cache'}).then(r => { if (!r.ok) throw new Error('Player geometry unavailable'); return r.json(); }),
  fetch(new URL('player.bin', root),{cache:'no-cache'}).then(r => { if (!r.ok) throw new Error('Player geometry unavailable'); return r.arrayBuffer(); }),
]);
const arrays = {float32: Float32Array, uint16: Uint16Array, uint32: Uint32Array};
const geometries = {};
for (const [name, attributes] of Object.entries(data.meshes)) {
  const g = new THREE.BufferGeometry();
  for (const [key, spec] of Object.entries(attributes)) {
    const a = new arrays[spec.type](buffer, spec.offset, spec.length);
    const attribute = new THREE.BufferAttribute(a, key === 'uv' ? 2 : key.startsWith('skin') ? 4 : key === 'index' ? 1 : 3);
    if (key === 'index') g.setIndex(attribute); else g.setAttribute(key, attribute);
  }
  geometries[name] = g;
}
const loader = new THREE.TextureLoader();
const textures = Object.fromEntries(await Promise.all([
  ['skin', 'skin.jpg'], ['relief', 'skin-relief.jpg'], ['hair-short', 'hair-short.png'],
  ['hair-crop', 'hair-crop.png'], ['eyes', 'eyes.png'], ['brows', 'brows.png'],
].map(async ([name, file]) => {
  const t = await loader.loadAsync(new URL(file, root).href);
  if (name !== 'relief') t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return [name, t];
})));

export const playerAssets = {bones: data.bones, geometries, textures};
