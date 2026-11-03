// Eval 7: the demo plays two turnarounds with a gap, then loops cleanly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generate } from '../src/sim/generator.js';
import { sampleTrack } from '../src/sim/track.js';
import { A320, MIN, stand, world, dist, runUntil } from './helpers.js';

const s = generate({ table: A320, stand, seed: 3 });
const [a, b] = s.turns;

test('aircraft is on blocks during each turn and gone mid-gap', () => {
  const w = world(s);
  runUntil(w, (w) => w.t >= a.onBlock + MIN);
  assert.equal(w.aircraft.phase, 'on_blocks');
  runUntil(w, (w) => w.t >= (a.offBlock + b.onBlock) / 2);
  assert.equal(w.aircraft.phase, 'absent');
  runUntil(w, (w) => w.t >= b.onBlock + MIN);
  assert.equal(w.aircraft.phase, 'on_blocks');
});

test('the stand is empty between the turns', () => {
  const w = world(s);
  runUntil(w, (w) => w.t >= a.offBlock + 3 * MIN);
  while (w.t < b.onBlock) {
    for (const v of w.vehicles) {
      assert.ok(v.state === 'offstage' || !stand.inSafetyArea(v.x, v.y), `${v.id} in the safety area at ${w.t}s`);
    }
    w.step(1);
  }
});

test('stepping past loopEnd restarts the replay and keeps the event log', () => {
  const w = world(s);
  runUntil(w, (w) => w.loop === 1, { dt: 0.5 });
  assert.ok(w.t < 1, `t = ${w.t} after wrap`);
  assert.equal(w.delay.total, 0, 'delay counter resets each loop');
  assert.ok(w.turns.every((t) => !t.done), 'turn results reset each loop');
  for (const v of w.vehicles) {
    const track = s.vehicles.find((x) => x.id === v.id).track;
    assert.ok(dist(v, sampleTrack(track, w.t)) < 0.01, `${v.id} not reset`);
  }
  const loop0 = w.events.filter((e) => e.loop === 0).length;
  assert.equal(loop0, w.events.length, 'loop 0 events kept, none duplicated yet');
});

test('untouched loops play out identically', () => {
  const w = world(s);
  runUntil(w, (w) => w.loop === 3, { dt: 0.5 });
  const shape = (loop) => w.events.filter((e) => e.loop === loop).map((e) => [e.type, e.vehicles, Math.round(e.t)]);
  assert.deepEqual(shape(1), shape(0));
  assert.deepEqual(shape(2), shape(0));
});
