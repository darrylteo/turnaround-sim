// Eval 5: the player's vehicle stays inside its handling limits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPlayer, stepPlayer, playerRect, LIMITS } from '../src/sim/player.js';
import { rect, overlap } from '../src/sim/geom.js';
import { stand, cleanSchedule, world, dist } from './helpers.js';

const env = { stand, obstacles: [] };
const open = () => createPlayer({ ...stand.nodes[stand.playerStart], h: 0 });
const drive = (p, input, seconds, dt = 1 / 60, e = env) => {
  const trace = [];
  for (let t = 0; t < seconds; t += dt) {
    const prev = { ...p };
    stepPlayer(p, input, dt, e);
    trace.push({ prev, p: { ...p }, dt });
  }
  return trace;
};

test('speed never exceeds the cap, forward or reverse', () => {
  const p = open();
  let top = 0;
  for (const s of drive(p, { throttle: 1, steer: 0 }, 60)) top = Math.max(top, s.p.v);
  assert.ok(top <= LIMITS.maxSpeed + 1e-9, `${top} m/s`);
  assert.ok(top >= 0.95 * LIMITS.maxSpeed, 'never got near top speed');
  const r = open();
  for (const s of drive(r, { throttle: -1, steer: 0 }, 30)) assert.ok(-s.p.v <= LIMITS.maxReverse + 1e-9);
});

test('acceleration and braking are capped', () => {
  const p = open();
  const trace = [...drive(p, { throttle: 1, steer: 0 }, 10), ...drive(p, { throttle: -1, steer: 0 }, 5)];
  for (const { prev, p: q, dt } of trace) {
    const dv = q.v - prev.v;
    assert.ok(dv <= LIMITS.accel * dt + 1e-9, 'accelerates too hard');
    assert.ok(-dv <= LIMITS.brake * dt + 1e-9, 'brakes too hard');
  }
});

test('turning radius is never tighter than the minimum (except the slow turn on the spot)', () => {
  const p = open();
  for (const { prev, p: q } of drive(p, { throttle: 1, steer: 1 }, 20)) {
    const dh = Math.abs(Math.atan2(Math.sin(q.h - prev.h), Math.cos(q.h - prev.h)));
    const ds = dist(q, prev);
    if (dh > 1e-6 && Math.abs(q.v) >= LIMITS.pivotBelow) assert.ok(ds / dh >= LIMITS.minTurnRadius - 0.1, `radius ${(ds / dh).toFixed(2)} m`);
    if (Math.abs(q.v) < LIMITS.pivotBelow) assert.ok(dh <= LIMITS.pivotRate / 60 + 1e-9, 'turns on the spot too fast');
  }
});

test('the player cannot drive into the aircraft', () => {
  const nose = stand.nodes[stand.spots.nose_gear];
  const p = createPlayer({ x: nose.x + 30, y: nose.y - 12, h: Math.PI });
  for (const { p: q } of drive(p, { throttle: 1, steer: 0 }, 30, 1 / 60, { stand, obstacles: [], aircraft: true })) {
    assert.ok(!stand.insideAircraft(q.x, q.y, LIMITS.halfWidth), `inside the aircraft at ${q.x.toFixed(1)},${q.y.toFixed(1)}`);
  }
  assert.ok(Math.abs(p.v) < 0.5, 'should be stopped against the aircraft');
});

test('the player cannot drive into another vehicle', () => {
  const p = open();
  const obstacles = [{ id: 'truck', poly: rect(p.x + 20, p.y, Math.PI / 2, 7, 2.5) }];
  for (const { p: q } of drive(p, { throttle: 1, steer: 0 }, 20, 1 / 60, { stand, obstacles })) {
    assert.ok(!overlap(playerRect(q), obstacles[0].poly), `overlaps the truck at ${q.x.toFixed(2)}`);
  }
  assert.equal(p.hit, 'truck');
});

test('the player stays inside the stand', () => {
  const p = open();
  for (const { p: q } of drive(p, { throttle: 1, steer: 0.3 }, 300)) {
    const b = stand.bounds;
    assert.ok(q.x >= b.xmin && q.x <= b.xmax && q.y >= b.ymin && q.y <= b.ymax);
  }
});

test('physics does not depend on frame rate', () => {
  const script = (t) => ({ throttle: t < 8 ? 1 : 0.3, steer: t < 4 ? 0 : 0.6 });
  const run = (dt) => {
    const p = open();
    for (let t = 0; t < 12; t += dt) stepPlayer(p, script(t), dt, env);
    return p;
  };
  const a = run(1 / 30);
  const b = run(1 / 120);
  assert.ok(dist(a, b) < 0.5, `${dist(a, b).toFixed(2)} m apart`);
});

test('junk input is ignored, state stays finite', () => {
  const p = open();
  for (const input of [{ throttle: NaN, steer: Infinity }, { throttle: 1e9, steer: -1e9 }, {}, undefined]) {
    stepPlayer(p, input, 1 / 60, env);
    for (const k of ['x', 'y', 'h', 'v']) assert.ok(Number.isFinite(p[k]), `${k} = ${p[k]}`);
    assert.ok(Math.abs(p.v) <= LIMITS.maxSpeed + 1e-9);
  }
});

test('speeding in the aircraft safety area is flagged', () => {
  const s = cleanSchedule();
  const t = s.turns[0];
  const door = stand.nodes[stand.spots.door_1R];
  const w = world(s);
  while (w.t < t.onBlock + 60) w.step(0.25);
  // Just ahead of door 1R, clear of every GSE spot, driving towards the terminal.
  w.setPlayer({ x: door.x + 1, y: door.y + 6, h: Math.PI / 2 });
  assert.ok(stand.inSafetyArea(w.player.x, w.player.y), 'test start point is outside the safety area');
  for (let i = 0; i < 40; i++) w.step(0.1, { throttle: 1, steer: 0 });
  assert.ok(w.events.some((e) => e.type === 'zone_speeding' && e.vehicles.includes('player')));
});
