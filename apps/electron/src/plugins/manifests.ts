/**
 * Built-in plugin manifests
 *
 * Single registration point for plugins that ship with the app. Imported by
 * BOTH the main process (registry, webview policy) and the renderer (runtime
 * activation), so only manifest data may be imported here — renderer entry
 * components are mapped separately in renderer-entries.ts.
 *
 * To add a built-in plugin:
 * 1. Create apps/electron/src/plugins/{id}/ with manifest.ts (+ renderer.tsx / main.ts)
 * 2. Add the manifest to BUILTIN_PLUGIN_MANIFESTS below
 * 3. Add its entry module(s) to renderer-entries.ts and/or main-entries.ts
 */

import type { PluginManifest } from '@craft-agent/shared/plugins/types'
import { FOCUS_TIMER_PLUGIN_MANIFEST } from './focus-timer/manifest'

export const BUILTIN_PLUGIN_MANIFESTS: PluginManifest[] = [
  FOCUS_TIMER_PLUGIN_MANIFEST,
]
