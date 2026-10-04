# Player motion

The taker's plant, swing, hip rotation, counterbalancing arms and follow-through
are derived from **Carnegie Mellon University Graphics Lab Motion Capture
Database**, subject 10, trial 01 (soccer — kick ball), recorded at 120 Hz.

- [Capture index](https://mocap.cs.cmu.edu/search.php?subjectnumber=10)
- [Dataset and usage terms](https://mocap.cs.cmu.edu/)

The data used in this project was obtained from mocap.cs.cmu.edu.
The database was created with funding from NSF EIA-0196217.

The dataset permits inclusion in products, including commercial products, but
prohibits selling the motion data itself, including converted data. The source
files here support rebuilding this game's derived animation and are not a
standalone motion-data product. These motions are separate from the CC0 model
assets in `assets/players`.

`tools/build-kick-motion.py` is original project code. It parses the ASF/AMC data,
evaluates forward kinematics, filters tracking noise, normalizes the actor to the
model's leg lengths, aligns the kick direction, and bakes a 60 Hz clip. The derived
clip is `src/kick-motion-data.js` (about 53 KB). Frame 597 is aligned to contact.
The game samples it at absolute time and applies IK to the support foot and the
unchanged striking contact key. No motion data enters `physics.js`.

Additional captures from the same database provide locomotion and recovery:

| Clip | Capture | Use |
| --- | --- | --- |
| Walk | [10, trial 04](https://mocap.cs.cmu.edu/search.php?subjectnumber=10) | Taker walking after a miss or save |
| Jog | [02, trial 03](https://mocap.cs.cmu.edu/search.php?subjectnumber=2) | Taker running after a goal |
| Ground recovery | [139, trial 16](https://mocap.cs.cmu.edu/search.php?subjectnumber=139) | Keeper knees-under-body scramble and post-shot get-up |

`tools/motion-source.py` contains original ASF/AMC parsing and forward kinematics.
`tools/build-body-motion.py` filters and retargets the captures and extracts cyclic
gaits. Walking and jogging are sampled by root distance to preserve stance footwork.
The derived clips in `src/body-motion-data.js` total about 156 KB.
Keeper push-off, dive, landing, side-to-front roll and reaction styling are authored
project animation. Recorded body and glove positions constrain ball-contact poses;
clear recovery intervals use a separate visual root and the captured get-up.
The deterministic simulation is unchanged.

Rebuild with Python and numpy:

```sh
python3 tools/build-kick-motion.py
python3 tools/build-body-motion.py
```
