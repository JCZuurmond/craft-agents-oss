/**
 * Plugin Panel Store
 *
 * Registry + visibility state for plugin-contributed side panels. This is a
 * plain external store (useSyncExternalStore) rather than jotai because
 * registrations happen from plugin activation code that runs outside the
 * React tree (the app's JotaiProvider store is not reachable from there).
 *
 * The store is the contribution-slot registry for the `sidePanel.*` slots:
 * panels carry a `location` (one of PLUGIN_PANEL_LOCATIONS) and each shell
 * edge keeps its own open/active/width state. Adding a future edge is a data
 * change here plus one host mount in AppShell — not a new architecture.
 *
 * Panels exist in one of three runtime states:
 * - 'declared' — known from the manifest's `contributes.sidePanels` block;
 *   rendered in the toggle rail, but the plugin hasn't been activated yet
 *   (lazy activation: opening the panel activates the plugin).
 * - 'ready'    — the plugin registered the panel component.
 * - 'error'    — activation failed, the component crashed, or the plugin
 *   never registered a declared panel.
 *
 * Persistence: each window keeps its own live state via sessionStorage
 * (per-window in Electron, survives reloads); localStorage holds the
 * last-written seed used by new windows and the next app launch. Two open
 * windows therefore never fight over each other's active panel.
 */

import { useSyncExternalStore } from 'react'
import type { ComponentType } from 'react'
import {
  PLUGIN_PANEL_LOCATIONS,
  DEFAULT_PLUGIN_PANEL_LOCATION,
  type PluginPanelLocation,
  type PluginSidePanelDeclaration,
} from '@craft-agent/shared/plugins/types'
import * as storage from '@/lib/local-storage'
import type { PluginPanelProps, PluginSidePanelContribution } from './types'

export type PluginPanelStatus = 'declared' | 'ready' | 'error'

export interface RegisteredPluginPanel {
  /** Globally unique panel key: `${pluginId}:${panelId}` */
  key: string
  pluginId: string
  location: PluginPanelLocation
  title: string
  icon?: string
  /** Panel body; null until the plugin registers it ('declared'/'error') */
  component: ComponentType<PluginPanelProps> | null
  status: PluginPanelStatus
  /** Populated when status === 'error' */
  error?: string
  /** True when the panel came from the manifest's declarative contributions */
  declared: boolean
}

export interface PluginPaneEdgeState {
  /** Key of the panel shown when this edge's pane is open */
  activePanelKey: string | null
  isOpen: boolean
  width: number
}

export interface PluginPaneState {
  panels: RegisteredPluginPanel[]
  edges: Record<PluginPanelLocation, PluginPaneEdgeState>
}

export const PLUGIN_PANE_MIN_WIDTH = 280
export const PLUGIN_PANE_MAX_WIDTH = 900
export const PLUGIN_PANE_DEFAULT_WIDTH = 420

function clampWidth(width: number): number {
  return Math.min(PLUGIN_PANE_MAX_WIDTH, Math.max(PLUGIN_PANE_MIN_WIDTH, Math.round(width)))
}

// ============================================================
// Per-window persistence (sessionStorage first, localStorage seed)
// ============================================================

function readPersisted<T>(key: storage.StorageKey, fallback: T, location: PluginPanelLocation): T {
  const fullKey = storage.getKeyString(key, location)
  try {
    const raw = window.sessionStorage.getItem(fullKey)
    if (raw !== null) return JSON.parse(raw) as T
  } catch {
    // sessionStorage unavailable (tests, SSR) — fall through to the seed
  }
  const seeded = storage.get(key, fallback, location)
  if (seeded !== fallback) return seeded
  // Migration: pre-location state was persisted unsuffixed for the right edge.
  return location === 'right' ? storage.get(key, fallback) : fallback
}

function writePersisted<T>(key: storage.StorageKey, value: T, location: PluginPanelLocation): void {
  try {
    window.sessionStorage.setItem(storage.getKeyString(key, location), JSON.stringify(value))
  } catch {
    // ignore — persistence is best-effort
  }
  storage.set(key, value, location)
}

function loadEdgeState(location: PluginPanelLocation): PluginPaneEdgeState {
  return {
    activePanelKey: readPersisted<string | null>(storage.KEYS.pluginPaneActivePanel, null, location),
    isOpen: readPersisted<boolean>(storage.KEYS.pluginPaneOpen, false, location),
    width: clampWidth(readPersisted<number>(storage.KEYS.pluginPaneWidth, PLUGIN_PANE_DEFAULT_WIDTH, location)),
  }
}

function persistEdgeVisibility(location: PluginPanelLocation, edge: PluginPaneEdgeState): void {
  writePersisted(storage.KEYS.pluginPaneOpen, edge.isOpen, location)
  writePersisted(storage.KEYS.pluginPaneActivePanel, edge.activePanelKey, location)
}

function initialState(): PluginPaneState {
  const edges = {} as Record<PluginPanelLocation, PluginPaneEdgeState>
  for (const location of PLUGIN_PANEL_LOCATIONS) {
    edges[location] = loadEdgeState(location)
  }
  return { panels: [], edges }
}

let state: PluginPaneState = initialState()

const listeners = new Set<() => void>()

function emit(next: PluginPaneState): void {
  state = next
  for (const listener of listeners) listener()
}

export function panelKey(pluginId: string, panelId: string): string {
  return `${pluginId}:${panelId}`
}

function withEdge(
  next: Pick<PluginPaneState, 'panels'> & { edges?: PluginPaneState['edges'] },
  location: PluginPanelLocation,
  edge: PluginPaneEdgeState,
): PluginPaneState {
  const edges = { ...(next.edges ?? state.edges), [location]: edge }
  persistEdgeVisibility(location, edge)
  return { panels: next.panels, edges }
}

/** Recompute an edge after panels changed: drop dangling active keys */
function reconcileEdge(panels: RegisteredPluginPanel[], location: PluginPanelLocation): PluginPaneEdgeState {
  const edge = state.edges[location]
  const edgePanels = panels.filter((p) => p.location === location)
  if (edge.activePanelKey && edgePanels.some((p) => p.key === edge.activePanelKey)) return edge
  // Active panel disappeared: fall back to the first remaining panel, or close.
  const fallback = edgePanels[0]?.key ?? null
  return {
    ...edge,
    activePanelKey: edge.isOpen ? fallback : null,
    isOpen: edge.isOpen && fallback !== null,
  }
}

function emitPanels(panels: RegisteredPluginPanel[]): void {
  let next: PluginPaneState = { ...state, panels }
  for (const location of PLUGIN_PANEL_LOCATIONS) {
    const edge = reconcileEdge(panels, location)
    if (edge !== state.edges[location]) {
      next = withEdge(next, location, edge)
    }
  }
  emit(next)
}

// ============================================================
// Panel registry mutations (called from the plugin runtime)
// ============================================================

/**
 * Seed panels from a manifest's declarative `contributes.sidePanels` block.
 * Declared panels render in the toggle rail before the plugin is activated;
 * opening one triggers lazy activation. Existing keys are left untouched.
 */
export function declarePluginPanels(
  pluginId: string,
  declarations: PluginSidePanelDeclaration[],
  fallbackIcon?: string,
): void {
  const additions = declarations
    .filter((d) => !state.panels.some((p) => p.key === panelKey(pluginId, d.id)))
    .map((d): RegisteredPluginPanel => ({
      key: panelKey(pluginId, d.id),
      pluginId,
      location: d.location ?? DEFAULT_PLUGIN_PANEL_LOCATION,
      title: d.title,
      icon: d.icon ?? fallbackIcon,
      component: null,
      status: 'declared',
      declared: true,
    }))
  if (additions.length === 0) return
  emitPanels([...state.panels, ...additions])
}

/** Remove every panel a plugin contributed (declared and imperative) */
export function removePluginPanels(pluginId: string): void {
  const panels = state.panels.filter((p) => p.pluginId !== pluginId)
  if (panels.length === state.panels.length) return
  emitPanels(panels)
}

/**
 * Register a panel component from plugin code (`ctx.ui.registerSidePanel`).
 * If the panel was declared in the manifest, the declaration is the source of
 * truth for title/icon/location and the registration fills in the component;
 * an undeclared registration contributes a complete new panel (eager path).
 * Returns an unregister function (declared panels revert to 'declared').
 */
export function registerPluginPanel(pluginId: string, contribution: PluginSidePanelContribution): () => void {
  const key = panelKey(pluginId, contribution.id)
  const existing = state.panels.find((p) => p.key === key)

  if (existing) {
    if (existing.status === 'ready') {
      throw new Error(`Plugin panel already registered: ${key}`)
    }
    emitPanels(state.panels.map((p) => (
      p.key === key
        ? {
            ...p,
            title: p.declared ? p.title : contribution.title,
            icon: (p.declared ? p.icon : undefined) ?? contribution.icon,
            component: contribution.component,
            status: 'ready',
            error: undefined,
          }
        : p
    )))
    return () => unregisterPluginPanel(key)
  }

  emitPanels([
    ...state.panels,
    {
      key,
      pluginId,
      location: contribution.location ?? DEFAULT_PLUGIN_PANEL_LOCATION,
      title: contribution.title,
      icon: contribution.icon,
      component: contribution.component,
      status: 'ready',
      declared: false,
    },
  ])
  return () => unregisterPluginPanel(key)
}

export function unregisterPluginPanel(key: string): void {
  const existing = state.panels.find((p) => p.key === key)
  if (!existing) return
  if (existing.declared) {
    // Keep the declared shell so the rail still shows the panel; the next
    // activation re-registers the component.
    emitPanels(state.panels.map((p) => (
      p.key === key ? { ...p, component: null, status: 'declared', error: undefined } : p
    )))
    return
  }
  emitPanels(state.panels.filter((p) => p.key !== key))
}

/** Mark one panel errored (activation failure, missing registration, crash) */
export function markPluginPanelError(key: string, error: string): void {
  if (!state.panels.some((p) => p.key === key)) return
  emitPanels(state.panels.map((p) => (p.key === key ? { ...p, status: 'error', error } : p)))
}

/** Mark all of a plugin's not-ready panels errored (activation failure) */
export function markPluginPanelsError(pluginId: string, error: string): void {
  if (!state.panels.some((p) => p.pluginId === pluginId && p.status !== 'ready')) return
  emitPanels(state.panels.map((p) => (
    p.pluginId === pluginId && p.status !== 'ready' ? { ...p, status: 'error', error } : p
  )))
}

/** Reset a panel for retry: 'ready' when its component exists, else 'declared' */
export function resetPluginPanel(key: string): void {
  const existing = state.panels.find((p) => p.key === key)
  if (!existing) return
  emitPanels(state.panels.map((p) => (
    p.key === key
      ? { ...p, status: p.component ? 'ready' : 'declared', error: undefined }
      : p
  )))
}

// ============================================================
// Edge visibility mutations (called from pane host UI and plugins)
// ============================================================

export function openPluginPanel(key: string): void {
  const panel = state.panels.find((p) => p.key === key)
  if (!panel) return
  emit(withEdge(state, panel.location, {
    ...state.edges[panel.location],
    activePanelKey: key,
    isOpen: true,
  }))
}

export function closePluginPane(location: PluginPanelLocation): void {
  const edge = state.edges[location]
  if (!edge.isOpen) return
  emit(withEdge(state, location, { ...edge, isOpen: false }))
}

/** Rail click behavior: focus if hidden/other panel, close if already active */
export function togglePluginPanel(key: string): void {
  const panel = state.panels.find((p) => p.key === key)
  if (!panel) return
  const edge = state.edges[panel.location]
  if (edge.isOpen && edge.activePanelKey === key) {
    closePluginPane(panel.location)
  } else {
    openPluginPanel(key)
  }
}

export function setPluginPaneWidth(location: PluginPanelLocation, width: number): void {
  const clamped = clampWidth(width)
  const edge = state.edges[location]
  if (clamped === edge.width) return
  writePersisted(storage.KEYS.pluginPaneWidth, clamped, location)
  emit({ ...state, edges: { ...state.edges, [location]: { ...edge, width: clamped } } })
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

/** Is an edge's pane open on a panel that actually exists? */
export function isPluginPaneVisible(location: PluginPanelLocation): boolean {
  const edge = state.edges[location]
  return edge.isOpen
    && edge.activePanelKey !== null
    && state.panels.some((p) => p.key === edge.activePanelKey && p.location === location)
}

/** Reactive variant of isPluginPaneVisible for core layout wiring (AppShell) */
export function usePluginPaneVisible(location: PluginPanelLocation): boolean {
  return useSyncExternalStore(subscribePluginPane, () => isPluginPaneVisible(location))
}
