// Shootout scoring, the same rules as the realm's impl/v3, where each game's
// creator chooses the margin a challenger must win by. The player kicks first
// in every round.
//   win by 1: a normal shootout, five kicks each, ending as soon as one side
//             cannot be caught, then sudden death;
//   win by 2 or 3: five kicks each at most, no sudden death, won only by that
//             many goals, ending as soon as that is certain either way.
export const REGULATION = 5;
export const DEFAULT_WIN_BY = 2;

export function createShootout(winBy = DEFAULT_WIN_BY) {
  return { player: [], cpu: [], winBy }; // per kick: true = scored
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
  const playerLeft = REGULATION - pk;
  const cpuLeft = REGULATION - ck;
  const m = s.winBy ?? DEFAULT_WIN_BY;
  if (m <= 1) {
    if (pk <= REGULATION && ck <= REGULATION) {
      if (pg > cg + cpuLeft) return 'player';
      if (cg > pg + playerLeft) return 'cpu';
      return null;
    }
    // Sudden death: decided only once both have kicked in the round.
    if (pk === ck && pg !== cg) return pg > cg ? 'player' : 'cpu';
    return null;
  }
  // The player once sure to finish m ahead, the computer once they no longer can.
  if (pg - (cg + cpuLeft) >= m) return 'player';
  if (pg + playerLeft - cg < m) return 'cpu';
  return null;
}

export const score = (s) => ({ player: goals(s.player), cpu: goals(s.cpu) });
export const round = (s) => s.cpu.length + 1;
export const suddenDeath = (s) => (s.winBy ?? DEFAULT_WIN_BY) <= 1 && s.cpu.length >= REGULATION;
