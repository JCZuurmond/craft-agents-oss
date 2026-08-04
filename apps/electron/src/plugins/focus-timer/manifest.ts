/**
 * Focus Timer plugin — manifest
 *
 * Data-only module: imported by both the main process (registry) and the
 * renderer (activation). Keep it free of React/Electron imports.
 */

import type { PluginManifest } from '@craft-agent/shared/plugins/types'

export const FOCUS_TIMER_PANEL_ID = 'timer'
export const FOCUS_TIMER_TOGGLE_COMMAND_ID = 'toggle'
export const FOCUS_TIMER_RESET_COMMAND_ID = 'reset'

export const FOCUS_TIMER_PLUGIN_MANIFEST: PluginManifest = {
  id: 'focus-timer',
  name: 'Focus Timer',
  version: '0.1.0',
  description: 'A focus-session timer in a slim top bar, driven by declared commands with a keybinding.',
  icon: '⏱️',
  apiVersion: 1,
  permissions: ['ui.sidePanel', 'commands', 'storage'],
  contributes: {
    sidePanels: [
      { id: FOCUS_TIMER_PANEL_ID, title: 'Focus Timer', icon: '⏱️', location: 'top' },
    ],
    commands: [
      // 'mod+shift+f' is free of core-default collisions (mod+f is find,
      // mod+shift+g is next-match); the command store would refuse a
      // colliding chord at declare time.
      { id: FOCUS_TIMER_TOGGLE_COMMAND_ID, title: 'Start / Pause Focus Timer', keybinding: 'mod+shift+f' },
      { id: FOCUS_TIMER_RESET_COMMAND_ID, title: 'Reset Focus Timer' },
    ],
  },
  activationEvents: [
    `onPanel:${FOCUS_TIMER_PANEL_ID}`,
    `onCommand:${FOCUS_TIMER_TOGGLE_COMMAND_ID}`,
    `onCommand:${FOCUS_TIMER_RESET_COMMAND_ID}`,
  ],
  entries: { renderer: 'renderer.tsx' },
  // Off by default: reference plugins keep the framework's zero-footprint
  // default posture; users opt in via Settings → Plugins.
  defaultEnabled: false,
}
