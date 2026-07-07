/**
 * In-page stand-in for the Electron main-process plugin host.
 *
 * Implements the exact `window.electronAPI.plugins` contract the preload
 * bridge exposes (list / setEnabled / invoke / reportRendererStatus /
 * onChanged — see src/shared/types.ts), backed by the same shared
 * `PluginRegistry` class the real main process uses. This keeps the demo
 * harness host-agnostic while avoiding a second app renderer entry point.
 *
 * Not reproduced here: Electron-only enforcement (webview partition allowlist,
 * navigation policing, `webviewTag` window flag). Those are covered by
 * docs/plugins/SECURITY.md and the main-process plugin host.
 *
 * IMPORTANT: import this module before renderer modules that read
 * `window.electronAPI` — installing the mock is a top-level side effect.
 */

import { PluginRegistry } from '@craft-agent/shared/plugins/registry'
import { checkPluginApiCompatibility, type PluginInfo } from '@craft-agent/shared/plugins/types'
import { BUILTIN_PLUGIN_MANIFESTS } from '../../manifests'

type PluginsChangedListener = (plugins: PluginInfo[]) => void

const listeners = new Set<PluginsChangedListener>()

/** Renderer-reported failures, merged into snapshots like the real host does */
const rendererErrors = new Map<string, string>()

const hostRegistry = new PluginRegistry({
  // No main-process capabilities exist in the browser demo (no webview
  // sessions to configure, no IPC handler table), so activation is a no-op.
  activate: () => [],
  onDidChange: () => notify(),
})

// Reference plugins ship defaultEnabled: false (a user opts in via
// Settings → Plugins). A recording seeds that opt-in with ?enable=<id>,
// exactly as a persisted plugins.json would.
const seededEnabled = new URLSearchParams(window.location.search).getAll('enable')

for (const manifest of BUILTIN_PLUGIN_MANIFESTS) {
  hostRegistry.register(
    { manifest, source: 'builtin' },
    (manifest.defaultEnabled ?? false) || seededEnabled.includes(manifest.id),
    { incompatibility: checkPluginApiCompatibility(manifest) ?? undefined },
  )
}

function currentInfo(): PluginInfo[] {
  return hostRegistry.listInfo().map((plugin) => {
    if (plugin.status === 'error') return plugin
    const rendererError = rendererErrors.get(plugin.id)
    return rendererError ? { ...plugin, status: 'error' as const, error: rendererError } : plugin
  })
}

function notify(): void {
  const info = currentInfo()
  for (const listener of listeners) listener(info)
}

export const demoPluginsHost = {
  list: async (): Promise<PluginInfo[]> => currentInfo(),

  setEnabled: async (id: string, enabled: boolean): Promise<{ ok: boolean; requiresRelaunch: boolean }> => {
    const entry = hostRegistry.get(id)
    if (!entry) return { ok: false, requiresRelaunch: false }
    if (entry.incompatibility && enabled) return { ok: false, requiresRelaunch: false }
    await hostRegistry.setEnabled(id, enabled)
    notify()
    // webviewTag is an Electron BrowserWindow flag; a browser page has no
    // equivalent, so a relaunch is never required here.
    return { ok: true, requiresRelaunch: false }
  },

  invoke: async (pluginId: string, channel: string, _args?: unknown): Promise<unknown> => {
    throw new Error(
      `Plugin invoke rejected: the browser demo host has no main process ` +
      `(plugin '${pluginId}', channel '${channel}')`,
    )
  },

  reportRendererStatus: async (pluginId: string, error: string | null): Promise<void> => {
    const previous = rendererErrors.get(pluginId)
    if (error === null) rendererErrors.delete(pluginId)
    else rendererErrors.set(pluginId, error)
    if (previous !== (error ?? undefined)) notify()
  },

  onChanged: (callback: PluginsChangedListener): (() => void) => {
    listeners.add(callback)
    return () => { listeners.delete(callback) }
  },
}

// Install as a side effect, before the plugin runtime module is evaluated.
;(window as unknown as { electronAPI: { plugins: typeof demoPluginsHost } }).electronAPI = {
  plugins: demoPluginsHost,
}
