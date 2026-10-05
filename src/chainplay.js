// How the computer plays, as gno-shots-realm's impl/v3: the first two of the
// 32 round bytes pick its keeper plan or its kick from equilibrium mixes,
// the last 24 are the mishit seed. The mixes solve the shooter-keeper game
// on this physics engine for the default constants (a double oracle): no
// shot scores more than about 79% against the keeper mix, no keeper plan
// concedes less than about 77% to the kick mix.
import * as P from './physics.js?v=28';

// cum: cumulative weight out of 65536; raw: the plan's four uint16.
export const CHAIN_KEEPER = [
  { cum: 22080, raw: [32768, 11796, 32768, 0] }, // 33.7% wait and read
  { cum: 35198, raw: [31457, 58650, 32768, 19661] }, // 20.0%
  { cum: 48315, raw: [34078, 58650, 32768, 19661] }, // 20.0%
  { cum: 56642, raw: [31457, 65530, 0, 0] }, // 12.7%
  { cum: 64968, raw: [34078, 65530, 0, 0] }, // 12.7%
  { cum: 65252, raw: [31457, 65530, 32768, 32768] }, // 0.4%
  { cum: 65536, raw: [34078, 65530, 32768, 32768] }, // 0.4%
];

// Realm units: aim mm, contact milli-radii, power per-mille.
export const CHAIN_KICKS = [
  { cum: 13504, aimX: 2200, aimY: 150, contactX: 0, contactY: -100, power: 1000 }, // 20.6%
  { cum: 27008, aimX: -2200, aimY: 150, contactX: 0, contactY: -100, power: 1000 }, // 20.6%
  { cum: 33589, aimX: 3200, aimY: 2250, contactX: 250, contactY: -100, power: 850 }, // 10.0%
  { cum: 40169, aimX: -3200, aimY: 2250, contactX: -250, contactY: -100, power: 850 }, // 10.0%
  { cum: 46362, aimX: 3300, aimY: 2150, contactX: 250, contactY: -100, power: 850 }, // 9.4%
  { cum: 52554, aimX: -3300, aimY: 2150, contactX: -250, contactY: -100, power: 850 }, // 9.4%
  { cum: 58145, aimX: 100, aimY: 2250, contactX: 0, contactY: 50, power: 1000 }, // 8.5%
  { cum: 63737, aimX: -100, aimY: 2250, contactX: 0, contactY: 50, power: 1000 }, // 8.5%
  { cum: 64636, aimX: 2100, aimY: 1450, contactX: 0, contactY: -100, power: 1000 }, // 1.4%
  { cum: 65536, aimX: -2100, aimY: 1450, contactX: 0, contactY: -100, power: 1000 }, // 1.4%
];

const pick = (bytes, table) => {
  const u = (bytes[0] << 8) | bytes[1];
  return table.find((e) => u < e.cum) ?? table[table.length - 1];
};

// When you shoot: the computer's keeper plan and your mishit seed.
export function keeperFromBytes(bytes) {
  const { raw } = pick(bytes, CHAIN_KEEPER);
  return { plan: P.planFromRaw(raw), strikeSeed: Uint8Array.from(bytes.slice(8, 32)) };
}

// When you keep: the computer's kick (as P.decodeTakerShot returns it).
export function kickFromBytes(bytes) {
  const { aimX, aimY, contactX, contactY, power } = pick(bytes, CHAIN_KICKS);
  return {
    input: {
      aim: { x: aimX / 1000, y: aimY / 1000 },
      contact: { x: contactX / 1000, y: contactY / 1000 },
      power: power / 1000,
      seed: Uint8Array.from(bytes.slice(8, 32)),
    },
    ints: { aimX, aimY, contactX, contactY, power },
  };
}
