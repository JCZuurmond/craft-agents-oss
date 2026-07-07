/**
 * Renderer Plugin Runtime
 *
 * Owns renderer-side plugin activation for this window, independent of any
 * particular UI host (the pane hosts only *render* contributions). Bootstraps
 * from AppShell at app level, keeps enablement in sync with the main-process
 * host live, and reports renderer-side failures back to main so Settings
 * shows the truth for this window too.
 *
 * Activation policy (the VS Code activationEvents model; see
 * shouldActivateOnStartup for the default when a manifest declares none):
 * - Plugins with declared side panels activate lazily when a panel is first
 *   opened; their panels appear in the toggle rail from manifest data alone.
 * - Plugins with declared commands activate lazily when a command first
 *   executes (keybinding or executeCommand) — keybindings bind from manifest
 *   data alone.
 * - Plugins declaring `onStartup` (or with no declarative contributions —
 *   their contributions exist only in code) activate eagerly at startup.
 * - Toggling a plugin on in Settings activates it immediately (the user asked
 *   for it now); toggling off deactivates and removes its panels and
 *   keybindings everywhere.
 */

import { PluginRegistry } from '@craft-agent/shared/plugins/registry'
import {
  checkPluginApiCompatibility,
  shouldActivateOnStartup,
  type LoadedPlugin,
  type PluginDisposable,
  type PluginEntryPaths,
  type PluginInfo,
  type PluginManifest,
} from '@craft-agent/shared/plugins/types'
import { BUILTIN_PLUGIN_MANIFESTS } from '../../plugins/manifests'
import { RENDERER_PLUGIN_ENTRIES } from '../../plugins/renderer-entries'
import { createPluginContext } from './context'
import type { PluginRendererEntry } from './types'
import {
  getPluginPanelState,
  subscribePluginPanels,
  declarePluginPanels,
  removePluginPanels,
  markPluginPanelError,
  markPluginPanelsError,
  resetPluginPanel,
} from './panel-store'
import {
  declarePluginCommands,
  removePluginCommands,
  setPluginCommandActivationHandler,
  initializePluginKeybindings,
} from './command-store'
import { pluginHostHooks } from './host-hooks'

let registry: PluginRegistry | null = null
let initializePromise: Promise<void> | null = null
const pendingActivations = new Map<string, Promise<boolean>>()
/** Last renderer status pushed to main per plugin (null = healthy) */
const lastReportedError = new Map<string, string | null>()
/** Resolved entry-file paths for external plugins (from main), keyed by id */
const externalEntryPaths = new Map<string, PluginEntryPaths>()

/**
 * Load an external plugin's renderer entry module from disk. Split out as a
 * test seam; the default dynamically imports the (main-resolved) entry file.
 * External plugin code runs in the same renderer realm as the app — trusted,
 * first-party-by-install code (see SECURITY.md); this is the one runtime step
 * that requires a real Electron renderer to exercise end-to-end.
 */
let externalRendererModuleLoader = async (
  entryPath: string,
): Promise<{ activate?: PluginRendererEntry }> => {
  const url = entryPath.startsWith('file:') ? entryPath : `file://${entryPath}`
  return (await import(/* @vite-ignore */ url)) as { activate?: PluginRendererEntry }
}

/** Test seam: override how external renderer modules are loaded */
export function setExternalRendererModuleLoader(
  loader: (entryPath: string) => Promise<{ activate?: PluginRendererEntry }>,
): void {
  externalRendererModuleLoader = loader
}

/** Reconstruct a manifest from the IPC snapshot for an external plugin */
function manifestFromInfo(info: PluginInfo): PluginManifest {
  return {
    id: info.id,
    name: info.name,
    version: info.version,
    description: info.description,
    icon: info.icon,
    permissions: info.permissions,
    apiVersion: info.apiVersion,
    contributes: info.contributes,
    activationEvents: info.activationEvents,
  }
}

/** Keep the external entry-path map in sync with the latest IPC snapshot */
function syncExternalEntryPaths(infos: PluginInfo[]): void {
  for (const info of infos) {
    if (info.entryPaths) externalEntryPaths.set(info.id, info.entryPaths)
  }
}

/**
 * Resolve a plugin's renderer entry: compiled-in for built-ins, dynamically
 * imported from disk for external plugins that ship a `renderer` entry file.
 */
async function resolveRendererEntry(plugin: LoadedPlugin): Promise<PluginRendererEntry | null> {
  const builtin = RENDERER_PLUGIN_ENTRIES[plugin.manifest.id]
  if (builtin) return builtin
  const entryPath = externalEntryPaths.get(plugin.manifest.id)?.renderer
  if (!entryPath) return null
  const mod = await externalRendererModuleLoader(entryPath)
  if (typeof mod.activate !== 'function') {
    throw new Error(`renderer entry '${entryPath}' does not export an activate() function`)
  }
  return mod.activate
}

function declaredPanels(manifest: PluginManifest) {
  return manifest.contributes?.sidePanels ?? []
}

function declaredCommands(manifest: PluginManifest) {
  return manifest.contributes?.commands ?? []
}

/** Does the manifest declare anything renderable/bindable without code? */
function hasDeclarativeContributions(manifest: PluginManifest): boolean {
  return declaredPanels(manifest).length > 0 || declaredCommands(manifest).length > 0
}

async function activateRendererPlugin(plugin: LoadedPlugin): Promise<PluginDisposable[]> {
  const pluginId = plugin.manifest.id
  const entry = await resolveRendererEntry(plugin)
  if (!entry) return []

  const created = createPluginContext(plugin.manifest)
  try {
    const result = await entry(created.ctx)
    const returned = result == null ? [] : Array.isArray(result) ? result : [result]
    pluginHostHooks.emit('plugin:activated', { pluginId })
    // First in the list = disposed last (reverse-order teardown), so the
    // deactivation hook fires after the plugin's own disposables ran.
    return [
      { dispose: () => pluginHostHooks.emit('plugin:deactivated', { pluginId }) },
      ...returned,
      { dispose: created.dispose },
    ]
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
  const panels = getPluginPanelState().panels
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
    syncExternalEntryPaths(infos)

    // Declared commands activate their plugin on first execution.
    setPluginCommandActivationHandler(ensurePluginActive)
    initializePluginKeybindings()

    for (const manifest of BUILTIN_PLUGIN_MANIFESTS) {
      if (!RENDERER_PLUGIN_ENTRIES[manifest.id] && !hasDeclarativeContributions(manifest)) continue
      const incompatibility = checkPluginApiCompatibility(manifest) ?? undefined
      const enabled = enabledById.get(manifest.id) ?? false
      registry.register({ manifest, source: 'builtin' }, enabled, { incompatibility })
      if (enabled && !incompatibility) {
        declareContributions(manifest)
      }
    }

    // External plugins: code lives on disk, discovered by main. Register those
    // that contribute to this renderer (a renderer entry file or declarative
    // panels/commands); main-only (ipc) and invalid dirs carry neither and are
    // skipped here. Built-ins already registered win any id clash.
    for (const info of infos) {
      if (!info.external || registry.get(info.id)) continue
      const manifest = manifestFromInfo(info)
      if (!info.entryPaths?.renderer && !hasDeclarativeContributions(manifest)) continue
      const incompatibility = info.incompatibility ?? checkPluginApiCompatibility(manifest) ?? undefined
      registry.register({ manifest, source: 'user' }, info.enabled, { incompatibility })
      if (info.enabled && !incompatibility) {
        declareContributions(manifest)
      }
    }

    // Eager activation only for plugins whose activation events (explicit or
    // inferred) say 'onStartup'; declared panels/commands activate lazily via
    // ensurePluginPanelReady / the command activation handler on first use.
    for (const entry of registry.list()) {
      if (entry.enabled && !entry.incompatibility && shouldActivateOnStartup(entry.manifest)) {
        await activateOnce(entry.manifest.id)
      }
    }

    pluginsApi.onChanged((plugins) => {
      syncExternalEntryPaths(plugins)
      for (const info of plugins) {
        const entry = registry?.get(info.id)
        if (!entry || entry.enabled === info.enabled) continue
        if (info.enabled) {
          // Live toggle-on: declare contributions and activate right away —
          // lazy startup exists for the paint path, not for explicit user
          // intent.
          declareContributions(entry.manifest)
          void registry?.setEnabled(info.id, true).then(() => {
            const failed = registry?.get(info.id)
            if (failed?.status === 'error') {
              markPluginPanelsError(info.id, failed.error ?? 'Plugin failed to activate')
            }
          })
        } else {
          void registry?.setEnabled(info.id, false).then(() => {
            removePluginPanels(info.id)
            removePluginCommands(info.id)
          })
        }
      }
    })

    // Panel-store changes (crash quarantines, retries, lazy registrations)
    // feed the same status report as registry changes.
    subscribePluginPanels(syncRendererStatusToMain)

    window.addEventListener('beforeunload', () => registry?.disposeAll())

    pluginHostHooks.emit('app:ready', {
      pluginIds: registry.list().map((entry) => entry.manifest.id),
    })
  })()

  return initializePromise
}

/** Seed a manifest's declarative contributions (panels + command keybindings) */
function declareContributions(manifest: PluginManifest): void {
  const panels = declaredPanels(manifest)
  if (panels.length > 0) declarePluginPanels(manifest.id, panels, manifest.icon)
  const commands = declaredCommands(manifest)
  if (commands.length > 0) declarePluginCommands(manifest.id, commands)
}

/**
 * Lazy-activation entry point for declared commands (mirrors
 * ensurePluginPanelReady): make sure the plugin behind a declared command is
 * activated before the command store dispatches it.
 */
async function ensurePluginActive(pluginId: string): Promise<void> {
  await initializePluginRuntime()
  const entry = registry?.get(pluginId)
  if (!entry || !entry.enabled || entry.incompatibility) return
  if (entry.status === 'inactive') {
    await activateOnce(pluginId)
  } else if (entry.status === 'error') {
    // Retry a previously failed activation (mirrors the Settings retry path).
    await registry?.setEnabled(pluginId, true)
  }
}

/**
 * Lazy-activation entry point: make sure the plugin behind a declared panel
 * is activated and the panel component registered. Marks the panel errored
 * when activation fails or the plugin never registers the declared panel.
 */
export async function ensurePluginPanelReady(key: string): Promise<void> {
  await initializePluginRuntime()
  const panel = getPluginPanelState().panels.find((p) => p.key === key)
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
  const panelAfter = getPluginPanelState().panels.find((p) => p.key === key)
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
