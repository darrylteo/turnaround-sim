// Eval 1: the schedule generator respects the source task table.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generate } from '../src/sim/generator.js';
import { A320, B738, MIN, SEEDS, stand, byKey, cleanSchedule } from './helpers.js';

const EPS = 1e-6;
const memo = new Map();   // the tests only read schedules, so each seed is generated once
const gen = (seed, opts = {}) => {
  const k = `${seed}:${JSON.stringify(opts)}`;
  if (!memo.has(k)) memo.set(k, generate({ table: A320, stand, seed, ...opts }));
  return memo.get(k);
};

function assertPrecedence(schedule) {
  for (const turn of schedule.turns) {
    const k = byKey(turn.tasks);
    for (const t of turn.tasks) {
      assert.ok(t.end >= t.start - EPS, `${t.key} ends before it starts`);
      for (const p of t.after) assert.ok(t.start >= k[p].end - EPS, `${t.key} starts before ${p} ends`);
      for (const n of t.before ?? []) assert.ok(t.end <= k[n].start + EPS, `${t.key} ends after ${n} starts`);
    }
  }
}

test('zero-noise schedule reproduces the A320 chart for both turns', () => {
  const s = cleanSchedule();
  assert.equal(s.turns.length, 2);
  for (const turn of s.turns) {
    const k = byKey(turn.tasks);
    for (const src of A320.tasks) {
      const t = k[`${turn.index}:${src.id}`];
      assert.ok(t, `missing task ${src.id}`);
      assert.ok(Math.abs((t.start - turn.onBlock) / MIN - src.start) < 0.05, `${src.id} start`);
      assert.ok(Math.abs((t.end - turn.onBlock) / MIN - src.end) < 0.05, `${src.id} end`);
    }
    assert.ok(Math.abs((turn.offBlock - turn.onBlock) / MIN - 44.2) < 0.05, 'TRT');
    assert.equal(turn.targetOffBlock, turn.onBlock + A320.target_trt_min * MIN);
  }
});

test('zero-noise schedule reproduces the 737-800 cross-check turn time', () => {
  const s = generate({ table: B738, stand, seed: 1, noise: false, lateProb: 0, turns: 1 });
  const turn = s.turns[0];
  assert.ok(Math.abs((turn.offBlock - turn.onBlock) / MIN - 37.5) < 0.05);
  assertPrecedence(s);
});

test('precedence holds for 200 noisy seeds on both tables', () => {
  for (const seed of SEEDS) {
    assertPrecedence(gen(seed));
    assertPrecedence(generate({ table: B738, stand, seed, turns: 1 }));
  }
});

test('no refuelling with passengers on board', () => {
  for (const seed of SEEDS) {
    for (const turn of gen(seed).turns) {
      const k = byKey(turn.tasks);
      const i = turn.index;
      assert.ok(k[`${i}:refuel`].start >= k[`${i}:deplane`].end - EPS, `seed ${seed}: fuel before deplaned`);
      assert.ok(k[`${i}:refuel`].end <= k[`${i}:board`].start + EPS, `seed ${seed}: fuel during boarding`);
    }
  }
});

test('a vehicle is at its spot for the whole task, after positioning', () => {
  for (const seed of SEEDS.slice(0, 50)) {
    const s = gen(seed);
    const tasks = byKey(s.turns.flatMap((t) => t.tasks));
    for (const v of s.vehicles) {
      for (const visit of v.visits) {
        for (const key of visit.taskKeys) {
          const t = tasks[key];
          assert.equal(t.vehicle, v.id);
          assert.ok(t.start >= t.ready - EPS, `${key} starts before ${v.id} is positioned`);
          assert.ok(visit.arrive <= t.ready + EPS && visit.depart >= t.end - EPS, `${v.id} not at spot for ${key}`);
        }
      }
    }
  }
});

test('one vehicle never serves two spots at once (catering 1R then 4R)', () => {
  for (const seed of SEEDS) {
    for (const v of gen(seed).vehicles) {
      for (let i = 1; i < v.visits.length; i++) {
        assert.ok(v.visits[i].arrive > v.visits[i - 1].depart, `seed ${seed}: ${v.id} overlaps visits`);
      }
    }
    const cat = gen(seed).vehicles.filter((v) => v.type === 'CAT' && v.turn === 0);
    assert.equal(cat.length, 1, 'one catering truck per turn');
    assert.deepEqual(cat[0].visits.map((x) => x.spot), [stand.spots.door_1R, stand.spots.door_4R]);
  }
});

test('no vehicle at the aircraft before chocks on or after off-blocks', () => {
  for (const seed of SEEDS) {
    const s = gen(seed);
    for (const v of s.vehicles) {
      const turn = s.turns[v.turn];
      for (const visit of v.visits) {
        assert.ok(visit.arrive >= turn.onBlock - EPS, `seed ${seed}: ${v.id} arrives before on-block`);
        assert.ok(visit.depart <= turn.offBlock + EPS, `seed ${seed}: ${v.id} still there after off-block`);
      }
    }
  }
});

test('generator is deterministic per seed', () => {
  const fresh = (seed) => generate({ table: A320, stand, seed });   // not the memo: two separate runs
  assert.deepEqual(fresh(42), fresh(42));
  assert.notDeepEqual(fresh(1), fresh(2));
});

test('noise stays plausible', () => {
  for (const seed of SEEDS) {
    for (const turn of gen(seed).turns) {
      for (const t of turn.tasks) {
        const src = A320.tasks.find((x) => x.id === t.id);
        const base = (src.end - src.start) * MIN;
        if (base === 0) continue;
        const r = (t.end - t.start) / base;
        assert.ok(r >= 0.9 - EPS && r <= 1.25 + EPS, `seed ${seed}: ${t.key} duration x${r.toFixed(2)}`);
      }
    }
  }
});

test('late vehicles are occasional, bounded, and sometimes cost the turn', () => {
  let seedsWithLate = 0;
  let lateTurns = 0;
  for (const seed of SEEDS) {
    const s = gen(seed);
    const late = s.vehicles.filter((v) => v.late > 0);
    assert.ok(late.length <= 4, `seed ${seed}: ${late.length} late vehicles`);
    for (const v of late) assert.ok(v.late <= 6 * MIN, `seed ${seed}: ${v.id} ${v.late}s late`);
    if (late.length) seedsWithLate++;
    lateTurns += s.turns.filter((t) => t.offBlock > t.targetOffBlock).length;
  }
  const n = SEEDS.length;
  assert.ok(seedsWithLate / n >= 0.3 && seedsWithLate / n <= 0.95, `late in ${seedsWithLate}/${n} seeds`);
  assert.ok(lateTurns / (2 * n) >= 0.1 && lateTurns / (2 * n) <= 0.9, `${lateTurns}/${2 * n} turns late`);
});

test('two turnarounds with a gap, then the loop ends', () => {
  const clean = cleanSchedule({ gapMin: 15 });
  const [a, b] = clean.turns;
  assert.ok(Math.abs(b.onBlock - a.offBlock - 15 * MIN) < 1, 'planned gap');
  for (const seed of SEEDS) {
    const s = gen(seed);
    const [a, b] = s.turns;
    assert.ok(b.onBlock >= a.offBlock + 5 * MIN - EPS, `seed ${seed}: stand not clear for turn 2`);
    assert.ok(s.loopEnd >= b.offBlock + 2 * MIN && s.loopEnd <= b.offBlock + 10 * MIN, `seed ${seed}: loop end`);
  }
});

test('every vehicle enters and leaves through a stand gate', () => {
  for (const seed of SEEDS.slice(0, 50)) {
    for (const v of gen(seed).vehicles) {
      assert.ok(Object.keys(A320.vehicles).includes(v.type), `unknown type ${v.type}`);
      const first = v.track[0];
      const last = v.track[v.track.length - 1];
      const atGate = (p) => stand.gates.some((g) => Math.hypot(stand.nodes[g].x - p.x, stand.nodes[g].y - p.y) < 0.5);
      assert.ok(atGate(first) && atGate(last), `seed ${seed}: ${v.id} appears or vanishes mid-stand`);
    }
  }
});
