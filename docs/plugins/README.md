# Craft Agents Plugins

Plugins add features to Craft Agents **without modifying core** (issue #256).
A plugin declares what it needs in a manifest, gets a typed, permission-gated
context at activation, and contributes UI (today: right-hand side panes) and
main-process capabilities through stable extension points.

| Doc | What's in it |
|---|---|
| [DESIGN.md](./DESIGN.md) | Codebase findings, design decisions, extension-point inventory, how core stays decoupled |
| [AUTHORING.md](./AUTHORING.md) | Manifest reference + the full plugin API |
| [SECURITY.md](./SECURITY.md) | Permission model and the webview sandboxing policy |
| [QUICKSTART.md](./QUICKSTART.md) | Build your own plugin in 5 minutes (the Browser Pane plugin as the worked example) |

## At a glance

- **Built-in plugins** ship in-tree under `apps/electron/src/plugins/<id>/`
  and register in one data file each for manifest and entries.
- **External plugins** are discovered from `~/.craft-agent/plugins/<id>/plugin.json`
  (manifest-level today; external *code* loading is future work — see DESIGN.md).
- **Enable/disable** lives in `~/.craft-agent/plugins.json` and in
  **Settings → Plugins**; toggling is live across windows.
- **Reference plugin:** `web-browser` — a sandboxed browser in a right-hand
  side pane, built entirely on the public plugin API.

## Where things live

```
packages/shared/src/plugins/        # manifest types, zod validation, storage, registry
apps/electron/src/main/plugin-host.ts    # authoritative registry, IPC, webview policy
apps/electron/src/renderer/plugins/      # PluginContext, runtime, pane host UI
apps/electron/src/plugins/               # built-in plugins + registration lists
~/.craft-agent/plugins/<id>/plugin.json  # external plugin manifests
~/.craft-agent/plugins.json              # enablement state
```
