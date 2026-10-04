"""Build the display-only athletic mesh from CC0 MakeHuman source assets.

Run with Python, numpy and Pillow. No MakeHuman application code is used.
The generated buffers contain UVs, smooth normals and four skin influences.
"""
from pathlib import Path
import json
import numpy as np
from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'assets/players/source'
OUT = ROOT / 'assets/players'

def obj(path):
    verts, uv, faces, groups = [], [], [], []
    group = ''
    for line in path.read_text().splitlines():
        s = line.split()
        if not s: continue
        if s[0] == 'v': verts.append([float(x) for x in s[1:4]])
        elif s[0] == 'vt': uv.append([float(x) for x in s[1:3]])
        elif s[0] == 'g': group = s[1]
        elif s[0] == 'f':
            faces.append([(int(x.split('/')[0])-1, int(x.split('/')[1])-1) for x in s[1:]])
            groups.append(group)
    return np.array(verts), np.array(uv), faces, groups

base, base_uv, base_faces, groups = obj(SOURCE / 'base.obj')
human = base.copy()
for name, strength in [('male.target', 1), ('athletic.target', .72)]:
    for line in (SOURCE / name).read_text().splitlines():
        if line and not line.startswith('#'):
            s = line.split(); human[int(s[0])] += np.array([float(x) for x in s[1:]]) * strength

skel = json.loads((SOURCE / 'skeleton.json').read_text())
def joint(bone, end='head'):
    return human[skel['joints'][skel['bones'][bone][end]]].mean(axis=0)

origin = joint('root', 'tail')
height = np.ptp(human[:13380, 1])
unit = 1.85 / height
def norm(v): return (v-origin)*unit

names = ['pelvis', 'abdomen', 'chest', 'neck', 'head']
for side in ['L', 'R']: names += [f'upper.{side}', f'fore.{side}', f'hand.{side}', f'thigh.{side}', f'shin.{side}', f'foot.{side}']
for side in ['L', 'R']:
    names += [f'finger{finger}-{segment}.{side}' for finger in range(1, 6) for segment in range(1, 4)]
bone_index = {n:i for i,n in enumerate(names)}
def mapped(n):
    side = n[-1]
    if n.startswith('upperarm'): return 'upper.'+side
    if n.startswith('lowerarm'): return 'fore.'+side
    if n.startswith('finger'): return n
    if n.startswith(('wrist','finger','metacarpal')): return 'hand.'+side
    if n.startswith('upperleg'): return 'thigh.'+side
    if n.startswith('lowerleg'): return 'shin.'+side
    if n.startswith(('foot','toe')): return 'foot.'+side
    if n.startswith(('root','pelvis','spine05')): return 'pelvis'
    if n.startswith(('spine03','spine04')): return 'abdomen'
    if n.startswith(('spine','clavicle','shoulder','breast')): return 'chest'
    if n.startswith('neck'): return 'neck'
    return 'head'

weights = np.zeros((len(base),len(names)))
for name, entries in json.loads((SOURCE/'weights.json').read_text())['weights'].items():
    for i, w in entries: weights[i,bone_index[mapped(name)]] += w
weights[weights.sum(axis=1)==0,0] = 1
weights /= weights.sum(axis=1)[:,None]

bones = []
for n in names:
    a,b = origin, origin+np.array([0,1,0])
    if n == 'neck': a,b = joint('neck01'),joint('head')
    elif n == 'head': a,b = joint('head'),joint('head','tail')
    elif '.' in n:
        part, side = n.split('.')
        source = n if n.startswith('finger') else {'upper':'upperarm01','fore':'lowerarm01','hand':'wrist','thigh':'upperleg01','shin':'lowerleg01','foot':'foot'}[part]+'.'+side
        a = joint(source)
        end = {'upper':'upperarm02','fore':'lowerarm02','thigh':'upperleg02','shin':'lowerleg02'}.get(part)
        b = joint(end+'.'+side,'tail') if end else joint(source,'tail')
    bones.append({'name':n,'start':norm(a).round(7).tolist(),'end':norm(b).round(7).tolist()})

def fit(folder, name):
    folder = SOURCE/'system'/folder
    v,uv,faces,_ = obj(folder/(name+'.obj'))
    lines=(folder/(name+'.mhclo')).read_text().splitlines()
    scales=np.ones(3); refs=[]; in_verts=False
    for line in lines:
        s=line.split()
        if not s or s[0].startswith('#'): continue
        if s[0] in ['x_scale','y_scale','z_scale']:
            axis=['x_scale','y_scale','z_scale'].index(s[0]); i,j=int(s[1]),int(s[2])
            scales[axis]=abs(human[i,axis]-human[j,axis])/float(s[3])
        elif s[0]=='verts': in_verts=True
        elif in_verts and s[0].lstrip('-').isdigit():
            if len(s)==1:
                i=int(s[0]); refs.append((human[i],weights[i]))
            elif len(s)>=9:
                ids=np.array([int(x) for x in s[:3]]); blend=np.array([float(x) for x in s[3:6]])
                offset=np.array([float(x) for x in s[6:9]])*scales
                refs.append(((human[ids]*blend[:,None]).sum(axis=0)+offset,(weights[ids]*blend[:,None]).sum(axis=0)))
            else: break
        elif in_verts and refs: break
    assert len(refs)==len(v),(name,len(refs),len(v))
    return norm(np.array([r[0] for r in refs])),uv,faces,np.array([r[1] for r in refs])

blob=bytearray(); manifest={'bones':bones,'meshes':{}}
def array(data,dtype):
    while len(blob)%4: blob.append(0)
    a=np.asarray(data,dtype=dtype); offset=len(blob); blob.extend(a.tobytes())
    return {'offset':offset,'length':a.size,'type':dtype}

def mesh(name,v,uv,faces,w):
    # Normals are accumulated before UV seam duplication.
    normals=np.zeros_like(v)
    for f in faces:
        ids=[x[0] for x in f]
        for k in range(1,len(ids)-1):
            i,j,l=ids[0],ids[k],ids[k+1]; n=np.cross(v[j]-v[i],v[l]-v[i])
            for q in [i,j,l]: normals[q]+=n
    normals/=np.maximum(np.linalg.norm(normals,axis=1)[:,None],1e-12)
    positions=[];normal=[];tex=[];skin=[];influence=[];indices=[];lookup={}
    for f in faces:
        corner=[]
        for i,t in f:
            key=(i,round(float(uv[t,0]),6),round(float(uv[t,1]),6))
            if key not in lookup:
                lookup[key]=len(positions);positions.append(v[i]);normal.append(normals[i]);tex.append(uv[t])
                ids=np.argsort(w[i])[-4:][::-1]; ws=w[i,ids].clip(0);ws/=max(ws.sum(),1e-12)
                skin.append(ids);influence.append(ws)
            corner.append(lookup[key])
        for k in range(1,len(corner)-1): indices += [corner[0],corner[k],corner[k+1]]
    manifest['meshes'][name]={k:array(a,t) for k,a,t in [
        ('position',positions,'float32'),('normal',normal,'float32'),('uv',tex,'float32'),
        ('skinIndex',skin,'uint16'),('skinWeight',influence,'float32'),('index',indices,'uint32')]}
    print(name,len(positions),'vertices',len(indices)//3,'triangles')

body=norm(human)
body_faces=[f for f,g in zip(base_faces,groups) if g=='body']
skin_faces=[];sock_faces=[];glove_faces=[]
for f in body_faces:
    ids=[c[0] for c in f]; p=body[ids].mean(axis=0); w=weights[ids].mean(axis=0)
    hand=sum(w[bone_index[n]] for n in names if n.startswith(('hand.','finger')))
    thigh=sum(w[bone_index[n]] for n in ['thigh.L','thigh.R'])
    shin=sum(w[bone_index[n]] for n in ['shin.L','shin.R'])
    foot=sum(w[bone_index[n]] for n in ['foot.L','foot.R'])
    arm=sum(w[bone_index[n]] for n in names if n.startswith(('upper.','fore.','hand.','finger')))
    # Fully covered regions are omitted, but the skin extends under each hem.
    if foot>.55: continue
    if hand>.55: glove_faces.append(f)
    if shin>.45 and p[1]<-.55: sock_faces.append(f); continue
    if thigh>.1 and p[1]>-.18: continue
    if arm<.25 and -.2<p[1]<.57: continue
    skin_faces.append(f)
mesh('skin',body,base_uv,skin_faces,weights)
mesh('gloves',body,base_uv,glove_faces,weights)

# Connected components distinguish the trousers from the fitted jersey.
def components(v,faces):
    adj=[set() for _ in v]
    for f in faces:
        ids=[c[0] for c in f]
        for i in ids: adj[i].update(ids)
    seen=set(); result=[]
    for i in range(len(v)):
        if i in seen: continue
        todo=[i];ids=set()
        while todo:
            j=todo.pop()
            if j in ids:continue
            ids.add(j);todo.extend(adj[j]-ids)
        seen.update(ids);result.append(ids)
    return result

def subdivide(v,uv,faces,w):
    """One Catmull-Clark step, preserving open hems and UV seams."""
    attrs=np.concatenate([v,w],axis=1); nv=attrs.copy().tolist()
    face_data=[attrs[[c[0] for c in f]].mean(axis=0) for f in faces]
    edges={};neighbors=[set() for _ in v];adj=[[] for _ in v]
    for j,f in enumerate(faces):
        ids=[c[0] for c in f]
        for a,b in zip(ids,ids[1:]+ids[:1]):
            edges.setdefault(tuple(sorted((a,b))),[]).append(j);neighbors[a].add(b);neighbors[b].add(a)
        for a in ids:adj[a].append(j)
    edge_id={};boundary=[[] for _ in v]
    for (a,b),fs in edges.items():
        if len(fs)==1:
            p=(attrs[a]+attrs[b])/2;boundary[a].append(b);boundary[b].append(a)
        else:p=(attrs[a]+attrs[b]+sum(face_data[f] for f in fs))/ (2+len(fs))
        edge_id[a,b]=len(nv);nv.append(p.tolist())
    for i,ns in enumerate(neighbors):
        if boundary[i]:nv[i]=(attrs[i]*.75+attrs[boundary[i]].mean(axis=0)*.25).tolist()
        elif ns:
            n=len(ns);F=np.mean([face_data[f] for f in adj[i]],axis=0);R=np.mean([(attrs[i]+attrs[j])/2 for j in ns],axis=0)
            nv[i]=((F+2*R+(n-3)*attrs[i])/n).tolist()
    nf=[];nt=[]
    for j,f in enumerate(faces):
        centre=len(nv);nv.append(face_data[j].tolist());fu=np.mean([uv[c[1]] for c in f],axis=0)
        for k,(a,t) in enumerate(f):
            b,u=f[(k+1)%len(f)];c,h=f[(k-1)%len(f)];ti=len(nt)
            nt.extend([uv[t],(uv[t]+uv[u])/2,fu,(uv[h]+uv[t])/2])
            nf.append([(a,ti),(edge_id[tuple(sorted((a,b)))],ti+1),(centre,ti+2),(edge_id[tuple(sorted((c,a)))],ti+3)])
    nv=np.array(nv);return nv[:,:3],np.array(nt),nf,nv[:,3:]

def clip(v,uv,faces,w,height,above):
    vv=v.tolist();tt=uv.tolist();ww=w.tolist();result=[];cuts={}
    for f in faces:
        polygon=[]
        for (i,t),(j,u) in zip(f,f[1:]+f[:1]):
            a,b=v[i],v[j];keep=(a[1]>=height)==above;nxt=(b[1]>=height)==above
            if keep:polygon.append((i,t))
            if keep!=nxt:
                s=(height-a[1])/(b[1]-a[1]);edge=tuple(sorted((i,j)))
                if edge not in cuts:
                    cuts[edge]=len(vv);vv.append((a+(b-a)*s).tolist());ww.append((w[i]+(w[j]-w[i])*s).tolist())
                tt.append((uv[t]+(uv[u]-uv[t])*s).tolist());polygon.append((cuts[edge],len(tt)-1))
        if len(polygon)>=3:result.append(polygon)
    return np.array(vv),np.array(tt),result,np.array(ww)

sv,su,sf,sw=clip(body,base_uv,[f for f in body_faces if weights[[c[0] for c in f]][:, [bone_index['shin.L'],bone_index['shin.R']]].sum(axis=1).mean()>.3],weights,-.55,False)
for i,p in enumerate(sv):
    side='L' if p[0]>0 else 'R'
    sw[i,:]=0;sw[i,bone_index['shin.'+side]]=1
sv,su,sf,sw=subdivide(sv,su,sf,sw)
mesh('socks',sv,su,sf,sw)

for suffix, garment in [('short','male_casualsuit04'),('long','male_casualsuit02')]:
    v,uv,faces,w=fit('clothes/'+garment,garment)
    comps=components(v,faces)
    top=max(comps,key=lambda c:max(v[i,1] for i in c))
    shirt=[f for f in faces if f[0][0] in top]
    sv,su,sf,sw=subdivide(v,uv,shirt,w)
    sv,su,sf,sw=subdivide(sv,su,sf,sw)
    # Subtle compression folds at the waist and sleeves, in actual geometry.
    for i,p in enumerate(sv):
        arm=sw[i,bone_index['upper.L']]+sw[i,bone_index['upper.R']]+sw[i,bone_index['fore.L']]+sw[i,bone_index['fore.R']]
        waist=np.exp(-((p[1]-.12)/.12)**2)*(1-min(1,arm))
        side=np.clip((abs(p[0])-.06)/.07,0,1)
        fold=.0025*waist*side*np.sin(p[1]*92+p[0]*37+np.sin(p[0]*43)*2)+.0006*arm*np.sin(p[1]*155+p[0]*43)
        sv[i,2]+=fold * (1 if p[2]>0 else -1)
    mesh('shirt-'+suffix,sv,su,sf,sw)
    if suffix=='short':
        # Crop the trousers to an actual open thigh hem, interpolating skin weights.
        sv,su,sf,sw=clip(v,uv,[f for f in faces if f[0][0] not in top],w,-.31,True)
        sv,su,sf,sw=subdivide(sv,su,sf,sw)
        sv,su,sf,sw=subdivide(sv,su,sf,sw)
        for i,p in enumerate(sv):
            hem=np.clip((-.23-p[1])/.05,0,1)
            side='L' if p[0]>0 else 'R'
            sw[i]*=1-hem;sw[i,bone_index['thigh.'+side]]+=hem
        mesh('shorts',sv,su,sf,sw)

for label,folder,name in [('hair-short','hair/short04','short04'),('hair-crop','hair/short02','short02'),('eyes','eyes/high-poly','high-poly'),('brows','eyebrows/eyebrow001','eyebrow001')]:
    v,uv,f,w=fit(folder,name);w[:]=0;w[:,bone_index['head']]=1;mesh(label,v,uv,f,w)

OUT.mkdir(exist_ok=True)
(OUT/'player.bin').write_bytes(blob)
(OUT/'player.json').write_text(json.dumps(manifest,separators=(',',':')))
for source,target,size,mode in [
    ('skins/young_caucasian_male/young_lightskinned_male_diffuse.png','skin.jpg',2048,'RGB'),
    ('hair/short04/short04_diffuse.png','hair-short.png',1024,'RGBA'),
    ('hair/short02/short02_diffuse.png','hair-crop.png',1024,'RGBA'),
    ('eyes/materials/brown_eye.png','eyes.png',512,'RGBA'),
    ('eyebrows/eyebrow001/eyebrow001.png','brows.png',512,'RGBA')]:
    im=Image.open(SOURCE/'system'/source).convert(mode);im.thumbnail((size,size),Image.Resampling.LANCZOS)
    im.save(OUT/target,quality=92,optimize=True)
    if target=='skin.jpg':
        # Small-scale skin relief; the facial form remains in the mesh.
        im.convert('L').filter(ImageFilter.GaussianBlur(.7)).save(OUT/'skin-relief.jpg',quality=88,optimize=True)
print('Runtime geometry',len(blob),'bytes')
