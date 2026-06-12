# Plugin Security & Permissions

Plugins are treated as **untrusted-ish** code: they run inside the app but get
no ambient authority. Everything flows through the permission-gated
`PluginContext`; the security-relevant enforcement lives in the **main
process** (`apps/electron/src/main/plugin-host.ts`), so a misbehaving renderer
cannot bypass it.

## What plugins can never do

Regardless of declared permissions, plugins have **no** access to:

- the credential store (`credentials.enc`) or any decrypted credential
- app/workspace config, sessions, or sources (no sanctioned service exposes them yet)
- Node.js, Electron APIs, or the filesystem
- arbitrary IPC — only `plugin:<own-id>:<channel>` handlers the plugin itself
  registered, and only while enabled
- other plugins' storage namespaces or session partitions

This follows the existing posture for local MCP subprocesses (filtered env,
no ambient secrets).

## Permission model

Permissions are a fixed, typed allowlist declared in the manifest and surfaced
to the user in Settings → Plugins. The host grants exactly what's declared;
undeclared access throws at the call site and shows up as a plugin error, not
a host failure.

| Permission | Grants | Does NOT grant |
|---|---|---|
| `ui.sidePanel` | a pane slot in the right-hand pane host | access to other panes, panels, or layout state |
| `ui.webview` | a hardened `<webview>` on the plugin's own partition | Node integration, preloads, other partitions, browser permissions |
| `storage` | KV storage under the plugin's namespace | other plugins' keys, app localStorage, disk paths |
| `ipc` | calls to the plugin's own main-process handlers | any core IPC channel or other plugins' channels |

## Embedded web content (`ui.webview`)

The Browser Pane plugin renders remote web pages, which is the riskiest
surface. Policy, enforced in the main process:

1. **`webviewTag` is off by default.** App windows only get
   `webviewTag: true` when an *enabled* plugin declares `ui.webview`
   (computed at window creation; toggling prompts a relaunch).
2. **Every attach is intercepted** (`will-attach-webview`, app-wide):
   - the requested session partition must be `persist:craft-plugin-<id>` for
     an enabled plugin that declares `ui.webview` — anything else is blocked;
   - `preload` is stripped; `nodeIntegration` (incl. subframes) is forced off;
     `contextIsolation`, `sandbox`, and `webSecurity` are forced on;
   - only `http(s)`/`about:blank` initial URLs may load.
3. **Per-plugin session partition** — cookies/storage are isolated from the
   app, from the agent's browser windows (`persist:browser-pane`), and from
   other plugins.
4. **Deny-by-default web permissions** — camera, microphone, geolocation,
   notifications, etc. are all refused on plugin partitions.
5. **No popups** — `window.open`/`target=_blank` never creates a window;
   `http(s)` URLs are handed to the OS browser, everything else is dropped.

The guest page therefore runs as a sandboxed, isolated renderer with no bridge
back into the app: the plugin's React code can drive navigation, but the page
itself cannot reach the plugin, the app, or Node.

## Renderer-side gating

`createPluginContext` (renderer) enforces the same permissions ergonomically:
undeclared surfaces throw descriptive errors (`Plugin 'x' tried to use
'registerSidePanel' without declaring the 'ui.sidePanel' permission`). This is
developer guidance — the authoritative checks are the main-process ones above
(`__plugins:invoke` re-validates enablement + `ipc` permission on every call).

## Error isolation

- A plugin that throws during activation is marked `status: 'error'` with the
  message shown in Settings; other plugins and the host are unaffected.
- Disposal failures during deactivation are swallowed (logged) so one bad
  disposable cannot leak the rest.

## External plugins

External plugins under `~/.craft-agent/plugins/` are **disabled by default**
(`defaultEnabled` is honored only for built-ins) and must be enabled
explicitly in Settings. Directory name must match manifest id, preventing a
plugin from impersonating another id. External *code* loading is not yet
enabled — see "Future work" in [DESIGN.md](./DESIGN.md).
