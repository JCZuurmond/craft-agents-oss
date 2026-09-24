# Browser Pane product demo

PR-review product demo for the Browser Pane plugin, recorded with the shared
plugin demo tooling in [`../../demo/`](../../demo/README.md). The source of
truth is the [shot-scraper video](https://shot-scraper.datasette.io/en/stable/video.html)
storyboard in `storyboards/`; `site/` is the offline demo site the pane
browses, served at `http://127.0.0.1:5199/demo-site/` while recording.

## Record

From `apps/electron/src/plugins/demo/`:

```sh
uvx shot-scraper install   # one-time: installs Playwright Chromium + ffmpeg
node record.mjs web-browser
```

Outputs (`.webm`, `.gif`, key-moment stills) are written to
`docs/plugins/web-browser/demo/`. Add/update the PR comment with
`node comment-demos.mjs web-browser --pr <number>`.

## What the storyboard shows

The plugin ships `defaultEnabled: false`; the storyboard URL seeds the user's
opt-in with `?enable=web-browser` and the last-visited URL through the generic
`?seed.craft-plugin-web-browser:last-url=...` parameter, exactly as a
persisted profile would. Scenes: manifest-declared rail toggle, lazy
activation on first open, navigation/history, failure handling, live
disable/enable from Settings, last-URL restore from scoped plugin storage, and
the any-edge showcase (a second demo plugin docking panels on other shell
edges through the same public API).
