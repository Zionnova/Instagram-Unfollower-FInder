/*
 * Reads the follower/following lists from an Instagram data export and works
 * out who doesn't follow you back.
 *
 * Instagram changes this export often, sometimes one file at a time, so one
 * archive can mix formats. Record shapes seen in real exports:
 *
 *   JSON A  {title: "", string_list_data: [{href, value: <username>, timestamp}]}
 *   JSON B  {title: <username>, string_list_data: [{href, timestamp}]}   (following.json, late 2024 on)
 *   JSON C  {timestamp, label_values: [{label, value}, ...]}             (2026 on; labels are translated)
 *   HTML A/B  one profile link per record, the date in the next <div>
 *   HTML C    one <table> of label/value rows per record, the date after it
 *
 * A list can be a bare array, wrapped in {"relationships_...": [...]}, or a
 * single record with no array around it.
 *
 * The rule throughout: when something can't be read, count it and say so.
 * An unreadable followers file must never turn into "nobody follows you".
 *
 * Works in the browser (window.IgParse) and in Node (require).
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.IgParse = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Instagram usernames: letters, digits, "." and "_", at most 30 characters.
  var USERNAME_RE = /^[a-z0-9._]{1,30}$/;

  // A link to a profile, and nothing else: instagram.com/<name> or instagram.com/_u/<name>.
  var PROFILE_HREF_RE = /^https?:\/\/(?:www\.|m\.)?instagram\.com\/(?:_u\/)?([^\/?#]+)\/?(?:[?#][^\s]*)?$/i;

  // First path segments on instagram.com that are site pages, not profiles.
  var RESERVED_PATHS = new Set([
    'about', 'accounts', 'challenge', 'developer', 'direct', 'emails', 'explore',
    'legal', 'p', 'privacy', 'reel', 'reels', 'session', 'stories', 'tv', 'web'
  ]);

  var DAY = 86400;

  // The export's date range cuts followers_*.json but leaves following.json
  // whole. If the oldest follower is this much newer than the oldest follow,
  // the followers list was almost certainly cut short.
  var SKEW_DAYS = 180;
  var SKEW_MIN_DATES = 10;

  function normalizeUsername(raw) {
    if (typeof raw !== 'string') return null;
    var u = raw.trim().replace(/^@/, '').toLowerCase();
    return USERNAME_RE.test(u) ? u : null;
  }

  function usernameFromHref(href) {
    if (typeof href !== 'string') return null;
    var m = PROFILE_HREF_RE.exec(href.trim());
    if (!m) return null;
    var u = normalizeUsername(m[1]);
    return u && !RESERVED_PATHS.has(u) ? u : null;
  }

  // ---------- which files matter ----------

  // pending_follow_requests: private accounts you asked to follow that haven't
  // accepted. (recent_follow_requests is left alone: what it holds isn't clear
  // enough to take anyone off the list because of it.)
  var FILE_RE = /^(followers(?:_\d+)?|following(?:_\d+)?|pending_follow_requests)\.(json|html?)$/;

  // followers_1.json -> { list: 'followers', shard: 'followers_1', format: 'json', ... }
  // following_hashtags.json, close_friends.json and the rest -> null.
  function classifyFile(path) {
    var clean = String(path).replace(/\\/g, '/');
    var name = clean.split('/').pop().toLowerCase();
    var m = FILE_RE.exec(name);
    if (!m) return null;
    var shard = m[1];
    return {
      list: shard.indexOf('followers') === 0 ? 'followers' : shard.indexOf('following') === 0 ? 'following' : 'requests',
      shard: shard,
      format: m[2] === 'json' ? 'json' : 'html',
      name: name,
      path: clean,
      inExportFolder: /(^|\/)followers_and_following\//i.test(clean)
    };
  }

  // ---------- dates ----------

  // Month names as Meta abbreviates them, in the languages Instagram exports
  // most often come in. Merged into one table: no token means different
  // months in different languages.
  var MONTHS = (function () {
    var lists = [
      'jan feb mar apr may jun jul aug sep oct nov dec',
      'ene feb mar abr may jun jul ago sep oct nov dic',
      'jan fev mar abr mai jun jul ago set out nov dez',
      'janv févr mars avr mai juin juil août sept oct nov déc',
      'jan feb mär apr mai jun jul aug sep okt nov dez',
      'gen feb mar apr mag giu lug ago set ott nov dic',
      'jan feb mrt apr mei jun jul aug sep okt nov dec',
      'oca şub mar nis may haz tem ağu eyl eki kas ara',
      'sty lut mar kwi maj cze lip sie wrz paź lis gru',
      'янв фев мар апр мая июн июл авг сен окт ноя дек'
    ];
    var extra = {
      sept: 9, märz: 3, juni: 6, juli: 7, fevr: 2, fév: 2, aout: 8,
      февр: 2, май: 5, июня: 6, июля: 7, сент: 9, нояб: 11
    };
    var table = {};
    lists.forEach(function (line) {
      line.split(' ').forEach(function (token, i) { table[token] = i + 1; });
    });
    Object.keys(extra).forEach(function (k) { table[k] = extra[k]; });
    return table;
  })();

  // "Aug 10, 2026 6:32 pm", "ago 10, 2026 6:32 pm", "8月 10, 2026 6:32 PM"
  // -> seconds since 1970 (read as UTC; close enough to sort and compare).
  function parseExportDate(text) {
    if (typeof text !== 'string') return null;
    var s = text.normalize ? text.normalize('NFC') : text;
    var yearMatch = /(?:^|[^\d])((?:19|20)\d\d)(?![\d])/.exec(s);
    if (!yearMatch) return null;
    var year = Number(yearMatch[1]);

    var rest = s.replace(yearMatch[1], ' ');
    var month = null;
    var numericMonth = /(\d{1,2})\s*[月월]/.exec(rest);
    if (numericMonth) {
      month = Number(numericMonth[1]);
      rest = rest.replace(numericMonth[0], ' ');
    } else {
      var words = rest.toLowerCase().match(/[^\s\d.,:;\/()\-]+/g) || [];
      for (var i = 0; i < words.length && month === null; i++) {
        if (Object.prototype.hasOwnProperty.call(MONTHS, words[i])) month = MONTHS[words[i]];
      }
    }
    if (!month || month > 12) return null;

    var hour = 0;
    var minute = 0;
    var time = /(\d{1,2}):(\d{2})/.exec(rest);
    if (time) {
      hour = Number(time[1]);
      minute = Number(time[2]);
      rest = rest.replace(time[0], ' ');
      var pm = /\bpm\b|午後|오후/i.test(s);
      var am = /\bam\b|午前|오전/i.test(s);
      if (pm && hour < 12) hour += 12;
      if (am && hour === 12) hour = 0;
    }
    var dayMatch = /(?:^|[^\d])(\d{1,2})(?![\d])/.exec(rest);
    var day = dayMatch ? Number(dayMatch[1]) : 1;
    if (day < 1 || day > 31 || hour > 23 || minute > 59) return null;
    return Date.UTC(year, month - 1, day, hour, minute) / 1000;
  }

  // ---------- reading one file ----------

  function isFiniteNumber(n) {
    return typeof n === 'number' && isFinite(n) && n > 0;
  }

  function looksLikeRecord(x) {
    return !!x && typeof x === 'object' && !Array.isArray(x) &&
      ('string_list_data' in x || 'label_values' in x || 'title' in x);
  }

  // The array of records inside a parsed JSON file, or null when the shape is unknown.
  function recordList(data) {
    if (Array.isArray(data)) return data;
    if (!data || typeof data !== 'object') return null;
    var keys = Object.keys(data);
    for (var i = 0; i < keys.length; i++) {
      if (/^relationships_/.test(keys[i]) && Array.isArray(data[keys[i]])) return data[keys[i]];
    }
    if (looksLikeRecord(data)) return [data];
    for (var j = 0; j < keys.length; j++) {
      var v = data[keys[j]];
      if (Array.isArray(v) && (v.length === 0 || v.some(looksLikeRecord))) return v;
    }
    return null;
  }

  // One JSON record -> { username, timestamp } | { labelValues, timestamp } | { unreadable: true }
  function readJsonRecord(entry) {
    if (!entry || typeof entry !== 'object') return { unreadable: true };
    var items = Array.isArray(entry.string_list_data) ? entry.string_list_data.filter(Boolean) : [];
    var timestamp = isFiniteNumber(entry.timestamp) ? entry.timestamp : null;
    for (var i = 0; i < items.length; i++) {
      if (isFiniteNumber(items[i].timestamp)) { timestamp = items[i].timestamp; break; }
    }
    var u;
    for (var a = 0; a < items.length; a++) {
      u = normalizeUsername(items[a].value);
      if (u) return { username: u, timestamp: timestamp };
    }
    u = normalizeUsername(entry.title);
    if (u) return { username: u, timestamp: timestamp };
    for (var b = 0; b < items.length; b++) {
      u = usernameFromHref(items[b].href);
      if (u) return { username: u, timestamp: timestamp };
    }
    if (Array.isArray(entry.label_values)) {
      var pairs = entry.label_values
        .filter(function (p) { return p && typeof p.label === 'string'; })
        .map(function (p) { return { label: p.label, value: typeof p.value === 'string' ? p.value : '' }; });
      if (pairs.length) return { labelValues: pairs, timestamp: timestamp };
    }
    return { unreadable: true };
  }

  function decodeHtmlText(s) {
    return s
      .replace(/<[^>]*>/g, '')
      .replace(/&#(\d+);/g, function (_, n) { return String.fromCodePoint(Number(n)); })
      .replace(/&#x([0-9a-f]+);/gi, function (_, n) { return String.fromCodePoint(parseInt(n, 16)); })
      .replace(/&nbsp;/g, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;|&apos;/g, "'")
      .replace(/&amp;/g, '&')
      .trim();
  }

  // The first date written after `from`, before the next record starts.
  function dateAfter(html, from) {
    var slice = html.slice(from, from + 800);
    var stop = slice.search(/<a\b|<table\b|<h2\b/i);
    if (stop >= 0) slice = slice.slice(0, stop);
    var re = />([^<>]{6,80})</g;
    var m;
    while ((m = re.exec(slice))) {
      var ts = parseExportDate(decodeHtmlText(m[1]));
      if (ts !== null) return ts;
    }
    return null;
  }

  function readHtml(html) {
    var records = [];
    var m;

    // HTML C: a table of label/value rows per record. Files written this way
    // have no profile links (measured), and a link inside a table is someone's
    // bio link, so when tables hold records they are read on their own.
    var tableRe = /<table\b[\s\S]*?<\/table>/gi;
    var rowRe = /<tr\b[^>]*>\s*<td\b[^>]*>([\s\S]*?)<\/td>\s*<td\b[^>]*>([\s\S]*?)<\/td>\s*<\/tr>/gi;
    while ((m = tableRe.exec(html))) {
      var pairs = [];
      var row;
      rowRe.lastIndex = 0;
      while ((row = rowRe.exec(m[0]))) {
        pairs.push({ label: decodeHtmlText(row[1]), value: decodeHtmlText(row[2]) });
      }
      if (pairs.length) records.push({ labelValues: pairs, timestamp: dateAfter(html, tableRe.lastIndex) });
    }

    if (!records.length) {
      // HTML A/B: one profile link per record.
      var linkRe = /<a\b[^>]*?\bhref\s*=\s*(["'])(.*?)\1[^>]*>/gi;
      while ((m = linkRe.exec(html))) {
        var u = usernameFromHref(decodeHtmlText(m[2]));
        if (u) records.push({ username: u, timestamp: dateAfter(html, linkRe.lastIndex) });
      }
    }

    // Every record sits in a "uiBoxWhite" box. Boxes without anything we can
    // read mean the format changed, not that the list is empty.
    var boxes = (html.match(/class\s*=\s*"[^"]*\buiBoxWhite\b/g) || []).length;
    if (!records.length && boxes) {
      for (var i = 0; i < boxes; i++) records.push({ unreadable: true });
    }
    return { records: records, shapeKnown: true };
  }

  function readFile(format, text) {
    if (format === 'html') return readHtml(text);
    var list = recordList(JSON.parse(text));
    if (list === null) return { records: [], shapeKnown: false };
    return { records: list.map(readJsonRecord), shapeKnown: true };
  }

  // ---------- translated labels (JSON C / HTML C) ----------

  // Which label holds the username. Labels are translated ("Username",
  // "Nombre de usuario", ...) and sometimes garbled by a double encoding, so
  // the label is found by how its values look across the whole export, not
  // by its name. Returns null when no label is a clear winner: guessing wrong
  // would invent accounts.
  function resolveUsernameLabel(labelled, knownUsernames) {
    var tallies = new Map();
    labelled.forEach(function (rec) {
      rec.labelValues.forEach(function (pair) {
        var t = tallies.get(pair.label);
        if (!t) tallies.set(pair.label, (t = { scored: 0, strict: 0, hits: 0 }));
        var v = pair.value.trim();
        if (!v) return;
        t.scored++;
        // Usernames in the export are always lowercase; display names rarely are.
        if (USERNAME_RE.test(v)) t.strict++;
        if (knownUsernames.has(v.toLowerCase())) t.hits++;
      });
    });
    if (!tallies.size) return null;

    var labels = Array.from(tallies.keys());
    for (var i = 0; i < labels.length; i++) {
      if (labels[i].trim().toLowerCase() === 'username') return labels[i];
    }

    var maxScored = Math.max.apply(null, labels.map(function (l) { return tallies.get(l).scored; }));
    var ranked = labels
      .filter(function (l) { var t = tallies.get(l); return t.scored > 0 && t.scored >= maxScored / 2; })
      .map(function (l) { var t = tallies.get(l); return { label: l, rate: t.strict / t.scored, hits: t.hits }; })
      .sort(function (a, b) { return b.rate - a.rate; });
    var top = ranked[0];
    var next = ranked[1];
    if (top && top.rate >= 0.9 && (!next || top.rate >= next.rate * 2)) return top.label;

    // Still tied: the username label is the one whose values are accounts
    // already known from the other lists.
    ranked.sort(function (a, b) { return b.hits - a.hits; });
    if (ranked[0] && ranked[0].hits > 0 && (!ranked[1] || ranked[0].hits > ranked[1].hits)) return ranked[0].label;
    return null;
  }

  // ---------- the comparison ----------

  function AnalysisError(code, message) {
    var err = new Error(message);
    err.code = code;
    return err;
  }

  function newestDate(records) {
    var newest = null;
    records.forEach(function (r) {
      if (r.timestamp != null && (newest === null || r.timestamp > newest)) newest = r.timestamp;
    });
    return newest;
  }

  function directUsernames(records) {
    var set = new Set();
    records.forEach(function (r) { if (r.username) set.add(r.username); });
    return set;
  }

  // Several copies of one file (a JSON and an HTML twin, both of Instagram's
  // folder layouts, or two exports chosen together): read exactly one.
  // Merging copies taken on different days would count people who have since
  // unfollowed.
  function pickCopy(copies) {
    var ranked = copies.slice().sort(function (a, b) {
      if (a.parsed.shapeKnown !== b.parsed.shapeKnown) return a.parsed.shapeKnown ? -1 : 1;
      var na = newestDate(a.parsed.records);
      var nb = newestDate(b.parsed.records);
      if (na !== null && nb !== null && Math.abs(na - nb) > 2 * DAY) return nb - na;
      if (a.kind.format !== b.kind.format) return a.kind.format === 'json' ? -1 : 1;
      var ca = /(^|\/)connections\//i.test(a.kind.path);
      var cb = /(^|\/)connections\//i.test(b.kind.path);
      if (ca !== cb) return ca ? -1 : 1;
      return 0;
    });
    var chosen = ranked[0];
    var chosenNames = directUsernames(chosen.parsed.records);
    var differs = ranked.slice(1).some(function (other) {
      if (other.parsed.records.length !== chosen.parsed.records.length) return true;
      var names = directUsernames(other.parsed.records);
      if (names.size !== chosenNames.size) return true;
      var same = true;
      names.forEach(function (n) { if (!chosenNames.has(n)) same = false; });
      return !same;
    });
    return { chosen: chosen, conflicting: differs };
  }

  function oldestDate(map) {
    var count = 0;
    var oldest = null;
    map.forEach(function (ts) {
      if (ts == null) return;
      count++;
      if (oldest === null || ts < oldest) oldest = ts;
    });
    return count >= SKEW_MIN_DATES ? oldest : null;
  }

  // Compares where the two lists begin. See SKEW_DAYS.
  function detectSkew(following, followers) {
    var followingSince = oldestDate(following);
    var followersSince = oldestDate(followers);
    if (followingSince === null || followersSince === null) return { verdict: 'unknown' };
    var gap = followersSince - followingSince;
    var verdict = gap > SKEW_DAYS * DAY ? 'followers-cut' : gap < -SKEW_DAYS * DAY ? 'following-cut' : 'ok';
    return { verdict: verdict, followingSince: followingSince, followersSince: followersSince };
  }

  // files: [{ path, text }]. Files other than the lists are ignored.
  function analyze(files) {
    var copies = [];
    files.forEach(function (file) {
      var kind = classifyFile(file.path);
      if (kind) copies.push({ kind: kind, text: file.text });
    });

    // Inside an export, the lists live in a followers_and_following folder.
    // When that folder is there, look nowhere else.
    if (copies.some(function (c) { return c.kind.inExportFolder; })) {
      copies = copies.filter(function (c) { return c.kind.inExportFolder; });
    }

    var warnings = [];
    copies = copies.filter(function (c) {
      try {
        c.parsed = readFile(c.kind.format, c.text);
        return true;
      } catch (e) {
        if (c.kind.list === 'requests') {
          warnings.push({ code: 'requests-unreadable', file: c.kind.name });
          return false;
        }
        throw AnalysisError('damaged-file', c.kind.name + ' is damaged and can’t be read (' + e.message + '). Try downloading the export again.');
      }
    });

    var byShard = new Map();
    copies.forEach(function (c) {
      var group = byShard.get(c.kind.shard);
      if (!group) byShard.set(c.kind.shard, (group = []));
      group.push(c);
    });

    var chosen = [];
    byShard.forEach(function (group, shard) {
      var pick = pickCopy(group);
      chosen.push(pick.chosen);
      if (pick.conflicting) warnings.push({ code: 'duplicate-copies', file: shard, used: pick.chosen.kind.path });
    });
    chosen.sort(function (a, b) { return a.kind.path < b.kind.path ? -1 : a.kind.path > b.kind.path ? 1 : 0; });

    var hasList = { followers: false, following: false };
    chosen.forEach(function (c) { if (c.kind.list !== 'requests') hasList[c.kind.list] = true; });
    if (!hasList.followers) {
      throw AnalysisError('missing-followers', 'Your followers list isn’t in what you chose (followers_1.json or followers_1.html). Make sure the export includes “Followers and following”. If Instagram split it into several .zip files, choose them all at once.');
    }
    if (!hasList.following) {
      throw AnalysisError('missing-following', 'The list of accounts you follow isn’t in what you chose (following.json or following.html). Make sure the export includes “Followers and following”. If Instagram split it into several .zip files, choose them all at once.');
    }

    chosen.forEach(function (c) {
      if (!c.parsed.shapeKnown && c.kind.list !== 'requests') {
        throw AnalysisError('unknown-format', c.kind.name + ' is laid out in a way this tool doesn’t recognise. Instagram has probably changed its export format again. Please report it on GitHub so it can be fixed.');
      }
    });

    // Usernames that could be read directly help pick the username label.
    var known = new Set();
    var labelled = [];
    chosen.forEach(function (c) {
      c.parsed.records.forEach(function (r) {
        if (r.username) known.add(r.username);
        else if (r.labelValues) labelled.push(r);
      });
    });
    var usernameLabel = labelled.length ? resolveUsernameLabel(labelled, known) : null;

    function usernameOf(record) {
      if (record.username) return record.username;
      if (!record.labelValues || usernameLabel === null) return null;
      for (var i = 0; i < record.labelValues.length; i++) {
        var pair = record.labelValues[i];
        if (pair.label === usernameLabel) {
          var u = normalizeUsername(pair.value);
          if (u) return u;
        }
      }
      return null;
    }

    var lists = { followers: new Map(), following: new Map(), requests: new Map() };
    var stats = { followers: { records: 0, unreadable: 0 }, following: { records: 0, unreadable: 0 }, requests: { records: 0, unreadable: 0 } };
    var fileReport = [];
    chosen.forEach(function (c) {
      var map = lists[c.kind.list];
      var st = stats[c.kind.list];
      var read = 0;
      c.parsed.records.forEach(function (r) {
        st.records++;
        var u = usernameOf(r);
        if (!u) { st.unreadable++; return; }
        read++;
        if (!map.has(u)) map.set(u, r.timestamp == null ? null : r.timestamp);
      });
      fileReport.push({ path: c.kind.path, list: c.kind.list, records: c.parsed.records.length, read: read });
    });

    ['followers', 'following'].forEach(function (list) {
      var st = stats[list];
      if (st.records > 0 && st.unreadable === st.records) {
        throw AnalysisError('unreadable-' + list,
          'Your ' + (list === 'followers' ? 'followers list' : 'list of accounts you follow') + ' has ' + st.records +
          ' entries, but none of them could be read. Instagram has probably changed its export format again. Please report it on GitHub so it can be fixed.');
      }
      if (st.unreadable > 0) warnings.push({ code: 'partly-unreadable', list: list, unreadable: st.unreadable, records: st.records });
    });
    if (stats.requests.unreadable > 0) warnings.push({ code: 'requests-unreadable', file: 'follow requests' });

    var notFollowingYouBack = [];
    var requested = [];
    lists.following.forEach(function (timestamp, username) {
      if (lists.followers.has(username)) return;
      var item = { username: username, timestamp: timestamp };
      if (lists.requests.has(username)) requested.push(item);
      else notFollowingYouBack.push(item);
    });
    var youDontFollowBack = [];
    lists.followers.forEach(function (timestamp, username) {
      if (!lists.following.has(username)) youDontFollowBack.push({ username: username, timestamp: timestamp });
    });

    // An empty followers list next to a real following list is possible (a new
    // account) but is also what any unread file looks like. Say so.
    if (lists.followers.size === 0 && lists.following.size > 0) {
      warnings.push({ code: 'no-followers' });
    }

    // Only a short followers list is flagged: that is what a date range does,
    // and it is the case that wrongly accuses people. A following list that
    // starts late is normal for accounts that gained followers first.
    var skew = detectSkew(lists.following, lists.followers);
    if (skew.verdict === 'followers-cut') {
      warnings.unshift({ code: 'followers-cut', followingSince: skew.followingSince, followersSince: skew.followersSince });
    }

    return {
      followingCount: lists.following.size,
      followersCount: lists.followers.size,
      mutualCount: lists.following.size - notFollowingYouBack.length - requested.length,
      // Accounts you follow that don't follow you. timestamp = when you followed them.
      notFollowingYouBack: notFollowingYouBack,
      // Private accounts you asked to follow that haven't accepted; left out of the list above.
      requested: requested,
      // Accounts that follow you that you don't follow. timestamp = when they followed you.
      youDontFollowBack: youDontFollowBack,
      warnings: warnings,
      files: fileReport,
      filesRead: fileReport.map(function (f) { return f.path.split('/').pop(); })
    };
  }

  return {
    analyze: analyze,
    classifyFile: classifyFile,
    readFile: readFile,
    parseExportDate: parseExportDate,
    resolveUsernameLabel: resolveUsernameLabel,
    detectSkew: detectSkew,
    usernameFromHref: usernameFromHref,
    normalizeUsername: normalizeUsername
  };
});
