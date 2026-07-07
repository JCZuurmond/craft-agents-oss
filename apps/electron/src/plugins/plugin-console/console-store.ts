/**
 * Plugin Console plugin — event buffer
 *
 * A ring buffer of observed host-hook events with a subscribe/getEntries
 * surface for the panel. Buffering lives outside the component so events
 * captured while the panel is closed (or before it has ever been opened)
 * still show up — the plugin activates at startup, the panel mounts later.
 */

import type { PluginHostHook, PluginHostHookMap } from '../../renderer/plugins/host-hooks'

/** Oldest entries are dropped past this cap */
export const MAX_CONSOLE_ENTRIES = 200

/** Every hook in the v1 vocabulary — the console subscribes to all of them */
export const OBSERVED_HOOKS = [
  'app:ready',
  'plugin:activated',
  'plugin:deactivated',
  'panel:opened',
  'panel:closed',
  'command:executed',
] as const satisfies readonly PluginHostHook[]

export interface ConsoleEntry {
  /** Monotonic id (stable React key) */
  seq: number
  at: Date
  hook: PluginHostHook
  summary: string
}

/** One-line `key=value` rendering of a hook payload (pure; unit-tested) */
export function summarizeHookPayload<K extends PluginHostHook>(
  hook: K,
  payload: PluginHostHookMap[K],
): string {
  switch (hook) {
    case 'app:ready': {
      const { pluginIds } = payload as PluginHostHookMap['app:ready']
      return `plugins=[${pluginIds.join(', ')}]`
    }
    case 'plugin:activated':
    case 'plugin:deactivated': {
      const { pluginId } = payload as PluginHostHookMap['plugin:activated']
      return `plugin=${pluginId}`
    }
    case 'panel:opened':
    case 'panel:closed': {
      const { pluginId, panelId, location } = payload as PluginHostHookMap['panel:opened']
      return `plugin=${pluginId} panel=${panelId} location=${location}`
    }
    case 'command:executed': {
      const { pluginId, commandId } = payload as PluginHostHookMap['command:executed']
      return `plugin=${pluginId} command=${commandId}`
    }
  }
}

export interface PluginConsoleStore {
  subscribe(listener: () => void): () => void
  getEntries(): ConsoleEntry[]
  append<K extends PluginHostHook>(hook: K, payload: PluginHostHookMap[K]): void
  clear(): void
}

export function createPluginConsoleStore(): PluginConsoleStore {
  let entries: ConsoleEntry[] = []
  let seq = 0
  const listeners = new Set<() => void>()
  const emit = (next: ConsoleEntry[]) => {
    entries = next
    for (const listener of listeners) listener()
  }

  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getEntries: () => entries,
    append(hook, payload) {
      const entry: ConsoleEntry = {
        seq: seq++,
        at: new Date(),
        hook,
        summary: summarizeHookPayload(hook, payload),
      }
      emit([...entries, entry].slice(-MAX_CONSOLE_ENTRIES))
    },
    clear() {
      emit([])
    },
  }
}
