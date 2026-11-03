#!/usr/bin/env node
/* The README's hero GIF: the overview while your tractor sits on the east lane and the traffic waits and reroutes
   round it. Steps the world itself so every run gives the same frames.  node scripts/hero.mjs  (needs Chrome, ffmpeg) */
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, sleep } from './cdp.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..'), PORT = 8791, FR = join(ROOT, '.frames');
const server = spawn(process.execPath, [join(ROOT, 'scripts/serve.mjs'), String(PORT)], { stdio: 'ignore' });
await sleep(800);
rmSync(FR, { recursive: true, force: true }); mkdirSync(FR);
const page = await open(`http://127.0.0.1:${PORT}/?autostart=1&seed=7`, { width: 1280, height: 720 });
if (!page.ready) throw new Error('app did not load');
await page.ev(`SIM.setPlaying(false); SIM.toggle('legend', false); SIM.toggle('marks', false); SIM.seek(330);
  SIM.view({ t: [18, -10, 0], h: 312, p: -36, r: 105 }); true`);
await sleep(1500);
const N = 90, STEP = 9;                       // 90 frames, 9 simulated seconds each: 06:46 to 06:59
for (let k = 0; k < N; k++) {
  await page.ev(`(() => { const w = SIM.world;
    if (w.t > 560 && !w.player) w.setPlayer({ x: 26, y: 5, h: -Math.PI / 2 });   // park on the east lane
    if (w.t > 1010 && w.player && w.player.x === 26) w.setPlayer({ x: 40, y: 22, h: 0 });   // and clear off
    w.step(${STEP}); return true; })()`);
  await page.ev('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
  writeFileSync(join(FR, `f${String(k).padStart(3, '0')}.png`), await page.shot());
}
console.log('console errors:', page.errors.length ? page.errors : 'none');
page.close(); server.kill();
mkdirSync(join(ROOT, 'docs'), { recursive: true });
const vf = 'fps=10,scale=880:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4';
execFileSync('ffmpeg', ['-y', '-v', 'error', '-framerate', '10', '-i', join(FR, 'f%03d.png'), '-vf', vf, '-loop', '0', join(ROOT, 'docs/hero.gif')]);
execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', join(FR, `f${String(Math.floor(N * 0.55)).padStart(3, '0')}.png`), join(ROOT, 'docs/screenshot.png')]);
rmSync(FR, { recursive: true, force: true });
console.log('wrote docs/hero.gif and docs/screenshot.png');
