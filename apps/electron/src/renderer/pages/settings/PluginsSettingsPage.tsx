/**
 * PluginsSettingsPage
 *
 * Lists every discovered plugin (built-in and external) with its declared
 * permissions and contributions and an enable/disable toggle. Toggling is
 * live in all windows; plugins that embed web content (`ui.webview`) need an
 * app relaunch when the window-level webview flag changes.
 *
 * External plugins live under ~/.craft-agent/plugins and their code is loaded
 * from disk. Because that code runs with the same access as the app, enabling
 * an external plugin first asks for trust consent (surfacing its declared
 * permissions). Plugins targeting an unsupported plugin API version, or whose
 * manifest failed to load, show the reason and can never be enabled.
 */

import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { PanelHeader } from '@/components/app-shell/PanelHeader'
import { ScrollArea } from '@/components/ui/scroll-area'
import { HeaderMenu } from '@/components/ui/HeaderMenu'
import { routes } from '@/lib/navigate'
import type { DetailsPageMeta } from '@/lib/navigation-registry'
import type { PluginInfo } from '../../../shared/types'

import {
  SettingsSection,
  SettingsCard,
  SettingsToggle,
} from '@/components/settings'

export const meta: DetailsPageMeta = {
  navigator: 'settings',
  slug: 'plugins',
}

export default function PluginsSettingsPage() {
  const { t } = useTranslation()
  const [plugins, setPlugins] = useState<PluginInfo[]>([])
  const [needsRelaunch, setNeedsRelaunch] = useState(false)
  /** External plugin awaiting trust consent before it's enabled */
  const [pendingConsent, setPendingConsent] = useState<PluginInfo | null>(null)

  useEffect(() => {
    if (!window.electronAPI?.plugins) return
    let cancelled = false
    window.electronAPI.plugins.list().then((list) => {
      if (!cancelled) setPlugins(list)
    }).catch((error) => {
      console.error('Failed to load plugins:', error)
    })
    const unsubscribe = window.electronAPI.plugins.onChanged((list) => setPlugins(list))
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  const applyToggle = useCallback(async (id: string, enabled: boolean) => {
    const result = await window.electronAPI.plugins.setEnabled(id, enabled)
    if (result.requiresRelaunch) setNeedsRelaunch(true)
  }, [])

  const requestToggle = useCallback((plugin: PluginInfo, enabled: boolean) => {
    // Enabling an external plugin runs third-party code — gate it behind an
    // explicit trust confirmation. Disabling, and all built-in toggles, are
    // immediate.
    if (enabled && plugin.external) {
      setPendingConsent(plugin)
      return
    }
    void applyToggle(plugin.id, enabled)
  }, [applyToggle])

  const confirmConsent = useCallback(() => {
    if (pendingConsent) void applyToggle(pendingConsent.id, true)
    setPendingConsent(null)
  }, [pendingConsent, applyToggle])

  return (
    <div className="h-full flex flex-col">
      <PanelHeader title={t("settings.plugins.title")} actions={<HeaderMenu route={routes.view.settings('plugins')} />} />
      <div className="flex-1 min-h-0 mask-fade-y">
        <ScrollArea className="h-full">
          <div className="px-5 py-7 max-w-3xl mx-auto">
            <div className="space-y-8">
              {needsRelaunch && (
                <div className="flex items-center gap-3 px-4 py-3 rounded-lg bg-foreground/5 text-sm">
                  <span className="flex-1">{t("settings.plugins.relaunchRequired")}</span>
                  <button
                    onClick={() => { void window.electronAPI.relaunchApp() }}
                    className="px-3 py-1.5 text-xs rounded-md bg-foreground/10 hover:bg-foreground/15 shrink-0"
                  >
                    {t("settings.plugins.relaunchNow")}
                  </button>
                </div>
              )}

              {pendingConsent && (
                <div className="flex flex-col gap-3 px-4 py-3 rounded-lg border border-amber-500/40 bg-amber-500/10 text-sm">
                  <div className="font-medium">
                    {t("settings.plugins.trustTitle", { name: pendingConsent.name })}
                  </div>
                  <div className="text-muted-foreground">{t("settings.plugins.trustWarning")}</div>
                  {pendingConsent.permissions.length > 0 && (
                    <div className="text-xs text-muted-foreground">
                      {t("settings.plugins.permissions")}: {pendingConsent.permissions.join(', ')}
                    </div>
                  )}
                  <div className="flex items-center gap-2">
                    <button
                      onClick={confirmConsent}
                      className="px-3 py-1.5 text-xs rounded-md bg-amber-500/20 hover:bg-amber-500/30 shrink-0"
                    >
                      {t("settings.plugins.enableAnyway")}
                    </button>
                    <button
                      onClick={() => setPendingConsent(null)}
                      className="px-3 py-1.5 text-xs rounded-md bg-foreground/10 hover:bg-foreground/15 shrink-0"
                    >
                      {t("common.cancel")}
                    </button>
                  </div>
                </div>
              )}

              <SettingsSection
                title={t("settings.plugins.installed")}
                description={t("settings.plugins.installedDesc")}
              >
                <SettingsCard>
                  {plugins.length === 0 ? (
                    <div className="px-4 py-6 text-sm text-muted-foreground text-center">
                      {t("settings.plugins.noPlugins")}
                    </div>
                  ) : (
                    plugins.map((plugin) => {
                      const declaredPanels = plugin.contributes?.sidePanels ?? []
                      const declaredCommands = plugin.contributes?.commands ?? []
                      return (
                        <SettingsToggle
                          key={plugin.id}
                          label={`${plugin.icon ? `${plugin.icon} ` : ''}${plugin.name}`}
                          description={[
                            plugin.description,
                            `v${plugin.version}`,
                            plugin.external ? t("settings.plugins.external") : undefined,
                            plugin.permissions.length > 0
                              ? `${t("settings.plugins.permissions")}: ${plugin.permissions.join(', ')}`
                              : undefined,
                            declaredPanels.length > 0
                              ? `${t("settings.plugins.panels")}: ${declaredPanels
                                  .map((panel) => `${panel.title} (${panel.location ?? 'right'})`)
                                  .join(', ')}`
                              : undefined,
                            declaredCommands.length > 0
                              ? `${t("settings.plugins.commands")}: ${declaredCommands
                                  .map((command) => command.keybinding ? `${command.title} (${command.keybinding})` : command.title)
                                  .join(', ')}`
                              : undefined,
                            plugin.incompatibility
                              ? `${t("settings.plugins.incompatible")}: ${plugin.incompatibility}`
                              : plugin.status === 'error'
                                ? `${t("settings.plugins.activationError")}: ${plugin.error ?? ''}`
                                : undefined,
                          ].filter(Boolean).join(' — ')}
                          checked={plugin.enabled}
                          disabled={!!plugin.incompatibility}
                          onCheckedChange={(enabled) => { requestToggle(plugin, enabled) }}
                        />
                      )
                    })
                  )}
                </SettingsCard>
              </SettingsSection>
            </div>
          </div>
        </ScrollArea>
      </div>
    </div>
  )
}
