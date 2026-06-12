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
  "entries": { "renderer": "renderer.tsx", "main": "main.ts" },
  "defaultEnabled": true           // built-ins only; external plugins always start disabled
}
```

Rules enforced by the loader:

- An external plugin's directory name must equal its manifest `id`.
- Duplicate ids are rejected; built-ins register first, so an external plugin
  can never shadow a built-in.
- Unknown or duplicate permissions fail validation.

## Permissions

The permission set is fixed and typed (`PluginPermission`). The host grants
exactly what's declared — using an undeclared surface throws.

| Permission | Grants access to |
|---|---|
| `ui.sidePanel` | `ctx.ui.*` — register/open/close right-hand side panes |
| `ui.webview` | `ctx.webviewPartition` — embed web content in a hardened `<webview>` |
| `storage` | `ctx.storage` — persistent KV scoped to the plugin |
| `ipc` | `ctx.invoke` — call the plugin's own main-process handlers |

See [SECURITY.md](./SECURITY.md) for what each permission does and does not allow.

## Lifecycle

```
discover → register → (enabled?) → activate(ctx) → … → deactivate/dispose
```

- Discovery happens at app startup (built-in list + `~/.craft-agent/plugins/`).
- Enable/disable is live: the renderer runtime reacts to Settings toggles in
  every window without a restart. The one exception: enabling or disabling a
  `ui.webview` plugin flips the window-level `webviewTag` flag, which Electron
  fixes at window creation — the Settings page offers a relaunch when needed.
- `activate(ctx)` may return a `PluginDisposable` (or array). Everything you
  register through `ctx` is also tracked automatically; deactivation disposes
  all of it in reverse order.
- A throwing `activate` marks the plugin `status: 'error'` (visible in
  Settings) and never affects other plugins or the host.

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

### Side panes

Registered panes appear as icons in a thin toggle rail on the right edge of
the shell. Clicking an icon opens the pane (resizable, persisted width);
clicking the active icon closes it. The pane host renders your component only
while the pane is open — design panels to restore their state from
`ctx.storage` (the browser plugin persists its last URL this way).

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

Channels are namespaced per plugin (`plugin:<id>:<channel>` on the wire); the
renderer can only reach its own plugin's handlers, and only while the plugin is
enabled.

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

Follow `apps/electron/src/plugins/web-browser/__tests__/` — plugins are
testable through the framework alone:

- validate the manifest with `validatePluginManifest`
- activate against a real `createPluginContext(manifest)` and assert on
  `getPluginPaneState()`
- SSR-render the registered component (`react-dom/server`) for a mount smoke test
- registry lifecycle is covered by `packages/shared/src/plugins/__tests__/`

Run with `bun test apps/electron/src/plugins` and
`bun test packages/shared/src/plugins`.
