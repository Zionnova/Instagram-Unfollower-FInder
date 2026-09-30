'use strict';
// Test helpers: fake Instagram exports and a small ZIP writer.

const zlib = require('node:zlib');

function crc32(buf) {
  let c;
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// files: { 'path/in/zip': string }. Options:
//   store: true   -> no compression
//   zip64: true   -> write ZIP64 end records and ZIP64 extra fields
//   comment: str  -> archive comment
function makeZip(files, { store = false, zip64 = false, comment = '' } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameBuf = Buffer.from(name, 'utf8');
    const raw = Buffer.from(content, 'utf8');
    const data = store ? raw : zlib.deflateRawSync(raw);
    const method = store ? 0 : 8;
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(zip64 ? 45 : 20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, data);

    let extra = Buffer.alloc(0);
    if (zip64) {
      extra = Buffer.alloc(4 + 24);
      extra.writeUInt16LE(0x0001, 0);
      extra.writeUInt16LE(24, 2);
      extra.writeBigUInt64LE(BigInt(raw.length), 4);
      extra.writeBigUInt64LE(BigInt(data.length), 12);
      extra.writeBigUInt64LE(BigInt(offset), 20);
    }
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(zip64 ? 45 : 20, 4);
    central.writeUInt16LE(zip64 ? 45 : 20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(zip64 ? 0xffffffff : data.length, 20);
    central.writeUInt32LE(zip64 ? 0xffffffff : raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(extra.length, 30);
    central.writeUInt32LE(zip64 ? 0xffffffff : offset, 42);
    centrals.push(central, nameBuf, extra);

    offset += local.length + nameBuf.length + data.length;
  }
  const dir = Buffer.concat(centrals);
  const count = Object.keys(files).length;
  const tail = [];
  if (zip64) {
    const rec = Buffer.alloc(56);
    rec.writeUInt32LE(0x06064b50, 0);
    rec.writeBigUInt64LE(44n, 4);
    rec.writeUInt16LE(45, 12);
    rec.writeUInt16LE(45, 14);
    rec.writeBigUInt64LE(BigInt(count), 24);
    rec.writeBigUInt64LE(BigInt(count), 32);
    rec.writeBigUInt64LE(BigInt(dir.length), 40);
    rec.writeBigUInt64LE(BigInt(offset), 48);
    const loc = Buffer.alloc(20);
    loc.writeUInt32LE(0x07064b50, 0);
    loc.writeBigUInt64LE(BigInt(offset + dir.length), 8);
    loc.writeUInt32LE(1, 16);
    tail.push(rec, loc);
  }
  const commentBuf = Buffer.from(comment, 'utf8');
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(zip64 ? 0xffff : count, 8);
  eocd.writeUInt16LE(zip64 ? 0xffff : count, 10);
  eocd.writeUInt32LE(zip64 ? 0xffffffff : dir.length, 12);
  eocd.writeUInt32LE(zip64 ? 0xffffffff : offset, 16);
  eocd.writeUInt16LE(commentBuf.length, 20);
  return Buffer.concat([...locals, dir, ...tail, eocd, commentBuf]);
}

// Layout of followers_1.json (all versions so far).
function followersJson(entries) {
  return JSON.stringify(
    entries.map(([u, ts]) => ({
      title: '',
      media_list_data: [],
      string_list_data: [{ href: `https://www.instagram.com/${u}`, value: u, timestamp: ts }]
    }))
  );
}

// following.json before late 2024: username in string_list_data[].value.
function followingJsonOld(entries) {
  return JSON.stringify({
    relationships_following: entries.map(([u, ts]) => ({
      title: '',
      media_list_data: [],
      string_list_data: [{ href: `https://www.instagram.com/${u}`, value: u, timestamp: ts }]
    }))
  });
}

// following.json from late 2024: username in "title", link via /_u/, no "value".
function followingJsonNew(entries) {
  return JSON.stringify({
    relationships_following: entries.map(([u, ts]) => ({
      title: u,
      string_list_data: [{ href: `https://www.instagram.com/_u/${u}`, timestamp: ts }]
    }))
  });
}

function followersHtml(usernames) {
  const rows = usernames
    .map(
      (u) =>
        `<div class="pam _3-95 _2ph- _a6-g uiBoxWhite noborder"><div class="_a6-p"><div><div>` +
        `<a target="_blank" href="https://www.instagram.com/${u}">${u}</a></div><div>Mar 3, 2024 9:12 pm</div></div></div></div>`
    )
    .join('');
  return `<html><head><title>Followers</title></head><body><a href="../../index.html">Back</a>` +
    `<div class="_a706" role="main">${rows}</div></body></html>`;
}

function followingHtml(usernames) {
  const rows = usernames
    .map(
      (u) =>
        `<div class="pam _3-95 _2ph- _a6-g uiBoxWhite noborder"><h2 class="_3-95 _2pim _a6-h _a6-i">${u}</h2>` +
        `<div class="_3-95 _a6-p"><div><div><a target="_blank" href="https://www.instagram.com/_u/${u}">https://www.instagram.com/_u/${u}</a></div>` +
        `<div>Mar 3, 2024 9:12 pm</div></div></div></div>`
    )
    .join('');
  return `<html><head><title>Following</title></head><body>` +
    `<a href="https://help.instagram.com/">Help</a><div class="_a706" role="main">${rows}</div></body></html>`;
}

// 2026 layout: every field is a {label, value} pair, and the labels are
// translated into the account's language.
function labelValuesJson(entries, labels = { url: 'URL', name: 'Name', username: 'Username' }, { wrap } = {}) {
  const records = entries.map(([u, ts, displayName]) => ({
    timestamp: ts,
    media: [],
    label_values: [
      { label: labels.url, value: '' },
      { label: labels.name, value: displayName ?? `${u.charAt(0).toUpperCase()}${u.slice(1)} Person` },
      { label: labels.username, value: u }
    ],
    fbid: '17800000000000001'
  }));
  return JSON.stringify(wrap ? { [wrap]: records } : records);
}

// HTML version of the label layout: one table per record, date after it.
function labelTableHtml(entries, labels = { name: 'Name', username: 'Username' }) {
  const rows = entries
    .map(
      ([u, date]) =>
        `<div class="pam _3-95 _2ph- _a6-g uiBoxWhite noborder"><div class="_3-95 _a6-p"><div class="pam _3-95 _2ph- _a6-g uiBoxWhite noborder">` +
        `<div class="_a6-p"><table style="table-layout: fixed;"><tr><td class="_a6_q">${labels.name}</td><td class="_2piu _a6_r">Some Name</td></tr>` +
        `<tr><td class="_a6_q">${labels.username}</td><td class="_2piu _a6_r">${u}</td></tr></table></div></div></div>` +
        `<div class="_3-94 _a6-o">${date}</div></div>`
    )
    .join('');
  return `<html><body><main class="_a706" role="main">${rows}</main></body></html>`;
}

module.exports = {
  makeZip,
  followersJson,
  followingJsonOld,
  followingJsonNew,
  followersHtml,
  followingHtml,
  labelValuesJson,
  labelTableHtml
};
