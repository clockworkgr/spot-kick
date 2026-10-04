"""Read ASF/AMC capture data with original, offline forward kinematics."""
import numpy as np


def rotation(angles):
    x, y, z = np.radians(angles)
    sx, cx, sy, cy, sz, cz = np.sin(x), np.cos(x), np.sin(y), np.cos(y), np.sin(z), np.cos(z)
    return (np.array([[cz, -sz, 0], [sz, cz, 0], [0, 0, 1]])
            @ np.array([[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]])
            @ np.array([[1, 0, 0], [0, cx, -sx], [0, sx, cx]]))


def filtered(a):
    pad = np.pad(a, ((2, 2), (0, 0)), mode='edge')
    return sum(pad[i:i + len(a)] * w for i, w in enumerate([1, 2, 3, 2, 1])) / 9


def read(asf, amc):
    bones, parents, section, bone = {}, {}, '', None
    for line in asf.read_text().splitlines():
        s = line.split()
        if not s:
            continue
        if s[0].startswith(':'):
            section = s[0]
            continue
        if section == ':bonedata':
            if s[0] == 'begin':
                bone = {}
            elif s[0] == 'end':
                bones[bone['name']] = bone
            elif s[0] in ['name', 'dof']:
                bone[s[0]] = s[1] if s[0] == 'name' else s[1:]
            elif s[0] in ['direction', 'axis', 'length']:
                bone[s[0]] = float(s[1]) if s[0] == 'length' else np.array(list(map(float, s[1:4])))
        elif section == ':hierarchy' and s[0] not in ['begin', 'end']:
            parents.update({name: s[0] for name in s[1:]})
    for bone in bones.values():
        bone['C'] = rotation(bone['axis'])
    frames, frame = [], None
    for line in amc.read_text().splitlines():
        s = line.split()
        if not s or s[0].startswith(('#', ':')):
            continue
        if s[0].isdigit():
            if frame:
                frames.append(frame)
            frame = {}
        else:
            frame[s[0]] = list(map(float, s[1:]))
    frames.append(frame)
    points, rotations = [], []
    for frame in frames:
        root = np.array(frame['root'])
        p, r = {'root': root[:3]}, {'root': rotation(root[3:])}
        for name, bone in bones.items():
            values = np.zeros(3)
            for axis, angle in zip(bone.get('dof', []), frame.get(name, [])):
                values[['rx', 'ry', 'rz'].index(axis)] = angle
            local = bone['C'] @ rotation(values) @ bone['C'].T
            r[name] = r[parents[name]] @ local
            p[name] = p[parents[name]] + r[name] @ bone['direction'] * bone['length']
        points.append(p)
        rotations.append(r)
    return bones, {n: filtered(np.array([p[n] for p in points])) for n in points[0]}, rotations
