/**
 * External plugin loading (renderer): an on-disk `source: 'user'` plugin is
 * registered from the IPC snapshot, its declared panel appears lazily, and its
 * code is loaded through the injectable module loader on first panel open. The
 * raw dynamic `import()` is the one step this can't exercise headlessly; the
 * loader seam stands in for it so every step around it is covered.
 */

import './storage-stub'
import { describe, test, expect } from 'bun:test'
import type { ComponentType } from 'react'
import type { PluginInfo } from '@craft-agent/shared/plugins/types'
import {
  initializePluginRuntime,
  ensurePluginPanelReady,
  setExternalRendererModuleLoader,
} from '../runtime'
import { getPluginPanelState, panelKey } from '../panel-store'
import type { PluginContext, PluginPanelProps } from '../types'

const Component = (() => null) as ComponentType<PluginPanelProps>

const externalInfo: PluginInfo = {
  id: 'weather',
  name: 'Weather',
  version: '1.0.0',
  permissions: ['ui.sidePanel', 'storage'],
  apiVersion: 1,
  contributes: { sidePanels: [{ id: 'main', title: 'Weather', icon: '🌦️', location: 'right' }] },
  source: 'user',
  enabled: true,
  status: 'inactive',
  external: true,
  entryPaths: { renderer: '/fake/plugins/weather/renderer.mjs' },
}

describe('external renderer plugin loading', () => {
  test('registers the plugin, declares its panel, and loads code on first open', async () => {
    const loadedFrom: string[] = []
    const ctxSeen: PluginContext[] = []

    // Stand in for the on-disk dynamic import.
    setExternalRendererModuleLoader(async (entryPath) => {
      loadedFrom.push(entryPath)
      return {
        activate(ctx: PluginContext) {
          ctxSeen.push(ctx)
          ctx.ui.registerSidePanel({ id: 'main', title: 'Weather', component: Component })
        },
      }
    })

    ;(globalThis as Record<string, unknown>).window = globalThis
    ;(globalThis as { electronAPI?: unknown }).electronAPI = {
      plugins: {
        list: async (): Promise<PluginInfo[]> => [externalInfo],
        setEnabled: async () => ({ ok: true, requiresRelaunch: false }),
        invoke: async () => undefined,
        reportRendererStatus: async () => undefined,
        onChanged: () => () => {},
      },
    }

    await initializePluginRuntime()

    // Declared panel is introspectable without the plugin's code having run.
    const key = panelKey('weather', 'main')
    const declared = getPluginPanelState().panels.find((p) => p.key === key)
    expect(declared?.status).toBe('declared')
    expect(loadedFrom).toEqual([])

    // Opening the panel activates the plugin: the loader runs, code registers
    // the component, and the panel becomes ready.
    await ensurePluginPanelReady(key)

    expect(loadedFrom).toEqual(['/fake/plugins/weather/renderer.mjs'])
    expect(getPluginPanelState().panels.find((p) => p.key === key)?.status).toBe('ready')
    // The host supplies its React instance for no-build authoring.
    expect(ctxSeen).toHaveLength(1)
    expect(ctxSeen[0]!.react.createElement).toBeTypeOf('function')
  })
})
