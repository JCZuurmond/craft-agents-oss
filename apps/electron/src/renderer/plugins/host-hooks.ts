/**
 * Plugin Host Hooks
 *
 * The renderer host's named-hook vocabulary — the Emacs `add-hook` pattern
 * (and the shape of Vim autocommands): the host runs every listener added to
 * a hook when the corresponding framework event happens. Listeners observe;
 * they cannot veto or reorder host behavior, and each listener is
 * error-isolated (see PluginHookRegistry).
 *
 * v1 hooks cover plugin-framework lifecycle only. Agent/session events are
 * deliberately NOT hooks — they stay reserved behind the documented
 * `events.read` permission (docs/plugins/DESIGN.md).
 */

import { PluginHookRegistry } from '@craft-agent/shared/plugins/hooks'
import type { PluginPanelLocation } from '@craft-agent/shared/plugins/types'

export interface PluginHostHookMap {
  /** The plugin runtime finished initializing for this window */
  'app:ready': { pluginIds: string[] }
  /** A plugin's renderer entry ran successfully */
  'plugin:activated': { pluginId: string }
  /** A plugin was deactivated and its registrations disposed */
  'plugin:deactivated': { pluginId: string }
  /** A plugin panel became the open panel on its edge */
  'panel:opened': { pluginId: string; panelId: string; location: PluginPanelLocation }
  /** An edge's plugin pane was closed */
  'panel:closed': { pluginId: string; panelId: string; location: PluginPanelLocation }
  /** A plugin command was executed (keybinding or ctx.commands.execute) */
  'command:executed': { pluginId: string; commandId: string }
}

export type PluginHostHook = keyof PluginHostHookMap

/** Singleton hook registry for this window's plugin host */
export const pluginHostHooks = new PluginHookRegistry<PluginHostHookMap>()

pluginHostHooks.onListenerError = (hook, error) => {
  console.warn(`[plugins] hook '${hook}' listener failed:`, error)
}
