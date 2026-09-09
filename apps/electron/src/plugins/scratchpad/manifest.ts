/**
 * Scratchpad plugin — manifest
 *
 * Data-only module: imported by both the main process (registry) and the
 * renderer (activation). Keep it free of React/Electron imports.
 */

import type { PluginManifest } from '@craft-agent/shared/plugins/types'

export const SCRATCHPAD_PANEL_ID = 'notes'

export const SCRATCHPAD_PLUGIN_MANIFEST: PluginManifest = {
  id: 'scratchpad',
  name: 'Scratchpad',
  version: '0.1.0',
  description: 'Quick notes in a left-hand side pane — autosaved to plugin-scoped storage.',
  icon: '📝',
  apiVersion: 1,
  permissions: ['ui.sidePanel', 'storage'],
  contributes: {
    sidePanels: [
      { id: SCRATCHPAD_PANEL_ID, title: 'Scratchpad', icon: '📝', location: 'left' },
    ],
  },
  activationEvents: [`onPanel:${SCRATCHPAD_PANEL_ID}`],
  entries: { renderer: 'renderer.tsx' },
  // Off by default: reference plugins keep the framework's zero-footprint
  // default posture; users opt in via Settings → Plugins.
  defaultEnabled: false,
}
