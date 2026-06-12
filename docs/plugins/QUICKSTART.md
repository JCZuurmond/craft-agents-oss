# Build Your Own Plugin in 5 Minutes

We'll build a minimal "Hello Pane" plugin, following exactly the same steps the
shipped Browser Pane plugin (`apps/electron/src/plugins/web-browser/`) uses.
Each step links to the corresponding piece of the worked example.

## 1. Create the plugin directory and manifest (1 min)

```
apps/electron/src/plugins/hello-pane/
├── manifest.ts
└── renderer.tsx
```

`manifest.ts` — data only, no React/Electron imports
(compare: `web-browser/manifest.ts`):

```ts
import type { PluginManifest } from '@craft-agent/shared/plugins'

export const HELLO_PANE_PLUGIN_MANIFEST: PluginManifest = {
  id: 'hello-pane',
  name: 'Hello Pane',
  version: '0.1.0',
  description: 'My first Craft Agents plugin.',
  icon: '👋',
  permissions: ['ui.sidePanel', 'storage'],
  entries: { renderer: 'renderer.tsx' },
  defaultEnabled: true,
}
```

## 2. Write the renderer entry (2 min)

`renderer.tsx` (compare: `web-browser/renderer.tsx` + `BrowserPanel.tsx`):

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

  ctx.ui.registerSidePanel({
    id: 'hello',
    title: 'Hello Pane',
    icon: '👋',
    component: HelloPanel,
  })
}
```

## 3. Register it (1 min)

Two one-line additions:

```ts
// apps/electron/src/plugins/manifests.ts
import { HELLO_PANE_PLUGIN_MANIFEST } from './hello-pane/manifest'
export const BUILTIN_PLUGIN_MANIFESTS: PluginManifest[] = [
  WEB_BROWSER_PLUGIN_MANIFEST,
  HELLO_PANE_PLUGIN_MANIFEST,        // ← add
]

// apps/electron/src/plugins/renderer-entries.ts
import { activate as activateHelloPane } from './hello-pane/renderer'
export const RENDERER_PLUGIN_ENTRIES: Record<string, PluginRendererEntry> = {
  'web-browser': activateWebBrowser,
  'hello-pane': activateHelloPane,   // ← add
}
```

## 4. Run it (1 min)

```bash
bun run typecheck:all
bun run electron:dev
```

A 👋 icon appears in the toggle rail on the right edge of the window — click
it to open your pane. **Settings → Plugins** now lists "Hello Pane" with its
permissions and an enable/disable toggle; toggling deactivates/reactivates it
live in every open window.

## 5. Going further

- **Embed web content:** declare `ui.webview` and render
  `<webview partition={ctx.webviewPartition} src="https://…" />` — the main
  process only accepts your own partition and forces the sandbox. See
  `web-browser/BrowserPanel.tsx` for navigation, address-bar normalization,
  and load-failure handling, and [SECURITY.md](./SECURITY.md) for the policy.
- **Main-process capabilities:** declare `ipc`, add a `main.ts` entry in
  `apps/electron/src/plugins/main-entries.ts`, register handlers with
  `ctx.handle(channel, fn)`, and call them from the renderer with
  `ctx.invoke(channel, args)`.
- **Test it:** copy the pattern in
  `web-browser/__tests__/web-browser-plugin.test.ts` — activate against
  `createPluginContext(manifest)` and assert on `getPluginPaneState()`.
- Full API reference: [AUTHORING.md](./AUTHORING.md).
