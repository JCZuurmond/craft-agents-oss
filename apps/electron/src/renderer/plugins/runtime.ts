/**
 * Renderer Plugin Runtime
 *
 * Owns renderer-side plugin activation for this window, independent of any
 * particular UI host (the pane hosts only *render* contributions). Bootstraps
 * from AppShell at app level, keeps enablement in sync with the main-process
 * host live, and reports renderer-side failures back to main so Settings
 * shows the truth for this window too.
 *
 * Activation policy:
 * - Plugins whose manifest declares `contributes.sidePanels` are activated
 *   lazily: their panels appear in the toggle rail from manifest data alone,
 *   and the plugin's `activate()` only runs when a panel is first opened.
 * - Plugins without declarative contributions are activated eagerly at
 *   startup — their contributions exist only in code, so there is nothing to
 *   render until `activate()` runs.
 * - Toggling a plugin on in Settings activates it immediately (the user asked
 *   for it now); toggling off deactivates and removes its panels everywhere.
 */

import { PluginRegistry } from '@craft-agent/shared/plugins/registry'
import {
  checkPluginApiCompatibility,
  type LoadedPlugin,
  type PluginDisposable,
  type PluginManifest,
} from '@craft-agent/shared/plugins/types'
import { BUILTIN_PLUGIN_MANIFESTS } from '../../plugins/manifests'
import { RENDERER_PLUGIN_ENTRIES } from '../../plugins/renderer-entries'
import { createPluginContext } from './context'
import {
  getPluginPaneState,
  subscribePluginPane,
  declarePluginPanels,
  removePluginPanels,
  markPluginPanelError,
  markPluginPanelsError,
  resetPluginPanel,
} from './panel-store'

let registry: PluginRegistry | null = null
let initializePromise: Promise<void> | null = null
const pendingActivations = new Map<string, Promise<boolean>>()
/** Last renderer status pushed to main per plugin (null = healthy) */
const lastReportedError = new Map<string, string | null>()

function declaredPanels(manifest: PluginManifest) {
  return manifest.contributes?.sidePanels ?? []
}

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
 * Push renderer-side failures (and recoveries) to the main-process host,
 * which merges them into the authoritative Settings status. Without this, a
 * plugin that breaks only in the renderer would look healthy. The reported
 * error is derived from BOTH failure surfaces — the registry (activation
 * errors) and the panel store (render crashes, unregistered declared
 * panels) — so an unrelated registry change never wipes a live crash, and a
 * successful panel retry clears its report.
 */
function syncRendererStatusToMain(): void {
  const reportStatus = window.electronAPI?.plugins?.reportRendererStatus
  if (!reportStatus || !registry) return
  const panels = getPluginPaneState().panels
  for (const entry of registry.list()) {
    const id = entry.manifest.id
    const activationError = entry.status === 'error' ? (entry.error ?? 'Unknown renderer error') : null
    const erroredPanel = panels.find((p) => p.pluginId === id && p.status === 'error')
    const error = activationError
      ?? (erroredPanel ? `Panel '${erroredPanel.key}': ${erroredPanel.error ?? 'error'}` : null)
    if (lastReportedError.get(id) === error) continue
    lastReportedError.set(id, error)
    void reportStatus(id, error)
  }
}

/** Activate with an in-flight guard (lazy opens can race the same plugin) */
function activateOnce(pluginId: string): Promise<boolean> {
  if (!registry) return Promise.resolve(false)
  const pending = pendingActivations.get(pluginId)
  if (pending) return pending
  const promise = registry.activate(pluginId).finally(() => pendingActivations.delete(pluginId))
  pendingActivations.set(pluginId, promise)
  return promise
}

/**
 * Initialize the plugin runtime for this window. Idempotent; called once from
 * the app shell. Safe outside Electron (playground) — resolves to a no-op.
 */
export function initializePluginRuntime(): Promise<void> {
  if (initializePromise) return initializePromise

  initializePromise = (async () => {
    // Plugin API is preload-provided; absent in non-Electron hosts (playground).
    const pluginsApi = window.electronAPI?.plugins
    if (!pluginsApi) return

    registry = new PluginRegistry({
      activate: activateRendererPlugin,
      onDidChange: syncRendererStatusToMain,
    })

    const infos = await pluginsApi.list()
    const enabledById = new Map(infos.map((info) => [info.id, info.enabled]))

    for (const manifest of BUILTIN_PLUGIN_MANIFESTS) {
      const panels = declaredPanels(manifest)
      if (!RENDERER_PLUGIN_ENTRIES[manifest.id] && panels.length === 0) continue
      const incompatibility = checkPluginApiCompatibility(manifest) ?? undefined
      const enabled = enabledById.get(manifest.id) ?? false
      registry.register({ manifest, source: 'builtin' }, enabled, { incompatibility })
      if (enabled && !incompatibility && panels.length > 0) {
        declarePluginPanels(manifest.id, panels, manifest.icon)
      }
    }

    // Eager activation only for plugins with no declared panels; declared
    // panels activate lazily via ensurePluginPanelReady on first open.
    for (const entry of registry.list()) {
      if (entry.enabled && !entry.incompatibility && declaredPanels(entry.manifest).length === 0) {
        await activateOnce(entry.manifest.id)
      }
    }

    pluginsApi.onChanged((plugins) => {
      for (const info of plugins) {
        const entry = registry?.get(info.id)
        if (!entry || entry.enabled === info.enabled) continue
        if (info.enabled) {
          // Live toggle-on: declare panels and activate right away — lazy
          // startup exists for the paint path, not for explicit user intent.
          const panels = declaredPanels(entry.manifest)
          if (panels.length > 0) declarePluginPanels(info.id, panels, entry.manifest.icon)
          void registry?.setEnabled(info.id, true).then(() => {
            const failed = registry?.get(info.id)
            if (failed?.status === 'error') {
              markPluginPanelsError(info.id, failed.error ?? 'Plugin failed to activate')
            }
          })
        } else {
          void registry?.setEnabled(info.id, false).then(() => removePluginPanels(info.id))
        }
      }
    })

    // Panel-store changes (crash quarantines, retries, lazy registrations)
    // feed the same status report as registry changes.
    subscribePluginPane(syncRendererStatusToMain)

    window.addEventListener('beforeunload', () => registry?.disposeAll())
  })()

  return initializePromise
}

/**
 * Lazy-activation entry point: make sure the plugin behind a declared panel
 * is activated and the panel component registered. Marks the panel errored
 * when activation fails or the plugin never registers the declared panel.
 */
export async function ensurePluginPanelReady(key: string): Promise<void> {
  await initializePluginRuntime()
  const panel = getPluginPaneState().panels.find((p) => p.key === key)
  if (!panel || panel.status !== 'declared' || !registry) return

  const entry = registry.get(panel.pluginId)
  if (!entry || !entry.enabled || entry.incompatibility) return

  if (entry.status === 'inactive') {
    await activateOnce(panel.pluginId)
  } else if (entry.status === 'error') {
    // Retry a previously failed activation (mirrors the Settings retry path).
    await registry.setEnabled(panel.pluginId, true)
  }

  const after = registry.get(panel.pluginId)
  if (after?.status === 'error') {
    markPluginPanelsError(panel.pluginId, after.error ?? 'Plugin failed to activate')
    return
  }
  const panelAfter = getPluginPaneState().panels.find((p) => p.key === key)
  if (panelAfter && panelAfter.status === 'declared') {
    markPluginPanelError(key, `Plugin '${panel.pluginId}' did not register panel '${key}'`)
  }
}

/** Retry a panel that errored: remount if it has a component, else re-activate */
export async function retryPluginPanel(key: string): Promise<void> {
  resetPluginPanel(key)
  await ensurePluginPanelReady(key)
}

/**
 * Called by the pane host's error boundary when a contributed component
 * throws during render: quarantine the panel; the panel-store subscription
 * then attributes the failure to the plugin in Settings (main aggregates
 * per-window renderer status), and a successful retry clears it.
 */
export function reportPluginPanelCrash(key: string, _pluginId: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  markPluginPanelError(key, `Crashed: ${message}`)
  syncRendererStatusToMain()
}
