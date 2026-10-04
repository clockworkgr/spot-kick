"""Bake display-only CMU locomotion and ground recovery. Requires numpy."""
import importlib.util
import json
from pathlib import Path
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'assets/motion/source'
spec = importlib.util.spec_from_file_location('motion_source', Path(__file__).with_name('motion-source.py'))
motion = importlib.util.module_from_spec(spec)
spec.loader.exec_module(motion)
rest = {b['name']: b for b in json.loads((ROOT / 'assets/players/player.json').read_text())['bones']}
leg_length = sum(np.linalg.norm(np.array(rest[n]['end']) - rest[n]['start']) for n in ['thigh.L', 'shin.L'])


def bake(source, looping):
    bones, p, rotations = motion.read(SOURCE / (source.split('_')[0] + '.asf'), SOURCE / (source + '.amc'))
    scale = leg_length / np.mean([sum(bones[s + n]['length'] for n in ['femur', 'tibia']) for s in ['l', 'r']])
    hip = (p['lhipjoint'] + p['rhipjoint']) / 2
    if looping:
        forward = hip[-1] - hip[0]
    else:
        forward = np.mean([r['thorax'][:, 2] for r in rotations[-60:]], axis=0)
    forward[1] = 0
    forward /= np.linalg.norm(forward)
    basis = np.array([np.cross([0, 1, 0], forward), [0, 1, 0], forward])
    ground = np.median(np.concatenate([p[s + 'tibia'][-60:, 1] for s in ['l', 'r']])) if not looping else np.percentile(np.concatenate([p[s + 'tibia'][:, 1] for s in ['l', 'r']]), 8)
    anchor = hip[-1].copy() if not looping else hip[0].copy()
    anchor[1] = ground - .094 / scale
    pos = lambda a: (a - anchor) @ basis.T * scale
    def direction(a):
        a = a @ basis.T
        return a / np.maximum(np.linalg.norm(a, axis=1)[:, None], 1e-12)
    channels = {'pelvis': pos(hip)}
    for name, bone, axis in [('up', 'root', 1), ('fwd', 'root', 2), ('chestUp', 'thorax', 1), ('chestFwd', 'thorax', 2), ('headFwd', 'head', 2)]:
        channels[name] = direction(motion.filtered(np.array([r[bone][:, axis] for r in rotations])))
    for s in ['l', 'r']:
        side = s.upper()
        for name, a, b in [('upper', 'humerus', 'clavicle'), ('fore', 'radius', 'humerus'), ('thigh', 'femur', 'hipjoint'), ('shin', 'tibia', 'femur')]:
            channels[name + side] = direction(p[s + a] - p[s + b])
        channels['ankle' + side] = pos(p[s + 'tibia'])
        channels['wrist' + side] = pos(p[s + 'radius'])
        toe = direction(p[s + 'foot'] - p[s + 'tibia'])
        theta = np.arctan2(-bones[s + 'foot']['direction'][1], np.linalg.norm(bones[s + 'foot']['direction'][[0, 2]]))
        horizontal = np.linalg.norm(toe[:, [0, 2]], axis=1)
        pitch = np.arctan2(toe[:, 1], horizontal) + theta
        toe[:, [0, 2]] *= np.cos(pitch)[:, None] / np.maximum(horizontal[:, None], 1e-12)
        toe[:, 1] = np.sin(pitch)
        channels['toe' + side] = toe
    if looping:
        # Root progress drives the gait: stance feet cancel the game's travel.
        planar = channels['pelvis'].copy()
        planar[:, 1] = 0
        for name in ['pelvis', 'ankleL', 'ankleR', 'wristL', 'wristR']:
            channels[name] -= planar
        feature = np.concatenate([channels[n] for n in ['ankleL', 'ankleR', 'thighL', 'thighR', 'foreL', 'foreR']], axis=1)
        candidates = []
        starts, periods = (range(175, 300), range(110, 155)) if source == '10_04' else (range(5, 75), range(65, 90))
        for start in starts:
            for period in periods:
                end = start + period
                if end >= len(feature) - 3:
                    continue
                delta = np.linalg.norm(feature[start] - feature[end])
                velocity = np.linalg.norm((feature[start + 2] - feature[start - 2]) - (feature[end + 2] - feature[end - 2]))
                candidates.append((delta + velocity * 2, start, end))
        _, start, end = min(candidates)
        distance = (hip @ basis.T)[:, 2] * scale
        stride = distance[end] - distance[start]
        progress = (distance[start:end + 1] - distance[start]) / stride
        samples = np.linspace(0, 1, 65)
        data = {n: np.array([np.interp(samples, progress, a[start:end + 1, axis]) for axis in range(3)]).T for n, a in channels.items()}
        # Match the two ends with a narrow, smooth seam correction.
        for n, a in data.items():
            seam = a[-1] - a[0]
            a -= (samples ** 12)[:, None] * seam
        metadata = {'stride': float(stride), 'duration': (end - start) / 120, 'loop': True}
    else:
        start, end = 176, 470
        data = {n: a[start:end + 1:2].copy() for n, a in channels.items()}
        metadata = {'duration': (end - start) / 120, 'loop': False}
    print(source, 'frames', start + 1, end + 1, metadata)
    return {**metadata, 'samples': len(data['pelvis']), 'channels': {n: a.round(6).reshape(-1).tolist() for n, a in data.items()}}


clips = {'walk': bake('10_04', True), 'jog': bake('02_03', True), 'getup': bake('139_16', False)}
out = ROOT / 'src/body-motion-data.js'
out.write_text('// Derived from CMU mocap; see assets/motion/CREDITS.md.\nexport const bodyMotion = ' + json.dumps(clips, separators=(',', ':')) + ';\n')
print(out.stat().st_size, 'bytes')
