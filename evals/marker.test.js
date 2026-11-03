// Eval 6: Mark mode. A viewer flags moments and gives verdicts on detector
// events; the export is a stable JSON eval set.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generate } from '../src/sim/generator.js';
import { createMarker, importMarks, VERDICTS } from '../src/sim/marker.js';
import { A320, stand, world } from './helpers.js';

// A run with at least one detector event to mark.
function run() {
  for (let seed = 1; seed < 50; seed++) {
    const s = generate({ table: A320, stand, seed });
    const w = world(s);
    while (w.t < s.loopEnd - 1) w.step(0.5);
    if (w.events.length) return { seed, events: w.events };
  }
  throw new Error('no seed produced a detector event');
}

const EXPORTED_AT = '2026-01-01T00:00:00.000Z';

test('verdicts are the fixed three', () => {
  assert.deepEqual(VERDICTS, ['valid', 'false_alarm', 'unsure']);
});

test('export holds every detector event, marked or not, plus human flags', () => {
  const { seed, events } = run();
  const m = createMarker({ seed, aircraft: 'A320' });
  m.verdict(events[0].id, 'false_alarm', 'trucks were parked, not moving');
  const flagId = m.flag({ t: 600, loop: 0, note: 'tug cut across the loader', vehicles: ['player'] });
  const out = m.export(events, { exportedAt: EXPORTED_AT });

  assert.equal(out.schema, 'turnaround-sim/marks@1');
  assert.equal(out.seed, seed);
  assert.equal(out.aircraft, 'A320');
  assert.equal(out.exportedAt, EXPORTED_AT);
  assert.equal(out.marks.length, events.length + 1);

  const first = out.marks.find((x) => x.eventId === events[0].id);
  assert.deepEqual(
    { source: first.source, verdict: first.verdict, note: first.note, type: first.type },
    { source: 'detector', verdict: 'false_alarm', note: 'trucks were parked, not moving', type: events[0].type },
  );
  const human = out.marks.find((x) => x.eventId === flagId);
  assert.equal(human.source, 'human');
  assert.equal(human.type, 'human_flag');
  assert.equal(human.t, 600);
  for (const x of out.marks.filter((x) => x.source === 'detector' && x.eventId !== events[0].id)) {
    assert.equal(x.verdict, null, 'unmarked events export with verdict null');
  }
});

test('marks are sorted by loop, time, then id', () => {
  const { seed, events } = run();
  const m = createMarker({ seed, aircraft: 'A320' });
  m.flag({ t: 5, loop: 1, note: 'b' });
  m.flag({ t: 5, loop: 0, note: 'a' });
  const marks = m.export(events, { exportedAt: EXPORTED_AT }).marks;
  for (let i = 1; i < marks.length; i++) {
    const a = marks[i - 1];
    const b = marks[i];
    assert.ok(a.loop < b.loop || (a.loop === b.loop && (a.t < b.t || (a.t === b.t && a.eventId < b.eventId))));
  }
});

test('a second verdict replaces the first', () => {
  const { seed, events } = run();
  const m = createMarker({ seed, aircraft: 'A320' });
  m.verdict(events[0].id, 'valid');
  m.verdict(events[0].id, 'unsure', 'not sure now');
  const out = m.export(events, { exportedAt: EXPORTED_AT });
  const x = out.marks.filter((x) => x.eventId === events[0].id);
  assert.equal(x.length, 1);
  assert.equal(x[0].verdict, 'unsure');
});

test('bad input is rejected', () => {
  const { seed, events } = run();
  const m = createMarker({ seed, aircraft: 'A320' });
  assert.throws(() => m.verdict(events[0].id, 'maybe'));
  assert.throws(() => m.verdict('no-such-event', 'valid'));
  assert.throws(() => m.flag({ loop: 0, note: 'no time' }));
});

test('export survives a JSON round trip and re-import', () => {
  const { seed, events } = run();
  const m = createMarker({ seed, aircraft: 'A320' });
  m.verdict(events[0].id, 'valid', 'real conflict');
  m.flag({ t: 61.5, loop: 0, note: 'odd stop' });
  const out = m.export(events, { exportedAt: EXPORTED_AT });
  const back = importMarks(JSON.parse(JSON.stringify(out)));
  assert.deepEqual(back.export(events, { exportedAt: EXPORTED_AT }), out);
  assert.throws(() => importMarks({ schema: 'something-else', marks: [] }));
});
