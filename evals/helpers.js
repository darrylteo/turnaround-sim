// Shared fixtures for the evals. Nothing here is under test.
import A320 from '../data/a320-turnaround.json' with { type: 'json' };
import B738 from '../data/b737-800-crosscheck.json' with { type: 'json' };
import { createStand } from '../src/sim/stand.js';
import { generate } from '../src/sim/generator.js';
import { createWorld } from '../src/sim/world.js';

export { A320, B738 };
export const MIN = 60;
export const SEEDS = Array.from({ length: 200 }, (_, i) => i + 1);

export const stand = createStand(A320);

export const byKey = (tasks) => Object.fromEntries(tasks.map((t) => [t.key, t]));

export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// A schedule with no noise and no late vehicles reproduces the source chart.
export const cleanSchedule = (opts = {}) =>
  generate({ table: A320, stand, seed: 1, noise: false, lateProb: 0, ...opts });

export const world = (schedule, opts = {}) => createWorld(schedule, { stand, ...opts });

// Step until pred(world) is true or maxT (sim seconds) passes. Returns true if pred hit.
export function runUntil(w, pred, { dt = 0.25, maxT = Infinity, input } = {}) {
  const stop = w.t + maxT;
  while (w.t < stop) {
    if (pred(w)) return true;
    w.step(dt, input);
  }
  return pred(w);
}

export const vehicle = (w, id) => w.vehicles.find((v) => v.id === id);

// Run until `id` is driving on an edge with at least `minAhead` metres left,
// on an edge that does (alt = true) or does not (alt = false) have a detour.
export function catchOnEdge(w, id, { alt, minAhead = 20, dt = 0.25 } = {}) {
  return runUntil(
    w,
    (w) => {
      const v = vehicle(w, id);
      return (
        v.state === 'moving' &&
        v.edge &&
        v.remaining >= minAhead &&
        (alt === undefined || stand.edgeHasAlternative(v.edge.a, v.edge.b) === alt)
      );
    },
    { dt, maxT: w.loopEnd },
  );
}

// Park the player `gap` metres ahead of vehicle `id`, on its lane, facing the same way.
export function blockAhead(w, id, gap = 9) {
  const v = vehicle(w, id);
  w.setPlayer({ x: v.x + gap * Math.cos(v.h), y: v.y + gap * Math.sin(v.h), h: v.h });
}

// Move the player somewhere it cannot touch anyone.
export const clearPlayer = (w) => w.setPlayer(null);
