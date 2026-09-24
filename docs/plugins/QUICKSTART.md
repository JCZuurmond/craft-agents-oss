# Build Your Own Plugin in 5 Minutes

We'll build a minimal "Hello Pane" plugin from nothing but the framework in
this repo — every file below is complete and self-contained. (A larger worked
example, a sandboxed Browser Pane plugin, ships separately from the framework;
this walkthrough deliberately depends on nothing outside it.)

## 1. Create the plugin directory and manifest (1 min)

```
apps/electron/src/plugins/hello-pane/
├── manifest.ts
└── renderer.tsx
```

`manifest.ts` — data only, no React/Electron imports:

```ts
import type { PluginManifest } from '@craft-agent/shared/plugins'

export const HELLO_PANE_PLUGIN_MANIFEST: PluginManifest = {
  id: 'hello-pane',
  name: 'Hello Pane',
  version: '0.1.0',
  description: 'My first Craft Agents plugin.',
  icon: '👋',
  apiVersion: 1,
  permissions: ['ui.sidePanel', 'storage'],
  contributes: {
    sidePanels: [{ id: 'hello', title: 'Hello Pane', icon: '👋', location: 'right' }],
  },
  entries: { renderer: 'renderer.tsx' },
  defaultEnabled: true,
}
```

Declaring the panel in `contributes.sidePanels` makes it introspectable
(Settings lists it) and **lazy**: its 👋 rail button renders from manifest
data alone, and your code only runs when the panel is first opened. Try
`location: 'left'` to host it on the left edge instead.

## 2. Write the renderer entry (2 min)

`renderer.tsx`:

```tsx
import { useState } from 'react'
import type { PluginContext, PluginPanelProps } from '../../renderer/plugins/types'

export function activate(ctx: PluginContext): void {
  function HelloPanel(_props: PluginPanelProps) {
    const [count, setCount] = useState(() => ctx.storage.get('count', 0))
    const increment = () => {
      const next = count + 1
      setCount(next)
      ctx.storage.set('count', next)   // survives restarts, scoped to this plugin
    }
    return (
      <div className="h-full flex flex-col items-center justify-center gap-3">
        <div className="text-sm">Hello from a plugin 👋</div>
        <button
          onClick={increment}
          className="px-3 py-1.5 text-xs rounded-md bg-foreground/10 hover:bg-foreground/15"
        >
          Clicked {count} times
        </button>
      </div>
    )
  }

  // Supplies the component for the declared panel — title/icon/location
  // come from the manifest declaration.
  ctx.ui.registerSidePanel({ id: 'hello', title: 'Hello Pane', component: HelloPanel })
}
```

## 3. Register it (1 min)

Two one-line additions to the (initially empty) registration maps:

```ts
// apps/electron/src/plugins/manifests.ts
import { HELLO_PANE_PLUGIN_MANIFEST } from './hello-pane/manifest'
export const BUILTIN_PLUGIN_MANIFESTS: PluginManifest[] = [
  HELLO_PANE_PLUGIN_MANIFEST,        // ← add
]

// apps/electron/src/plugins/renderer-entries.ts
import { activate as activateHelloPane } from './hello-pane/renderer'
export const RENDERER_PLUGIN_ENTRIES: Record<string, PluginRendererEntry> = {
  'hello-pane': activateHelloPane,   // ← add
}
```

## 4. Run it (1 min)

```bash
bun run typecheck:all
bun run electron:dev
```

A 👋 icon appears in the toggle rail on the right edge of the window — click
it to open your panel (that first click is what activates the plugin).
**Settings → Plugins** now lists "Hello Pane" with its permissions and
declared panel and an enable/disable toggle; toggling deactivates/reactivates
it live in every open window.

## 5. Going further

- **Embed web content:** declare `ui.webview` and render
  `<webview partition={ctx.webviewPartition} src="https://…" />` inside your
  panel — the main process only accepts your own partition, forces the
  sandbox, and polices every navigation. See [SECURITY.md](./SECURITY.md) for
  the policy.
- **Main-process capabilities:** declare `ipc`, add a `main.ts` entry in
  `apps/electron/src/plugins/main-entries.ts`, register handlers with
  `ctx.handle(channel, fn)`, and call them from the renderer with
  `ctx.invoke(channel, args)`.
- **Ship it without rebuilding the app:** the same manifest + `activate(ctx)`
  works as an **external** plugin — drop the folder into
  `~/.craft-agent/plugins/<id>/` and the host loads it from disk. Use
  `ctx.react` instead of a `react` import so no bundler is needed. Scaffold one
  with `bun run plugin:new <id>`. See [INSTALL.md](./INSTALL.md).
- **Test it:** activate against `createPluginContext(manifest)` and assert on
  `getPluginPanelState()`; validate your manifest with
  `validatePluginManifest`. The framework's own tests under
  `packages/shared/src/plugins/__tests__/` show the patterns.
- Full API reference: [AUTHORING.md](./AUTHORING.md).
