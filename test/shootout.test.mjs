import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as S from '../src/shootout.js';

const play = (kicks) => {
  const s = S.createShootout();
  for (const k of kicks) S.record(s, S.nextSide(s), k);
  return s;
};

test('the player kicks first in every round', () => {
  const s = S.createShootout();
  assert.equal(S.nextSide(s), 'player');
  S.record(s, 'player', true);
  assert.equal(S.nextSide(s), 'cpu');
  assert.throws(() => S.record(s, 'player', true));
});

test('ends as soon as one side cannot be caught', () => {
  // 3-0 after three rounds: the computer has two kicks left.
  assert.equal(S.winner(play([true, false, true, false, true, false])), 'player');
  assert.equal(S.winner(play([true, false, true, false])), null);
  // 0-3 after three rounds: the player's two kicks left cannot make up three.
  assert.equal(S.winner(play([false, true, false, true, false, true])), 'cpu');
  // 2-4 after four rounds: one kick left cannot make up two.
  assert.equal(S.winner(play([true, true, true, true, false, true, false, true])), 'cpu');
});

test('sudden death is decided once both have kicked in a round', () => {
  const level = Array(10).fill(true);
  assert.equal(S.winner(play(level)), null);
  assert.equal(S.suddenDeath(play(level)), true);
  assert.equal(S.winner(play([...level, true])), null);
  assert.equal(S.winner(play([...level, true, false])), 'player');
  assert.equal(S.winner(play([...level, false, true])), 'cpu');
  assert.equal(S.winner(play([...level, true, true])), null);
});
