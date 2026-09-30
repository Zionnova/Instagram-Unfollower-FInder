'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const IgZip = require('../assets/zip.js');
const IgParse = require('../assets/parse.js');
const h = require('./helpers.js');

const files = {
  'connections/followers_and_following/followers_1.json': h.followersJson([['alice', 1], ['bob', 2]]),
  'connections/followers_and_following/following.json': h.followingJsonNew([['alice', 1], ['carol', 3]]),
  'media/posts/202401/big.txt': 'x'.repeat(200000),
  'índex.html': '<p>é</p>'
};

async function readAll(buffer) {
  const blob = new Blob([buffer]);
  const entries = await IgZip.listEntries(blob);
  const out = {};
  for (const entry of entries) out[entry.name] = await IgZip.readText(blob, entry);
  return out;
}

test('reads deflated entries, including non-ASCII names and text', async () => {
  assert.deepEqual(await readAll(h.makeZip(files)), files);
});

test('reads stored (uncompressed) entries', async () => {
  assert.deepEqual(await readAll(h.makeZip(files, { store: true })), files);
});

test('reads ZIP64 archives', async () => {
  assert.deepEqual(await readAll(h.makeZip(files, { zip64: true })), files);
});

test('finds the directory past an archive comment', async () => {
  assert.deepEqual(await readAll(h.makeZip(files, { comment: 'exported by instagram' })), files);
});

test('end to end: zip in, list of non-followers out', async () => {
  const blob = new Blob([h.makeZip(files)]);
  const wanted = (await IgZip.listEntries(blob)).filter((e) => IgParse.classifyFile(e.name));
  const texts = await Promise.all(wanted.map(async (e) => ({ path: e.name, text: await IgZip.readText(blob, e) })));
  const result = IgParse.analyze(texts);
  assert.deepEqual(result.notFollowingYouBack.map((a) => a.username), ['carol']);
});

test('rejects files that are not ZIP archives', async () => {
  await assert.rejects(IgZip.listEntries(new Blob(['just some text'])), /not a ZIP archive/);
});
