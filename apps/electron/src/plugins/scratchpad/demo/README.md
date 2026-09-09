# Scratchpad product demo

PR-review product demo for the Scratchpad plugin, recorded with the shared
plugin demo tooling in [`../../demo/`](../../demo/README.md).

## Record

From `apps/electron/src/plugins/demo/`:

```sh
uvx shot-scraper install   # one-time: installs Playwright Chromium + ffmpeg
node record.mjs scratchpad
```

Outputs (`.webm`, `.gif`, key-moment stills) are written to
`docs/plugins/scratchpad/demo/`. Add/update the PR comment with
`node comment-demos.mjs scratchpad --pr <number>`.

## What the storyboard shows

The plugin ships `defaultEnabled: false`; the storyboard URL seeds the user's
opt-in with `?enable=scratchpad`. Scenes: manifest-declared left-edge rail
toggle, lazy activation on first open (`onPanel:notes`), autosave on every
edit through scoped `ctx.storage`, restore across close/reopen, and live
disable/enable from Settings with the note surviving.
