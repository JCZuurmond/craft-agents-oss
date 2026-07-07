/**
 * Browser Pane plugin — smoke/integration tests
 *
 * Exercises the plugin strictly through the public framework surface:
 * manifest validation, declarative panel metadata, activation via a real
 * PluginContext, panel registration in the pane store, mounting the pane
 * (SSR render), and disposal. No core internals are touched.
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
import { WEB_BROWSER_PANEL_ID, WEB_BROWSER_PLUGIN_MANIFEST } from '../manifest'
import { activate } from '../renderer'
import { normalizeAddressInput, DEFAULT_URL } from '../BrowserPanel'
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

const PANEL_KEY = panelKey(WEB_BROWSER_PLUGIN_MANIFEST.id, WEB_BROWSER_PANEL_ID)

beforeEach(() => {
  backing.clear()
  removePluginPanels(WEB_BROWSER_PLUGIN_MANIFEST.id)
  __setDockStateForTests('left', { activePanelKey: null, isOpen: false, size: 420 })
  __setDockStateForTests('right', { activePanelKey: null, isOpen: false, size: 420 })
})

describe('web-browser plugin manifest', () => {
  test('is a valid plugin manifest', () => {
    const result = validatePluginManifest(WEB_BROWSER_PLUGIN_MANIFEST)
    expect(result.valid).toBe(true)
    expect(result.errors).toEqual([])
  })

  test('is registered as a built-in with a renderer entry', () => {
    expect(BUILTIN_PLUGIN_MANIFESTS.some((m) => m.id === 'web-browser')).toBe(true)
    expect(RENDERER_PLUGIN_ENTRIES['web-browser']).toBe(activate)
  })

  test('declares exactly the permissions and side panel it uses', () => {
    expect(WEB_BROWSER_PLUGIN_MANIFEST.permissions).toEqual(['ui.sidePanel', 'ui.webview', 'storage'])
    expect(WEB_BROWSER_PLUGIN_MANIFEST.contributes?.sidePanels).toEqual([
      { id: WEB_BROWSER_PANEL_ID, title: 'Browser Pane', icon: '🌐', location: 'right' },
    ])
    expect(WEB_BROWSER_PLUGIN_MANIFEST.activationEvents).toEqual([`onPanel:${WEB_BROWSER_PANEL_ID}`])
  })
})

describe('web-browser plugin lifecycle', () => {
  test('activate fills the declared browser side panel and dispose reverts it', () => {
    declarePluginPanels(
      WEB_BROWSER_PLUGIN_MANIFEST.id,
      WEB_BROWSER_PLUGIN_MANIFEST.contributes!.sidePanels!,
      WEB_BROWSER_PLUGIN_MANIFEST.icon,
    )
    const created = createPluginContext(WEB_BROWSER_PLUGIN_MANIFEST)

    activate(created.ctx)
    const registered = getPluginPanelState().panels.find((p) => p.key === PANEL_KEY)
    expect(registered).toBeDefined()
    expect(registered?.declared).toBe(true)
    expect(registered?.status).toBe('ready')
    expect(registered?.title).toBe('Browser Pane')
    expect(registered?.icon).toBe(WEB_BROWSER_PLUGIN_MANIFEST.icon)

    created.dispose()
    const reverted = getPluginPanelState().panels.find((p) => p.key === PANEL_KEY)
    expect(reverted).toMatchObject({ status: 'declared', component: null })
  })

  test('panel can be opened and closed through the pane store', () => {
    const created = createPluginContext(WEB_BROWSER_PLUGIN_MANIFEST)
    activate(created.ctx)

    openPluginPanel(PANEL_KEY)
    expect(getPluginPanelState().docks.right.isOpen).toBe(true)
    expect(getPluginPanelState().docks.right.activePanelKey).toBe(PANEL_KEY)

    closePluginPanelDock('right')
    expect(getPluginPanelState().docks.right.isOpen).toBe(false)

    created.dispose()
  })

  test('panel mounts: renders a sandboxed webview with the plugin partition and toolbar', () => {
    const created = createPluginContext(WEB_BROWSER_PLUGIN_MANIFEST)
    activate(created.ctx)

    const panel = getPluginPanelState().panels.find((p) => p.key === PANEL_KEY)
    expect(panel).toBeDefined()
    expect(panel?.component).toBeTruthy()
    const html = renderToString(createElement(panel!.component!, { isActive: true }))

    expect(html).toContain('<webview')
    expect(html).toContain('partition="persist:craft-plugin-web-browser"')
    expect(html).toContain(`src="${DEFAULT_URL}"`)
    expect(html).toContain('aria-label="Address"')
    expect(html).toContain('aria-label="Back"')
    expect(html).toContain('aria-label="Forward"')

    created.dispose()
  })
})

describe('framework permission gating (litmus)', () => {
  test('a plugin without ui.sidePanel cannot register panels', () => {
    const created = createPluginContext({
      id: 'no-ui',
      name: 'No UI',
      version: '1.0.0',
      permissions: [],
    })
    expect(() =>
      created.ctx.ui.registerSidePanel({ id: 'x', title: 'X', component: () => null }),
    ).toThrow(/ui\.sidePanel/)
    created.dispose()
  })

  test('a plugin without ui.webview cannot obtain a webview partition', () => {
    const created = createPluginContext({
      id: 'no-webview',
      name: 'No Webview',
      version: '1.0.0',
      permissions: ['ui.sidePanel'],
    })
    expect(() => created.ctx.webviewPartition).toThrow(/ui\.webview/)
    created.dispose()
  })

  test('a plugin without ipc cannot invoke main-process handlers', async () => {
    const created = createPluginContext({
      id: 'no-ipc',
      name: 'No IPC',
      version: '1.0.0',
      permissions: [],
    })
    await expect(created.ctx.invoke('anything')).rejects.toThrow(/'ipc' permission/)
    created.dispose()
  })
})

describe('normalizeAddressInput', () => {
  test('keeps full URLs', () => {
    expect(normalizeAddressInput('https://example.com/a?b=1')).toBe('https://example.com/a?b=1')
  })
  test('adds https:// to host-like input', () => {
    expect(normalizeAddressInput('example.com')).toBe('https://example.com')
    expect(normalizeAddressInput('localhost:3000/path')).toBe('https://localhost:3000/path')
  })
  test('turns plain text into a search', () => {
    expect(normalizeAddressInput('craft agents')).toBe('https://duckduckgo.com/?q=craft%20agents')
  })
  test('falls back to the default URL for empty input', () => {
    expect(normalizeAddressInput('   ')).toBe(DEFAULT_URL)
  })
  test('schemes the webview policy blocks become searches instead of silent blocks', () => {
    // Main-process hardening only loads http(s)/about:blank (SECURITY.md);
    // pre-validating here gives address-bar input an ordinary search result.
    expect(normalizeAddressInput('file:///etc/passwd')).toBe(
      'https://duckduckgo.com/?q=file%3A%2F%2F%2Fetc%2Fpasswd',
    )
    expect(normalizeAddressInput('ftp://example.com/file')).toBe(
      'https://duckduckgo.com/?q=ftp%3A%2F%2Fexample.com%2Ffile',
    )
    expect(normalizeAddressInput('about:config')).toBe(
      'https://duckduckgo.com/?q=about%3Aconfig',
    )
  })
  test('about:blank passes through; http casing is tolerated', () => {
    expect(normalizeAddressInput('about:blank')).toBe('about:blank')
    expect(normalizeAddressInput('HTTP://example.com')).toBe('HTTP://example.com')
  })
})
