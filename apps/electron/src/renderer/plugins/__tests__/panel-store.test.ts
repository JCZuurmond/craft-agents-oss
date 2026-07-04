/**
 * Panel store semantics: declared/ready/error lifecycle, declaration↔code
 * merge rules, per-edge visibility state, and edge reconciliation when
 * panels disappear. Runs under bun without a DOM — storage-stub provides
 * in-memory local/sessionStorage (the store also guards their absence).
 */

import './storage-stub'
import { describe, test, expect, beforeEach } from 'bun:test'
import type { ComponentType } from 'react'
import {
  declarePluginPanels,
  registerPluginPanel,
  removePluginPanels,
  markPluginPanelError,
  markPluginPanelsError,
  resetPluginPanel,
  openPluginPanel,
  closePluginPane,
  togglePluginPanel,
  getPluginPaneState,
  isPluginPaneVisible,
  panelKey,
} from '../panel-store'
import type { PluginPanelProps } from '../types'

const Component = (() => null) as ComponentType<PluginPanelProps>

/** The store is a module singleton — reset panels and edges between tests */
beforeEach(() => {
  for (const panel of [...getPluginPaneState().panels]) {
    removePluginPanels(panel.pluginId)
  }
  closePluginPane('left')
  closePluginPane('right')
})

describe('declarative panels', () => {
  test('declared panels appear without a component, honoring location and icon fallback', () => {
    declarePluginPanels('p1', [
      { id: 'a', title: 'A' },
      { id: 'b', title: 'B', icon: '🅱️', location: 'left' },
    ], '🧩')

    const { panels } = getPluginPaneState()
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

    const panel = getPluginPaneState().panels[0]!
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

    const panel = getPluginPaneState().panels[0]!
    expect(panel.status).toBe('declared')
    expect(panel.component).toBeNull()
  })

  test('double registration of a ready panel throws', () => {
    registerPluginPanel('p1', { id: 'a', title: 'A', component: Component })
    expect(() => registerPluginPanel('p1', { id: 'a', title: 'A', component: Component })).toThrow()
  })

  test('undeclared registration contributes a complete panel and unregisters fully', () => {
    const unregister = registerPluginPanel('p1', { id: 'x', title: 'X', location: 'left', component: Component })
    expect(getPluginPaneState().panels[0]).toMatchObject({ status: 'ready', location: 'left', declared: false })
    unregister()
    expect(getPluginPaneState().panels).toHaveLength(0)
  })
})

describe('error lifecycle', () => {
  test('markPluginPanelsError only touches not-ready panels; reset restores by component presence', () => {
    declarePluginPanels('p1', [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }])
    registerPluginPanel('p1', { id: 'a', title: 'A', component: Component })
    markPluginPanelsError('p1', 'activation failed')

    const byId = (id: string) => getPluginPaneState().panels.find((p) => p.key === panelKey('p1', id))!
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

describe('per-edge visibility', () => {
  test('edges track open/active independently', () => {
    registerPluginPanel('p1', { id: 'r', title: 'R', component: Component })
    registerPluginPanel('p2', { id: 'l', title: 'L', location: 'left', component: Component })

    openPluginPanel(panelKey('p1', 'r'))
    expect(isPluginPaneVisible('right')).toBe(true)
    expect(isPluginPaneVisible('left')).toBe(false)

    openPluginPanel(panelKey('p2', 'l'))
    expect(isPluginPaneVisible('left')).toBe(true)
    expect(isPluginPaneVisible('right')).toBe(true) // independent

    togglePluginPanel(panelKey('p1', 'r')) // active → closes right only
    expect(isPluginPaneVisible('right')).toBe(false)
    expect(isPluginPaneVisible('left')).toBe(true)
  })

  test('removing the active panel falls back to the next panel on that edge', () => {
    registerPluginPanel('p1', { id: 'a', title: 'A', component: Component })
    registerPluginPanel('p2', { id: 'b', title: 'B', component: Component })
    openPluginPanel(panelKey('p1', 'a'))

    removePluginPanels('p1')
    const { edges } = getPluginPaneState()
    expect(edges.right.activePanelKey).toBe(panelKey('p2', 'b'))
    expect(isPluginPaneVisible('right')).toBe(true)

    removePluginPanels('p2')
    expect(isPluginPaneVisible('right')).toBe(false)
  })

  test('opening an unknown panel is a no-op', () => {
    openPluginPanel('nope:nope')
    expect(isPluginPaneVisible('right')).toBe(false)
  })
})
