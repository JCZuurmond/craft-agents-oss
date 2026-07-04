# Plugin Security & Permissions

## The trust model, honestly

**v1 plugins are trusted, first-party code.** Plugin code ships in-tree,
bundled with the app, and reviewed like any other app code; external plugin
*code* is never loaded (only external manifests are listed — see below). The
permission system exists for **intent declaration, user-facing surfacing, and
developer ergonomics** — it is *not* a sandbox for the plugin's own renderer
code, and this document does not pretend otherwise. (This is the honest
posture Obsidian takes for its community plugins: the trust boundary is the
author, not a runtime cage.)

Concretely, a renderer plugin runs **in the same JavaScript context as core
and every other plugin**. Nothing stops in-process code from touching
`window.electronAPI`, the DOM, another plugin's `localStorage` namespace, or
core modules. The permission-gated `PluginContext` throws when a plugin uses a
surface it didn't declare — that is developer guidance that fails fast and
attributes misuse, not an enforcement boundary.

**The one hard security boundary is the `<webview>` guest page.** Web content
a plugin embeds runs in a separate, sandboxed renderer with no bridge back
into the app; the policy is enforced in the main process and cannot be relaxed
from the renderer. Everything in "Embedded web content" below is a real,
enforced guarantee. The rest of the model is defense in depth plus honesty
about where the line sits today.

### Goals for external-code loading (not yet enforced)

When external plugin code loading lands, the following must become *enforced*
guarantees before the first external plugin runs (tracked in
[DESIGN.md](./DESIGN.md) future work; candidate mechanisms: a separate
extension-host process à la VS Code, or an isolated realm à la Figma):

- no access to the credential store, app/workspace config, sessions, sources
- no Node.js, Electron APIs, or filesystem
- no IPC beyond the plugin's own namespaced channels
- no access to other plugins' storage or partitions

Until then, those bullets describe what sanctioned `PluginContext` surfaces
expose (nothing exposes the above), **not** what a hostile plugin could reach.

## Permission model

Permissions are a fixed, typed allowlist declared in the manifest and surfaced
to the user in Settings → Plugins. The host grants exactly what's declared;
undeclared access throws at the call site and shows up as a plugin error, not
a host failure.

| Permission | Grants | Enforcement |
|---|---|---|
| `ui.sidePanel` | panels in the left/right pane hosts | renderer-side gating (ergonomic) |
| `ui.webview` | a hardened `<webview>` on the plugin's own partition | **main process, on every attach and navigation** |
| `storage` | KV storage under the plugin's namespace | renderer-side gating (ergonomic) |
| `ipc` | calls to the plugin's own main-process handlers | **main process, on every invoke** |

`ui.webview` is a sub-capability of a panel (the `<webview>` renders inside a
pane the plugin contributes), not a standalone contribution — it sits in the
permission list because it changes the app's security posture (window-level
`webviewTag`) and therefore must be user-visible.

Two main-process checks are real boundaries even for first-party code:

- `__plugins:invoke` re-validates enablement + the `ipc` permission on every
  call, and every `__plugins:*` channel rejects senders that are not app
  window renderers (a plugin `<webview>` guest can never reach this surface —
  guests are sandboxed with no preload, and the sender type is checked as
  defense in depth).
- Known limitation (by design of a shared renderer context): the main process
  cannot distinguish *which* in-process caller invokes
  `plugins.invoke(pluginId, …)`, so plugin A calling plugin B's channels is
  not detectable server-side. That becomes enforceable only with
  out-of-process plugin isolation; until then it is part of the first-party
  trust assumption above.

## Embedded web content (`ui.webview`)

Remote web pages are the riskiest surface. Policy, enforced in the main
process:

1. **`webviewTag` is off by default.** App windows only get
   `webviewTag: true` when an *enabled* plugin declares `ui.webview`
   (computed at window creation; toggling prompts a relaunch).
2. **Every attach is intercepted** (`will-attach-webview`, app-wide):
   - the requested session partition must be `persist:craft-plugin-<id>` for
     an enabled plugin that declares `ui.webview` — anything else is blocked;
   - `preload` is stripped; `nodeIntegration` (incl. subframes) is forced off;
     `contextIsolation`, `sandbox`, and `webSecurity` are forced on;
   - only `http(s)`/`about:blank` initial URLs may load.
3. **Navigation is policed continuously, not just at attach:**
   - `will-navigate`, `will-frame-navigate`, and `will-redirect` on the guest
     are blocked unless the target is `http(s)`/`about:blank` — an allowed
     page cannot wander to `file:`, `data:`, `javascript:`, or a privileged
     app scheme;
   - embedder-initiated loads (`<webview>.src` / `loadURL`) bypass
     `will-navigate` by Electron design, so `did-start-navigation` reactively
     aborts any disallowed load and bounces the main frame to `about:blank`.
     This last layer is reactive rather than preventive; the sandbox +
     `webSecurity` + partition allowlist bound what a briefly-started load
     could reach.
4. **Per-plugin session partition** — cookies/storage are isolated from the
   app, from the agent's browser windows (`persist:browser-pane`), and from
   other plugins.
5. **Deny-by-default web permissions** — camera, microphone, geolocation,
   notifications, etc. are all refused on plugin partitions.
6. **No popups** — `window.open`/`target=_blank` never creates a window;
   `http(s)` URLs are handed to the OS browser, everything else is dropped.

The guest page therefore runs as a sandboxed, isolated renderer with no bridge
back into the app: the plugin's React code can drive navigation, but the page
itself cannot reach the plugin, the app, or Node.

## Renderer-side gating

`createPluginContext` (renderer) enforces the declared permissions
ergonomically: undeclared surfaces throw descriptive errors (`Plugin 'x' tried
to use 'registerSidePanel' without declaring the 'ui.sidePanel' permission`).
As stated above, this is developer guidance for trusted code — the
authoritative checks are the main-process ones.

## Error isolation

- A plugin that throws during **activation** is marked `status: 'error'` with
  the message shown in Settings; other plugins and the host are unaffected.
  Renderer-side activation failures are reported per window to the main host
  (`__plugins:reportRendererStatus`) so Settings reflects them too.
- A contributed panel that throws during **render** is caught by an error
  boundary in the pane host: the panel is quarantined with a retry affordance
  and the crash is attributed to the plugin in Settings. It cannot take down
  the shell.
- Disposal failures during deactivation are swallowed (logged) so one bad
  disposable cannot leak the rest.
- Plugins targeting an unsupported `apiVersion` are refused at registration
  with the reason shown in Settings (never activated, never enabled).

## External plugins

External plugins under `~/.craft-agent/plugins/` are **manifest-only** in this
version: they are discovered, validated, and listed in Settings, but no
external *code* is loaded, and Settings marks them accordingly instead of
offering a toggle that would silently do nothing. They are disabled by default
(`defaultEnabled` is honored only for built-ins). Directory name must match
manifest id, preventing a plugin from impersonating another id. External code
loading is future work with the enforcement bar described at the top of this
document.
