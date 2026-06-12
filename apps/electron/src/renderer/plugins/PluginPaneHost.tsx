/**
 * PluginPaneHost
 *
 * The single AppShell seam for plugin-contributed UI. Renders:
 * - the open plugin pane (header + active panel component) as a flex sibling
 *   of the panel stack, on the right edge of the shell
 * - a thin toggle rail with one icon button per registered panel
 *
 * Renders nothing when no plugin has registered a panel, so core layouts are
 * untouched unless a plugin is active. Also bootstraps the plugin runtime on
 * first mount.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from '@craft-agent/ui'
import { RADIUS_INNER, PANEL_SASH_HIT_WIDTH, PANEL_SASH_LINE_WIDTH } from '../components/app-shell/panel-constants'
import { initializePluginRuntime } from './runtime'
import {
  usePluginPaneState,
  togglePluginPanel,
  closePluginPane,
  setPluginPaneWidth,
  PLUGIN_PANE_MIN_WIDTH,
  PLUGIN_PANE_MAX_WIDTH,
} from './panel-store'

export function PluginPaneHost() {
  const { t } = useTranslation()
  const { panels, activePanelKey, isOpen, width } = usePluginPaneState()
  const [isResizing, setIsResizing] = useState(false)
  const paneRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void initializePluginRuntime()
  }, [])

  const onSashMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setIsResizing(true)
  }, [])

  useEffect(() => {
    if (!isResizing) return
    const onMouseMove = (e: MouseEvent) => {
      const pane = paneRef.current
      if (!pane) return
      const next = pane.getBoundingClientRect().right - e.clientX
      setPluginPaneWidth(Math.min(PLUGIN_PANE_MAX_WIDTH, Math.max(PLUGIN_PANE_MIN_WIDTH, next)))
    }
    const onMouseUp = () => setIsResizing(false)
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
  }, [isResizing])

  if (panels.length === 0) return null

  const activePanel = panels.find((p) => p.key === activePanelKey) ?? null
  const showPane = isOpen && activePanel !== null

  return (
    <>
      {/* === PLUGIN PANE === */}
      {showPane && (
        <div
          ref={paneRef}
          data-panel-role="plugin-pane"
          className="h-full relative shrink-0 bg-background shadow-middle overflow-hidden flex flex-col"
          style={{
            width,
            borderRadius: RADIUS_INNER,
            transition: isResizing ? undefined : 'width 0.15s ease-out',
          }}
        >
          {/* Header */}
          <div className="flex items-center gap-2 px-3 h-10 shrink-0 border-b border-border/50">
            {activePanel.contribution.icon && (
              <span className="text-sm leading-none" aria-hidden="true">{activePanel.contribution.icon}</span>
            )}
            <span className="flex-1 text-sm font-medium truncate">{activePanel.contribution.title}</span>
            <button
              onClick={closePluginPane}
              className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-foreground/5"
              aria-label={t('common.close')}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>

          {/* Active panel body */}
          <div className="flex-1 min-h-0">
            <activePanel.contribution.component isActive={true} />
          </div>

          {/* Resize sash (left edge) */}
          <div
            onMouseDown={onSashMouseDown}
            className="absolute inset-y-0 left-0 cursor-col-resize flex justify-center z-10"
            style={{ width: PANEL_SASH_HIT_WIDTH }}
          >
            <div
              className={cn('h-full transition-colors', isResizing ? 'bg-foreground/20' : 'hover:bg-foreground/10')}
              style={{ width: PANEL_SASH_LINE_WIDTH }}
            />
          </div>
        </div>
      )}

      {/* === TOGGLE RAIL === */}
      <div
        data-panel-role="plugin-rail"
        className="h-full shrink-0 flex flex-col items-center gap-1 py-2"
        style={{ width: 30 }}
      >
        {panels.map((panel) => {
          const isActive = showPane && panel.key === activePanelKey
          return (
            <Tooltip key={panel.key}>
              <TooltipTrigger asChild>
                <button
                  onClick={() => togglePluginPanel(panel.key)}
                  aria-label={panel.contribution.title}
                  aria-pressed={isActive}
                  className={cn(
                    'w-7 h-7 rounded-md flex items-center justify-center text-sm transition-colors',
                    isActive
                      ? 'bg-foreground/10 text-foreground'
                      : 'text-muted-foreground hover:text-foreground hover:bg-foreground/5',
                  )}
                >
                  <span aria-hidden="true">{panel.contribution.icon ?? '◧'}</span>
                </button>
              </TooltipTrigger>
              <TooltipContent side="left">{panel.contribution.title}</TooltipContent>
            </Tooltip>
          )
        })}
      </div>
    </>
  )
}
