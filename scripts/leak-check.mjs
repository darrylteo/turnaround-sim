#!/usr/bin/env node
/* Leak check: fails if any tracked file or commit message holds a banned term. The terms live only as SHA-256
   hashes in scripts/leak-hashes.json, so this public repo never names what it guards against. Text is lower-cased
   and split into words; every run of one to five words is checked as written ("quux corp") and, when four
   letters or more, joined ("fooxbar" catches "Foox-Bar"). Binary files are scanned for their readable strings,
   so names inside a model's JSON are caught too.
     node scripts/leak-check.mjs          scan the repo (exit 1 on a hit; prints where, never what)
     node scripts/leak-check.mjs --hash   rebuild the hashes from leak-terms.local.txt (git-ignored) */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HASHES = join(ROOT, 'scripts', 'leak-hashes.json');
const MAX_WORDS = 5;

const sha = (s) => createHash('sha256').update(s).digest('hex');
const words = (s) => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
export const normalize = (term) => words(term).join(' ');

export function scanText(text, hashes) {
  const hits = [];
  text.split(/\r?\n/).forEach((line, n) => {
    const w = words(line);
    for (let i = 0; i < w.length; i++) {
      for (let k = 1; k <= MAX_WORDS && i + k <= w.length; k++) {
        const run = w.slice(i, i + k);
        const joined = run.join('');
        for (const form of k === 1 ? [run[0]] : joined.length >= 4 ? [run.join(' '), joined] : [run.join(' ')]) {
          const hx = sha(form);
          if (hashes.has(hx)) hits.push({ line: n + 1, hash: hx.slice(0, 8) });
        }
      }
    }
  });
  return hits;
}

export const loadHashes = () => new Set(JSON.parse(readFileSync(HASHES, 'utf8')).sha256);

export function scanRepo({ root = ROOT, hashes = loadHashes() } = {}) {
  const git = (...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8', maxBuffer: 1 << 28 });
  const files = git('ls-files', '--cached', '--others', '--exclude-standard', '-z').split('\0').filter(Boolean)
    .filter((f) => f !== 'scripts/leak-hashes.json' && existsSync(join(root, f)));
  const hits = [];
  for (const f of files) {
    const buf = readFileSync(join(root, f));
    let text = buf.toString('latin1');
    if (f.endsWith('.glb')) text = buf.subarray(20, 20 + buf.readUInt32LE(12)).toString('utf8');   // a model: its glTF JSON
    else if (text.includes('\0')) text = (text.match(/[\x20-\x7e]{8,}/g) || []).join('\n');      // other binary: its readable strings
    for (const h of scanText(text, hashes)) hits.push({ where: f, ...h });
  }
  let log = '';
  try { log = git('log', '--format=%H%n%B'); } catch { /* no commits yet */ }
  let commit = '';
  log.split('\n').forEach((line) => {
    if (/^[0-9a-f]{40}$/.test(line)) { commit = line.slice(0, 8); return; }
    for (const h of scanText(line, hashes)) hits.push({ where: `commit ${commit}`, line: h.line, hash: h.hash });
  });
  return hits;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes('--hash')) {
    const terms = readFileSync(join(ROOT, 'leak-terms.local.txt'), 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    const set = new Set();
    for (const t of terms) { const n = normalize(t); set.add(sha(n)); if (n.includes(' ')) set.add(sha(n.replace(/ /g, ''))); }
    writeFileSync(HASHES, JSON.stringify({ note: 'SHA-256 of banned terms, lower-cased, words joined by one space or by nothing', sha256: [...set].sort() }, null, 1) + '\n');
    console.log(`${set.size} hashes written`);
  } else {
    const hits = scanRepo();
    for (const h of hits) console.log(`banned term (${h.hash}) at ${h.where}:${h.line}`);
    console.log(hits.length ? `${hits.length} leak(s)` : 'leak check: clean');
    process.exit(hits.length ? 1 : 0);
  }
}
