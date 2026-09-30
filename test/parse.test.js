'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const IgParse = require('../assets/parse.js');
const h = require('./helpers.js');

const DIR = 'connections/followers_and_following/';
const names = (list) => list.map((a) => a.username).sort();
const codes = (result) => result.warnings.map((w) => w.code);
const DAY = 86400;
const NOW = 1790700000; // late September 2026

// n accounts, one every `stepDays`, newest first.
function accounts(prefix, n, stepDays, start = NOW) {
  return Array.from({ length: n }, (_, i) => [`${prefix}${i}`, start - i * stepDays * DAY]);
}

// ---------- the basic comparison ----------

test('finds accounts that do not follow back (current JSON layout)', () => {
  const result = IgParse.analyze([
    { path: DIR + 'followers_1.json', text: h.followersJson([['alice', 100], ['bob', 200], ['fan_only', 300]]) },
    { path: DIR + 'following.json', text: h.followingJsonNew([['alice', 110], ['bob', 210], ['celeb', 310], ['old.friend', 410]]) }
  ]);
  assert.deepEqual(names(result.notFollowingYouBack), ['celeb', 'old.friend']);
  assert.deepEqual(names(result.youDontFollowBack), ['fan_only']);
  assert.equal(result.followingCount, 4);
  assert.equal(result.followersCount, 3);
  assert.equal(result.mutualCount, 2);
  assert.deepEqual(result.warnings, []);
  // The date kept is when you followed them.
  assert.equal(result.notFollowingYouBack.find((a) => a.username === 'celeb').timestamp, 310);
});

test('reads the older following.json layout where the username is in "value"', () => {
  const result = IgParse.analyze([
    { path: 'followers_and_following/followers_1.json', text: h.followersJson([['alice', 1]]) },
    { path: 'followers_and_following/following.json', text: h.followingJsonOld([['alice', 1], ['zed', 2]]) }
  ]);
  assert.deepEqual(names(result.notFollowingYouBack), ['zed']);
});

test('merges followers split across several files', () => {
  const result = IgParse.analyze([
    { path: DIR + 'followers_1.json', text: h.followersJson([['a', 1]]) },
    { path: DIR + 'followers_2.json', text: h.followersJson([['b', 1]]) },
    { path: DIR + 'following.json', text: h.followingJsonNew([['a', 1], ['b', 1], ['c', 1]]) }
  ]);
  assert.deepEqual(names(result.notFollowingYouBack), ['c']);
  assert.deepEqual(result.filesRead, ['followers_1.json', 'followers_2.json', 'following.json']);
});

test('usernames are compared case-insensitively and deduplicated', () => {
  const result = IgParse.analyze([
    { path: 'followers_1.json', text: h.followersJson([['Alice', 1]]) },
    { path: 'following.json', text: h.followingJsonNew([['alice', 1], ['ALICE', 2]]) }
  ]);
  assert.equal(result.followingCount, 1);
  assert.equal(result.notFollowingYouBack.length, 0);
});

test('an empty followers list is shown, with a warning to check it', () => {
  const result = IgParse.analyze([
    { path: DIR + 'followers_1.json', text: '[]' },
    { path: DIR + 'following.json', text: h.followingJsonNew([['a', 1], ['b', 2]]) }
  ]);
  assert.equal(result.followersCount, 0);
  assert.deepEqual(names(result.notFollowingYouBack), ['a', 'b']);
  assert.deepEqual(codes(result), ['no-followers']);
});

test('an HTML record directly followed by the next one does not borrow its date', () => {
  const html = '<main>' +
    '<div class="uiBoxWhite"><div><a href="https://www.instagram.com/nodate">nodate</a></div></div>' +
    '<div class="uiBoxWhite"><div><a href="https://www.instagram.com/dated">dated</a></div><div>Aug 01, 2026 3:06 pm</div></div></main>';
  const records = IgParse.readFile('html', html).records;
  assert.equal(records[0].username, 'nodate');
  assert.equal(records[0].timestamp, null);
  assert.equal(records[1].timestamp, Date.UTC(2026, 7, 1, 15, 6) / 1000);
});

test('a single record with no array around it is read', () => {
  const single = JSON.parse(h.followersJson([['solo', 5]]))[0];
  const result = IgParse.analyze([
    { path: DIR + 'followers_1.json', text: JSON.stringify(single) },
    { path: DIR + 'following.json', text: h.followingJsonNew([['solo', 1], ['x', 2]]) }
  ]);
  assert.deepEqual(names(result.notFollowingYouBack), ['x']);
});

// ---------- the 2026 label/value layout (the "everyone doesn't follow back" bug) ----------

test('followers in the translated label layout are read (English labels)', () => {
  const result = IgParse.analyze([
    { path: DIR + 'followers_1.json', text: h.labelValuesJson([['alice', 10], ['bob', 20]]) },
    { path: DIR + 'following.json', text: h.followingJsonNew([['alice', 1], ['bob', 2], ['celeb', 3]]) }
  ]);
  assert.equal(result.followersCount, 2);
  assert.deepEqual(names(result.notFollowingYouBack), ['celeb']);
  assert.deepEqual(result.warnings, []);
});

for (const [language, labels] of [
  ['Spanish', { url: 'URL', name: 'Nombre', username: 'Nombre de usuario' }],
  ['double-encoded Russian', { url: 'URL', name: 'Ð\u0098Ð¼Ñ\u008f', username: 'Ð\u0098Ð¼Ñ\u008f Ð¿Ð¾Ð»ÑŒÐ·Ð¾Ð²Ð°Ñ\u0082ÐµÐ»Ñ\u008f' }],
  ['invented', { url: 'URL', name: 'Όνομα', username: 'Χρήστης' }]
]) {
  test(`the username label is found without knowing its name (${language})`, () => {
    const followers = accounts('fan', 30, 3);
    const result = IgParse.analyze([
      { path: DIR + 'followers_1.json', text: h.labelValuesJson(followers, labels) },
      { path: DIR + 'following.json', text: h.followingJsonNew([...followers.slice(0, 20), ['celeb', NOW]]) }
    ]);
    assert.equal(result.followersCount, 30);
    assert.deepEqual(names(result.notFollowingYouBack), ['celeb']);
  });
}

test('display names that look like usernames do not win the label', () => {
  // A third of the display names are single lowercase words.
  const followers = accounts('fan', 30, 3).map(([u, ts], i) => [u, ts, i % 3 === 0 ? 'lowercase' + i : `Real Name ${i}`]);
  const labels = { url: 'URL', name: 'Nombre', username: 'Usuario' };
  const result = IgParse.analyze([
    { path: DIR + 'followers_1.json', text: h.labelValuesJson(followers, labels) },
    { path: DIR + 'following.json', text: h.followingJsonNew(followers.slice(0, 10)) }
  ]);
  assert.equal(result.followersCount, 30);
  assert.ok(result.notFollowingYouBack.length === 0);
});

test('when the username label cannot be told apart, it fails loudly instead of guessing', () => {
  // Both labels hold username-shaped values and nothing else in the export helps.
  const records = [['aaa', 1], ['bbb', 2]].map(([u, ts]) => ({
    timestamp: ts,
    label_values: [{ label: 'X', value: u }, { label: 'Y', value: u + '_other' }]
  }));
  assert.throws(
    () => IgParse.analyze([
      { path: DIR + 'followers_1.json', text: JSON.stringify(records) },
      { path: DIR + 'following.json', text: h.followingJsonNew([['zzz', 1]]) }
    ]),
    (err) => err.code === 'unreadable-followers'
  );
});

test('the HTML table layout is read, with dates', () => {
  const result = IgParse.analyze([
    { path: DIR + 'followers_1.html', text: h.labelTableHtml([['alice', 'ago 01, 2026 3:06 pm'], ['bob', 'ago 02, 2026 3:06 pm']], { name: 'Nombre', username: 'Nombre de usuario' }) },
    { path: DIR + 'following.html', text: h.followingHtml(['alice', 'bob', 'carol']) }
  ]);
  assert.equal(result.followersCount, 2);
  assert.deepEqual(names(result.notFollowingYouBack), ['carol']);
  assert.deepEqual(names(result.youDontFollowBack), []);
});

// ---------- things that must never turn into "nobody follows you" ----------

test('a followers file whose records cannot be read is an error, not an empty list', () => {
  const unknown = JSON.stringify([{ something_new: { user: 'alice' } }, { something_new: { user: 'bob' } }]);
  assert.throws(
    () => IgParse.analyze([
      { path: DIR + 'followers_1.json', text: unknown },
      { path: DIR + 'following.json', text: h.followingJsonNew([['alice', 1]]) }
    ]),
    (err) => err.code === 'unreadable-followers' && /2 entries/.test(err.message)
  );
});

test('a followers file with an unknown wrapper is an error', () => {
  assert.throws(
    () => IgParse.analyze([
      { path: DIR + 'followers_1.json', text: JSON.stringify({ version: 3, data: { people: 'x' } }) },
      { path: DIR + 'following.json', text: h.followingJsonNew([['alice', 1]]) }
    ]),
    (err) => err.code === 'unknown-format'
  );
});

test('an HTML followers file with record boxes but nothing readable is an error', () => {
  const html = '<main>' + '<div class="pam uiBoxWhite noborder"><span>new layout</span></div>'.repeat(3) + '</main>';
  assert.throws(
    () => IgParse.analyze([
      { path: DIR + 'followers_1.html', text: html },
      { path: DIR + 'following.html', text: h.followingHtml(['alice']) }
    ]),
    (err) => err.code === 'unreadable-followers'
  );
});

test('some unreadable entries give a warning with counts', () => {
  const following = JSON.stringify({
    relationships_following: [
      { title: 'fine_user', string_list_data: [{ href: 'https://www.instagram.com/_u/fine_user', timestamp: 1 }] },
      { title: '', string_list_data: [{ timestamp: 2 }] },
      { title: 'Not A Username', string_list_data: [] }
    ]
  });
  const result = IgParse.analyze([
    { path: 'followers_1.json', text: h.followersJson([]) },
    { path: 'following.json', text: following }
  ]);
  assert.deepEqual(names(result.notFollowingYouBack), ['fine_user']);
  assert.deepEqual(result.warnings, [{ code: 'partly-unreadable', list: 'following', unreadable: 2, records: 3 }, { code: 'no-followers' }]);
});

// ---------- the export's date range ----------

test('a followers list cut short by the date range is flagged', () => {
  const following = accounts('u', 200, 10); // goes back about 5.5 years
  const followers = following.filter((_, i) => i % 4 !== 0).filter(([, ts]) => ts > NOW - 365 * DAY); // last year only
  const result = IgParse.analyze([
    { path: DIR + 'followers_1.json', text: h.followersJson(followers) },
    { path: DIR + 'following.json', text: h.followingJsonNew(following) }
  ]);
  assert.equal(codes(result)[0], 'followers-cut');
  const w = result.warnings[0];
  assert.equal(w.followingSince, following[following.length - 1][1]);
  assert.ok(w.followersSince > NOW - 366 * DAY);
});

test('a complete export is not flagged', () => {
  const following = accounts('u', 200, 10);
  const followers = following.filter((_, i) => i % 4 !== 0);
  const result = IgParse.analyze([
    { path: DIR + 'followers_1.json', text: h.followersJson(followers) },
    { path: DIR + 'following.json', text: h.followingJsonNew(following) }
  ]);
  assert.deepEqual(result.warnings, []);
});

test('too few dates to judge is not flagged', () => {
  const result = IgParse.analyze([
    { path: DIR + 'followers_1.json', text: h.followersJson(accounts('u', 5, 1)) },
    { path: DIR + 'following.json', text: h.followingJsonNew(accounts('u', 50, 60)) }
  ]);
  assert.deepEqual(result.warnings, []);
});

// ---------- follow requests ----------

test('accounts with a pending follow request are listed separately', () => {
  const result = IgParse.analyze([
    { path: DIR + 'followers_1.json', text: h.followersJson([['alice', 1]]) },
    { path: DIR + 'following.json', text: h.followingJsonNew([['alice', 1], ['celeb', 2], ['private.acct', 3]]) },
    { path: DIR + 'pending_follow_requests.json', text: h.labelValuesJson([['private.acct', 3]], undefined, { wrap: 'relationships_follow_requests_sent' }) }
  ]);
  assert.deepEqual(names(result.notFollowingYouBack), ['celeb']);
  assert.deepEqual(names(result.requested), ['private.acct']);
  assert.equal(result.mutualCount, 1);
});

test('an unreadable request file is a warning, not an error', () => {
  const result = IgParse.analyze([
    { path: DIR + 'followers_1.json', text: h.followersJson([['alice', 1]]) },
    { path: DIR + 'following.json', text: h.followingJsonNew([['alice', 1], ['bob', 2]]) },
    { path: DIR + 'pending_follow_requests.json', text: '{broken' }
  ]);
  assert.deepEqual(names(result.notFollowingYouBack), ['bob']);
  assert.deepEqual(codes(result), ['requests-unreadable']);
});

// ---------- which files are read ----------

test('two copies of a list from different exports: only the newest is used', () => {
  const oldCopy = h.followersJson([['alice', 1000], ['left_since', 900]]);
  const newCopy = h.followersJson([['alice', 1000], ['new_fan', NOW]]);
  const result = IgParse.analyze([
    { path: 'followers_and_following/followers_1.json', text: oldCopy },
    { path: 'connections/followers_and_following/followers_1.json', text: newCopy },
    { path: 'connections/followers_and_following/following.json', text: h.followingJsonNew([['alice', 1], ['left_since', 2]]) }
  ]);
  assert.deepEqual(names(result.notFollowingYouBack), ['left_since']);
  assert.deepEqual(codes(result), ['duplicate-copies']);
  assert.equal(result.warnings[0].used, 'connections/followers_and_following/followers_1.json');
});

test('a JSON and an HTML copy of the same list: JSON is used, no warning', () => {
  // The HTML helper dates every row Mar 3, 2024 9:12 pm (local time); JSON is UTC.
  const mar3 = Date.UTC(2024, 2, 3, 21, 12) / 1000 + 7 * 3600;
  const result = IgParse.analyze([
    { path: DIR + 'followers_1.json', text: h.followersJson([['alice', mar3], ['bob', mar3]]) },
    { path: DIR + 'followers_1.html', text: h.followersHtml(['alice', 'bob']) },
    { path: DIR + 'following.json', text: h.followingJsonNew([['alice', 1], ['carol', 2]]) }
  ]);
  assert.deepEqual(result.filesRead, ['followers_1.json', 'following.json']);
  assert.deepEqual(result.warnings, []);
});

test('outside the followers_and_following folder, look-alike files are ignored', () => {
  const result = IgParse.analyze([
    { path: DIR + 'followers_1.json', text: h.followersJson([['alice', 1]]) },
    { path: DIR + 'following.json', text: h.followingJsonNew([['alice', 1], ['bob', 2]]) },
    { path: 'your_instagram_activity/threads/followers.json', text: h.followersJson([['bob', 1]]) }
  ]);
  assert.deepEqual(names(result.notFollowingYouBack), ['bob']);
});

test('ignores other files in the export', () => {
  const result = IgParse.analyze([
    { path: 'followers_1.json', text: h.followersJson([['a', 1]]) },
    { path: 'following.json', text: h.followingJsonNew([['a', 1]]) },
    { path: 'following_hashtags.json', text: '{"relationships_following_hashtag":[{"title":"cats"}]}' },
    { path: 'close_friends.json', text: '{"relationships_close_friends":[]}' },
    { path: '__MACOSX/connections/._followers_1.json', text: 'binary junk' }
  ]);
  assert.equal(result.followingCount, 1);
  assert.deepEqual(result.filesRead, ['followers_1.json', 'following.json']);
});

test('refuses to compare when one side is missing', () => {
  assert.throws(
    () => IgParse.analyze([{ path: 'following.json', text: h.followingJsonNew([['a', 1]]) }]),
    (err) => err.code === 'missing-followers'
  );
  assert.throws(
    () => IgParse.analyze([{ path: 'followers_1.json', text: h.followersJson([['a', 1]]) }]),
    (err) => err.code === 'missing-following'
  );
});

test('names the file when its JSON is broken', () => {
  assert.throws(
    () => IgParse.analyze([{ path: 'followers_1.json', text: '{oops' }, { path: 'following.json', text: '{}' }]),
    (err) => err.code === 'damaged-file' && /followers_1\.json/.test(err.message)
  );
});

// ---------- HTML ----------

test('reads the HTML export, ignores links that are not profiles, and reads dates', () => {
  const result = IgParse.analyze([
    { path: DIR + 'followers_1.html', text: h.followersHtml(['alice', 'bob']) },
    { path: DIR + 'following.html', text: h.followingHtml(['alice', 'bob', 'carol']) }
  ]);
  assert.deepEqual(names(result.notFollowingYouBack), ['carol']);
  assert.equal(result.followingCount, 3);
  assert.equal(result.notFollowingYouBack[0].timestamp, Date.UTC(2024, 2, 3, 21, 12) / 1000);
});

// ---------- small pieces ----------

test('parseExportDate reads the date formats Instagram writes', () => {
  const iso = (t) => {
    const ts = IgParse.parseExportDate(t);
    return ts === null ? null : new Date(ts * 1000).toISOString().slice(0, 16);
  };
  assert.equal(iso('Aug 10, 2026 6:32 pm'), '2026-08-10T18:32');
  assert.equal(iso('ago 10, 2026 6:32 pm'), '2026-08-10T18:32');
  assert.equal(iso('8月 10, 2026 6:32 PM'), '2026-08-10T18:32');
  assert.equal(iso('Aug 01, 2026 12:06 am'), '2026-08-01T00:06');
  assert.equal(iso('Dec 31, 2019 12:30 pm'), '2019-12-31T12:30');
  assert.equal(iso('10 авг. 2026 г., 18:32'), '2026-08-10T18:32');
  assert.equal(iso('10. Aug. 2026, 18:32'), '2026-08-10T18:32');
  assert.equal(iso('out 5, 2023 1:00 pm'), '2023-10-05T13:00');
  assert.equal(iso('someone2020'), null);
  assert.equal(iso('2026'), null);
  assert.equal(iso(undefined), null);
});

test('usernameFromHref', () => {
  const f = IgParse.usernameFromHref;
  assert.equal(f('https://www.instagram.com/alice'), 'alice');
  assert.equal(f('https://www.instagram.com/alice/'), 'alice');
  assert.equal(f('https://instagram.com/_u/Some.User_1'), 'some.user_1');
  assert.equal(f('https://www.instagram.com/alice?igsh=abc'), 'alice');
  assert.equal(f('https://www.instagram.com/'), null);
  assert.equal(f('https://www.instagram.com/p/C0abc123/'), null);
  assert.equal(f('https://www.instagram.com/explore'), null);
  assert.equal(f('https://help.instagram.com/alice'), null);
  assert.equal(f('https://notinstagram.com/alice'), null);
  assert.equal(f('https://wa.me/123456'), null);
  assert.equal(f('followers_1.html'), null);
  assert.equal(f('https://www.instagram.com/%E0%A4%A'), null);
  assert.equal(f(undefined), null);
});

test('classifyFile', () => {
  const c = IgParse.classifyFile;
  assert.deepEqual(c('connections/followers_and_following/followers_1.json'), {
    list: 'followers',
    shard: 'followers_1',
    format: 'json',
    name: 'followers_1.json',
    path: 'connections/followers_and_following/followers_1.json',
    inExportFolder: true
  });
  assert.equal(c('following.html').format, 'html');
  assert.equal(c('following.html').inExportFolder, false);
  assert.equal(c('C:\\export\\following.json').list, 'following');
  assert.equal(c('pending_follow_requests.json').list, 'requests');
  assert.equal(c('pending_follow_requests.html').list, 'requests');
  assert.equal(c('recent_follow_requests.json'), null);
  assert.equal(c('following_hashtags.json'), null);
  assert.equal(c('recently_unfollowed_profiles.json'), null);
  assert.equal(c('connections/followers_and_following/'), null);
});
