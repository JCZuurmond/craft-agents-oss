/**
 * Plugin Console plugin — panel UI
 *
 * A terminal-style event log for the bottom dock: one monospace row per
 * observed host-hook event, pinned to the newest entry while the panel is
 * visible, with a clear control in the footer.
 */

import { useEffect, useRef, useSyncExternalStore } from 'react'
import type { PluginPanelProps } from '../../renderer/plugins/types'
import type { PluginConsoleStore } from './console-store'

const HOOK_TINTS: Record<string, string> = {
  'app:ready': 'text-emerald-500',
  'plugin:activated': 'text-sky-500',
  'plugin:deactivated': 'text-amber-500',
  'panel:opened': 'text-violet-500',
  'panel:closed': 'text-violet-400/70',
  'command:executed': 'text-pink-500',
}

function formatTime(at: Date): string {
  const pad = (value: number, width = 2) => String(value).padStart(width, '0')
  return `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}.${pad(at.getMilliseconds(), 3)}`
}

export function createConsolePanel(store: PluginConsoleStore) {
  return function ConsolePanel({ isActive }: PluginPanelProps) {
    const entries = useSyncExternalStore(store.subscribe, store.getEntries, store.getEntries)
    const scrollRef = useRef<HTMLDivElement | null>(null)

    // Pin to the newest entry while visible.
    useEffect(() => {
      if (!isActive) return
      const el = scrollRef.current
      if (el) el.scrollTop = el.scrollHeight
    }, [entries.length, isActive])

    return (
      <div className="h-full flex flex-col font-mono text-[12px]">
        <div ref={scrollRef} data-testid="plugin-console-log" className="flex-1 min-h-0 overflow-y-auto px-3 py-2">
          {entries.length === 0 ? (
            <div className="h-full flex items-center justify-center text-muted-foreground/70 font-sans text-[13px]">
              No framework events yet — open a panel or run a plugin command.
            </div>
          ) : (
            entries.map((entry) => (
              <div key={entry.seq} className="flex items-baseline gap-2 py-0.5 whitespace-nowrap">
                <span className="text-muted-foreground/60 shrink-0">{formatTime(entry.at)}</span>
                <span className={`shrink-0 w-40 ${HOOK_TINTS[entry.hook] ?? 'text-foreground'}`}>{entry.hook}</span>
                <span className="text-muted-foreground truncate">{entry.summary}</span>
              </div>
            ))
          )}
        </div>
        <div className="shrink-0 flex items-center gap-2 px-3 h-8 border-t border-border/50 text-[11px] text-muted-foreground font-sans">
          <span data-testid="plugin-console-count">
            {`${entries.length} event${entries.length === 1 ? '' : 's'}`}
          </span>
          <span className="text-muted-foreground/50">· observing framework hooks since activation</span>
          <span className="flex-1" />
          <button
            onClick={() => store.clear()}
            disabled={entries.length === 0}
            aria-label="Clear console"
            className="px-2 py-0.5 rounded-md enabled:hover:text-foreground enabled:hover:bg-foreground/5 disabled:opacity-40"
          >
            Clear
          </button>
        </div>
      </div>
    )
  }
}
