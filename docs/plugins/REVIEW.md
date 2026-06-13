# Architectural Review — Plugin/Extensibility Framework (PR #1, issue #256)

Red-team review of the framework added in
[`JCZuurmond/craft-agents-oss#1`](https://github.com/JCZuurmond/craft-agents-oss/pull/1)
(framework only; the `web-browser` reference plugin is the stacked PR #2).
Original review was written at head `12f42e0`; this extended pass rechecked
PR #1 at head `e2f6e07` (after PR #3 was merged into the stack), base
`a512da7`.

---

## TL;DR verdict

**Q1 — Does it generalize, or is it a browser pane wearing a framework costume?**
**Partly a costume, but the bones are real.** The *lifecycle/registry/permission/
storage/IPC* machinery (`packages/shared/src/plugins/` + the two hosts) is a
genuine, reusable plugin platform — textbook Fowler Plugin + Separated Interface,
clean error isolation, host-agnostic registry. But the **contribution surface is
narrow and shaped around the browser pane**: there is exactly **one** UI
extension point (`ui.sidePanel` → a single hardcoded **right**-edge slot) and a
`ui.webview` permission whose entire reason to exist is embedding a web browser.
Eight of the ten Part C stress cases are inexpressible without core edits. So the
framework generalized the *plumbing* well and the *contribution points* barely at
all. It is a real plugin host with a browser-pane-shaped API — not a fake, but
not yet a platform. The supplemental pass strengthens that conclusion: the
renderer runtime is currently bootstrapped by the right-pane host itself, so a
future renderer-only command/settings/status plugin would still be coupled to the
presence of the pane seam (S-M1).

**Q2 — Minimal footprint / upgrade-safe?**
**Yes, strongly — this is the PR's best quality.** Excluding this review doc,
the framework/docset adds 23 new files and modifies 18 existing files; the
pre-existing-file footprint is **132 added / 2 deleted** lines. Both deletions
are one-expression swaps at *pre-existing* seams (`webviewTag: false` →
computed; `isRightSidebarVisible={false}` → computed). With the registration
maps empty the app is provably pixel-identical to vanilla. The revert test passes
cleanly. The only real conflict risk is concentrated in two hot files
(`AppShell.tsx`, `shared/types.ts`), and one of those touches is avoidable (see
M5).

Net: **merge-able as a v1 foundation**, but the docs over-promise on isolation
(see Blocker B1), some shipped docs point at a browser plugin that is not in this
PR (S-M4), and the contribution/runtime model needs a generalization pass before
a *second* kind of plugin lands (M1–M3, S-M1). Fix B1/S-M4's documentation now;
schedule M1–M3/S-M1 before the platform is opened to third parties.

---

## Findings by severity

### Blocker

**B1 — `SECURITY.md` materially overstates plugin isolation; renderer plugins
have full ambient authority.**
`docs/plugins/SECURITY.md:9-21` claims plugins get "no access to … arbitrary IPC
… other plugins' storage namespaces," and that enforcement "lives in the main
process so a misbehaving renderer cannot bypass it." That is true only for the
**embedded web page** inside a `<webview>` (which *is* well sandboxed — credit
below). It is **not** true for a plugin's own renderer code. Every renderer
plugin runs in the **same JS context as core and every other plugin**
(`runtime.ts` activates them into `window`). Therefore a plugin's `activate()`
body can:

- call `window.electronAPI.*` directly — the **entire** app IPC surface (WS-RPC:
  sources, sessions, credentials operations, workspaces…), not just its own
  `ctx.invoke`;
- call `window.electronAPI.plugins.invoke('<other-plugin-id>', channel, args)` —
  `plugin-host.ts:214` only checks the *target* plugin is enabled and declares
  `ipc`, never that the **caller** owns that id. So plugin A can drive plugin B's
  main-process handlers. This directly contradicts `SECURITY.md:35` ("calls to
  the plugin's *own* … handlers").
- read another plugin's storage (`localStorage['craft-plugin-<other>:…']` is
  right there — `context.ts:33`);
- touch the DOM, import core modules, etc.

The `deniedSurface` proxy in `context.ts:56` is **advisory developer
ergonomics**, not a sandbox — it only fires if the plugin politely goes through
its own `ctx`.

This is inherent to in-process renderer plugins (the Emacs end of the spectrum)
and is *acceptable for v1* because plugin **code** is first-party, bundled
in-tree, and external code loading is explicitly deferred. The Blocker is the
**documentation**, not the architecture: shipping a `SECURITY.md` that promises
capability isolation the runtime does not enforce will mislead the first external
plugin author and anyone doing a security assessment.

*Fix (pick one, both cheap):*
1. **Rewrite `SECURITY.md` to tell the truth**: "v1 plugins are trusted,
   first-party, in-process code; the permission system is *intent declaration +
   UI surfacing + guidance*, not a sandbox. The only hard security boundary is
   the `<webview>` guest page." Move all the "plugins can never…" guarantees
   under a clearly-labelled *"Goal for external-code loading (not yet
   enforced)"* heading. (Borrowed framing: **Obsidian**, which is honest that
   community plugins run with full access and the trust boundary is "do you trust
   the author," not a sandbox.)
2. Close the cross-plugin `invoke` hole now (it's a real bug regardless of
   trust): have the preload tag invoke calls with the calling context, or drop
   the `pluginId` argument from `plugins.invoke` and derive it — though in a
   shared context this is only partial. Prefer #1's honesty plus a roadmap to a
   real boundary (VS Code extension-host process / Figma iframe+QuickJS) for when
   external code loads.

Either way the headline claim must match the runtime before merge.

### Major

**M1 — The UI contribution model is a single hardcoded right-pane slot; new UI
locations are impossible without core edits.**
`PluginUi` (`renderer/plugins/types.ts:45`) exposes only `registerSidePanel`, and
`PluginPaneHost` (`PluginPaneHost.tsx`) hardcodes one right-edge slot, one toggle
rail, one visible panel. Part C cases #1 (left pane), #3 (command palette), #4
(status-bar/toolbar widget), #5 (settings page), #8 (modal/theme) are all
**inexpressible** today. The *seam location* is right (the pre-existing AppShell
right-sidebar slot), but the *abstraction* is "one host owns one slot."

*Fix (minimal, highest leverage):* introduce one generic **contribution-slot
registry** keyed by slot id, and have core mount a tiny `SlotHost` at each stable
layout anchor it already owns. A plugin contributes to a slot by id; new
locations become new slot ids, not new core edits. Concretely, the cheapest first
step that unlocks #1 and #2 at near-zero added surface: give
`registerSidePanel({ location: 'left' | 'right' })` (default `'right'`) and make
`PluginPaneHost` mountable on either edge — AppShell already plumbs left/right
edges. This is the trimmed **VS Code `viewsContainers` + `contributes.views`**
model, which fits because this app is also a multi-pane shell. Do *not* build all
five slots now — build the *registry indirection* so adding the next slot is a
data change, not an architecture change (Open–Closed across the UI dimension, not
just within "right pane").

**M2 — Contributions are imperative (run code to discover them); no declarative
manifest contributions, hence no lazy activation.**
Panels are registered only by *executing* `activate(ctx)`
(`runtime.ts:60` runs `activateEnabled()` for every enabled plugin on first
AppShell mount; `plugin-host.ts:173` does likewise in main, *before first window*,
on the critical path to first paint). Consequences: (a) Settings can't show "this
plugin contributes a Browser pane / a command / a settings page" without
activating it; (b) there is **no lazy activation** — the opposite of VS Code's
`activationEvents`. Fine for a handful of bundled plugins; it does not scale and
blocks any future code-loading story.

*Fix:* move *static* contribution metadata (panels, commands, settings pages,
slot ids) into the **manifest** as a declarative `contributes` block; keep
`activate()` for wiring *behavior* only. Then the host can list/lazy-activate from
data. Borrowed directly from **VS Code `contributes` + activation events** and
**Eclipse `plugin.xml` extension points** — both deliberately separate "what a
plugin offers" (static, introspectable) from "what it does" (code). This also
makes M1's slot registry declarative for free.

**M3 — No framework API version; the plugin↔host contract is unversioned.**
The manifest carries the *plugin's* `version` (`validation.ts:29`) but nothing
pins the *framework API version* it targets. When `PluginContext` evolves,
external plugins break silently with no compatibility gate. VS Code solved this
with `engines.vscode: "^1.x"` and the *proposed API* channel so the stable
surface can grow without breaking consumers.

*Fix:* add a host-advertised `PLUGIN_API_VERSION` constant and a manifest
`engines.craftAgent` (or `apiVersion`) field; reject/disable-with-reason at
`register()` when the host can't satisfy the range. Adopt a "proposed
permissions/contributions" tier for unstable surface. Borrowed from **VS Code**;
it is the single cheapest insurance against the costliest future failure
(community-plugin breakage on upgrade), and directly serves issue #256's
upgrade-safety thesis — applied to the *plugin* contract, not just core.

**M4 — Agent/tool hooks (Part C #7) have no seam, and the eventual design must
reuse the existing event bus, not fork it.**
There is no way for a plugin to observe `PreToolUse`/`PostToolUse`/`SessionStart`.
`DESIGN.md:204` correctly defers this, noting the typed `WorkspaceEventBus`
(`packages/shared/src/automations/event-bus.ts`) lives server-side. Deferring is
the right call (client transport needs design). The finding is **forward-looking
and load-bearing**: when this lands it must expose a *read-only client mirror* of
the existing `WorkspaceEventBus`/`AgentEvent` types, **not** a second event
system. Flagging now so the manifest/permission vocabulary (`events.read`?)
is reserved and the deferral doesn't calcify into a parallel bus later.

### Supplemental findings from the current head (`e2f6e07`)

#### Major (supplemental)

**S-M1 — Renderer runtime bootstrap is owned by the right-pane host, so the
"plugin runtime" is still coupled to the browser-pane seam.**
`PluginPaneHost.tsx:36-38` calls `initializePluginRuntime()`, and the only core
mount for that host is `AppShell.tsx:3348`, guarded by `!isAutoCompact`. That
means renderer plugin activation is a side effect of mounting the **right-hand
pane UI**, not an app-level plugin runtime. Today that mostly works because the
only intended renderer contribution is a right pane. But it fails the Part C
stress tests the moment a plugin contributes a command, settings page, status
item, modal, or background renderer listener: those plugins should activate even
when no pane host exists and even in compact mode.

This is the strongest concrete evidence that the framework's renderer half is
still browser-pane-shaped, despite the generic registry underneath. **VS Code**
keeps extension activation in the extension host and treats views as one
contribution among many; **Obsidian** loads a plugin via lifecycle first, then
lets it register views/commands/settings. We should follow that split.

*Fix:* move `initializePluginRuntime()` to an app-level `PluginRuntimeProvider`
or an unconditional `AppShell` effect. Leave `PluginPaneHost` responsible only
for rendering `ui.sidePanel` contributions. This is a tiny seam move (one import
+ one effect) with high generality payoff.

**S-M2 — Renderer activation and render failures are not reported to the
authoritative Settings registry.**
Settings reads `window.electronAPI.plugins.list()` (`PluginsSettingsPage.tsx:35-43`),
which is backed by the **main-process** registry (`plugin-host.ts:186-189`). A
renderer-only plugin with a broken `activate(ctx)` fails inside the renderer's
separate registry (`runtime.ts:50-60`) but never reports that status back to
main. The user still sees the plugin as enabled/active unless the main-side
activation failed. The docs promise that a throwing plugin is shown as
`status: 'error'` in Settings, and `PluginsSettingsPage.tsx:94-95` has UI for
that state, but renderer failures cannot currently reach it. Render-time errors
are worse: `PluginPaneHost.tsx:97-98` mounts the contributed component without an
error boundary, so a throwing panel can take down the shell and still not update
plugin status.

*Fix:* either narrow the docs/type names to say `PluginInfo.status` is
**main-host status only**, or add a small renderer-status IPC
(`__plugins:reportRendererStatus`) that each window emits after activation
failures and an error boundary around contributed components. For Settings,
aggregate status as "error if any window reports renderer error" and show the
window/error details.
This borrows the failure-attribution lesson from **IntelliJ** (`PluginException`
attributes errors to plugins) without needing VS Code-style process isolation.

**S-M3 — The webview URL allowlist is attach-time only; post-attach navigation is
not restricted.**
`will-attach-webview` validates the initial `params.src` (`plugin-host.ts:240-252`)
and hardens preferences (`plugin-host.ts:254-262`), but after `did-attach-webview`
the only policy installed is popup containment (`plugin-host.ts:265-278`). There
is no `will-navigate`/`will-frame-navigate`/redirect guard on the guest
`webContents`. A plugin or compromised guest page should not be able to wander
from an allowed `https:` page to `file:`, `data:`, `javascript:`, `devtools:`,
custom app protocols, or any future privileged scheme merely because the initial
attach was allowed. The existing sandbox makes many escalations harder, but
browser-extension/Figma-style capability models enforce **navigation and origin
policy continuously**, not just at creation.

*Fix:* in `did-attach-webview`, install navigation guards on the guest
`webContents` using the same `isAllowedWebviewUrl()` predicate (probably
`http:`, `https:`, and `about:blank` only), log and `preventDefault()` everything
else, and cover redirects/subframe navigation where Electron exposes separate
events. Keep `setWindowOpenHandler` as the popup path. Until this lands, the
"Figma-grade" language in the security review should be downgraded to
"strong attach-time hardening."

**S-M4 — PR #1's framework docs refer to a browser plugin that is not present in
PR #1, making the docs non-reproducible on the base review target.**
This branch is explicitly framework-only, with the `web-browser` plugin in the
stacked PR #2. But `QUICKSTART.md:3-5`, `QUICKSTART.md:16`,
`QUICKSTART.md:35`, `QUICKSTART.md:86`, `QUICKSTART.md:108`,
`QUICKSTART.md:115`, `AUTHORING.md:143`, `README.md:23-24`,
`SECURITY.md:39`, and `main-entries.ts:7` all talk as if
`apps/electron/src/plugins/web-browser/` already ships in PR #1. A reviewer or
plugin author following those links on PR #1 lands on missing files; the example
registration even references `WEB_BROWSER_PLUGIN_MANIFEST`/`activateWebBrowser`
that do not exist until PR #2. This is not an architecture flaw, but it is a
serious upgrade-stack/docs flaw: the lower PR should not document files only
available in an upper PR.

*Fix:* either (a) make PR #1 docs self-contained with a minimal `hello-pane`
example and move browser-pane-specific examples to PR #2, or (b) explicitly mark
every browser-pane reference as "available in stacked PR #2" with no file links
that are broken on PR #1. Prefer (a); it keeps the framework docs neutral and
reduces the browser-pane costume smell.

### Minor

**M5 — Avoidable logic-scatter in the most conflict-prone core file (DRY
violation).**
`AppShell.tsx:565-567` *re-implements* the pane-visibility predicate inline
(`pluginPane.isOpen && pluginPane.panels.some(p => p.key === activePanelKey)`),
while `panel-store.ts:141` already exports `isPluginPaneVisible()` doing exactly
this. Core should consume the exported selector, not duplicate it. `AppShell.tsx`
is a 3000-line, frequently-touched file and the single highest upgrade-conflict
risk in the PR (see Part D) — every line of *logic* (vs. a one-line mount) added
there is a future merge hazard. Collapse the three lines to one hook call.

**M6 — External plugins are listable and toggleable but are silent no-ops.**
`loadExternalPlugins()` discovers `~/.craft-agent/plugins/*/plugin.json` and
Settings renders a working enable toggle for them, but no external *code* is
loaded (renderer/main entry maps are first-party only). A user can enable an
external plugin and **nothing happens, with no error** — a broken affordance.
Either hide external manifests until code-loading lands, or render them disabled
with a "manifest only — not loadable in this version" badge. (`DESIGN.md`
documents the limitation; the *UI* doesn't.)

**M7 — Package boundary leaks its Node-ness into every renderer import site.**
`@craft-agent/shared/plugins` (index) re-exports Node-only `storage.ts`
(`fs`/`os`), so renderer code must import the `…/plugins/types` and
`…/plugins/registry` subpaths to avoid bundling `fs` — and both `context.ts:8`
and `runtime.ts:11` carry warning comments about it. That's an information-hiding
smell (Parnas): the module's build-environment constraints leak to consumers.
Consider a `…/plugins/node` subpath for fs-touching code so the default import is
browser-safe, removing the footgun and the comments.

**M8 — Multi-window pane state can fight over shared `localStorage`.**
`panel-store.ts` persists `pluginPaneActivePanel`/`pluginPaneOpen` to
`localStorage`, which is shared across windows, while each window has its own
module-singleton store. Two windows will clobber each other's active-panel
choice. The app already solved this elsewhere by per-window-suffixing
(`local-storage.ts` `workspaceUrl` comment). Apply the same suffix scheme.

**M9 — Doc drift: `DESIGN.md` says one registration file; reality is three.**
`DESIGN.md:96-98,194` references `apps/electron/src/plugins/index.ts` as the
single registration point. The actual files are `manifests.ts`,
`renderer-entries.ts`, `main-entries.ts` (correctly described in `AUTHORING.md`).
Align `DESIGN.md`.

### Nit

**N1 — `ui.webview` sits at the same level as `ui.sidePanel` but is really a
capability *of* a panel.** It is the clearest "browser-pane tell" in the
permission enum. No correctness issue; consider documenting it as a panel
sub-capability so the permission taxonomy doesn't imply a webview is a standalone
contribution.

**N2 — Plugins can't contribute translated strings.** The reference browser plugin
hardcodes English (`BrowserPanel.tsx` "Back", "Search or enter address"), while
the framework itself is fully i18n'd. A framework that can't localize its plugins
is a gap; fine for v1.

---

## Credit where due (don't regress these)

- **The `<webview>` hardening is a strong, main-enforced start.**
  `plugin-host.ts:238` intercepts `will-attach-webview` app-wide, forces
  `sandbox`/`contextIsolation`/`webSecurity` on and `nodeIntegration`/preload off
  regardless of what the tag requested, allowlists the
  `persist:craft-plugin-<id>` partition, validates the initial http(s)/about
  URL, denies camera/mic/geo by default, and contains popups to the OS browser.
  This is the one real security boundary and it should not regress. But do not
  call it complete/Figma-grade until S-M3's post-attach navigation filtering
  lands.
- **Error isolation and reverse-order teardown** (`registry.ts:92-131`) are
  correct and swallow disposer failures without leaking the rest.
- **The enabling refactor was already present** (Kent Beck "make the change easy,
  then make the easy change"): `PanelStackContainer` already plumbed
  `isRightSidebarVisible`, hardcoded `false`. The PR fed an existing seam rather
  than carving a new one — the good version of the maxim.

---

## Part A — Benchmark against real extension architectures

| System | What they do | What this PR does | Defensible for an Electron + agent app? |
|---|---|---|---|
| **VS Code** | Separate **extension-host process**; one narrow stable `vscode` facade; **declarative `contributes`** (commands/views/viewsContainers/menus); **activationEvents** for lazy load; sandboxed **webviews**; **proposed API** to evolve safely. | Same renderer process (no host isolation); **imperative** `activate(ctx)` registration; **no** lazy activation; attach-hardened webview with a navigation gap (S-M3); **no** proposed/versioned API. | Webview direction ✔, but not parity until S-M3. Diverges on isolation, declarativeness, lazy-load, versioning — **not** all justified: M2/M3 are cheap to adopt and worth it. Process isolation is reasonably deferred for first-party v1. |
| **Eclipse** | OSGi bundles + `plugin.xml` **extension points**; heavyweight, maximally general. | One typed permission enum + imperative context. | Correct to be lighter than Eclipse for this app; the *declarative* lesson (M2) still applies without the OSGi weight. |
| **Emacs** | Fully in-process Lisp, hooks, `advice`, redefinition; max extensibility, ~zero sandbox. | In-process renderer plugins with **advisory** permission proxy. | This is effectively where the PR sits *today* (see B1) while *claiming* otherwise. Fine if the docs admit it (Emacs is honest that it's an open system). |
| **Neovim** | **msgpack-RPC remote plugins** out-of-process + Lua API; deliberate decoupling so a plugin can't crash the editor. | Renderer plugins share the app's process and event loop. | The relevant warning for *failure isolation*: a slow/crashing renderer plugin can jank or take the window down. Acceptable for first-party v1; the model to copy if/when third-party code loads. |
| **IntelliJ** | "Everything is an extension point" + DI container + plugin.xml. | One extension dimension (side pane) + capability permissions. | Right to not go full extension-point-explosion now; M1's slot registry is the minimal step toward it. |
| **Obsidian** (closest analog) | Electron, `Plugin` `onload`/`onunload`, `registerView`/`addCommand`/`addSettingTab`, auto-cleanup of registered resources; **community plugins run with full access — trust boundary is the author, not a sandbox.** | `activate`/dispose with auto-tracked disposables (very close to Obsidian's Component model ✔); only `registerView`-equivalent exists (no command/settings/ribbon contributions yet). | The disposable-lifecycle mirror of Obsidian is apt and well-executed. **Obsidian is also the honesty model for B1**: it never pretends in-process plugins are sandboxed. |
| **Figma** | Sandbox realm (QuickJS/WASM) for scene code + **iframe** for UI; every cross-boundary call is serialized `postMessage`. | `<webview>` guest attach hardening resembles Figma's UI iframe, but lacks continuous navigation enforcement (S-M3); the *plugin's own code* is not in any sandbox (unlike Figma's QuickJS). | Directionally right, not Figma-grade until S-M3. The plugin-logic sandbox gap is the B1 honesty issue; QuickJS-style isolation is the target for external code. |
| **Chrome MV3** | Manifest **declared permissions** + `host_permissions`; background service worker vs content-script split; least-privilege. | Manifest **declared permissions** ✔ (good parity on *declaration & UI surfacing*); main vs renderer split ≈ background/content split ✔. | The permission-declaration model is the most battle-tested thing the PR borrowed and it borrowed it well. The gap vs Chrome is *enforcement* (Chrome's are kernel-enforced; these are advisory in-renderer and incomplete for webview navigation) — B1/S-M3. |

**Sources:**
Verified sources used for the comparison:
[VS Code Extension Host](https://code.visualstudio.com/api/advanced-topics/extension-host),
[activation events](https://code.visualstudio.com/api/references/activation-events),
[contribution points](https://code.visualstudio.com/api/references/contribution-points),
[proposed API](https://code.visualstudio.com/api/advanced-topics/using-proposed-api),
[webviews](https://code.visualstudio.com/api/extension-guides/webview);
[Eclipse extensions/extension points](https://help.eclipse.org/latest/topic/org.eclipse.pde.doc.user/concepts/extension.htm)
and [extension registry](https://help.eclipse.org/latest/topic/org.eclipse.platform.doc.isv/guide/runtime_registry.htm);
[Emacs hooks](https://www.gnu.org/software/emacs/manual/html_node/elisp/Hooks.html)
and [advice](https://www.gnu.org/software/emacs/manual/html_node/elisp/Advising-Functions.html);
[Neovim remote plugins](https://neovim.io/doc/user/remote_plugin.html) and
[API/RPC](https://neovim.io/doc/user/api.html);
[IntelliJ extension points](https://plugins.jetbrains.com/docs/intellij/plugin-extension-points.html),
[plugin.xml](https://plugins.jetbrains.com/docs/intellij/plugin-configuration-file.html), and
[services](https://plugins.jetbrains.com/docs/intellij/plugin-services.html);
[Obsidian Plugin API](https://docs.obsidian.md/Reference/TypeScript+API/Plugin)
and [manifest](https://docs.obsidian.md/Plugins/Releasing/Plugin+manifest);
[Figma how plugins run](https://developers.figma.com/docs/plugins/how-plugins-run/)
and [plugin-system security write-up](https://www.figma.com/blog/how-we-built-the-figma-plugin-system/);
[Chrome declared permissions](https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions),
[service workers](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers), and
[content scripts](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts);
[Fowler Plugin](https://martinfowler.com/eaaCatalog/plugin.html) and
[Separated Interface](https://martinfowler.com/eaaCatalog/separatedInterface.html);
[Martin Clean Architecture / Dependency Rule](https://blog.cleancoder.com/uncle-bob/2012/08/13/the-clean-architecture.html);
[Parnas module decomposition](http://sunnyday.mit.edu/16.355/parnas-criteria.html);
[Meyer Open-Closed Principle](https://en.wikipedia.org/wiki/Open%E2%80%93closed_principle);
[Kent Beck quote](https://x.com/KentBeck/status/250733358307500032).

---

## Part B — Named architectural principles

| Principle | Verdict | Evidence |
|---|---|---|
| **Martin — Dependency Rule** (core ignorant of plugins; deps point inward) | **Pass** | `packages/shared/src/plugins/` is fully plugin-agnostic; hosts depend on the `PluginActivator` abstraction, not concretes. No core module imports a specific plugin; the `BUILTIN_*` maps are the inversion seam and are empty in this PR. |
| **Fowler — Plugin + Separated Interface** | **Pass (textbook)** | `PluginContext`/`PluginRendererEntry`/`PluginMainContext` are clean separated interfaces; the host links concretes at runtime via the registration maps — exactly "link at configuration, not compilation." |
| **Parnas — information hiding** | **Partial** | `ctx` hides internals well *by intent*, but encapsulation is unenforced in a shared renderer context (B1), and the package boundary leaks its Node-ness (M7). `panel-store` also exports a broad mutation API publicly. |
| **Meyer — Open–Closed** | **Strong on one axis, fails across axes** | Adding a *side-panel* plugin = **2 data files, +8 lines, zero core logic** (measured against PR #2). But a *new kind* of contribution (left pane, status bar, command) requires core edits (M1). Closed for the supported dimension; open for new dimensions. |
| **Beck — make the change easy, then change** | **Pass** | The right-sidebar seam pre-existed; the PR fed it rather than bolting on. The webviewTag seam is a one-expression swap. Enabling refactor was clean (and largely already done upstream). |

---

## Part C — Generalization stress test

Expressed on paper against the **public API only**.

| # | Hypothetical plugin | Expressible today? | Verdict / minimal fix (and whose pattern) |
|---|---|---|---|
| 1 | **Left**-side pane | **No** | "Right" is hardcoded in `PluginPaneHost` + the AppShell mount. Min fix: `location: 'left'\|'right'` on `registerSidePanel` + edge-agnostic host (**VS Code viewsContainers**). |
| 2 | Second simultaneous pane from another plugin | **Partial** | Two plugins *coexist* in one shared right slot (keys namespaced `pluginId:panelId`, two rail icons) but are **mutually exclusive** (one `activePanelKey`, one shared width). No true side-by-side. Needs M1's slot model for real composition. |
| 3 | Command-palette / keyboard shortcut | **No** | No command contribution exists. Min fix: declarative `contributes.commands` + a `registerCommand` dispatch (**VS Code commands**); wire to the app's existing shortcut system, don't invent one. |
| 4 | Status-bar / toolbar widget | **No** | No such slot. Min fix: a `statusBar` slot id in M1's registry (**VS Code `contributes` / status bar items**). |
| 5 | Settings page from a plugin | **No** | Settings pages are a fixed core registry (`settings-registry.ts`); a plugin can't add one. Min fix: declarative `contributes.settings` feeding the existing registry (**Obsidian `addSettingTab`**). |
| 6 | New **source type** / hook into sources/skills | **No** | Source types are fixed (`mcp`/`api`/`local`, per `packages/shared/CLAUDE.md`); plugins don't touch sources/skills. Out of scope; would need a sources extension point (**Eclipse extension point**). |
| 7 | Agent/tool hook (`PreToolUse`/`SessionStart`) | **No (deferred)** | No event seam. When built, mirror `WorkspaceEventBus` read-only — **do not fork it** (M4). |
| 8 | Modal/dialog or theme | **No** | No modal or theme contribution surface. Theme especially would want declarative tokens (**VS Code color themes**). |
| 9 | Main-process-only background plugin (no UI) | **Yes** ✔ | A manifest with `permissions: ['ipc']` + a `main-entries.ts` entry and no renderer entry works today; `MAIN_PLUGIN_ENTRIES` exists precisely for this. The one fully-general non-UI path. |
| 10 | Plugin depending on another plugin | **No** | No dependency declaration, no load-order guarantee (registration is array/iteration order; activation is unordered map iteration). Min fix: manifest `dependencies` + topological activation (**Eclipse `require-bundle` / npm peer model**). Defer, but reserve the field. |

**Score: 1 fully expressible (#9), 1 partial (#2), 8 needing new core seams.** The
one fully-general path is the *non-UI* one; the UI surface is the under-generalized
half. That asymmetry is the evidence for the Q1 verdict.

---

## Part D — Minimal-footprint / upgrade-safety audit

**Diffstat at `e2f6e07`:** current PR head including this review doc is 42
files, **+3082 / −2**. Excluding `docs/plugins/REVIEW.md` itself, the
framework/docset is 41 files, **+2680 / −2**: **23 new files** and **18 modified
existing files**. Net change in pre-existing files: **132 added, 2 deleted** —
the two deletions are single-token swaps (`false` → a function call). This is
about as additive as a cross-cutting feature can be.

**Revert test:** With `BUILTIN_PLUGIN_MANIFESTS = []` (this PR's state),
`isPluginWebviewEnabled()` returns `false` (empty registry), `PluginPaneHost`
returns `null` (no panels), `isRightSidebarVisible` is `false`. The UI is
provably identical to vanilla. Deleting `apps/electron/src/plugins/` +
`src/renderer/plugins/` + `src/main/plugin-host.ts` + reverting the 18 one-hunk
edits restores baseline with no behavioral residue. **Pass.**

**Reuse vs. duplication:** Correctly reuses `CRAFT_CONFIG_DIR`, the
`atomicWriteFileSync`/`safeJsonParse` utils, the zod+`{valid,errors}` automations
convention, the central `local-storage` `KEYS`, the existing direct-IPC preload
tier, the settings-page registry, and the pre-existing right-sidebar slot.
**Did not fork** the config store or invent a parallel settings system. The only
duplication is the inline visibility predicate (M5). It correctly **declined** to
reuse the server-side event bus (wrong process) but must reuse it later (M4).

| Modified file | +/− | Seam or scatter? | Upgrade-conflict risk |
|---|---|---|---|
| `main/index.ts` | +8/0 | **Seam** — 1 import + 2 lifecycle calls at app bootstrap | **Low** — stable, append-only region |
| `main/window-manager.ts` | +5/1 | **Seam** — `webviewTag` one-expression swap in `webPreferences` | **Low-Med** — `webPreferences` is occasionally edited upstream |
| `preload/bootstrap.ts` | +14/0 | **Seam** — adds `plugins.*` to the existing direct-IPC tier | **Low** — additive, stable bridge |
| `renderer/components/app-shell/AppShell.tsx` | +11/1 | **Seam + minor scatter** — 2 imports, a `PluginPaneHost` mount (good) **and** an inline visibility computation that duplicates `panel-store` (M5) | **High** — 3000-line hot file; biggest conflict surface in the PR. Shrink the footprint via M5. |
| `renderer/components/icons/SettingsIcons.tsx` | +3/0 | **Seam** — registry entry | **Low** |
| `renderer/lib/local-storage.ts` | +5/0 | **Seam** — 3 `KEYS` | **Low** |
| `renderer/pages/settings/settings-pages.ts` | +2/0 | **Seam** — registry entry | **Low** |
| `shared/menu-schema.ts` | +1/0 | **Seam** — registry entry | **Low** |
| `shared/settings-registry.ts` | +1/0 | **Seam** — registry entry | **Low** |
| `shared/types.ts` | +16/0 | **Seam** — `plugins` block on `ElectronAPI` + type re-export | **Med** — central, frequently-edited interface; additive though |
| `packages/shared/package.json` | +3/0 | **Seam** — 3 subpath exports | **Low** |
| `i18n/locales/*.json` ×7 | +9 each | **Seam** — keys (parity-gated) | **Low** — mechanical, but a merge dropping the block fails `lint:i18n:parity` (good) |

**Most likely to conflict on upstream merges:** `AppShell.tsx` (size + churn) and
`shared/types.ts` (central interface). Both are the *correct* stable anchors —
there is nowhere better to put a layout mount or an IPC type — so the risk is
intrinsic; M5 removes the only *avoidable* part of it. Everything else is
registry one-liners that conflict only if upstream edits the exact adjacent line.

**Conclusion:** Footprint and upgrade-safety are **excellent** and clearly the
design's north star (consistent with issue #256). The one actionable cleanup is
M5.

---

## Part E — Cross-cutting hard questions

- **Isolation/security.** Embedded web page: **well isolated at attach time**
  (main-enforced — see Credit), but post-attach navigation still needs S-M3.
  Plugin's own renderer code: **not isolated** — full ambient authority over
  `window.electronAPI` and other plugins' state (**B1**).
  No permission grants credentials/Node/config — *true only because no service
  exposes them through `ctx`*, but the plugin can reach them via the shared
  `window` anyway. Versus Chrome (kernel-enforced declared permissions) / Figma
  (QuickJS realm) / VS Code (separate host), this is the weakest enforcement,
  acceptable only under the first-party-trust assumption that **must be stated**.
- **API versioning & stability.** **Absent (M3).** No framework `apiVersion`, no
  proposed/stable tiering. The single biggest long-term risk to a community
  ecosystem.
- **Failure isolation.** **Main-process activation** errors are isolated
  (`status: 'error'`, others unaffected) — good. **Renderer activation** errors
  are isolated locally but invisible to Settings (S-M2). **Runtime** is not: an
  enabled plugin's component throwing during render, or a busy loop, janks/crashes
  the shared renderer (no React error boundary around
  `<activePanel.contribution.component>` in `PluginPaneHost.tsx:98`). Min fix:
  wrap contributed components in an error boundary and report renderer status.
  (Neovim/VS Code get stronger isolation via process boundaries.)
- **Performance.** **Load-everything-at-startup**, and main-side activation runs
  *before first window* on the paint-critical path (M2). Negligible at one
  plugin; no lazy-activation story for scale.

---

## Recommended minimal extension-point set (max generality per unit of surface)

Ranked by leverage-per-cost. Each names the architecture it borrows from and why
it fits a multi-pane Electron agent shell.

1. **Honesty + (optional) close the `invoke` hole (B1)** — *docs + ~5 LOC*.
   Borrowed from **Obsidian**'s honest trust model. Prerequisite to shipping.
2. **Decouple renderer runtime bootstrap from the side-pane host (S-M1)** — one
   app-level effect/provider; large generality payoff and removes the clearest
   browser-pane coupling.
3. **Declarative `contributes` in the manifest (M2)** — unlocks introspection +
   lazy activation + powers slots/commands/settings declaratively. Borrowed from
   **VS Code / Eclipse**. One manifest field, large payoff.
4. **Generic contribution-slot registry, starting with `location` on side panels
   (M1)** — turns "new UI location" from a core edit into a data change; subsumes
   left pane, status bar, toolbar. Borrowed from **VS Code viewsContainers/views**.
5. **Complete webview navigation enforcement (S-M3)** — small Electron event-hook
   addition; aligns the webview with **Chrome/Figma**-style continuous capability
   enforcement.
6. **Framework `apiVersion` + `engines` gate (M3)** — cheapest insurance for
   upgrade-safe community plugins; the exact issue-#256 thesis applied to the
   plugin contract. Borrowed from **VS Code `engines.vscode`**.
7. **(When needed) read-only client mirror of `WorkspaceEventBus` for agent hooks
   (M4)** — reuse, don't fork. Borrowed from the app's **own automations** bus.

Deliberately **not** recommended now (avoid over-engineering — no realistic v1
plugin needs them): inter-plugin dependency resolution (#10), plugin-contributed
source types (#6), themes (#8), separate extension-host process. Reserve the
manifest vocabulary for them; don't build them.
