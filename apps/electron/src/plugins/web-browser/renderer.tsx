/**
 * Browser Pane plugin — renderer entry
 *
 * The reference consumer of the plugin framework: contributes one right-hand
 * side pane containing a sandboxed web browser. Uses only the PluginContext
 * surface — no core imports beyond the public plugin API types.
 */

import type { PluginContext } from '../../renderer/plugins/types'
import { createBrowserPanel } from './BrowserPanel'
import { WEB_BROWSER_PANEL_ID } from './manifest'

export { WEB_BROWSER_PANEL_ID as BROWSER_PANEL_ID }

export function activate(ctx: PluginContext): void {
  ctx.ui.registerSidePanel({
    id: WEB_BROWSER_PANEL_ID,
    title: ctx.manifest.name,
    icon: ctx.manifest.icon,
    component: createBrowserPanel(ctx),
  })
  ctx.logger.info('browser side panel registered')
}
