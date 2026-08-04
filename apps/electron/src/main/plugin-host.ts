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

import { pathToFileURL } from 'url'
import { app, ipcMain, session, shell, BrowserWindow } from 'electron'
import { mainLog } from './logger'
import {
  PluginRegistry,
  loadExternalPluginsDetailed,
  resolvePluginEntryFile,
  loadPluginsConfig,
  isPluginEnabled,
  setPluginEnabled,
  manifestHasPermission,
  getPluginWebviewPartition,
  checkPluginApiCompatibility,
  PLUGIN_WEBVIEW_PARTITION_PREFIX,
  type InvalidExternalPlugin,
  type LoadedPlugin,
  type PluginDisposable,
  type PluginEntryPaths,
  type PluginInfo,
  type PluginManifest,
} from '@craft-agent/shared/plugins/node'
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

/**
 * External plugin directories that failed to load (bad/missing/mismatched
 * manifest). Surfaced in Settings as errored rows with their reasons so an
 * author sees *why* their plugin didn't appear, instead of it vanishing.
 */
let invalidExternalPlugins: InvalidExternalPlugin[] = []

/** Absolute entry-file paths for valid external plugins, keyed by plugin id */
const externalEntryPaths = new Map<string, PluginEntryPaths>()

/**
 * Load an external plugin's main-process entry module from disk. Split out so
 * tests can stub it; the default dynamically imports the resolved file. A
 * plugin's code runs in the main process only for `source: 'user'` plugins
 * that declare `ipc` — this is trusted-installer territory (see SECURITY.md).
 */
let externalMainModuleLoader = async (absPath: string): Promise<{ activate?: ResolvedMainEntry }> => {
  return (await import(pathToFileURL(absPath).href)) as { activate?: ResolvedMainEntry }
}

/** Test seam: override how external main modules are loaded */
export function setExternalMainModuleLoader(
  loader: (absPath: string) => Promise<{ activate?: ResolvedMainEntry }>,
): void {
  externalMainModuleLoader = loader
}

type ResolvedMainEntry = (
  ctx: PluginMainContext,
) => PluginDisposable | PluginDisposable[] | void | Promise<PluginDisposable | PluginDisposable[] | void>

/**
 * Renderer-side failures reported per window (webContents id → plugin id →
 * error). The renderer runtime activates plugins in its own registry; without
 * this report channel a plugin that only breaks in the renderer would look
 * healthy in Settings. Merged into the plugin info snapshots below.
 */
const rendererErrorsByWindow = new Map<number, Map<string, string>>()

function ipcHandlerKey(pluginId: string, channel: string): string {
  return `${pluginId}:${channel}`
}

/**
 * Only the app's own window renderers may drive the plugin IPC surface.
 * Plugin <webview> guests are sandboxed without a preload so they cannot
 * reach ipcRenderer at all — this guard is defense in depth for the case
 * where any embedded content ever gains an IPC path.
 */
function isTrustedPluginIpcSender(event: Electron.IpcMainInvokeEvent): boolean {
  return event.sender.getType() === 'window'
}

/** Renderer-reported error for a plugin from any window, if one exists */
function rendererErrorFor(pluginId: string): string | undefined {
  for (const errors of rendererErrorsByWindow.values()) {
    const error = errors.get(pluginId)
    if (error) return error
  }
  return undefined
}

/**
 * A synthetic PluginInfo for an external directory that wouldn't load. The
 * reason rides on `incompatibility` (like an unsupported apiVersion) so the
 * Settings UI lists it with the reason and a permanently-disabled toggle —
 * an invalid manifest is, like an incompatible one, something the host can
 * never activate.
 */
function invalidPluginInfo(invalid: InvalidExternalPlugin): PluginInfo {
  return {
    id: invalid.id,
    name: invalid.id,
    version: '0.0.0',
    permissions: [],
    source: 'user',
    enabled: false,
    status: 'error',
    incompatibility: `Invalid plugin: ${invalid.errors.join('; ')}`,
    external: true,
  }
}

/**
 * Registry snapshot with per-window renderer failures merged in, external
 * entry paths attached (so the renderer can load their code), and invalid
 * external directories appended as errored rows.
 */
function currentPluginInfo(): PluginInfo[] {
  const info = registry?.listInfo() ?? []
  const merged = info.map((plugin) => {
    const entryPaths = externalEntryPaths.get(plugin.id)
    const withEntry = entryPaths ? { ...plugin, entryPaths } : plugin
    if (withEntry.status === 'error') return withEntry
    const rendererError = rendererErrorFor(plugin.id)
    return rendererError ? { ...withEntry, status: 'error' as const, error: rendererError } : withEntry
  })
  // Append invalid external dirs that never made it into the registry, unless
  // a valid plugin already claimed that id (built-ins win).
  const known = new Set(merged.map((p) => p.id))
  for (const invalid of invalidExternalPlugins) {
    if (!known.has(invalid.id)) merged.push(invalidPluginInfo(invalid))
  }
  return merged
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

/**
 * Subframes inside a plugin webview may use the schemes ordinary web pages
 * embed (data:/blob: iframes, about:srcdoc) — blocking those breaks normal
 * sites, and the guest sandbox + webSecurity already contain them. Privileged
 * schemes (file:, chrome:, devtools:, custom app protocols) stay blocked.
 */
const ALLOWED_WEBVIEW_SUBFRAME_PROTOCOLS = new Set(['https:', 'http:', 'data:', 'blob:', 'about:'])

function isAllowedWebviewSubframeUrl(src: string): boolean {
  try {
    return ALLOWED_WEBVIEW_SUBFRAME_PROTOCOLS.has(new URL(src).protocol)
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

/** Roll back every disposable collected so far (reverse order), swallowing errors */
function rollback(disposables: PluginDisposable[]): void {
  for (const d of disposables.reverse()) {
    try {
      d.dispose()
    } catch {
      // best-effort teardown
    }
  }
}

/**
 * Resolve a plugin's main-process entry: compiled-in for built-ins, loaded
 * from disk for external plugins that declare a `main` entry file.
 */
async function resolveMainEntry(plugin: LoadedPlugin): Promise<ResolvedMainEntry | null> {
  const builtin = MAIN_PLUGIN_ENTRIES[plugin.manifest.id]
  if (builtin) return builtin
  const abs = resolvePluginEntryFile(plugin, 'main')
  if (!abs) return null
  const mod = await externalMainModuleLoader(abs)
  if (typeof mod.activate !== 'function') {
    throw new Error(`main entry '${abs}' does not export an activate() function`)
  }
  return mod.activate
}

/** Main-side activation: wire IPC entries and lock down webview partitions */
async function activatePlugin(plugin: LoadedPlugin): Promise<PluginDisposable[]> {
  const disposables: PluginDisposable[] = []
  const { manifest } = plugin

  try {
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
      const entry = await resolveMainEntry(plugin)
      if (entry) {
        const ctx: PluginMainContext = {
          manifest,
          log: (message) => mainLog.info(`[plugin:${manifest.id}] ${message}`),
          // Auto-track every handler so a throw mid-activation rolls them back
          // (a leaked handler would otherwise stay callable on an errored plugin).
          handle: (channel, handler) => {
            const key = ipcHandlerKey(manifest.id, channel)
            if (pluginIpcHandlers.has(key)) {
              throw new Error(`Plugin '${manifest.id}' already registered channel '${channel}'`)
            }
            pluginIpcHandlers.set(key, handler)
            const disposable: PluginDisposable = { dispose: () => pluginIpcHandlers.delete(key) }
            disposables.push(disposable)
            return disposable
          },
        }
        const result = await entry(ctx)
        if (result) {
          disposables.push(...(Array.isArray(result) ? result : [result]))
        }
      }
    }
  } catch (error) {
    // Partial registrations must not survive a failed activation.
    rollback(disposables)
    throw error
  }

  return disposables
}

function broadcastPluginsChanged(): void {
  if (!registry) return
  const info = currentPluginInfo()
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
  // Plugins targeting an unsupported apiVersion register as permanently
  // errored: listed in Settings with the reason, never activated.
  for (const manifest of BUILTIN_PLUGIN_MANIFESTS) {
    const plugin: LoadedPlugin = { manifest, source: 'builtin' }
    const incompatibility = checkPluginApiCompatibility(manifest) ?? undefined
    registry.register(plugin, isPluginEnabled(manifest, config, 'builtin'), { incompatibility })
  }
  const discovery = loadExternalPluginsDetailed()
  invalidExternalPlugins = discovery.invalid
  externalEntryPaths.clear()
  for (const plugin of discovery.plugins) {
    const incompatibility = checkPluginApiCompatibility(plugin.manifest) ?? undefined
    registry.register(plugin, isPluginEnabled(plugin.manifest, config, 'user'), { incompatibility })
    // Resolve the plugin's entry files once so the renderer can load its code
    // (and the main entry loader can find it) without re-touching the manifest.
    const renderer = resolvePluginEntryFile(plugin, 'renderer') ?? undefined
    const main = resolvePluginEntryFile(plugin, 'main') ?? undefined
    if (renderer || main) externalEntryPaths.set(plugin.manifest.id, { renderer, main })
  }
  if (discovery.invalid.length > 0) {
    mainLog.warn(
      `[plugins] ${discovery.invalid.length} external plugin(s) failed to load: ` +
      discovery.invalid.map((i) => `${i.id} (${i.errors[0] ?? 'invalid'})`).join(', '),
    )
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
  ipcMain.handle('__plugins:list', (event): PluginInfo[] => {
    if (!isTrustedPluginIpcSender(event)) return []
    return currentPluginInfo()
  })

  ipcMain.handle(
    '__plugins:setEnabled',
    async (event, id: unknown, enabled: unknown): Promise<{ ok: boolean; requiresRelaunch: boolean }> => {
      if (!isTrustedPluginIpcSender(event)) {
        return { ok: false, requiresRelaunch: false }
      }
      if (!registry || typeof id !== 'string' || typeof enabled !== 'boolean') {
        return { ok: false, requiresRelaunch: false }
      }
      const entry = registry.get(id)
      if (!entry) return { ok: false, requiresRelaunch: false }
      // Incompatible plugins can never be enabled; don't persist a state the
      // registry will refuse anyway.
      if (entry.incompatibility && enabled) return { ok: false, requiresRelaunch: false }

      setPluginEnabled(id, enabled)
      await registry.setEnabled(id, enabled)
      broadcastPluginsChanged()

      // webviewTag is fixed per BrowserWindow at creation — if the effective
      // flag drifted from what windows were created with, a relaunch is needed
      // for webview panels to (dis)appear.
      const requiresRelaunch =
        manifestHasPermission(entry.manifest, 'ui.webview') &&
        isPluginWebviewEnabled() !== webviewEnabledAtStartup
      return { ok: true, requiresRelaunch }
    },
  )

  ipcMain.handle('__plugins:invoke', async (event, pluginId: unknown, channel: unknown, args: unknown) => {
    if (!isTrustedPluginIpcSender(event)) {
      throw new Error('Plugin invoke rejected: untrusted sender')
    }
    if (!registry || typeof pluginId !== 'string' || typeof channel !== 'string') {
      throw new Error('Invalid plugin invoke request')
    }
    const entry = registry.get(pluginId)
    // Require an *active* runtime, not merely enabled — a plugin that errored
    // during activation must not expose any handler that leaked before the throw.
    if (!entry || !entry.enabled || entry.status !== 'active') {
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

  // Renderer runtimes report per-window activation/render failures here so
  // Settings reflects renderer-side status too (error = null clears).
  ipcMain.handle('__plugins:reportRendererStatus', (event, pluginId: unknown, error: unknown) => {
    if (!isTrustedPluginIpcSender(event)) return
    if (!registry || typeof pluginId !== 'string') return
    if (error !== null && typeof error !== 'string') return
    if (!registry.get(pluginId)) return

    const windowId = event.sender.id
    let errors = rendererErrorsByWindow.get(windowId)
    if (!errors) {
      errors = new Map()
      rendererErrorsByWindow.set(windowId, errors)
      event.sender.once('destroyed', () => {
        rendererErrorsByWindow.delete(windowId)
        broadcastPluginsChanged()
      })
    }

    const previous = errors.get(pluginId)
    if (error === null) {
      errors.delete(pluginId)
    } else {
      errors.set(pluginId, error)
      mainLog.warn(`[plugins] renderer error for '${pluginId}' (window ${windowId}): ${error}`)
    }
    if (previous !== (error ?? undefined)) broadcastPluginsChanged()
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

      // Continuous navigation policy: the attach-time src check alone would
      // let an allowed page later wander to file:, javascript:, or a
      // privileged app scheme. Main-frame navigations keep the strict
      // http(s)/about:blank allowlist; subframes additionally allow the
      // schemes ordinary pages embed (see isAllowedWebviewSubframeUrl).
      const isAllowedNavigation = (url: string, isMainFrame: boolean) =>
        isMainFrame ? isAllowedWebviewUrl(url) : isAllowedWebviewSubframeUrl(url)
      const blockDisallowed = (
        event: { preventDefault(): void },
        url: string,
        isMainFrame: boolean,
        kind: string,
      ) => {
        if (isAllowedNavigation(url, isMainFrame)) return
        mainLog.warn(`[plugins] blocked webview ${kind} to '${url}'`)
        event.preventDefault()
      }
      webviewContents.on('will-navigate', (event, url) => blockDisallowed(event, url, true, 'navigation'))
      webviewContents.on('will-frame-navigate', (event) =>
        blockDisallowed(event, event.url, event.isMainFrame, 'frame navigation'))
      webviewContents.on('will-redirect', (event) =>
        blockDisallowed(event, event.url, event.isMainFrame, 'redirect'))

      // Embedder-initiated main-frame loads (<webview>.src / loadURL) do not
      // fire will-navigate; bounce anything disallowed as soon as it starts.
      // Subframes are left to the preventive guards above — stop() is
      // contents-wide and would abort the whole page for one bad iframe.
      webviewContents.on('did-start-navigation', (event) => {
        if (!event.isMainFrame || event.isSameDocument || isAllowedWebviewUrl(event.url)) return
        mainLog.warn(`[plugins] aborted webview load of '${event.url}'`)
        webviewContents.stop()
        void webviewContents.loadURL('about:blank')
      })
    })
  })
}

/** Tear down all active plugins (app shutdown) */
export function disposePluginHost(): void {
  registry?.disposeAll()
}
