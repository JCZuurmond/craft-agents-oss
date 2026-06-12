/**
 * Renderer Plugin Runtime
 *
 * Activates built-in plugins' renderer entries against the enablement state
 * owned by the main-process host, and keeps them in sync live: toggling a
 * plugin in Settings activates/deactivates it in every window without a
 * restart (the lone exception is the webviewTag window flag — see plugin-host).
 */

// Import from subpaths (not the package index) — the index re-exports
// Node-only storage code that must stay out of the renderer bundle.
import { PluginRegistry } from '@craft-agent/shared/plugins/registry'
import type { LoadedPlugin, PluginDisposable } from '@craft-agent/shared/plugins/types'
import { BUILTIN_PLUGIN_MANIFESTS } from '../../plugins/manifests'
import { RENDERER_PLUGIN_ENTRIES } from '../../plugins/renderer-entries'
import { createPluginContext } from './context'

let registry: PluginRegistry | null = null
let initializePromise: Promise<void> | null = null

function activateRendererPlugin(plugin: LoadedPlugin): PluginDisposable[] {
  const entry = RENDERER_PLUGIN_ENTRIES[plugin.manifest.id]
  if (!entry) return []

  const created = createPluginContext(plugin.manifest)
  try {
    const result = entry(created.ctx)
    const returned = result == null ? [] : Array.isArray(result) ? result : [result]
    return [...returned, { dispose: created.dispose }]
  } catch (error) {
    // Roll back anything the entry registered before throwing, then let the
    // registry record the error state.
    created.dispose()
    throw error
  }
}

/**
 * Initialize the plugin runtime for this window. Idempotent — the pane host
 * and any other caller can invoke it freely.
 */
export function initializePluginRuntime(): Promise<void> {
  if (initializePromise) return initializePromise

  initializePromise = (async () => {
    // Plugin API is preload-provided; absent in non-Electron hosts (playground).
    const pluginsApi = window.electronAPI?.plugins
    if (!pluginsApi) return

    registry = new PluginRegistry({ activate: activateRendererPlugin })

    const infos = await pluginsApi.list()
    const enabledById = new Map(infos.map((info) => [info.id, info.enabled]))

    for (const manifest of BUILTIN_PLUGIN_MANIFESTS) {
      if (!RENDERER_PLUGIN_ENTRIES[manifest.id]) continue
      registry.register({ manifest, source: 'builtin' }, enabledById.get(manifest.id) ?? false)
    }

    await registry.activateEnabled()

    pluginsApi.onChanged((plugins) => {
      for (const info of plugins) {
        const entry = registry?.get(info.id)
        if (entry && entry.enabled !== info.enabled) {
          void registry?.setEnabled(info.id, info.enabled)
        }
      }
    })

    window.addEventListener('beforeunload', () => registry?.disposeAll())
  })()

  return initializePromise
}
