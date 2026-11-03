/* Walking on foot, ported from the earlier stand replay: WASD walks, Q and E turn, Shift runs, Space jumps, with a
   head bob, a landing dip, and a push out of anything solid. Walking blocks only the walker; the replay runs on.
   Input: { forward, back, left, right, turnLeft, turnRight, run, jump } booleans. h is radians from east. */
import { inPoly } from './geom.js';

export const WALK = { walk: 3.2, run: 9, eye: 1.7, radius: 0.35, jumpV: 5.2, gravity: 15, turnRate: 50 * Math.PI / 180 };

export function createWalker({ x, y, h = 0 }) {
  return { x, y, h, p: 0, z: 0, vz: 0, land: 0, bob: 0, bobK: 0, speed: 0, run: false };
}

// env: { stand, solids: [poly] }
export function stepWalker(w, input = {}, dt, env = {}) {
  const K = input || {};
  if (K.turnLeft) w.h += WALK.turnRate * dt;
  if (K.turnRight) w.h -= WALK.turnRate * dt;
  const f = [Math.cos(w.h), Math.sin(w.h)], r = [Math.sin(w.h), -Math.cos(w.h)];
  let mx = 0, my = 0;
  if (K.forward) { mx += f[0]; my += f[1]; } if (K.back) { mx -= f[0]; my -= f[1]; }
  if (K.right) { mx += r[0]; my += r[1]; } if (K.left) { mx -= r[0]; my -= r[1]; }
  const n = Math.hypot(mx, my), v = K.run ? WALK.run : WALK.walk;
  w.run = !!K.run;
  w.speed = n ? v : 0;
  if (n) { w.x += mx / n * v * dt; w.y += my / n * v * dt; }
  const b = env.stand?.bounds;
  if (b) { w.x = Math.max(b.xmin + 1, Math.min(b.xmax - 1, w.x)); w.y = Math.max(b.ymin + 1, Math.min(b.ymax - 1, w.y)); }
  pushOut(w, env.solids || []);
  // head bob: a dip on every step and a sideways sway every stride, stronger when running; then the jump and landing
  w.bobK += ((n && !w.z ? 1 : 0) - w.bobK) * Math.min(1, dt * 8);
  if (n) w.bob += dt * (K.run ? 12.5 : 8.5);
  if (K.jump && !w.jumpHeld && w.z === 0 && w.vz === 0) w.vz = WALK.jumpV;   // one jump per press
  w.jumpHeld = !!K.jump;
  if (w.z > 0 || w.vz > 0) {
    w.z += w.vz * dt - WALK.gravity * dt * dt / 2; w.vz -= WALK.gravity * dt;   // exact under constant gravity
    if (w.z <= 0) { w.z = 0; w.vz = 0; w.land = 0.14; }
  } else w.land = Math.max(0, w.land - dt * 0.9);
  return w;
}

export function pushOut(w, solids) {          // step out of anything solid
  for (let it = 0; it < 3; it++) for (const Q of solids) {
    let best = Infinity, qx = 0, qy = 0;
    for (let i = 0; i < Q.length; i++) {
      const [x1, y1] = Q[i], [x2, y2] = Q[(i + 1) % Q.length], dx = x2 - x1, dy = y2 - y1;
      const t = Math.max(0, Math.min(1, ((w.x - x1) * dx + (w.y - y1) * dy) / (dx * dx + dy * dy || 1e-9)));
      const px = x1 + t * dx, py = y1 + t * dy, dd = Math.hypot(w.x - px, w.y - py);
      if (dd < best) { best = dd; qx = px; qy = py; }
    }
    const inside = inPoly([w.x, w.y], Q);
    if (!inside && best >= WALK.radius) continue;
    let ux = inside ? qx - w.x : w.x - qx, uy = inside ? qy - w.y : w.y - qy;
    if (best < 1e-6) {                               // right on the edge: push away from the middle
      const cx = Q.reduce((s, p) => s + p[0], 0) / Q.length, cy = Q.reduce((s, p) => s + p[1], 0) / Q.length;
      ux = qx - cx; uy = qy - cy;
    }
    const un = Math.hypot(ux, uy) || 1; ux /= un; uy /= un;
    w.x = qx + ux * WALK.radius; w.y = qy + uy * WALK.radius;
  }
}
