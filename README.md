# Spot Kick

A 3-D penalty shootout against the computer. You take a kick, then go in goal
for the computer's kick, round after round: five kicks each at most, no sudden
death, and you win only by two goals or more; it ends as soon as that is
certain either way (`src/shootout.js`, the same rules as the realm's impl/v3).
Whichever side is not yours is decided **before** you choose: its move is
sealed (hashed) and revealed after. The computer plays the chain's
equilibrium mixes (`src/chainplay.js`, see the realm's README, Economics).

## Playing on gno.land

The page opens on a **lobby** for the Spot Kick realm (`../gno-shots-realm`); **Practice offline**
(or `?practice`) is the self-contained game described below.

It is published at <https://clockworkgr.github.io/spot-kick/> (GitHub Pages, straight from
`main`) and plays the realm deployed on the Onyx testnet (`onyx-1`) at
`gno.land/r/g1lnkytfqcjwllws63gvf0mv9yt04aswy4y9amhm/shots`; test GNOT come from the
[faucet](https://faucet.gno.land). To develop against a local chain:

```
tools/devchain.sh g1youradenaaddress    # gnodev + the realm, impl/v3 accepted, your address funded
python3 -m http.server 8000             # then open http://localhost:8000/?rpc=http://127.0.0.1:26657&chainId=dev&realm=gno.land/r/clockwork/shots&web=http://127.0.0.1:8888&name=Local%20gnodev
```

`tools/deploy.sh <gnokey-key>` deploys the packages and realm to a public network (Onyx by
default) under that key's address namespace, with that address as the realm's Admin, and
accepts the latest implementation (impl/v3). Named namespaces such as `clockwork` cannot be registered on Onyx yet, so
the script rewrites `gno.land/{p,r}/clockwork` on the way. Its gnokey must match the
network's gno release (`tools/bin/gnokey-onyx`, built from the `chain/onyx` tag).

- **Wallet:** [Adena](https://adena.app). Connecting adds and switches to the configured network
  (default: Onyx, `https://rpc.onyx.testnets.gno.land`, chain id `onyx-1`). Change it with ⚙ or
  with `?rpc=…&chainId=…&realm=…&web=…`.
- **Lobby:** every game the realm holds, with tabs for open, in play, finished and yours. You can
  create a game (pot, entry fee, idle timeout, and four small settings: goal width, keeper size,
  keeper agility, shot speed), play an open one (pays its fee),
  continue your shootout, top up a pot, cancel your unplayed game for a refund, resign, or end a
  challenger's shootout once they have been idle past the timeout. *Details* shows the settings and
  every challenger's kicks, with links to gnoweb.
- **A kick on chain:** you aim and strike, or plan your keeper, exactly as offline. Your move is
  sent as the realm's integers (mm, milli-radii, per-mille, four uint16), and the realm settles it in
  that block: the chain's move and the mishit come from SHA-256 of the block time (see the realm's
  README for why that is not yet safe for real stakes). Adena only broadcasts, so the page then reads
  the transaction from the node's `/tx` endpoint for the kick the realm returned, and replays those
  ten inputs and that seed in the 3-D engine.
- **Who decides:** the realm runs this engine, ported to gno (`penalty/physics/v0`) with
  bit-identical results, so the replay is exactly the chain's kick; the report shows the chain's
  verdict and confirms the replay matches it. Games with non-default constants are badged: the
  realm plays them with their constants, the replay with the defaults.
- **Cost:** 30–70M gas for a typical kick on chain, ~0.36B at worst. The chain charges the
  fee for the gas limit, so each kick pays for 0.7B (0.7 GNOT at 1 ugnot per 1000 gas, the
  price on both gnodev and Onyx) plus ~0.3 GNOT of storage deposit, which comes back on the
  move that ends the shootout: the realm then keeps only its score (see the realm's README,
  Storage), and the lobby shows such a shootout as *settled*.
- `src/chain.js` (RPC reads, Adena, transactions) and `src/lobby.js` (lobby UI) are the whole
  integration.

## Round bytes

Every kick's randomness is 32 bytes, sealed before you choose and revealed after.
The last 24 are the mishit seed of whoever kicks. Since impl/v3 the computer's
move is picked by bytes 0–1 from its mixes (`src/chainplay.js`: a keeper plan,
or a kick in the realm's units), as the chain picks its own; the tables below
describe how a keeper plan's four uint16 decode, and how impl/v1 and v2 read
the first eight bytes as the move itself (`penalty.Seed`).

**You shoot** — the computer keeps (`decodeRound(bytes)` → `{ plan, strikeSeed }`):

| Bytes | Meaning | Mapping of v = uint16 / 65535 |
| --- | --- | --- |
| 0–1 | keeper direction | 0 → 0° (along the line to your right) … 1 → 180° (your left); the middle 6% sweeps the headings that come off the line, the rest is ≤ 22° off the line |
| 2–3 | keeper speed / mode | lowest 6% → star jump (0–1.15 m/s); next 24% → **wait and read**; rest → committed dive at 2.6–5.2 m/s |
| 4–5 | keeper jump | −1.4 … 4.0 m/s (negative = collapse low) |
| 6–7 | keeper reaction | 0.02 … 0.12 s |
| 8–31 | mishit seed | two sums of six uint16s give the contact error in x and y |

**You keep** — the computer shoots (`decodeTakerShot(bytes)` → `{ input, ints }`, integer
mm / per-mille / milli-radii exactly as `penalty.Seed.ChainShot`):

| Bytes | Meaning | Mapping |
| --- | --- | --- |
| 0–1 | aim x | uint16 → ±(half goal width − 25 cm) |
| 2–3 | aim y | uint16 → 0.3 m … bar + 0.2 m |
| 4–5 | power | uint16 → 45 … 100% |
| 6, 7 | contact x, y | int8 → ±0.35 R (kept inside the contact disc) |
| 8–31 | mishit seed | as above |

**Misreads.** Every keeper misjudges a little, and more the earlier it acts. `keeperMisread(seed)`
draws four standard normals from a salted hash of bytes 8–31, so the sealed bytes fix it but it is
independent of the mishit. They scale with how early the keeper moves (`KEEPER.MISREAD_*`,
`MISJUDGE_*`, `misreadSigmas(plan)`):

| | earliest | latest |
| --- | --- | --- |
| Read: predicted crossing point, sideways / height (by time since contact, 0.18 → 0.28 s) | ±1.2 m / ±0.5 m | ±5 cm / ±4 cm |
| Committed dive: sideways speed / jump (by reaction, 20 → 120 ms) | ±0.6 / ±0.6 m/s | ±0.12 / ±0.12 m/s |

The read's error keeps shrinking as it watches, so the hands still close in on the ball. Against the
computer's kicks this makes reaction a real choice: with a dive aimed at the right spot, saves rise
from 76% at 20 ms to 83% at 95 ms; waiting to read peaks around 70 ms (54% → 56% → 50% at 120 ms).
`simulateShot(input, plan, { misread: false })` gives a perfect read for analysis.

Your keeper plan is four uint16s too: the UI's choice goes through `encodePlan` and back
through `decodePlan`, so it is exactly a plan the realm's `SubmitKeeperPlan` could send.

The game draws the bytes with `crypto.getRandomValues`, or from
`roundBytesFromSeed(seed, kick)` when the URL has `?seed=N`.

```
python3 -m http.server 8000      # any static server; ES modules need http://
open http://localhost:8000       # ?seed=123 makes the computer's moves reproducible
node --test test/*.test.mjs      # physics and shootout tests (no browser needed)
node tools/fuzz.mjs --shots 1000000   # Monte Carlo outcome report (all CPU cores)
```

## Controls

Shooting:

| Input | Action |
| --- | --- |
| Mouse / arrow keys | Aim the swing (reticle on the goal plane) |
| Click the ball widget / WASD | Contact point on the ball |
| Hold Space or mouse, release | Charge power (it sweeps up and down), shoot on release |

Keeping — the camera faces the goal while you plan, then watches from behind your keeper:

| Input | Action |
| --- | --- |
| Mouse over the goal, click | Choose and pin the spot to cover (L unpins; arrows nudge it) |
| 1 · 2 | **Pick a spot** (commit to a dive at contact + reaction) · **Wait & read** (react to the ball, beaten by pace and curl) |
| Q / E or the slider | Reaction time, 20–120 ms |
| Space · Enter · Ready | Lock the plan in and face the kick |

Picking a spot does not set the plan's numbers directly: `src/keeperplan.js` searches a table of
dives (speed × jump, plus slow star jumps, built from `previewKeeper` — the real keeper physics
with no ball) for the plan whose body covers the spot longest while the ball usually arrives
(0.3–0.75 s after contact), mirrored for the left. The translucent ghost and dashed glove paths
show that dive; once the ball is in play the hands still track it, as for the computer's keeper.

| Input | Action |
| --- | --- |
| R · Enter | Replay · next kick |
| H · P | Show hitboxes · practice path preview (empty goal, when shooting) |

## How it works

`src/physics.js` is a self-contained, dependency-free simulator. On release the whole
shot is integrated at 1 kHz until a verdict is reached (and a little beyond, for the
replay); `src/main.js` (three.js) only plays back the recorded frames. The same engine runs
on chain as `gno-shots-realm/…/penalty/physics/v0`, bit for bit — see *On-chain port* below.

- **Kick**: the foot swings toward the aim point. You choose a contact offset within
  0.5 ball radii; the boot then lands slightly off it (a seeded, deterministic mishit
  whose spread grows with power). The contact normal `n` nudges the launch direction,
  efficiency falls off for glancing hits, and spin is the angular impulse `r × J / I`,
  with sidespin transferring much better than back/top spin, so curling is easy.
- **Flight**: gravity, quadratic drag (`Cd = 0.25`), Magnus force `∝ ω × v`, spin decay.
  Hitting below centre gives backspin (lift); hitting the right side curls the ball left.
- **Ground**: restitution bounces, then rolling with resistance and rolling spin.
- **Steps**: 1 ms (semi-implicit Euler) whenever the ball is near anything it can touch — the
  keeper, the posts and bar, the ground, the net; in free flight, 5 ms Heun (second-order
  Runge-Kutta) steps, which are more accurate than the 1 ms Euler ones (within 0.1 mm at the goal
  against ~4 mm). Drag uses the ball's speed from one Newton step off the previous step's (a
  square root only after an impact).
- **Goal frame**: posts and bar are capsules; the net panels are one-way damped springs.
  A goal needs the whole ball over the whole line, inside the frame.
- **Goal**: 6.555 × 2.424 m (regulation is 7.32 × 2.44 m), to make scoring harder.
- **Keeper**: kinematic body of capsules/spheres (legs, torso, arms, gloves, head),
  scaled to about 2.17 m. After its reaction delay it pushes off over 0.12 s toward the
  planned velocity (a negative jump means collapsing low), leans into the dive, and
  reaches with its arms; arms flatten along the grass rather than propping the body up.
  Its reaction delay (0.02–0.12 s) is part of the plan.
- **Reading the shot** (deterministic): the keeper only uses the simulated ball state.
  It predicts where the ball will cross its plane (straight line + gravity + drag and
  rolling resistance, but no spin, so curl can fool it) with only `+ − × ÷ √`, re-reading
  the ball every 20 ms (50 Hz) and acting on its latest read in between. The keeper moves
  at 50 Hz too (1 ms in the step where its plan commits, so reaction keeps 1 ms precision);
  the ball, still at 1 kHz, meets body shapes interpolated between the keeper's 20 ms poses,
  and the replay draws the interpolated pose. Lean and arms are re-normalised with three
  Newton steps instead of a square root.
  - From 0.16 s after contact its hands steer towards that point.
  - A *read* plan commits at 0.16 s + reaction: a dive sized to reach the predicted
    point, or, if the ball is still more than 0.45 s away, a shuffle across first.
  - After landing it stays down while the ball is imminent, then gets up (scrambling
    faster the more upright it is), shuffles towards the predicted point and may dive
    once more when the ball is due within 0.38 s.
  - The trailing foot stays planted during push-off.
- **Catch or parry**: each keeper touch is decided once, at its first contact
  (`result.contacts` logs every touch with its speed, positioning and decision).
  - A glove or chest contact holds the ball if its speed relative to that part is within a
    limit set by positioning: 9 m/s at full stretch to 25 m/s with both hands on the ball
    and the body behind it. A lone glove holds at most 13 m/s.
  - Legs and arms gather a ball under 7.5 m/s (trickled into the feet); faster, they block
    and it rebounds. The head always parries.
  - A slow ball gives the keeper time to react: below 12 m/s every part reaches up to 12 cm
    further. A reading keeper goes down sideways to a low ball beside it.
  - A caught ball rides in the keeper's hands (`frame.held`), the verdict is immediate
    (`result.keeperContact` = `'caught'`, details in `result.caught`); a parried ball can
    still be gathered at a later touch.
  - Collision shapes are a little larger than the body (`KEEPER.HIT_MARGIN`, shown by the
    Hitboxes toggle): gloves +3 cm, arms/body/legs +2 cm, head +1 cm.
  - Limbs are not rigid (`KEEPER.GIVE`): each can change the ball's speed along the contact
    normal by a limited amount. Two hands together and a braced chest stop a full-power
    shot; a lone glove, an arm or a leg trailing in the air gives way to a hard one, which
    carries on slowed and deflected. A touch made only through the extra reach is a
    fingertip and has 75% of that strength; a glove touch with the ball within 25 cm of the
    body is a braced reflex block with the chest's strength.
  - A glove touch under 16 m/s that cannot be held is pushed away and wide, not back in.
  - The hands keep adjusting while the keeper watches the ball: up to 7 cm of extra reach.
- `node tools/save-analysis.mjs` breaks outcomes and keeper touches down by shot type and
  keeper plan, and lists suspicious cases with reproducible shot indexes.
- `node tools/reach-analysis.mjs --out rows.jsonl` records how close each limb's body surface
  came to the ball before it crossed the line; `node tools/reach-verdict.mjs rows.jsonl`
  judges every shot against an independent realistic-keeper model (reach a real keeper adds
  with time, chance a touch keeps the ball out) and compares it with the simulation.
  Ball–keeper contacts use the part's actual velocity, with softer gloves than body.
- **Verdicts**: a goal when the whole ball is over the line inside the frame; otherwise a
  save, woodwork or miss when it crosses outside, stops, is moving away from goal 0.8 m out
  after a touch, or is outside a post moving away from it, and at the latest after 2.5 s.
  After a keeper touch or the woodwork, a loose ball (under 3 m/s, within 1.8 m of the
  keeper's hips, below 2.2 m) is a save if the keeper can pounce on it before it is wholly
  over the line: 0.2 s to go down on it plus the distance beyond 0.9 m at 3 m/s (`POUNCE_*`).
  This decides about 1% of kicks and turns 0.03% of them from goals into saves.
  (Each of these early verdicts was checked on 200,000+ fuzzed kicks: at most 9 in 200,000
  would otherwise still have gone in.)
- **Work skipped where it cannot matter** (`ZONES`): keeper contacts only within 2.2 m of the
  keeper's hip (no part reaches beyond 1.97 m) and each part only near the box it sweeps in a
  20 ms block; posts and bar only near the line. Results are identical with or without them;
  the on-chain port relies on them for gas.
- **Determinism**: inside the loop only `+ − × ÷`, `sqrt`, `min/max/abs/round` and
  `imul` are used. These are exactly rounded in IEEE-754, and the dive angle goes through
  a polynomial `detSin`, so results are bit-identical across JS engines. The plan is
  committed with a hash before the shot, together with that round's mishit seed, and each shot is re-simulated to check its state hash.

## On-chain port

`gno-shots-realm/gno.land/p/clockwork/penalty/physics/v0` is this engine in gno, operation
for operation, and must stay bit-identical to it. After changing either engine:

```
node tools/golden.mjs --cases 300 --seed 8 --gno > ../gno-shots-realm/gno.land/p/clockwork/penalty/physics/v0/golden_cases_test.gno
(cd ../gno-shots-realm && gno test ./gno.land/p/clockwork/penalty/physics/v0/)   # 300 kicks in the gno VM
tools/port-check.sh 20000                                                         # 20,000 more natively (needs Go)
```

`tools/golden.mjs` records, for varied kicks, every float as its 64 bits: launch, the keeper's
misread draws, every keeper move and touch, where the ball reaches the line, the deciding step
and a hash of the whole ball and keeper state every 25 steps (via `simulateShot`'s `trace`
option). Changes that alter results must be made in both engines; changes that only skip work
(like `ZONES`) can be checked by comparing a large run with and without them.

## Display (cosmetic only)

Nothing below feeds back into the simulation. The hitbox toggle shows the true
physics shapes until possession or simulation end. The visual keeper can recover
independently once its recorded contacts are clear; after a confirmed catch the
displayed ball and keeper follow a coordinated hold and recovery. The recorded
frames, catch decisions, results and hashes remain unchanged.

- `src/rig.js` poses continuous, GPU-skinned athletic human meshes with anatomical
  faces and hands, UV-mapped skin, strand hair, textured eyes, fitted cloth jerseys
  and shorts, latex gloves, and boots with laces and studs. Forty-seven blended bones
  deform the body and articulate thirty finger joints. Hands relax while running,
  spread for saves, flatten for support and close into fists for celebrations.
  Kit crests and numbers are printed on the
  cloth and deform with it. World-space targets and two-bone IK keep the keeper's
  gloves on the physics glove spheres around each contact. During a hold, wrist IK
  locks the actual glove palm to the ball, fingers and thumbs curl around its
  surface, and elbow clearance steers the forearms away from it. Transported elbow
  poles retain the native bend direction; both arm segments use the same bend
  plane with bounded skin roll near extension. Transported knee poles prevent
  the legs changing bend direction while drawing the feet beneath the hips.
  Anatomical knee hinges,
  bounded wrist pronation, scapula reach and
  curved hand transitions reduce arm snapping. Ankle orientation and sole clearance let
  the boots roll over the turf. Breathing is cosmetic.
  `src/player-assets.js` loads only local assets; see `assets/players/CREDITS.md`
  for the CC0 sources and the offline build command.
- `src/animation.js` turns time, the recorded keeper pose, the launch and the
  outcome into body poses: keeper idle sway, split-step and loaded crouch, dive
  styling (driving lead leg, tucked trailing knee, palms and gaze on the ball),
  then getting up and celebrating or despairing. Shuffle feet alternate between
  fixed world-space footholds and a swing. The ready stance uses compact hands,
  lower elbows, forward-bending forearms and neutral wrists with slightly raised
  fingertips. A distant reach retains a slight elbow bend;
  recorded glove targets take over in contact range. Absolute recovery intervals
  bring the arms back to the guard during the keeper's rise, within about 0.34 s,
  rather than waiting for simulation end. Arm transitions remain continuous
  between dives. Dive styling distinguishes loaded push-off,
  gathered legs in flight and a cushioned landing. After the last contact, a clear
  interval permits a full visual recovery: decelerate onto the outer thigh and
  shoulder, settle on the side, roll onto the front, brace the palms, draw the
  knees under the hips and push through a planted foot before stepping upright.
  A captured get-up supplies independent hip, chest and limb movement; body
  rotations remain orthonormal during the roll. Short intervals before another
  dive use a low palm brace, gather the knees underneath, step the outside drive
  foot into a loaded crouch, then roll over its planted toe into the second dive.
  Hip, chest and arm transitions share that sequence; the keeper rejoins the
  recorded pose before contact. The second landing can settle into the full
  get-up after a late parry, without first rotating upright.
  The visual root can stay on the turf while the engine's colliders recover.
  Contact reactions read `result.contacts`, including `gaveWay`, the struck
  limb and incoming/outgoing recorded travel. A firm parry has a short recoil
  and follow-through; a giving glove/arm folds back more, and an airborne
  giving leg recoils while a planted leg retains its support. The reaction
  begins after impact, fades into the landing and clears before another touch.
  It never changes the ball flight or turns a parry into possession.
  Catch animation uses the engine's actual receiving method: two hands close
  together, one hand receives before the free hand joins, and chest/arm catches
  wrap the ball into the body. A ball gathered at the feet stays on the turf
  while staggered steps open a squat and both hands arrive; only then is it
  lifted during the rise. Low
  catches use a downward scoop; a diving keeper protects the ball beside the
  chest through the landing and roll and uses the free hand to brace during the
  captured get-up. Supporting wrists lock the palm to its turf target, with
  flattened fingers and thumbs. Both
  hands rejoin the hold as the keeper rises. Shoulder reach and an approximation
  of the clothed torso keep a received ball within reach and outside the shirt
  as the chest rolls relative to the hips. Held-ball position and rotation share
  the body's pose and absolute time, including during result idle and replay.
- `src/pose-math.js` shares the keeper's articulated spine frame between body
  animation, rigging and ball holds. Abdomen and chest rotations use separate
  anatomical pivots, with a small shoulder lead at takeoff and bounded lag during
  recovery. Dive bend and twist fade as the keeper gets upright.
- `src/kick-motion.js` samples a real CMU soccer-kick capture for the taker's
  approach, load, strike and follow-through. Captured pelvis/chest rotation and
  limb directions are retargeted to the model's anatomy, with a planted support
  forefoot and a small IK correction to the unchanged strike contact. Aim changes
  leave idle feet still; the approach turns smoothly into the shot heading.
  Sampling and blends use absolute time, so live shots and replays match.
  The local clip is about 53 KB; `assets/motion/CREDITS.md` records the source,
  usage terms and offline build command.
- `src/body-motion.js` retargets recorded CMU walking, jogging and ground recovery.
  Gait phase follows distance, with smooth starts and stops; settling and turns
  alternate foot placements. Reactions use finite gestures and return to rest.
  The local locomotion/recovery clips total about 156 KB and use the same source
  terms documented in `assets/motion/CREDITS.md`.
- `src/scene.js` and `src/visuals.js` hold the stadium: stepped seating with instanced
  spectators, gangways, rails, access tunnels and roof trusses; scrolling LED boards
  and floodlights; textured turf with fine wind-blown blades, worn goalmouth and
  contact shadows; thinner net cords with frame ties and pinned edges; and a leather
  32-panel ball with recessed seams. Static terraces and trusses use merged geometry.

Open `http://localhost:8000/tools/visual-review.html` to inspect the models from
nine camera positions (including face and held-ball hand close-ups), select low/high
dives, star jumps, ground recovery, second dives, outcome reactions, two-hand/one-hand/chest
catches, arm/foot gathers, controlled parries, limbs giving way or parry-then-catch
sequences, and play them at quarter/half speed. Each fixture checks that it still
produces the outcome it describes; the latest touch and method appear beside the time.
On load it checks finite skin transforms, joint continuity, sole clearance,
varied contact keys, stationary shuffle footholds, reproducible poses and held-ball
transforms after seeking, compact ready arms and neutral wrists, recovery phases,
supporting hand clearance, mirrored second-dive braces and foot plants,
stationary drive toes, continuous phase boundaries and unchanged recorded glove centres at contact,
continuous catch onset, palm contact and finger/glove clearance around the ball,
one-hand receiving order, delayed foot-gather lift and recoil driven by `gaveWay`.
Animation also leaves the recorded simulation data, catch metadata and recovery
metadata unchanged.
This review page is separate from the game.
