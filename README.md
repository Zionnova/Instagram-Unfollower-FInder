# Unfollower Finder

Find the Instagram accounts you follow that don't follow you back, using the
data export Instagram gives you. Each result links straight to the person's
profile.

It's one static web page. Your export is read by your browser and never leaves
your device: there is no server, no login, no tracking, and the page's Content
Security Policy blocks it from making network requests at all. Even the fonts
are bundled in the repo rather than loaded from Google, so opening the page
contacts nobody.

It follows your system's light or dark setting, and the button in the top
corner switches between them.

## Using it

1. **Get your export from Instagram.** In the app: profile → menu →
   **Accounts Center** → **Your information and permissions** →
   **Export your information** (older versions call it *Download your
   information*) → create an export for your Instagram account →
   **Export to device**. Then:
   - **Customize information:** select only **Followers and following**.
   - **Date range:** **All time**. It isn't the default, and it matters more
     than anything else here. See [why](#why-all-time-matters).
   - **Format:** **JSON**. HTML also works.

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
back. Private accounts you've asked to follow that haven't accepted are listed
separately, because you don't actually follow them yet.

### Running the page

- **GitHub Pages (recommended):** repo **Settings → Pages → Build and
  deployment → Deploy from a branch**, pick `main` and `/ (root)`. The site
  appears at `https://<user>.github.io/Instagram-Unfollower-FInder/`.
- **Locally:** download the repo and double-click `index.html`. It works from
  `file://` with no build step and no internet connection.

## How it works

The export holds the lists in `connections/followers_and_following/`:

| File | Meaning |
| --- | --- |
| `followers_1.json` (`_2`, `_3`… on big accounts) | Accounts that follow you |
| `following.json` | Accounts you follow |
| `pending_follow_requests.json` | Private accounts you've asked to follow that haven't accepted |

The result is `following − followers − pending requests`, compared by
lowercase username.

### Instagram keeps changing the format

Instagram changes this export often, sometimes one file at a time, so a single
export can mix formats. The parser reads every layout seen in real exports:

| Layout | What a record looks like |
| --- | --- |
| JSON, 2022 on | `{"title": "", "string_list_data": [{"href", "value": <username>, "timestamp"}]}` |
| JSON, late 2024 on (`following.json`) | `{"title": <username>, "string_list_data": [{"href", "timestamp"}]}` |
| JSON, 2026 on | `{"timestamp", "label_values": [{"label": "Username", "value": <username>}, …]}` |
| HTML | one profile link per record, with the date in the next line |
| HTML, 2026 on | a small table of label/value rows per record |

The 2026 layouts write every field as a label and a value, and **the labels
are translated** into the account's language ("Username", "Nombre de usuario",
…), sometimes garbled by a double encoding. So the parser doesn't look for the
word "Username". It works out which label holds usernames from how the values
look across the whole export: usernames are always lowercase letters, digits,
dots and underscores, and display names rarely are. If no label is a clear
winner, it stops with an error instead of guessing.

A list can also be a bare array, wrapped in `{"relationships_...": [...]}`, or a
single record with no array around it.

### When something can't be read, it says so

The worst thing a tool like this can do is read nothing from your followers
file and then tell you nobody follows you back. That's what the first version
of this page did when it met the 2026 layout. Now:

- If the followers or following list has entries but **none** can be read, you
  get an error that says so, not a result.
- If **some** entries can't be read, the results come with a warning and the
  count.
- If the followers list comes out **empty**, you get a warning to check it
  against your profile.
- If an export holds **two copies** of a list (both of Instagram's folder
  layouts, or two exports chosen together), only the newest copy is read.
  Mixing copies from different days would count people who have since
  unfollowed.
- **Files read** under the counts shows exactly which files were used and how
  many entries each gave.

The zip is read without loading the whole file into memory. Only the directory
and the few small files needed are read, so a multi-gigabyte export that
includes photos is fine. Each file's unzipped size is checked, so a download
that was cut off or damaged gives an error instead of a wrong answer.
Decompression uses the browser's built-in `DecompressionStream`, which needs
Chrome/Edge 103+, Firefox 113+ or Safari 16.4+. On older browsers, unzip the
export and choose the folder.

### Why "All time" matters

The export isn't a history of every follow. `followers_1.json` and
`following.json` are snapshots of who follows whom **on the day you requested
the export**. If you unfollowed someone or they unfollowed you, they're not in
the file.

The date range filters **`followers_1.json` by when each person followed you,
but leaves `following.json` whole**. With anything shorter than "All time",
everyone who followed you before the cut-off is missing, and every one of them
shows up as "not following you back". The file looks perfectly normal, so
nothing in it tells you. [safe-unfollow](https://github.com/ignromanov/safe-unfollow)
measured this on one account's exports two days apart: followers dropped from
364 to 118, and 199 of 298 mutual follows were wrongly reported.

The page watches for this. If your followers only go back to, say, last year
while the accounts you follow go back years, it shows a warning. The quickest
check is yours to make, though: compare the "Follow you" number with the
follower count on your profile. If your profile shows a lot more, request the
export again with **All time**.

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
- If Instagram changes the export format again, the parser may need updating.
  The page will tell you when it can't read a file. Open an issue with one
  entry from that file (change the username) and it can be fixed.

## Troubleshooting

**Almost everyone shows up as not following me back.** Compare "Follow you"
with the follower count on your profile. If the page's number is much lower,
the export's date range wasn't "All time": request a new export with All time.
If the page says it couldn't read your followers, that's a format change; please
open an issue.

**"Your followers list isn't in what you chose".** The export has to include
"Followers and following". Instagram sometimes splits a big export into several
.zip files; choose all of them at once.

**"This .zip file is incomplete or damaged".** The download was cut off.
Download it again from the email link.

## Development

No dependencies and no build step. The code is plain browser JavaScript:

```
index.html          page markup
assets/style.css    styles (light and dark)
assets/theme.js     applies a saved light/dark choice before the page paints
assets/fonts/       Bricolage Grotesque and Instrument Sans (SIL Open Font License)
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

## Credits

The details of Instagram's recent format changes, including the translated
labels, the date-range cut and the duplicate folder layouts, come from the
research in [safe-unfollow](https://github.com/ignromanov/safe-unfollow) and
[InstagramUnfollowers](https://github.com/EdvinCodes/InstagramUnfollowers), both
open source. No code was copied from either.

## License

Code: [MIT](LICENSE). Fonts: [SIL Open Font License 1.1](assets/fonts/), see
the `OFL-*.txt` files next to them. Not affiliated with Instagram or Meta.
