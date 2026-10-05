import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as S from '../src/shootout.js';

const play = (winBy, kicks) => {
  const s = S.createShootout(winBy);
  for (const k of kicks) S.record(s, S.nextSide(s), k);
  return s;
};
// Rounds as [player scored, computer scored].
const rounds = (winBy, ...rs) => play(winBy, rs.flat());
const T = true;
const F = false;

test('the player kicks first in every round', () => {
  const s = S.createShootout();
  assert.equal(S.nextSide(s), 'player');
  S.record(s, 'player', true);
  assert.equal(S.nextSide(s), 'cpu');
  assert.throws(() => S.record(s, 'player', true));
});

test('win by 1 is a normal shootout, sudden death included', () => {
  assert.equal(S.winner(rounds(1, [T, F], [T, F], [T, F])), 'player'); // 3-0, two left
  assert.equal(S.winner(rounds(1, [F, T], [F, T], [F, T])), 'cpu');
  const level = Array(10).fill(true);
  assert.equal(S.winner(play(1, level)), null);
  assert.equal(S.suddenDeath(play(1, level)), true);
  assert.equal(S.winner(play(1, [...level, T])), null);
  assert.equal(S.winner(play(1, [...level, T, F])), 'player');
  assert.equal(S.winner(play(1, [...level, F, T])), 'cpu');
});

test('win by 2: only once sure to finish two goals ahead', () => {
  assert.equal(S.winner(rounds(2, [T, F], [T, F], [T, F])), null); // 3-2 still possible
  assert.equal(S.winner(rounds(2, [T, F], [T, T], [T, F], [T, F])), 'player'); // 4-2 at worst
  const close = rounds(2, [T, F], [T, T], [T, F], [F, T]);
  S.record(close, 'player', true);
  assert.equal(S.winner(close), null);
  S.record(close, 'cpu', false);
  assert.equal(S.winner(close), 'player'); // 4-2
  // 4-3 going into the last kick: a miss leaves one goal at best, and no sudden death.
  const s = rounds(2, [T, T], [T, F], [T, T], [T, T]);
  S.record(s, 'player', false);
  assert.equal(S.winner(s), 'cpu');
  assert.equal(S.suddenDeath(s), false);
  assert.equal(S.winner(rounds(2, [T, T], [F, F], [F, T])), 'cpu'); // 3-2 at best
});

test('win by 3', () => {
  assert.equal(S.winner(rounds(3, [T, F], [T, F], [T, F], [T, F])), 'player'); // 4-1 at worst
  assert.equal(S.winner(rounds(3, [T, F], [T, F], [T, F], [T, T])), null); // 5-2 possible
  assert.equal(S.winner(play(3, [T, T, F, F, F])), 'cpu'); // 1-1 and a miss: 3-1 at best
});
