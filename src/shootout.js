// Shootout scoring, the same rules as the realm's penalty.Shootout: the
// player kicks first in every round; five kicks each, ending as soon as one
// side cannot be caught; level after that, sudden-death rounds until one side
// scores and the other does not.
export const REGULATION = 5;

export function createShootout() {
  return { player: [], cpu: [] }; // per kick: true = scored
}

const goals = (k) => k.filter(Boolean).length;

// 'player' or 'cpu': who takes the next kick.
export const nextSide = (s) => (s.player.length === s.cpu.length ? 'player' : 'cpu');

export function record(s, side, scored) {
  if (winner(s)) throw new Error('the shootout is already decided');
  if (side !== nextSide(s)) throw new Error(`${side} is kicking out of turn`);
  s[side].push(scored);
}

// 'player' | 'cpu' | null while undecided.
export function winner(s) {
  const pk = s.player.length;
  const ck = s.cpu.length;
  const pg = goals(s.player);
  const cg = goals(s.cpu);
  if (pk <= REGULATION && ck <= REGULATION) {
    if (pg > cg + REGULATION - ck) return 'player';
    if (cg > pg + REGULATION - pk) return 'cpu';
    return null;
  }
  if (pk === ck && pg !== cg) return pg > cg ? 'player' : 'cpu';
  return null;
}

export const score = (s) => ({ player: goals(s.player), cpu: goals(s.cpu) });
export const round = (s) => s.cpu.length + 1;
export const suddenDeath = (s) => s.cpu.length >= REGULATION;
