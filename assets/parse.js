/*
 * Reads the follower/following files from an Instagram "Download your
 * information" export and works out who doesn't follow you back.
 *
 * Handles every layout seen so far:
 *   - JSON where the username is in string_list_data[].value (2022-2024)
 *   - JSON where the username moved to "title" and the link became
 *     instagram.com/_u/<name> (late 2024 onward, following.json)
 *   - the HTML export format
 *
 * Works in the browser (window.IgParse) and in Node (require).
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.IgParse = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Instagram usernames: letters, digits, "." and "_", at most 30 chars.
  var USERNAME_RE = /^[a-z0-9._]{1,30}$/;

  // First path segments on instagram.com that are site pages, not profiles.
  var RESERVED_PATHS = new Set([
    'about', 'accounts', 'challenge', 'developer', 'direct', 'emails',
    'explore', 'legal', 'p', 'reel', 'reels', 'session', 'stories', 'tv', 'web'
  ]);

  function normalizeUsername(raw) {
    if (typeof raw !== 'string') return null;
    var u = raw.trim().replace(/^@/, '').toLowerCase();
    return USERNAME_RE.test(u) ? u : null;
  }

  // https://www.instagram.com/alice, .../alice/, .../_u/alice -> "alice"
  function usernameFromHref(href) {
    if (typeof href !== 'string') return null;
    var url;
    try {
      url = new URL(href.trim()); // no base: relative links are not profiles
    } catch (e) {
      return null;
    }
    if (!/(^|\.)instagram\.com$/i.test(url.hostname)) return null;
    var segments = url.pathname.split('/').filter(Boolean);
    if (segments[0] === '_u') segments.shift();
    if (segments.length !== 1) return null;
    var u = normalizeUsername(segments[0]);
    return u && !RESERVED_PATHS.has(u) ? u : null;
  }

  // Which list a file belongs to, judged by its name:
  // followers_1.json, followers_2.json, following.json, following.html ...
  // Deliberately ignores following_hashtags.json, close_friends.json, etc.
  function classifyFile(path) {
    var name = String(path).split(/[\\/]/).pop().toLowerCase();
    var m = /^(followers|following)(?:_\d+)?\.(json|html?)$/.exec(name);
    if (!m) return null;
    return { list: m[1], format: m[2] === 'json' ? 'json' : 'html', name: name };
  }

  function entriesFromJson(data) {
    if (Array.isArray(data)) return data;
    if (data && typeof data === 'object') {
      var keys = Object.keys(data);
      for (var i = 0; i < keys.length; i++) {
        if (keys[i].indexOf('relationships_') === 0 && Array.isArray(data[keys[i]])) return data[keys[i]];
      }
      for (var j = 0; j < keys.length; j++) {
        if (Array.isArray(data[keys[j]])) return data[keys[j]];
      }
    }
    return [];
  }

  // One JSON entry -> { username, timestamp } or null if no username can be found.
  function readJsonEntry(entry) {
    if (!entry || typeof entry !== 'object') return null;
    var items = Array.isArray(entry.string_list_data) ? entry.string_list_data : [];
    var timestamp = null;
    for (var i = 0; i < items.length; i++) {
      if (items[i] && Number.isFinite(items[i].timestamp)) {
        timestamp = items[i].timestamp;
        break;
      }
    }
    for (var k = 0; k < items.length; k++) {
      var item = items[k];
      if (!item) continue;
      var u = normalizeUsername(item.value) || usernameFromHref(item.href);
      if (u) return { username: u, timestamp: timestamp };
    }
    var fromTitle = normalizeUsername(entry.title);
    return fromTitle ? { username: fromTitle, timestamp: timestamp } : null;
  }

  function decodeEntities(s) {
    return s
      .replace(/&#(\d+);/g, function (_, n) { return String.fromCharCode(Number(n)); })
      .replace(/&#x([0-9a-f]+);/gi, function (_, n) { return String.fromCharCode(parseInt(n, 16)); })
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&');
  }

  // Returns { accounts: [{ username, timestamp }], skipped: number }.
  function parseFile(format, text) {
    var accounts = [];
    var skipped = 0;
    if (format === 'json') {
      var entries = entriesFromJson(JSON.parse(text));
      for (var i = 0; i < entries.length; i++) {
        var acc = readJsonEntry(entries[i]);
        if (acc) accounts.push(acc);
        else skipped++;
      }
    } else {
      // The HTML export has no stable structure worth relying on, but every
      // account is an absolute link to its profile. Dates are written in the
      // account's language, so they are not parsed.
      var re = /href\s*=\s*["']([^"']+)["']/gi;
      var m;
      while ((m = re.exec(text))) {
        var u = usernameFromHref(decodeEntities(m[1]));
        if (u) accounts.push({ username: u, timestamp: null });
      }
    }
    return { accounts: accounts, skipped: skipped };
  }

  function MissingListError(list) {
    var err = new Error(
      list === 'followers'
        ? 'No followers file was found (followers_1.json or followers_1.html). Make sure your download includes "Followers and following".'
        : 'No following file was found (following.json or following.html). Make sure your download includes "Followers and following".'
    );
    err.code = 'missing-' + list;
    return err;
  }

  // files: [{ path, text }]. Files that aren't follower/following lists are ignored.
  function analyze(files) {
    var lists = { followers: new Map(), following: new Map() };
    var read = { followers: [], following: [] };
    var skipped = 0;

    files.forEach(function (file) {
      var kind = classifyFile(file.path);
      if (!kind) return;
      var parsed;
      try {
        parsed = parseFile(kind.format, file.text);
      } catch (e) {
        throw new Error('Could not read ' + kind.name + ': ' + e.message);
      }
      read[kind.list].push(kind.name);
      skipped += parsed.skipped;
      var map = lists[kind.list];
      parsed.accounts.forEach(function (acc) {
        if (!map.has(acc.username)) map.set(acc.username, acc.timestamp);
      });
    });

    if (!read.followers.length) throw MissingListError('followers');
    if (!read.following.length) throw MissingListError('following');

    function difference(a, b) {
      var out = [];
      a.forEach(function (timestamp, username) {
        if (!b.has(username)) out.push({ username: username, timestamp: timestamp });
      });
      return out;
    }

    var notFollowingYouBack = difference(lists.following, lists.followers);
    return {
      followingCount: lists.following.size,
      followersCount: lists.followers.size,
      mutualCount: lists.following.size - notFollowingYouBack.length,
      // Accounts you follow that don't follow you. timestamp = when you followed them.
      notFollowingYouBack: notFollowingYouBack,
      // Accounts that follow you that you don't follow. timestamp = when they followed you.
      youDontFollowBack: difference(lists.followers, lists.following),
      filesRead: read.followers.concat(read.following),
      skippedEntries: skipped
    };
  }

  return {
    analyze: analyze,
    classifyFile: classifyFile,
    parseFile: parseFile,
    usernameFromHref: usernameFromHref,
    normalizeUsername: normalizeUsername
  };
});
