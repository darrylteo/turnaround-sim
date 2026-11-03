# Evals

These evals were written before the features they test (see the git history). A few changed while the features were built. The walk evals were added with the 3D game, before the walker. The turn-radius check now allows the deliberate slow turn on the spot. Obstacles became polygons. The fuel-slack check blocks for 25 s instead of 60, so it no longer also holds up the catering truck behind. They run headless with
`npm test` (Node's built-in test runner, no dependencies) and on every push in
CI.

| File | What it proves |
|------|----------------|
| `generator.test.js` | **Precedence.** With no noise, the generator reproduces the A320 chart and its 44.2 min turn, and the 737-800 cross-check's 37.5 min. Across 200 noisy seeds it never breaks an `after`/`before` link. It never refuels with passengers on board, never puts one truck at two doors at once, and never parks a vehicle at the aircraft before chocks are on. Late vehicles are occasional (at most 4 per run, at most 6 min late) and sometimes cost the turn. Two turns run with a gap, and the generator is deterministic per seed. |
| `replay.test.js` | **Replay fidelity.** With no player, every vehicle is within 1 cm of its generated track at every step and reaches its spot on time. Tracks stay on the road graph and under the speed cap. The same seed and the same inputs produce an identical run. Late arrivals baked into the schedule show up as `late_arrival` events, one for one. |
| `reroute.test.js` | **Waiting and rerouting.** A vehicle stops at least `STOP_DISTANCE` short of the player, waits, and never drives through you. After `rerouteAfter` s it takes a detour that avoids the blocked edge and still reaches its spot. Where no detour exists it keeps waiting and resumes when you leave. |
| `delay.test.js` | **Delay counter.** The counter equals the time a blocked vehicle lost (±1 s). It is the sum of arrival lateness, is never negative and never decreases. Delaying catering, which is on the critical path, pushes off-block back by the same amount. Delaying fuel by less than its 2.6 min of slack doesn't. On-time score = 100 − 5 × minutes late, floored at 0. |
| `handling.test.js` | **Handling limits.** Top speed, reverse speed, acceleration, braking and turn radius are capped. You can't drive into the aircraft, into another vehicle or off the stand. Physics is the same at 30 and 120 fps, and junk input can't produce NaN. Speeding inside the aircraft safety area is flagged. |
| `marker.test.js` | **Mark mode.** There are three fixed verdicts (`valid`, `false_alarm`, `unsure`). The export holds every detector event (unmarked ones have `verdict: null`) plus human flags. It is sorted, a second verdict replaces the first, bad input is rejected, and it survives a JSON round trip. |
| `loop.test.js` | **Demo loop.** The aircraft is on blocks during each turn and gone mid-gap, and the stand is empty between turns. Passing `loopEnd` restarts the replay, resets the counter and keeps the event log. Untouched loops play out identically. |
| `walk.test.js` | **Walking and jumping.** Walk and run speeds are right, and walking diagonally is no faster. Q and E turn at the set rate. A jump peaks at v²/2g and lands after 2v/g, with no second jump in mid-air and a landing dip. You can't walk through the aircraft, a vehicle driving at you pushes you aside, and you stay on the stand. Added with the 3D game, before the walker. |
| `leak.test.js` | **Leak check.** No tracked file or commit message contains a banned term. Terms are stored only as SHA-256 hashes of lower-cased words, phrases and joined spellings. |

## Module contract these evals pin down

All times are in seconds since the loop starts. All distances are in metres,
with x east and y north. The aircraft parks nose-in, facing north.

- `src/sim/stand.js` exports `createStand(table)`, which returns `{ nodes, edges, spots, gates, playerStart, bounds, path(), edgeHasAlternative(a, b), distanceToNetwork(x, y), insideAircraft(x, y, pad), inSafetyArea(x, y) }`.
- `src/sim/generator.js` exports `generate({ table, stand, seed, turns = 2, gapMin = 15, noise = true, lateProb })` and `REPLAY_SPEED`. It returns `{ turns: [{ index, onBlock, offBlock, targetOffBlock, tasks }], vehicles: [{ id, type, turn, late, visits: [{ spot, taskKeys, planned, arrive, depart }], track }], loopEnd }`.
- `src/sim/track.js` exports `sampleTrack(track, t)`, which returns `{ x, y, h }`.
- `src/sim/world.js` exports `createWorld(schedule, { stand, player, rerouteAfter = 10 })`, `STOP_DISTANCE` and `onTimeScore(lateMin)`. The world exposes `step(dt, input)`, `setPlayer(pose | null)`, `t`, `loop`, `loopEnd`, `vehicles`, `player`, `aircraft.phase`, `events`, `delay: { total, arrivals }` and `turns`.
- `src/sim/player.js` exports `createPlayer(pose)`, `stepPlayer(p, input, dt, env)` and `LIMITS`.
- `src/sim/marker.js` exports `createMarker({ seed, aircraft })`, which returns `{ flag, verdict, export }`. It also exports `importMarks(json)` and `VERDICTS`.

## Game assumptions (not from the manuals)

These are set in code and labelled as assumptions:

- the stand layout and road graph;
- speeds: replayed GSE at 15 km/h, the player capped at 25 km/h, and 5 km/h inside the safety area;
- stop distance and the reroute timer;
- pushback timing;
- the score formula.

The 7.5 m aircraft safety area comes from the A320 manual's §5-1-2.
