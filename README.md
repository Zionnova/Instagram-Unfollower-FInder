# Unfollower Finder

Find the Instagram accounts you follow that don't follow you back, using the
data export Instagram gives you. Each result links straight to the person's
profile.

It's one static web page. Your export is read by your browser and never leaves
your device: there is no server, no login, no tracking, and the page's Content
Security Policy blocks it from making network requests at all.

## Using it

1. **Get your export from Instagram.** In the app: profile → menu →
   **Accounts Center** → **Your information and permissions** →
   **Export your information** (older versions call it *Download your
   information*) → create an export for your Instagram account →
   **Export to device**. Then:
   - **Customize information:** select only **Followers and following**.
   - **Date range:** **All time**. See [why](#why-all-time-matters).
   - **Format:** **JSON**. HTML also works, but has no follow dates.

   Instagram emails you when the file is ready.
2. **Open the page** and drop in the `.zip` exactly as downloaded. No need to
   unzip it. If Instagram split the download into several zips, select all of
   them. An unzipped folder, or just `followers_1.json` + `following.json`,
   also works.
3. **Go through the list.** Click a name to open their profile. Profiles you've
   opened turn grey. **Hide** anything you don't care about (celebrities,
   brands) or that turns out to be deleted; hidden accounts are remembered in
   that browser.

A second tab shows the opposite: people who follow you that you don't follow
back.

### Running the page

- **GitHub Pages (recommended):** repo **Settings → Pages → Build and
  deployment → Deploy from a branch**, pick `main` and `/ (root)`. The site
  appears at `https://<user>.github.io/Instagram-Unfollower-FInder/`.
- **Locally:** download the repo and double-click `index.html`. It works from
  `file://` with no build step and no internet connection.

## How it works

The export contains two relevant files, found anywhere in the zip by name:

| File | Meaning |
| --- | --- |
| `followers_1.json` (`_2`, `_3`… on big accounts) | Accounts that follow you |
| `following.json` | Accounts you follow |

The result is `following − followers`, compared by lowercase username.

Instagram has changed the file layout over time, and the parser handles each
version it knows about:

- **2022–2024 JSON:** the username is in `string_list_data[0].value`.
- **Late-2024 JSON (`following.json`):** `value` was removed. The username is
  in `title` and the link is `instagram.com/_u/<username>`. Tools that only
  read `value` got empty results after this change.
- **HTML export:** usernames are taken from the profile links.

Entries where no valid username can be found are skipped and counted, and the
page tells you how many there were.

The zip is read without loading the whole file into memory. Only the directory
and the two or three small files needed are read, so a multi-gigabyte export
that includes photos is fine. Decompression uses the browser's built-in
`DecompressionStream`, which needs Chrome/Edge 103+, Firefox 113+ or
Safari 16.4+. On older browsers, unzip the export and choose the folder.

### Why "All time" matters

The export isn't a history of every follow. `followers_1.json` and
`following.json` are snapshots of who follows whom **on the day you requested
the export**. If you unfollowed someone or they unfollowed you, they're not in
the file. That's why results are always "current".

The date range doesn't change that. It filters by **when each follow
started**. With "Last year", a friend who followed you three years ago is left
out of `followers_1.json`. If you followed them back recently, they'd wrongly
show up as not following you. "All time" gives the complete current lists.

### Deleted and deactivated accounts

When an account is deleted, Instagram removes its follows, so it never shows up
in an export. Temporarily **deactivated** accounts are a grey area. They can
still be in the lists, and their profile link shows "Sorry, this page isn't
available." That's what **Hide** is for.

Checking automatically whether each account still exists would mean contacting
Instagram once per account. A static page can't do that, because browsers block
cross-site requests to instagram.com. A server doing it gets rate-limited and
blocked, which may be how similar tools stopped working. This project doesn't
do it.

## Limitations

- Results are as of the export date. Request a new export to refresh them.
- The HTML format has no follow dates, so only A-to-Z sorting is available.
- If Instagram changes the export format again, the parser may need updating.
  Open an issue with a sample entry (with the username changed) from the new
  file.

## Development

No dependencies and no build step. The code is plain browser JavaScript:

```
index.html          page markup
assets/style.css    styles (light and dark)
assets/zip.js       ZIP reader (stored, deflate, ZIP64)
assets/parse.js     export parsing and the comparison
assets/app.js       page behaviour
test/               unit tests (Node's built-in test runner)
```

`zip.js` and `parse.js` work in both the browser and Node. Run the tests with
Node 22 or newer:

```sh
npm test
```

## License

[MIT](LICENSE). Not affiliated with Instagram or Meta.
