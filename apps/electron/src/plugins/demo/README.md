# Plugin product-demo tooling

Shared harness + recorder for PR-review product demos of built-in plugins.
The source of truth for each demo is a set of
[shot-scraper video](https://shot-scraper.datasette.io/en/stable/video.html)
storyboards that a plugin keeps in its own directory:

```
apps/electron/src/plugins/{id}/demo/
├── storyboards/*.yml   # required — one recording per storyboard
├── vite.config.ts      # required — two-line stub over the shared factory
├── package.json        # required — anchors `npx vite` in this directory
└── site/               # optional — static pages served at /demo-site
```

The demo harness lives here (`harness/`) instead of
`apps/electron/src/renderer`, so it does **not** add an application renderer
route. It still uses the real renderer plugin runtime, the real
`PluginPanelDock` on all four shell edges, the real Settings primitives, and
the unmodified built-in plugins. The only Electron stand-ins are an in-page
`window.electronAPI.plugins` adapter (backed by the same shared
`PluginRegistry` class the main process uses) and an iframe-backed `<webview>`
shim, because shot-scraper records a browser page, not an Electron
BrowserWindow. The main-process `<webview>` hardening is Electron-only and out
of the demos' scope (see `docs/plugins/SECURITY.md`).

## Record a plugin's demos

From this directory:

```sh
uvx shot-scraper install       # one-time: installs Playwright Chromium + ffmpeg
node record.mjs <plugin-id>    # e.g. node record.mjs web-browser
```

Outputs are written to `docs/plugins/{plugin-id}/demo/`:

- one `.webm` per storyboard;
- one `.gif` per storyboard for embedding in PR comments;
- still screenshots defined by the storyboard.

## Add/update the PR comment

```sh
node comment-demos.mjs <plugin-id> --pr <number>
```

Without `--pr`, the script prints the Markdown. It discovers every `*.yml` /
`*.yaml` file in the plugin's `demo/storyboards/` and embeds the matching GIF
from the storyboard's `output:` path.

### Image URLs — use the `blob/…?raw=true` form, not `raw.githubusercontent.com`

Embedded GIFs use `https://github.com/<repo>/blob/<branch>/<path>?raw=true`.
On a **private** repo this matters: `raw.githubusercontent.com` needs a
short-lived `?token=` that GitHub's image proxy (camo) can't supply, so a
`raw.githubusercontent.com` image renders broken and clicking it bounces to a
github.com sign-in page. The `github.com/.../blob/…?raw=true` URL is
same-origin and served to anyone who can already see the PR. Hand-written PR
bodies that embed these GIFs must use the same form.

Set `DEMO_BASE_URL` to point the URLs at a custom public host (e.g. a
published mirror); the script then serves files directly from that base with
no `?raw=true` suffix.

## Writing a storyboard

Storyboards run with the plugin's `demo/` directory as the working directory,
so `output:` and `screenshot:` paths are plugin-relative
(`../../../../../../docs/plugins/{id}/demo/...`).

The plugin's `demo/vite.config.ts` is a stub over the shared factory — it
exists so every path resolves file-relative (npm exec anchors subprocess cwd
at the nearest `package.json`, which is why the demo directory keeps one):

```ts
import { createPluginDemoConfig } from '../../demo/vite-config'
export default createPluginDemoConfig(import.meta.url)
```

Start the harness server from the storyboard with:

```yaml
server: exec node ../../../../../../node_modules/vite/bin/vite.js --host 127.0.0.1 --config vite.config.ts
url: "http://127.0.0.1:5199/?enable={plugin-id}"
```

Invoke vite's bin directly behind `exec` (not through `npx`/`npm run`):
shot-scraper kills only the process it spawned, so any manager layer in
between orphans the dev server and the next recording hits "port already in
use" against a stale module graph. `record.mjs` fails fast when the
storyboard's port is already taken.

Harness conveniences available to scenes:

- `?enable={id}` (repeatable) — seed the user's Settings opt-in for a
  `defaultEnabled: false` plugin, exactly as a persisted `plugins.json` would.
- `?seed.{localStorage key}={JSON value}` — seed persisted state before any
  plugin code runs, e.g. a plugin's scoped storage namespace:
  `seed.craft-plugin-{id}:{key}={JSON}`.
- `window.__pluginDemo.setCaption(text)` — show/clear the caption overlay.
- `window.__pluginDemo.openSettings(bool)` — toggle the Settings → Plugins card.
- `window.__pluginDemo.showEdgePanels()` — register a second demo plugin's
  panels on other edges (the four-dock showcase).
- `{plugin}/demo/site/` — served at `http://127.0.0.1:5199/demo-site/` while
  that plugin records, for demos that need local web content.

## Manual shot-scraper invocation

From a plugin's `demo/` directory:

```sh
shot-scraper video storyboards/{name}.yml
```
