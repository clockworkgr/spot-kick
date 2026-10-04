# Player assets

The anatomical base mesh, athletic male morphs, skin weights, skin texture, eyes,
eyebrows, hair and fitted garment sources are **CC0** assets from the MakeHuman
Community. Only asset data is included; no MakeHuman application code is used.

- Base/morph/rig sources: [MakeHuman repository](https://github.com/makehumancommunity/makehuman),
  pinned to `a8bc2d54ff0ac92e78ff71431b1023eda42bf482`.
- Skin, short02/short04 hair, high-poly eyes with brown irises, eyebrow001,
  and male_casualsuit02/04 garment sources:
  [official CC0 system asset pack](https://static.makehumancommunity.org/assets/assetpacks/makehuman_system_assets.html).
- The source files retain their author and license headers. The complete asset
  license is saved in [source/LICENSE-CC0.md](source/LICENSE-CC0.md).

The derived football models use a young male anatomical morph with 72% athletic
muscle shaping, smooth fitted jerseys, cropped shorts, calf socks and latex gloves.
The application uses a simplified display skeleton driven by the existing IK
targets. Display meshes and textures never enter the physics simulator.

Runtime assets are `player.json`, `player.bin`, `skin.jpg`, `skin-relief.jpg`,
`eyes.png`, `brows.png`, `hair-short.png` and `hair-crop.png`. They are served locally
and require no remote asset service. The geometry is about 4.7 MB; textures are
downsampled and compressed for the browser. The original source data is retained
for rebuilding and is not loaded by the game.

To rebuild, use Python with numpy and Pillow:

```sh
python3 tools/build-player-assets.py
```

The geometry builder is original project code. It applies asset morphs, fits
garments, subdivides cloth, welds open hems, maps weights to 47 display bones
(including 30 finger joints),
duplicates UV seams and writes indexed buffers with four influences per vertex.
