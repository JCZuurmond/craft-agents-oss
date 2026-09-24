/**
 * Plugin Console plugin — manifest
 *
 * Data-only module: imported by both the main process (registry) and the
 * renderer (activation). Keep it free of React/Electron imports.
 */

import type { PluginManifest } from '@craft-agent/shared/plugins/types'

export const PLUGIN_CONSOLE_PANEL_ID = 'console'

export const PLUGIN_CONSOLE_PLUGIN_MANIFEST: PluginManifest = {
  id: 'plugin-console',
  name: 'Plugin Console',
  version: '0.1.0',
  description: 'A live console of plugin-framework events (activations, panels, commands) in a bottom panel.',
  icon: '📟',
  apiVersion: 1,
  permissions: ['ui.sidePanel'],
  contributes: {
    sidePanels: [
      { id: PLUGIN_CONSOLE_PANEL_ID, title: 'Plugin Console', icon: '📟', location: 'bottom' },
    ],
  },
  // Eager activation: hooks only observe events emitted after subscription,
  // so the console activates with the runtime to capture the app:ready wave —
  // the onStartup path no other reference plugin exercises.
  activationEvents: ['onStartup'],
  entries: { renderer: 'renderer.tsx' },
  // Off by default: reference plugins keep the framework's zero-footprint
  // default posture; users opt in via Settings → Plugins.
  defaultEnabled: false,
}
