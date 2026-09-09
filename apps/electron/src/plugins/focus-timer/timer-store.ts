/**
 * Focus Timer plugin — timer state
 *
 * A tiny external store (subscribe/getState) so the same state can be driven
 * from command handlers (keybinding path) and rendered by the panel. Time
 * advances only through tick(elapsedMs) — the component owns the interval,
 * tests advance the clock synchronously.
 *
 * Persistence through the plugin's scoped storage: the preferred duration and
 * the completed-session count survive restarts.
 */

import type { PluginStorage } from '../../renderer/plugins/types'

export const DURATION_PRESETS_MINUTES = [15, 25, 50] as const
export const DEFAULT_DURATION_MINUTES = 25

export const DURATION_STORAGE_KEY = 'duration-minutes'
export const COMPLETED_STORAGE_KEY = 'completed-sessions'

export type FocusTimerPhase = 'idle' | 'running' | 'paused' | 'done'

export interface FocusTimerState {
  phase: FocusTimerPhase
  durationMinutes: number
  remainingMs: number
  completedSessions: number
}

/** "25:00" (mm:ss, rounded up so a running timer never shows 00:00 early) */
export function formatRemaining(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

export interface FocusTimerStore {
  subscribe(listener: () => void): () => void
  getState(): FocusTimerState
  start(): void
  pause(): void
  /** Start when idle/paused/done, pause when running (the keybinding action) */
  toggle(): void
  reset(): void
  setDurationMinutes(minutes: number): void
  /** Advance the clock; no-op unless running. Completion increments the persisted count. */
  tick(elapsedMs: number): void
}

export function createFocusTimerStore(storage: PluginStorage): FocusTimerStore {
  const durationMinutes = storage.get(DURATION_STORAGE_KEY, DEFAULT_DURATION_MINUTES)
  let state: FocusTimerState = {
    phase: 'idle',
    durationMinutes,
    remainingMs: durationMinutes * 60_000,
    completedSessions: storage.get(COMPLETED_STORAGE_KEY, 0),
  }

  const listeners = new Set<() => void>()
  const emit = (next: FocusTimerState) => {
    state = next
    for (const listener of listeners) listener()
  }

  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getState: () => state,

    start() {
      if (state.phase === 'running') return
      const remainingMs = state.phase === 'paused' ? state.remainingMs : state.durationMinutes * 60_000
      emit({ ...state, phase: 'running', remainingMs })
    },

    pause() {
      if (state.phase !== 'running') return
      emit({ ...state, phase: 'paused' })
    },

    toggle() {
      if (state.phase === 'running') this.pause()
      else this.start()
    },

    reset() {
      emit({ ...state, phase: 'idle', remainingMs: state.durationMinutes * 60_000 })
    },

    setDurationMinutes(minutes: number) {
      if (!(minutes > 0)) return
      storage.set(DURATION_STORAGE_KEY, minutes)
      emit({ ...state, phase: 'idle', durationMinutes: minutes, remainingMs: minutes * 60_000 })
    },

    tick(elapsedMs: number) {
      if (state.phase !== 'running' || elapsedMs <= 0) return
      const remainingMs = state.remainingMs - elapsedMs
      if (remainingMs > 0) {
        emit({ ...state, remainingMs })
        return
      }
      const completedSessions = state.completedSessions + 1
      storage.set(COMPLETED_STORAGE_KEY, completedSessions)
      emit({ ...state, phase: 'done', remainingMs: 0, completedSessions })
    },
  }
}
