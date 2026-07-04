/**
 * PluginPaneHost
 *
 * Renders one shell edge's plugin-contributed panels:
 * - the open pane (header + active panel body) as a flex sibling of the
 *   panel stack, on the edge given by the `location` prop
 * - a thin toggle rail with one icon button per registered panel
 *
 * Renders nothing when no plugin has registered a panel on this edge, so
 * core layouts are untouched unless a plugin is active. Contributed
 * components are mounted behind an error boundary — a crashing panel is
 * quarantined with a retry affordance and reported to Settings; it can never
 * take down the shell. Declared-but-not-yet-activated panels trigger lazy
 * activation when opened.
 *
 * The plugin runtime itself is bootstrapped at app level (AppShell), not
 * here: plugins activate even when no pane host is mounted.
 */

import { Component, useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from '@craft-agent/ui'
import type { PluginPanelLocation } from '@craft-agent/shared/plugins/types'
import { RADIUS_INNER, PANEL_SASH_HIT_WIDTH, PANEL_SASH_LINE_WIDTH } from '../components/app-shell/panel-constants'
import { ensurePluginPanelReady, retryPluginPanel, reportPluginPanelCrash } from './runtime'
import {
  usePluginPaneState,
  togglePluginPanel,
  closePluginPane,
  setPluginPaneWidth,
  PLUGIN_PANE_MIN_WIDTH,
  PLUGIN_PANE_MAX_WIDTH,
  type RegisteredPluginPanel,
} from './panel-store'

interface PanelErrorBoundaryProps {
  panelKey: string
  pluginId: string
  children: ReactNode
}

/**
 * Quarantines a crashing contributed component: flips the panel to its
 * 'error' state (rendered by the host below) and attributes the crash to the
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
    // The store now marks the panel 'error', so the host renders the error
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
        <div className="text-sm font-medium">{t('pluginPane.panelFailed')}</div>
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

export function PluginPaneHost({ location }: { location: PluginPanelLocation }) {
  const { t } = useTranslation()
  const { panels: allPanels, edges } = usePluginPaneState()
  const [isResizing, setIsResizing] = useState(false)
  const paneRef = useRef<HTMLDivElement>(null)

  const panels = allPanels.filter((p) => p.location === location)
  const edge = edges[location]

  const onSashMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setIsResizing(true)
  }, [])

  useEffect(() => {
    if (!isResizing) return
    const onMouseMove = (e: MouseEvent) => {
      const pane = paneRef.current
      if (!pane) return
      const rect = pane.getBoundingClientRect()
      const next = location === 'right' ? rect.right - e.clientX : e.clientX - rect.left
      setPluginPaneWidth(location, Math.min(PLUGIN_PANE_MAX_WIDTH, Math.max(PLUGIN_PANE_MIN_WIDTH, next)))
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

  const activePanel = panels.find((p) => p.key === edge.activePanelKey) ?? null
  const showPane = edge.isOpen && activePanel !== null

  const pane = showPane && (
    <div
      ref={paneRef}
      data-panel-role="plugin-pane"
      data-panel-location={location}
      className="h-full relative shrink-0 bg-background shadow-middle overflow-hidden flex flex-col"
      style={{
        width: edge.width,
        borderRadius: RADIUS_INNER,
        transition: isResizing ? undefined : 'width 0.15s ease-out',
      }}
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-3 h-10 shrink-0 border-b border-border/50">
        {activePanel.icon && (
          <span className="text-sm leading-none" aria-hidden="true">{activePanel.icon}</span>
        )}
        <span className="flex-1 text-sm font-medium truncate">{activePanel.title}</span>
        <button
          onClick={() => closePluginPane(location)}
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

      {/* Resize sash (on the inner edge, toward the panel stack) */}
      <div
        onMouseDown={onSashMouseDown}
        className={cn(
          'absolute inset-y-0 cursor-col-resize flex justify-center z-10',
          location === 'right' ? 'left-0' : 'right-0',
        )}
        style={{ width: PANEL_SASH_HIT_WIDTH }}
      >
        <div
          className={cn('h-full transition-colors', isResizing ? 'bg-foreground/20' : 'hover:bg-foreground/10')}
          style={{ width: PANEL_SASH_LINE_WIDTH }}
        />
      </div>
    </div>
  )

  const rail = (
    <div
      data-panel-role="plugin-rail"
      data-panel-location={location}
      className="h-full shrink-0 flex flex-col items-center gap-1 py-2"
      style={{ width: 30 }}
    >
      {panels.map((panel) => {
        const isActive = showPane && panel.key === edge.activePanelKey
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
            <TooltipContent side={location === 'right' ? 'left' : 'right'}>{panel.title}</TooltipContent>
          </Tooltip>
        )
      })}
    </div>
  )

  // The rail hugs the window edge: outside the pane on both sides.
  return location === 'right' ? (
    <>
      {pane}
      {rail}
    </>
  ) : (
    <>
      {rail}
      {pane}
    </>
  )
}
