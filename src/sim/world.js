/* The running world: the schedule played back, the player's tractor, and what happens between them. Replayed
   vehicles follow their tracks exactly until the player gets in the way. Then they wait, and after rerouteAfter
   seconds take a detour if the road graph has one. Each then rejoins its track and runs late by the time it lost.
   The delay counter sums that lateness at the service spots. Late vehicles push their tasks back, and the tasks
   push off-block back, as in the schedule. The loop restarts after the second turn. */
import { sampleTrack, timeAtNode } from './track.js';
import { REPLAY_SPEED, TIMES } from './generator.js';
import { createPlayer, stepPlayer, playerRect, LIMITS } from './player.js';
import { rect, gap } from './geom.js';
import { TYPES } from './fleet.js';

export const STOP_DISTANCE = 5.5;     // centre to centre, metres, assumed
const CLEAR = 1.5, NEAR_PLAYER = 4, RETRY_S = 3, SEP_EVENT_M = 0.3, LATE_EVENT_S = 60, MAX_STEP = 0.5;

export const onTimeScore = (lateMin) => Math.max(0, Math.round(100 - 5 * Math.max(0, lateMin)));

export function createWorld(schedule, { stand, player = null, rerouteAfter = 10 } = {}) {
  const S = schedule;
  const tasksOf = S.turns.map((turn) => {
    const byKey = Object.fromEntries(turn.tasks.map((t) => [t.key, t]));
    const order = [], seen = new Set();
    const visit = (t) => { if (seen.has(t.key)) return; seen.add(t.key); t.after.forEach((k) => visit(byKey[k])); order.push(t); };
    turn.tasks.filter((t) => t.id !== 'pushback').forEach(visit);
    return { byKey, order, push: turn.tasks.find((t) => t.id === 'pushback') };
  });
  const visitOf = {}, trainOf = {};
  for (const v of S.vehicles) {
    v.visits.forEach((q, k) => q.taskKeys.forEach((key) => (visitOf[key] = [v.id, k])));
    if (v.feeds) { trainOf[v.feeds[0]] = [v.id, 0, 30]; trainOf[v.feeds[1]] = [v.id, 1, 60]; }
  }

  const w = {
    t: 0, loop: 0, loopEnd: S.loopEnd, schedule: S, stand,
    vehicles: [], player: player ? createPlayer(player) : null,
    events: [], delay: { total: 0, arrivals: [] }, turns: [], aircraft: { phase: 'absent' }, bridge: 0,
  };
  let nEvent = 0;
  const emit = (type, vehicles, data = {}) => w.events.push({ id: `L${w.loop}-E${String(++nEvent).padStart(5, '0')}`, loop: w.loop, t: w.t, type, vehicles, data });

  function reset() {
    w.vehicles = S.vehicles.map((v) => ({
      id: v.id, type: v.type, turn: v.turn, src: v, x: v.track[0].x, y: v.track[0].y, h: v.track[0].h, v: 0,
      mode: 'replay', state: 'offstage', lag: 0, waitS: 0, retry: 0, edge: null, remaining: 0, route: [], rerouted: false,
      arrived: new Map(), departed: new Map(), detour: null,
    }));
    w.delay = { total: 0, arrivals: [] };
    w.turns = S.turns.map((t) => ({ index: t.index, onBlock: t.onBlock, offBlock: t.offBlock, targetOffBlock: t.targetOffBlock, lateMin: null, score: null, done: false }));
    sep.clear(); zone.speeding = zone.early = false;
    index = new Map(w.vehicles.map((v) => [v.id, v]));
    for (const v of w.vehicles) place(v, sampleTrack(v.src.track, w.t), w.t);
    retime(); poseAircraft();
  }
  const sep = new Set(), zone = { speeding: false, early: false };
  let index = new Map(), dirty = true;          // dirty: a lag changed, so task times need working out again
  const byId = (id) => index.get(id);

  // ---- task times from what has actually happened (identical to the schedule when nobody is late) ----
  const lagAt = (id, k) => { const v = byId(id); return v.arrived.has(k) ? v.arrived.get(k) : v.lag; };
  const departLag = (id, k) => { const v = byId(id); return v.departed.has(k) ? v.departed.get(k) : Math.max(v.lag, shiftOf(id, k)); };
  let actualEnd = {};
  function shiftOf(id, k) {                       // how much later than planned the tasks at this visit end
    const sv = byId(id).src, q = sv.visits[k];
    const keys = sv.feeds ? [sv.feeds[k]] : q.taskKeys;
    let s = 0;
    for (const key of keys) {
      const t = tasksOf[sv.turn].byKey[key];
      if (t && actualEnd[key] != null) s = Math.max(s, actualEnd[key] - t.end);
    }
    return s > 1e-6 ? s : 0;
  }
  function retime() {
    dirty = false;
    actualEnd = {};
    S.turns.forEach((turn, i) => {
      const T = tasksOf[i], st = w.turns[i];
      for (const t of T.order) {
        let s = t.release;
        for (const p of t.after) s = Math.max(s, actualEnd[p]);
        if (visitOf[t.key]) { const [id, k] = visitOf[t.key]; s = Math.max(s, byId(id).src.visits[k].ready + lagAt(id, k)); }
        if (trainOf[t.key]) { const [id, k, wait] = trainOf[t.key]; s = Math.max(s, byId(id).src.visits[k].arrive + lagAt(id, k) + wait); }
        actualEnd[t.key] = s + (t.end - t.start);
      }
      if (st.done) return;
      if (!T.push) { st.offBlock = Math.max(...T.order.map((t) => actualEnd[t.key])); return; }
      let s = T.push.release;
      for (const p of T.push.after) s = Math.max(s, actualEnd[p]);
      for (const v of w.vehicles) {
        if (v.turn !== i) continue;
        if (v.type === 'TOW') s = Math.max(s, v.src.visits[0].ready + lagAt(v.id, 0));
        else v.src.visits.forEach((q, k) => { s = Math.max(s, q.depart + departLag(v.id, k)); });
      }
      actualEnd[T.push.key] = s;
      st.offBlock = s;
    });
  }

  // ---- placing a replayed vehicle at track time tau ----
  function place(v, p, tau) {
    const tr = v.src.track;
    const atGate = !p.moving && p.i >= 0 && stand.nodes[tr[p.i].node]?.kind === 'gate';   // off the map between trips
    const off = tau < tr[0].t || tau > tr[tr.length - 1].t || atGate;
    v.v = 0;
    v.x = p.x; v.y = p.y; v.h = p.h;
    v.state = off ? 'offstage' : p.moving ? 'moving' : 'parked';
    if (p.moving && p.i >= 0) {
      const a = tr[p.i], b = tr[p.i + 1];
      v.edge = { a: a.node, b: b.node }; v.remaining = Math.hypot(b.x - p.x, b.y - p.y);
    } else { v.edge = null; v.remaining = 0; }
    const rest = [];
    for (let k = Math.max(0, p.i + 1); k < tr.length; k++) if (rest[rest.length - 1] !== tr[k].node) rest.push(tr[k].node);
    v.route = rest;
  }
  const rectOf = (v, x = v.x, y = v.y, h = v.h) => rect(x, y, h, TYPES[v.type].L, TYPES[v.type].W);

  // would moving from cur to next bring v too close to the player?
  function blocked(v, cur, next) {
    const P = w.player;
    if (!P || v.state === 'offstage') return false;
    const moved = Math.hypot(next.x - cur.x, next.y - cur.y);
    if (moved < 1e-9) return false;
    const d0 = Math.hypot(cur.x - P.x, cur.y - P.y), d1 = Math.hypot(next.x - P.x, next.y - P.y);
    if (d1 >= d0 || d1 > 20) return false;
    return d1 < STOP_DISTANCE || gap(rectOf(v, next.x, next.y, next.h), playerRect(P)) < CLEAR;
  }

  // ---- a detour round the player, back to the first node of the track beyond the block ----
  function planDetour(v) {
    if (!v.edge || !w.player) return null;
    const P = w.player, avoid = new Set(stand.edgesNear(P.x, P.y, NEAR_PLAYER));
    avoid.add(stand.edgeKey(v.edge.a, v.edge.b));
    const seq = v.route;
    let R = null;
    for (let j = 0; j < seq.length; j++) {
      const n = stand.nodes[seq[j]];
      if (Math.hypot(n.x - P.x, n.y - P.y) < NEAR_PLAYER + 2) continue;
      if (j + 1 < seq.length && avoid.has(stand.edgeKey(seq[j], seq[j + 1]))) continue;
      R = seq[j]; break;
    }
    if (!R) return null;
    const route = stand.path(v.edge.a, R, { avoid, avoidKinds: true });
    if (!route) return null;
    const pts = [{ x: v.x, y: v.y, node: null }, ...route.map((id) => ({ x: stand.nodes[id].x, y: stand.nodes[id].y, node: id }))];
    return { pts, i: 1, R, tauFrom: w.t - v.lag };
  }

  function stepVehicle(v, dt) {
    const tr = v.src.track, x0 = v.x, y0 = v.y;
    if (v.mode === 'detour') {
      const d = v.detour;
      let left = REPLAY_SPEED * dt, x = v.x, y = v.y, h = v.h;
      while (left > 1e-9 && d.i < d.pts.length) {
        const q = d.pts[d.i], dd = Math.hypot(q.x - x, q.y - y);
        if (dd < 1e-9) { d.i++; continue; }
        const m = Math.min(left, dd), nh = Math.atan2(q.y - y, q.x - x);
        const nx = x + (q.x - x) / dd * m, ny = y + (q.y - y) / dd * m;
        if (blocked(v, { x, y }, { x: nx, y: ny, h: nh })) { v.waitS += dt; break; }
        x = nx; y = ny; h = nh; left -= m; v.waitS = 0;
        if (m === dd) d.i++;
      }
      Object.assign(v, { x, y, h, state: 'moving' });   // lag is settled on rejoining
      v.edge = d.i < d.pts.length ? { a: d.pts[d.i - 1].node, b: d.pts[d.i].node } : null;
      v.remaining = d.i < d.pts.length ? Math.hypot(d.pts[d.i].x - x, d.pts[d.i].y - y) : 0;
      v.route = d.pts.slice(d.i).map((p) => p.node);
      if (d.i >= d.pts.length) {                      // back on the track where it reaches R
        const tauR = timeAtNode(tr, d.R, d.tauFrom);
        v.mode = 'replay'; v.detour = null; v.rerouted = false;
        v.lag = Math.max(v.lag, (w.t + dt) - tauR); dirty = true;
      }
      v.v = Math.hypot(v.x - x0, v.y - y0) / dt;
      return;
    }
    const tauNow = w.t - v.lag, tauNext = w.t + dt - v.lag;
    const cur = sampleTrack(tr, tauNow), next = sampleTrack(tr, tauNext);
    const towPush = v.type === 'TOW' && v.edge && stand.edges.some((e) => e.restricted && ((e.a === v.edge.a && e.b === v.edge.b) || (e.a === v.edge.b && e.b === v.edge.a)));
    if (!towPush && blocked(v, cur, next)) {
      if (v.mode !== 'wait') { v.mode = 'wait'; v.waitS = 0; v.retry = 0; emit('blocked', [v.id, 'player']); }
      v.lag += dt; v.waitS += dt; dirty = true;
      place(v, cur, tauNow); v.state = 'waiting';
      if (v.waitS >= rerouteAfter && (v.retry -= dt) <= 0) {
        v.retry = RETRY_S;
        const d = planDetour(v);
        if (d) {
          v.mode = 'detour'; v.detour = d; v.rerouted = true; v.route = d.pts.slice(1).map((p) => p.node);
          emit('reroute', [v.id], { to: d.R });
        }
      }
      return;
    }
    if (v.mode === 'wait') { v.mode = 'replay'; v.waitS = 0; }
    // service spots: arrivals, and holding on while late tasks finish
    const q = v.src.visits;
    for (let k = 0; k < q.length; k++) {
      if (!v.arrived.has(k) && tauNext >= q[k].arrive) {
        v.arrived.set(k, v.lag); if (v.lag) dirty = true;
        const actual = q[k].arrive + v.lag, late = v.lag;
        w.delay.arrivals.push({ vehicle: v.id, visit: k, spot: q[k].spot, planned: q[k].arrive, actual, late });
        w.delay.total += late;
        if (actual - q[k].planned > LATE_EVENT_S) emit('late_arrival', [v.id], { spot: q[k].name, late: actual - q[k].planned });
      }
      if (v.arrived.has(k) && !v.departed.has(k)) {
        const want = shiftOf(v.id, k), room = w.t + dt - q[k].arrive;
        if (want > v.lag && tauNext <= q[k].depart) { v.lag = Math.min(want, room); dirty = true; }
        if (w.t + dt - v.lag >= q[k].depart) { v.departed.set(k, v.lag); if (v.lag) dirty = true; }
      }
    }
    const p = sampleTrack(tr, w.t + dt - v.lag);
    place(v, p, w.t + dt - v.lag);
    v.v = Math.hypot(v.x - x0, v.y - y0) / dt;
  }

  // ---- aircraft and bridge, from the turns' actual times ----
  function poseAircraft() {
    w.aircraft = { phase: 'absent' };
    w.bridge = 0;
    for (let i = 0; i < S.turns.length; i++) {
      const plan = S.turns[i], st = w.turns[i], t = w.t, off = st.offBlock;
      const a = plan.onBlock - TIMES.taxiIn;
      if (t < a || t >= off + TIMES.push + TIMES.taxiOut) continue;
      let phase, nx = 0, ny = 0, h = Math.PI / 2;
      if (t < plan.onBlock) { const f = (t - a) / TIMES.taxiIn; phase = 'taxi_in'; ny = -70 * (1 - f) ** 2; }
      else if (t < off) phase = 'on_blocks';
      else if (t < off + TIMES.push) { phase = 'pushback'; ny = -53.5 * (t - off) / TIMES.push; }
      else {
        const f = (t - off - TIMES.push) / TIMES.taxiOut, turnF = Math.min(1, f / 0.4);
        phase = 'taxi_out'; h = Math.PI / 2 + turnF * Math.PI / 2;
        const R = 20, ang = turnF * Math.PI / 2;
        nx = -R * (1 - Math.cos(ang)); ny = -53.5 - R * Math.sin(ang);
        if (f > 0.4) nx -= (f - 0.4) / 0.6 * 120;
      }
      w.aircraft = { phase, turn: i, nx, ny, h };
      const T = tasksOf[i].byKey, dock = T[`${i}:pbb_dock`], undock = T[`${i}:pbb_remove`];
      if (dock && undock) {
        const d0 = actualEnd[dock.key] - (dock.end - dock.start), d1 = actualEnd[dock.key];
        const u0 = actualEnd[undock.key] - (undock.end - undock.start), u1 = actualEnd[undock.key];
        w.bridge = Math.max(0, Math.min(1, (t - d0) / (d1 - d0), (u1 - t) / (u1 - u0)));
      }
      break;
    }
  }
  const aircraftSolids = () => (w.aircraft.phase === 'absent' ? [] : stand.aircraftParts(w.aircraft.nx, w.aircraft.ny, w.aircraft.h));
  w.solids = () => [
    ...aircraftSolids(), ...stand.fixedObstacles, { id: 'bridge-wheels', poly: stand.bogie(w.bridge).poly },
    ...w.vehicles.filter((v) => v.state !== 'offstage').map((v) => ({ id: v.id, poly: rectOf(v) })),
  ];

  function detect() {
    const live = w.vehicles.filter((v) => v.state !== 'offstage');
    const all = w.player ? [...live, { id: 'player', type: 'PLAYER', x: w.player.x, y: w.player.y, h: w.player.h, v: Math.abs(w.player.v) }] : live;
    const now = new Set();
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
      const a = all[i], b = all[j];
      if (Math.abs(a.x - b.x) > 12 || Math.abs(a.y - b.y) > 12 || (a.v < 0.5 && b.v < 0.5)) continue;
      if (gap(rectOf(a), rectOf(b)) >= SEP_EVENT_M) continue;
      const key = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
      now.add(key);
      if (!sep.has(key)) emit('separation', [a.id, b.id]);
    }
    sep.clear(); now.forEach((k) => sep.add(k));
    const P = w.player;
    if (!P) return;
    const inside = stand.inSafetyArea(P.x, P.y), present = w.aircraft.phase !== 'absent';
    const fast = inside && present && Math.abs(P.v) > LIMITS.zoneSpeed;
    if (fast && !zone.speeding) emit('zone_speeding', ['player'], { kmh: Math.abs(P.v) * 3.6 });
    zone.speeding = fast;
    const early = inside && w.aircraft.phase === 'taxi_in';
    if (early && !zone.early) emit('zone_before_chocks', ['player']);
    zone.early = early;
  }

  function substep(dt, input) {
    if (w.player) stepPlayer(w.player, input, dt, { stand, obstacles: w.solids().filter((o) => !o.id.startsWith('aircraft')), aircraft: aircraftSolids() });
    for (const v of w.vehicles) stepVehicle(v, dt);
    w.t += dt;
    if (dirty) retime();
    for (let i = 0; i < w.turns.length; i++) {
      const st = w.turns[i];
      if (!st.done && w.t >= st.offBlock) {
        st.done = true; st.lateMin = (st.offBlock - st.targetOffBlock) / 60; st.score = onTimeScore(st.lateMin);
      }
    }
    poseAircraft();
    detect();
    if (w.t >= w.loopEnd) { w.t -= w.loopEnd; w.loop += 1; reset(); }
  }

  w.step = (dt, input) => {
    for (let left = dt; left > 1e-12; left -= MAX_STEP) substep(Math.min(MAX_STEP, left), input);
    return w;
  };
  w.setPlayer = (pose) => { w.player = pose ? createPlayer(pose) : null; };
  w.score = () => { const d = w.turns.filter((t) => t.done); return d.length ? d.reduce((s, t) => s + t.score, 0) / d.length : null; };
  reset();
  return w;
}
