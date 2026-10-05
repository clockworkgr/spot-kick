import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as S from '../src/shootout.js';

const play = (kicks) => {
  const s = S.createShootout();
  for (const k of kicks) S.record(s, S.nextSide(s), k);
  return s;
};
// Rounds as [player scored, computer scored].
const rounds = (...rs) => play(rs.flat());

test('the player kicks first in every round', () => {
  const s = S.createShootout();
  assert.equal(S.nextSide(s), 'player');
  S.record(s, 'player', true);
  assert.equal(S.nextSide(s), 'cpu');
  assert.throws(() => S.record(s, 'player', true));
});

test('the player wins only once sure to finish two goals ahead', () => {
  // 3-0 after three rounds: 3-2 is still possible, and the player can add two.
  assert.equal(S.winner(rounds([true, false], [true, false], [true, false])), null);
  // 4-1 after four rounds: the computer's last kick leaves it at least 4-2.
  assert.equal(S.winner(rounds([true, false], [true, true], [true, false], [true, false])), 'player');
  // 4-2 after five rounds, decided by the computer's last miss.
  const close = rounds([true, false], [true, true], [true, false], [false, true]);
  S.record(close, 'player', true);
  assert.equal(S.winner(close), null);
  S.record(close, 'cpu', false);
  assert.equal(S.winner(close), 'player');
});

test('a one-goal win, or worse, loses', () => {
  // 4-3 going into the last kick... a miss leaves 4-3 at best: one goal is not
  // enough, and there is no sudden death.
  const s = rounds([true, true], [true, false], [true, true], [true, true]);
  assert.equal(S.winner(s), null);
  S.record(s, 'player', false);
  assert.equal(S.winner(s), 'cpu');
  assert.throws(() => S.record(s, 'cpu', true));
  // 1-2 after three rounds: two kicks left can reach 3-2 at best.
  assert.equal(S.winner(rounds([true, true], [false, false], [false, true])), 'cpu');
  // level 2-2 after two rounds is still open.
  assert.equal(S.winner(rounds([true, true], [true, true])), null);
});
