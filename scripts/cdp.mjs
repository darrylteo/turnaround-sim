// Headless Chrome over the DevTools protocol, for the hero GIF and the local smoke check (from the earlier replay's
// evals). open() returns helpers to evaluate in the page, collect console errors, and screenshot.
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function open(url, { port = 9351, width = 1280, height = 720 } = {}) {
  const flags = ['--headless=new', '--use-angle=d3d11', '--enable-gpu-rasterization', '--ignore-gpu-blocklist', '--mute-audio',
    '--hide-scrollbars', `--remote-debugging-port=${port}`, `--window-size=${width},${height}`, '--user-data-dir=' + join(tmpdir(), 'turnaround-sim-chrome'),
    '--no-first-run', '--disable-extensions', '--disable-default-apps', 'about:blank'];
  const chrome = spawn(CHROME, flags, { stdio: 'ignore' });
  let ver = null;
  for (let i = 0; i < 50 && !ver; i++) { try { ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); } catch { await sleep(200); } }
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let id = 0, s;
  const pending = new Map(), errors = [];
  const send = (method, params = {}, sessionId) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') errors.push(`${m.params.entry.text} ${m.params.entry.url || ''}`);
  });
  const { result: { targetId } } = await send('Target.createTarget', { url: 'about:blank' });
  ({ result: { sessionId: s } } = await send('Target.attachToTarget', { targetId, flatten: true }));
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, s);
  for (const d of ['Page', 'Runtime', 'Log']) await send(d + '.enable', {}, s);
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, s);
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
    return r.result?.result?.value;
  };
  const page = {
    ev, errors,
    async goto(u) {
      await send('Page.navigate', { url: u }, s);
      for (let i = 0; i < 120; i++) { if (await ev('!!(window.SIM && SIM.ready)').catch(() => false)) return true; await sleep(500); }
      return false;
    },
    async shot() { const r = await send('Page.captureScreenshot', { format: 'png' }, s); return Buffer.from(r.result.data, 'base64'); },
    close() { try { ws.close(); } catch { /* already closed */ } chrome.kill(); },
  };
  if (url) page.ready = await page.goto(url);
  return page;
}
