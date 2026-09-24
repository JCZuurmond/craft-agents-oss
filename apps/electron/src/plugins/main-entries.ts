/**
 * Built-in plugin main-process entries
 *
 * Maps plugin id → main-process activate function for built-in plugins that
 * declare the `ipc` permission. Imported ONLY by src/main/plugin-host.ts.
 *
 * Renderer-only plugins never appear here; the map exists so an `ipc` plugin
 * is a one-line registration.
 */

import type { PluginDisposable } from '@craft-agent/shared/plugins/types'
import type { PluginMainContext } from '../main/plugin-host'

export type PluginMainEntry = (
  ctx: PluginMainContext,
) => PluginDisposable | PluginDisposable[] | void

export const MAIN_PLUGIN_ENTRIES: Record<string, PluginMainEntry> = {}
