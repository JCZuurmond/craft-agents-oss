/**
 * Scratchpad plugin — smoke/integration tests
 *
 * Exercises the plugin strictly through the public framework surface:
 * manifest validation, declarative panel metadata, activation via a real
 * PluginContext, panel registration in the panel store, mounting the panel
 * (SSR render), storage-backed restore, and disposal. No core internals are
 * touched.
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
import { SCRATCHPAD_PANEL_ID, SCRATCHPAD_PLUGIN_MANIFEST } from '../manifest'
import { activate } from '../renderer'
import { noteStats, NOTE_STORAGE_KEY } from '../ScratchpadPanel'
import { createPluginContext } from '../../../renderer/plugins/context'
import {
  declarePluginPanels,
  getPluginPanelState,
  openPluginPanel,
  closePluginPanelDock,
  panelKey,
  removePluginPanels,
  __setDockStateForTests,
} from '../../../renderer/plugins/panel-store'
import { BUILTIN_PLUGIN_MANIFESTS } from '../../manifests'
import { RENDERER_PLUGIN_ENTRIES } from '../../renderer-entries'

const PANEL_KEY = panelKey(SCRATCHPAD_PLUGIN_MANIFEST.id, SCRATCHPAD_PANEL_ID)

beforeEach(() => {
  backing.clear()
  removePluginPanels(SCRATCHPAD_PLUGIN_MANIFEST.id)
  __setDockStateForTests('left', { activePanelKey: null, isOpen: false, size: 420 })
  __setDockStateForTests('right', { activePanelKey: null, isOpen: false, size: 420 })
})

describe('scratchpad plugin manifest', () => {
  test('is a valid plugin manifest', () => {
    const result = validatePluginManifest(SCRATCHPAD_PLUGIN_MANIFEST)
    expect(result.valid).toBe(true)
    expect(result.errors).toEqual([])
  })

  test('is registered as a built-in with a renderer entry', () => {
    expect(BUILTIN_PLUGIN_MANIFESTS.some((m) => m.id === 'scratchpad')).toBe(true)
    expect(RENDERER_PLUGIN_ENTRIES['scratchpad']).toBe(activate)
  })

  test('declares exactly the permissions and left-edge panel it uses', () => {
    expect(SCRATCHPAD_PLUGIN_MANIFEST.permissions).toEqual(['ui.sidePanel', 'storage'])
    expect(SCRATCHPAD_PLUGIN_MANIFEST.contributes?.sidePanels).toEqual([
      { id: SCRATCHPAD_PANEL_ID, title: 'Scratchpad', icon: '📝', location: 'left' },
    ])
    expect(SCRATCHPAD_PLUGIN_MANIFEST.activationEvents).toEqual([`onPanel:${SCRATCHPAD_PANEL_ID}`])
  })
})

describe('scratchpad plugin lifecycle', () => {
  test('activate fills the declared panel and dispose reverts it', () => {
    declarePluginPanels(
      SCRATCHPAD_PLUGIN_MANIFEST.id,
      SCRATCHPAD_PLUGIN_MANIFEST.contributes!.sidePanels!,
      SCRATCHPAD_PLUGIN_MANIFEST.icon,
    )
    const created = createPluginContext(SCRATCHPAD_PLUGIN_MANIFEST)

    activate(created.ctx)
    const registered = getPluginPanelState().panels.find((p) => p.key === PANEL_KEY)
    expect(registered).toBeDefined()
    expect(registered?.declared).toBe(true)
    expect(registered?.status).toBe('ready')
    expect(registered?.location).toBe('left')
    expect(registered?.title).toBe('Scratchpad')

    created.dispose()
    const reverted = getPluginPanelState().panels.find((p) => p.key === PANEL_KEY)
    expect(reverted).toMatchObject({ status: 'declared', component: null })
  })

  test('panel opens and closes through the left dock', () => {
    const created = createPluginContext(SCRATCHPAD_PLUGIN_MANIFEST)
    activate(created.ctx)

    openPluginPanel(PANEL_KEY)
    expect(getPluginPanelState().docks.left.isOpen).toBe(true)
    expect(getPluginPanelState().docks.left.activePanelKey).toBe(PANEL_KEY)
    // The right dock is untouched — this is a left-edge contribution.
    expect(getPluginPanelState().docks.right.isOpen).toBe(false)

    closePluginPanelDock('left')
    expect(getPluginPanelState().docks.left.isOpen).toBe(false)

    created.dispose()
  })

  test('panel mounts empty with the autosave hint', () => {
    const created = createPluginContext(SCRATCHPAD_PLUGIN_MANIFEST)
    activate(created.ctx)

    const panel = getPluginPanelState().panels.find((p) => p.key === PANEL_KEY)
    expect(panel?.component).toBeTruthy()
    const html = renderToString(createElement(panel!.component!, { isActive: true }))

    expect(html).toContain('aria-label="Scratchpad note"')
    expect(html).toContain('Autosaves as you type')
    expect(html).toContain('0 words')

    created.dispose()
  })

  test('panel restores persisted content from scoped storage on mount', () => {
    const created = createPluginContext(SCRATCHPAD_PLUGIN_MANIFEST)
    created.ctx.storage.set(NOTE_STORAGE_KEY, 'Ship the release notes')
    activate(created.ctx)

    const panel = getPluginPanelState().panels.find((p) => p.key === PANEL_KEY)
    const html = renderToString(createElement(panel!.component!, { isActive: true }))

    expect(html).toContain('Ship the release notes')
    expect(html).toContain('Restored from plugin storage')
    expect(html).toContain('4 words')

    // The note lives under the plugin's scoped namespace, not a global key.
    expect(backing.has('craft-plugin-scratchpad:note')).toBe(true)

    created.dispose()
  })
})

describe('noteStats', () => {
  test('empty text has zero stats', () => {
    expect(noteStats('')).toEqual({ chars: 0, words: 0, lines: 0 })
  })

  test('counts words across whitespace runs and newlines', () => {
    expect(noteStats('a  b\nc')).toEqual({ chars: 6, words: 3, lines: 2 })
  })

  test('whitespace-only text counts no words', () => {
    expect(noteStats('   \n ')).toMatchObject({ words: 0, lines: 2 })
  })
})
