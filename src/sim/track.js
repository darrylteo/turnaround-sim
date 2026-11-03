/* A track is a list of samples {t, x, y, h, node, rev?}. Between two samples a vehicle moves in a straight line at
   constant speed, or holds if they are at the same place. h is the heading while holding; when moving the heading
   is the direction of travel, turned half round for a segment driven in reverse (rev on the later sample). */

export function locate(track, t) {           // index of the last sample at or before t (-1 before the first)
  let lo = 0, hi = track.length - 1;
  if (!track.length || t < track[0].t) return -1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (track[m].t <= t) lo = m; else hi = m - 1; }
  return lo;
}

export function sampleTrack(track, t) {
  const i = locate(track, t);
  if (i < 0) { const a = track[0]; return { x: a.x, y: a.y, h: a.h, i: -1, moving: false }; }
  const a = track[i];
  if (i === track.length - 1) return { x: a.x, y: a.y, h: a.h, i, moving: false };
  const b = track[i + 1], dt = b.t - a.t, f = dt > 0 ? (t - a.t) / dt : 1;
  const dx = b.x - a.x, dy = b.y - a.y;
  if (Math.hypot(dx, dy) < 1e-9) return { x: a.x, y: a.y, h: a.h, i, moving: false };
  const h = Math.atan2(dy, dx) + (b.rev ? Math.PI : 0);
  return { x: a.x + f * dx, y: a.y + f * dy, h: Math.atan2(Math.sin(h), Math.cos(h)), i, moving: true };
}

// The first time at or after t0 that the track reaches node id, or null.
export function timeAtNode(track, id, t0) {
  for (let i = Math.max(0, locate(track, t0)); i < track.length; i++) if (track[i].node === id && track[i].t >= t0) return track[i].t;
  return null;
}
