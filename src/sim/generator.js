/* The synthetic schedule: a seeded run of turnarounds built from a task table. Each turn starts its tasks as soon as
   their release time (the chart's start), their predecessors and their vehicle allow, with noise on durations and,
   now and then, a late vehicle. Every vehicle gets a track on the stand road graph: in from a gate, a wait in its
   staging bay, its service spots, and out again. Times are seconds since the loop starts. */
import { rng, rect, gap } from './geom.js';
import { sampleTrack } from './track.js';
import { TYPES } from './fleet.js';

export const REPLAY_SPEED = 15 / 3.6;          // m/s, assumed
export const TIMES = { lead: 240, taxiIn: 120, push: 120, taxiOut: 90, tail: 300 };
const SETUP_MIN_S = 10, STAGE_S = 120, SEP_M = 0.8, SHIFT_S = 3, MAX_SHIFT_S = 60;
const TRAINS = [
  { type: 'ULD', spot: 'fwd_train', unload: 'fwd_unload', load: 'fwd_load' },
  { type: 'ULD', spot: 'aft_train', unload: 'aft_unload', load: 'aft_load' },
  { type: 'BULK', spot: 'bulk_train', unload: 'bulk_unload', load: 'bulk_load' },
];

/* A chart start is a fixed "not before" time only where nothing else explains it (the outbound loads, say). Where
   it is just the end of a predecessor or the moment the vehicle is ready, a quick crew may start earlier. */
function normalize(table) {
  const tasks = table.tasks.map((t) => ({ ...t, end: t.end ?? t.start + t.duration, after: t.after ?? [], before: t.before ?? [] }));
  const by = Object.fromEntries(tasks.map((t) => [t.id, t]));
  for (const t of tasks) for (const b of t.before) by[b].after = [...by[b].after, t.id];
  for (const t of tasks) {
    let explained = Math.max(0, ...t.after.map((p) => by[p].end));
    const first = t.same_vehicle_as ? null : tasks.find((q) => q.equipment === t.equipment && q.at === t.at && q.position);
    const win = t.position || (first && first.position);
    if (win) explained = Math.max(explained, win[1]);
    t.fixed = t.start > explained + 0.01;
  }
  return tasks;
}

export function generate({ table, stand, seed = 1, turns = 2, gapMin = 15, noise = true, lateProb = 0.35 }) {
  const R = rng(seed);
  const src = normalize(table);
  const placed = [];                                   // tracks already laid, for keeping vehicles apart
  const out = { seed, aircraft: table.aircraft, gapMin, turns: [], vehicles: [], loopEnd: 0 };
  let onBlock = TIMES.lead, minEntry = 0;
  for (let i = 0; i < turns; i++) {
    const draws = {
      m: src.map(() => (noise ? 0.9 + 0.35 * R() ** 3 : 1)),   // mostly a little quick, now and then up to 25% slow
      late: R() < lateProb, lateWho: R(), lateS: 75 + R() * 285, towGate: R(),
    };
    const plan = buildTurn({ i, onBlock, src, table, stand, draws, late: false, placed: [], minEntry });
    const turn = buildTurn({ i, onBlock, src, table, stand, draws, late: draws.late, placed, minEntry, plan });
    out.turns.push(turn.turn);
    out.vehicles.push(...turn.vehicles);
    minEntry = turn.turn.offBlock + 180;
    onBlock = turn.turn.offBlock + gapMin * 60;
  }
  const last = out.turns[out.turns.length - 1];
  out.loopEnd = last.offBlock + TIMES.tail;
  return out;
}

function buildTurn({ i, onBlock, src, table, stand, draws, late, placed, minEntry, plan }) {
  const key = (id) => `${i}:${id}`;
  const tasks = src.map((t, k) => ({
    key: key(t.id), id: t.id, turn: i, after: t.after.map(key), before: t.before.map(key),
    release: t.fixed ? onBlock + t.start * 60 : onBlock,
    dur: (t.end - t.start) * 60 * (/available time/.test(t.note || '') ? Math.min(1, draws.m[k]) : draws.m[k]),   // filler work never runs over vehicle: null, ready: null, start: null, end: null,
  }));
  const T = Object.fromEntries(tasks.map((t) => [t.id, t]));
  const S = Object.fromEntries(src.map((t) => [t.id, t]));

  // ---- vehicles: one per piece of equipment and spot, the same one where the table says so ----
  const vehicles = [], byTask = {};
  for (const s of src) {
    if (!s.equipment || !TYPES[s.equipment] || !s.at) continue;
    let v = s.same_vehicle_as ? byTask[s.same_vehicle_as] : vehicles.find((x) => x.type === s.equipment && x.visits.some((q) => q.name === s.at));
    if (!v) {
      const many = src.filter((q) => q.equipment === s.equipment && !q.same_vehicle_as).map((q) => q.at);
      const suffix = new Set(many).size > 1 ? '-' + s.at.split('_')[0] : '';
      v = { id: `t${i}-${s.equipment.toLowerCase()}${suffix}`, type: s.equipment, turn: i, late: 0, visits: [], track: [] };
      vehicles.push(v);
    }
    let visit = v.visits.find((q) => q.name === s.at);
    if (!visit) { visit = { name: s.at, spot: stand.spots[s.at], taskKeys: [], window: s.position, removeS: 0 }; v.visits.push(visit); }
    visit.taskKeys.push(key(s.id));
    if (s.remove) visit.removeS = (s.remove[1] - s.remove[0]) * 60;
    if (s.position && !visit.window) visit.window = s.position;
    T[s.id].vehicle = v.id;
    byTask[s.id] = v;
  }
  const trains = TRAINS.filter((q) => S[q.unload] && S[q.load] && stand.spots[q.spot]).map((q, k) => {
    const v = { id: q.type === 'BULK' ? `t${i}-bulk` : `t${i}-uld-${q.spot.split('_')[0]}`, type: q.type, turn: i, late: 0, track: [], feeds: q,
      visits: [{ name: q.spot, spot: stand.spots[q.spot], taskKeys: [], role: 'inbound' }, { name: q.spot, spot: stand.spots[q.spot], taskKeys: [], role: 'outbound' }] };
    vehicles.push(v);
    return v;
  });
  const lateV = late ? vehicles[Math.floor(draws.lateWho * vehicles.length)] : null;
  if (lateV) lateV.late = draws.lateS;

  // ---- times: approach and readiness of each visit, then tasks in dependency order ----
  const travel = (route) => stand.pathLength(route) / REPLAY_SPEED;
  const gateFor = (v, spotId) => {
    if (v.type === 'TOW') return draws.towGate < 0.5 ? 'gW' : 'gE';
    return stand.nodes[spotId].x < 0 ? 'gW' : 'gE';
  };
  const trainTask = {};
  for (const v of trains) { trainTask[v.feeds.unload] = [v, 0]; trainTask[v.feeds.load] = [v, 1]; }

  function timeVisit(v, k) {                // fills visit.leave, arrive, ready (once)
    const q = v.visits[k];
    if (q.ready != null) return q;
    const bay = k === 0 && stand.bays[q.name];
    const [p0, p1] = q.window || [0, 0];
    const lateS = k === 0 ? v.late : 0;
    if (k === 0) {
      const from = bay || gateFor(v, q.spot);
      q.approach = stand.path(from, q.spot, { avoidKinds: true });
      const tt = travel(q.approach);
      if (bay) { q.leave = onBlock + p0 * 60 + lateS; q.arrive = q.leave + tt; q.ready = Math.max(q.arrive + SETUP_MIN_S, q.leave + (p1 - p0) * 60); }
      else { q.arrive = onBlock + p0 * 60 + lateS; q.leave = q.arrive - tt; q.ready = Math.max(q.arrive + SETUP_MIN_S, onBlock + p1 * 60 + lateS); }
    } else {
      const prev = v.visits[k - 1];
      const prevEnd = Math.max(...prev.taskKeys.map((x) => tasks.find((t) => t.key === x).end)) + prev.removeS;
      const prevSrc = S[prev.taskKeys[prev.taskKeys.length - 1].split(':')[1]];
      const driveS = prevSrc.remove ? (p0 - prevSrc.remove[1]) * 60 : 0;
      q.leave = prevEnd + driveS;
      q.approach = stand.path(prev.spot, q.spot, { avoidKinds: true });
      q.arrive = q.leave + travel(q.approach);
      q.ready = Math.max(q.arrive + SETUP_MIN_S, q.leave + (p1 - p0) * 60);
      prev.depart = q.leave;
    }
    return q;
  }
  function timeTrain(v, k) {
    const q = v.visits[k];
    if (q.arrive != null) return q;
    const target = k === 0 ? onBlock + 60 + v.late : T[v.feeds.load].release - 60;
    q.approach = stand.path('gE', q.spot, { avoidKinds: true });
    q.arrive = target; q.leave = target - travel(q.approach); q.ready = q.arrive;
    return q;
  }

  const done = new Set();
  const order = [];
  const visit = (t) => {
    if (done.has(t.key)) return;
    done.add(t.key);
    for (const p of t.after) visit(tasks.find((x) => x.key === p));
    order.push(t);
  };
  tasks.filter((t) => t.id !== 'pushback').forEach(visit);
  for (const t of order) {
    let start = t.release;
    for (const p of t.after) start = Math.max(start, tasks.find((x) => x.key === p).end);
    if (t.vehicle) {
      const v = vehicles.find((x) => x.id === t.vehicle), k = v.visits.findIndex((q) => q.taskKeys.includes(t.key));
      t.ready = timeVisit(v, k).ready;
      start = Math.max(start, t.ready);
    }
    if (trainTask[t.id]) {
      const [v, k] = trainTask[t.id], q = timeTrain(v, k);
      start = Math.max(start, q.arrive + (k === 0 ? 30 : 60));
    }
    t.start = start; t.end = start + t.dur;
  }
  for (const v of vehicles) {
    for (let k = 0; k < v.visits.length; k++) {
      const q = v.visits[k];
      if (v.feeds) { timeTrain(v, k); const t = T[k === 0 ? v.feeds.unload : v.feeds.load]; q.depart = t.end + 30; continue; }
      timeVisit(v, k);
      if (q.depart == null) q.depart = Math.max(...q.taskKeys.map((x) => tasks.find((t) => t.key === x).end)) + q.removeS;
    }
  }

  // ---- tracks, except the tug's, kept apart from everything already laid ----
  const others = [...placed];
  const tow = vehicles.find((v) => v.type === 'TOW');
  for (const v of vehicles) {
    if (v === tow) continue;
    layTrack(v, { stand, others, minEntry });
    others.push(v);
  }
  // off-blocks: the chart's push time, once every vehicle but the tug has gone
  const push = T.pushback;
  let offBlock;
  if (push) {
    let s = push.release;
    for (const p of push.after) s = Math.max(s, tasks.find((x) => x.key === p).end);
    for (const v of vehicles) if (v !== tow) s = Math.max(s, ...v.visits.map((q) => q.depart));
    if (tow) { const q = timeVisit(tow, 0); push.ready = q.ready; s = Math.max(s, q.ready); push.vehicle = tow.id; }
    push.start = push.end = offBlock = s;
    if (tow) { tow.visits[0].depart = offBlock; layTrack(tow, { stand, others, minEntry, push: true }); others.push(tow); }
  } else offBlock = Math.max(...tasks.map((t) => t.end));
  placed.push(...vehicles);

  // planned arrivals: the same turn with no late vehicle
  for (const v of vehicles) v.visits.forEach((q, k) => {
    const pv = plan && plan.vehicles.find((x) => x.id === v.id);
    q.planned = pv ? pv.visits[k].arrive : q.arrive;
  });

  const turn = {
    index: i, onBlock, offBlock, targetOffBlock: onBlock + table.target_trt_min * 60,
    taxiInStart: onBlock - TIMES.taxiIn, pushEnd: offBlock + TIMES.push, taxiOutEnd: offBlock + TIMES.push + TIMES.taxiOut,
    tasks: tasks.map(({ key, id, turn, start, end, after, before, vehicle, ready, release }) => ({ key, id, turn, start, end, after, before, vehicle, ready, release })),
  };
  return {
    turn,
    vehicles: vehicles.map(({ id, type, turn, late, visits, track, feeds }) => ({
      id, type, turn, late, track, ...(feeds ? { feeds: [key(feeds.unload), key(feeds.load)] } : {}),
      visits: visits.map(({ name, spot, taskKeys, planned, arrive, depart, ready }) => ({ name, spot, taskKeys, planned, arrive, depart, ready })),
    })),
  };
}

/* ---- laying a track ---- */
function legSamples(stand, route, t0, { revFirst = false, speed = REPLAY_SPEED } = {}) {
  const N = stand.nodes, out = [];
  let t = t0;
  for (let k = 1; k < route.length; k++) {
    const a = N[route[k - 1]], b = N[route[k]];
    t += Math.hypot(b.x - a.x, b.y - a.y) / speed;
    out.push({ t, x: b.x, y: b.y, node: b.id, ...(revFirst && k === 1 ? { rev: true } : {}) });
  }
  return out;
}
const headingOf = (stand, a, b) => Math.atan2(stand.nodes[b].y - stand.nodes[a].y, stand.nodes[b].x - stand.nodes[a].x);

function clashes(stand, v, samples, others) {      // would this leg come too close to a laid track?
  if (!samples.length) return false;
  const tv = TYPES[v.type], t0 = samples[0].t, t1 = samples[samples.length - 1].t;
  for (const o of others) {
    if (!o.track.length || o.track[o.track.length - 1].t < t0 || o.track[0].t > t1) continue;
    const to = TYPES[o.type];
    for (let t = t0; t <= t1; t += 0.25) {
      const p = sampleTrack(samples, t), q = sampleTrack(o.track, t);
      if (t < o.track[0].t || t > o.track[o.track.length - 1].t) continue;
      if ((!q.moving && stand.nodes[o.track[q.i]?.node]?.kind === 'gate') || (!p.moving && stand.nodes[samples[p.i]?.node]?.kind === 'gate')) continue;
      if (Math.hypot(p.x - q.x, p.y - q.y) > 12) continue;
      if (gap(rect(p.x, p.y, p.h, tv.L, tv.W), rect(q.x, q.y, q.h, to.L, to.W)) < SEP_M) return true;
    }
  }
  return false;
}

function layTrack(v, { stand, others, minEntry, push }) {
  const N = stand.nodes, tr = [];
  const at = (t, id, h, extra) => tr.push({ t, x: N[id].x, y: N[id].y, h, node: id, ...extra });
  const fixH = (list, h0) => { let h = h0; for (const s of list) { const p = tr[tr.length - 1] || s; s.h = s.rev ? Math.atan2(p.y - s.y, p.x - s.x) : Math.atan2(s.y - p.y, s.x - p.x); h = s.h; tr.push(s); } return h; };
  const first = v.visits[0];
  const bay = !v.feeds && first.approach && N[first.approach[0]].kind === 'bay' ? first.approach[0] : null;

  // in: from a gate to the bay (backing in), or straight to the first spot
  if (bay) {
    const gate = N[bay].x < 0 ? 'gW' : 'gE';
    const route = stand.path(gate, bay, { avoidKinds: true });
    const tt = stand.pathLength(route) / REPLAY_SPEED;
    const t0 = Math.max(minEntry, first.leave - STAGE_S - tt);
    const mk = (t) => [{ t, x: N[gate].x, y: N[gate].y, node: gate }, ...legSamples(stand, route, t, {}).map((s, k, a) => (k === a.length - 1 ? { ...s, rev: true } : s))];
    const leg = mk(bestStart(stand, v, mk, others, t0, minEntry, first.leave - SETUP_MIN_S - tt));
    const g = leg.shift(); at(g.t, gate, headingOf(stand, route[0], route[1]));
    const h = fixH(leg, 0);
    at(first.leave, bay, h);                         // waits in the bay
  } else {
    const route = first.approach;
    let t0 = first.leave, shift = 0;
    const mk = (t) => [{ t, x: N[route[0]].x, y: N[route[0]].y, node: route[0] }, ...legSamples(stand, route, t)];
    while (shift < MAX_SHIFT_S && t0 - shift - SHIFT_S >= minEntry && clashes(stand, v, mk(t0 - shift), others)) shift += SHIFT_S;
    t0 = Math.max(0, t0 - shift);
    first.leave = t0; first.arrive = t0 + stand.pathLength(route) / REPLAY_SPEED;
    at(t0, route[0], headingOf(stand, route[0], route[1]));
    fixH(legSamples(stand, route, t0), 0);
  }
  for (let k = 0; k < v.visits.length; k++) {
    const q = v.visits[k];
    if (k === 0 && bay) fixH(legSamples(stand, q.approach, q.leave), 0);
    if (k > 0) {
      if (v.feeds) {                                  // a train comes back for the outbound load
        const g = q.approach[0];
        let t0 = q.leave, shift = 0;
        const mk = (t) => [{ t, x: N[g].x, y: N[g].y, node: g }, ...legSamples(stand, q.approach, t)];
        while (shift < MAX_SHIFT_S && clashes(stand, v, mk(t0 - shift), others)) shift += SHIFT_S;
        t0 -= shift; q.leave = t0; q.arrive = t0 + stand.pathLength(q.approach) / REPLAY_SPEED;
        at(t0, g, headingOf(stand, q.approach[0], q.approach[1]));
        fixH(legSamples(stand, q.approach, t0), 0);
      } else {
        at(q.leave, v.visits[k - 1].spot, tr[tr.length - 1].h);
        fixH(legSamples(stand, q.approach, q.leave, { revFirst: true }), 0);
      }
    }
    const next = v.visits[k + 1];
    if (next && !v.feeds) continue;                  // holds at the spot until it drives to the next one
    // the hold, then out to a gate (or, for the tug, the push back down the centreline first)
    if (push) {
      at(q.depart, q.spot, tr[tr.length - 1].h);
      const pr = [q.spot, 'r0'];
      fixH(legSamples(stand, pr, q.depart, { speed: stand.pathLength(pr) / TIMES.push }), 0);
      const exit = shortestOut(stand, 'r0');
      at(q.depart + TIMES.push + 5, 'r0', tr[tr.length - 1].h);
      fixH(legSamples(stand, exit, q.depart + TIMES.push + 5), 0);
      continue;
    }
    const forward = v.feeds;                         // trains drive on through to the lane; others back out
    const firstHop = forward ? stand.edges.find((e) => (e.a === q.spot || e.b === q.spot) && N[e.a === q.spot ? e.b : e.a].x === stand.lanes.laneX) : null;
    const hop = forward ? (firstHop.a === q.spot ? firstHop.b : firstHop.a) : null;
    const route = forward ? [q.spot, ...shortestOut(stand, hop, new Set([stand.edgeKey(q.spot, hop)]))] : [q.spot, ...shortestOut(stand, q.spot).slice(1)];
    let shift = 0;
    const mk = (t) => [{ t, x: N[q.spot].x, y: N[q.spot].y, node: q.spot }, ...legSamples(stand, route, t, { revFirst: !forward })];
    while (shift < MAX_SHIFT_S && clashes(stand, v, mk(q.depart + shift), others)) shift += SHIFT_S;
    q.depart += shift;
    at(q.depart, q.spot, tr[tr.length - 1].h);
    fixH(legSamples(stand, route, q.depart, { revFirst: !forward }), 0);
  }
  // heading at a hold is the heading it arrived with
  for (let k = 1; k < tr.length; k++) if (tr[k].node === tr[k - 1].node && Math.hypot(tr[k].x - tr[k - 1].x, tr[k].y - tr[k - 1].y) < 1e-9) tr[k].h = tr[k - 1].h;
  v.track = tr;
}

// the start nearest t0, earlier or later within [lo, hi], whose leg keeps clear of everything laid
function bestStart(stand, v, mk, others, t0, lo, hi) {
  for (let s = 0; s <= MAX_SHIFT_S * 2; s += SHIFT_S) {
    if (t0 - s >= lo && !clashes(stand, v, mk(t0 - s), others)) return t0 - s;
    if (s && t0 + s <= hi && !clashes(stand, v, mk(t0 + s), others)) return t0 + s;
  }
  return t0;
}

function shortestOut(stand, from, avoid = new Set()) {
  let best = null;
  for (const g of stand.gates) {
    const r = stand.path(from, g, { avoid, avoidKinds: true });
    if (r && (!best || stand.pathLength(r) < stand.pathLength(best))) best = r;
  }
  return best;
}
