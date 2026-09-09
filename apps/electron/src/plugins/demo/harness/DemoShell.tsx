/**
 * DemoShell — a minimal Craft-like application frame for plugin demos.
 *
 * Everything plugin-related in here is the real framework: the renderer plugin
 * runtime (`initializePluginRuntime`), the real `PluginPanelDock` on all four
 * shell edges, the real Settings primitives for the plugin toggle, and the
 * real built-in plugins. Only the surrounding chrome (titlebar/sidebar/chat
 * mock) is scenery — the full AppShell would drag in the whole application
 * for a PR demo page.
 */

import { useEffect, useState } from 'react'
import { TooltipProvider } from '@craft-agent/ui'
import type { PluginInfo } from '@craft-agent/shared/plugins/types'
import { PluginPanelDock, PluginPanelArea } from '../../../renderer/plugins/PluginPanelDock'
import { registerPluginPanel, openPluginPanel } from '../../../renderer/plugins/panel-store'
import { initializePluginRuntime } from '../../../renderer/plugins/runtime'
import { SettingsCard, SettingsSection, SettingsToggle } from '../../../renderer/components/settings'
import { RADIUS_EDGE, PANEL_GAP, PANEL_EDGE_INSET } from '../../../renderer/components/app-shell/panel-constants'

declare global {
  interface Window {
    __pluginDemo?: {
      setCaption(text: string): void
      openSettings(open: boolean): void
      /** Register a second demo plugin's panels on other edges (four-dock showcase) */
      showEdgePanels(): void
    }
  }
}

function TitleBar({ onToggleSettings }: { onToggleSettings: () => void }) {
  return (
    <div className="h-10 shrink-0 flex items-center px-3 select-none">
      <div className="flex items-center gap-1.5" aria-hidden="true">
        <span className="w-3 h-3 rounded-full bg-[#ff5f57]" />
        <span className="w-3 h-3 rounded-full bg-[#febc2e]" />
        <span className="w-3 h-3 rounded-full bg-[#28c840]" />
      </div>
      <div className="flex-1 text-center text-[13px] font-medium text-muted-foreground">
        Craft Agents
      </div>
      <button
        onClick={onToggleSettings}
        data-testid="demo-open-settings"
        className="px-2.5 py-1 text-xs rounded-md text-muted-foreground hover:text-foreground hover:bg-foreground/5"
      >
        ⚙︎ Plugins
      </button>
    </div>
  )
}

function SidebarMock() {
  const sessions = [
    { title: 'Draft Q3 release notes', time: '2m', active: true },
    { title: 'Summarize support inbox', time: '1h', active: false },
    { title: 'Competitor pricing research', time: '3h', active: false },
    { title: 'Weekly metrics digest', time: '1d', active: false },
  ]
  return (
    <div className="w-56 shrink-0 flex flex-col gap-4 px-3 py-2 text-sm">
      <div className="flex items-center gap-2 px-1">
        <span className="w-5 h-5 rounded-md bg-foreground/80 text-background text-[11px] font-semibold flex items-center justify-center">A</span>
        <span className="font-semibold text-[13px]">Acme Workspace</span>
      </div>
      <div className="flex flex-col gap-0.5">
        {['Inbox', 'All Sessions', 'Sources', 'Skills'].map((item, i) => (
          <div
            key={item}
            className={`px-2 py-1 rounded-md text-[13px] ${i === 1 ? 'bg-foreground/10 font-medium' : 'text-muted-foreground'}`}
          >
            {item}
          </div>
        ))}
      </div>
      <div className="flex flex-col gap-0.5 min-h-0">
        <div className="px-2 pb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">Today</div>
        {sessions.map((session) => (
          <div
            key={session.title}
            className={`px-2 py-1.5 rounded-md flex items-baseline gap-2 ${session.active ? 'bg-foreground/10' : ''}`}
          >
            <span className="flex-1 truncate text-[13px]">{session.title}</span>
            <span className="text-[11px] text-muted-foreground/70 shrink-0">{session.time}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function ChatMock() {
  return (
    <div className="flex-1 min-w-0 h-full bg-background shadow-middle flex flex-col" style={{ borderRadius: RADIUS_EDGE }}>
      <div className="h-10 shrink-0 flex items-center px-4 border-b border-border/50 text-sm font-medium">
        Draft Q3 release notes
      </div>
      <div className="flex-1 min-h-0 px-6 py-5 flex flex-col gap-4 overflow-hidden text-sm">
        <div className="self-end max-w-[75%] px-3.5 py-2 rounded-2xl bg-foreground/10">
          Pull the merged PRs since v0.10 and draft the release notes. Set the workspace up so we can iterate side by side.
        </div>
        <div className="max-w-[85%] flex flex-col gap-2">
          <div className="text-muted-foreground">
            Found 24 merged PRs since v0.10. Drafting notes grouped by feature area — the plugin framework
            and its reference plugins are the headline items.
          </div>
          <div className="px-3 py-2 rounded-lg bg-foreground/5 text-xs text-muted-foreground font-mono">
            ▸ Read 24 pull requests · 3 sources
          </div>
          <div className="text-muted-foreground">
            First pass is ready — open whichever plugin panels you need around the chat while we work.
          </div>
        </div>
      </div>
      <div className="shrink-0 px-4 pb-4">
        <div className="h-11 rounded-xl bg-foreground/5 flex items-center px-4 text-sm text-muted-foreground/60">
          Message the agent…
        </div>
      </div>
    </div>
  )
}

/**
 * Condensed Settings → Plugins card: mirrors the real settings primitives
 * without pulling in router/navigation state that is irrelevant for the demo.
 */
function PluginSettingsOverlay({ open }: { open: boolean }) {
  const [plugins, setPlugins] = useState<PluginInfo[]>([])

  useEffect(() => {
    let cancelled = false
    void window.electronAPI.plugins.list().then((list) => {
      if (!cancelled) setPlugins(list)
    })
    const unsubscribe = window.electronAPI.plugins.onChanged((list) => setPlugins(list))
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  if (!open) return null

  return (
    <div
      data-testid="demo-settings"
      className="absolute top-12 right-4 z-50 w-[440px] rounded-xl bg-background shadow-middle border border-border/50 p-5"
    >
      <SettingsSection
        title="Plugins"
        description="Extend the app with panels, commands, and embedded views."
      >
        <SettingsCard>
          {plugins.map((plugin) => {
            const declaredPanels = plugin.contributes?.sidePanels ?? []
            return (
              <SettingsToggle
                key={plugin.id}
                label={`${plugin.icon ? `${plugin.icon} ` : ''}${plugin.name}`}
                description={[
                  plugin.description,
                  `v${plugin.version}`,
                  plugin.permissions.length > 0 ? `Permissions: ${plugin.permissions.join(', ')}` : undefined,
                  declaredPanels.length > 0
                    ? `Panels: ${declaredPanels.map((panel) => `${panel.title} (${panel.location ?? 'right'})`).join(', ')}`
                    : undefined,
                ].filter(Boolean).join(' — ')}
                checked={plugin.enabled}
                disabled={!!plugin.incompatibility}
                onCheckedChange={(enabled) => { void window.electronAPI.plugins.setEnabled(plugin.id, enabled) }}
              />
            )
          })}
        </SettingsCard>
      </SettingsSection>
    </div>
  )
}

function CaptionBar({ text }: { text: string }) {
  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-5 z-[100] flex justify-center transition-opacity duration-300"
      style={{ opacity: text ? 1 : 0 }}
    >
      <div className="max-w-[70%] px-5 py-2.5 rounded-full bg-black/80 text-white text-[13px] font-medium shadow-lg">
        {text}
      </div>
    </div>
  )
}

export function DemoShell() {
  const [caption, setCaption] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)

  // Same app-level bootstrap AppShell performs: plugins activate per their
  // activation events whether or not a pane host is mounted.
  useEffect(() => {
    void initializePluginRuntime()
  }, [])

  useEffect(() => {
    window.__pluginDemo = {
      setCaption,
      openSettings: setSettingsOpen,
      showEdgePanels: () => {
        // A hypothetical second plugin contributing to other edges —
        // registered through the same public store surface the framework
        // gives ctx.ui.registerSidePanel. Proves the dock generalizes.
        const placeholder = (label: string) => () => (
          <div className="h-full px-4 py-3 text-[13px] text-muted-foreground font-mono">{label}</div>
        )
        registerPluginPanel('edge-demo', {
          id: 'terminal', title: 'Terminal', icon: '💻', location: 'bottom',
          component: placeholder('$ bun test packages/shared/src/plugins — 94 pass'),
        })
        registerPluginPanel('edge-demo', {
          id: 'notes', title: 'Notes', icon: '📝', location: 'left',
          component: placeholder('Scratch notes panel'),
        })
        openPluginPanel('edge-demo:terminal')
      },
    }
    return () => { delete window.__pluginDemo }
  }, [])

  return (
    <TooltipProvider delayDuration={0}>
      <div className="h-screen w-screen flex flex-col bg-sidebar text-foreground overflow-hidden">
        <TitleBar onToggleSettings={() => setSettingsOpen((open) => !open)} />
        <div
          className="flex-1 min-h-0 flex items-stretch"
          style={{ gap: PANEL_GAP, padding: `0 ${PANEL_EDGE_INSET}px ${PANEL_EDGE_INSET}px` }}
        >
          {/* The real plugin docks, wired exactly like AppShell: vertical
              docks flank the content, PluginPanelArea provides top/bottom */}
          <PluginPanelDock location="left" />
          <SidebarMock />
          <PluginPanelArea>
            <ChatMock />
          </PluginPanelArea>
          <PluginPanelDock location="right" />
        </div>
        <PluginSettingsOverlay open={settingsOpen} />
        <CaptionBar text={caption} />
      </div>
    </TooltipProvider>
  )
}
