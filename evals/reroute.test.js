// Eval 3: replayed vehicles wait for the player and reroute around them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STOP_DISTANCE } from '../src/sim/world.js';
import { cleanSchedule, world, vehicle, catchOnEdge, blockAhead, clearPlayer, runUntil, dist } from './helpers.js';

// First vehicle in the loop that drives along an edge of the given kind.
function setup({ alt, rerouteAfter }) {
  const s = cleanSchedule();
  for (const v of s.vehicles) {
    const w = world(s, { rerouteAfter });
    if (catchOnEdge(w, v.id, { alt })) return { s, w, id: v.id };
  }
  throw new Error(`no vehicle drives an edge with alt=${alt}`);
}

test('a vehicle stops short of the player and waits', () => {
  const { w, id } = setup({ alt: true, rerouteAfter: Infinity });
  blockAhead(w, id);
  let minGap = Infinity;
  runUntil(w, (w) => void (minGap = Math.min(minGap, dist(vehicle(w, id), w.player))), { maxT: 20 });
  const v = vehicle(w, id);
  assert.equal(v.state, 'waiting');
  assert.ok(minGap >= STOP_DISTANCE - 1, `closed to ${minGap.toFixed(2)} m`);
  assert.ok(w.events.some((e) => e.type === 'blocked' && e.vehicles.includes(id)), 'no blocked event');
});

test('it never drives through the player', () => {
  const { w, id } = setup({ alt: true, rerouteAfter: Infinity });
  blockAhead(w, id);
  for (let i = 0; i < 240; i++) {
    w.step(0.25);
    assert.ok(dist(vehicle(w, id), w.player) >= STOP_DISTANCE - 1, `overlap at ${w.t}s`);
  }
});

test('after rerouteAfter seconds it takes a detour that avoids the blocked edge', () => {
  const { w, id } = setup({ alt: true, rerouteAfter: 10 });
  const blocked = { ...vehicle(w, id).edge };
  blockAhead(w, id);
  runUntil(w, (w) => vehicle(w, id).rerouted, { maxT: 15 });
  const v = vehicle(w, id);
  assert.ok(v.rerouted, 'did not reroute within 15 s');
  assert.ok(w.events.some((e) => e.type === 'reroute' && e.vehicles.includes(id)), 'no reroute event');
  const uses = (r) => r.some((n, i) => i > 0 && ((r[i - 1] === blocked.a && n === blocked.b) || (r[i - 1] === blocked.b && n === blocked.a)));
  assert.ok(!uses(v.route), 'detour still uses the blocked edge');
  const arrivals = () => w.delay.arrivals.filter((a) => a.vehicle === id);
  assert.ok(runUntil(w, () => arrivals().length > 0, { maxT: 600 }), 'never reached its spot');
  assert.ok(arrivals()[0].late > 0, 'detour should cost time');
});

test('with no detour it keeps waiting, then resumes when the player leaves', () => {
  const { w, id } = setup({ alt: false, rerouteAfter: 10 });
  blockAhead(w, id);
  runUntil(w, () => false, { maxT: 60 });
  assert.equal(vehicle(w, id).state, 'waiting');
  assert.ok(!vehicle(w, id).rerouted, 'rerouted with no alternative');
  clearPlayer(w);
  assert.ok(runUntil(w, (w) => vehicle(w, id).state !== 'waiting', { maxT: 2 }), 'did not resume');
  assert.ok(runUntil(w, (w) => w.delay.arrivals.some((a) => a.vehicle === id), { maxT: 600 }), 'never arrived');
});
