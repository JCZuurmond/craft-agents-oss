/**
 * Focus Timer plugin — smoke/integration tests
 *
 * Exercises the plugin strictly through the public framework surface:
 * manifest validation, declarative panel + command metadata, activation via a
 * real PluginContext, command dispatch through the host command store,
 * mounting the panel (SSR render), timer-store behavior, and disposal.
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
import { qualifiedCommandId } from '@craft-agent/shared/plugins/types'
import {
  FOCUS_TIMER_PANEL_ID,
  FOCUS_TIMER_PLUGIN_MANIFEST,
  FOCUS_TIMER_RESET_COMMAND_ID,
  FOCUS_TIMER_TOGGLE_COMMAND_ID,
} from '../manifest'
import { activate } from '../renderer'
import {
  COMPLETED_STORAGE_KEY,
  DURATION_STORAGE_KEY,
  createFocusTimerStore,
  formatRemaining,
} from '../timer-store'
import { createPluginContext } from '../../../renderer/plugins/context'
import {
  declarePluginPanels,
  getPluginPanelState,
  openPluginPanel,
  panelKey,
  removePluginPanels,
  __setDockStateForTests,
} from '../../../renderer/plugins/panel-store'
import {
  declarePluginCommands,
  executePluginCommand,
  listDeclaredPluginCommands,
  removePluginCommands,
  __resetPluginCommandsForTests,
} from '../../../renderer/plugins/command-store'
import { BUILTIN_PLUGIN_MANIFESTS } from '../../manifests'
import { RENDERER_PLUGIN_ENTRIES } from '../../renderer-entries'

const PLUGIN_ID = FOCUS_TIMER_PLUGIN_MANIFEST.id
const PANEL_KEY = panelKey(PLUGIN_ID, FOCUS_TIMER_PANEL_ID)
const TOGGLE_QUALIFIED = qualifiedCommandId(PLUGIN_ID, FOCUS_TIMER_TOGGLE_COMMAND_ID)

beforeEach(() => {
  backing.clear()
  removePluginPanels(PLUGIN_ID)
  removePluginCommands(PLUGIN_ID)
  __resetPluginCommandsForTests()
  __setDockStateForTests('top', { activePanelKey: null, isOpen: false, size: 280 })
})

describe('focus-timer plugin manifest', () => {
  test('is a valid plugin manifest', () => {
    const result = validatePluginManifest(FOCUS_TIMER_PLUGIN_MANIFEST)
    expect(result.valid).toBe(true)
    expect(result.errors).toEqual([])
  })

  test('is registered as a built-in with a renderer entry', () => {
    expect(BUILTIN_PLUGIN_MANIFESTS.some((m) => m.id === PLUGIN_ID)).toBe(true)
    expect(RENDERER_PLUGIN_ENTRIES[PLUGIN_ID]).toBe(activate)
  })

  test('declares the top-edge panel, both commands, and lazy activation events', () => {
    expect(FOCUS_TIMER_PLUGIN_MANIFEST.permissions).toEqual(['ui.sidePanel', 'commands', 'storage'])
    expect(FOCUS_TIMER_PLUGIN_MANIFEST.contributes?.sidePanels).toEqual([
      { id: FOCUS_TIMER_PANEL_ID, title: 'Focus Timer', icon: '⏱️', location: 'top' },
    ])
    expect(FOCUS_TIMER_PLUGIN_MANIFEST.contributes?.commands).toEqual([
      { id: FOCUS_TIMER_TOGGLE_COMMAND_ID, title: 'Start / Pause Focus Timer', keybinding: 'mod+shift+f' },
      { id: FOCUS_TIMER_RESET_COMMAND_ID, title: 'Reset Focus Timer' },
    ])
    expect(FOCUS_TIMER_PLUGIN_MANIFEST.activationEvents).toEqual([
      `onPanel:${FOCUS_TIMER_PANEL_ID}`,
      `onCommand:${FOCUS_TIMER_TOGGLE_COMMAND_ID}`,
      `onCommand:${FOCUS_TIMER_RESET_COMMAND_ID}`,
    ])
  })

  test('declared keybinding survives the core-collision filter', () => {
    declarePluginCommands(PLUGIN_ID, FOCUS_TIMER_PLUGIN_MANIFEST.contributes!.commands!)
    const declared = listDeclaredPluginCommands().find((c) => c.commandId === FOCUS_TIMER_TOGGLE_COMMAND_ID)
    expect(declared?.keybinding).toBe('mod+shift+f')
  })
})

describe('focus-timer plugin lifecycle', () => {
  test('activate fills the declared top panel and dispose reverts it', () => {
    declarePluginPanels(
      PLUGIN_ID,
      FOCUS_TIMER_PLUGIN_MANIFEST.contributes!.sidePanels!,
      FOCUS_TIMER_PLUGIN_MANIFEST.icon,
    )
    const created = createPluginContext(FOCUS_TIMER_PLUGIN_MANIFEST)

    activate(created.ctx)
    const registered = getPluginPanelState().panels.find((p) => p.key === PANEL_KEY)
    expect(registered?.status).toBe('ready')
    expect(registered?.location).toBe('top')

    created.dispose()
    const reverted = getPluginPanelState().panels.find((p) => p.key === PANEL_KEY)
    expect(reverted).toMatchObject({ status: 'declared', component: null })
  })

  test('toggle command opens the top dock and starts/pauses the timer', async () => {
    const created = createPluginContext(FOCUS_TIMER_PLUGIN_MANIFEST)
    activate(created.ctx)

    const started = await executePluginCommand(TOGGLE_QUALIFIED)
    expect(started).toBe('running')
    expect(getPluginPanelState().docks.top.isOpen).toBe(true)
    expect(getPluginPanelState().docks.top.activePanelKey).toBe(PANEL_KEY)

    const paused = await executePluginCommand(TOGGLE_QUALIFIED)
    expect(paused).toBe('paused')

    created.dispose()
    // Disposal unregisters the handlers (undeclared handler → hard failure).
    await expect(executePluginCommand(TOGGLE_QUALIFIED)).rejects.toThrow()
  })

  test('panel mounts with the persisted duration and completed count', () => {
    const created = createPluginContext(FOCUS_TIMER_PLUGIN_MANIFEST)
    created.ctx.storage.set(DURATION_STORAGE_KEY, 50)
    created.ctx.storage.set(COMPLETED_STORAGE_KEY, 3)
    activate(created.ctx)

    const panel = getPluginPanelState().panels.find((p) => p.key === PANEL_KEY)
    const html = renderToString(createElement(panel!.component!, { isActive: true }))

    expect(html).toContain('50:00')
    expect(html).toContain('🏁 3')
    expect(html).toContain('aria-label="Start"')
    expect(html).toContain('aria-label="Reset"')

    created.dispose()
  })
})

describe('focus timer store', () => {
  const storageFor = (created: ReturnType<typeof createPluginContext>) => created.ctx.storage

  test('runs to completion, increments and persists the session count', () => {
    const created = createPluginContext(FOCUS_TIMER_PLUGIN_MANIFEST)
    const store = createFocusTimerStore(storageFor(created))

    store.setDurationMinutes(1)
    store.start()
    store.tick(30_000)
    expect(store.getState()).toMatchObject({ phase: 'running', remainingMs: 30_000 })

    store.tick(30_000)
    expect(store.getState()).toMatchObject({ phase: 'done', remainingMs: 0, completedSessions: 1 })
    expect(storageFor(created).get(COMPLETED_STORAGE_KEY, 0)).toBe(1)

    created.dispose()
  })

  test('pause holds the clock; ticks while not running are ignored', () => {
    const created = createPluginContext(FOCUS_TIMER_PLUGIN_MANIFEST)
    const store = createFocusTimerStore(storageFor(created))

    store.tick(5_000) // idle — ignored
    store.start()
    store.tick(1_000)
    store.pause()
    store.tick(60_000) // paused — ignored
    const state = store.getState()
    expect(state.phase).toBe('paused')
    expect(state.remainingMs).toBe(25 * 60_000 - 1_000)

    created.dispose()
  })

  test('setDurationMinutes persists the preference and resets the clock', () => {
    const created = createPluginContext(FOCUS_TIMER_PLUGIN_MANIFEST)
    const store = createFocusTimerStore(storageFor(created))

    store.setDurationMinutes(15)
    expect(store.getState()).toMatchObject({ phase: 'idle', durationMinutes: 15, remainingMs: 15 * 60_000 })
    expect(storageFor(created).get(DURATION_STORAGE_KEY, 0)).toBe(15)

    created.dispose()
  })
})

describe('formatRemaining', () => {
  test('formats mm:ss with padding', () => {
    expect(formatRemaining(25 * 60_000)).toBe('25:00')
    expect(formatRemaining(61_000)).toBe('01:01')
    expect(formatRemaining(0)).toBe('00:00')
  })

  test('rounds partial seconds up so a running timer never hits 00:00 early', () => {
    expect(formatRemaining(500)).toBe('00:01')
  })
})
