/**
 * Plugin Context Factory
 *
 * Builds the permission-gated PluginContext handed to a plugin's renderer
 * entry, and tracks every registration so deactivation can dispose them all.
 */

import * as React from 'react'
import {
  manifestHasPermission,
  getPluginWebviewPartition,
  type PluginDisposable,
  type PluginManifest,
} from '@craft-agent/shared/plugins/types'
import type { PluginCommands, PluginContext, PluginHooks, PluginLogger, PluginStorage, PluginUi } from './types'
import { registerPluginPanel, panelKey, openPluginPanel, closePluginPanelDock, getPluginPanelState } from './panel-store'
import { registerPluginCommand, executePluginCommand } from './command-store'
import { pluginHostHooks } from './host-hooks'

function createLogger(pluginId: string): PluginLogger {
  const prefix = `[plugin:${pluginId}]`
  return {
    info: (message, ...args) => console.info(prefix, message, ...args),
    warn: (message, ...args) => console.warn(prefix, message, ...args),
    error: (message, ...args) => console.error(prefix, message, ...args),
  }
}

/**
 * localStorage-backed KV scoped under `craft-plugin-{id}:`. Plugins cannot
 * reach keys outside their namespace through this surface.
 */
function createStorage(pluginId: string): PluginStorage {
  const prefix = `craft-plugin-${pluginId}:`
  return {
    get<T>(key: string, fallback: T): T {
      try {
        const raw = localStorage.getItem(prefix + key)
        return raw === null ? fallback : (JSON.parse(raw) as T)
      } catch {
        return fallback
      }
    },
    set<T>(key: string, value: T): void {
      try {
        localStorage.setItem(prefix + key, JSON.stringify(value))
      } catch (error) {
        console.warn(`[plugin:${pluginId}] storage.set failed for '${key}':`, error)
      }
    },
    remove(key: string): void {
      localStorage.removeItem(prefix + key)
    },
  }
}

function deniedSurface<T extends object>(pluginId: string, permission: string, shape: T): T {
  const handler: ProxyHandler<T> = {
    get(_target, prop) {
      throw new Error(
        `Plugin '${pluginId}' tried to use '${String(prop)}' without declaring the '${permission}' permission`,
      )
    },
  }
  return new Proxy(shape, handler)
}

export interface CreatedPluginContext {
  ctx: PluginContext
  /** Disposes everything registered through the context */
  dispose(): void
}

export function createPluginContext(manifest: PluginManifest): CreatedPluginContext {
  const pluginId = manifest.id
  const disposables: PluginDisposable[] = []

  const ui: PluginUi = manifestHasPermission(manifest, 'ui.sidePanel')
    ? {
        registerSidePanel: (contribution) => {
          const unregister = registerPluginPanel(pluginId, contribution)
          const disposable: PluginDisposable = { dispose: unregister }
          disposables.push(disposable)
          return disposable
        },
        openSidePanel: (panelId) => openPluginPanel(panelKey(pluginId, panelId)),
        closeSidePanel: (panelId) => {
          const state = getPluginPanelState()
          const key = panelKey(pluginId, panelId)
          const panel = state.panels.find((p) => p.key === key)
          if (panel && state.docks[panel.location].activePanelKey === key) {
            closePluginPanelDock(panel.location)
          }
        },
      }
    : deniedSurface(pluginId, 'ui.sidePanel', {} as PluginUi)

  const storage: PluginStorage = manifestHasPermission(manifest, 'storage')
    ? createStorage(pluginId)
    : deniedSurface(pluginId, 'storage', {} as PluginStorage)

  const commands: PluginCommands = manifestHasPermission(manifest, 'commands')
    ? {
        register: (commandId, handler) => {
          const disposable = registerPluginCommand(pluginId, commandId, handler)
          disposables.push(disposable)
          return disposable
        },
        execute: (qualifiedId, args) => executePluginCommand(qualifiedId, args),
      }
    : deniedSurface(pluginId, 'commands', {} as PluginCommands)

  const hooks: PluginHooks = {
    on: (hook, listener) => {
      const disposable = pluginHostHooks.on(hook, listener)
      disposables.push(disposable)
      return disposable
    },
  }

  const ctx: PluginContext = {
    manifest,
    react: React,
    logger: createLogger(pluginId),
    storage,
    ui,
    commands,
    hooks,
    invoke: (channel, args) => {
      if (!manifestHasPermission(manifest, 'ipc')) {
        return Promise.reject(
          new Error(`Plugin '${pluginId}' tried to invoke '${channel}' without declaring the 'ipc' permission`),
        )
      }
      return window.electronAPI.plugins.invoke(pluginId, channel, args)
    },
    get webviewPartition() {
      if (!manifestHasPermission(manifest, 'ui.webview')) {
        throw new Error(`Plugin '${pluginId}' tried to use a webview without declaring the 'ui.webview' permission`)
      }
      return getPluginWebviewPartition(pluginId)
    },
  }

  return {
    ctx,
    dispose: () => {
      for (const disposable of disposables.reverse()) {
        try {
          disposable.dispose()
        } catch {
          // ignore teardown failures
        }
      }
      disposables.length = 0
    },
  }
}
