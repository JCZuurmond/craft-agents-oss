# Plugin Console product demo

PR-review product demo for the Plugin Console plugin, recorded with the shared
plugin demo tooling in [`../../demo/`](../../demo/README.md).

## Record

From `apps/electron/src/plugins/demo/`:

```sh
uvx shot-scraper install   # one-time: installs Playwright Chromium + ffmpeg
node record.mjs plugin-console
```

Outputs (`.webm`, `.gif`, key-moment stills) are written to
`docs/plugins/plugin-console/demo/`. Add/update the PR comment with
`node comment-demos.mjs plugin-console --pr <number>`.

## What the storyboard shows

The plugin ships `defaultEnabled: false`; the storyboard URL seeds the user's
opt-in with `?enable=plugin-console`. Scenes: startup activation
(`onStartup`) buffering the boot wave before the panel ever opens, the
buffered `app:ready` / `plugin:activated` / `panel:opened` log in the bottom
dock, live `panel:opened` events as a second demo plugin docks panels on the
left and bottom edges, cross-edge event flow, and the clear control.
