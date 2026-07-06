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
`apps/electron/src/plugins/<id>/` and is registered in three data files —
`manifests.ts` (manifest, imported by both processes), `renderer-entries.ts`
(renderer activate, renderer-only), and `main-entries.ts` (main activate,
main-only). The split exists because manifests are plain data consumed by both
processes while entries must never leak React into main or Node into the
renderer. The loader additionally discovers **external manifests** under
`~/.craft-agent/plugins/<id>/plugin.json` so the
registry/settings/enable-disable machinery already treats plugins as data;
loading external *code* is future work (see "Future work").

## Phase 2 — Design

### Plugin manifest (`plugin.json`)

```jsonc
{
  "id": "hello-pane",             // slug, unique
  "name": "Hello Pane",           // display name
  "version": "0.1.0",             // semver
  "description": "…",             // optional
  "icon": "👋",                   // optional, emoji or URL (same rules as skills)
  "apiVersion": 1,                // plugin API version targeted (optional, default 1)
  "permissions": ["ui.sidePanel", "commands"],
  "contributes": {                // static contributions (introspectable without code)
    "sidePanels": [{ "id": "main", "title": "Hello", "icon": "👋", "location": "right" }],
    "commands": [{ "id": "open", "title": "Open Hello", "keybinding": "mod+shift+9" }]
  },
  "activationEvents": ["onPanel:main", "onCommand:open"], // optional; default inferred
  "entries": { "renderer": "renderer.tsx" }, // entry points (informational for bundled plugins)
  "defaultEnabled": true          // optional, default false for external plugins
}
```

Validated with zod (`validatePluginManifest`), mirroring automations.

**Declarative contributions (`contributes`).** Static metadata about what a
plugin offers is separated from what it does (`activate()`), following the
VS Code/Eclipse model. Declared side panels and commands power three things
without running any plugin code: Settings can list them, the panel docks render
panel toggle buttons and the command store binds keybindings from manifest
data alone, and activation becomes **lazy** (plugins without declarative
contributions still activate eagerly at startup, since their contributions
exist only in code). The declaration is the source of truth for
title/icon/location/keybinding; `ctx.ui.registerSidePanel()` /
`ctx.commands.register()` with the same id supplies the component/handler at
activation time.

**Activation events (`activationEvents`).** The VS Code lazy-activation
vocabulary (and the spirit of Vim autoload — code loads when first used):
`onStartup`, `onPanel:{panelId}`, `onCommand:{commandId}`. Absent = inferred
from declared contributions (declarative → lazy, code-only → eager), which is
exactly the pre-activationEvents behavior; declaring events makes the policy
explicit, e.g. a panel plugin that also needs a startup listener declares
`["onStartup"]`. Events referencing undeclared ids fail validation.

**Commands (`contributes.commands`).** The universal editor extensibility
primitive — VS Code commands, Emacs interactive commands (`M-x`), Vim ex
commands. Every user-invocable plugin behavior (keybindings today; a future
palette or plugin menu items) dispatches through one host command registry
keyed by qualified id (`{pluginId}.{commandId}`, the VS Code dotted-id
convention). Keybindings ride on the declaration; the app's existing action
registry keeps absolute precedence (its capture-phase listener claims core
chords first, and chords equal to a core default are refused at declare
time), and plugin bindings never fire in text inputs or open menus.

**API versioning (`apiVersion`).** The host advertises `PLUGIN_API_VERSION`
(from `@craft-agent/shared/plugins`); a manifest pins the version it targets
(missing = 1). A plugin targeting a version the host cannot satisfy is
registered as permanently errored — listed in Settings with the reason,
never activated, never enable-able — instead of breaking silently on an app
upgrade. This is the `engines.vscode` lesson applied to the plugin contract.

### Permissions

Fixed, typed set — the host grants only what's declared, and surfaces it in
Settings → Plugins:

| Permission | Grants |
|---|---|
| `ui.sidePanel` | register panels in the plugin docks (any shell edge: left, right, top, or bottom) |
| `ui.webview` | embed remote web content in a hardened `<webview>` (dedicated `persist:craft-plugin-<id>` partition); a sub-capability of a side panel, listed as a permission because it changes the window-level security posture |
| `commands` | register handlers for declared commands (with their keybindings) and execute commands through the host registry |
| `storage` | persistent key-value storage scoped to the plugin |
| `ipc` | invoke main-process handlers registered for this plugin (namespaced `plugin:<id>:<channel>`) |

No sanctioned `PluginContext` surface exposes credentials, app config,
sessions, or Node APIs. Undeclared capability access throws. See
[SECURITY.md](./SECURITY.md) for what is enforcement versus ergonomics — the
honest version matters. `ctx.hooks` needs no permission: hooks only broadcast
plugin-framework lifecycle events (never user or session data), see
"Extension-point inventory".

**Reserved vocabulary (do not reinvent when the need arrives):**
`contributes.settingsPages`, `contributes.statusItems` for future contribution
kinds; `contributes.locales` for plugin-supplied translation bundles (v1
plugin strings are English-only — a plugin cannot extend the app's i18n
registry, whose keys live in `packages/shared/src/i18n/locales/`); an
`events.read` permission for a read-only client mirror of the automations
`WorkspaceEventBus` (reuse that bus — never fork it); a manifest
`dependencies` field for inter-plugin ordering. These are deliberately
documented-but-unbuilt so v1 stays small while the names stay stable.

### Lifecycle

`discover → register → (enabled?) activate → deactivate/dispose`

- Discovery: built-in manifest list + `~/.craft-agent/plugins/*/plugin.json`.
- Registration: plugins targeting an unsupported `apiVersion` register as
  permanently errored with the reason (never activated or enabled).
- Enable/disable state: `~/.craft-agent/plugins.json` (app-level, same tier as
  `config.json`/`preferences.json`). Toggling is live: the renderer host
  activates/deactivates without an app restart (matching the app's "no
  restart" ethos). The `ui.webview` *window flag* is computed at window
  creation; enabling a webview plugin for the first time asks for a window
  reload.
- Activation: `activate(ctx)` returns an optional disposable; every
  registration made through `ctx` is tracked and auto-disposed on deactivate.
  A throwing plugin is marked `status: 'error'` and never takes the host down.
  Renderer-side: activation follows the manifest's activation events
  (explicit or inferred) — lazy on first panel open (`onPanel:`) or first
  command execution (`onCommand:`), eager at startup (`onStartup` or no
  declarative contributions). The renderer runtime is bootstrapped at app
  level (an AppShell effect), not by any dock — plugins activate even in
  layouts that mount no dock (e.g. compact mode).
- Failure visibility: renderer activation failures and panel render crashes
  are reported per window to the main host (`__plugins:reportRendererStatus`)
  and merged into the Settings status; contributed components render inside an
  error boundary with a retry affordance.

### Context object (`PluginContext`)

```ts
interface PluginContext {
  manifest: PluginManifest
  logger: PluginLogger                    // prefixed console logging
  storage: PluginStorage                  // scoped KV (requires 'storage')
  ui: { registerSidePanel(c): Disposable; openSidePanel(id); closeSidePanel(id) } // 'ui.sidePanel'
  commands: { register(id, handler): Disposable; execute(qualifiedId, args?): Promise<unknown> } // 'commands'
  hooks: { on(hook, listener): Disposable } // framework lifecycle hooks (no permission)
  invoke(channel, args): Promise<unknown> // 'ipc' → plugin:<id>:<channel> in main
  webviewPartition: string                // 'ui.webview' → persist:craft-plugin-<id>
}
```

## Extension-point inventory

1. **Side panels** (`ui.sidePanel`) — declared in `contributes.sidePanels`
   (introspectable, lazy) and/or registered imperatively via
   `ctx.ui.registerSidePanel({ id, title, icon, location, component })`.
   The panel store is a contribution-slot registry keyed by `location`
   (`'left' | 'right' | 'top' | 'bottom'`, default `'right'` — the Emacs
   side-window vocabulary); AppShell mounts one `PluginPanelDock` per
   vertical edge at its pre-existing layout anchors and wraps the content
   area in `PluginPanelArea`, which provides the top/bottom docks (VS Code's
   bottom-panel geometry: horizontal docks span the content area between the
   vertical docks). One dock component serves all four edges — only the size
   axis (width vs height), sash placement, and rail direction differ. A new
   UI location is a new member of `PLUGIN_PANEL_LOCATIONS` plus one dock
   mount — a data change, not a new architecture. Each dock owns its
   visibility, focus, size, resize sash, and toggle rail; state persists per
   window (sessionStorage) with a `localStorage` seed under central `KEYS`,
   so multiple windows never fight over dock state.
2. **Commands & keybindings** (`commands`) — declared in
   `contributes.commands` (introspectable, lazily activated via
   `onCommand:`) with handlers registered via `ctx.commands.register(id, fn)`
   and dispatched through one shared `PluginCommandRegistry` keyed by
   `{pluginId}.{commandId}`. Declared keybindings bind from manifest data
   alone, reuse the core action registry's hotkey matcher and context keys,
   and always yield to core shortcuts. Cross-plugin dispatch via
   `ctx.commands.execute(qualifiedId)`. This is the VS Code/Emacs/Vim command
   pattern; a future palette or menu contribution renders from the same
   registry.
3. **Host hooks** (no permission) — `ctx.hooks.on(name, fn)`, the Emacs
   `add-hook` pattern (and the shape of Vim autocommands). Fixed vocabulary of
   framework lifecycle events: `app:ready`, `plugin:activated`,
   `plugin:deactivated`, `panel:opened`, `panel:closed`, `command:executed`.
   Listeners observe (never veto), are error-isolated per Emacs `run-hooks`
   semantics, and are auto-disposed on deactivate. Agent/session events are
   deliberately excluded — those remain reserved for the `events.read`
   WorkspaceEventBus mirror.
4. **Hardened web embed** (`ui.webview`) — per-plugin session partition +
   `will-attach-webview` enforcement plus continuous navigation policing in
   main. This is a *framework* capability usable by any panel that embeds web
   content.
5. **Main-process capabilities** (`ipc`) — main-side plugin modules register
   handlers via `PluginMainContext.handle(channel, fn)`; renderer reaches them
   through `ctx.invoke`. Channels are namespaced and permission-gated
   (`__plugins:invoke` rejects undeclared/disabled plugins and untrusted
   senders).
6. **Scoped storage** (`storage`) — namespaced persistent KV per plugin.
7. **Registry & settings surface** — Settings → Plugins lists every discovered
   plugin (built-in and external) with permissions, declared contributions
   (panels, commands + keybindings), and an enable/disable switch; changes
   broadcast to all windows (`__plugins:changed`). External plugins are
   labelled manifest-only; incompatible plugins show their reason with the
   toggle disabled.

## How core stays decoupled

Core changes are additive and generic (core knows no specific plugin):

- `AppShell.tsx`: one runtime-bootstrap effect, one `PluginPanelDock` mount
  per vertical edge plus one `PluginPanelArea` wrapper around the content
  area at the pre-existing layout anchors, and the stack's edge/radius
  props fed from the exported `usePluginPanelDockVisible(...)` selector (no
  plugin logic inline in AppShell).
- `window-manager.ts`: `webviewTag` computed from "any enabled plugin declares
  `ui.webview`" instead of hardcoded `false`.
- `main/index.ts`: one `initializePluginHost()` + one `disposePluginHost()` call.
- `preload/bootstrap.ts`: `plugins.*` direct-IPC methods.
- Settings registry/menu/i18n: one `plugins` page entry.

Everything else is new files. With the registration maps empty
(`BUILTIN_PLUGIN_MANIFESTS`, `RENDERER_PLUGIN_ENTRIES`, `MAIN_PLUGIN_ENTRIES`),
the app is pixel-identical to vanilla; removing a bundled plugin's directory
plus its registration lines removes it completely.

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
