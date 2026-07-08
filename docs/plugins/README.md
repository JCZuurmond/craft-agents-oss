# Craft Agents Plugins

Plugins add features to Craft Agents **without modifying core** (issue #256).
A plugin declares what it needs (permissions) and what it offers (declarative
contributions) in a manifest, gets a typed, permission-gated context at
activation, and contributes UI (side panels on any shell edge) and
main-process capabilities through stable extension points. Plugins ship
either **in-tree** (compiled with the app) or **external** — a folder dropped
into `~/.craft-agent/plugins/` and loaded from disk, no rebuild needed.

| Doc | What's in it |
|---|---|
| [DESIGN.md](./DESIGN.md) | Codebase findings, design decisions, extension-point inventory, how core stays decoupled |
| [INSTALL.md](./INSTALL.md) | Install/author an **external** plugin (drop-in folder, no build step), the `plugin` CLI, and the trust model |
| [AUTHORING.md](./AUTHORING.md) | Manifest reference + the full plugin API |
| [SECURITY.md](./SECURITY.md) | The honest trust model, permission semantics, and the webview policy |
| [QUICKSTART.md](./QUICKSTART.md) | Build your own plugin in 5 minutes (self-contained "Hello Pane" walkthrough) |

## At a glance

- **Built-in plugins** ship in-tree under `apps/electron/src/plugins/<id>/`
  and register in one data file each for manifest and entries.
- **Declarative contributions** (`contributes.sidePanels`,
  `contributes.commands`) make panels, commands, and keybindings
  introspectable in Settings and activation lazy — plugin code runs on first
  panel open or first command execution, not at startup (`activationEvents`
  makes the policy explicit, VS Code-style).
- **Editor-proven patterns**: VS Code-style commands and activation events,
  Vim-style keybindings that always yield to core shortcuts, and Emacs-style
  host hooks (`ctx.hooks.on`) for observing framework lifecycle events.
- **Versioned contract**: manifests pin the `apiVersion` they target; the
  host refuses incompatible plugins with a visible reason instead of breaking
  them silently on upgrade.
- **External plugins** live at `~/.craft-agent/plugins/<id>/` with a
  `plugin.json` and their entry files; the host discovers, validates, and
  **loads their code** at runtime (renderer entry via `entries.renderer`,
  main entry via `entries.main`). No rebuild — restart to discover a new
  folder. See [INSTALL.md](./INSTALL.md). Directories whose manifest fails to
  validate are listed in Settings with the reason instead of vanishing.
- **Trust:** external code runs in-process with the app's access, so enabling
  an external plugin asks for consent (surfacing its permissions). The
  framework validates; the installer decides — the editor/Obsidian model
  (see [SECURITY.md](./SECURITY.md)).
- **Enable/disable** lives in `~/.craft-agent/plugins.json` and in
  **Settings → Plugins**; toggling is live across windows.

## Where things live

```
packages/shared/src/plugins/        # manifest types, zod validation, registry (browser-safe)
packages/shared/src/plugins/node.ts      # discovery + enablement persistence (Node-only subpath)
apps/electron/src/main/plugin-host.ts    # authoritative registry, IPC, webview policy
apps/electron/src/renderer/plugins/      # PluginContext, runtime, panel dock UI
apps/electron/src/plugins/               # built-in plugins + registration lists
~/.craft-agent/plugins/<id>/plugin.json  # external plugin manifests
~/.craft-agent/plugins.json              # enablement state
```
