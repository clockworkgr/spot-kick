import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import * as CP from '../src/chainplay.js';
import * as P from '../src/physics.js';

const IMPL = new URL('../../gno-shots-realm/gno.land/r/clockwork/shots/impl/v3/impl.gno', import.meta.url);

test('the tables are the realm impl/v3 ones', { skip: !existsSync(IMPL) && 'realm repo not next to this one' }, () => {
  const src = readFileSync(IMPL, 'utf8');
  const block = (name) => src.slice(src.indexOf(`var ${name} = `), src.indexOf('\n}\n', src.indexOf(`var ${name} = `)));
  const rows = (name) => [...block(name).matchAll(/\{([-\d, ]+)\}/g)].map((m) => m[1].split(',').map((x) => Number(x.trim())));
  assert.deepEqual(rows('chainKeeper'), CP.CHAIN_KEEPER.map((e) => [e.cum, ...e.raw]));
  assert.deepEqual(rows('chainKicks'), CP.CHAIN_KICKS.map((e) => [e.cum, e.aimX, e.aimY, e.contactX, e.contactY, e.power]));
});

test('the round bytes pick moves in proportion to their weights', () => {
  for (const table of [CP.CHAIN_KEEPER, CP.CHAIN_KICKS]) {
    let prev = 0;
    for (const e of table) {
      assert.ok(e.cum > prev);
      prev = e.cum;
    }
    assert.equal(prev, 65536);
  }
  const bytes = new Uint8Array(32);
  bytes.set([0x56, 0x40], 0); // 22080: the first entry above the read plan's share
  assert.deepEqual(CP.keeperFromBytes(bytes).plan.raw, CP.CHAIN_KEEPER[1].raw);
  bytes.set([0, 0], 0);
  const k = CP.keeperFromBytes(bytes);
  assert.equal(k.plan.mode, 'read');
  bytes.set([0xff, 0xff], 0);
  const kick = CP.kickFromBytes(bytes);
  assert.deepEqual(kick.ints, { aimX: -2100, aimY: 1450, contactX: 0, contactY: -100, power: 1000 });
  bytes.set([7, 7, 7], 8);
  assert.deepEqual([...CP.kickFromBytes(bytes).input.seed.slice(0, 3)], [7, 7, 7]);
  assert.ok(P.simulateShot(kick.input, k.plan).result.outcome);
});
