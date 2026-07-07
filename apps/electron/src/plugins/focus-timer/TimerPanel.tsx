/**
 * Focus Timer plugin — panel UI
 *
 * A slim horizontal strip for the top dock: start/pause/reset controls, the
 * remaining time, a progress fill, duration presets, and the persisted
 * completed-session count. All state lives in the plugin's timer store so the
 * declared commands (keybinding path) drive exactly what the buttons drive.
 */

import { useEffect, useRef, useSyncExternalStore } from 'react'
import { Pause, Play, RotateCcw } from 'lucide-react'
import type { PluginPanelProps } from '../../renderer/plugins/types'
import {
  DURATION_PRESETS_MINUTES,
  formatRemaining,
  type FocusTimerStore,
} from './timer-store'

/** UI tick — real elapsed time is measured, so throttling can't drift the clock */
const TICK_INTERVAL_MS = 250

export function createTimerPanel(store: FocusTimerStore) {
  return function TimerPanel(_props: PluginPanelProps) {
    const state = useSyncExternalStore(store.subscribe, store.getState, store.getState)
    const lastTickRef = useRef<number | null>(null)

    // Drive the store's clock while running; the store itself stays passive.
    useEffect(() => {
      if (state.phase !== 'running') {
        lastTickRef.current = null
        return
      }
      lastTickRef.current = Date.now()
      const interval = setInterval(() => {
        const now = Date.now()
        store.tick(now - (lastTickRef.current ?? now))
        lastTickRef.current = now
      }, TICK_INTERVAL_MS)
      return () => clearInterval(interval)
    }, [state.phase])

    const totalMs = state.durationMinutes * 60_000
    const progress = totalMs > 0 ? 1 - state.remainingMs / totalMs : 0
    const running = state.phase === 'running'
    const done = state.phase === 'done'

    const presetButton = (minutes: number) => (
      <button
        key={minutes}
        onClick={() => store.setDurationMinutes(minutes)}
        aria-label={`Focus for ${minutes} minutes`}
        aria-pressed={state.durationMinutes === minutes}
        className={`px-2 h-6 rounded-md text-[11px] tabular-nums transition-colors ${
          state.durationMinutes === minutes
            ? 'bg-foreground/10 text-foreground font-medium'
            : 'text-muted-foreground hover:text-foreground hover:bg-foreground/5'
        }`}
      >
        {minutes}m
      </button>
    )

    return (
      <div className="h-full flex items-center gap-3 px-4">
        <button
          onClick={() => store.toggle()}
          aria-label={running ? 'Pause' : 'Start'}
          className="w-8 h-8 shrink-0 rounded-full bg-foreground/10 hover:bg-foreground/15 flex items-center justify-center"
        >
          {running ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5 ml-0.5" />}
        </button>
        <button
          onClick={() => store.reset()}
          aria-label="Reset"
          className="p-1.5 shrink-0 rounded-md text-muted-foreground hover:text-foreground hover:bg-foreground/5"
        >
          <RotateCcw className="h-3.5 w-3.5" />
        </button>

        <div
          data-testid="focus-timer-time"
          data-phase={state.phase}
          className="shrink-0 text-xl font-semibold tabular-nums font-mono"
        >
          {formatRemaining(state.remainingMs)}
        </div>

        <div className="flex-1 min-w-0 h-1.5 rounded-full bg-foreground/10 overflow-hidden">
          <div
            className={`h-full rounded-full transition-[width] duration-300 ${done ? 'bg-emerald-500' : 'bg-foreground/50'}`}
            style={{ width: `${Math.min(100, Math.max(0, progress * 100))}%` }}
          />
        </div>

        <div className="shrink-0 text-[12px] text-muted-foreground w-28 text-center">
          {done ? 'Focus complete ✓' : running ? 'Focusing…' : state.phase === 'paused' ? 'Paused' : 'Ready'}
        </div>

        <div className="shrink-0 flex items-center gap-1">
          {DURATION_PRESETS_MINUTES.map(presetButton)}
        </div>

        <div
          data-testid="focus-timer-completed"
          className="shrink-0 text-[11px] text-muted-foreground tabular-nums"
          title="Completed focus sessions (persisted)"
        >
          {`🏁 ${state.completedSessions}`}
        </div>
      </div>
    )
  }
}
