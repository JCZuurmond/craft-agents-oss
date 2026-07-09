/**
 * Plugin Console plugin — smoke/integration tests
 *
 * Exercises the plugin strictly through the public framework surface:
 * manifest validation, onStartup activation policy, hook capture through a
 * real PluginContext, mounting the panel (SSR render), ring-buffer behavior,
 * and disposal detaching the listeners.
 */

import { describe, test, expect, beforeEach } from 'bun:test'

// Renderer modules persist UI state through localStorage; provide a minimal
// shim before importing them (bun test has no DOM).
const backing = new Map<string, string>()
;(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (key: string) => backing.get(key) ?? null,
  setItem: (key: string, value: string) => { backing.set(key, String(value)) },
  removeItem: (key: string) => { backing.delete(key) },
}

import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { validatePluginManifest } from '@craft-agent/shared/plugins'
import { shouldActivateOnStartup } from '@craft-agent/shared/plugins/types'
import { PLUGIN_CONSOLE_PANEL_ID, PLUGIN_CONSOLE_PLUGIN_MANIFEST } from '../manifest'
import { activate } from '../renderer'
import {
  MAX_CONSOLE_ENTRIES,
  OBSERVED_HOOKS,
  createPluginConsoleStore,
  summarizeHookPayload,
} from '../console-store'
import { createPluginContext } from '../../../renderer/plugins/context'
import { pluginHostHooks } from '../../../renderer/plugins/host-hooks'
import {
  getPluginPanelState,
  openPluginPanel,
  panelKey,
  removePluginPanels,
  __setDockStateForTests,
} from '../../../renderer/plugins/panel-store'
import { BUILTIN_PLUGIN_MANIFESTS } from '../../manifests'
import { RENDERER_PLUGIN_ENTRIES } from '../../renderer-entries'

const PLUGIN_ID = PLUGIN_CONSOLE_PLUGIN_MANIFEST.id
const PANEL_KEY = panelKey(PLUGIN_ID, PLUGIN_CONSOLE_PANEL_ID)

beforeEach(() => {
  backing.clear()
  removePluginPanels(PLUGIN_ID)
  __setDockStateForTests('bottom', { activePanelKey: null, isOpen: false, size: 280 })
})

describe('plugin-console manifest', () => {
  test('is a valid plugin manifest', () => {
    const result = validatePluginManifest(PLUGIN_CONSOLE_PLUGIN_MANIFEST)
    expect(result.valid).toBe(true)
    expect(result.errors).toEqual([])
  })

  test('is registered as a built-in with a renderer entry', () => {
    expect(BUILTIN_PLUGIN_MANIFESTS.some((m) => m.id === PLUGIN_ID)).toBe(true)
    expect(RENDERER_PLUGIN_ENTRIES[PLUGIN_ID]).toBe(activate)
  })

  test('declares a bottom-edge panel and activates at startup', () => {
    expect(PLUGIN_CONSOLE_PLUGIN_MANIFEST.permissions).toEqual(['ui.sidePanel'])
    expect(PLUGIN_CONSOLE_PLUGIN_MANIFEST.contributes?.sidePanels).toEqual([
      { id: PLUGIN_CONSOLE_PANEL_ID, title: 'Plugin Console', icon: '📟', location: 'bottom' },
    ])
    // Hooks only observe events emitted after subscription — the manifest
    // must opt out of the panels-are-lazy default.
    expect(shouldActivateOnStartup(PLUGIN_CONSOLE_PLUGIN_MANIFEST)).toBe(true)
  })
})

describe('plugin-console lifecycle and hook capture', () => {
  test('activate registers the bottom panel; captured hooks render in the log', () => {
    const created = createPluginContext(PLUGIN_CONSOLE_PLUGIN_MANIFEST)
    activate(created.ctx)

    const panel = getPluginPanelState().panels.find((p) => p.key === PANEL_KEY)
    expect(panel?.status).toBe('ready')
    expect(panel?.location).toBe('bottom')

    pluginHostHooks.emit('app:ready', { pluginIds: ['plugin-console', 'web-browser'] })
    pluginHostHooks.emit('panel:opened', { pluginId: 'web-browser', panelId: 'browser', location: 'right' })
    pluginHostHooks.emit('command:executed', { pluginId: 'focus-timer', commandId: 'toggle' })

    const html = renderToString(createElement(panel!.component!, { isActive: true }))
    expect(html).toContain('app:ready')
    expect(html).toContain('plugins=[plugin-console, web-browser]')
    expect(html).toContain('plugin=web-browser panel=browser location=right')
    expect(html).toContain('plugin=focus-timer command=toggle')
    expect(html).toContain('3 events')

    created.dispose()
  })

  test('dispose detaches the hook listeners', () => {
    const created = createPluginContext(PLUGIN_CONSOLE_PLUGIN_MANIFEST)
    activate(created.ctx)
    const panel = getPluginPanelState().panels.find((p) => p.key === PANEL_KEY)

    pluginHostHooks.emit('plugin:activated', { pluginId: 'before-dispose' })
    created.dispose()
    pluginHostHooks.emit('plugin:activated', { pluginId: 'after-dispose' })

    const html = renderToString(createElement(panel!.component!, { isActive: true }))
    expect(html).toContain('plugin=before-dispose')
    expect(html).not.toContain('plugin=after-dispose')
  })

  test('panel opens on the bottom dock', () => {
    const created = createPluginContext(PLUGIN_CONSOLE_PLUGIN_MANIFEST)
    activate(created.ctx)

    openPluginPanel(PANEL_KEY)
    expect(getPluginPanelState().docks.bottom.isOpen).toBe(true)
    expect(getPluginPanelState().docks.bottom.activePanelKey).toBe(PANEL_KEY)

    created.dispose()
  })

  test('empty console renders the hint and a disabled clear control', () => {
    const created = createPluginContext(PLUGIN_CONSOLE_PLUGIN_MANIFEST)
    activate(created.ctx)
    const panel = getPluginPanelState().panels.find((p) => p.key === PANEL_KEY)

    const html = renderToString(createElement(panel!.component!, { isActive: true }))
    expect(html).toContain('No framework events yet')
    expect(html).toContain('0 events')

    created.dispose()
  })
})

describe('console store', () => {
  test('caps the buffer at MAX_CONSOLE_ENTRIES, dropping oldest first', () => {
    const store = createPluginConsoleStore()
    for (let i = 0; i < MAX_CONSOLE_ENTRIES + 10; i++) {
      store.append('plugin:activated', { pluginId: `p${i}` })
    }
    const entries = store.getEntries()
    expect(entries).toHaveLength(MAX_CONSOLE_ENTRIES)
    expect(entries[0].summary).toBe('plugin=p10')
    expect(entries.at(-1)?.summary).toBe(`plugin=p${MAX_CONSOLE_ENTRIES + 9}`)
  })

  test('clear empties the buffer and notifies subscribers', () => {
    const store = createPluginConsoleStore()
    let notified = 0
    store.subscribe(() => { notified++ })
    store.append('panel:closed', { pluginId: 'a', panelId: 'b', location: 'bottom' })
    store.clear()
    expect(store.getEntries()).toEqual([])
    expect(notified).toBe(2)
  })

  test('observes the complete v1 hook vocabulary', () => {
    expect([...OBSERVED_HOOKS].sort()).toEqual([
      'app:ready',
      'command:executed',
      'panel:closed',
      'panel:opened',
      'plugin:activated',
      'plugin:deactivated',
    ])
  })
})

describe('summarizeHookPayload', () => {
  test('summarizes each payload shape as key=value pairs', () => {
    expect(summarizeHookPayload('app:ready', { pluginIds: ['a', 'b'] })).toBe('plugins=[a, b]')
    expect(summarizeHookPayload('plugin:deactivated', { pluginId: 'x' })).toBe('plugin=x')
    expect(summarizeHookPayload('panel:opened', { pluginId: 'x', panelId: 'y', location: 'top' }))
      .toBe('plugin=x panel=y location=top')
    expect(summarizeHookPayload('command:executed', { pluginId: 'x', commandId: 'run' }))
      .toBe('plugin=x command=run')
  })
})
