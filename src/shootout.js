// Shootout scoring, the same rules as the realm's impl/v3: the player kicks
// first in every round; five kicks each at most, no sudden death; the player
// wins only by WIN_MARGIN goals or more, and it ends as soon as that is
// certain either way.
export const REGULATION = 5;
export const WIN_MARGIN = 2;

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

// 'player' | 'cpu' | null while undecided: the player once they are sure to
// finish WIN_MARGIN ahead, the computer once they no longer can.
export function winner(s) {
  const pg = goals(s.player);
  const cg = goals(s.cpu);
  const playerLeft = REGULATION - s.player.length;
  const cpuLeft = REGULATION - s.cpu.length;
  if (pg - (cg + cpuLeft) >= WIN_MARGIN) return 'player';
  if (pg + playerLeft - cg < WIN_MARGIN) return 'cpu';
  return null;
}

export const score = (s) => ({ player: goals(s.player), cpu: goals(s.cpu) });
export const round = (s) => s.cpu.length + 1;
