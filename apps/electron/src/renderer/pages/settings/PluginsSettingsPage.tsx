/**
 * PluginsSettingsPage
 *
 * Lists every discovered plugin (built-in and external) with its declared
 * permissions and an enable/disable toggle. Toggling is live in all windows;
 * plugins that embed web content (`ui.webview`) need an app relaunch when the
 * window-level webview flag changes.
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
                    plugins.map((plugin) => (
                      <SettingsToggle
                        key={plugin.id}
                        label={`${plugin.icon ? `${plugin.icon} ` : ''}${plugin.name}`}
                        description={[
                          plugin.description,
                          `v${plugin.version}`,
                          plugin.permissions.length > 0
                            ? `${t("settings.plugins.permissions")}: ${plugin.permissions.join(', ')}`
                            : undefined,
                          plugin.status === 'error'
                            ? `${t("settings.plugins.activationError")}: ${plugin.error ?? ''}`
                            : undefined,
                        ].filter(Boolean).join(' — ')}
                        checked={plugin.enabled}
                        onCheckedChange={(enabled) => { void handleToggle(plugin.id, enabled) }}
                      />
                    ))
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
