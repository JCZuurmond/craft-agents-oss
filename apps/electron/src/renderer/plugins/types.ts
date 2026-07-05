/**
 * Renderer Plugin API
 *
 * The typed surface handed to a plugin's renderer entry. Capabilities are
 * permission-gated: accessing a surface whose permission the manifest does not
 * declare throws at call time (fail fast, visible in the plugin's status).
 */

import type { ComponentType } from 'react'
import type { PluginDisposable, PluginManifest, PluginPanelLocation } from '@craft-agent/shared/plugins/types'
import type { PluginCommandHandler } from '@craft-agent/shared/plugins/commands'
import type { PluginHostHook, PluginHostHookMap } from './host-hooks'

/** Props passed to a contributed side-panel component */
export interface PluginPanelProps {
  /** True while this panel is the visible one in the plugin pane */
  isActive: boolean
}

/**
 * A side panel contributed to a plugin pane host (left or right shell edge).
 *
 * Panels declared in the manifest's `contributes.sidePanels` block are the
 * source of truth for title/icon/location — registering the same panel id
 * from code supplies the component and ignores the other fields. Panels
 * registered without a declaration are complete definitions (eager path).
 */
export interface PluginSidePanelContribution {
  /** Panel id, unique within the plugin */
  id: string
  /** Title shown in the pane header and toggle-rail tooltip */
  title: string
  /** Emoji shown in the toggle rail (falls back to the manifest icon) */
  icon?: string
  /** Which shell edge hosts the panel (default 'right') */
  location?: PluginPanelLocation
  /** Panel body. Mounted while the pane is open and this panel is active. */
  component: ComponentType<PluginPanelProps>
}

/** Prefixed console logging for a plugin */
export interface PluginLogger {
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
}

/** Persistent key-value storage scoped to the plugin (requires 'storage') */
export interface PluginStorage {
  get<T>(key: string, fallback: T): T
  set<T>(key: string, value: T): void
  remove(key: string): void
}

/** UI contributions (requires 'ui.sidePanel') */
export interface PluginUi {
  /** Register a side pane. Disposed automatically on deactivate. */
  registerSidePanel(contribution: PluginSidePanelContribution): PluginDisposable
  /** Open the plugin pane and focus the given panel */
  openSidePanel(panelId: string): void
  /** Close the plugin pane if the given panel is active */
  closeSidePanel(panelId: string): void
}

/**
 * Command contributions (requires 'commands') — the universal editor
 * primitive (VS Code commands / Emacs M-x / Vim ex commands). Commands
 * declared in `contributes.commands` get introspection, optional
 * keybindings, and lazy activation; `register()` supplies their handlers at
 * activation time (registering undeclared, code-only command ids also works,
 * but they get no keybinding and no lazy activation).
 */
export interface PluginCommands {
  /** Register a handler for one of this plugin's command ids. Auto-disposed. */
  register(commandId: string, handler: PluginCommandHandler): PluginDisposable
  /**
   * Execute any registered plugin command by qualified id
   * (`{pluginId}.{commandId}`), the cross-plugin dispatch path.
   */
  execute(qualifiedId: string, args?: unknown): Promise<unknown>
}

/**
 * Named host hooks (the Emacs `add-hook` pattern). Listeners observe
 * plugin-framework lifecycle events; they cannot veto host behavior, and a
 * throwing listener never affects other plugins or the host. Subscriptions
 * are auto-disposed on deactivate.
 */
export interface PluginHooks {
  on<K extends PluginHostHook>(hook: K, listener: (payload: PluginHostHookMap[K]) => void): PluginDisposable
}

/** Context handed to a plugin's renderer `activate()` */
export interface PluginContext {
  manifest: PluginManifest
  logger: PluginLogger
  /** Scoped storage (requires 'storage') */
  storage: PluginStorage
  /** UI contributions (requires 'ui.sidePanel') */
  ui: PluginUi
  /** Command registration and dispatch (requires 'commands') */
  commands: PluginCommands
  /** Named host hooks — framework lifecycle observation (no permission) */
  hooks: PluginHooks
  /** Invoke a main-process handler registered by this plugin (requires 'ipc') */
  invoke(channel: string, args?: unknown): Promise<unknown>
  /**
   * Session partition for <webview> tags this plugin renders
   * (requires 'ui.webview'). The main process rejects any other partition.
   */
  readonly webviewPartition: string
}

/** A plugin's renderer entry point */
export type PluginRendererEntry = (
  ctx: PluginContext,
) => PluginDisposable | PluginDisposable[] | void
