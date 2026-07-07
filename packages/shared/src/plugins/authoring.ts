/**
 * Plugin Authoring Dev-Tools (Node-only)
 *
 * Validate a plugin directory and scaffold a new one. Backs the
 * `bun run plugin:*` CLI (scripts/plugin.ts) and gives external plugin
 * authors the same zod feedback the app uses at discovery — *before* they
 * launch the app. Import from '@craft-agent/shared/plugins/node'.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { basename, join, resolve, sep } from 'path';
import { safeJsonParse } from '../utils/files.ts';
import { validatePluginManifest } from './validation.ts';
import { PLUGIN_MANIFEST_FILE } from './storage.ts';
import type { PluginManifest } from './types.ts';

export interface PluginDirValidation {
  valid: boolean;
  /** Absolute plugin directory that was validated */
  dir: string;
  manifest: PluginManifest | null;
  /** Blocking problems — the app would refuse (or silently skip) this plugin */
  errors: string[];
  /** Non-blocking advice (e.g. a plugin that contributes nothing) */
  warnings: string[];
}

/** Resolve a path that may point at a plugin dir or directly at its plugin.json */
function resolvePluginDir(pathArg: string): string {
  const abs = resolve(pathArg);
  if (existsSync(abs) && statSync(abs).isFile() && basename(abs) === PLUGIN_MANIFEST_FILE) {
    return resolve(abs, '..');
  }
  return abs;
}

/**
 * Validate a plugin directory the way the host does at discovery, plus author
 * niceties: id/dir match, entry files exist and stay inside the directory,
 * and a warning when a plugin declares no way to run.
 */
export function validatePluginDirectory(pathArg: string): PluginDirValidation {
  const dir = resolvePluginDir(pathArg);
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    return { valid: false, dir, manifest: null, errors: [`not a directory: ${dir}`], warnings };
  }

  const manifestPath = join(dir, PLUGIN_MANIFEST_FILE);
  if (!existsSync(manifestPath)) {
    return { valid: false, dir, manifest: null, errors: [`missing ${PLUGIN_MANIFEST_FILE}`], warnings };
  }

  let raw: unknown;
  try {
    raw = safeJsonParse(readFileSync(manifestPath, 'utf-8'));
  } catch (error) {
    return {
      valid: false,
      dir,
      manifest: null,
      errors: [`${PLUGIN_MANIFEST_FILE} is not valid JSON: ${String(error)}`],
      warnings,
    };
  }

  const result = validatePluginManifest(raw);
  if (!result.valid || !result.manifest) {
    return { valid: false, dir, manifest: null, errors: result.errors, warnings };
  }
  const manifest = result.manifest;

  // The directory name is the plugin's identity on disk (the host refuses a
  // mismatch to stop id spoofing / built-in shadowing).
  if (manifest.id !== basename(dir)) {
    errors.push(`manifest id '${manifest.id}' must match its directory name '${basename(dir)}'`);
  }

  // Declared entry files must exist and stay inside the plugin directory.
  const root = resolve(dir);
  for (const which of ['renderer', 'main'] as const) {
    const rel = manifest.entries?.[which];
    if (!rel) continue;
    const abs = resolve(root, rel);
    if (abs !== root && !abs.startsWith(root + sep)) {
      errors.push(`entries.${which} '${rel}' escapes the plugin directory`);
    } else if (!existsSync(abs) || !statSync(abs).isFile()) {
      errors.push(`entries.${which} '${rel}' does not exist`);
    }
  }

  const hasRenderer = !!manifest.entries?.renderer;
  const hasContributes =
    (manifest.contributes?.sidePanels?.length ?? 0) > 0 ||
    (manifest.contributes?.commands?.length ?? 0) > 0;
  const hasMain = !!manifest.entries?.main;
  if (!hasRenderer && !hasMain && !hasContributes) {
    warnings.push('plugin declares no entries and no contributions — it will do nothing');
  }
  if (hasContributes && !hasRenderer) {
    warnings.push('declares panels/commands but no renderer entry to supply their code');
  }

  return { valid: errors.length === 0, dir, manifest, errors, warnings };
}

export interface ScaffoldOptions {
  id: string;
  /** Parent directory the new plugin folder is created under */
  dir: string;
  /** Overwrite an existing directory */
  force?: boolean;
}

export interface ScaffoldResult {
  /** Absolute path to the created plugin directory */
  path: string;
  /** Files written (relative to the plugin directory) */
  files: string[];
}

function titleize(id: string): string {
  return id
    .split('-')
    .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(' ');
}

/** The manifest + renderer a `plugin new` scaffold writes (also used in tests) */
export function renderPluginScaffold(id: string): { manifest: string; renderer: string } {
  const name = titleize(id);
  const manifest: PluginManifest = {
    id,
    name,
    version: '0.1.0',
    description: `${name} — a Craft Agents plugin.`,
    icon: '🧩',
    apiVersion: 1,
    permissions: ['ui.sidePanel', 'storage'],
    contributes: { sidePanels: [{ id: 'main', title: name, icon: '🧩', location: 'right' }] },
    entries: { renderer: 'renderer.mjs' },
    defaultEnabled: false,
  };

  // No build step: the entry is plain ESM and builds UI with the host's React
  // (ctx.react) instead of importing its own copy or using JSX.
  const renderer = `// ${name} — a Craft Agents plugin (no build step required).
// Loaded from disk; use the host's React via ctx.react — don't import react.

export function activate(ctx) {
  const { useState } = ctx.react

  function Panel() {
    const [count, setCount] = useState(() => ctx.storage.get('count', 0))
    return ctx.react.createElement(
      'div',
      { className: 'h-full flex flex-col items-center justify-center gap-3' },
      ctx.react.createElement('div', { className: 'text-sm' }, 'Hello from ${name} 🧩'),
      ctx.react.createElement(
        'button',
        {
          className: 'px-3 py-1.5 text-xs rounded-md bg-foreground/10 hover:bg-foreground/15',
          onClick: () => {
            const next = count + 1
            setCount(next)
            ctx.storage.set('count', next) // scoped to this plugin, survives restarts
          },
        },
        'Clicked ' + count + ' times',
      ),
    )
  }

  ctx.ui.registerSidePanel({ id: 'main', title: '${name}', component: Panel })
}
`;

  return { manifest: JSON.stringify(manifest, null, 2) + '\n', renderer };
}

/** Create a runnable starter plugin under `dir/id/`. */
export function scaffoldPlugin(opts: ScaffoldOptions): ScaffoldResult {
  const path = join(resolve(opts.dir), opts.id);
  if (existsSync(path) && !opts.force) {
    throw new Error(`refusing to overwrite existing directory: ${path} (use --force)`);
  }
  mkdirSync(path, { recursive: true });

  const { manifest, renderer } = renderPluginScaffold(opts.id);
  writeFileSync(join(path, PLUGIN_MANIFEST_FILE), manifest);
  writeFileSync(join(path, 'renderer.mjs'), renderer);

  return { path, files: [PLUGIN_MANIFEST_FILE, 'renderer.mjs'] };
}
