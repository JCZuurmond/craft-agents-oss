/**
 * Panel store semantics: declared/ready/error lifecycle, declaration↔code
 * merge rules, per-dock visibility state, and dock reconciliation when
 * panels disappear. Runs under bun without a DOM — storage-stub provides
 * in-memory local/sessionStorage (the store also guards their absence).
 */

import './storage-stub'
import { describe, test, expect, beforeEach } from 'bun:test'
import type { ComponentType } from 'react'
import { PLUGIN_PANEL_LOCATIONS } from '@craft-agent/shared/plugins/types'
import {
  declarePluginPanels,
  registerPluginPanel,
  removePluginPanels,
  markPluginPanelError,
  markPluginPanelsError,
  resetPluginPanel,
  openPluginPanel,
  togglePluginPanel,
  setPluginPanelDockSize,
  getPluginPanelState,
  isPluginPanelDockVisible,
  panelKey,
  PLUGIN_PANEL_DOCK_SIZE,
  __setDockStateForTests,
} from '../panel-store'
import type { PluginPanelProps } from '../types'

const Component = (() => null) as ComponentType<PluginPanelProps>

/** The store is a module singleton — reset panels and docks between tests */
beforeEach(() => {
  for (const panel of [...getPluginPanelState().panels]) {
    removePluginPanels(panel.pluginId)
  }
  for (const location of PLUGIN_PANEL_LOCATIONS) {
    __setDockStateForTests(location, { activePanelKey: null, isOpen: false, size: 420 })
  }
})

describe('declarative panels', () => {
  test('declared panels appear without a component, honoring location and icon fallback', () => {
    declarePluginPanels('p1', [
      { id: 'a', title: 'A' },
      { id: 'b', title: 'B', icon: '🅱️', location: 'left' },
    ], '🧩')

    const { panels } = getPluginPanelState()
    expect(panels).toHaveLength(2)
    const a = panels.find((p) => p.key === panelKey('p1', 'a'))!
    const b = panels.find((p) => p.key === panelKey('p1', 'b'))!
    expect(a).toMatchObject({ status: 'declared', location: 'right', icon: '🧩', declared: true })
    expect(b).toMatchObject({ status: 'declared', location: 'left', icon: '🅱️' })
    expect(a.component).toBeNull()
  })

  test('registering a declared panel fills the component; manifest fields win', () => {
    declarePluginPanels('p1', [{ id: 'a', title: 'Declared Title', location: 'left' }])
    registerPluginPanel('p1', { id: 'a', title: 'Code Title', icon: '💥', component: Component })

    const panel = getPluginPanelState().panels[0]!
    expect(panel.status).toBe('ready')
    expect(panel.component).toBe(Component)
    expect(panel.title).toBe('Declared Title')
    expect(panel.location).toBe('left')
    // icon: declaration had none — code icon fills the gap
    expect(panel.icon).toBe('💥')
  })

  test('unregistering a declared panel reverts it to declared instead of removing', () => {
    declarePluginPanels('p1', [{ id: 'a', title: 'A' }])
    const unregister = registerPluginPanel('p1', { id: 'a', title: 'A', component: Component })
    unregister()

    const panel = getPluginPanelState().panels[0]!
    expect(panel.status).toBe('declared')
    expect(panel.component).toBeNull()
  })

  test('double registration of a ready panel throws', () => {
    registerPluginPanel('p1', { id: 'a', title: 'A', component: Component })
    expect(() => registerPluginPanel('p1', { id: 'a', title: 'A', component: Component })).toThrow()
  })

  test('undeclared registration contributes a complete panel and unregisters fully', () => {
    const unregister = registerPluginPanel('p1', { id: 'x', title: 'X', location: 'left', component: Component })
    expect(getPluginPanelState().panels[0]).toMatchObject({ status: 'ready', location: 'left', declared: false })
    unregister()
    expect(getPluginPanelState().panels).toHaveLength(0)
  })

  test('panels can be declared on every shell edge', () => {
    declarePluginPanels('p1', [
      { id: 'l', title: 'L', location: 'left' },
      { id: 'r', title: 'R', location: 'right' },
      { id: 't', title: 'T', location: 'top' },
      { id: 'b', title: 'B', location: 'bottom' },
    ])
    const locations = getPluginPanelState().panels.map((p) => p.location)
    expect(locations).toEqual(['left', 'right', 'top', 'bottom'])
  })
})

describe('error lifecycle', () => {
  test('markPluginPanelsError only touches not-ready panels; reset restores by component presence', () => {
    declarePluginPanels('p1', [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }])
    registerPluginPanel('p1', { id: 'a', title: 'A', component: Component })
    markPluginPanelsError('p1', 'activation failed')

    const byId = (id: string) => getPluginPanelState().panels.find((p) => p.key === panelKey('p1', id))!
    expect(byId('a').status).toBe('ready')
    expect(byId('b')).toMatchObject({ status: 'error', error: 'activation failed' })

    resetPluginPanel(panelKey('p1', 'b'))
    expect(byId('b').status).toBe('declared')

    markPluginPanelError(panelKey('p1', 'a'), 'render crash')
    expect(byId('a')).toMatchObject({ status: 'error', error: 'render crash' })
    resetPluginPanel(panelKey('p1', 'a'))
    expect(byId('a').status).toBe('ready') // component still registered
  })
})

describe('per-dock visibility', () => {
  test('docks track open/active independently across all four edges', () => {
    registerPluginPanel('p1', { id: 'r', title: 'R', component: Component })
    registerPluginPanel('p2', { id: 'l', title: 'L', location: 'left', component: Component })
    registerPluginPanel('p3', { id: 'b', title: 'B', location: 'bottom', component: Component })

    openPluginPanel(panelKey('p1', 'r'))
    expect(isPluginPanelDockVisible('right')).toBe(true)
    expect(isPluginPanelDockVisible('left')).toBe(false)
    expect(isPluginPanelDockVisible('bottom')).toBe(false)

    openPluginPanel(panelKey('p2', 'l'))
    openPluginPanel(panelKey('p3', 'b'))
    expect(isPluginPanelDockVisible('left')).toBe(true)
    expect(isPluginPanelDockVisible('right')).toBe(true) // independent
    expect(isPluginPanelDockVisible('bottom')).toBe(true)

    togglePluginPanel(panelKey('p1', 'r')) // active → closes right only
    expect(isPluginPanelDockVisible('right')).toBe(false)
    expect(isPluginPanelDockVisible('left')).toBe(true)
    expect(isPluginPanelDockVisible('bottom')).toBe(true)
  })

  test('removing the active panel falls back to the next panel on that dock', () => {
    registerPluginPanel('p1', { id: 'a', title: 'A', component: Component })
    registerPluginPanel('p2', { id: 'b', title: 'B', component: Component })
    openPluginPanel(panelKey('p1', 'a'))

    removePluginPanels('p1')
    const { docks } = getPluginPanelState()
    expect(docks.right.activePanelKey).toBe(panelKey('p2', 'b'))
    expect(isPluginPanelDockVisible('right')).toBe(true)

    removePluginPanels('p2')
    expect(isPluginPanelDockVisible('right')).toBe(false)
  })

  test('opening an unknown panel is a no-op', () => {
    openPluginPanel('nope:nope')
    expect(isPluginPanelDockVisible('right')).toBe(false)
  })

  test('a restored active panel survives other plugins declaring first (startup order)', () => {
    // Simulate persisted state from the last session: dock open on p2's
    // panel, which has not been declared yet in this session.
    __setDockStateForTests('right', { activePanelKey: panelKey('p2', 'b'), isOpen: true, size: 420 })

    // Another plugin declares first — it must not steal or clear the dock.
    declarePluginPanels('p1', [{ id: 'a', title: 'A' }])
    expect(getPluginPanelState().docks.right.activePanelKey).toBe(panelKey('p2', 'b'))
    expect(isPluginPanelDockVisible('right')).toBe(false) // waiting for p2

    // The restored plugin declares: the dock comes back on its panel.
    declarePluginPanels('p2', [{ id: 'b', title: 'B' }])
    expect(getPluginPanelState().docks.right.activePanelKey).toBe(panelKey('p2', 'b'))
    expect(isPluginPanelDockVisible('right')).toBe(true)
  })
})

describe('dock sizing', () => {
  test('sizes clamp to per-orientation limits (width for vertical, height for horizontal)', () => {
    setPluginPanelDockSize('right', 10_000)
    expect(getPluginPanelState().docks.right.size).toBe(PLUGIN_PANEL_DOCK_SIZE.vertical.max)
    setPluginPanelDockSize('right', 1)
    expect(getPluginPanelState().docks.right.size).toBe(PLUGIN_PANEL_DOCK_SIZE.vertical.min)

    setPluginPanelDockSize('bottom', 10_000)
    expect(getPluginPanelState().docks.bottom.size).toBe(PLUGIN_PANEL_DOCK_SIZE.horizontal.max)
    setPluginPanelDockSize('bottom', 1)
    expect(getPluginPanelState().docks.bottom.size).toBe(PLUGIN_PANEL_DOCK_SIZE.horizontal.min)
  })
})
