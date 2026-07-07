/**
 * Browser Pane plugin — manifest
 *
 * Data-only module: imported by both the main process (registry/policy) and
 * the renderer (activation). Keep it free of React/Electron imports.
 */

import type { PluginManifest } from '@craft-agent/shared/plugins/types'

export const WEB_BROWSER_PANEL_ID = 'browser'

export const WEB_BROWSER_PLUGIN_MANIFEST: PluginManifest = {
  id: 'web-browser',
  name: 'Browser Pane',
  version: '0.1.0',
  description: 'A web browser in a right-hand side pane: address bar, navigation, and a sandboxed render surface.',
  icon: '🌐',
  apiVersion: 1,
  permissions: ['ui.sidePanel', 'ui.webview', 'storage'],
  contributes: {
    sidePanels: [
      { id: WEB_BROWSER_PANEL_ID, title: 'Browser Pane', icon: '🌐', location: 'right' },
    ],
  },
  activationEvents: [`onPanel:${WEB_BROWSER_PANEL_ID}`],
  entries: { renderer: 'renderer.tsx' },
  // Off by default: this is a reference plugin, and enabling it flips the
  // window-level webviewTag flag — the framework's minimal default footprint
  // (vanilla windows, no webview surface) is preserved until a user opts in
  // via Settings → Plugins.
  defaultEnabled: false,
}
