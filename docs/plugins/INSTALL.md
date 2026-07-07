# Installing & authoring external plugins

An **external plugin** is a folder you drop into `~/.craft-agent/plugins/` —
Craft Agents loads its code from disk, so you add a plugin *without rebuilding
the app*. This is the model code editors use (VS Code extensions, Vim/Emacs
packages, Obsidian community plugins): the framework validates and asks for
consent; **you, the installer, decide whether to trust the code.**

> In-tree "built-in" plugins (compiled with the app) are covered by
> [QUICKSTART.md](./QUICKSTART.md) and [AUTHORING.md](./AUTHORING.md). This
> page is about the drop-in, no-rebuild path.

## Where plugins live

```
~/.craft-agent/plugins/<id>/
├── plugin.json     # the manifest (id MUST equal the folder name)
├── renderer.mjs    # entries.renderer — exports activate(ctx)   (UI/commands)
└── main.mjs        # entries.main — exports activate(ctx)        (optional; ipc)
```

- `~/.craft-agent` is the config root (override with `CRAFT_CONFIG_DIR`).
- Enable/disable state lives in `~/.craft-agent/plugins.json`.
- The folder name **is** the plugin's identity — the host refuses a plugin
  whose manifest `id` doesn't match its folder (no impersonating another
  plugin or shadowing a built-in).

## Install in three steps

1. **Put the plugin folder** in `~/.craft-agent/plugins/`.
2. **Restart the app** so it's discovered (new folders are found at startup).
3. **Settings → Plugins** lists it. Toggle it on — you'll be shown its
   declared permissions and a trust prompt; confirm to enable. Enabling and
   disabling after that is live, no restart.

If a plugin doesn't appear, it failed validation — Settings lists the folder
with the reason. Run the CLI (below) to see the same errors from your
terminal.

## Author one with no build step

External entries are plain ESM. To avoid a bundler entirely, build UI with the
host's React handed to you as `ctx.react` (importing your own `react` copy
would break hooks) instead of JSX.

`~/.craft-agent/plugins/hello/plugin.json`:

```json
{
  "id": "hello",
  "name": "Hello",
  "version": "0.1.0",
  "icon": "🧩",
  "apiVersion": 1,
  "permissions": ["ui.sidePanel", "storage"],
  "contributes": { "sidePanels": [{ "id": "main", "title": "Hello", "location": "right" }] },
  "entries": { "renderer": "renderer.mjs" },
  "defaultEnabled": false
}
```

`~/.craft-agent/plugins/hello/renderer.mjs`:

```js
// No import of 'react' — use the host's copy via ctx.react.
export function activate(ctx) {
  const { useState } = ctx.react
  function Panel() {
    const [n, setN] = useState(() => ctx.storage.get('count', 0))
    return ctx.react.createElement(
      'button',
      { onClick: () => { const v = n + 1; setN(v); ctx.storage.set('count', v) } },
      'Clicked ' + n + ' times',
    )
  }
  ctx.ui.registerSidePanel({ id: 'main', title: 'Hello', component: Panel })
}
```

That's a working plugin — declared panel, lazy activation (its code runs when
the panel is first opened), and storage that survives restarts. The full
context API (`ctx.commands`, `ctx.hooks`, `ctx.invoke`, `ctx.webviewPartition`)
is in [AUTHORING.md](./AUTHORING.md); it's identical for built-in and external
plugins. If you prefer JSX/TypeScript, bundle your plugin to a single ESM file
with your own toolchain and point `entries.renderer` at the output — the host
just dynamically imports whatever file you name.

## The `plugin` CLI

Validate and scaffold from the repo without launching the app:

```bash
# Scaffold a runnable starter into ~/.craft-agent/plugins/my-plugin
bun run plugin:new my-plugin

# ...or into a directory you choose
bun run plugin:new my-plugin --dir ./some/dir

# Validate a plugin folder (or its plugin.json) — same checks the host runs,
# plus id/dir match and entry-file existence. Exit code 1 on failure.
bun run plugin:validate ~/.craft-agent/plugins/my-plugin
```

`plugin:validate` reports the exact zod errors (missing `version`, bad
`permission`, an `entries.renderer` that doesn't exist, …) so you fix the
manifest before the app ever sees it. `plugin:new` writes a `plugin.json` +
`renderer.mjs` that already pass validation.

## Trust model (read before enabling third-party plugins)

External plugin code runs **in-process, with the same access as the app** —
there is no sandbox around it in v1 (the one hard boundary is the `<webview>`
guest; see [SECURITY.md](./SECURITY.md)). The framework does what it can:

- validates the manifest and refuses invalid ones (listed with the reason);
- refuses id/folder mismatches and `entries.*` paths that escape the folder;
- gates the plugin `apiVersion`;
- shows declared permissions and requires **explicit consent** before enabling;
- rolls back a main-process plugin that throws mid-activation, and keeps
  `invoke` unreachable until the plugin is actively running.

What it does **not** do is protect you from code you chose to enable. Treat an
external plugin like a browser extension: **install only plugins you trust, and
read the source when in doubt.** A manifest `repository`/source link and
signed, isolated loading of *untrusted* code are future work (DESIGN.md).
