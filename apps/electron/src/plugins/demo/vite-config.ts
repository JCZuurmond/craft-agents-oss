/**
 * Shared Vite config factory for plugin product-demo recordings.
 *
 * Dev-server only — the app build is untouched. The served root is the shared
 * demo harness next to this file, not apps/electron/src/renderer, so this does
 * not add a new application renderer path. It reuses the real renderer plugin
 * runtime, panel docks, settings primitives, and the built-in plugins.
 *
 * Each plugin's demo directory keeps a two-line `vite.config.ts` stub that
 * passes its own location in:
 *
 *   import { createPluginDemoConfig } from '../../demo/vite-config'
 *   export default createPluginDemoConfig(import.meta.url)
 *
 * (A stub per plugin — rather than pointing `--config` at this file — keeps
 * every path file-relative: npm exec anchors subprocess cwd at the nearest
 * package.json, so cwd-relative resolution is a trap.) When `{plugin}/demo/
 * site` exists, its files are served under /demo-site for storyboards that
 * need local web content (e.g. the Browser Pane demo).
 */

import { defineConfig, type Plugin, type ViteDevServer, type UserConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEMO_TOOLS_DIR = dirname(fileURLToPath(import.meta.url))
const ELECTRON_ROOT = resolve(DEMO_TOOLS_DIR, '../../..')
const REPO_ROOT = resolve(ELECTRON_ROOT, '../..')
const HARNESS_DIR = resolve(DEMO_TOOLS_DIR, 'harness')

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
}

/** Serve the recorded plugin's demo/site directory under /demo-site */
function demoSite(siteDir: string): Plugin {
  return {
    name: 'plugin-demo-site',
    configureServer(server: ViteDevServer) {
      if (!existsSync(siteDir)) return
      server.middlewares.use('/demo-site', (req, res, next) => {
        const urlPath = (req.url ?? '/').split('?')[0]
        const relative = urlPath === '/' || urlPath === '' ? '/index.html' : urlPath
        const file = join(siteDir, normalize(relative))
        if (!file.startsWith(siteDir)) {
          next()
          return
        }
        readFile(file)
          .then((content) => {
            res.setHeader('Content-Type', CONTENT_TYPES[extname(file)] ?? 'application/octet-stream')
            res.end(content)
          })
          .catch(() => {
            res.statusCode = 404
            res.end('Not found')
          })
      })
    },
  }
}

/**
 * Build the demo dev-server config for one plugin's demo directory.
 * @param pluginDemoConfigUrl the stub's `import.meta.url`
 */
export function createPluginDemoConfig(pluginDemoConfigUrl: string): UserConfig {
  const pluginDemoDir = dirname(fileURLToPath(pluginDemoConfigUrl))
  return defineConfig({
    plugins: [react(), tailwindcss(), demoSite(resolve(pluginDemoDir, 'site'))],
    root: HARNESS_DIR,
    base: './',
    resolve: {
      alias: {
        '@': resolve(ELECTRON_ROOT, 'src/renderer'),
        '@config': resolve(REPO_ROOT, 'packages/shared/src/config'),
        react: resolve(REPO_ROOT, 'node_modules/react'),
        'react-dom': resolve(REPO_ROOT, 'node_modules/react-dom'),
      },
      dedupe: ['react', 'react-dom'],
    },
    server: {
      host: '127.0.0.1',
      port: 5199,
      strictPort: true,
      open: false,
      fs: { allow: [REPO_ROOT] },
    },
  })
}
