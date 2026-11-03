// Eval 8: nothing private leaks into the repo. Banned terms are stored only
// as SHA-256 hashes, so the list itself names nobody.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { scanText, scanRepo, loadHashes } from '../scripts/leak-check.mjs';

const h = (s) => createHash('sha256').update(s).digest('hex');

test('scanner finds a banned word, phrase or joined spelling in any case', () => {
  const hashes = new Set([h('zorblax'), h('quux corp'), h('fooxbar')]);
  assert.equal(scanText('Stand at ZORBLAX, gate 3', hashes).length, 1);
  assert.equal(scanText('funded by Quux  Corp.', hashes).length, 1);
  assert.equal(scanText('the Foox-Bar programme', hashes).length, 1, 'hyphenated form of a joined term');
  assert.equal(scanText('a clean generic contact stand', hashes).length, 0);
});

test('hash list is non-trivial and holds no plaintext', () => {
  const hashes = loadHashes();
  assert.ok(hashes.size >= 10, `only ${hashes.size} banned terms`);
  for (const x of hashes) assert.match(x, /^[0-9a-f]{64}$/);
});

test('no tracked file or commit message contains a banned term', () => {
  const hits = scanRepo();
  assert.deepEqual(hits, [], hits.map((x) => `${x.where}:${x.line}`).join('\n'));
});
