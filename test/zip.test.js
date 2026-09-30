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
  await assert.rejects(IgZip.listEntries(new Blob(['just some text'])), /isn’t a \.zip archive/);
});

test('a download cut off partway says so', async () => {
  const zip = h.makeZip(files);
  await assert.rejects(IgZip.listEntries(new Blob([zip.subarray(0, Math.floor(zip.length / 2))])), /incomplete or damaged/);
});

test('a damaged entry is caught instead of read as garbage', async () => {
  const zip = Buffer.from(h.makeZip(files));
  const blob = new Blob([zip]);
  const entries = await IgZip.listEntries(blob);
  const big = entries.find((e) => e.name.endsWith('big.txt'));
  // Flip bytes in the middle of the compressed data.
  const damaged = Buffer.from(zip);
  const mid = big.offset + 30 + Buffer.byteLength(big.name) + Math.floor(big.compressedSize / 2);
  for (let i = 0; i < 16; i++) damaged[mid + i] ^= 0xff;
  await assert.rejects(IgZip.readText(new Blob([damaged]), big), /incomplete or damaged/);
});

test('a signature-like sequence inside the archive comment does not confuse the reader', async () => {
  const fake = Buffer.alloc(22);
  fake.writeUInt32LE(0x06054b50, 0);
  fake.writeUInt16LE(7, 10);
  assert.deepEqual(await readAll(h.makeZip(files, { comment: 'x' + fake.toString('latin1') + 'y' })), files);
});
