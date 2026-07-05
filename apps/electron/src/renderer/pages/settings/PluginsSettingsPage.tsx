/**
 * PluginsSettingsPage
 *
 * Lists every discovered plugin (built-in and external) with its declared
 * permissions and contributions and an enable/disable toggle. Toggling is
 * live in all windows; plugins that embed web content (`ui.webview`) need an
 * app relaunch when the window-level webview flag changes.
 *
 * External plugins are discovery-only in this version (their manifests are
 * listed but no external code is loaded), so their toggles stay disabled with
 * a "manifest only" note instead of silently doing nothing. Plugins targeting
 * an unsupported plugin API version show the incompatibility reason and can
 * never be enabled.
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

  const handleToggle = useCallback(async (id: string, enabled: boolean) => {
    const result = await window.electronAPI.plugins.setEnabled(id, enabled)
    if (result.requiresRelaunch) setNeedsRelaunch(true)
  }, [])

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
                      // External plugin code is not loaded in this version —
                      // enabling one would be a silent no-op, so the toggle
                      // only allows turning an already-enabled one off.
                      const manifestOnly = plugin.source === 'user'
                      return (
                        <SettingsToggle
                          key={plugin.id}
                          label={`${plugin.icon ? `${plugin.icon} ` : ''}${plugin.name}`}
                          description={[
                            plugin.description,
                            `v${plugin.version}`,
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
                            manifestOnly ? t("settings.plugins.externalManifestOnly") : undefined,
                            plugin.incompatibility
                              ? `${t("settings.plugins.incompatible")}: ${plugin.incompatibility}`
                              : plugin.status === 'error'
                                ? `${t("settings.plugins.activationError")}: ${plugin.error ?? ''}`
                                : undefined,
                          ].filter(Boolean).join(' — ')}
                          checked={plugin.enabled}
                          disabled={!!plugin.incompatibility || (manifestOnly && !plugin.enabled)}
                          onCheckedChange={(enabled) => { void handleToggle(plugin.id, enabled) }}
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
