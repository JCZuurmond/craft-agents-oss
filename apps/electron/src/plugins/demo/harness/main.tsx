// IMPORTANT: keep these side-effect imports first. The mock installs
// `window.electronAPI` before renderer modules read it at load time, and the
// shim registers the <webview> stand-in before React mounts one.
import './electron-api-mock'
import './webview-shim'

import React from 'react'
import ReactDOM from 'react-dom/client'
import { setupI18n } from '@craft-agent/shared/i18n'
import { initReactI18next } from 'react-i18next'
import { DemoShell } from './DemoShell'
import './demo.css'

// Generic storage seeding: `?seed.{localStorage key}={JSON value}` writes the
// pair before any plugin code runs. Storyboards use it to start a plugin from
// persisted state (e.g. a previous session's scoped ctx.storage namespace:
// `seed.craft-plugin-{id}:{key}={JSON}`), exactly as a real profile would.
for (const [key, value] of new URLSearchParams(location.search)) {
  if (key.startsWith('seed.')) {
    localStorage.setItem(key.slice('seed.'.length), value)
  }
}

setupI18n([initReactI18next])

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <DemoShell />
  </React.StrictMode>,
)
