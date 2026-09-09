/**
 * Plugin Panel Store
 *
 * Registry + visibility state for plugin-contributed panels. This is a
 * plain external store (useSyncExternalStore) rather than jotai because
 * registrations happen from plugin activation code that runs outside the
 * React tree (the app's JotaiProvider store is not reachable from there).
 *
 * The store is the contribution-slot registry for the `sidePanel.*` slots:
 * panels carry a `location` (one of PLUGIN_PANEL_LOCATIONS — every shell
 * edge, the Emacs side-window model) and each edge's dock keeps its own
 * open/active/size state. Vertical docks (left/right) size by width,
 * horizontal docks (top/bottom) by height. Adding a future location is a
 * data change here plus one dock mount — not a new architecture.
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
  isHorizontalPanelEdge,
  type PluginPanelLocation,
  type PluginSidePanelDeclaration,
} from '@craft-agent/shared/plugins/types'
import * as storage from '@/lib/local-storage'
import type { PluginPanelProps, PluginSidePanelContribution } from './types'
import { pluginHostHooks } from './host-hooks'

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

export interface PluginPanelDockState {
  /** Key of the panel shown when this dock is open */
  activePanelKey: string | null
  isOpen: boolean
  /** Width for vertical docks (left/right), height for horizontal (top/bottom) */
  size: number
}

export interface PluginPanelStoreState {
  panels: RegisteredPluginPanel[]
  docks: Record<PluginPanelLocation, PluginPanelDockState>
}

/** Per-orientation dock size limits (px along the resize axis) */
export const PLUGIN_PANEL_DOCK_SIZE = {
  vertical: { min: 280, max: 900, default: 420 },
  horizontal: { min: 140, max: 600, default: 280 },
} as const

function sizeLimits(location: PluginPanelLocation) {
  return PLUGIN_PANEL_DOCK_SIZE[isHorizontalPanelEdge(location) ? 'horizontal' : 'vertical']
}

function clampSize(location: PluginPanelLocation, size: number): number {
  const { min, max } = sizeLimits(location)
  return Math.min(max, Math.max(min, Math.round(size)))
}

// ============================================================
// Per-window persistence (sessionStorage first, localStorage seed)
// ============================================================

function readPersisted<T>(key: storage.StorageKey, fallback: T, location: PluginPanelLocation): T {
  try {
    const raw = window.sessionStorage.getItem(storage.getKeyString(key, location))
    if (raw !== null) return JSON.parse(raw) as T
  } catch {
    // sessionStorage unavailable (tests, SSR) — fall through to the seed
  }
  try {
    const seeded = storage.getRaw(key, location)
    if (seeded !== null) return JSON.parse(seeded) as T
  } catch {
    // localStorage unavailable or corrupt entry — use the fallback
  }
  return fallback
}

function writePersisted<T>(key: storage.StorageKey, value: T, location: PluginPanelLocation): void {
  try {
    window.sessionStorage.setItem(storage.getKeyString(key, location), JSON.stringify(value))
  } catch {
    // ignore — persistence is best-effort
  }
  storage.set(key, value, location)
}

function loadDockState(location: PluginPanelLocation): PluginPanelDockState {
  return {
    activePanelKey: readPersisted<string | null>(storage.KEYS.pluginPanelDockActivePanel, null, location),
    isOpen: readPersisted<boolean>(storage.KEYS.pluginPanelDockOpen, false, location),
    size: clampSize(
      location,
      readPersisted<number>(storage.KEYS.pluginPanelDockSize, sizeLimits(location).default, location),
    ),
  }
}

function persistDockVisibility(location: PluginPanelLocation, dock: PluginPanelDockState): void {
  writePersisted(storage.KEYS.pluginPanelDockOpen, dock.isOpen, location)
  writePersisted(storage.KEYS.pluginPanelDockActivePanel, dock.activePanelKey, location)
}

function initialState(): PluginPanelStoreState {
  const docks = {} as Record<PluginPanelLocation, PluginPanelDockState>
  for (const location of PLUGIN_PANEL_LOCATIONS) {
    docks[location] = loadDockState(location)
  }
  return { panels: [], docks }
}

let state: PluginPanelStoreState = initialState()

const listeners = new Set<() => void>()

function emit(next: PluginPanelStoreState): void {
  state = next
  for (const listener of listeners) listener()
}

export function panelKey(pluginId: string, panelId: string): string {
  return `${pluginId}:${panelId}`
}

function withDock(
  next: Pick<PluginPanelStoreState, 'panels'> & { docks?: PluginPanelStoreState['docks'] },
  location: PluginPanelLocation,
  dock: PluginPanelDockState,
): PluginPanelStoreState {
  const docks = { ...(next.docks ?? state.docks), [location]: dock }
  persistDockVisibility(location, dock)
  return { panels: next.panels, docks }
}

/**
 * Recompute a dock after panels changed. Only a *removal* of the active
 * panel reassigns or closes the dock — an active key that simply hasn't been
 * declared yet (startup restore races plugin declaration order) is left
 * untouched, so the dock reappears when its panel arrives instead of being
 * stolen by whichever plugin declares first. Persisted state is only
 * rewritten when the dock actually changes.
 */
function reconcileDock(
  oldPanels: RegisteredPluginPanel[],
  newPanels: RegisteredPluginPanel[],
  location: PluginPanelLocation,
): PluginPanelDockState {
  const dock = state.docks[location]
  if (!dock.activePanelKey) return dock
  const key = dock.activePanelKey
  const isPresent = newPanels.some((p) => p.key === key && p.location === location)
  if (isPresent) return dock
  const wasPresent = oldPanels.some((p) => p.key === key && p.location === location)
  if (!wasPresent) return dock
  // Active panel was removed: fall back to the first remaining panel, or close.
  const fallback = newPanels.find((p) => p.location === location)?.key ?? null
  const next = {
    ...dock,
    activePanelKey: dock.isOpen ? fallback : null,
    isOpen: dock.isOpen && fallback !== null,
  }
  if (next.activePanelKey === dock.activePanelKey && next.isOpen === dock.isOpen) return dock
  return next
}

function emitPanels(panels: RegisteredPluginPanel[]): void {
  const oldPanels = state.panels
  let next: PluginPanelStoreState = { ...state, panels }
  for (const location of PLUGIN_PANEL_LOCATIONS) {
    const dock = reconcileDock(oldPanels, panels, location)
    if (dock !== state.docks[location]) {
      next = withDock(next, location, dock)
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
// Dock visibility mutations (called from dock UI and plugins)
// ============================================================

/** `${pluginId}:${panelId}` → hook payload parts (plugin ids contain no ':') */
function splitPanelKey(key: string): { pluginId: string; panelId: string } {
  const separator = key.indexOf(':')
  return { pluginId: key.slice(0, separator), panelId: key.slice(separator + 1) }
}

export function openPluginPanel(key: string): void {
  const panel = state.panels.find((p) => p.key === key)
  if (!panel) return
  const dock = state.docks[panel.location]
  const wasOpenHere = dock.isOpen && dock.activePanelKey === key
  emit(withDock(state, panel.location, {
    ...dock,
    activePanelKey: key,
    isOpen: true,
  }))
  if (!wasOpenHere) {
    pluginHostHooks.emit('panel:opened', { ...splitPanelKey(key), location: panel.location })
  }
}

export function closePluginPanelDock(location: PluginPanelLocation): void {
  const dock = state.docks[location]
  if (!dock.isOpen) return
  emit(withDock(state, location, { ...dock, isOpen: false }))
  if (dock.activePanelKey) {
    pluginHostHooks.emit('panel:closed', { ...splitPanelKey(dock.activePanelKey), location })
  }
}

/** Rail click behavior: focus if hidden/other panel, close if already active */
export function togglePluginPanel(key: string): void {
  const panel = state.panels.find((p) => p.key === key)
  if (!panel) return
  const dock = state.docks[panel.location]
  if (dock.isOpen && dock.activePanelKey === key) {
    closePluginPanelDock(panel.location)
  } else {
    openPluginPanel(key)
  }
}

export function setPluginPanelDockSize(location: PluginPanelLocation, size: number): void {
  const clamped = clampSize(location, size)
  const dock = state.docks[location]
  if (clamped === dock.size) return
  writePersisted(storage.KEYS.pluginPanelDockSize, clamped, location)
  emit({ ...state, docks: { ...state.docks, [location]: { ...dock, size: clamped } } })
}

// ============================================================
// Subscription
// ============================================================

export function subscribePluginPanels(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getPluginPanelState(): PluginPanelStoreState {
  return state
}

export function usePluginPanelState(): PluginPanelStoreState {
  return useSyncExternalStore(subscribePluginPanels, getPluginPanelState)
}

/** Is a dock open on a panel that actually exists? */
export function isPluginPanelDockVisible(location: PluginPanelLocation): boolean {
  const dock = state.docks[location]
  return dock.isOpen
    && dock.activePanelKey !== null
    && state.panels.some((p) => p.key === dock.activePanelKey && p.location === location)
}

/** Reactive variant of isPluginPanelDockVisible for core layout wiring (AppShell) */
export function usePluginPanelDockVisible(location: PluginPanelLocation): boolean {
  return useSyncExternalStore(subscribePluginPanels, () => isPluginPanelDockVisible(location))
}

/**
 * TEST ONLY: force a dock's state, bypassing panel-existence checks, to
 * simulate persisted state restored before any plugin has declared its
 * panels. Never call from product code.
 */
export function __setDockStateForTests(location: PluginPanelLocation, dock: PluginPanelDockState): void {
  emit({ ...state, docks: { ...state.docks, [location]: dock } })
}
