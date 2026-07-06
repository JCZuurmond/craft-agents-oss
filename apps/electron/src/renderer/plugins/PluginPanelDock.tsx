/**
 * PluginPanelDock
 *
 * Renders one shell edge's plugin-contributed panels:
 * - the open dock (header + active panel body) as a flex sibling of its
 *   neighbors, on the edge given by the `location` prop
 * - a thin toggle rail with one icon button per registered panel
 *
 * All four edges are supported — the Emacs side-window model. Vertical
 * docks (left/right) live in the shell's horizontal flex row and resize by
 * width; horizontal docks (top/bottom) live in the content column mounted
 * by PluginPanelArea and resize by height (VS Code's bottom-panel
 * geometry). One component covers both orientations: only the size axis,
 * sash placement, and rail direction differ.
 *
 * Renders nothing when no plugin has registered a panel on this edge, so
 * core layouts are untouched unless a plugin is active. Contributed
 * components are mounted behind an error boundary — a crashing panel is
 * quarantined with a retry affordance and reported to Settings; it can never
 * take down the shell. Declared-but-not-yet-activated panels trigger lazy
 * activation when opened.
 *
 * The plugin runtime itself is bootstrapped at app level (AppShell), not
 * here: plugins activate even when no dock is mounted.
 */

import { Component, useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from '@craft-agent/ui'
import { isHorizontalPanelEdge, type PluginPanelLocation } from '@craft-agent/shared/plugins/types'
import {
  RADIUS_INNER,
  PANEL_GAP,
  PANEL_SASH_HIT_WIDTH,
  PANEL_SASH_LINE_WIDTH,
} from '../components/app-shell/panel-constants'
import { ensurePluginPanelReady, retryPluginPanel, reportPluginPanelCrash } from './runtime'
import {
  usePluginPanelState,
  togglePluginPanel,
  closePluginPanelDock,
  setPluginPanelDockSize,
  type RegisteredPluginPanel,
} from './panel-store'

const RAIL_THICKNESS = 30

/** Tooltip side pointing inward, away from the dock's window edge */
const TOOLTIP_SIDE: Record<PluginPanelLocation, 'left' | 'right' | 'top' | 'bottom'> = {
  left: 'right',
  right: 'left',
  top: 'bottom',
  bottom: 'top',
}

interface PanelErrorBoundaryProps {
  panelKey: string
  pluginId: string
  children: ReactNode
}

/**
 * Quarantines a crashing contributed component: flips the panel to its
 * 'error' state (rendered by the dock below) and attributes the crash to the
 * plugin in Settings. Without this, one plugin's render error unmounts the
 * entire shell.
 */
class PanelErrorBoundary extends Component<PanelErrorBoundaryProps, { hasError: boolean }> {
  state = { hasError: false }

  static getDerivedStateFromError() {
    return { hasError: true }
  }

  componentDidCatch(error: unknown) {
    reportPluginPanelCrash(this.props.panelKey, this.props.pluginId, error)
  }

  render() {
    // The store now marks the panel 'error', so the dock renders the error
    // state instead of these children on the next pass.
    if (this.state.hasError) return null
    return this.props.children
  }
}

function PanelBody({ panel }: { panel: RegisteredPluginPanel }) {
  const { t } = useTranslation()

  // Lazy activation: a declared panel's plugin activates on first open.
  useEffect(() => {
    if (panel.status === 'declared') {
      void ensurePluginPanelReady(panel.key)
    }
  }, [panel.key, panel.status])

  if (panel.status === 'error') {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-3 px-6 text-center">
        <div className="text-sm font-medium">{t('pluginPanel.failed')}</div>
        {panel.error && (
          <div className="text-xs text-muted-foreground break-words max-w-full">{panel.error}</div>
        )}
        <button
          onClick={() => { void retryPluginPanel(panel.key) }}
          className="px-3 py-1.5 text-xs rounded-md bg-foreground/10 hover:bg-foreground/15"
        >
          {t('common.retry')}
        </button>
      </div>
    )
  }

  if (panel.status === 'declared' || !panel.component) {
    return (
      <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
        {t('common.loading')}
      </div>
    )
  }

  return (
    <PanelErrorBoundary key={panel.key} panelKey={panel.key} pluginId={panel.pluginId}>
      <panel.component isActive={true} />
    </PanelErrorBoundary>
  )
}

export function PluginPanelDock({ location }: { location: PluginPanelLocation }) {
  const { t } = useTranslation()
  const { panels: allPanels, docks } = usePluginPanelState()
  const [isResizing, setIsResizing] = useState(false)
  const dockRef = useRef<HTMLDivElement>(null)

  const horizontal = isHorizontalPanelEdge(location)
  const panels = allPanels.filter((p) => p.location === location)
  const dock = docks[location]

  const onSashMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setIsResizing(true)
  }, [])

  useEffect(() => {
    if (!isResizing) return
    const onMouseMove = (e: MouseEvent) => {
      const el = dockRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      // Size grows toward the shell's center: measured from the dock's own
      // window edge to the pointer.
      const next =
        location === 'right' ? rect.right - e.clientX
        : location === 'left' ? e.clientX - rect.left
        : location === 'bottom' ? rect.bottom - e.clientY
        : e.clientY - rect.top
      setPluginPanelDockSize(location, next)
    }
    const onMouseUp = () => setIsResizing(false)
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
  }, [isResizing, location])

  if (panels.length === 0) return null

  const activePanel = panels.find((p) => p.key === dock.activePanelKey) ?? null
  const showDock = dock.isOpen && activePanel !== null

  const openDock = showDock && (
    <div
      ref={dockRef}
      data-panel-role="plugin-dock"
      data-panel-location={location}
      className={cn(
        'relative shrink-0 bg-background shadow-middle overflow-hidden flex flex-col',
        horizontal ? 'w-full' : 'h-full',
      )}
      style={{
        [horizontal ? 'height' : 'width']: dock.size,
        borderRadius: RADIUS_INNER,
        transition: isResizing ? undefined : `${horizontal ? 'height' : 'width'} 0.15s ease-out`,
      }}
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-3 h-10 shrink-0 border-b border-border/50">
        {activePanel.icon && (
          <span className="text-sm leading-none" aria-hidden="true">{activePanel.icon}</span>
        )}
        <span className="flex-1 text-sm font-medium truncate">{activePanel.title}</span>
        <button
          onClick={() => closePluginPanelDock(location)}
          className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-foreground/5"
          aria-label={t('common.close')}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Active panel body */}
      <div className="flex-1 min-h-0">
        <PanelBody panel={activePanel} />
      </div>

      {/* Resize sash on the inner edge, toward the shell's center */}
      <div
        onMouseDown={onSashMouseDown}
        className={cn(
          'absolute flex z-10',
          horizontal
            ? cn('inset-x-0 cursor-row-resize flex-col justify-center items-stretch',
                location === 'top' ? 'bottom-0' : 'top-0')
            : cn('inset-y-0 cursor-col-resize justify-center',
                location === 'right' ? 'left-0' : 'right-0'),
        )}
        style={{ [horizontal ? 'height' : 'width']: PANEL_SASH_HIT_WIDTH }}
      >
        <div
          className={cn(
            horizontal ? 'w-full self-center' : 'h-full',
            'transition-colors',
            isResizing ? 'bg-foreground/20' : 'hover:bg-foreground/10',
          )}
          style={{ [horizontal ? 'height' : 'width']: PANEL_SASH_LINE_WIDTH }}
        />
      </div>
    </div>
  )

  const rail = (
    <div
      data-panel-role="plugin-rail"
      data-panel-location={location}
      className={cn(
        'shrink-0 flex items-center gap-1',
        horizontal ? 'w-full flex-row justify-start px-2' : 'h-full flex-col py-2',
      )}
      style={{ [horizontal ? 'height' : 'width']: RAIL_THICKNESS }}
    >
      {panels.map((panel) => {
        const isActive = showDock && panel.key === dock.activePanelKey
        return (
          <Tooltip key={panel.key}>
            <TooltipTrigger asChild>
              <button
                onClick={() => togglePluginPanel(panel.key)}
                aria-label={panel.title}
                aria-pressed={isActive}
                className={cn(
                  'w-7 h-7 rounded-md flex items-center justify-center text-sm transition-colors',
                  isActive
                    ? 'bg-foreground/10 text-foreground'
                    : 'text-muted-foreground hover:text-foreground hover:bg-foreground/5',
                )}
              >
                <span aria-hidden="true">{panel.icon ?? '◧'}</span>
              </button>
            </TooltipTrigger>
            <TooltipContent side={TOOLTIP_SIDE[location]}>{panel.title}</TooltipContent>
          </Tooltip>
        )
      })}
    </div>
  )

  // The rail hugs the window edge: before the dock on left/top, after it on
  // right/bottom. Parent flex direction matches the orientation (row for
  // vertical docks, column for horizontal ones).
  return location === 'right' || location === 'bottom' ? (
    <>
      {openDock}
      {rail}
    </>
  ) : (
    <>
      {rail}
      {openDock}
    </>
  )
}

/**
 * PluginPanelArea
 *
 * Column wrapper that gives the top/bottom docks their mount points around
 * the app's content area (between the vertical docks — VS Code's
 * bottom-panel geometry). AppShell wraps PanelStackContainer with this
 * instead of mounting horizontal docks itself, keeping the core diff to one
 * element. With no top/bottom panels registered the docks render null and
 * this is a plain pass-through flex column.
 */
export function PluginPanelArea({ hidden, children }: { hidden?: boolean; children: ReactNode }) {
  return (
    <div className="flex-1 min-w-0 min-h-0 flex flex-col" style={{ gap: PANEL_GAP }}>
      {!hidden && <PluginPanelDock location="top" />}
      {children}
      {!hidden && <PluginPanelDock location="bottom" />}
    </div>
  )
}
