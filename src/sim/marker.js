/* Mark mode: a viewer gives verdicts on the detector's events and flags moments of their own. The export is an eval
   set: every detector event (verdict null when unmarked) and every human flag, sorted by loop, time and id. */

export const VERDICTS = ['valid', 'false_alarm', 'unsure'];
export const SCHEMA = 'turnaround-sim/marks@1';

export function createMarker({ seed, aircraft }, init = {}) {
  const verdicts = new Map(Object.entries(init.verdicts || {}));   // event id -> { verdict, note }
  const flags = [...(init.flags || [])];                          // human flags
  let n = flags.length;

  return {
    seed, aircraft,
    verdict(eventId, verdict, note = '') {
      if (!VERDICTS.includes(verdict)) throw new Error(`verdict must be one of ${VERDICTS.join(', ')}`);
      const f = flags.find((x) => x.eventId === eventId);
      if (!f && !/^L\d+-E\d+$/.test(String(eventId))) throw new Error(`no event ${eventId}`);
      if (f) { f.verdict = verdict; f.note = note || f.note; return; }
      verdicts.set(eventId, { verdict, note });
    },
    flag({ t, loop = 0, note = '', vehicles = [] }) {
      if (!Number.isFinite(t)) throw new Error('a flag needs a time');
      const eventId = `H${String(++n).padStart(4, '0')}`;
      flags.push({ eventId, loop, t, type: 'human_flag', source: 'human', vehicles, verdict: 'valid', note });
      return eventId;
    },
    unflag(eventId) { const i = flags.findIndex((f) => f.eventId === eventId); if (i >= 0) flags.splice(i, 1); },
    get(eventId) { return verdicts.get(eventId) || flags.find((f) => f.eventId === eventId) || null; },
    export(events, { exportedAt = new Date().toISOString() } = {}) {
      const marks = [
        ...events.map((e) => {
          const v = verdicts.get(e.id);
          return { eventId: e.id, loop: e.loop, t: e.t, type: e.type, source: 'detector', vehicles: e.vehicles, data: e.data ?? {}, verdict: v ? v.verdict : null, note: v ? v.note : '' };
        }),
        ...flags.map((f) => ({ eventId: f.eventId, loop: f.loop, t: f.t, type: f.type, source: 'human', vehicles: f.vehicles, data: {}, verdict: f.verdict, note: f.note })),
      ].sort((a, b) => a.loop - b.loop || a.t - b.t || (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0));
      return { schema: SCHEMA, seed, aircraft, exportedAt, marks };
    },
  };
}

export function importMarks(json) {
  if (!json || json.schema !== SCHEMA || !Array.isArray(json.marks)) throw new Error(`not a ${SCHEMA} file`);
  const verdicts = {}, flags = [];
  for (const m of json.marks) {
    if (m.source === 'human') flags.push({ eventId: m.eventId, loop: m.loop, t: m.t, type: 'human_flag', source: 'human', vehicles: m.vehicles || [], verdict: m.verdict, note: m.note || '' });
    else if (m.verdict != null) verdicts[m.eventId] = { verdict: m.verdict, note: m.note || '' };
  }
  return createMarker({ seed: json.seed, aircraft: json.aircraft }, { verdicts, flags });
}
