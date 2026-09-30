/*
 * Minimal read-only ZIP reader for the browser (window.IgZip) and Node.
 *
 * It reads only the central directory and the few files asked for, using
 * Blob.slice, so a multi-gigabyte Instagram export never has to fit in
 * memory. Supports stored and deflated entries and ZIP64 archives.
 * Decompression uses the built-in DecompressionStream.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.IgZip = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SIG_EOCD = 0x06054b50;
  var SIG_ZIP64_LOCATOR = 0x07064b50;
  var SIG_ZIP64_EOCD = 0x06064b50;
  var SIG_CENTRAL = 0x02014b50;
  var SIG_LOCAL = 0x04034b50;

  var utf8 = new TextDecoder('utf-8');

  async function readView(blob, start, length) {
    var buf = await blob.slice(start, start + length).arrayBuffer();
    return new DataView(buf);
  }

  function u64(view, offset) {
    return Number(view.getBigUint64(offset, true));
  }

  // Returns [{ name, method, flags, compressedSize, size, offset }].
  async function listEntries(blob) {
    // The end-of-central-directory record is 22 bytes plus a comment of up to 64 KiB.
    var tailLength = Math.min(blob.size, 22 + 0xffff);
    var tailStart = blob.size - tailLength;
    var tail = await readView(blob, tailStart, tailLength);
    var eocd = -1;
    for (var i = tail.byteLength - 22; i >= 0; i--) {
      if (tail.getUint32(i, true) === SIG_EOCD) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error('This file is not a ZIP archive, or it is damaged.');

    var count = tail.getUint16(eocd + 10, true);
    var dirSize = tail.getUint32(eocd + 12, true);
    var dirOffset = tail.getUint32(eocd + 16, true);

    if (count === 0xffff || dirSize === 0xffffffff || dirOffset === 0xffffffff) {
      var locator = eocd - 20;
      if (locator < 0 || tail.getUint32(locator, true) !== SIG_ZIP64_LOCATOR) {
        throw new Error('This ZIP archive is damaged (missing ZIP64 locator).');
      }
      var z64 = await readView(blob, u64(tail, locator + 8), 56);
      if (z64.getUint32(0, true) !== SIG_ZIP64_EOCD) {
        throw new Error('This ZIP archive is damaged (bad ZIP64 record).');
      }
      count = u64(z64, 32);
      dirSize = u64(z64, 40);
      dirOffset = u64(z64, 48);
    }

    var dir = await readView(blob, dirOffset, dirSize);
    var entries = [];
    var p = 0;
    for (var n = 0; n < count; n++) {
      if (dir.getUint32(p, true) !== SIG_CENTRAL) {
        throw new Error('This ZIP archive is damaged (bad central directory).');
      }
      var flags = dir.getUint16(p + 8, true);
      var method = dir.getUint16(p + 10, true);
      var compressedSize = dir.getUint32(p + 20, true);
      var size = dir.getUint32(p + 24, true);
      var nameLength = dir.getUint16(p + 28, true);
      var extraLength = dir.getUint16(p + 30, true);
      var commentLength = dir.getUint16(p + 32, true);
      var offset = dir.getUint32(p + 42, true);
      var name = utf8.decode(new Uint8Array(dir.buffer, dir.byteOffset + p + 46, nameLength));

      // ZIP64 extra field: only the values that overflowed are present, in this order.
      var e = p + 46 + nameLength;
      var extraEnd = e + extraLength;
      while (e + 4 <= extraEnd) {
        var id = dir.getUint16(e, true);
        var len = dir.getUint16(e + 2, true);
        if (id === 0x0001) {
          var q = e + 4;
          if (size === 0xffffffff) { size = u64(dir, q); q += 8; }
          if (compressedSize === 0xffffffff) { compressedSize = u64(dir, q); q += 8; }
          if (offset === 0xffffffff) { offset = u64(dir, q); q += 8; }
        }
        e += 4 + len;
      }

      entries.push({
        name: name,
        method: method,
        flags: flags,
        compressedSize: compressedSize,
        size: size,
        offset: offset
      });
      p = extraEnd + commentLength;
    }
    return entries;
  }

  async function readText(blob, entry) {
    if (entry.flags & 1) throw new Error(entry.name + ' is encrypted.');
    var local = await readView(blob, entry.offset, 30);
    if (local.getUint32(0, true) !== SIG_LOCAL) {
      throw new Error('This ZIP archive is damaged (bad entry header for ' + entry.name + ').');
    }
    var start = entry.offset + 30 + local.getUint16(26, true) + local.getUint16(28, true);
    var data = blob.slice(start, start + entry.compressedSize);

    if (entry.method === 0) return utf8.decode(await data.arrayBuffer());
    if (entry.method !== 8) {
      throw new Error(entry.name + ' uses an unsupported compression method (' + entry.method + ').');
    }
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('This browser cannot unzip files. Update it, or unzip the export yourself and choose the extracted folder.');
    }
    var stream = data.stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Response(stream).text();
  }

  return { listEntries: listEntries, readText: readText };
});
