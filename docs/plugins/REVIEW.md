# Architectural Review — Plugin/Extensibility Framework

This file is the combined review record for
[`JCZuurmond/craft-agents-oss#1`](https://github.com/JCZuurmond/craft-agents-oss/pull/1).
It folds together:

1. the original architectural red-team review from PR #3 / early PR #1;
2. the supplemental review from PR #4;
3. the final adversarial review after PR #1 absorbed PR #6.

Current reviewed code head: `2dd529dc` (`claude/serene-meitner-4ksi6h`), based
on upstream `v0.10.5` (`c9d9a26`). This combined review document was folded into
PR #1 at `7150d15c`. The Browser Pane reference plugin remains the stacked PR #2.

---

## Final verdict on the combined PR

**No blocker found in the combined framework PR.**

The original review's core concern was that the framework had solid plugin
plumbing but browser-pane-shaped contribution points. The follow-up work now
addresses the high-leverage gaps without exploding the surface area:

- declarative `contributes.sidePanels` and `contributes.commands`;
- left/right panel locations;
- lazy activation events (`onStartup`, `onPanel:*`, `onCommand:*`);
- plugin API version compatibility checks;
- host lifecycle hooks;
- renderer error reporting back to Settings;
- panel render error boundaries;
- continuous `<webview>` navigation enforcement;
- browser-safe shared exports split from Node-only discovery/persistence.

The remaining limitations are acceptable for a first-party v1 as long as the
trust model stays honest: renderer plugin code is trusted, in-process app code,
not sandboxed third-party code.

---

## Current architecture assessment

### Security / trust model

`docs/plugins/SECURITY.md` now correctly states the v1 boundary:

- plugin renderer code is trusted, first-party, bundled code running in the same
  JavaScript context as the app and other renderer plugins;
- renderer-side permission gates are intent/developer ergonomics, not a sandbox;
- the hard boundary is the embedded `<webview>` guest page.

The webview path is main-process enforced in `apps/electron/src/main/plugin-host.ts`:

- `webviewTag` is only enabled when an enabled plugin declares `ui.webview`;
- attach requires the plugin-owned `persist:craft-plugin-<id>` partition;
- preload is stripped and Node/subframe Node are disabled;
- `contextIsolation`, `sandbox`, and `webSecurity` are forced on;
- permissions are denied by default;
- popups are denied and safe links are opened externally;
- main-frame navigation is continuously restricted to `http(s)` / `about:blank`,
  with subframes limited to ordinary web embed schemes.

Residual risk: in a shared renderer context, the main process cannot prove which
plugin initiated `window.electronAPI.plugins.invoke(pluginId, ...)`. Do not load
untrusted external plugin code until there is an isolated extension host or
similar realm boundary.

### Generality of contribution points

The combined PR is no longer a browser pane in framework clothing. The
framework now has generic primitives that match established editor extension
systems:

- **declarative contributions** like VS Code/Eclipse;
- **commands** as the universal user-invocable primitive;
- **activation events** for lazy loading;
- **left/right view slots** for shell UI composition;
- **hooks** for framework lifecycle observation;
- **API version gates** for upgrade safety.

Still intentionally out of scope for this PR: settings-page contributions,
status-bar/toolbar items, source-type extensions, plugin dependencies, and
agent/tool event mirrors. Those should be added as new declarative contribution
families only when a real plugin needs them. For future agent/tool hooks, reuse a
read-only mirror of the existing `WorkspaceEventBus` shape rather than creating a
parallel event bus.

### Runtime and failure isolation

The supplemental PR #4 review found that renderer activation was coupled to the
right-pane host and renderer failures were invisible to Settings. Both are fixed:

- `AppShell` initializes the plugin runtime at app level;
- `PluginPaneHost` only renders panel contributions;
- renderer activation/render failures are reported via
  `__plugins:reportRendererStatus`;
- Settings merges main-process and renderer-side plugin status;
- contributed panel components are wrapped in an error boundary and quarantined
  on crash.

A plugin can still jank its own renderer window with CPU-heavy trusted code. That
is inherent to the first-party in-process v1 model.

### Upgrade footprint

The core footprint remains additive and concentrated at existing seams:

- app bootstrap (`initializePluginHost` / `disposePluginHost`);
- window `webPreferences.webviewTag`;
- preload direct IPC surface;
- AppShell's existing left/right layout seams;
- settings/menu/icon/i18n registries;
- shared package subpath exports.

With no built-in plugin manifests registered, the pane hosts render nothing and
`webviewTag` stays false. The framework is therefore easy to remove or keep
rebasing over upstream releases.

---

## Historical finding roll-up

| Finding | Source | Status in combined PR |
|---|---|---|
| B1: `SECURITY.md` overstated isolation | original review | **Resolved** — docs now use the honest first-party/in-process trust model. |
| M1: one hardcoded right-pane UI slot | original review | **Resolved for v1** — side panels declare `location: 'left' \| 'right'`; future slots can follow the same contribution pattern. |
| M2: imperative-only contributions / no lazy activation | original review | **Resolved** — manifest `contributes` plus activation events. |
| M3: no plugin API version gate | original review | **Resolved** — `apiVersion`, host constants, compatibility errors surfaced in Settings. |
| M4: future agent/tool hooks must reuse existing event bus | original review | **Still a future-work constraint** — no agent hooks added in this PR. |
| M5: AppShell duplicated pane visibility logic | original review | **Resolved** — AppShell consumes `usePluginPaneVisible`. |
| M6: external manifests looked toggleable but code did not load | original review | **Resolved** — external plugins are shown as manifest-only and cannot be silently enabled. |
| M7: default shared plugin export leaked Node imports | original review | **Resolved** — browser-safe default plugin exports; Node-only exports live under `@craft-agent/shared/plugins/node`. |
| M8: multi-window pane state clobbered shared localStorage | original review | **Resolved** — per-window `sessionStorage` with `localStorage` as seed. |
| M9: design docs referenced stale registration layout | original review | **Resolved** — docs describe the split manifest/main/renderer maps. |
| S-M1: renderer runtime bootstrapped by pane host | PR #4 | **Resolved** — runtime initializes at app level. |
| S-M2: renderer activation/render failures invisible to Settings | PR #4 | **Resolved** — renderer status IPC + panel error boundary. |
| S-M3: webview URL policy attach-time only | PR #4 | **Resolved** — navigation/redirect/frame guards added after attach. |
| S-M4: framework docs referenced a browser plugin not present in #1 | PR #4 | **Resolved** — framework docs use a self-contained hello-pane example and refer to Browser Pane as stacked PR #2. |

---

## Current residual risks / follow-ups

1. **External plugin code loading requires real isolation.** Before loading
   third-party code, add a separate extension host process or equivalent
   isolated realm. The current renderer `PluginContext` is not an enforcement
   boundary for hostile code.
2. **Cross-plugin caller attribution is not enforceable in-process.** Main can
   verify the target plugin is enabled and declares `ipc`, but cannot prove which
   renderer plugin called the bridge without isolation.
3. **`webviewTag` is a BrowserWindow creation-time flag.** The relaunch prompt is
   the right v1 behavior when enabling/disabling `ui.webview` plugins.
4. **Add new contribution families conservatively.** Settings pages, status
   items, source types, dependencies, and agent/tool hooks should stay absent
   until demanded by concrete plugins.

---

## Validation at final review

- `npx --yes bun@latest test packages/shared/src/plugins apps/electron/src/renderer/plugins/__tests__` — 86 passed.
- `npx --yes bun@latest run typecheck:shared` — passed.
- `npx --yes bun@latest run typecheck:electron` — passed.

Stacked reference plugin #2 was also updated and verified separately:

- `npx --yes bun@latest test packages/shared/src/plugins apps/electron/src/renderer/plugins/__tests__ apps/electron/src/plugins/web-browser/__tests__/web-browser-plugin.test.ts` — 99 passed.
