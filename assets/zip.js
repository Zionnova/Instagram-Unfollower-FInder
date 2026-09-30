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

  var DAMAGED = 'This .zip file is incomplete or damaged. If the download was interrupted, download the export again.';

  // Returns [{ name, method, flags, compressedSize, size, offset }].
  async function listEntries(blob) {
    try {
      return await readDirectory(blob);
    } catch (err) {
      // A cut-off download usually fails as an out-of-range read; say what it means.
      if (err instanceof RangeError) throw new Error(DAMAGED);
      throw err;
    }
  }

  async function readDirectory(blob) {
    // The end-of-central-directory record is 22 bytes plus a comment of up to 64 KiB.
    var tailLength = Math.min(blob.size, 22 + 0xffff);
    var tailStart = blob.size - tailLength;
    var tail = await readView(blob, tailStart, tailLength);
    // Scan backwards; prefer a record whose comment length reaches exactly to
    // the end of the file, so a signature inside the comment can't fool us.
    var eocd = -1;
    for (var i = tail.byteLength - 22; i >= 0; i--) {
      if (tail.getUint32(i, true) !== SIG_EOCD) continue;
      if (eocd < 0) eocd = i;
      if (i + 22 + tail.getUint16(i + 20, true) === tail.byteLength) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) {
      var head = blob.size >= 4 ? await readView(blob, 0, 4) : null;
      if (head && head.getUint32(0, true) === SIG_LOCAL) throw new Error(DAMAGED);
      throw new Error('This file isn’t a .zip archive. Choose the .zip file Instagram sent you.');
    }

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

    if (dirOffset + dirSize > blob.size) throw new Error(DAMAGED);
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
    if (entry.offset + 30 > blob.size) throw new Error(DAMAGED);
    var local = await readView(blob, entry.offset, 30);
    if (local.getUint32(0, true) !== SIG_LOCAL) throw new Error(DAMAGED);
    var start = entry.offset + 30 + local.getUint16(26, true) + local.getUint16(28, true);
    if (start + entry.compressedSize > blob.size) throw new Error(DAMAGED);
    var data = blob.slice(start, start + entry.compressedSize);

    var bytes;
    if (entry.method === 0) {
      bytes = await data.arrayBuffer();
    } else if (entry.method === 8) {
      if (typeof DecompressionStream === 'undefined') {
        throw new Error('This browser can’t unzip files. Update it, or unzip the export yourself and choose the folder.');
      }
      try {
        bytes = await new Response(data.stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer();
      } catch (err) {
        throw new Error(DAMAGED);
      }
    } else {
      throw new Error(entry.name + ' uses a compression method this page can’t read (' + entry.method + '). Unzip the export yourself and choose the folder.');
    }
    // A damaged entry can inflate to the wrong length without an error.
    if (bytes.byteLength !== entry.size) throw new Error(DAMAGED);
    return utf8.decode(bytes);
  }

  return { listEntries: listEntries, readText: readText };
});
