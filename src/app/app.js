/* Turnaround sim in Cesium: two synthetic A320 turnarounds at a fictional stand, then a loop.
   The viewer set-up, model tinting and rings, labels, mini-map, timeline, camera modes and walking are ported from
   the earlier stand replay. The schedule, world and marker are src/sim/ (headless, tested by evals/).
   Local metres: x east, y north, the nose stop at (0, 0). Headings in src/sim are radians from east. */
import { createStand } from '../sim/stand.js';
import { generate } from '../sim/generator.js';
import { createWorld, STOP_DISTANCE } from '../sim/world.js';
import { LIMITS } from '../sim/player.js';
import { createWalker, stepWalker, WALK } from '../sim/walker.js';
import { createMarker, importMarks } from '../sim/marker.js';
import { TYPES, DOLLY } from '../sim/fleet.js';

const C = window.Cesium;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const params = new URLSearchParams(location.search);
const SEED = +params.get('seed') || 7;
const BASE_S = 6 * 3600 + 40 * 60;                 // the loop starts at 06:40 on a fictional morning
const hms = (s) => { s = Math.max(0, Math.floor(BASE_S + s)) % 86400; return [s / 3600 | 0, (s % 3600) / 60 | 0, s % 60].map((n) => String(n).padStart(2, '0')).join(':'); };
const mmss = (s) => `${s < 0 ? '-' : ''}${Math.floor(Math.abs(s) / 60)}:${String(Math.floor(Math.abs(s) % 60)).padStart(2, '0')}`;

const QUALITY = (() => {   // integrated GPUs get hard, shorter shadows and no MSAA; ?quality=high or low overrides
  const q = params.get('quality');
  if (q === 'high' || q === 'low') return q;
  try {
    const g = document.createElement('canvas').getContext('webgl2'), x = g && g.getExtension('WEBGL_debug_renderer_info');
    return x && /intel|uhd|iris|basic render|swiftshader|llvmpipe/i.test(g.getParameter(x.UNMASKED_RENDERER_WEBGL)) ? 'low' : 'high';
  } catch { return 'high'; }
})();

const SIM = (window.SIM = { ready: false });
const SPAWN = { x: -46, y: 8, h: 0 };

/* ---------- viewer (no imagery, no terrain, no tokens) ---------- */
const viewer = new C.Viewer('scene', {
  baseLayer: false, animation: false, timeline: false, baseLayerPicker: false, geocoder: false, homeButton: false,
  sceneModePicker: false, navigationHelpButton: false, fullscreenButton: false, infoBox: false, selectionIndicator: false,
  shadows: true, msaaSamples: QUALITY === 'high' ? 4 : 1, contextOptions: { webgl: { alpha: true } },
});
const scene = viewer.scene, cam = viewer.camera;
viewer.cesiumWidget.creditContainer.style.display = 'none';
scene.skyBox.show = false; scene.sun.show = false; scene.moon.show = false; scene.skyAtmosphere.show = false;
scene.globe.showGroundAtmosphere = false; scene.fog.enabled = false; scene.globe.baseColor = C.Color.fromCssColorString('#1a1f25');
scene.backgroundColor = C.Color.TRANSPARENT; scene.globe.enableLighting = false; scene.globe.depthTestAgainstTerrain = false;
viewer.clock.currentTime = C.JulianDate.fromIso8601('2026-06-21T09:30:00Z'); viewer.clock.shouldAnimate = false;
viewer.shadowMap.softShadows = QUALITY === 'high'; viewer.shadowMap.size = QUALITY === 'high' ? 2048 : 1024;
viewer.shadowMap.darkness = 0.45; viewer.shadowMap.maximumDistance = QUALITY === 'high' ? 500 : 250;
const ssc = scene.screenSpaceCameraController;
ssc.minimumZoomDistance = 2; ssc.maximumZoomDistance = 1600;
// a fictional spot on the ellipsoid: nothing real is drawn under it
const M = C.Transforms.eastNorthUpToFixedFrame(C.Cartesian3.fromDegrees(0.5, 0.5, 0));
const Minv = C.Matrix4.inverseTransformation(M, new C.Matrix4());
const P = (x, y, z = 0) => C.Matrix4.multiplyByPoint(M, new C.Cartesian3(x, y, z), new C.Cartesian3());
const bearingOf = (h) => Math.PI / 2 - h;          // math heading to Cesium's clockwise-from-north heading

/* local frame placement: axes X, Y, Z (unit vectors in east-north-up) scaled by s, at position p */
const scratch = new C.Matrix4();
function frame(out, p, X, Y, Z, s = [1, 1, 1]) {
  const m = C.Matrix4.fromArray([X[0] * s[0], X[1] * s[0], X[2] * s[0], 0, Y[0] * s[1], Y[1] * s[1], Y[2] * s[1], 0, Z[0] * s[2], Z[1] * s[2], Z[2] * s[2], 0, p[0], p[1], p[2], 1], 0, scratch);
  return C.Matrix4.multiply(M, m, out);
}
const UP = [0, 0, 1];
const flat = (h) => [[Math.cos(h), Math.sin(h), 0], [-Math.sin(h), Math.cos(h), 0], UP];   // X forward, Y left, Z up

/* ---------- solids: unit boxes and cylinders, coloured per instance ---------- */
function solid(geometry, css, { shadows = true, translucent = false } = {}) {
  const col = C.Color.fromCssColorString(css);
  return scene.primitives.add(new C.Primitive({
    asynchronous: false, shadows: shadows ? C.ShadowMode.ENABLED : C.ShadowMode.DISABLED,
    geometryInstances: new C.GeometryInstance({ geometry, attributes: { color: C.ColorGeometryInstanceAttribute.fromColor(col) } }),
    appearance: new C.PerInstanceColorAppearance({ closed: true, translucent: translucent || col.alpha < 1 }),
  }));
}
const VF = C.PerInstanceColorAppearance.VERTEX_FORMAT;
const unitBox = (css, o) => solid(C.BoxGeometry.fromDimensions({ dimensions: new C.Cartesian3(1, 1, 1), vertexFormat: VF }), css, o);
const unitCyl = (css, top = 0.5, o) => solid(new C.CylinderGeometry({ length: 1, topRadius: top, bottomRadius: 0.5, slices: 28, vertexFormat: VF }), css, o);
function box(prim, x, y, z0, h, L, W, H) {          // standing at height z0 on (x, y), its length along h
  const [X, Y, Z] = flat(h);
  prim.modelMatrix = frame(new C.Matrix4(), [x, y, z0 + H / 2], X, Y, Z, [L, W, H]);
}
const groundBox = (css, x, y, h, L, W, z = 0.01, H = 0.02) => { const b = unitBox(css, { shadows: false }); box(b, x, y, z, h, L, W, H); return b; };
const segBox = (css, a, b, W, z = 0.02) => groundBox(css, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2, Math.atan2(b[1] - a[1], b[0] - a[0]), Math.hypot(b[0] - a[0], b[1] - a[1]), W, z);

let stand, schedule, world, marker, table;
const states = () => world.vehicles;

/* ---------- the stand: apron, roads, markings, terminal ---------- */
function buildStand() {
  groundBox('#4a4f55', 0, -40, 0, 240, 150, 0.0, 0.01);                 // apron concrete
  for (const e of stand.edges) {                                         // service roads and stand spurs
    const a = stand.nodes[e.a], b = stand.nodes[e.b];
    if (e.restricted) continue;
    const road = a.kind === 'road' && b.kind === 'road' || a.kind === 'gate' || b.kind === 'gate';
    segBox(road ? '#2f3439' : '#3c4147', [a.x, a.y], [b.x, b.y], road ? 4.2 : 2.6, road ? 0.015 : 0.013);
  }
  const L = stand.lanes;
  for (const y of [L.headY - 2.2, L.headY + 2.2]) segBox('#d9dde2', [-L.gateX, y], [L.gateX, y], 0.15, 0.02);   // road edge lines
  segBox('#f2c200', [0, -110], [0, 0], 0.25, 0.022);                     // lead-in line
  segBox('#f2c200', [-2.5, 0], [2.5, 0], 0.4, 0.022);                    // stop bar
  const sa = stand.safetyArea;
  sa.forEach((p, i) => segBox('#e0453a', p, sa[(i + 1) % sa.length], 0.3, 0.024));   // stand safety line
  for (const id of Object.values(stand.bays)) {                          // staging bays
    const n = stand.nodes[id], [X] = flat(n.h);
    const fw = 9, ww = 3.2, cx = n.x, cy = n.y;
    for (const [dx, dy, len, h] of [[0, ww / 2, fw, n.h], [0, -ww / 2, fw, n.h]]) groundBox('#d9dde2', cx + -Math.sin(h) * dy, cy + Math.cos(h) * dy, h, len, 0.12, 0.023);
  }
  const term = unitBox('#5d6b78'); box(term, 0, 40, 0, 0, 220, 28, 14);   // terminal building
  const glass = unitBox('#7fa6c8', { shadows: false }); box(glass, 0, 26.05, 4, 0, 220, 0.2, 8);
}

/* ---------- the aircraft: the A320 model (GPLv2, credited in the README), scaled to the manual's length ---------- */
const AC = { model: null };
const AC_GLB = { uri: 'models/a320.glb', noseZ: 22.44, tailZ: -15.83, wheelY: -0.78 };   // the model's own extents (glTF metres)
async function buildAircraft() {
  AC.model = await loadModel(AC_GLB.uri, { show: false });
  AC.scale = table.dimensions.length_m / (AC_GLB.noseZ - AC_GLB.tailZ);
}
function placeAircraft(a) {
  if (!AC.model) return;
  AC.model.show = a.phase !== 'absent';
  if (!AC.model.show) return;
  const s = AC.scale, back = AC_GLB.noseZ * s;     // the model's origin sits this far behind the nose
  const [X, Y, Z] = flat(a.h);
  AC.model.modelMatrix = frame(new C.Matrix4(), [a.nx - X[0] * back, a.ny - X[1] * back, -AC_GLB.wheelY * s], X, Y, Z, [s, s, s]);
}

/* ---------- jet bridge (illustrative), as in the earlier replay: rotunda, two telescoping tunnels, cab, bogie ---------- */
const BR = { };
const ROT_R = 3, CAB = [3.5, 4.4, 3.2], TUBE = 3.2;
function buildBridge() {
  const b = stand.bridge, F = b.floor;
  const link = unitBox('#8a949f'); box(link, b.rotunda[0], (b.rotunda[1] + b.terminalY) / 2, F - 0.3, Math.PI / 2, b.terminalY - b.rotunda[1], 3.6, 3.4);
  const col = unitCyl('#5a6470'); col.modelMatrix = frame(new C.Matrix4(), [b.rotunda[0], b.rotunda[1], (F - 0.3) / 2], [1, 0, 0], [0, 1, 0], UP, [1.6, 1.6, F - 0.3]);
  const rot = unitCyl('#6d7885'); rot.modelMatrix = frame(new C.Matrix4(), [b.rotunda[0], b.rotunda[1], F - 0.4 + 1.9], [1, 0, 0], [0, 1, 0], UP, [ROT_R * 2, ROT_R * 2, 3.8]);
  Object.assign(BR, { inner: unitBox('#9aa4b0'), outer: unitBox('#aab4c0'), cab: unitBox('#c8d0da'), leg: unitBox('#4d5762'), wheels: unitBox('#2c3036') });
  const park = Math.hypot(b.parked[0] - b.rotunda[0], b.parked[1] - b.rotunda[1]) - ROT_R - CAB[0] / 2;
  BR.sect = 0.66 * park;
}
function placeBridge(f) {
  const b = stand.bridge, F = b.floor, [rx, ry] = b.rotunda, q = stand.bogie(f);
  const [cx, cy] = q.cab, sill = 3.4, floor = F + (sill - F) * f;
  const L = Math.hypot(cx - rx, cy - ry), ux = (cx - rx) / L, uy = (cy - ry) / L, h = Math.atan2(uy, ux);
  const face = h + (0 - h) * f;                    // turns to face the door (east) as it docks
  const span = L - ROT_R - CAB[0] / 2, sect = Math.max(BR.sect, span / 2 + 0.5);
  box(BR.inner, rx + ux * (ROT_R + sect / 2), ry + uy * (ROT_R + sect / 2), F - 0.2, h, sect, TUBE, TUBE);
  box(BR.outer, cx - ux * (CAB[0] / 2 + sect / 2), cy - uy * (CAB[0] / 2 + sect / 2), (F + floor) / 2 - 0.35, h, sect, TUBE + 0.3, TUBE + 0.3);
  box(BR.cab, cx, cy, floor - 0.3, face, CAB[0], CAB[1], CAB[2]);
  box(BR.leg, q.x, q.y, 0.9, h, 0.9, 0.9, floor - 1.2);
  box(BR.wheels, q.x, q.y, 0, h + Math.PI / 2, 1.4, 3.4, 0.9);
}

/* ---------- vehicle models: a pool per model, reused as vehicles come and go ---------- */
const slots = new Map(), pools = {}, loaded = {}, fallback = {};
const modelUri = (m) => `models/${m}.glb`;
const MODEL_YAW = { tractor: Math.PI };           // the tractor model's nose is the other way round
async function loadModel(uri, opts) {
  try { return scene.primitives.add(await C.Model.fromGltfAsync({ url: uri, minimumPixelSize: 0, shadows: C.ShadowMode.ENABLED, ...opts })); }
  catch { return null; }
}
async function makeSlot(type) {
  const T = TYPES[type], col = C.Color.fromCssColorString(T.color);
  const slot = { type, unit: null, col, dollies: [] };
  slot.model = await loadModel(modelUri(T.model), { colorBlendMode: C.ColorBlendMode.MIX, colorBlendAmount: 0.35, color: col, show: false });
  if (!slot.model) { slot.model = unitBox(T.color); slot.box = true; slot.model.show = false; }
  slot.ring = await loadModel(modelUri('ring'), { shadows: C.ShadowMode.DISABLED, colorBlendMode: C.ColorBlendMode.MIX, colorBlendAmount: 1, color: col, show: false });
  for (let k = 0; k < (T.dollies || 0); k++) slot.dollies.push(await loadModel(modelUri(DOLLY.model), { colorBlendMode: C.ColorBlendMode.MIX, colorBlendAmount: 0.25, color: C.Color.fromCssColorString('#9aa3ad'), show: false }));
  slot.model._slot = slot;
  (pools[type] = pools[type] || []).push(slot);
  return slot;
}
function grow(type) {
  const p = (pools[type] = pools[type] || []);
  if (p._growing) return;
  p._growing = true;
  makeSlot(type).then(() => { p._growing = false; });
}
const trails = new Map();                          // id -> breadcrumbs for a train's dollies
function placeSlot(slot, v, hit, halo) {
  const T = TYPES[slot.type], s = T.scale || 1;
  const [X, Y, Z] = flat(v.h + (MODEL_YAW[T.model] || 0));
  if (slot.box) box(slot.model, v.x, v.y, 0.02, v.h, T.L, T.W, T.H);
  else {
    slot.model.modelMatrix = frame(new C.Matrix4(), [v.x, v.y, 0.02], X, Y, Z, [s, s, s]);
    slot.model.color = hit ? C.Color.fromCssColorString('#ff453a') : slot.col;
    slot.model.colorBlendAmount = hit ? 0.7 : 0.35;
  }
  slot.model.show = true;
  if (slot.ring) {
    const r = 0.5 * Math.hypot(T.L, T.W) + 0.15;
    slot.ring.modelMatrix = frame(new C.Matrix4(), [v.x, v.y, 0.1], [1, 0, 0], [0, 1, 0], UP, [r, r, r]);
    slot.ring.color = halo || slot.col.withAlpha(0.95);
    slot.ring.show = true;
  }
  if (slot.dollies.length) {                       // dollies follow the tractor's own path
    let tr = trails.get(v.id) || [];
    const last = tr[tr.length - 1];
    if (!last || Math.hypot(last[0] - v.x, last[1] - v.y) > 12) tr = [[v.x - Math.cos(v.h) * 20, v.y - Math.sin(v.h) * 20], [v.x, v.y]];
    else if (Math.hypot(last[0] - v.x, last[1] - v.y) > 0.3) tr.push([v.x, v.y]);
    if (tr.length > 80) tr = tr.slice(-80);
    trails.set(v.id, tr);
    slot.dollies.forEach((d, k) => {
      if (!d) return;
      const want = T.L / 2 + DOLLY.gap + DOLLY.L / 2 + k * (DOLLY.L + DOLLY.gap);
      const p = alongBack(tr, want);
      const [dx, dy, dz] = flat(p.h);
      d.modelMatrix = frame(new C.Matrix4(), [p.x, p.y, 0.02], dx, dy, dz);
      d.show = true;
    });
  }
}
function alongBack(tr, dist) {                     // the point `dist` metres back along the breadcrumbs, and its heading
  let left = dist;
  for (let i = tr.length - 1; i > 0; i--) {
    const [x1, y1] = tr[i], [x0, y0] = tr[i - 1], d = Math.hypot(x1 - x0, y1 - y0);
    if (d >= left) { const f = left / d; return { x: x1 + (x0 - x1) * f, y: y1 + (y0 - y1) * f, h: Math.atan2(y1 - y0, x1 - x0) }; }
    left -= d;
  }
  const [x0, y0] = tr[0], [x1, y1] = tr[1] || [x0 + 1, y0];
  const h = Math.atan2(y1 - y0, x1 - x0);
  return { x: x0 - Math.cos(h) * left, y: y0 - Math.sin(h) * left, h };
}
function hideSlot(slot) { slot.model.show = false; if (slot.ring) slot.ring.show = false; slot.dollies.forEach((d) => d && (d.show = false)); slot.unit = null; }

/* ---------- state ---------- */
let MODE = 'orbit', picked = null, hovered = null, followId = null;
let rate = 30, playing = true, started = false, intro = false;
const TOG = { help: false, legend: true, cine: false, marks: true };
const hits = new Set();                            // ids in a separation conflict right now
const evPos = new Map();                           // event id -> where it happened, for the camera
const walker = createWalker({ x: 0, y: 0, h: 0 });
walker.keys = new Set(); walker.rode = false;
const driveKeys = new Set();
let tractorSlot = null;

function heldInput() {
  const up = driveKeys.has('u'), dn = driveKeys.has('d');
  return { throttle: up ? 1 : dn ? -1 : 0, steer: (driveKeys.has('r') ? 1 : 0) - (driveKeys.has('l') ? 1 : 0) };
}

function vehicleState(v) {
  if (v.state === 'waiting') return 'waiting for you';
  if (v.mode === 'detour') return 'rerouting';
  if (v.state === 'moving') return `${(v.v * 3.6).toFixed(0)} km/h`;
  return 'parked';
}

/* ---------- per-frame update ---------- */
let lastEvent = 0;
function update(dtSim) {
  if (dtSim > 0) {
    const input = MODE === 'drive' ? heldInput() : { throttle: 0, steer: 0 };
    const loop = world.loop;
    world.step(dtSim, input);
    if (world.loop !== loop) { trails.clear(); renderMarks(); }
  }
  if (MODE === 'walk') walkStep();
  // the detector's live conflicts, and positions of new events for the camera
  hits.clear();
  for (let i = lastEvent; i < world.events.length; i++) {
    const e = world.events[i];
    const vs = e.vehicles.map((id) => (id === 'player' ? world.player : world.vehicles.find((v) => v.id === id))).filter(Boolean);
    if (vs.length) evPos.set(e.id, { x: vs.reduce((s, v) => s + v.x, 0) / vs.length, y: vs.reduce((s, v) => s + v.y, 0) / vs.length });
  }
  if (world.events.length !== lastEvent) { lastEvent = world.events.length; renderMarks(); }
  for (const e of world.events.slice(-12)) if (e.type === 'separation' && world.t - e.t < 4 && e.loop === world.loop) e.vehicles.forEach((id) => hits.add(id));
  placeAircraft(world.aircraft);
  placeBridge(world.bridge);
  // vehicles on their slots
  const live = states().filter((v) => v.state !== 'offstage');
  const want = new Set(live.map((v) => v.id));
  for (const [id, slot] of slots) if (!want.has(id)) { hideSlot(slot); slots.delete(id); trails.delete(id); }
  for (const v of live) {
    let slot = slots.get(v.id);
    if (!slot) {
      slot = (pools[v.type] || []).find((q) => !q.unit);
      if (!slot) { grow(v.type); continue; }
      slot.unit = v.id; slots.set(v.id, slot);
    }
    const halo = v.id === picked ? C.Color.WHITE : (v.state === 'waiting' || v.mode === 'detour') ? C.Color.WHITE.withAlpha(0.35 + 0.5 * PULSE) : null;
    placeSlot(slot, v, hits.has(v.id), halo);
  }
  if (tractorSlot) {
    if (world.player) placeSlot(tractorSlot, world.player, hits.has('player'), C.Color.fromCssColorString('#ffd60a'));
    else hideSlot(tractorSlot);
  }
  drawTop(); drawHead(); drawHud();
}

function drawTop() {
  $('clock').textContent = hms(world.t);
  const a = world.aircraft, turn = a.phase !== 'absent' ? world.turns[a.turn] : null;
  const PH = { taxi_in: 'Taxiing in', on_blocks: 'On blocks', pushback: 'Pushback', taxi_out: 'Taxiing out' };
  $('acname').textContent = turn ? `A320 · turn ${turn.index + 1} of ${world.turns.length}` : 'Stand empty';
  $('acphase').textContent = turn ? `${PH[a.phase]}${a.phase === 'on_blocks' ? ` · ${mmss(world.t - turn.onBlock)} of ${table.target_trt_min}:00` : ''}` : nextTurnText();
  $('delay').textContent = `${Math.round(world.delay.total)} s`;
  $('delay').classList.toggle('bad', world.delay.total > 0);
  const done = world.turns.filter((t) => t.done);
  const sc = $('score');
  if (done.length) {
    const avg = Math.round(done.reduce((s, t) => s + t.score, 0) / done.length);
    sc.textContent = avg; sc.classList.toggle('good', avg >= 90); sc.classList.toggle('bad', avg < 90);
    $('scorek').textContent = `on-time score · ${done.length} of ${world.turns.length} turns`;
  } else { sc.textContent = '–'; sc.classList.remove('good', 'bad'); $('scorek').textContent = 'on-time score'; }
  $('day').textContent = `loop ${world.loop + 1} · seed ${SEED} · synthetic`;
}
function nextTurnText() {
  const next = world.turns.find((t) => !t.done && t.onBlock > world.t);
  return next ? `next arrival ${hms(next.onBlock)}` : 'loop restarts soon';
}

function drawHud() {
  const hud = $('hud');
  const turn = world.turns.find((t) => !t.done && t.onBlock <= world.t + 120) || null;
  const proj = turn ? (turn.offBlock - turn.targetOffBlock) / 60 : null;
  const projTxt = turn ? `<span>off-block <b class="${proj > 0 ? 'hit' : ''}">${proj > 0 ? '+' : ''}${proj.toFixed(1)} min</b> vs target</span>` : '';
  if (MODE === 'drive' && world.player) {
    const p = world.player, inside = stand.inSafetyArea(p.x, p.y) && world.aircraft.phase !== 'absent';
    const waiting = states().filter((v) => v.state === 'waiting' || v.mode === 'detour').length;
    hud.innerHTML = `<b>Your tractor</b><span class="spd">${(Math.abs(p.v) * 3.6).toFixed(0)}<i>km/h</i></span>` +
      `<span>delay to others <b>${Math.round(world.delay.total)} s</b></span>${waiting ? `<span class="hit">${waiting} waiting or rerouting</span>` : ''}${projTxt}` +
      (p.hit ? `<span class="hit">Blocked by ${esc(hitName(p.hit))}</span>` : '') + (inside && Math.abs(p.v) > LIMITS.zoneSpeed ? '<span class="hit">Over 5 km/h near the aircraft</span>' : '') +
      `<span class="k">25 km/h cap (assumed) · S brakes then reverses · drag or zoom to move the camera · Esc gets out</span>`;
  } else if (MODE === 'walk') {
    hud.innerHTML = `<b>On foot</b><span class="spd">${(walker.speed * 3.6).toFixed(0)}<i>km/h</i></span>${projTxt}` +
      `<span class="k">WASD walk · Q E turn · Shift runs · Space jumps · drag to look · click a vehicle to ride along · Esc stops</span>`;
  } else if (MODE === 'follow') {
    const v = states().find((x) => x.id === followId);
    hud.innerHTML = v ? `<b>${esc(TYPES[v.type].label)}</b><span>${esc(vehicleState(v))}</span>${v.lag > 0.5 ? `<span class="hit">${Math.round(v.lag)} s late</span>` : ''}${projTxt}` +
      `<span class="k">${walker.rode ? 'Click to step off' : 'Drag and zoom move the camera · Esc stops following'}</span>` : '';
  }
}
function hitName(id) {
  const s = String(id);
  if (s === 'aircraft-body') return 'the aircraft';
  if (s.startsWith('aircraft-engine')) return `the ${s.endsWith('left') ? 'left' : 'right'} engine`;
  if (s.startsWith('bridge')) return 'the jet bridge';
  if (s === 'edge') return 'the edge of the stand';
  const v = states().find((x) => x.id === s);
  return v ? `the ${TYPES[v.type].label.toLowerCase()}` : 'a vehicle';
}

let lastFrame = performance.now(), PULSE = 0;
scene.preRender.addEventListener(() => {
  const now = performance.now(), dt = Math.min(0.25, (now - lastFrame) / 1000);
  lastFrame = now; PULSE = 0.5 + 0.5 * Math.sin(now / 110);
  if (!SIM.ready) return;
  if (!started && !intro) orbitIntro(dt);
  REAL_DT = dt;
  update(playing && started ? dt * rate : 0);
  if (MODE === 'drive') chase(); else if (MODE === 'follow') followCam(dt); else if (MODE === 'walk') walkCam(dt);
  drawLabels(); drawMap();
});
let REAL_DT = 0;

/* ---------- floating labels over the nearest vehicles ---------- */
const tags = new Map();
function drawLabels() {
  const layer = $('labels'), W = viewer.canvas.clientWidth, H = viewer.canvas.clientHeight;
  const near = [];
  const list = world.player ? [...states(), { id: 'player', type: 'PLAYER', state: 'moving', x: world.player.x, y: world.player.y, v: Math.abs(world.player.v), mode: 'player', lag: 0 }] : states();
  for (const v of list) {
    if (v.state === 'offstage') continue;
    const w = P(v.x, v.y, TYPES[v.type].H + 2.2), dist = C.Cartesian3.distance(w, cam.positionWC);
    if (dist > 220 || C.Cartesian3.dot(C.Cartesian3.subtract(w, cam.positionWC, new C.Cartesian3()), cam.directionWC) < 0) continue;
    const sp = C.SceneTransforms.worldToWindowCoordinates(scene, w, new C.Cartesian2());
    if (!sp || sp.x < 0 || sp.x > W || sp.y < 110 || sp.y > H - 190) continue;
    near.push([v, dist, sp]);
  }
  near.sort((a, b) => a[1] - b[1]).splice(9);
  const keep = new Set(near.map((q) => q[0].id));
  for (const [id, d] of tags) if (!keep.has(id)) { d.remove(); tags.delete(id); }
  for (const [v, dist, sp] of near) {
    let d = tags.get(v.id);
    if (!d) { d = document.createElement('div'); d.className = 'tag'; layer.appendChild(d); tags.set(v.id, d); }
    const k = Math.max(0.8, Math.min(1.2, 90 / dist));
    d.style.transform = `translate(${sp.x}px,${sp.y}px) translate(-50%,-100%) scale(${k})`;
    d.classList.toggle('hit', hits.has(v.id)); d.classList.toggle('wait', v.state === 'waiting' || v.mode === 'detour');
    const html = v.id === 'player' ? `You<i>baggage tractor · ${(v.v * 3.6).toFixed(0)} km/h</i>`
      : `${esc(TYPES[v.type].label)}<i>${esc(vehicleState(v))}${v.lag > 0.5 ? ` · ${Math.round(v.lag)} s late` : ''}</i>`;
    if (d._html !== html) { d._html = html; d.innerHTML = html; }
  }
}

/* ---------- hover card ---------- */
function pickVehicle(ev) {
  const r = viewer.canvas.getBoundingClientRect(), pk = scene.pick(new C.Cartesian2(ev.clientX - r.left, ev.clientY - r.top));
  const slot = pk && pk.primitive && pk.primitive._slot;
  return slot && slot.unit != null ? slot.unit : null;
}
viewer.canvas.addEventListener('pointermove', (ev) => {
  const card = $('card'), id = SIM.ready ? pickVehicle(ev) : null;
  hovered = id;
  const v = id && states().find((x) => x.id === id);
  if (!v) { card.style.display = 'none'; return; }
  const next = v.src.visits.find((q, k) => !v.arrived.has(k));
  card.innerHTML = `<b>${esc(TYPES[v.type].label)}</b><div class="row"><span>Turn</span><span>${v.turn + 1}</span></div>` +
    `<div class="row"><span>Now</span><span>${esc(vehicleState(v))}</span></div>` +
    `<div class="row"><span>Late against the replay</span><span>${Math.round(v.lag)} s</span></div>` +
    (next ? `<div class="row"><span>Next spot</span><span>${esc(next.name.replace(/_/g, ' '))} at ${hms(next.arrive + v.lag)}</span></div>` : '') +
    (v.src.late ? `<div class="flag">Scheduled late by ${Math.round(v.src.late)} s (synthetic)</div>` : '');
  card.style.display = 'block'; card.style.left = ev.clientX + 16 + 'px'; card.style.top = ev.clientY + 16 + 'px';
});
viewer.canvas.addEventListener('pointerleave', () => { $('card').style.display = 'none'; });

/* ---------- mini-map: north up, centred on the stand ---------- */
const MAPHALF = 85, MAPC = [0, -25];
function drawMap() {
  const el = $('minimap'), g = el.getContext('2d'), S = el.width, k = S / 2 / MAPHALF;
  const X = (x) => S / 2 + (x - MAPC[0]) * k, Y = (y) => S / 2 - (y - MAPC[1]) * k;
  g.clearRect(0, 0, S, S); g.save(); g.beginPath(); g.arc(S / 2, S / 2, S / 2, 0, 7); g.clip();
  g.fillStyle = 'rgba(16,17,20,.85)'; g.fillRect(0, 0, S, S);
  g.lineCap = 'round';
  for (const e of stand.edges) {
    if (e.restricted) continue;
    const a = stand.nodes[e.a], b = stand.nodes[e.b];
    g.strokeStyle = 'rgba(120,126,134,.9)'; g.lineWidth = a.kind === 'road' && b.kind === 'road' ? 7 : 4;
    g.beginPath(); g.moveTo(X(a.x), Y(a.y)); g.lineTo(X(b.x), Y(b.y)); g.stroke();
  }
  g.strokeStyle = 'rgba(224,69,58,.9)'; g.lineWidth = 2;
  g.beginPath(); stand.safetyArea.forEach(([x, y], i) => (i ? g.lineTo(X(x), Y(y)) : g.moveTo(X(x), Y(y)))); g.closePath(); g.stroke();
  g.fillStyle = 'rgba(93,107,120,.9)'; g.fillRect(0, Y(54), S, Y(26) - Y(54));
  if (world.aircraft.phase !== 'absent') {
    const a = world.aircraft;
    g.fillStyle = 'rgba(255,255,255,.88)';
    for (const part of stand.aircraftParts(a.nx, a.ny, a.h)) { g.beginPath(); part.poly.forEach(([x, y], i) => (i ? g.lineTo(X(x), Y(y)) : g.moveTo(X(x), Y(y)))); g.closePath(); g.fill(); }
    const f = [Math.cos(a.h), Math.sin(a.h)], r = [Math.sin(a.h), -Math.cos(a.h)], D = table.dimensions;
    const at = (rr, aa) => [X(a.nx + rr * r[0] - aa * f[0]), Y(a.ny + rr * r[1] - aa * f[1])];
    for (const kk of [1, -1]) { g.beginPath(); [[kk * 2, 12.6], [kk * D.span_m / 2, 20], [kk * D.span_m / 2, 21.5], [kk * 2, 19]].forEach(([u, v], i) => { const [p, q] = at(u, v); i ? g.lineTo(p, q) : g.moveTo(p, q); }); g.closePath(); g.fill(); }
  }
  for (const v of states()) {
    if (v.state === 'offstage') continue;
    const off = v.state === 'waiting' || v.mode === 'detour';
    g.beginPath(); g.arc(X(v.x), Y(v.y), v.id === picked ? 7 : 5, 0, 7); g.fillStyle = hits.has(v.id) ? '#ff453a' : TYPES[v.type].color; g.fill();
    g.lineWidth = off || v.id === picked ? 3 : 1.5; g.strokeStyle = off || v.id === picked ? '#fff' : 'rgba(0,0,0,.7)'; g.stroke();
  }
  // you (or the camera), as an arrow
  const cp = C.Matrix4.multiplyByPoint(Minv, cam.positionWC, new C.Cartesian3());
  const me = MODE === 'drive' && world.player ? world.player : MODE === 'walk' ? walker : null;
  const px = X(me ? me.x : cp.x), py = Y(me ? me.y : cp.y), h = me ? bearingOf(me.h) : cam.heading;
  if (world.player && MODE !== 'drive') { g.beginPath(); g.arc(X(world.player.x), Y(world.player.y), 6, 0, 7); g.fillStyle = '#ffd60a'; g.fill(); g.lineWidth = 2; g.strokeStyle = '#000'; g.stroke(); }
  g.save(); g.translate(px, py); g.rotate(h);
  g.fillStyle = '#fff'; g.strokeStyle = '#000'; g.lineWidth = 2;
  g.beginPath(); g.moveTo(0, -12); g.lineTo(8, 9); g.lineTo(0, 4); g.lineTo(-8, 9); g.closePath(); g.stroke(); g.fill(); g.restore();
  g.restore();
  g.beginPath(); g.arc(S / 2, S / 2, S / 2 - 2, 0, 7); g.lineWidth = 3; g.strokeStyle = 'rgba(255,255,255,.35)'; g.stroke();
  g.fillStyle = '#fff'; g.font = '700 22px monospace'; g.textAlign = 'center'; g.fillText('N', S / 2, 30);
}

/* ---------- timeline: the whole loop, the two turns, the event ticks ---------- */
const tl = $('timeline');
const tx = (t) => (t / world.loopEnd) * 100 + '%';
function buildTimeline() {
  const step = 15 * 60, marks = [];
  for (let t = 0; t <= world.loopEnd; t += step) marks.push(`<span style="left:${tx(t)}">${hms(t).slice(0, 5)}</span>`);
  $('hours').innerHTML = marks.join('');
  // vehicles on the stand through the loop, from the untouched schedule
  const cv = $('spark'), g = cv.getContext('2d'), N = 240, spark = new Array(N).fill(0);
  const probe = createWorld(schedule, { stand });
  for (let i = 0; i < N; i++) { probe.step(world.loopEnd / N); spark[i] = probe.vehicles.filter((v) => v.state !== 'offstage' && stand.inSafetyArea(v.x, v.y)).length; if (probe.loop) break; }
  const draw = () => {
    cv.width = cv.clientWidth * devicePixelRatio; cv.height = 44 * devicePixelRatio;
    g.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    const W = cv.clientWidth, mx = Math.max(...spark, 1);
    g.clearRect(0, 0, W, 44);
    g.beginPath(); g.moveTo(0, 44);
    spark.forEach((n, i) => g.lineTo((i / N) * W, 44 - (n / mx) * 38));
    g.lineTo(W, 44); g.closePath(); g.fillStyle = 'rgba(41,151,255,.28)'; g.fill();
    g.fillStyle = '#b4b4ba'; g.font = '12px ' + getComputedStyle(document.body).fontFamily; g.fillText(`Vehicles at the aircraft (peak ${mx})`, 6, 13);
  };
  draw(); addEventListener('resize', draw);
}
function drawFlights() {
  $('flights').innerHTML = world.turns.map((t, i) => {
    const plan = schedule.turns[i], l = (plan.taxiInStart / world.loopEnd) * 100, r = ((t.offBlock + 210) / world.loopEnd) * 100;
    const cls = t.done ? (t.lateMin > 0 ? 'done-late' : 'done-ok') : '';
    const lab = `Turn ${i + 1} · A320 · on ${hms(t.onBlock).slice(0, 5)} · target off ${hms(t.targetOffBlock).slice(0, 5)}${t.done ? ` · ${t.lateMin > 0 ? '+' : ''}${t.lateMin.toFixed(1)} min · score ${t.score}` : ''}`;
    return `<div class="fl ${cls}" style="left:${l}%;width:${r - l}%" title="${esc(lab)}">${esc(lab)}</div>`;
  }).join('');
  $('marks-ticks').innerHTML = world.events.filter((e) => e.loop === world.loop).map((e) => `<i style="left:${tx(e.t)}"></i>`).join('');
}
function drawHead() { $('head').style.left = tx(world.t); if (++drawHead.n % 15 === 0) drawFlights(); }
drawHead.n = 0;
let scrubbing = false;
const timeAt = (ev) => { const r = tl.getBoundingClientRect(); return Math.max(0, Math.min(world.loopEnd - 1, ((ev.clientX - r.left) / r.width) * world.loopEnd)); };
function seek(t) {                                 // a jump replays the schedule from the start of the loop, without the driving
  const loop = world.loop, events = world.events, player = world.player && { x: world.player.x, y: world.player.y, h: world.player.h };
  world = createWorld(schedule, { stand, player: null });
  world.loop = loop;
  if (t > 0) world.step(t);
  world.events = events.filter((e) => e.loop < loop).concat(world.events.map((e) => ({ ...e, loop })));
  lastEvent = 0;
  if (player) world.setPlayer(player);
  trails.clear(); renderMarks(); update(0);
}
tl.addEventListener('pointerdown', (ev) => { scrubbing = true; tl.setPointerCapture(ev.pointerId); start(); seek(timeAt(ev)); });
tl.addEventListener('pointermove', (ev) => {
  const hv = $('hover'); hv.style.display = 'block'; hv.style.left = tx(timeAt(ev)); hv.textContent = hms(timeAt(ev));
  if (scrubbing) seek(timeAt(ev));
});
tl.addEventListener('pointerup', () => { scrubbing = false; });
tl.addEventListener('pointerleave', () => { $('hover').style.display = 'none'; });

/* ---------- controls ---------- */
const SPEEDS = [1, 5, 10, 30, 60];
$('speeds').innerHTML = SPEEDS.map((s) => `<button data-s="${s}">${s}×</button>`).join('');
const setRate = (r) => { rate = r; document.querySelectorAll('#speeds button').forEach((b) => b.classList.toggle('on', +b.dataset.s === r)); };
document.querySelectorAll('#speeds button').forEach((b) => (b.onclick = () => { start(); setRate(+b.dataset.s); }));
function setPlaying(on) { playing = on; $('play').innerHTML = on ? '&#10074;&#10074;' : '&#9654;'; }
$('play').onclick = () => { start(); setPlaying(!playing); };
$('roles').innerHTML = Object.entries(TYPES).filter(([k]) => k !== 'PLAYER').map(([, t]) => `<span><i style="background:${t.color}"></i>${esc(t.label)}</span>`).join('') +
  `<span><i style="background:${TYPES.PLAYER.color}"></i>You</span>`;

/* ---------- cameras: target (local x, y, z), compass heading, pitch, range ---------- */
const VIEWS = { overview: { t: [4, -22, 0], h: 20, p: -42, r: 150 }, ground: { t: [6, -16, 3], h: 300, p: -9, r: 58 } };
const VIEWKEYS = Object.keys(VIEWS);
$('views').innerHTML = VIEWKEYS.map((v, i) => `<button data-v="${v}" title="Camera ${i + 1}">${v[0].toUpperCase() + v.slice(1)}</button>`).join('');
document.querySelectorAll('#views button').forEach((b) => (b.onclick = () => { start(); toOrbit(b.dataset.v); }));
function toOrbit(name) { if (MODE !== 'orbit') setMode('orbit', null, true); view(name, 1.2); }
function view(name, dur, done) {
  const v = typeof name === 'string' ? VIEWS[name] : name, tgt = P(v.t[0], v.t[1], v.t[2]);
  const off = new C.HeadingPitchRange(C.Math.toRadians(v.h), C.Math.toRadians(v.p), v.r);
  if (!dur) { cam.lookAt(tgt, off); cam.lookAtTransform(C.Matrix4.IDENTITY); return; }
  cam.flyToBoundingSphere(new C.BoundingSphere(tgt, 1), { offset: off, duration: dur, easingFunction: C.EasingFunction.QUADRATIC_IN_OUT, complete: done, cancel: done });
}
const INTRO = { t: [0, -22, 0], h: 20, p: -24, r: 330 }, INTRO_DEG_S = 3, FLY_S = 3.5;
function orbitIntro(dt) { INTRO.h = (INTRO.h + dt * INTRO_DEG_S) % 360; view(INTRO); }
const showPrompt = () => { $('title').querySelector('.go').textContent = 'Press any key to begin'; document.body.classList.add('ready'); };
function start(fly) {
  if (started || intro) return;
  const begin = () => { intro = false; started = true; document.body.classList.remove('intro'); document.body.classList.add('started'); setTimeout(() => { $('hint').style.opacity = 0.55; }, 20000); };
  if (!fly) { view('overview'); return begin(); }
  if (!document.body.classList.contains('ready')) return;
  intro = true; document.body.classList.add('intro');
  view('overview', FLY_S, begin);
}
function toggle(name, on = !TOG[name]) {
  TOG[name] = on;
  if (name === 'help') { $('help').hidden = !on; $('helpbtn').classList.toggle('on', on); }
  if (name === 'legend') document.body.classList.toggle('nolegend', !on);
  if (name === 'marks') document.body.classList.toggle('nomarks', !on);
  if (name === 'cine') document.body.classList.toggle('cine', on);
}
document.querySelectorAll('[data-toggle]').forEach((b) => (b.onclick = () => toggle(b.dataset.toggle)));
$('cine').onclick = () => toggle('cine', true);
$('uncine').onclick = () => toggle('cine', false);
document.querySelectorAll('#modes button').forEach((b) => (b.onclick = () => { start(); setMode(b.dataset.m, b.dataset.m === 'follow' ? picked : null); }));

document.addEventListener('keydown', (ev) => {
  if (ev.target.closest?.('input, textarea, select, [contenteditable]')) return;
  if (!started) { ev.preventDefault(); start(true); return; }
  const k = ev.key.toLowerCase();
  if (MODE === 'walk' && walkKey(ev, true)) ev.preventDefault();
  else if (MODE === 'drive' && driveKey(ev, true)) ev.preventDefault();
  else if (ev.key === ' ') { ev.preventDefault(); setPlaying(!playing); }
  else if (ev.key === 'Escape' && !$('markbox').hidden) closeFlag(false);
  else if (ev.key === 'Escape' && MODE !== 'orbit') setMode('orbit');
  else if (ev.key === 'Escape' && TOG.cine) toggle('cine', false);
  else if (k === 'e') setMode('drive');
  else if (k === 'f' && (picked ?? hovered) != null) setMode('follow', picked ?? hovered);
  else if (k === 'x') setMode('walk');
  else if (k === 'c') toggle('cine');
  else if (k === 'h' || ev.key === '?') toggle('help');
  else if (k === 'l') toggle('legend');
  else if (k === 'k') toggle('marks');
  else if (k === 'n') { ev.preventDefault(); openFlag(); }
  else if ('12'.includes(ev.key)) toOrbit(VIEWKEYS[+ev.key - 1]);
  else if (k === '[' || k === ']') { const i = SPEEDS.indexOf(rate) + (k === ']' ? 1 : -1); if (SPEEDS[i]) setRate(SPEEDS[i]); }
});
document.addEventListener('pointerdown', () => start(true), true);
document.addEventListener('keyup', (ev) => { if (MODE === 'drive') driveKey(ev, false); else if (MODE === 'walk') walkKey(ev, false); });

/* ---------- driving: E takes your tractor, Esc leaves it where it is ---------- */
function driveKey(ev, down) {
  if (down && ev.key === ' ') { setPlaying(!playing); return true; }
  const k = { arrowup: 'u', w: 'u', arrowdown: 'd', s: 'd', arrowleft: 'l', a: 'l', arrowright: 'r', d: 'r' }[ev.key.toLowerCase()];
  if (!k) return false;
  if (down) driveKeys.add(k); else driveKeys.delete(k);
  return true;
}
function chase() { const p = world.player; if (p) trackCam(p.x, p.y, p.h); }

/* ---------- modes: orbit, follow a vehicle, drive your tractor, walk on foot (from the earlier replay) ---------- */
const FOV0 = Math.PI / 3;
let followH = 0;
const camOff = { has: false, relH: 0, p: -14, r: 24, lastH: 0, lastTgt: null };
function setMode(name, id, keepView) {
  cam.cancelFlight();
  if (MODE !== 'orbit') { cam.lookAtTransform(C.Matrix4.IDENTITY); walker.keys.clear(); driveKeys.clear(); cam.frustum.fov = FOV0; }
  const fromWalk = MODE === 'walk';
  followId = null; MODE = 'orbit'; ssc.enableInputs = true; walker.rode = false;
  Object.assign(camOff, { has: false, relH: 0, p: name === 'follow' ? -18 : -14, r: name === 'follow' ? 26 : 22 });
  if (name === 'drive') {
    if (!world.player) world.setPlayer(SPAWN);   // on the apron west of the stand, facing the head-of-stand road
    MODE = 'drive'; setRate(1); setPlaying(true);
  } else if (name === 'follow' && id != null && states().find((v) => v.id === id)) {
    followId = id; followH = states().find((v) => v.id === id).h; MODE = 'follow'; walker.rode = fromWalk && !!keepView;
  } else if (name === 'walk') {
    const c = keepView ? [walker.x, walker.y] : viewCentre();
    Object.assign(walker, { x: c[0], y: c[1], h: keepView ? walker.h : bearingOf(cam.heading), p: keepView ? walker.p : 0, z: 0, vz: 0, speed: 0 });
    MODE = 'walk'; ssc.enableInputs = false;
    if (rate > 10) setRate(5);
  }
  if (MODE === 'orbit' && !keepView) view('overview', 1.2);
  document.body.dataset.mode = MODE;
  document.querySelectorAll('#modes button').forEach((b) => b.classList.toggle('on', b.dataset.m === MODE));
  showSelection();
}
function viewCentre() {
  const r = cam.getPickRay(new C.Cartesian2(viewer.canvas.clientWidth / 2, viewer.canvas.clientHeight / 2));
  const g = r && scene.globe.pick(r, scene);
  if (!g) return [30, -2];
  const q = C.Matrix4.multiplyByPoint(Minv, g, new C.Cartesian3()), b = stand.bounds;
  return [Math.max(b.xmin + 5, Math.min(b.xmax - 5, q.x)), Math.max(b.ymin + 5, Math.min(b.ymax - 5, q.y))];
}
function trackCam(x, y, h) {                       // behind the vehicle, keeping the turn, tilt and zoom the user gave it
  const tgt = P(x, y, 1.5), hd = C.Math.toDegrees(bearingOf(h));
  if (camOff.has) {
    camOff.r = Math.max(6, Math.min(400, C.Cartesian3.distance(cam.positionWC, camOff.lastTgt)));
    camOff.p = Math.max(-89, Math.min(-2, C.Math.toDegrees(cam.pitch)));
    camOff.relH = ((C.Math.toDegrees(cam.heading) - camOff.lastH + 540) % 360) - 180;
  }
  cam.lookAt(tgt, new C.HeadingPitchRange(C.Math.toRadians(hd + camOff.relH), C.Math.toRadians(camOff.p), camOff.r));
  Object.assign(camOff, { has: true, lastH: hd, lastTgt: tgt });
}
function followCam(dt) {
  const v = states().find((x) => x.id === followId);
  if (!v || v.state === 'offstage') { setMode('orbit'); return; }
  followH += Math.atan2(Math.sin(v.h - followH), Math.cos(v.h - followH)) * Math.min(1, dt * 2.5);
  trackCam(v.x, v.y, followH);
}
function walkKey(ev, down) {
  walker.run = ev.shiftKey;
  if (ev.key === 'Shift') return true;
  if (ev.key === ' ') { if (down) walker.keys.add('jump'); else walker.keys.delete('jump'); return true; }
  const k = { arrowup: 'forward', w: 'forward', arrowdown: 'back', s: 'back', arrowleft: 'left', a: 'left', arrowright: 'right', d: 'right', q: 'turnLeft', e: 'turnRight' }[ev.key.toLowerCase()];
  if (!k) return false;
  if (down) walker.keys.add(k); else walker.keys.delete(k);
  return true;
}
function walkStep() {                              // walking runs in real time, whatever the replay speed
  const K = walker.keys, input = { run: walker.run };
  for (const k of K) input[k] = true;
  stepWalker(walker, input, REAL_DT, { stand, solids: world.solids().map((o) => o.poly) });
}
function walkCam(dt) {
  const r = [Math.sin(walker.h), -Math.cos(walker.h)], moving = walker.speed > 0;
  const amp = (walker.run ? 0.09 : 0.05) * walker.bobK, dip = -Math.abs(Math.cos(walker.bob)) * amp, sway = Math.sin(walker.bob) * amp * 0.7;
  cam.frustum.fov += (FOV0 * (walker.run && moving ? 1.13 : 1) - cam.frustum.fov) * Math.min(1, dt * 6);
  cam.setView({ destination: P(walker.x + r[0] * sway, walker.y + r[1] * sway, WALK.eye + amp * 0.5 + dip + walker.z - walker.land),
    orientation: { heading: bearingOf(walker.h), pitch: C.Math.toRadians(walker.p), roll: sway * 0.35 } });
}
let look = null, downAt = null;
viewer.canvas.addEventListener('pointerdown', (ev) => { downAt = [ev.clientX, ev.clientY]; if (MODE === 'walk') look = { x: ev.clientX, y: ev.clientY, h: walker.h, p: walker.p }; });
addEventListener('pointerup', () => { look = null; });
viewer.canvas.addEventListener('pointermove', (ev) => {
  if (MODE !== 'walk' || !look) return;
  walker.h = look.h - (ev.clientX - look.x) * 0.18 * Math.PI / 180;
  walker.p = Math.max(-60, Math.min(30, look.p - (ev.clientY - look.y) * 0.18));
});
viewer.canvas.addEventListener('click', (ev) => {
  if (!downAt || Math.hypot(ev.clientX - downAt[0], ev.clientY - downAt[1]) > 5) return;
  const id = pickVehicle(ev);
  if (MODE === 'orbit') select(id);
  else if (MODE === 'walk' && id != null) { select(id); setMode('follow', id, true); }      // ride along
  else if (MODE === 'follow' && walker.rode) {                                                // step off behind it
    const v = states().find((x) => x.id === followId);
    if (v) Object.assign(walker, { x: v.x - Math.cos(v.h) * (TYPES[v.type].L / 2 + 2.5), y: v.y - Math.sin(v.h) * (TYPES[v.type].L / 2 + 2.5), h: v.h, p: 0 });
    setMode('walk', null, true);
  }
});
function select(id) { picked = id; showSelection(); }
function showSelection() {
  const v = picked != null && states().find((x) => x.id === picked);
  $('sel').innerHTML = v ? `${esc(TYPES[v.type].label)} <i>turn ${v.turn + 1}</i>` : '';
  $('selbox').hidden = !v;
  document.querySelector('#modes [data-m="follow"]').disabled = !v;
}

/* ---------- Mark mode: verdicts on the detector's events, flags for what it missed ---------- */
const EVT = {
  separation: ['Separation', 'two vehicles closer than 0.3 m while moving'],
  late_arrival: ['Late arrival', 'a vehicle reached its spot over a minute late'],
  blocked: ['Blocked', 'a vehicle stopped for you'],
  reroute: ['Reroute', 'a vehicle took a detour round you'],
  zone_speeding: ['Speeding', 'you drove over 5 km/h near the aircraft'],
  zone_before_chocks: ['Too early', 'you were near the aircraft before chocks on'],
  human_flag: ['Your flag', 'something the detector missed'],
};
const STORE = `turnaround-sim:marks:${SEED}`;
function loadMarker() {
  try { const j = JSON.parse(localStorage.getItem(STORE)); if (j) return importMarks(j); } catch { /* none yet, or storage blocked */ }
  return createMarker({ seed: SEED, aircraft: 'A320' });
}
const saveMarks = () => { try { localStorage.setItem(STORE, JSON.stringify(marker.export(world.events))); } catch { /* storage blocked: marks live until reload */ } };
function renderMarks() {
  const out = marker.export(world.events).marks.filter((m) => m.loop === world.loop || m.verdict);
  $('markcount').textContent = out.length;
  const who = (ids) => ids.map((id) => (id === 'player' ? 'you' : (states().find((v) => v.id === id) ? TYPES[states().find((v) => v.id === id).type].label.toLowerCase() : id))).join(' and ');
  $('marklist').innerHTML = out.length ? out.slice().reverse().map((m) => {
    const [name] = EVT[m.type] || [m.type];
    const vd = m.source === 'detector' ? `<span class="vd">${[['valid', '✓'], ['false_alarm', '✗'], ['unsure', '?']].map(([v, s]) => `<button data-v="${v}" data-id="${m.eventId}" class="${m.verdict === v ? 'on' : ''}" title="${v.replace('_', ' ')}">${s}</button>`).join('')}</span>` : '';
    return `<li class="${m.source}"><span class="go" data-id="${m.eventId}"><span class="t">${hms(m.t)}</span><span class="c">${esc(name)}</span><span class="n">${esc(m.note || who(m.vehicles))}${m.loop !== world.loop ? ` · loop ${m.loop + 1}` : ''}</span></span>${vd}</li>`;
  }).join('') : '<li class="empty">No events yet. Drive into the traffic (E) to make some</li>';
  $('marklist').querySelectorAll('.vd button').forEach((b) => (b.onclick = () => { marker.verdict(b.dataset.id, b.dataset.v); saveMarks(); renderMarks(); }));
  $('marklist').querySelectorAll('.go').forEach((s) => (s.onclick = () => lookAtEvent(s.dataset.id)));
  drawFlights();
}
function lookAtEvent(id) {
  const p = evPos.get(id) || (() => { const f = marker.get(id); return f && f.x != null ? f : null; })();
  if (!p) return;
  if (MODE !== 'orbit') setMode('orbit', null, true);
  view({ t: [p.x, p.y, 1], h: C.Math.toDegrees(cam.heading), p: -35, r: 45 }, 1.0);
}
function openFlag() {
  const box = $('markbox');
  box.hidden = false; box.dataset.t = world.t;
  $('mk-what').textContent = 'At'; $('mk-when').textContent = hms(world.t);
  $('mk-note').value = ''; setTimeout(() => $('mk-note').focus(), 0);
}
function closeFlag(save) {
  const box = $('markbox');
  if (save) {
    const id = marker.flag({ t: +box.dataset.t, loop: world.loop, note: $('mk-note').value.trim() || 'flagged', vehicles: picked ? [picked] : [] });
    const c = viewCentre(); evPos.set(id, { x: c[0], y: c[1] });
    saveMarks(); renderMarks();
  }
  box.hidden = true;
}
$('flagbtn').onclick = () => { start(); openFlag(); };
$('mk-save').onclick = () => closeFlag(true);
$('mk-cancel').onclick = () => closeFlag(false);
$('mk-note').addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); closeFlag(true); } if (ev.key === 'Escape') closeFlag(false); });
$('exportbtn').onclick = () => {
  const blob = new Blob([JSON.stringify(marker.export(world.events), null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = `turnaround-marks-seed${SEED}.json`; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};

/* ---------- start ---------- */
(async () => {
  table = await (await fetch('data/a320-turnaround.json')).json();
  stand = createStand(table);
  schedule = generate({ table, stand, seed: SEED });
  world = createWorld(schedule, { stand });
  marker = loadMarker();
  buildStand(); buildBridge(); await buildAircraft();
  const types = [...new Set(schedule.vehicles.map((v) => v.type))];
  await Promise.all(types.map((t) => makeSlot(t)));
  tractorSlot = await makeSlot('PLAYER');
  pools.PLAYER = [];
  buildTimeline(); renderMarks(); showSelection(); setRate(rate);
  SIM.ready = true;
  Object.assign(SIM, { stand, schedule, setMode, seek, start, setRate, view, toggle, setPlaying, marker: () => marker });
  Object.defineProperties(SIM, { world: { get: () => world }, mode: { get: () => MODE } });
  update(0);
  if (params.has('autostart')) start(false); else showPrompt();
})().catch((err) => { console.error(err); $('title').querySelector('.go').textContent = 'Could not load the stand'; });
