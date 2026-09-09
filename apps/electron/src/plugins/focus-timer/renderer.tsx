/**
 * Focus Timer plugin — renderer entry
 *
 * Contributes a slim top-edge panel plus two declared commands. The reference
 * consumer for `contributes.commands`: the manifest declares the command ids
 * and the 'mod+shift+f' keybinding, the host binds them from data alone, and
 * activation only supplies the handlers here — executing either command
 * before activation lazy-activates the plugin first (onCommand events).
 */

import type { PluginContext } from '../../renderer/plugins/types'
import { createTimerPanel } from './TimerPanel'
import { createFocusTimerStore } from './timer-store'
import {
  FOCUS_TIMER_PANEL_ID,
  FOCUS_TIMER_RESET_COMMAND_ID,
  FOCUS_TIMER_TOGGLE_COMMAND_ID,
} from './manifest'

export function activate(ctx: PluginContext): void {
  const store = createFocusTimerStore(ctx.storage)

  ctx.ui.registerSidePanel({
    id: FOCUS_TIMER_PANEL_ID,
    title: ctx.manifest.name,
    icon: ctx.manifest.icon,
    // The declared panel's manifest entry is the source of truth for the
    // edge; carrying it here keeps the eager (undeclared) path equivalent.
    location: 'top',
    component: createTimerPanel(store),
  })

  ctx.commands.register(FOCUS_TIMER_TOGGLE_COMMAND_ID, () => {
    // Surface the timer when driven from the keybinding, then flip it.
    ctx.ui.openSidePanel(FOCUS_TIMER_PANEL_ID)
    store.toggle()
    return store.getState().phase
  })

  ctx.commands.register(FOCUS_TIMER_RESET_COMMAND_ID, () => {
    store.reset()
    return store.getState().phase
  })

  ctx.logger.info('focus timer panel and commands registered')
}
