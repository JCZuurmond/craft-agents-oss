/**
 * Browser Pane plugin — panel UI
 *
 * Address bar + back/forward/reload controls around a sandboxed <webview>.
 * Built entirely on the plugin API: the session partition comes from
 * ctx.webviewPartition (enforced by the main-process webview hardening) and
 * the last visited URL persists through ctx.storage.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, RotateCw, TriangleAlert, X } from 'lucide-react'
import type { PluginContext, PluginPanelProps } from '../../renderer/plugins/types'
import type {
  WebviewElement,
  WebviewFailLoadEvent,
  WebviewNavigateEvent,
} from './webview-element'

export const DEFAULT_URL = 'https://duckduckgo.com'
const LAST_URL_STORAGE_KEY = 'last-url'
/** Chromium net error for user-aborted loads (e.g. navigating away mid-load) */
const ERR_ABORTED = -3

const searchUrl = (query: string) => `https://duckduckgo.com/?q=${encodeURIComponent(query)}`

/**
 * Normalize address-bar input the same way the core browser windows do:
 * scheme-less host-like strings get https://, anything else becomes a search.
 *
 * Only schemes the main-process webview policy will actually load pass
 * through (http, https, about:blank) — the policy blocks everything else
 * anyway (SECURITY.md), so pre-validating here turns a would-be silent
 * block into an ordinary search instead.
 */
export function normalizeAddressInput(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) return DEFAULT_URL
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(trimmed)?.[1]?.toLowerCase()
  if (scheme === 'http' || scheme === 'https') return trimmed
  if (scheme) return searchUrl(trimmed)
  if (trimmed === 'about:blank') return trimmed
  if (trimmed.startsWith('about:')) return searchUrl(trimmed)
  const looksLikeHost = /^(localhost|\d{1,3}(?:\.\d{1,3}){3}|[\w-]+(?:\.[\w-]+)+)(?::\d+)?(?:\/|$)/i.test(trimmed)
  if (looksLikeHost) return `https://${trimmed}`
  return searchUrl(trimmed)
}

interface LoadError {
  code: number
  description: string
  url: string
}

export function createBrowserPanel(ctx: PluginContext) {
  return function BrowserPanel(_props: PluginPanelProps) {
    const webviewRef = useRef<WebviewElement | null>(null)
    const [src] = useState<string>(() => ctx.storage.get(LAST_URL_STORAGE_KEY, DEFAULT_URL))
    const [addressValue, setAddressValue] = useState(src)
    const [currentUrl, setCurrentUrl] = useState(src)
    const [isLoading, setIsLoading] = useState(false)
    const [canGoBack, setCanGoBack] = useState(false)
    const [canGoForward, setCanGoForward] = useState(false)
    const [loadError, setLoadError] = useState<LoadError | null>(null)
    const [addressFocused, setAddressFocused] = useState(false)

    useEffect(() => {
      const webview = webviewRef.current
      if (!webview) return

      const syncNavState = () => {
        try {
          setCanGoBack(webview.canGoBack())
          setCanGoForward(webview.canGoForward())
        } catch {
          // webview not ready yet
        }
      }

      const onDidNavigate = (event: Event) => {
        const { url, isMainFrame } = event as WebviewNavigateEvent
        if (isMainFrame === false) return
        setCurrentUrl(url)
        setLoadError(null)
        ctx.storage.set(LAST_URL_STORAGE_KEY, url)
        syncNavState()
      }
      const onStartLoading = () => {
        setIsLoading(true)
        setLoadError(null)
      }
      const onStopLoading = () => {
        setIsLoading(false)
        syncNavState()
      }
      const onFailLoad = (event: Event) => {
        const { errorCode, errorDescription, validatedURL, isMainFrame } = event as WebviewFailLoadEvent
        if (!isMainFrame || errorCode === ERR_ABORTED) return
        setIsLoading(false)
        setLoadError({ code: errorCode, description: errorDescription, url: validatedURL })
        ctx.logger.warn(`load failed (${errorCode} ${errorDescription}) for ${validatedURL}`)
      }

      webview.addEventListener('did-navigate', onDidNavigate)
      webview.addEventListener('did-navigate-in-page', onDidNavigate)
      webview.addEventListener('did-start-loading', onStartLoading)
      webview.addEventListener('did-stop-loading', onStopLoading)
      webview.addEventListener('did-fail-load', onFailLoad)
      return () => {
        webview.removeEventListener('did-navigate', onDidNavigate)
        webview.removeEventListener('did-navigate-in-page', onDidNavigate)
        webview.removeEventListener('did-start-loading', onStartLoading)
        webview.removeEventListener('did-stop-loading', onStopLoading)
        webview.removeEventListener('did-fail-load', onFailLoad)
      }
    }, [])

    // Address bar mirrors the page URL unless the user is editing it
    useEffect(() => {
      if (!addressFocused) setAddressValue(currentUrl)
    }, [currentUrl, addressFocused])

    const navigate = useCallback((input: string) => {
      const url = normalizeAddressInput(input)
      const webview = webviewRef.current
      if (!webview) return
      setLoadError(null)
      webview.src = url
      setCurrentUrl(url)
    }, [])

    const onAddressSubmit = (e: React.FormEvent) => {
      e.preventDefault()
      navigate(addressValue)
      webviewRef.current?.focus()
    }

    const safeCall = (fn: (webview: WebviewElement) => void) => {
      const webview = webviewRef.current
      if (!webview) return
      try {
        fn(webview)
      } catch (error) {
        ctx.logger.warn('webview call failed', error)
      }
    }

    const toolbarButton =
      'p-1.5 rounded-md text-muted-foreground enabled:hover:text-foreground enabled:hover:bg-foreground/5 disabled:opacity-40'

    return (
      <div className="h-full flex flex-col">
        {/* Toolbar */}
        <div className="flex items-center gap-1 px-2 py-1.5 shrink-0 border-b border-border/50">
          <button
            className={toolbarButton}
            disabled={!canGoBack}
            onClick={() => safeCall((w) => w.goBack())}
            aria-label="Back"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
          </button>
          <button
            className={toolbarButton}
            disabled={!canGoForward}
            onClick={() => safeCall((w) => w.goForward())}
            aria-label="Forward"
          >
            <ArrowRight className="h-3.5 w-3.5" />
          </button>
          <button
            className={toolbarButton}
            onClick={() => safeCall((w) => (isLoading ? w.stop() : w.reload()))}
            aria-label={isLoading ? 'Stop' : 'Reload'}
          >
            {isLoading ? <X className="h-3.5 w-3.5" /> : <RotateCw className="h-3.5 w-3.5" />}
          </button>
          <form onSubmit={onAddressSubmit} className="flex-1 min-w-0">
            <input
              value={addressValue}
              onChange={(e) => setAddressValue(e.target.value)}
              onFocus={(e) => {
                setAddressFocused(true)
                e.target.select()
              }}
              onBlur={() => setAddressFocused(false)}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              placeholder="Search or enter address"
              aria-label="Address"
              className="w-full h-7 px-2.5 text-xs rounded-md bg-foreground/5 text-foreground placeholder:text-muted-foreground outline-none focus:ring-1 focus:ring-ring"
            />
          </form>
        </div>

        {/* Render surface */}
        <div className="flex-1 min-h-0 relative">
          <webview
            ref={(el) => { webviewRef.current = el as WebviewElement | null }}
            src={src}
            partition={ctx.webviewPartition}
            className="absolute inset-0"
            style={{ width: '100%', height: '100%' }}
          />
          {loadError && (
            <div className="absolute inset-0 bg-background flex flex-col items-center justify-center gap-3 px-6 text-center">
              <TriangleAlert className="h-6 w-6 text-muted-foreground" />
              <div className="text-sm font-medium">This page failed to load</div>
              <div className="text-xs text-muted-foreground break-all">
                {loadError.url}
                <br />
                {loadError.description} ({loadError.code})
              </div>
              <button
                onClick={() => navigate(loadError.url)}
                className="px-3 py-1.5 text-xs rounded-md bg-foreground/10 hover:bg-foreground/15"
              >
                Try again
              </button>
            </div>
          )}
        </div>
      </div>
    )
  }
}
