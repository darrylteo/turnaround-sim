// Eval 2: replay fidelity. If you don't touch anything, the world plays the
// generated schedule back exactly, and the same inputs give the same run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generate, REPLAY_SPEED } from '../src/sim/generator.js';
import { sampleTrack } from '../src/sim/track.js';
import { A320, stand, world, dist } from './helpers.js';

const gen = (seed) => generate({ table: A320, stand, seed });

test('with no player, every vehicle sits on its generated track at every step', () => {
  for (const seed of [1, 2, 3]) {
    const s = gen(seed);
    const w = world(s);
    const tracks = Object.fromEntries(s.vehicles.map((v) => [v.id, v.track]));
    while (w.t < s.loopEnd - 1) {
      w.step(0.5);
      for (const v of w.vehicles) {
        const p = sampleTrack(tracks[v.id], w.t);
        assert.ok(dist(v, p) < 0.01, `seed ${seed}: ${v.id} off track by ${dist(v, p).toFixed(3)} m at ${w.t}s`);
      }
    }
    assert.equal(w.delay.total, 0);
    assert.equal(w.events.filter((e) => e.type === 'blocked' || e.type === 'reroute').length, 0);
  }
});

test('vehicles reach each spot at the scheduled arrive time and leave at depart', () => {
  const s = gen(5);
  for (const v of s.vehicles) {
    for (const visit of v.visits) {
      const spot = stand.nodes[visit.spot];
      assert.ok(dist(sampleTrack(v.track, visit.arrive), spot) < 0.5, `${v.id} not at spot on arrival`);
      assert.ok(dist(sampleTrack(v.track, visit.depart), spot) < 0.5, `${v.id} left early`);
    }
  }
});

test('tracks stay on the stand road graph and under the replay speed', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    for (const v of gen(seed).vehicles) {
      for (let i = 0; i < v.track.length; i++) {
        const p = v.track[i];
        assert.ok(stand.distanceToNetwork(p.x, p.y) < 0.5, `${v.id} off-road at ${p.t}s`);
        if (i === 0) continue;
        const q = v.track[i - 1];
        const dt = p.t - q.t;
        assert.ok(dt >= 0, `${v.id} track goes back in time`);
        if (dt > 0) assert.ok(dist(p, q) / dt <= REPLAY_SPEED + 1e-6, `${v.id} too fast at ${p.t}s`);
      }
    }
  }
});

test('same seed and same player inputs give an identical run', () => {
  const input = (t) => ({ throttle: t % 40 < 25 ? 1 : -0.5, steer: Math.sin(t / 7) });
  const run = () => {
    const w = world(gen(7), { player: { x: stand.nodes[stand.playerStart].x, y: stand.nodes[stand.playerStart].y, h: 0 } });
    while (w.t < 30 * 60) w.step(0.25, input(w.t));
    return JSON.stringify({ events: w.events, delay: w.delay, player: w.player, vehicles: w.vehicles.map((v) => [v.x, v.y]) });
  };
  assert.equal(run(), run());
});

test('late arrivals in the schedule show up as late_arrival events', () => {
  let checked = 0;
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
    const s = gen(seed);
    const lateVisits = s.vehicles.flatMap((v) => v.visits.filter((x) => x.arrive - x.planned > 60).map((x) => v.id));
    const w = world(s);
    while (w.t < s.loopEnd - 1) w.step(0.5);
    const events = w.events.filter((e) => e.type === 'late_arrival').map((e) => e.vehicles[0]);
    assert.deepEqual(events.sort(), lateVisits.sort(), `seed ${seed}`);
    checked += lateVisits.length;
  }
  assert.ok(checked > 0, 'no seed had a late vehicle, so nothing was checked');
});
