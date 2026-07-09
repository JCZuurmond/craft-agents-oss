/**
 * Scratchpad plugin — renderer entry
 *
 * Contributes one left-hand side pane holding an autosaving plain-text note.
 * The reference consumer for `ctx.storage`: every keystroke persists through
 * the plugin's scoped namespace and survives close/reopen, disable/enable,
 * and app restarts. Uses only the PluginContext surface.
 */

import type { PluginContext } from '../../renderer/plugins/types'
import { createScratchpadPanel } from './ScratchpadPanel'
import { SCRATCHPAD_PANEL_ID } from './manifest'

export function activate(ctx: PluginContext): void {
  ctx.ui.registerSidePanel({
    id: SCRATCHPAD_PANEL_ID,
    title: ctx.manifest.name,
    icon: ctx.manifest.icon,
    // The declared panel's manifest entry is the source of truth for the
    // edge; carrying it here keeps the eager (undeclared) path equivalent.
    location: 'left',
    component: createScratchpadPanel(ctx),
  })
  ctx.logger.info('scratchpad side panel registered')
}
