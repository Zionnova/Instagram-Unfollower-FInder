/* Page logic: read the chosen files, run the comparison, show the list. */
(function () {
  'use strict';

  var HIDDEN_KEY = 'unfollower-finder.hidden.v1';
  var dateFormat = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  var numberFormat = new Intl.NumberFormat();

  function $(id) {
    return document.getElementById(id);
  }

  var ui = {
    start: $('start'),
    drop: $('drop'),
    fileInput: $('file-input'),
    folderInput: $('folder-input'),
    status: $('status'),
    sampleBtn: $('sample-btn'),
    howLink: $('how-link'),
    themeBtn: $('theme-btn'),
    results: $('results'),
    sampleBanner: $('sample-banner'),
    bigNumber: $('big-number'),
    bigLabel: $('big-label'),
    nFollowing: $('n-following'),
    nFollowers: $('n-followers'),
    nMutual: $('n-mutual'),
    sourceNote: $('source-note'),
    tabs: Array.prototype.slice.call(document.querySelectorAll('.tab')),
    search: $('search'),
    sort: $('sort'),
    list: $('list'),
    empty: $('empty'),
    toggleHidden: $('toggle-hidden'),
    resetBtn: $('reset-btn')
  };

  var state = {
    result: null,
    sample: false,
    tab: 'notFollowingYouBack',
    showHidden: false
  };

  // Hidden accounts are a per-browser convenience; the sample never touches storage.
  var savedHidden = loadHidden();
  var sampleHidden = new Set();

  function hiddenSet() {
    return state.sample ? sampleHidden : savedHidden;
  }

  function loadHidden() {
    try {
      var raw = localStorage.getItem(HIDDEN_KEY);
      var list = raw ? JSON.parse(raw) : [];
      return new Set(Array.isArray(list) ? list : []);
    } catch (e) {
      return new Set();
    }
  }

  function saveHidden() {
    if (state.sample) return;
    try {
      localStorage.setItem(HIDDEN_KEY, JSON.stringify(Array.from(savedHidden)));
    } catch (e) {
      /* storage unavailable (private window, blocked site data): keep it in memory */
    }
  }

  function setStatus(message, isError) {
    ui.status.textContent = message || '';
    ui.status.classList.toggle('is-error', !!isError);
  }

  // ---------- reading files ----------

  // inputs: [{ file, path }] -> [{ path, text }], only the follower/following lists.
  async function readInputs(inputs) {
    var out = [];
    for (var i = 0; i < inputs.length; i++) {
      var file = inputs[i].file;
      var path = inputs[i].path;
      if (/\.zip$/i.test(file.name)) {
        var entries = await IgZip.listEntries(file);
        for (var j = 0; j < entries.length; j++) {
          if (IgParse.classifyFile(entries[j].name)) {
            out.push({ path: entries[j].name, text: await IgZip.readText(file, entries[j]) });
          }
        }
      } else if (IgParse.classifyFile(path)) {
        out.push({ path: path, text: await file.text() });
      }
    }
    return out;
  }

  async function handleInputs(inputs) {
    if (!inputs.length) return;
    setStatus(inputs.length === 1 ? 'Reading ' + inputs[0].file.name + '…' : 'Reading ' + inputs.length + ' files…');
    ui.drop.setAttribute('aria-busy', 'true');
    try {
      var files = await readInputs(inputs);
      if (!files.length) {
        throw new Error(
          'No follower or following lists were found in what you chose. The export needs to include "Followers and following". ' +
          'If Instagram split your download into several .zip files, choose all of them at once.'
        );
      }
      showResult(IgParse.analyze(files), false);
      setStatus('');
    } catch (err) {
      setStatus(err.message, true);
    } finally {
      ui.drop.removeAttribute('aria-busy');
    }
  }

  function fromFileList(fileList) {
    return Array.prototype.map.call(fileList, function (file) {
      return { file: file, path: file.webkitRelativePath || file.name };
    });
  }

  // Dropped folders have to be walked by hand.
  async function fromDrop(dataTransfer) {
    var items = Array.prototype.slice.call(dataTransfer.items || []);
    var roots = items
      .map(function (item) { return item.webkitGetAsEntry ? item.webkitGetAsEntry() : null; })
      .filter(Boolean);
    if (!roots.length) return fromFileList(dataTransfer.files);

    var out = [];
    async function walk(entry, prefix) {
      if (entry.isFile) {
        var file = await new Promise(function (resolve, reject) { entry.file(resolve, reject); });
        out.push({ file: file, path: prefix + file.name });
      } else if (entry.isDirectory) {
        var reader = entry.createReader();
        var batch;
        do {
          batch = await new Promise(function (resolve, reject) { reader.readEntries(resolve, reject); });
          for (var i = 0; i < batch.length; i++) await walk(batch[i], prefix + entry.name + '/');
        } while (batch.length);
      }
    }
    for (var i = 0; i < roots.length; i++) await walk(roots[i], '');
    return out;
  }

  // ---------- results ----------

  function showResult(result, isSample) {
    state.result = result;
    state.sample = isSample;
    state.tab = 'notFollowingYouBack';
    state.showHidden = false;
    ui.search.value = '';
    ui.sort.value = 'newest';

    ui.nFollowing.textContent = numberFormat.format(result.followingCount);
    ui.nFollowers.textContent = numberFormat.format(result.followersCount);
    ui.nMutual.textContent = numberFormat.format(result.mutualCount);

    var note = isSample
      ? 'Read from an example export.'
      : 'Read from ' + listNames(result.filesRead) + '. This is how things stood when you requested the export.';
    if (result.skippedEntries) {
      note += ' ' + result.skippedEntries + ' ' + (result.skippedEntries === 1 ? 'entry had' : 'entries had') + ' no readable username and ' + (result.skippedEntries === 1 ? 'was' : 'were') + ' left out.';
    }
    ui.sourceNote.textContent = note;

    ui.sampleBanner.hidden = !isSample;
    ui.start.hidden = true;
    ui.howLink.hidden = true;
    ui.results.hidden = false;
    ui.resetBtn.hidden = false;
    ui.resetBtn.innerHTML = isSample
      ? '<span class="label-long">Use your own file</span><span class="label-short">Your file</span>'
      : '<span class="label-long">Open a different file</span><span class="label-short">New file</span>';
    render();
    window.scrollTo(0, 0);
  }

  function listNames(names) {
    var unique = Array.from(new Set(names));
    if (unique.length <= 1) return unique.join('');
    return unique.slice(0, -1).join(', ') + ' and ' + unique[unique.length - 1];
  }

  function hasDates(items) {
    return items.some(function (a) { return a.timestamp != null; });
  }

  function compare(sort) {
    function byName(a, b) {
      return a.username < b.username ? -1 : a.username > b.username ? 1 : 0;
    }
    if (sort === 'az') return byName;
    var dir = sort === 'oldest' ? 1 : -1;
    return function (a, b) {
      if (a.timestamp == null && b.timestamp == null) return byName(a, b);
      if (a.timestamp == null) return 1;
      if (b.timestamp == null) return -1;
      return (a.timestamp - b.timestamp) * dir || byName(a, b);
    };
  }

  function render() {
    var all = state.result[state.tab];
    var hidden = hiddenSet();

    // Date sorting only makes sense when the export has dates (JSON does, HTML doesn't).
    var dated = hasDates(all);
    Array.prototype.forEach.call(ui.sort.options, function (opt) {
      if (opt.value !== 'az') opt.disabled = !dated;
    });
    if (!dated) ui.sort.value = 'az';

    ui.tabs.forEach(function (tab) {
      tab.setAttribute('aria-pressed', String(tab.getAttribute('data-tab') === state.tab));
    });
    updateCounts();

    var query = ui.search.value.trim().replace(/^@/, '').toLowerCase();
    var shown = all
      .filter(function (a) {
        return (state.showHidden || !hidden.has(a.username)) && (!query || a.username.indexOf(query) !== -1);
      })
      .sort(compare(ui.sort.value));

    var fragment = document.createDocumentFragment();
    shown.forEach(function (acc) { fragment.appendChild(renderRow(acc, hidden.has(acc.username))); });
    ui.list.replaceChildren(fragment);

    var emptyText = '';
    if (!shown.length) {
      if (!all.length) {
        emptyText = state.tab === 'notFollowingYouBack'
          ? 'Everyone you follow follows you back.'
          : 'You follow back everyone who follows you.';
      } else if (query) {
        emptyText = 'No usernames match "' + query + '".';
      } else {
        emptyText = 'You have hidden all ' + numberFormat.format(all.length) + ' accounts in this list.';
      }
    }
    ui.empty.textContent = emptyText;
    ui.empty.hidden = !emptyText;
  }

  // Tab counts leave out hidden accounts; the figures above always show the full export.
  function updateCounts() {
    var hidden = hiddenSet();
    function notHidden(a) { return !hidden.has(a.username); }
    ui.tabs.forEach(function (tab) {
      var remaining = state.result[tab.getAttribute('data-tab')].filter(notHidden).length;
      tab.querySelector('.count').textContent = numberFormat.format(remaining);
    });
    var all = state.result[state.tab];
    var left = all.filter(notHidden).length;
    var hiddenHere = all.length - left;
    ui.bigNumber.textContent = numberFormat.format(left);
    ui.bigLabel.textContent = state.tab === 'notFollowingYouBack'
      ? (left === 1 ? 'person you follow doesn’t follow you back' : 'people you follow don’t follow you back')
      : (left === 1 ? 'person follows you that you don’t follow back' : 'people follow you that you don’t follow back');
    ui.toggleHidden.hidden = !hiddenHere && !state.showHidden;
    ui.toggleHidden.textContent = state.showHidden
      ? 'Leave out hidden accounts'
      : 'Show ' + numberFormat.format(hiddenHere) + ' hidden ' + (hiddenHere === 1 ? 'account' : 'accounts');
  }

  function renderRow(acc, isHidden) {
    var li = document.createElement('li');
    li.className = 'row' + (isHidden ? ' is-hidden' : '');

    var avatar = document.createElement('span');
    avatar.className = 'avatar';
    avatar.setAttribute('aria-hidden', 'true');
    avatar.setAttribute('data-tint', String(tintFor(acc.username)));
    avatar.textContent = (acc.username.replace(/[^a-z0-9]/g, '').charAt(0) || '@').toUpperCase();
    li.appendChild(avatar);

    var who = document.createElement('div');
    who.className = 'who';
    var url = 'https://www.instagram.com/' + acc.username + '/';
    var handle = document.createElement(state.sample ? 'span' : 'a');
    handle.className = 'handle';
    handle.textContent = acc.username;
    if (!state.sample) setLink(handle, url);
    who.appendChild(handle);
    if (acc.timestamp != null) {
      var since = document.createElement('span');
      since.className = 'since';
      var date = dateFormat.format(new Date(acc.timestamp * 1000));
      since.textContent = state.tab === 'notFollowingYouBack' ? 'You followed them ' + date : 'Followed you ' + date;
      who.appendChild(since);
    }
    li.appendChild(who);

    if (!state.sample) {
      var view = document.createElement('a');
      view.className = 'view-btn';
      setLink(view, url);
      view.textContent = 'View profile';
      view.setAttribute('aria-label', 'View @' + acc.username + ' on Instagram');
      view.insertAdjacentHTML('beforeend', '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17L17 7"/><path d="M8 7h9v9"/></svg>');
      li.appendChild(view);
    }

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'hide-btn';
    btn.setAttribute('data-username', acc.username);
    setHideLabel(btn, acc.username, isHidden);
    li.appendChild(btn);
    return li;
  }

  function setLink(a, url) {
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
  }

  function setHideLabel(btn, username, isHidden) {
    btn.textContent = isHidden ? 'Undo' : 'Hide';
    btn.setAttribute('aria-label', (isHidden ? 'Unhide @' : 'Hide @') + username);
  }

  // A stable colour per username, so avatars don't reshuffle between renders.
  function tintFor(username) {
    var h = 0;
    for (var i = 0; i < username.length; i++) h = (h * 31 + username.charCodeAt(i)) >>> 0;
    return (h % 6) + 1;
  }

  // Hiding marks the row in place (so a mis-tap is easy to undo) and
  // only removes it from the list on the next re-render.
  function toggleHiddenRow(btn) {
    var username = btn.getAttribute('data-username');
    var hidden = hiddenSet();
    var nowHidden = !hidden.has(username);
    if (nowHidden) hidden.add(username);
    else hidden.delete(username);
    saveHidden();

    btn.closest('.row').classList.toggle('is-hidden', nowHidden);
    setHideLabel(btn, username, nowHidden);
    updateCounts();
  }

  function reset() {
    state.result = null;
    ui.results.hidden = true;
    ui.resetBtn.hidden = true;
    ui.start.hidden = false;
    ui.howLink.hidden = false;
    ui.fileInput.value = '';
    ui.folderInput.value = '';
    setStatus('');
    window.scrollTo(0, 0);
  }

  // ---------- example data ----------

  // A small made-up export in the current Instagram JSON layout.
  function sampleFiles() {
    var mutual = ['lena.draws', 'north_trail_coffee', 'marco.pvz', 'the_quiet_kiln', 'sofi.runs', 'ana_bakes_bread',
      'jules.films', 'pixelgarden.studio', 'tomas_on_bikes', 'mira.reads', 'kai.surfs', 'dana_plants',
      'hugo.sketches', 'rosa_and_the_dog', 'eli.makes.things', 'paz.ceramics'];
    var theyDont = ['bigcity.foodguide', 'daily.astro.facts', 'old_classmate_07', 'vintage.lens.shop',
      'running_club_west', 'nora.travels', 'design.inspo.daily', 'leo_climbs', 'band_you_saw_once'];
    var youDont = ['giveaway.bot.2931', 'cousin_pablo', 'neighbor.jess', 'promo_deals_now'];

    var now = Math.floor(Date.now() / 1000);
    function daysAgo(n) { return now - n * 86400; }

    var followers = mutual.concat(youDont).map(function (u, i) {
      return {
        title: '',
        media_list_data: [],
        string_list_data: [{ href: 'https://www.instagram.com/' + u, value: u, timestamp: daysAgo(9 + i * 41) }]
      };
    });
    var following = mutual.concat(theyDont).map(function (u, i) {
      return {
        title: u,
        string_list_data: [{ href: 'https://www.instagram.com/_u/' + u, timestamp: daysAgo(4 + ((i * 53) % 900)) }]
      };
    });
    return [
      { path: 'connections/followers_and_following/followers_1.json', text: JSON.stringify(followers) },
      { path: 'connections/followers_and_following/following.json', text: JSON.stringify({ relationships_following: following }) }
    ];
  }

  // ---------- wiring ----------

  ui.fileInput.addEventListener('change', function () {
    handleInputs(fromFileList(ui.fileInput.files));
  });
  ui.folderInput.addEventListener('change', function () {
    handleInputs(fromFileList(ui.folderInput.files));
  });

  ['dragenter', 'dragover'].forEach(function (type) {
    ui.drop.addEventListener(type, function (e) {
      e.preventDefault();
      ui.drop.classList.add('is-over');
    });
  });
  ui.drop.addEventListener('dragleave', function (e) {
    if (!ui.drop.contains(e.relatedTarget)) ui.drop.classList.remove('is-over');
  });
  ui.drop.addEventListener('drop', async function (e) {
    e.preventDefault();
    ui.drop.classList.remove('is-over');
    try {
      handleInputs(await fromDrop(e.dataTransfer));
    } catch (err) {
      setStatus('Could not read what you dropped: ' + err.message, true);
    }
  });
  // A file dropped outside the box would otherwise make the browser navigate away.
  window.addEventListener('dragover', function (e) { e.preventDefault(); });
  window.addEventListener('drop', function (e) { e.preventDefault(); });

  ui.sampleBtn.addEventListener('click', function () {
    showResult(IgParse.analyze(sampleFiles()), true);
  });

  ui.tabs.forEach(function (tab) {
    tab.addEventListener('click', function () {
      state.tab = tab.getAttribute('data-tab');
      state.showHidden = false;
      render();
    });
  });
  ui.search.addEventListener('input', render);
  ui.sort.addEventListener('change', render);
  ui.toggleHidden.addEventListener('click', function () {
    state.showHidden = !state.showHidden;
    render();
  });
  ui.list.addEventListener('click', function (e) {
    var btn = e.target.closest('.hide-btn');
    if (btn) toggleHiddenRow(btn);
  });
  ui.resetBtn.addEventListener('click', reset);

  // ---------- light / dark ----------

  var THEME_KEY = 'unfollower-finder.theme';
  var darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

  function isDark() {
    var set = document.documentElement.getAttribute('data-theme');
    return set ? set === 'dark' : darkQuery.matches;
  }

  function labelThemeButton() {
    ui.themeBtn.setAttribute('aria-label', isDark() ? 'Switch to light mode' : 'Switch to dark mode');
  }

  ui.themeBtn.addEventListener('click', function () {
    var next = isDark() ? 'light' : 'dark';
    // Choosing what the system already uses means "follow the system" again.
    var systemTheme = darkQuery.matches ? 'dark' : 'light';
    if (next === systemTheme) document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', next);
    try {
      if (next === systemTheme) localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, next);
    } catch (e) {
      /* storage unavailable: the choice lasts until the page is closed */
    }
    labelThemeButton();
  });
  if (darkQuery.addEventListener) darkQuery.addEventListener('change', labelThemeButton);
  labelThemeButton();
})();
