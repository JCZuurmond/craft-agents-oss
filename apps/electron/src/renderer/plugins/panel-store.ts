/**
 * Plugin Panel Store
 *
 * Registry + visibility state for plugin-contributed side panes. This is a
 * plain external store (useSyncExternalStore) rather than jotai because
 * registrations happen from plugin activation code that runs outside the
 * React tree (the app's JotaiProvider store is not reachable from there).
 *
 * Open/width/active-panel state persists via the central localStorage helper.
 */

import { useSyncExternalStore } from 'react'
import * as storage from '@/lib/local-storage'
import type { PluginSidePanelContribution } from './types'

export interface RegisteredPluginPanel {
  /** Globally unique panel key: `${pluginId}:${contribution.id}` */
  key: string
  pluginId: string
  contribution: PluginSidePanelContribution
}

export interface PluginPaneState {
  panels: RegisteredPluginPanel[]
  /** Key of the panel shown when the pane is open */
  activePanelKey: string | null
  isOpen: boolean
  width: number
}

export const PLUGIN_PANE_MIN_WIDTH = 280
export const PLUGIN_PANE_MAX_WIDTH = 900
export const PLUGIN_PANE_DEFAULT_WIDTH = 420

function clampWidth(width: number): number {
  return Math.min(PLUGIN_PANE_MAX_WIDTH, Math.max(PLUGIN_PANE_MIN_WIDTH, Math.round(width)))
}

let state: PluginPaneState = {
  panels: [],
  activePanelKey: storage.get<string | null>(storage.KEYS.pluginPaneActivePanel, null),
  isOpen: storage.get<boolean>(storage.KEYS.pluginPaneOpen, false),
  width: clampWidth(storage.get<number>(storage.KEYS.pluginPaneWidth, PLUGIN_PANE_DEFAULT_WIDTH)),
}

const listeners = new Set<() => void>()

function emit(next: PluginPaneState): void {
  state = next
  for (const listener of listeners) listener()
}

function persistVisibility(next: PluginPaneState): void {
  storage.set(storage.KEYS.pluginPaneOpen, next.isOpen)
  storage.set(storage.KEYS.pluginPaneActivePanel, next.activePanelKey)
}

export function panelKey(pluginId: string, panelId: string): string {
  return `${pluginId}:${panelId}`
}

// ============================================================
// Mutations (called from plugin runtime and pane host UI)
// ============================================================

export function registerPluginPanel(pluginId: string, contribution: PluginSidePanelContribution): () => void {
  const key = panelKey(pluginId, contribution.id)
  if (state.panels.some((p) => p.key === key)) {
    throw new Error(`Plugin panel already registered: ${key}`)
  }
  emit({ ...state, panels: [...state.panels, { key, pluginId, contribution }] })
  return () => unregisterPluginPanel(key)
}

export function unregisterPluginPanel(key: string): void {
  const panels = state.panels.filter((p) => p.key !== key)
  if (panels.length === state.panels.length) return
  const next: PluginPaneState = {
    ...state,
    panels,
    activePanelKey: state.activePanelKey === key ? null : state.activePanelKey,
    isOpen: state.isOpen && !(state.activePanelKey === key && panels.length === 0),
  }
  // If the active panel disappeared but others remain, fall back to the first.
  if (next.isOpen && next.activePanelKey === null) {
    next.activePanelKey = panels[0]?.key ?? null
    next.isOpen = next.activePanelKey !== null
  }
  persistVisibility(next)
  emit(next)
}

export function openPluginPanel(key: string): void {
  if (!state.panels.some((p) => p.key === key)) return
  const next = { ...state, activePanelKey: key, isOpen: true }
  persistVisibility(next)
  emit(next)
}

export function closePluginPane(): void {
  if (!state.isOpen) return
  const next = { ...state, isOpen: false }
  persistVisibility(next)
  emit(next)
}

/** Rail click behavior: focus if hidden/other panel, close if already active */
export function togglePluginPanel(key: string): void {
  if (state.isOpen && state.activePanelKey === key) {
    closePluginPane()
  } else {
    openPluginPanel(key)
  }
}

export function setPluginPaneWidth(width: number): void {
  const clamped = clampWidth(width)
  if (clamped === state.width) return
  storage.set(storage.KEYS.pluginPaneWidth, clamped)
  emit({ ...state, width: clamped })
}

// ============================================================
// Subscription
// ============================================================

export function subscribePluginPane(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getPluginPaneState(): PluginPaneState {
  return state
}

export function usePluginPaneState(): PluginPaneState {
  return useSyncExternalStore(subscribePluginPane, getPluginPaneState)
}

/** Lightweight check for AppShell's isRightSidebarVisible wiring */
export function isPluginPaneVisible(): boolean {
  return state.isOpen && state.panels.length > 0 && state.activePanelKey !== null
}
