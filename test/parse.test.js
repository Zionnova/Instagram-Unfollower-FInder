'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const IgParse = require('../assets/parse.js');
const h = require('./helpers.js');

const DIR = 'connections/followers_and_following/';
const names = (list) => list.map((a) => a.username).sort();

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
  assert.equal(result.skippedEntries, 0);
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

test('reads the HTML export and ignores links that are not profiles', () => {
  const result = IgParse.analyze([
    { path: DIR + 'followers_1.html', text: h.followersHtml(['alice', 'bob']) },
    { path: DIR + 'following.html', text: h.followingHtml(['alice', 'bob', 'carol']) }
  ]);
  assert.deepEqual(names(result.notFollowingYouBack), ['carol']);
  assert.equal(result.followingCount, 3);
  assert.equal(result.notFollowingYouBack[0].timestamp, null);
});

test('usernames are compared case-insensitively and deduplicated', () => {
  const result = IgParse.analyze([
    { path: 'followers_1.json', text: h.followersJson([['Alice', 1]]) },
    { path: 'following.json', text: h.followingJsonNew([['alice', 1], ['ALICE', 2]]) }
  ]);
  assert.equal(result.followingCount, 1);
  assert.equal(result.notFollowingYouBack.length, 0);
});

test('entries without a readable username are counted, not guessed', () => {
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
  assert.equal(result.skippedEntries, 2);
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
    /followers_1\.json/
  );
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
  assert.equal(f('https://help.instagram.com/'), null);
  assert.equal(f('https://notinstagram.com/alice'), null);
  assert.equal(f('followers_1.html'), null);
  assert.equal(f('https://www.instagram.com/%E0%A4%A'), null);
  assert.equal(f(undefined), null);
});

test('classifyFile', () => {
  const c = IgParse.classifyFile;
  assert.deepEqual(c('a/b/followers_1.json'), { list: 'followers', format: 'json', name: 'followers_1.json' });
  assert.equal(c('following.html').format, 'html');
  assert.equal(c('C:\\export\\following.json').list, 'following');
  assert.equal(c('following_hashtags.json'), null);
  assert.equal(c('pending_follow_requests.json'), null);
  assert.equal(c('recently_unfollowed_profiles.json'), null);
  assert.equal(c('connections/followers_and_following/'), null);
});
