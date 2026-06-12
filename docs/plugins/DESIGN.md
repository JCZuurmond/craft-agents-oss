# Plugin Framework — Design Note (issue #256)

This document records what was found in the codebase before designing the plugin
framework, the design decisions that follow from it, and the extension-point
inventory the framework exposes.

## Phase 1 — Codebase findings

### Monorepo layout & boundaries

- `packages/core` — lightweight shared types; `packages/shared` — business logic
  (agent, auth, config, credentials, sessions, sources, skills, automations,
  statuses, labels). All cross-cutting, host-agnostic logic lives in
  `packages/shared/src/<area>/` with a subpath export per area
  (`@craft-agent/shared/<area>` in `packages/shared/package.json#exports`).
- `apps/electron` — `src/main` (Electron main), `src/preload/bootstrap.ts`
  (context bridge), `src/renderer` (React + Vite), `src/shared` (types shared
  across the three).
- `apps/cli`, `packages/server*` — headless server + CLI. These never load
  renderer code; plugin UI must not leak into them.

**Conclusion:** manifest/validation/registry/persistence logic belongs in a new
`packages/shared/src/plugins/` area exported as `@craft-agent/shared/plugins`.
The Electron-only host (IPC, webview hardening, React slot system) belongs in
`apps/electron`.

### Existing extensibility precedents

| Feature | Storage | Manifest | Validation | Discovery |
|---|---|---|---|---|
| Sources | `{workspace}/sources/{slug}/config.json` | JSON | manual (`config/validators.ts`) | `loadWorkspaceSources()` |
| Skills | `{workspace}/skills/{slug}/SKILL.md` + global `~/.agents/skills/` | YAML frontmatter | manual required-fields | `loadAllSkills()` (tiered: global < workspace < project) |
| Automations | `{workspace}/automations.json` | JSON | **zod** (`automations/schemas.ts`) | `AutomationSystem.reloadConfig()` |
| Statuses | `{workspace}/statuses/config.json` | JSON | manual (`statuses/validation.ts`) | `loadStatusConfig()` |

Common conventions reused by the plugin framework:

- Config root `CONFIG_DIR` (`~/.craft-agent`, overridable via `CRAFT_CONFIG_DIR`
  — this is also how tests isolate storage).
- One directory per item, `*.json` manifest, slug-style ids.
- zod validation (the newest precedent, automations) with a
  `{ valid, errors }` result shape.
- Storage modules are pure sync-fs functions, unit-tested under
  `src/<area>/__tests__/` with `bun test`.

### Renderer layout

`AppShell.tsx` composes a horizontal flex shell:
`PanelStackContainer(sidebarSlot, navigatorSlot, content panels)` followed by
absolutely-positioned resize handles. `PanelStackContainer` already accepts an
`isRightSidebarVisible` prop and documents that *"the right sidebar stays
OUTSIDE this container"* — AppShell currently hardcodes `false` and mounts
nothing on the right. That untaken seam is exactly where a plugin pane mounts.

State is jotai (note: the app uses a `<JotaiProvider>` scope, so module-level
registries can't rely on jotai's default store) plus a typed `localStorage`
helper (`renderer/lib/local-storage.ts`, central `KEYS`).

### IPC patterns

`preload/bootstrap.ts` builds `window.electronAPI` from a WS-RPC channel map
(local server / remote server routing), then augments it with a small set of
**direct `ipcRenderer.invoke` methods for Electron-local concerns**
(`app:relaunch`, `workspace:remove`, `i18n:changeLanguage`, `__dialog:*`,
`__browser:invoke`). Plugins are an Electron-client feature (they contribute UI
to the desktop shell), so the plugin surface uses the direct-IPC tier — the
headless server, webui and CLI are untouched.

### Security model

- Main windows: `contextIsolation: true`, `nodeIntegration: false`,
  `webviewTag: false`.
- The existing agent-browser feature (`browser-pane-manager.ts`) opens
  **separate chromeless `BrowserWindow`s** with sandboxed `BrowserView`s — it is
  not an in-app pane and is not a plugin precedent; it does demonstrate the
  house style for embedded web content: dedicated `persist:` session partition,
  sandbox, UA scrubbing, popup containment.
- Local MCP subprocesses get a filtered environment; credentials are
  AES-256-GCM encrypted and only reachable through `src/credentials/`.

**Conclusion for the embedded browser:** plugin web content uses `<webview>`
gated behind an explicit `ui.webview` permission. The host enables
`webviewTag` on app windows only when an enabled plugin declares that
permission, and hardens every attach via `will-attach-webview` (force
`contextIsolation`, `sandbox`, no `nodeIntegration`, strip preloads, require a
`persist:craft-plugin-*` partition). Plugin partitions get a deny-by-default
permission-request handler. Plugins never see Node, Electron APIs, app
credentials, or the agent's environment.

### Build pipeline

Main is bundled with esbuild, preload with esbuild, renderer with Vite
(single bundle; no dynamic plugin import infrastructure exists). Therefore v1
plugins are **bundled plugins**: code ships in-tree under
`apps/electron/src/plugins/<id>/` and is registered in one data file
(`apps/electron/src/plugins/index.ts`). The loader additionally discovers
**external manifests** under `~/.craft-agent/plugins/<id>/plugin.json` so the
registry/settings/enable-disable machinery already treats plugins as data;
loading external *code* is future work (see "Future work").

## Phase 2 — Design

### Plugin manifest (`plugin.json`)

```jsonc
{
  "id": "web-browser",            // slug, unique
  "name": "Browser Pane",         // display name
  "version": "0.1.0",             // semver
  "description": "…",             // optional
  "icon": "🌐",                   // optional, emoji or URL (same rules as skills)
  "permissions": ["ui.sidePanel", "ui.webview"],
  "entries": { "renderer": "renderer.tsx" }, // entry points (informational for bundled plugins)
  "defaultEnabled": true          // optional, default false for external plugins
}
```

Validated with zod (`validatePluginManifest`), mirroring automations.

### Permissions

Fixed, typed set — the host grants only what's declared, and surfaces it in
Settings → Plugins:

| Permission | Grants |
|---|---|
| `ui.sidePanel` | register panes in the right-hand plugin pane host |
| `ui.webview` | embed remote web content in a hardened `<webview>` (dedicated `persist:craft-plugin-<id>` partition) |
| `storage` | persistent key-value storage scoped to the plugin |
| `ipc` | invoke main-process handlers registered for this plugin (namespaced `plugin:<id>:<channel>`) |

No permission grants access to credentials, app config, sessions, or Node APIs.
Undeclared capability access throws.

### Lifecycle

`discover → register → (enabled?) activate → deactivate/dispose`

- Discovery: built-in manifest list + `~/.craft-agent/plugins/*/plugin.json`.
- Enable/disable state: `~/.craft-agent/plugins.json` (app-level, same tier as
  `config.json`/`preferences.json`). Toggling is live: the renderer host
  activates/deactivates without an app restart (matching the app's "no
  restart" ethos). The `ui.webview` *window flag* is computed at window
  creation; enabling a webview plugin for the first time asks for a window
  reload.
- Activation: `activate(ctx)` returns an optional disposable; every
  registration made through `ctx` is tracked and auto-disposed on deactivate.
  A throwing plugin is marked `status: 'error'` and never takes the host down.

### Context object (`PluginContext`)

```ts
interface PluginContext {
  manifest: PluginManifest
  logger: PluginLogger                    // prefixed console logging
  storage: PluginStorage                  // scoped KV (requires 'storage')
  ui: { registerSidePanel(c): Disposable; openSidePanel(id); closeSidePanel(id) } // 'ui.sidePanel'
  invoke(channel, args): Promise<unknown> // 'ipc' → plugin:<id>:<channel> in main
  webviewPartition: string                // 'ui.webview' → persist:craft-plugin-<id>
}
```

## Extension-point inventory

1. **Right side pane** (`ui.sidePanel`) — `ctx.ui.registerSidePanel({ id,
   title, icon, component })`. Mounts into `PluginPaneHost`, the one additive
   AppShell seam (the previously-unused right-sidebar slot). Host owns
   visibility, focus, width, resize sash, and a toggle rail; state persists in
   `localStorage` under central `KEYS`.
2. **Hardened web embed** (`ui.webview`) — per-plugin session partition +
   `will-attach-webview` enforcement in main. This is a *framework* capability;
   the browser plugin is just its first consumer.
3. **Main-process capabilities** (`ipc`) — main-side plugin modules register
   handlers via `PluginMainContext.handle(channel, fn)`; renderer reaches them
   through `ctx.invoke`. Channels are namespaced and permission-gated
   (`__plugins:invoke` rejects undeclared/disabled plugins).
4. **Scoped storage** (`storage`) — namespaced persistent KV per plugin.
5. **Registry & settings surface** — Settings → Plugins lists every discovered
   plugin (built-in and external) with permissions and an enable/disable
   switch; changes broadcast to all windows (`__plugins:changed`).

## How core stays decoupled

Core changes are additive and generic (nothing knows the browser plugin exists):

- `AppShell.tsx`: mount `PluginPaneHost` in the existing right-sidebar seam and
  feed `isRightSidebarVisible` from it.
- `window-manager.ts`: `webviewTag` computed from "any enabled plugin declares
  `ui.webview`" instead of hardcoded `false`.
- `main/index.ts`: one `initializePluginHost()` call.
- `preload/bootstrap.ts`: `plugins.*` direct-IPC methods.
- Settings registry/menu/i18n: one `plugins` page entry.

Everything else is new files. Removing `apps/electron/src/plugins/web-browser/`
plus its one registration line removes the browser pane completely.

## Future work (explicitly out of scope for v1)

- Loading external plugin *code* (the manifest/discovery/enable machinery
  already treats plugins as data; code loading needs a vetted module pipeline —
  signed bundles or a custom protocol — and likely renderer-process isolation).
- Workspace-scoped plugin enablement (per-workspace overrides of the app-level
  state, like themes).
- Event-bus subscriptions (`SessionStart`/`PostToolUse`…): the
  `WorkspaceEventBus` lives server-side in the automations system; exposing a
  read-only mirror to client plugins needs a transport design pass.
- Plugin-contributed agent tools/MCP servers (today: use sources/skills).
