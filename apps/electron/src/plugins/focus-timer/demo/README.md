# Focus Timer product demo

PR-review product demo for the Focus Timer plugin, recorded with the shared
plugin demo tooling in [`../../demo/`](../../demo/README.md).

## Record

From `apps/electron/src/plugins/demo/`:

```sh
uvx shot-scraper install   # one-time: installs Playwright Chromium + ffmpeg
node record.mjs focus-timer
```

Outputs (`.webm`, `.gif`, key-moment stills) are written to
`docs/plugins/focus-timer/demo/`. Add/update the PR comment with
`node comment-demos.mjs focus-timer --pr <number>`.

## What the storyboard shows

The plugin ships `defaultEnabled: false`; the storyboard URL seeds the user's
opt-in with `?enable=focus-timer` and a 0.15-minute duration through the
generic `?seed.craft-plugin-focus-timer:duration-minutes=0.15` parameter so a
full session completes on camera. Scenes: manifest-declared top-edge rail
toggle, the `mod+shift+f` keybinding lazy-activating the plugin through the
declared toggle command (`onCommand:toggle`), pausing from the same chord, a
session completing with the persisted 🏁 count incrementing, and duration
presets persisting through scoped `ctx.storage`.
