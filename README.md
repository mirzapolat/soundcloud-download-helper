# SoundCloud Downloader

A Tampermonkey userscript that downloads SoundCloud tracks as MP3 with proper tags.

## Install

Open the Tampermonkey dashboard, create a new script, paste `soundcloud-downloader.user.js`, save.

## Using it

A **Download** button shows up next to Like and Repost on every track, plus a floating
button in the corner for whatever is playing. `Alt+D` does the same.

Before anything downloads you get a small preview — cover, title, artist, duration,
quality, and the filename you're about to get. Confirm or cancel.

Grab the **`+`** instead and the track goes into a queue. Collect as many as you like,
then hit *Download all* and everything arrives as one zip. The queue survives reloads,
so you can fill it over a few days. `Alt+Q` queues the current track.

Anything running can be cancelled — button, `Esc`, or a click outside the dialog.

The floating button can be dragged anywhere on the page. Hover it and a small grip
appears above it; drag it where you want and it stays there, across reloads.
Drop it near an edge and it snaps flush. Double-click the grip to put it back.

## Tags

Title, artist, uploader, label, genre, year, ISRC, composer, cover art, and the
track URL and description in the comment field.

Artist comes from the `Artist - Title` naming convention when a track uses it,
otherwise from SoundCloud's own metadata, otherwise the uploader.
`Introvert - Friction [FREE DL]` becomes artist *Introvert*, title *Friction*.

## Settings

The `CONFIG` block at the top of the script:

- `preview` — show the confirmation dialog (default on)
- `bundleAsZip` — one zip per batch instead of many separate downloads (default on)
- `splitArtistFromTitle` — split `Artist - Title` into separate tags
- `cleanTitle` — drop `[FREE DL]` and similar noise from titles
- `artworkSize` — `t500x500`, `t1080x1080` or `original`
- `filename` — defaults to `{artist} - {title}`; also `{user}`, `{year}`, `{genre}`
- `zipName` — supports `{count}` and `{date}`

Interface text lives in the `T` object right below it.

## Good to know

- Tracks that only offer AAC are saved as `.m4a` without tags. There's no way around
  that container from inside the browser.
- Go+ and other DRM tracks won't work at all.
- A batch is held in memory until the zip is written — roughly 4 MB per track.
  Dozens are fine, hundreds are not.
- If downloads suddenly stop working, SoundCloud rotated its API key. Use
  *Refresh SoundCloud client_id* in the Tampermonkey menu.
- For your own listening. Don't be a jerk to the people who made the music.
