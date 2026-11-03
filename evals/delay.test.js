// Eval 4: the delay counter and the on-time score add up.
// Delay counter = the lateness the player causes, summed over vehicle arrivals
// at their service spots, measured against the replay. Zero if you do nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generate } from '../src/sim/generator.js';
import { onTimeScore } from '../src/sim/world.js';
import { A320, MIN, stand, cleanSchedule, world, vehicle, catchOnEdge, blockAhead, clearPlayer, runUntil } from './helpers.js';

const typeId = (s, type, turn = 0) => s.vehicles.find((v) => v.type === type && v.turn === turn).id;

// Block vehicle `id` for `seconds`, then let it go. Returns seconds it spent waiting.
function block(w, id, seconds) {
  assert.ok(catchOnEdge(w, id, { minAhead: 25 }), `${id} never on a long enough edge`);
  blockAhead(w, id);
  let waited = 0;
  const dt = 0.25;
  for (let t = 0; t < seconds; t += dt) {
    w.step(dt);
    if (vehicle(w, id).state === 'waiting') waited += dt;
  }
  clearPlayer(w);
  return waited;
}

const finish = (w, turn = 0) => runUntil(w, (w) => w.turns[turn].done, { maxT: w.loopEnd });
const arrivalOf = (w, id) => w.delay.arrivals.find((a) => a.vehicle === id);

test('counter matches the time a blocked vehicle lost', () => {
  const s = cleanSchedule();
  const id = typeId(s, 'FUEL');
  const w = world(s, { rerouteAfter: Infinity });
  const waited = block(w, id, 30);
  assert.ok(waited >= 25, `only waited ${waited}s`);
  runUntil(w, () => arrivalOf(w, id), { maxT: 600 });
  assert.ok(Math.abs(arrivalOf(w, id).late - waited) <= 1, `late ${arrivalOf(w, id).late}s vs waited ${waited}s`);
  assert.ok(w.delay.total >= waited - 1);
});

test('counter is the sum of arrival lateness, never negative, never decreasing', () => {
  const s = generate({ table: A320, stand, seed: 11 });
  const w = world(s, { player: { x: stand.nodes[stand.playerStart].x, y: stand.nodes[stand.playerStart].y, h: 0 } });
  let last = 0;
  while (w.t < s.loopEnd - 1) {
    w.step(0.25, { throttle: Math.sin(w.t / 9), steer: Math.cos(w.t / 5) });
    assert.ok(w.delay.total >= last - 1e-9, 'counter went down');
    last = w.delay.total;
  }
  const sum = w.delay.arrivals.reduce((a, x) => a + x.late, 0);
  assert.ok(Math.abs(w.delay.total - sum) < 1e-6);
  assert.ok(w.delay.arrivals.every((a) => a.late >= 0));
});

test('delay on the critical path (catering) pushes off-block back', () => {
  const s = cleanSchedule();
  const base = world(s);
  finish(base);
  const w = world(s, { rerouteAfter: Infinity });
  const id = typeId(s, 'CAT');
  block(w, id, 60);
  finish(w);
  const late = arrivalOf(w, id).late;
  const pushed = w.turns[0].offBlock - base.turns[0].offBlock;
  assert.ok(late > 30, `catering only ${late}s late`);
  assert.ok(Math.abs(pushed - late) <= 1, `off-block moved ${pushed}s for ${late}s lateness`);
});

test('delay inside slack (fuel, 2.6 min spare) does not move off-block', () => {
  const s = cleanSchedule();
  const base = world(s);
  finish(base);
  const w = world(s, { rerouteAfter: Infinity });
  const id = typeId(s, 'FUEL');
  block(w, id, 60);
  finish(w);
  assert.ok(arrivalOf(w, id).late > 30);
  assert.ok(Math.abs(w.turns[0].offBlock - base.turns[0].offBlock) <= 0.5);
});

test('on-time score', () => {
  assert.equal(onTimeScore(-3), 100);
  assert.equal(onTimeScore(0), 100);
  assert.equal(onTimeScore(1), 95);
  assert.equal(onTimeScore(10), 50);
  assert.equal(onTimeScore(25), 0);
  const w = world(cleanSchedule());
  finish(w);
  const t = w.turns[0];
  assert.ok(Math.abs(t.lateMin - (t.offBlock - t.targetOffBlock) / MIN) < 1e-9);
  assert.equal(t.score, onTimeScore(t.lateMin));
});
