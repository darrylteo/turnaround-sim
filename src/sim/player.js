/* The player's baggage tractor: throttle, brake and steering against assumed caps, stopped by anything solid.
   Ported from the earlier stand replay's drive.js. Input: throttle -1..1 (negative brakes, then reverses once
   stopped), steer -1..1 (positive turns right). Below a walking pace, steering turns slowly on the spot. */
import { rect, depth, wrap } from './geom.js';
import { TYPES } from './fleet.js';

const WHEELBASE = 2.6, MAX_STEER = 35 * Math.PI / 180;
export const LIMITS = {
  maxSpeed: 25 / 3.6, maxReverse: 6 / 3.6,              // m/s, one cap everywhere (assumed)
  accel: 25 / 3.6 / 5, brake: 25 / 3.6 / 2.5, drag: 0.4, // m/s2
  minTurnRadius: WHEELBASE / Math.tan(MAX_STEER), pivotBelow: 0.3, pivotRate: 20 * Math.PI / 180,
  length: TYPES.PLAYER.L, width: TYPES.PLAYER.W, halfWidth: TYPES.PLAYER.W / 2,
  zoneSpeed: 5 / 3.6,                                   // flagged above this inside the aircraft safety area
};

const num = (v, lo, hi) => (Number.isFinite(+v) ? Math.max(lo, Math.min(hi, +v)) : 0);

export function createPlayer({ x, y, h = 0 }) {
  return { id: 'player', type: 'PLAYER', x, y, h, v: 0, hit: null };
}

export const playerRect = (p, x = p.x, y = p.y, h = p.h) => rect(x, y, h, LIMITS.length, LIMITS.width);

// env: { stand, obstacles: [{id, poly}], aircraft: polys from stand.aircraftParts() | true | false }
export function stepPlayer(p, input, dt, env = {}) {
  const throttle = num(input?.throttle, -1, 1), steer = num(input?.steer, -1, 1);
  if (!(dt > 0)) return p;
  const L = LIMITS, v = p.v;
  let nv;
  if (throttle > 0) nv = v < 0 ? Math.min(0, v + L.brake * throttle * dt) : Math.min(L.maxSpeed, v + L.accel * throttle * dt);
  else if (throttle < 0) nv = v > 0 ? Math.max(0, v + L.brake * throttle * dt) : Math.max(-L.maxReverse, v + L.accel * throttle * dt);
  else nv = v > 0 ? Math.max(0, v - L.drag * dt) : Math.min(0, v + L.drag * dt);
  const yaw = Math.abs(nv) < L.pivotBelow ? -steer * L.pivotRate * dt
    : -nv / WHEELBASE * Math.tan(steer * MAX_STEER) * dt;
  const h = wrap(p.h + yaw);
  // move along the arc's mean heading, so the path does not depend on the frame rate
  const hm = p.h + yaw / 2, x = p.x + Math.cos(hm) * nv * dt, y = p.y + Math.sin(hm) * nv * dt;
  const b = env.stand?.bounds;
  if (b && (x < b.xmin || x > b.xmax || y < b.ymin || y > b.ymax)) { p.v = 0; p.hit = 'edge'; return p; }
  // a move may not push the tractor deeper into anything; one that eases an overlap is allowed
  const air = env.aircraft === true ? env.stand.aircraftParts() : env.aircraft || [];
  const solids = [...air, ...(env.obstacles || [])];
  const R0 = playerRect(p), R = playerRect(p, x, y, h);
  const hit = solids.find((o) => { const d = depth(R, o.poly); return d > 0 && d > depth(R0, o.poly) + 1e-9; });
  if (hit) { p.v = 0; p.hit = hit.id; return p; }
  Object.assign(p, { x, y, h, v: nv, hit: null });
  return p;
}
