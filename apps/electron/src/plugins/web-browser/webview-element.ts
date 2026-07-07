/**
 * Minimal typings for the Electron <webview> tag as used by the Browser Pane
 * plugin. The renderer is web-only code (no electron import), so we declare
 * just the surface we use instead of depending on Electron.WebviewTag.
 * (React's JSX already declares the <webview> intrinsic element; these types
 * cover the runtime methods/events it leaves untyped.)
 */

export interface WebviewElement extends HTMLElement {
  src: string
  partition: string
  goBack(): void
  goForward(): void
  canGoBack(): boolean
  canGoForward(): boolean
  reload(): void
  stop(): void
  getURL(): string
}

export interface WebviewNavigateEvent extends Event {
  url: string
  isMainFrame?: boolean
}

export interface WebviewFailLoadEvent extends Event {
  errorCode: number
  errorDescription: string
  validatedURL: string
  isMainFrame: boolean
}

export interface WebviewTitleEvent extends Event {
  title: string
}
