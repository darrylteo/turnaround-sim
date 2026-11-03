/* A fictional nose-in contact stand. Local metres: x east, y north, the nose stop at (0, 0) and the aircraft facing
   north towards the terminal. The road graph, bays and spots are our own layout; the service positions come from
   the aircraft table (metres aft of the nose and from the centreline). */
import { dijkstra, segDist, inPoly, polyDist, rect } from './geom.js';
import { TYPES } from './fleet.js';

const HEAD_Y = 14, LANE_X = 26, BAY_X = 34, PERIM_X = 46, REAR_Y = -50, GATE_X = 90;
const WEST = Math.PI, EAST = 0, SOUTH = -Math.PI / 2;

export function createStand(table) {
  const P = table.positions, D = table.dimensions;
  const nodes = {}, edges = [];
  const node = (id, x, y, kind = 'road', extra = {}) => (nodes[id] = { id, x, y, kind, ...extra }, id);
  const edge = (a, b, opts = {}) => edges.push({ a, b, len: Math.hypot(nodes[b].x - nodes[a].x, nodes[b].y - nodes[a].y), ...opts });

  // head-of-stand road (under the bridge) with the two gates, and the perimeter road beyond the east staging area
  node('gW', -GATE_X, HEAD_Y, 'gate'); node('hW', -LANE_X, HEAD_Y); node('h0', 0, HEAD_Y); node('hG', 8, HEAD_Y);
  node('hE', LANE_X, HEAD_Y); node('hP', PERIM_X, HEAD_Y); node('gE', GATE_X, HEAD_Y, 'gate');
  ['gW', 'hW', 'h0', 'hG', 'hE', 'hP', 'gE'].reduce((a, b) => (edge(a, b), b));

  const spots = {}, bays = {}, trains = {};
  const lane = { E: [], W: [] };
  const laneNode = (side, y) => {
    const id = `${side}${y}`;
    if (!nodes[id]) { node(id, side === 'E' ? LANE_X : -LANE_X, y); lane[side].push(id); }
    return id;
  };
  // a service spot on a spur from the side lane, facing the aircraft, with a staging bay straight across the lane
  const sideSpot = (name, type, side, x, y, bay = true) => {
    const ln = laneNode(side, y);
    spots[name] = node(`s:${name}`, x, y, 'spot', { h: side === 'E' ? WEST : EAST, type });
    edge(ln, spots[name]);
    if (bay) { bays[name] = node(`b:${name}`, side === 'E' ? BAY_X : -BAY_X, y, 'bay', { h: side === 'E' ? WEST : EAST }); edge(ln, bays[name]); }
  };
  const off = (type, from) => from + TYPES[type].L / 2 + 0.3;   // vehicle centre: front bumper 0.3 m short of the aircraft
  sideSpot('door_1R', 'CAT', 'E', off('CAT', 2), -P.door_1R.x);
  sideSpot('fwd_cargo_door', 'LDCL', 'E', off('LDCL', 2), -P.fwd_cargo_door.x);
  sideSpot('refuel_coupling_rh', 'FUEL', 'E', P.refuel_coupling_rh.y + TYPES.FUEL.L / 2 + 0.5, -P.refuel_coupling_rh.x);
  sideSpot('aft_cargo_door', 'LDCL', 'E', off('LDCL', 2), -P.aft_cargo_door.x);
  sideSpot('bulk_cargo_door', 'CB', 'E', off('CB', 2), -P.bulk_cargo_door.x);
  sideSpot('door_4R', 'CAT', 'E', off('CAT', 2), -P.door_4R.x, false);
  sideSpot('waste_water_panel', 'LV', 'E', off('LV', 1.2), -(P.waste_water_panel.x + 2.3));
  sideSpot('lp_air', 'AC', 'W', -9, -8.5);
  sideSpot('potable_water_panel', 'WV', 'W', -off('WV', 1.2), -(P.potable_water_panel.x + 2.3));

  // container and bulk trains stop on rungs between the lane and the perimeter road, outside the safety area
  for (const [name, y] of [['fwd_train', -12.5], ['aft_train', -15.8], ['bulk_train', -37.5]]) {
    const ln = laneNode('E', y), pr = node(`p${y}`, PERIM_X, y);
    trains[name] = spots[name] = node(`s:${name}`, 30, y, 'spot', { h: WEST, type: 'train' });
    edge(pr, spots[name]); edge(spots[name], ln);
  }
  const perim = ['hP', 'p-12.5', 'p-15.8', 'p-37.5'];
  perim.reduce((a, b) => (edge(a, b), b));

  // ground power ahead of the nose (bay north of the road), the tug at the nose, pushed back to the rear road
  bays.ground_power = node('b:ground_power', 8, 20, 'bay', { h: SOUTH });
  edge('hG', bays.ground_power);
  spots.ground_power = node('s:ground_power', 4.6, 1.6, 'spot', { h: Math.atan2(1.6 - HEAD_Y, 4.6 - 8), type: 'GPU' });
  edge('hG', spots.ground_power);
  spots.nose_gear = node('s:nose_gear', 0, 3.5, 'spot', { h: SOUTH, type: 'TOW' });
  edge('h0', spots.nose_gear);

  // side lanes, top to bottom, then the rear road behind the tail
  node('e4', LANE_X, REAR_Y); node('r0', 0, REAR_Y); node('w4', -LANE_X, REAR_Y);
  for (const side of ['E', 'W']) {
    const ids = lane[side].sort((a, b) => nodes[b].y - nodes[a].y);
    [side === 'E' ? 'hE' : 'hW', ...ids, side === 'E' ? 'e4' : 'w4'].reduce((a, b) => (edge(a, b), b));
  }
  edge('e4', 'r0'); edge('r0', 'w4');
  edge(spots.nose_gear, 'r0', { restricted: true });   // the stand centreline: only the tug, while pushing back

  node('start', -62, -25, 'start');

  // ---- graph queries ----
  const ids = Object.keys(nodes), index = Object.fromEntries(ids.map((id, i) => [id, i]));
  const adj = ids.map(() => []);
  edges.forEach((e, k) => { adj[index[e.a]].push([index[e.b], e.len, k]); adj[index[e.b]].push([index[e.a], e.len, k]); });
  const ekey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const edgeByKey = new Map(edges.map((e) => [ekey(e.a, e.b), e]));

  // avoidKinds: never pass through another spot, bay or gate on the way
  function path(from, to, { avoid = new Set(), allowRestricted = false, avoidKinds = false } = {}) {
    const dst = index[to];
    const r = dijkstra(ids.length, (u) => adj[u].filter(([v, , k]) => {
      const e = edges[k];
      if (avoidKinds && v !== dst && nodes[ids[v]].kind !== 'road') return false;
      return (allowRestricted || !e.restricted) && !avoid.has(ekey(e.a, e.b));
    }).map(([v, w]) => [v, w]), index[from], dst);
    return r && r.map((i) => ids[i]);
  }
  const pathLength = (route) => route.reduce((s, id, i) => (i ? s + Math.hypot(nodes[id].x - nodes[route[i - 1]].x, nodes[id].y - nodes[route[i - 1]].y) : 0), 0);

  // bridges of the unrestricted graph (Tarjan): an edge with no detour round it
  const bridgeKeys = new Set();
  {
    const disc = new Array(ids.length).fill(-1), low = new Array(ids.length).fill(0);
    let time = 0;
    const dfs = (u, viaEdge) => {
      disc[u] = low[u] = time++;
      for (const [v, , k] of adj[u]) {
        if (edges[k].restricted || k === viaEdge) continue;
        if (disc[v] < 0) { dfs(v, k); low[u] = Math.min(low[u], low[v]); if (low[v] > disc[u]) bridgeKeys.add(ekey(edges[k].a, edges[k].b)); }
        else low[u] = Math.min(low[u], disc[v]);
      }
    };
    for (let i = 0; i < ids.length; i++) if (disc[i] < 0) dfs(i, -1);
  }
  const edgeHasAlternative = (a, b) => edgeByKey.has(ekey(a, b)) && !edgeByKey.get(ekey(a, b)).restricted && !bridgeKeys.has(ekey(a, b));

  function distanceToNetwork(x, y) {
    let d = Infinity;
    for (const e of edges) d = Math.min(d, segDist([x, y], [nodes[e.a].x, nodes[e.a].y], [nodes[e.b].x, nodes[e.b].y]));
    return d;
  }
  // edges within r metres of a point
  const edgesNear = (x, y, r) => edges.filter((e) => !e.restricted && segDist([x, y], [nodes[e.a].x, nodes[e.a].y], [nodes[e.b].x, nodes[e.b].y]) < r).map((e) => ekey(e.a, e.b));

  // ---- the aircraft's solid parts at ground level: body and engines (wings and tail are above the GSE) ----
  const L = D.length_m, hw = D.fuselage_width_m / 2, span = D.span_m;
  const bodyAF = [[0, 0], [0.9, 0.8], [1.6, 2.2], [hw, 4.5], [hw, 27.5], [1.4, 33], [0.6, L], [-0.6, L], [-1.4, 33], [-hw, 27.5], [-hw, 4.5], [-1.6, 2.2], [-0.9, 0.8]];
  const engineAF = (k) => [[k * 5.75 - 1.1, 10.8], [k * 5.75 + 1.1, 10.8], [k * 5.75 + 1.1, 15.8], [k * 5.75 - 1.1, 15.8]];
  // nose at (nx, ny) facing heading h (north by default); aircraft frame [right, aft] -> world
  function aircraftParts(nx = 0, ny = 0, h = Math.PI / 2) {
    const fx = Math.cos(h), fy = Math.sin(h), rx = fy, ry = -fx;
    const put = (pts) => pts.map(([r, a]) => [nx + r * rx - a * fx, ny + r * ry - a * fy]);
    return [{ id: 'aircraft-body', poly: put(bodyAF) }, { id: 'aircraft-engine-right', poly: put(engineAF(1)) }, { id: 'aircraft-engine-left', poly: put(engineAF(-1)) }];
  }
  const PARTS = aircraftParts();
  const insideAircraft = (x, y, pad = 0) => PARTS.some((p) => polyDist([x, y], p.poly) < pad || inPoly([x, y], p.poly));

  // the stand safety line: at least 7.5 m clear of the aircraft (AC-A320 §5-1-2)
  const S = 7.5, wing = span / 2 + S;
  const safetyArea = [[-(hw + S + 3.5), S], [hw + S + 3.5, S], [wing, -12], [wing, -(L + S)], [-wing, -(L + S)], [-wing, -12]];
  const inSafetyArea = (x, y) => inPoly([x, y], safetyArea);

  // the jet bridge (illustrative): a fixed link from the terminal, a rotunda, and a tunnel to door 1L
  const bridge = {
    terminalY: 26, rotunda: [-20, 19], floor: 4.2,
    parked: [-13, 6], docked: [-(hw + 0.4 + 1.75), -P.door_1L.x], bogieBack: 4,
  };
  const bogie = (f) => {
    const cx = bridge.parked[0] + (bridge.docked[0] - bridge.parked[0]) * f, cy = bridge.parked[1] + (bridge.docked[1] - bridge.parked[1]) * f;
    const ux = bridge.rotunda[0] - cx, uy = bridge.rotunda[1] - cy, n = Math.hypot(ux, uy);
    const bx = cx + ux / n * bridge.bogieBack, by = cy + uy / n * bridge.bogieBack;
    return { x: bx, y: by, h: Math.atan2(uy, ux), cab: [cx, cy], poly: rect(bx, by, Math.atan2(uy, ux) + Math.PI / 2, 3.4, 1.4) };
  };
  const fixedObstacles = [{ id: 'bridge-rotunda', poly: rect(bridge.rotunda[0], bridge.rotunda[1], 0, 1.6, 1.6) }];

  return {
    nodes, edges, spots, bays, trains, gates: ['gW', 'gE'], playerStart: 'start',
    bounds: { xmin: -100, xmax: 100, ymin: -110, ymax: 24 },
    path, pathLength, edgeHasAlternative, edgeKey: ekey, edgesNear, distanceToNetwork,
    aircraftParts, insideAircraft, safetyArea, inSafetyArea, bridge, bogie, fixedObstacles,
    lanes: { headY: HEAD_Y, laneX: LANE_X, bayX: BAY_X, perimX: PERIM_X, rearY: REAR_Y, gateX: GATE_X },
  };
}
