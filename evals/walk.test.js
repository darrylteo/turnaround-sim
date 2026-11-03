// Eval 9: walking and jumping on foot, as in the earlier stand replay.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWalker, stepWalker, WALK } from '../src/sim/walker.js';
import { rect, inPoly, polyDist } from '../src/sim/geom.js';
import { stand, dist } from './helpers.js';

const open = (h = 0) => createWalker({ ...stand.nodes[stand.playerStart], h });
const run = (w, input, seconds, env = { stand, solids: [] }, dt = 1 / 60) => {
  const trace = [];
  for (let k = 0, n = Math.round(seconds / dt); k < n; k++) { stepWalker(w, input, dt, env); trace.push({ ...w }); }
  return trace;
};

test('walks at walking pace and runs at running pace', () => {
  for (const [run_, v] of [[false, WALK.walk], [true, WALK.run]]) {
    const w = open();
    const x0 = { x: w.x, y: w.y };
    run(w, { forward: true, run: run_ }, 2);
    assert.ok(Math.abs(dist(w, x0) - 2 * v) < 0.05 * v, `${dist(w, x0).toFixed(2)} m in 2 s`);
  }
});

test('walking diagonally is no faster than straight', () => {
  const w = open();
  const x0 = { x: w.x, y: w.y };
  run(w, { forward: true, right: true }, 2);
  assert.ok(dist(w, x0) <= 2 * WALK.walk + 1e-6);
});

test('Q and E turn at the set rate', () => {
  const w = open(0);
  run(w, { turnLeft: true }, 1);
  assert.ok(Math.abs(w.h - WALK.turnRate) < 0.02, `turned ${w.h}`);
});

test('a jump rises to v^2/2g and lands after 2v/g', () => {
  const w = open();
  const trace = run(w, { jump: true }, 1.2);
  const apex = Math.max(...trace.map((s) => s.z));
  const air = trace.filter((s) => s.z > 0).length / 60;
  assert.ok(Math.abs(apex - WALK.jumpV ** 2 / (2 * WALK.gravity)) < 0.02, `apex ${apex.toFixed(3)} m`);
  assert.ok(Math.abs(air - 2 * WALK.jumpV / WALK.gravity) < 0.04, `airtime ${air.toFixed(3)} s`);
  assert.equal(w.z, 0);
});

test('no second jump in mid-air, and a landing dip after', () => {
  const w = open();
  stepWalker(w, { jump: true }, 1 / 60, { stand, solids: [] });
  run(w, {}, 0.2);
  const vz = w.vz;
  stepWalker(w, { jump: true }, 1 / 60, { stand, solids: [] });
  assert.ok(w.vz < vz, 'jumped again in the air');
  const after = run(w, {}, 1);
  assert.equal(w.z, 0);
  assert.ok(after.some((s) => s.z === 0 && s.land > 0), 'no landing dip');
});

test('you cannot walk into the aircraft', () => {
  const door = stand.nodes[stand.spots.door_1R];
  const w = createWalker({ x: door.x, y: door.y, h: Math.PI });
  const env = { stand, solids: stand.aircraftParts().map((p) => p.poly) };
  for (const s of run(w, { forward: true, run: true }, 6, env)) {
    for (const P of env.solids) {
      assert.ok(!inPoly([s.x, s.y], P), 'inside the aircraft');
      assert.ok(polyDist([s.x, s.y], P) >= WALK.radius - 1e-3);
    }
  }
});

test('a vehicle driving at you pushes you aside, never through you', () => {
  const w = open();
  const x0 = w.x, y0 = w.y;
  for (let k = 0; k < 300; k++) {
    const truck = rect(x0 + 8 - k * 0.05, y0 + 0.3, Math.PI, 7, 2.5);
    stepWalker(w, {}, 1 / 60, { stand, solids: [truck] });
    assert.ok(!inPoly([w.x, w.y], truck), `inside the truck at step ${k}`);
  }
});

test('you stay on the stand', () => {
  const w = open(Math.PI);
  run(w, { forward: true, run: true }, 30);
  const b = stand.bounds;
  assert.ok(w.x >= b.xmin && w.x <= b.xmax && w.y >= b.ymin && w.y <= b.ymax);
});
