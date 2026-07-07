/**
 * Built-in plugin renderer entries
 *
 * Maps plugin id → renderer activate function. Imported ONLY by the renderer
 * plugin runtime (src/renderer/plugins/runtime.ts) — never from main, which
 * must stay free of React imports.
 */

import type { PluginRendererEntry } from '../renderer/plugins/types'
import { activate as activatePluginConsole } from './plugin-console/renderer'

export const RENDERER_PLUGIN_ENTRIES: Record<string, PluginRendererEntry> = {
  'plugin-console': activatePluginConsole,
}
