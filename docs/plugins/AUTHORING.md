# Plugin Authoring Guide

## The manifest

Every plugin is described by a manifest. Built-in plugins export it from
`manifest.ts`; external plugins put it in `plugin.json`. Validation is zod-based
(`validatePluginManifest` in `@craft-agent/shared/plugins`) and runs on every
discovery — invalid manifests are skipped, never crash the host.

```jsonc
{
  // Required
  "id": "my-plugin",          // slug: lowercase letters, digits, hyphens; unique
  "name": "My Plugin",        // display name (Settings, pane headers)
  "version": "0.1.0",         // semver
  "permissions": [],          // see below — empty array is valid

  // Optional
  "description": "What it does",   // shown in Settings → Plugins
  "icon": "🧩",                    // emoji or https URL (same rules as skills)
  "apiVersion": 1,                 // plugin API version you target (default 1)
  "contributes": {                 // static contributions — see below
    "sidePanels": [
      { "id": "main", "title": "My Panel", "icon": "🧩", "location": "right" }
    ]
  },
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
  the `ui.sidePanel` permission.
- A manifest targeting an `apiVersion` the host cannot satisfy is listed in
  Settings with the incompatibility reason and never activated or enabled.
  The host's current version is `PLUGIN_API_VERSION` in
  `@craft-agent/shared/plugins`.

## Declarative contributions vs. `activate()`

`contributes` describes **what** your plugin offers; `activate()` wires **how**
it behaves. Declare your side panels in the manifest whenever you can:

- Settings lists them without running your code.
- Their toggle-rail buttons render from manifest data alone.
- Your plugin activates **lazily** — `activate(ctx)` runs the first time one
  of your panels is opened, not at app startup. (Plugins with no declared
  panels activate eagerly at startup instead, since nothing about them is
  known until code runs.)

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
| `ui.sidePanel` | `ctx.ui.*` — register/open/close side panels (left or right edge) |
| `ui.webview` | `ctx.webviewPartition` — embed web content in a hardened `<webview>` inside one of your panels |
| `storage` | `ctx.storage` — persistent KV scoped to the plugin |
| `ipc` | `ctx.invoke` — call the plugin's own main-process handlers |

See [SECURITY.md](./SECURITY.md) for what each permission does and does not
allow — including the honest boundary between enforcement and ergonomics.

## Lifecycle

```
discover → register → (enabled?) → activate(ctx) → … → deactivate/dispose
```

- Discovery happens at app startup (built-in list + `~/.craft-agent/plugins/`).
- Renderer activation is lazy for plugins with declared panels (first open),
  eager otherwise; main-process activation is always eager (webview policy and
  IPC handlers must exist before first use).
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
  boundary: the pane shows the failure with a Retry button, the crash is
  attributed to your plugin in Settings, and the rest of the shell is
  unaffected.

## Renderer API (`PluginContext`)

Defined in `apps/electron/src/renderer/plugins/types.ts`.

```ts
export function activate(ctx: PluginContext): void {
  // Identity
  ctx.manifest            // your validated PluginManifest

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
    location: 'right',                // 'left' | 'right' (default 'right')
    component: MyPanel,               // React component, receives { isActive }
  })
  ctx.ui.openSidePanel('main')        // open + focus
  ctx.ui.closeSidePanel('main')       // close if active

  // Main-process calls (requires 'ipc')
  const result = await ctx.invoke('my-channel', { some: 'args' })

  // Webview embedding (requires 'ui.webview')
  // The ONLY partition the main process will allow your webviews to use:
  <webview partition={ctx.webviewPartition} src="https://…" />
}
```

### Side panels

Panels appear as icons in a thin toggle rail on their shell edge (left or
right). Clicking an icon opens the pane (resizable, per-window persisted
width); clicking the active icon closes it. The pane host renders your
component only while the pane is open — design panels to restore their state
from `ctx.storage`.

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

Channels are namespaced per plugin (`plugin:<id>:<channel>` on the wire), and
the main process validates on every call that the target plugin is enabled and
declares `ipc`. Note the honest caveat from [SECURITY.md](./SECURITY.md): in a
shared renderer context the main process cannot attribute *which* in-process
caller named a plugin id, so "only your own handlers" is a convention the
typed `ctx.invoke` upholds, not a cross-plugin enforcement boundary.

## Imports: browser-safe vs. Node

`@craft-agent/shared/plugins` is browser-safe (types, validation, registry) —
import it from anywhere. Discovery/persistence code that touches the
filesystem lives in `@craft-agent/shared/plugins/node` — main process and
tests only. Plugin code should never need the node subpath.

## Registration (built-in plugins)

Three one-line registrations, all data files:

1. `apps/electron/src/plugins/manifests.ts` → add your manifest to
   `BUILTIN_PLUGIN_MANIFESTS` (imported by main *and* renderer — keep your
   `manifest.ts` free of React/Electron imports).
2. `apps/electron/src/plugins/renderer-entries.ts` → map your id to your
   renderer `activate` (renderer-only import graph).
3. `apps/electron/src/plugins/main-entries.ts` → map your id to your main
   `activate` (main-only import graph), if you have one.

## Testing

Plugins are testable through the framework alone:

- validate the manifest with `validatePluginManifest`
- activate against a real `createPluginContext(manifest)` and assert on
  `getPluginPaneState()`
- SSR-render the registered component (`react-dom/server`) for a mount smoke test
- registry lifecycle, manifest validation, and API-version gating are covered
  by `packages/shared/src/plugins/__tests__/`

Run with `bun test apps/electron/src/plugins` and
`bun test packages/shared/src/plugins`.
