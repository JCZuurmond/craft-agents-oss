# Plugin Authoring Guide

## The manifest

Every plugin is described by a manifest. Built-in plugins export it from
`manifest.ts` (typed as `PluginManifest`, checked by the compiler); external
plugins put it in `plugin.json`, validated with zod
(`validatePluginManifest` in `@craft-agent/shared/plugins`) at every
discovery. An external manifest that fails validation never crashes the
host — the directory is listed in Settings → Plugins with the errors so you
see *why* it didn't load.

```jsonc
{
  // Required
  "id": "my-plugin",          // slug: lowercase letters, digits, hyphens; unique
  "name": "My Plugin",        // display name (Settings, dock headers)
  "version": "0.1.0",         // semver
  "permissions": [],          // see below — empty array is valid

  // Optional
  "description": "What it does",   // shown in Settings → Plugins
  "icon": "🧩",                    // emoji or https URL (same rules as skills)
  "apiVersion": 1,                 // plugin API version you target (default 1)
  "contributes": {                 // static contributions — see below
    "sidePanels": [
      { "id": "main", "title": "My Panel", "icon": "🧩", "location": "right" }
    ],
    "commands": [
      { "id": "open", "title": "Open My Panel", "keybinding": "mod+shift+9" }
    ]
  },
  "activationEvents": ["onPanel:main", "onCommand:open"],  // when activate() runs (default inferred)
  "entries": { "renderer": "renderer.tsx", "main": "main.ts" },
  "defaultEnabled": true           // built-ins only; external plugins always start disabled
}
```

Rules enforced by the loader:

- An external plugin's directory name must equal its manifest `id`.
- Duplicate ids are rejected; built-ins register first, so an external plugin
  can never shadow a built-in.
- Unknown or duplicate permissions fail validation; duplicate panel ids within
  `contributes.sidePanels` fail validation; declaring `sidePanels` requires
  the `ui.sidePanel` permission; declaring `commands` requires the `commands`
  permission.
- Keybindings must be modifier(s)+key in the app's hotkey format (e.g.
  `mod+shift+b`; `mod` = Cmd on macOS, Ctrl elsewhere) and must include `mod`
  or `alt` — bare keys and shift-only chords are reserved for typing. A chord
  that collides with a core app shortcut is refused at runtime (with a console
  warning); core shortcuts always win.
- `activationEvents` entries must be `onStartup`, `onPanel:{panelId}`, or
  `onCommand:{commandId}`, and the referenced panel/command ids must exist in
  `contributes`.
- A manifest targeting an `apiVersion` the host cannot satisfy is listed in
  Settings with the incompatibility reason and never activated or enabled.
  The host's current version is `PLUGIN_API_VERSION` in
  `@craft-agent/shared/plugins`.

## Declarative contributions vs. `activate()`

`contributes` describes **what** your plugin offers; `activate()` wires **how**
it behaves. Declare your side panels and commands in the manifest whenever you
can:

- Settings lists them without running your code.
- Panel toggle-rail buttons and command keybindings work from manifest data
  alone.
- Your plugin activates **lazily** — `activate(ctx)` runs the first time one
  of your panels is opened or one of your commands executes, not at app
  startup. (Plugins with no declarative contributions activate eagerly at
  startup instead, since nothing about them is known until code runs.)

`activationEvents` makes this policy explicit when you need to override the
inferred default — most plugins never declare it:

| Event | `activate()` runs when… |
|---|---|
| `onStartup` | the renderer plugin runtime initializes |
| `onPanel:{panelId}` | the declared panel is first opened |
| `onCommand:{commandId}` | the declared command first executes (keybinding or `executeCommand`) |

The common override is a plugin with declared panels that also needs a
background listener from startup: declare `["onStartup"]`.

Note the v1 scope of an explicit list: it decides **startup eagerness**
(`onStartup` present or not). The per-id `onPanel:`/`onCommand:` entries are
validated against your declared contributions and document intent, but a lazy
plugin activates on the first use of *any* of its declared panels or
commands — the host does not restrict activation to the listed ids.

At activation time, register the component for each declared panel with the
same panel id. The declaration is the source of truth for title/icon/location;
the registration supplies the component:

```ts
export function activate(ctx: PluginContext): void {
  ctx.ui.registerSidePanel({ id: 'main', title: 'My Panel', component: MyPanel })
  // title/icon/location come from the manifest declaration when one exists
}
```

If your plugin needs to run at startup regardless of panel visibility (a
background renderer listener), skip `contributes.sidePanels` and register
panels imperatively — that opts you into eager activation.

## Permissions

The permission set is fixed and typed (`PluginPermission`). The host grants
exactly what's declared — using an undeclared surface throws.

| Permission | Grants access to |
|---|---|
| `ui.sidePanel` | `ctx.ui.*` — register/open/close side panels on any shell edge (left/right/top/bottom) |
| `ui.webview` | `ctx.webviewPartition` — embed web content in a hardened `<webview>` inside one of your panels |
| `commands` | `ctx.commands.*` — register handlers for your declared commands (with their keybindings) and execute commands |
| `storage` | `ctx.storage` — persistent KV scoped to the plugin |
| `ipc` | `ctx.invoke` — call the plugin's own main-process handlers |

`ctx.hooks` (framework lifecycle observation) needs no permission — hooks only
broadcast plugin-framework events, never user or session data.

See [SECURITY.md](./SECURITY.md) for what each permission does and does not
allow — including the honest boundary between enforcement and ergonomics.

## Lifecycle

```
discover → register → (enabled?) → activate(ctx) → … → deactivate/dispose
```

- Discovery happens at app startup (built-in list + `~/.craft-agent/plugins/`).
- Renderer activation follows the activation events (explicit or inferred):
  lazy on first panel open / first command execution for plugins with
  declarative contributions, eager at startup otherwise; main-process
  activation is always eager (webview policy and IPC handlers must exist
  before first use).
- Enable/disable is live: the renderer runtime reacts to Settings toggles in
  every window without a restart. Toggling a plugin on activates it
  immediately (no laziness — the user asked for it now). The one exception:
  enabling or disabling a `ui.webview` plugin flips the window-level
  `webviewTag` flag, which Electron fixes at window creation — the Settings
  page offers a relaunch when needed.
- `activate(ctx)` may return a `PluginDisposable` (or array). Everything you
  register through `ctx` is also tracked automatically; deactivation disposes
  all of it in reverse order.
- A throwing `activate` marks the plugin `status: 'error'` (visible in
  Settings — renderer-side failures are reported per window to the main host)
  and never affects other plugins or the host.
- A panel component that throws during render is quarantined by an error
  boundary: the dock shows the failure with a Retry button, the crash is
  attributed to your plugin in Settings, and the rest of the shell is
  unaffected.

## Renderer API (`PluginContext`)

Defined in `apps/electron/src/renderer/plugins/types.ts`.

```ts
export function activate(ctx: PluginContext): void {
  // Identity
  ctx.manifest            // your validated PluginManifest

  // The host's React — build UI without importing your own copy or using JSX.
  // Essential for external, no-build plugins; built-ins may import react too.
  ctx.react.createElement('div', null, 'hi')

  // Logging — prefixed with [plugin:<id>]
  ctx.logger.info('hello')

  // Scoped persistent storage (requires 'storage')
  ctx.storage.set('key', { any: 'json' })
  const value = ctx.storage.get('key', fallback)

  // UI contributions (requires 'ui.sidePanel')
  ctx.ui.registerSidePanel({
    id: 'main',                       // unique within your plugin
    title: 'My Panel',
    icon: '🧩',                       // shown in the toggle rail
    location: 'right',                // 'left' | 'right' | 'top' | 'bottom' (default 'right')
    component: MyPanel,               // React component, receives { isActive }
  })
  ctx.ui.openSidePanel('main')        // open + focus
  ctx.ui.closeSidePanel('main')       // close if active

  // Commands (requires 'commands') — register handlers for your declared
  // command ids; the declaration supplies title/keybinding
  ctx.commands.register('open', () => ctx.ui.openSidePanel('main'))
  await ctx.commands.execute('my-plugin.open')   // cross-plugin dispatch by qualified id

  // Hooks — observe framework lifecycle events (no permission; Emacs add-hook style)
  ctx.hooks.on('panel:opened', ({ pluginId, panelId, location }) => { /* … */ })
  // Vocabulary: app:ready, plugin:activated, plugin:deactivated,
  //             panel:opened, panel:closed, command:executed

  // Main-process calls (requires 'ipc')
  const result = await ctx.invoke('my-channel', { some: 'args' })

  // Webview embedding (requires 'ui.webview')
  // The ONLY partition the main process will allow your webviews to use:
  <webview partition={ctx.webviewPartition} src="https://…" />
}
```

### Side panels

Panels appear as icons in a thin toggle rail on their shell edge — any of
the four (the Emacs side-window model): `left` and `right` docks sit beside
the content and resize by width; `top` and `bottom` docks span the content
area (VS Code's bottom-panel geometry) and resize by height. Clicking an
icon opens the dock (resizable, per-window persisted size); clicking the
active icon closes it. The dock renders your component only while it is
open — design panels to restore their state from `ctx.storage`.

The main content panels (chat, session list) are deliberately not
contributable in v1 — plugins extend around the spine, never into it.

### Commands and keybindings

Commands are the universal editor extensibility primitive (VS Code commands,
Emacs `M-x`, Vim ex commands). Declare them in `contributes.commands`, then
register a handler for each declared id at activation time — the declaration
is the source of truth for title and keybinding, the registration supplies the
behavior. A declared command whose plugin has not activated yet activates it
first, then dispatches (`onCommand:` lazy activation), so keybindings work
from app startup without loading your code.

Keybinding rules, in precedence order:

1. Core app shortcuts always win — the core action registry handles keys in
   the capture phase; plugin bindings only see what core did not claim, and a
   chord equal to a core default is refused at declare time.
2. Plugin keybindings never fire while a text input is focused or a
   modal/menu is open.

`ctx.commands.register` also accepts undeclared, code-only command ids (useful
for internal dispatch targets), but those get no keybinding, no Settings
listing, and no lazy activation.

### Hooks

`ctx.hooks.on(hook, listener)` is the Emacs `add-hook` pattern: the host runs
your listener when the named framework event happens. Listeners observe — they
cannot veto or reorder host behavior — and a throwing listener is isolated
(logged, never breaks other plugins or the host). Subscriptions are disposed
automatically on deactivate. Agent/session events are deliberately not hooks;
they stay reserved behind the future `events.read` permission (see DESIGN.md).

## Main-process API (`PluginMainContext`)

For plugins that need main-process capabilities (requires `ipc`). Defined in
`apps/electron/src/main/plugin-host.ts`, registered in
`apps/electron/src/plugins/main-entries.ts`:

```ts
// apps/electron/src/plugins/my-plugin/main.ts
import type { PluginMainEntry } from '../main-entries'

export const activate: PluginMainEntry = (ctx) => {
  return ctx.handle('my-channel', async (args) => {
    ctx.log('handling my-channel')
    return { ok: true }
  })
}
```

Handlers are namespaced per plugin (the renderer reaches them through the
host's single `__plugins:invoke` bridge, addressed by plugin id + channel),
and the main process validates on every call that the target plugin is
enabled, actively running, and declares `ipc`. Note the honest caveat from [SECURITY.md](./SECURITY.md): in a
shared renderer context the main process cannot attribute *which* in-process
caller named a plugin id, so "only your own handlers" is a convention the
typed `ctx.invoke` upholds, not a cross-plugin enforcement boundary.

## Imports: browser-safe vs. Node

`@craft-agent/shared/plugins` is browser-safe (types, validation, registry) —
import it from anywhere. Discovery/persistence code that touches the
filesystem lives in `@craft-agent/shared/plugins/node` — main process and
tests only. Plugin code should never need the node subpath.

## Getting your plugin loaded

There are two ways to ship a plugin; the manifest and `activate(ctx)` API are
identical for both.

**External (drop-in, no rebuild)** — the easy path for custom plugins. Put the
plugin folder under `~/.craft-agent/plugins/<id>/` with its `plugin.json` and
the entry files named in `entries` (e.g. `renderer.mjs`, `main.mjs`); the host
loads the code from disk. No registration files, no build of the app. See
[INSTALL.md](./INSTALL.md).

**Built-in (compiled with the app)** — three one-line registrations, all data
files:

1. `apps/electron/src/plugins/manifests.ts` → add your manifest to
   `BUILTIN_PLUGIN_MANIFESTS` (imported by main *and* renderer — keep your
   `manifest.ts` free of React/Electron imports).
2. `apps/electron/src/plugins/renderer-entries.ts` → map your id to your
   renderer `activate` (renderer-only import graph).
3. `apps/electron/src/plugins/main-entries.ts` → map your id to your main
   `activate` (main-only import graph), if you have one.

## Testing

Plugins are testable through the framework alone:

- validate the manifest with `validatePluginManifest`, or a whole folder with
  `validatePluginDirectory` (`@craft-agent/shared/plugins/node`) — the CLI
  `bun run plugin:validate <dir>` wraps it
- activate against a real `createPluginContext(manifest)` and assert on
  `getPluginPanelState()`
- for external loading, inject a fake module via
  `setExternalRendererModuleLoader` / `setExternalMainModuleLoader` and assert
  the plugin registers its panels/handlers (see
  `apps/electron/src/renderer/plugins/__tests__/external-loading.test.ts`)
- SSR-render the registered component (`react-dom/server`) for a mount smoke test
- registry lifecycle, manifest validation, and API-version gating are covered
  by `packages/shared/src/plugins/__tests__/`

Run with `bun test packages/shared/src/plugins` and
`bun test apps/electron/src/renderer/plugins/__tests__`.

## Product demos (optional)

A plugin can ship auto-generated PR-review demos: keep shot-scraper
storyboards in `{your-plugin}/demo/storyboards/` and record them with the
shared tooling in `apps/electron/src/plugins/demo/` (`node record.mjs
<plugin-id>`), which runs your unmodified plugin on the real renderer runtime
in a browser page and writes a GIF/WebM per storyboard to
`docs/plugins/{plugin-id}/demo/`. See
[`apps/electron/src/plugins/demo/README.md`](../../apps/electron/src/plugins/demo/README.md).
