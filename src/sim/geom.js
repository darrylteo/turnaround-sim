/* Plane geometry in local metres (x east, y north). Headings h are radians from east, counter-clockwise.
   Polygons are arrays of [x, y]. Ported from the earlier stand replay's drive.js. */

export const TAU = Math.PI * 2;
export const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));   // to (-pi, pi]

export function rect(x, y, h, L, W) {        // corners of an L x W box at (x, y), its length along h
  const c = Math.cos(h), s = Math.sin(h);
  return [[L / 2, W / 2], [L / 2, -W / 2], [-L / 2, -W / 2], [-L / 2, W / 2]].map(([a, b]) => [x + a * c - b * s, y + a * s + b * c]);
}

export function overlap(A, B) {               // separating axes, for convex polygons
  for (const P of [A, B]) for (let i = 0; i < P.length; i++) {
    const q = P[(i + 1) % P.length], nx = P[i][1] - q[1], ny = q[0] - P[i][0];
    let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
    for (const p of A) { const d = p[0] * nx + p[1] * ny; a0 = Math.min(a0, d); a1 = Math.max(a1, d); }
    for (const p of B) { const d = p[0] * nx + p[1] * ny; b0 = Math.min(b0, d); b1 = Math.max(b1, d); }
    if (a1 < b0 || b1 < a0) return false;
  }
  return true;
}

export function depth(A, B) {                 // how far convex polygons interpenetrate (the least push that parts them), 0 when apart
  let d = Infinity;
  for (const P of [A, B]) for (let i = 0; i < P.length; i++) {
    const q = P[(i + 1) % P.length], nx = P[i][1] - q[1], ny = q[0] - P[i][0], n = Math.hypot(nx, ny) || 1;
    let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
    for (const p of A) { const s = (p[0] * nx + p[1] * ny) / n; a0 = Math.min(a0, s); a1 = Math.max(a1, s); }
    for (const p of B) { const s = (p[0] * nx + p[1] * ny) / n; b0 = Math.min(b0, s); b1 = Math.max(b1, s); }
    d = Math.min(d, Math.min(a1, b1) - Math.max(a0, b0));
    if (d <= 0) return 0;
  }
  return d;
}

export const segDist = ([px, py], [x1, y1], [x2, y2]) => {
  const dx = x2 - x1, dy = y2 - y1, L = dx * dx + dy * dy || 1e-9, s = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / L));
  return Math.hypot(px - x1 - s * dx, py - y1 - s * dy);
};

export function gap(A, B) {                   // clear distance between convex polygons, 0 when they touch
  if (overlap(A, B)) return 0;
  let g = Infinity;
  for (const [P, Q] of [[A, B], [B, A]]) for (const p of P) for (let i = 0; i < Q.length; i++) g = Math.min(g, segDist(p, Q[i], Q[(i + 1) % Q.length]));
  return g;
}

export function inPoly([x, y], P) {
  let c = false;
  for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
    const [xi, yi] = P[i], [xj, yj] = P[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c;
  }
  return c;
}

export function polyDist(p, P) {             // distance from a point to a polygon's edge (0 inside counts as 0)
  if (inPoly(p, P)) return 0;
  let d = Infinity;
  for (let i = 0; i < P.length; i++) d = Math.min(d, segDist(p, P[i], P[(i + 1) % P.length]));
  return d;
}

export function dijkstra(n, nbrs, src, dst) { // nbrs(i) -> [[j, w]]; returns the node list or null
  const dist = new Float64Array(n).fill(Infinity), prev = new Int32Array(n).fill(-1), done = new Uint8Array(n);
  dist[src] = 0;
  for (;;) {
    let u = -1, best = Infinity;
    for (let i = 0; i < n; i++) if (!done[i] && dist[i] < best) { best = dist[i]; u = i; }
    if (u < 0 || u === dst) break;
    done[u] = 1;
    for (const [v, w] of nbrs(u)) if (dist[u] + w < dist[v]) { dist[v] = dist[u] + w; prev[v] = u; }
  }
  if (!isFinite(dist[dst])) return null;
  const path = [];
  for (let u = dst; u >= 0; u = prev[u]) path.unshift(u);
  return path;
}

// A small seeded generator (mulberry32), so a seed always gives the same run.
export function rng(seed) {
  let a = (seed >>> 0) || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
