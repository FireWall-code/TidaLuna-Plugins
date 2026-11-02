# TidalPlaylistRescue

Over time, some tracks in your playlists turn grey: TIDAL still lists them but can no longer play them, even though the same song is
usually still on TIDAL under another ID. This plugin finds those tracks and swaps them for the version that still plays.

## How to use it

1. Open **Luna Settings → Plugins → TidalPlaylistRescue**
2. Tick the playlists you want to check, or **Favorites**
3. Click **Find unavailable tracks**
4. Review the results, untick anything you want to leave alone, then click **Apply**

## Settings

| Setting | What it does |
| --- | --- |
| Detect by ISRC | Looks for the same recording through its ISRC code. The most reliable method |
| Detect by name | When the ISRC finds nothing: same title, a shared artist, length within 2 seconds and same explicit status |
| Replacement choice | **Closest version** prefers the same album, artists and length. **Best quality** prefers Hi-Res |
| Tracks with no available version | **Keep** leaves them unticked. **Offer to remove them** ticks them in the results |

## What to expect

- **Positions are kept in playlists.** Favorites have no positions, so a replacement there gets today's date.
- **The date added changes** on every replaced track.
- **Removing a dead track is final.** TIDAL refuses to add one back, so the plugin keeps a **History** of everything it removed.
- **Public playlists** are marked in the list, since other people can see the changes.

## How it stays safe

- A track only counts as dead if the stream endpoint confirms it. Anything uncertain is left alone.
- A replacement is only offered if the stream endpoint confirms that it plays.
- The replacement always goes in before the dead track comes out, so a failure cannot lose a song.
- Every write checks the playlist version. If the playlist changed since the scan, the run stops rather than risk removing the wrong track.

## Development

```bash
pnpm test
```

The matching rules, the scan and the repair logic have no Luna imports and run under `node:test`. The playlist selection screen follows
the layout of [squadgazzz](https://github.com/squadgazzz/luna-plugins)'s PlaylistTools.
