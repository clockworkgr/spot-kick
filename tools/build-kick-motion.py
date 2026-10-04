"""Bake CMU subject 10, trial 01 into a small display-only soccer kick clip.

ASF/AMC are parsed as data. This original builder uses no third-party program code.
The source is 120 Hz; the game samples a filtered 60 Hz clip at absolute time.
"""
import numpy as np,json
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
SOURCE=ROOT/'assets/motion/source'

def rot(angles):
 x,y,z=np.radians(angles);sx,cx=np.sin(x),np.cos(x);sy,cy=np.sin(y),np.cos(y);sz,cz=np.sin(z),np.cos(z)
 return np.array([[cz,-sz,0],[sz,cz,0],[0,0,1]])@np.array([[cy,0,sy],[0,1,0],[-sy,0,cy]])@np.array([[1,0,0],[0,cx,-sx],[0,sx,cx]])
lines=(SOURCE/'10.asf').read_text().splitlines();bones={};hier={};section='';b=None
for line in lines:
 s=line.split()
 if not s:continue
 if s[0].startswith(':'):section=s[0];continue
 if section==':bonedata':
  if s[0]=='begin':b={}
  elif s[0]=='end':bones[b['name']]=b;b=None
  elif s[0] in ['name','dof']:b[s[0]]=s[1] if s[0]=='name' else s[1:]
  elif s[0] in ['direction','axis','length']:b[s[0]]=np.array(list(map(float,s[1:4]))) if s[0]!='length' else float(s[1])
 elif section==':hierarchy' and s[0] not in ['begin','end']:
  for n in s[1:]:hier[n]=s[0]
for b in bones.values():b['C']=rot(b['axis'])
frames=[];d=None
for line in (SOURCE/'10_01.amc').read_text().splitlines():
 s=line.split()
 if not s or s[0].startswith(('#',':')):continue
 if s[0].isdigit():
  if d:frames.append(d)
  d={}
 else:d[s[0]]=list(map(float,s[1:]))
frames.append(d)
points=[];rotation=[]
for f in frames:
 r=np.array(f['root']);coords={'root':r[:3]};rs={'root':rot(r[3:])}
 for n,b in bones.items():
  values=np.zeros(3)
  for axis,a in zip(b.get('dof',[]),f.get(n,[])):values['rx ry rz'.split().index(axis)]=a
  R=b['C']@rot(values)@b['C'].T;parent=hier[n];rs[n]=rs[parent]@R
  coords[n]=coords[parent]+rs[n]@b['direction']*b['length']
 points.append(coords);rotation.append(rs)
point={n:np.array([p[n] for p in points]) for n in points[0]}
def filtered(a):
 pad=np.pad(a,((2,2),(0,0)),mode='edge')
 return sum(pad[j:j+len(a)]*s for j,s in enumerate([1,2,3,2,1]))/9
point={n:filtered(p) for n,p in point.items()}
# The fast, low forward sweep of the striking ankle identifies contact.
contact=596
forward=point['rtibia'][contact+2]-point['rtibia'][contact-2];forward[1]=0;forward/=np.linalg.norm(forward)
left=np.cross([0,1,0],forward);basis=np.array([left,[0,1,0],forward])
template=json.loads((ROOT/'assets/players/player.json').read_text())['bones']
native=sum(np.linalg.norm(np.array(b['end'])-b['start']) for b in template if b['name'] in ['thigh.L','shin.L'])
actor=(bones['lfemur']['length']+bones['ltibia']['length']+bones['rfemur']['length']+bones['rtibia']['length'])/2
scale=native/actor
anchor=point['ltibia'][578:616].mean(axis=0);anchor[1]-=.088/scale
def position(a):return (a-anchor)@basis.T*scale
def direction(a):
 a=a@basis.T;return a/np.maximum(np.linalg.norm(a,axis=1)[:,None],1e-12)
channels={'pelvis':position((point['lhipjoint']+point['rhipjoint'])/2)+[0,.006,0]}
for name,bone,axis in [('up','root',1),('fwd','root',2),('chestUp','thorax',1),('chestFwd','thorax',2),('headFwd','head',2)]:
 channels[name]=direction(filtered(np.array([r[bone][:,axis] for r in rotation])))
for side in ['l','r']:
 suffix=side.upper()
 channels['upper'+suffix]=direction(point[side+'humerus']-point[side+'clavicle'])
 channels['fore'+suffix]=direction(point[side+'radius']-point[side+'humerus'])
 channels['thigh'+suffix]=direction(point[side+'femur']-point[side+'hipjoint'])
 channels['shin'+suffix]=direction(point[side+'tibia']-point[side+'femur'])
 channels['ankle'+suffix]=position(point[side+'tibia'])
 # The anatomical foot points down ~15 degrees in ASF's rest pose.
 toe=direction(point[side+'foot']-point[side+'tibia'])
 theta=np.arctan2(-bones[side+'foot']['direction'][1],np.linalg.norm(bones[side+'foot']['direction'][[0,2]]))
 horizontal=np.linalg.norm(toe[:,[0,2]],axis=1);pitch=np.arctan2(toe[:,1],horizontal)+theta
 toe[:,[0,2]]*=np.cos(pitch)[:,None]/np.maximum(horizontal[:,None],1e-12);toe[:,1]=np.sin(pitch)
 channels['toe'+suffix]=toe
start=contact-102;stop=contact+102
samples=range(start,stop+1,2)
rest={b['name']:b for b in template}
model={'hip':rest['thigh.L']['start'],'shoulder':rest['upper.L']['start'],
 'thigh':np.linalg.norm(np.array(rest['thigh.L']['end'])-rest['thigh.L']['start']),
 'shin':np.linalg.norm(np.array(rest['shin.L']['end'])-rest['shin.L']['start']),
 'upperArm':np.linalg.norm(np.array(rest['upper.L']['end'])-rest['upper.L']['start']),
 'foreArm':np.linalg.norm(np.array(rest['fore.L']['end'])-rest['fore.L']['start']),
 'head':rest['head']['start']}
data={'fps':60,'start':-.85,'end':(list(samples)[-1]-contact)/120,'sourceContactFrame':contact+1,'model':model,
 'channels':{n:a[list(samples)].round(6).reshape(-1).tolist() for n,a in channels.items()}}
out=ROOT/'src/kick-motion-data.js'
out.write_text('// Derived from CMU mocap 10_01; see assets/motion/CREDITS.md.\nexport const kickMotion = '+json.dumps(data,separators=(',',':'))+';\n')
print(len(list(samples)),'captured poses;',out.stat().st_size,'bytes; contact =',contact+1)
print('Contact ankle',channels['ankleR'][contact],'support',channels['ankleL'][contact])
