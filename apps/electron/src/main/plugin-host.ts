/**
 * Main-process Plugin Host
 *
 * Owns the authoritative plugin registry (built-in + external plugins),
 * persists enablement, exposes the `__plugins:*` IPC surface consumed by the
 * preload bridge, and enforces the security policy for plugin web content:
 *
 * - <webview> is only allowed in app windows when at least one enabled plugin
 *   declares the `ui.webview` permission (computed at window creation).
 * - Every webview attach is hardened via `will-attach-webview`: preload
 *   scripts are stripped, nodeIntegration is forced off, contextIsolation and
 *   sandbox are forced on, the session partition must belong to an enabled
 *   webview plugin, and only http(s)/about: URLs may load.
 * - Plugin partitions get a deny-by-default permission-request handler.
 * - window.open / target=_blank from plugin webviews never creates windows;
 *   http(s) links are handed to the OS browser.
 */

import { app, ipcMain, session, shell, BrowserWindow } from 'electron'
import { mainLog } from './logger'
import {
  PluginRegistry,
  loadExternalPlugins,
  loadPluginsConfig,
  isPluginEnabled,
  setPluginEnabled,
  manifestHasPermission,
  getPluginWebviewPartition,
  PLUGIN_WEBVIEW_PARTITION_PREFIX,
  type LoadedPlugin,
  type PluginDisposable,
  type PluginInfo,
  type PluginManifest,
} from '@craft-agent/shared/plugins'
import { BUILTIN_PLUGIN_MANIFESTS } from '../plugins/manifests'
import { MAIN_PLUGIN_ENTRIES } from '../plugins/main-entries'

/** Context handed to a plugin's main-process entry (requires `ipc` permission) */
export interface PluginMainContext {
  manifest: PluginManifest
  log: (message: string) => void
  /**
   * Register a handler reachable from the plugin's renderer side via
   * `ctx.invoke(channel, args)`. Channels are namespaced per plugin.
   */
  handle(channel: string, handler: (args: unknown) => unknown | Promise<unknown>): PluginDisposable
}

type PluginIpcHandler = (args: unknown) => unknown | Promise<unknown>

let registry: PluginRegistry | null = null
let webviewEnabledAtStartup = false
const pluginIpcHandlers = new Map<string, PluginIpcHandler>()

function ipcHandlerKey(pluginId: string, channel: string): string {
  return `${pluginId}:${channel}`
}

/** Resolve a webview partition back to its owning plugin id, or null */
function partitionToPluginId(partition: string | undefined): string | null {
  if (!partition || !partition.startsWith(PLUGIN_WEBVIEW_PARTITION_PREFIX)) return null
  return partition.slice(PLUGIN_WEBVIEW_PARTITION_PREFIX.length) || null
}

function isAllowedWebviewUrl(src: string | undefined): boolean {
  if (!src) return true // empty src is fine; navigation is still partition-gated
  if (src === 'about:blank') return true
  try {
    const parsed = new URL(src)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:'
  } catch {
    return false
  }
}

/** Is the partition owned by a currently-enabled plugin with ui.webview? */
function isAuthorizedWebviewPartition(partition: string | undefined): boolean {
  const pluginId = partitionToPluginId(partition)
  if (!pluginId || !registry) return false
  const entry = registry.get(pluginId)
  return !!entry && entry.enabled && manifestHasPermission(entry.manifest, 'ui.webview')
}

/** Main-side activation: wire IPC entries and lock down webview partitions */
function activatePlugin(plugin: LoadedPlugin): PluginDisposable[] {
  const disposables: PluginDisposable[] = []
  const { manifest } = plugin

  if (manifestHasPermission(manifest, 'ui.webview')) {
    // Deny-by-default permissions (camera, mic, geolocation, …) for any web
    // content this plugin embeds.
    const partition = getPluginWebviewPartition(manifest.id)
    const ses = session.fromPartition(partition)
    ses.setPermissionRequestHandler((_wc, permission, callback) => {
      mainLog.info(`[plugins] denied permission '${permission}' for plugin '${manifest.id}'`)
      callback(false)
    })
    disposables.push({
      dispose: () => ses.setPermissionRequestHandler(null),
    })
  }

  if (manifestHasPermission(manifest, 'ipc')) {
    const entry = MAIN_PLUGIN_ENTRIES[manifest.id]
    if (entry) {
      const ctx: PluginMainContext = {
        manifest,
        log: (message) => mainLog.info(`[plugin:${manifest.id}] ${message}`),
        handle: (channel, handler) => {
          const key = ipcHandlerKey(manifest.id, channel)
          if (pluginIpcHandlers.has(key)) {
            throw new Error(`Plugin '${manifest.id}' already registered channel '${channel}'`)
          }
          pluginIpcHandlers.set(key, handler)
          return { dispose: () => pluginIpcHandlers.delete(key) }
        },
      }
      const result = entry(ctx)
      if (result) {
        disposables.push(...(Array.isArray(result) ? result : [result]))
      }
    }
  }

  return disposables
}

function broadcastPluginsChanged(): void {
  if (!registry) return
  const info = registry.listInfo()
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send('__plugins:changed', info)
    }
  }
}

/**
 * Whether app windows should be created with `webviewTag: true`.
 * Computed from registry state; `initializePluginHost()` runs before the first
 * window is created so startup state is always consistent.
 */
export function isPluginWebviewEnabled(): boolean {
  if (!registry) return false
  return registry
    .list()
    .some((entry) => entry.enabled && manifestHasPermission(entry.manifest, 'ui.webview'))
}

/**
 * Initialize the plugin host. Call once at app startup, before the first
 * window is created (window webPreferences depend on isPluginWebviewEnabled).
 */
export async function initializePluginHost(): Promise<void> {
  if (registry) return

  registry = new PluginRegistry({
    activate: activatePlugin,
    onDidChange: broadcastPluginsChanged,
  })

  const config = loadPluginsConfig()

  // Built-ins first — an external plugin can never shadow a built-in id.
  for (const manifest of BUILTIN_PLUGIN_MANIFESTS) {
    const plugin: LoadedPlugin = { manifest, source: 'builtin' }
    registry.register(plugin, isPluginEnabled(manifest, config, 'builtin'))
  }
  for (const plugin of loadExternalPlugins()) {
    registry.register(plugin, isPluginEnabled(plugin.manifest, config, 'user'))
  }

  await registry.activateEnabled()
  webviewEnabledAtStartup = isPluginWebviewEnabled()

  const counts = registry.list()
  mainLog.info(
    `[plugins] host initialized: ${counts.length} plugin(s), ` +
    `${counts.filter((p) => p.enabled).length} enabled, webview=${webviewEnabledAtStartup}`,
  )

  registerPluginIpc()
  installWebviewHardening()
}

function registerPluginIpc(): void {
  ipcMain.handle('__plugins:list', (): PluginInfo[] => {
    return registry?.listInfo() ?? []
  })

  ipcMain.handle(
    '__plugins:setEnabled',
    async (_event, id: unknown, enabled: unknown): Promise<{ ok: boolean; requiresRelaunch: boolean }> => {
      if (!registry || typeof id !== 'string' || typeof enabled !== 'boolean') {
        return { ok: false, requiresRelaunch: false }
      }
      const entry = registry.get(id)
      if (!entry) return { ok: false, requiresRelaunch: false }

      setPluginEnabled(id, enabled)
      await registry.setEnabled(id, enabled)
      broadcastPluginsChanged()

      // webviewTag is fixed per BrowserWindow at creation — if the effective
      // flag drifted from what windows were created with, a relaunch is needed
      // for webview panes to (dis)appear.
      const requiresRelaunch =
        manifestHasPermission(entry.manifest, 'ui.webview') &&
        isPluginWebviewEnabled() !== webviewEnabledAtStartup
      return { ok: true, requiresRelaunch }
    },
  )

  ipcMain.handle('__plugins:invoke', async (_event, pluginId: unknown, channel: unknown, args: unknown) => {
    if (!registry || typeof pluginId !== 'string' || typeof channel !== 'string') {
      throw new Error('Invalid plugin invoke request')
    }
    const entry = registry.get(pluginId)
    if (!entry || !entry.enabled) {
      throw new Error(`Plugin not available: ${pluginId}`)
    }
    if (!manifestHasPermission(entry.manifest, 'ipc')) {
      throw new Error(`Plugin '${pluginId}' does not declare the 'ipc' permission`)
    }
    const handler = pluginIpcHandlers.get(ipcHandlerKey(pluginId, channel))
    if (!handler) {
      throw new Error(`Plugin '${pluginId}' has no handler for channel '${channel}'`)
    }
    return handler(args)
  })
}

/**
 * Enforce the plugin webview policy on every webview attach, app-wide.
 * Defense in depth: even with webviewTag enabled on a window, an attach only
 * succeeds for an authorized plugin partition, with safe webPreferences.
 */
function installWebviewHardening(): void {
  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-attach-webview', (event, webPreferences, params) => {
      const partition = typeof params.partition === 'string' ? params.partition : undefined

      if (!isAuthorizedWebviewPartition(partition)) {
        mainLog.warn(`[plugins] blocked webview attach for partition '${partition ?? '(none)'}'`)
        event.preventDefault()
        return
      }
      if (!isAllowedWebviewUrl(typeof params.src === 'string' ? params.src : undefined)) {
        mainLog.warn(`[plugins] blocked webview src '${params.src}'`)
        event.preventDefault()
        return
      }

      // Force the safe configuration regardless of what the tag requested.
      delete webPreferences.preload
      webPreferences.nodeIntegration = false
      webPreferences.nodeIntegrationInSubFrames = false
      webPreferences.contextIsolation = true
      webPreferences.sandbox = true
      webPreferences.webSecurity = true
      webPreferences.allowRunningInsecureContent = false
      webPreferences.experimentalFeatures = false
    })

    contents.on('did-attach-webview', (_e, webviewContents) => {
      // Partition + webPreferences were validated in will-attach-webview.
      // Popups never become windows; safe links open in the OS browser.
      webviewContents.setWindowOpenHandler((details) => {
        try {
          const parsed = new URL(details.url)
          if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
            void shell.openExternal(details.url)
          }
        } catch {
          // unparseable URL — drop it
        }
        return { action: 'deny' }
      })
    })
  })
}

/** Tear down all active plugins (app shutdown) */
export function disposePluginHost(): void {
  registry?.disposeAll()
}
