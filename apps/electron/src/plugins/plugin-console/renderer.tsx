/**
 * Plugin Console plugin — renderer entry
 *
 * Contributes a bottom-edge panel that logs every plugin-framework host hook.
 * The reference consumer for `ctx.hooks` and `onStartup` activation: the
 * subscription starts with the runtime (so the app:ready wave is captured),
 * the panel just renders the buffer whenever it is opened. Listeners observe
 * only — a throwing listener never affects other plugins or the host.
 */

import type { PluginContext } from '../../renderer/plugins/types'
import { createConsolePanel } from './ConsolePanel'
import { OBSERVED_HOOKS, createPluginConsoleStore } from './console-store'
import { PLUGIN_CONSOLE_PANEL_ID } from './manifest'

export function activate(ctx: PluginContext): void {
  const store = createPluginConsoleStore()

  for (const hook of OBSERVED_HOOKS) {
    ctx.hooks.on(hook, (payload) => store.append(hook, payload))
  }

  ctx.ui.registerSidePanel({
    id: PLUGIN_CONSOLE_PANEL_ID,
    title: ctx.manifest.name,
    icon: ctx.manifest.icon,
    // The declared panel's manifest entry is the source of truth for the
    // edge; carrying it here keeps the eager (undeclared) path equivalent.
    location: 'bottom',
    component: createConsolePanel(store),
  })

  ctx.logger.info('plugin console registered; observing framework hooks')
}
