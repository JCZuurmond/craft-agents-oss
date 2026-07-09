#!/usr/bin/env node
/**
 * Record every shot-scraper storyboard for one or more plugins and emit
 * reviewer artifacts under docs/plugins/{plugin-id}/demo/.
 *
 * Usage:
 *   node record.mjs <plugin-id> [<plugin-id> ...]
 *
 * A plugin opts in by keeping storyboards in
 * apps/electron/src/plugins/{id}/demo/storyboards/*.yml. The storyboards are
 * the source of truth; this wrapper only supplies the tooling glue: run
 * `shot-scraper video` from the plugin's demo directory (so storyboard paths
 * stay plugin-relative), then convert the WebM to a PR-friendly GIF using
 * ffmpeg.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { createConnection } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEMO_TOOLS_DIR = dirname(fileURLToPath(import.meta.url))
const PLUGINS_DIR = resolve(DEMO_TOOLS_DIR, '..')
const REPO_ROOT = resolve(DEMO_TOOLS_DIR, '../../../../..')
const WORK_DIR = join(DEMO_TOOLS_DIR, '.recordings')

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    shell: false,
    ...options,
  })
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with status ${result.status}`)
  }
}

function commandExists(command) {
  const result = spawnSync(command, ['--version'], { stdio: 'ignore' })
  return result.status === 0
}

function shotScraperCommand() {
  if (process.env.SHOT_SCRAPER_BIN) return { command: process.env.SHOT_SCRAPER_BIN, prefix: [] }
  if (commandExists('shot-scraper')) return { command: 'shot-scraper', prefix: [] }
  if (commandExists('uvx')) return { command: 'uvx', prefix: ['shot-scraper'] }
  throw new Error('No shot-scraper found. Install it or use `uvx shot-scraper install` first.')
}

function findFfmpeg() {
  const candidates = [process.env.FFMPEG_BIN, 'ffmpeg']
  const playwrightCaches = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    join(process.env.HOME ?? '', '.cache/ms-playwright'),
  ]
  for (const cache of playwrightCaches) {
    if (!cache || !existsSync(cache)) continue
    for (const entry of readdirSync(cache)) {
      if (entry.startsWith('ffmpeg-')) {
        candidates.push(join(cache, entry, 'ffmpeg-linux'))
      }
    }
  }
  for (const candidate of candidates) {
    if (!candidate) continue
    const result = spawnSync(candidate, ['-version'], { stdio: 'ignore' })
    if (result.status === 0) return candidate
  }
  return null
}

function outputPathFor(storyboardPath, pluginDemoDir) {
  const text = readFileSync(storyboardPath, 'utf8')
  const match = text.match(/^output:\s*(.+)$/m)
  if (!match) throw new Error(`Storyboard has no output: ${storyboardPath}`)
  const raw = match[1].trim().replace(/^['"]|['"]$/g, '')
  return resolve(pluginDemoDir, raw)
}

function storyboardPort(storyboardPath) {
  const text = readFileSync(storyboardPath, 'utf8')
  const match = text.match(/^url:\s*["']?(https?:\/\/[^"'\s]+)/m)
  if (!match) return null
  try {
    return new URL(match[1]).port || null
  } catch {
    return null
  }
}

/**
 * Fail fast when the storyboard's server port is already taken: recording
 * would silently run against a stale server (shot-scraper's own vite spawn
 * dies on strictPort) and produce a demo of the wrong module graph.
 */
function assertPortFree(port, storyboard) {
  return new Promise((resolvePromise, rejectPromise) => {
    const socket = createConnection({ host: '127.0.0.1', port: Number(port) }, () => {
      socket.destroy()
      rejectPromise(new Error(
        `Port ${port} is already in use before recording ${storyboard} — ` +
        `a stale demo server is likely still running. Stop it and retry.`,
      ))
    })
    socket.on('error', () => resolvePromise())
  })
}

function encodeGif(ffmpeg, webmPath) {
  const gifPath = webmPath.replace(/\.webm$/i, '.gif')
  const palette = join(WORK_DIR, `${Date.now()}-palette.png`)
  run(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', webmPath,
    '-vf', 'fps=8,scale=880:-1:flags=lanczos,palettegen=stats_mode=diff',
    palette,
  ], { cwd: REPO_ROOT })
  run(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', webmPath, '-i', palette,
    '-lavfi', 'fps=8,scale=880:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle',
    gifPath,
  ], { cwd: REPO_ROOT })
  return gifPath
}

async function recordPlugin(pluginId, shotScraper, ffmpeg) {
  const pluginDemoDir = join(PLUGINS_DIR, pluginId, 'demo')
  const storyboardDir = join(pluginDemoDir, 'storyboards')
  if (!existsSync(storyboardDir)) {
    throw new Error(`No storyboards found for plugin '${pluginId}' (expected ${storyboardDir})`)
  }

  const storyboards = readdirSync(storyboardDir)
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .sort()
  if (storyboards.length === 0) {
    throw new Error(`No storyboards found in ${storyboardDir}`)
  }

  const outDir = join(REPO_ROOT, 'docs/plugins', pluginId, 'demo')
  mkdirSync(outDir, { recursive: true })

  for (const name of storyboards) {
    const storyboard = join('storyboards', name)
    const output = outputPathFor(join(storyboardDir, name), pluginDemoDir)
    const port = storyboardPort(join(storyboardDir, name))
    if (port) await assertPortFree(port, `${pluginId}/${storyboard}`)
    console.log(`\n▶ Recording ${pluginId}/${storyboard}`)
    run(shotScraper.command, [...shotScraper.prefix, 'video', storyboard], { cwd: pluginDemoDir })
    console.log(`▶ Encoding GIF for ${output}`)
    const gif = encodeGif(ffmpeg, output)
    console.log(`✓ ${gif}`)
  }

  console.log(`\nArtifacts for '${pluginId}' written to ${outDir}`)
}

async function main() {
  const pluginIds = process.argv.slice(2).filter((arg) => !arg.startsWith('-'))
  if (pluginIds.length === 0) {
    throw new Error('Usage: node record.mjs <plugin-id> [<plugin-id> ...]')
  }

  rmSync(WORK_DIR, { recursive: true, force: true })
  mkdirSync(WORK_DIR, { recursive: true })

  const shotScraper = shotScraperCommand()
  const ffmpeg = findFfmpeg()
  if (!ffmpeg) {
    throw new Error('No ffmpeg found. Run `uvx shot-scraper install` or set $FFMPEG_BIN.')
  }

  for (const pluginId of pluginIds) {
    await recordPlugin(pluginId, shotScraper, ffmpeg)
  }

  console.log('Run `node comment-demos.mjs <plugin-id> --pr <number>` to add/update a PR comment.')
}

await main()
