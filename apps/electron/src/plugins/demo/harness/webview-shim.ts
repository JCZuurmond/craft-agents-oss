/**
 * <webview> stand-in for browser-page demos.
 *
 * Electron's real tag is Chromium guest-view machinery hardened by the main
 * process. A plain browser page has none of that, so the demo provides the
 * runtime surface webview-embedding plugins use (`src`, history methods,
 * loading events) backed by a same-origin <iframe>. Plugin components run
 * unmodified against either implementation — the shim's surface is a
 * structural match for the plugins' own webview typings (e.g. the Browser
 * Pane's webview-element.ts), duplicated here so the shared harness depends
 * on no particular plugin.
 *
 * Custom element names must contain a hyphen, so `webview` itself cannot be
 * registered. Instead a `demo-webview` element carries the implementation and
 * `Document.prototype.createElement` is patched to return it whenever React
 * asks for a `webview` element.
 */

/** The subset of Electron's WebviewTag surface the shim implements */
interface WebviewLikeElement extends HTMLElement {
  src: string
  partition: string
  getURL(): string
  canGoBack(): boolean
  canGoForward(): boolean
  goBack(): void
  goForward(): void
  reload(): void
  stop(): void
}

const PROBE_TIMEOUT_MS = 4000

interface ProbeFailure {
  code: number
  description: string
}

async function probe(url: string): Promise<ProbeFailure | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  try {
    await fetch(url, { mode: 'no-cors', signal: controller.signal })
    return null
  } catch {
    return { code: -102, description: 'ERR_CONNECTION_REFUSED' }
  } finally {
    clearTimeout(timer)
  }
}

class DemoWebviewElement extends HTMLElement implements WebviewLikeElement {
  static observedAttributes = ['src']

  partition = ''

  #iframe: HTMLIFrameElement | null = null
  #history: string[] = []
  #index = -1

  #ensureIframe(): HTMLIFrameElement {
    if (!this.#iframe) {
      const iframe = document.createElement('iframe')
      iframe.style.cssText = 'width:100%;height:100%;border:0;display:block;background:#fff'
      iframe.addEventListener('load', () => this.#onIframeLoad())
      this.#iframe = iframe
      this.appendChild(iframe)
    }
    return this.#iframe
  }

  connectedCallback(): void {
    this.style.display = 'block'
    this.#ensureIframe()
    const initial = this.getAttribute('src')
    if (initial && this.#index === -1) void this.#load(initial)
  }

  attributeChangedCallback(name: string, _old: string | null, value: string | null): void {
    // Attributes set before connection are handled by connectedCallback.
    if (name !== 'src' || !this.isConnected || value === null) return
    if (value !== this.getURL()) void this.#load(value)
  }

  get src(): string {
    return this.getURL()
  }

  set src(url: string) {
    void this.#load(url)
  }

  getURL(): string {
    return this.#history[this.#index] ?? ''
  }

  canGoBack(): boolean {
    return this.#index > 0
  }

  canGoForward(): boolean {
    return this.#index < this.#history.length - 1
  }

  goBack(): void {
    if (!this.canGoBack()) return
    this.#index -= 1
    this.#emit('did-start-loading')
    this.#ensureIframe().src = this.#history[this.#index]
  }

  goForward(): void {
    if (!this.canGoForward()) return
    this.#index += 1
    this.#emit('did-start-loading')
    this.#ensureIframe().src = this.#history[this.#index]
  }

  reload(): void {
    const url = this.getURL()
    if (!url) return
    this.#emit('did-start-loading')
    this.#ensureIframe().src = url
  }

  stop(): void {
    this.#emit('did-stop-loading')
  }

  async #load(url: string): Promise<void> {
    this.#emit('did-start-loading')
    this.removeAttribute('data-error')
    const failure = await probe(url)
    if (failure) {
      this.setAttribute('data-error', failure.description)
      this.setAttribute('data-error-url', url)
      this.#emit('did-fail-load', {
        errorCode: failure.code,
        errorDescription: failure.description,
        validatedURL: url,
        isMainFrame: true,
      })
      this.#emit('did-stop-loading')
      return
    }
    this.#ensureIframe().src = url
  }

  #onIframeLoad(): void {
    const url = this.#currentIframeUrl()
    if (!url || url === 'about:blank') return
    if (url !== this.#history[this.#index]) {
      this.#history = [...this.#history.slice(0, this.#index + 1), url]
      this.#index = this.#history.length - 1
    }
    this.setAttribute('data-loaded-url', url)
    this.setAttribute('data-can-go-back', String(this.canGoBack()))
    this.setAttribute('data-can-go-forward', String(this.canGoForward()))
    this.#emit('did-navigate', { url, isMainFrame: true })
    this.#emit('did-stop-loading')
  }

  #currentIframeUrl(): string | null {
    try {
      return this.#iframe?.contentWindow?.location.href ?? null
    } catch {
      // Cross-origin page: fall back to the last URL we set ourselves.
      return this.#iframe?.src ?? null
    }
  }

  #emit(type: string, detail?: Record<string, unknown>): void {
    this.dispatchEvent(Object.assign(new Event(type), detail))
  }
}

if (!customElements.get('demo-webview')) {
  customElements.define('demo-webview', DemoWebviewElement)

  const originalCreateElement = Document.prototype.createElement as (
    this: Document,
    tagName: string,
    options?: ElementCreationOptions,
  ) => HTMLElement
  Document.prototype.createElement = function createElement(
    this: Document,
    tagName: string,
    options?: ElementCreationOptions,
  ): HTMLElement {
    if (typeof tagName === 'string' && tagName.toLowerCase() === 'webview') {
      return originalCreateElement.call(this, 'demo-webview')
    }
    return originalCreateElement.call(this, tagName, options)
  } as typeof Document.prototype.createElement
}
