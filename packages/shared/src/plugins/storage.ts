/**
 * Plugin Storage
 *
 * Discovery of external plugins and persistence of enable/disable state.
 *
 * - External plugins: {configDir}/plugins/{id}/plugin.json
 * - Enablement state: {configDir}/plugins.json (app-level, like preferences.json)
 *
 * All functions accept an optional configDir override (used by tests and
 * multi-instance dev); the default follows CRAFT_CONFIG_DIR like config/paths.ts.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'fs';
import { homedir } from 'os';
import { join, resolve, sep } from 'path';
import { atomicWriteFileSync, safeJsonParse } from '../utils/files.ts';
import { validatePluginManifest } from './validation.ts';
import {
  PLUGINS_CONFIG_VERSION,
  type ExternalPluginDiscovery,
  type InvalidExternalPlugin,
  type LoadedPlugin,
  type PluginManifest,
  type PluginsConfig,
} from './types.ts';

export const PLUGIN_MANIFEST_FILE = 'plugin.json';
export const PLUGINS_CONFIG_FILE = 'plugins.json';
export const PLUGINS_DIR_NAME = 'plugins';

/** Resolved lazily (not at module load) so tests can point CRAFT_CONFIG_DIR at a temp dir */
function defaultConfigDir(): string {
  return process.env.CRAFT_CONFIG_DIR || join(homedir(), '.craft-agent');
}

/** Directory containing external plugins: {configDir}/plugins/ */
export function getPluginsDir(configDir?: string): string {
  return join(configDir ?? defaultConfigDir(), PLUGINS_DIR_NAME);
}

/** Path to the app-level enablement state file: {configDir}/plugins.json */
export function getPluginsConfigPath(configDir?: string): string {
  return join(configDir ?? defaultConfigDir(), PLUGINS_CONFIG_FILE);
}

// ============================================================
// Discovery
// ============================================================

/**
 * One external plugin directory's load outcome:
 * - `{ plugin }`  — a valid, loadable plugin
 * - `{ invalid }` — a directory with a manifest that failed to load/validate
 * - `null`        — not a plugin directory at all (no manifest present)
 */
type ExternalPluginLoad =
  | { plugin: LoadedPlugin; invalid?: undefined }
  | { plugin?: undefined; invalid: InvalidExternalPlugin }
  | null;

/**
 * Load a single external plugin directory, distinguishing "valid",
 * "present-but-invalid", and "not a plugin dir". `id` is the directory name.
 */
function loadExternalPluginDetailed(pluginsDir: string, id: string): ExternalPluginLoad {
  const pluginDir = join(pluginsDir, id);
  const manifestPath = join(pluginDir, PLUGIN_MANIFEST_FILE);

  if (!existsSync(pluginDir) || !statSync(pluginDir).isDirectory()) return null;
  // No manifest at all → this isn't a plugin directory; don't report it.
  if (!existsSync(manifestPath)) return null;

  const invalid = (errors: string[]): ExternalPluginLoad => ({
    invalid: { id, path: pluginDir, errors },
  });

  let raw: unknown;
  try {
    raw = safeJsonParse(readFileSync(manifestPath, 'utf-8'));
  } catch (error) {
    return invalid([`${PLUGIN_MANIFEST_FILE} is not readable or valid JSON: ${String(error)}`]);
  }

  const result = validatePluginManifest(raw);
  if (!result.valid || !result.manifest) {
    return invalid(result.errors.length > 0 ? result.errors : ['manifest failed validation']);
  }
  // The directory name is the plugin's identity on disk; a mismatched id would
  // let one plugin masquerade as another (or shadow a built-in).
  if (result.manifest.id !== id) {
    return invalid([
      `manifest id '${result.manifest.id}' must match its directory name '${id}'`,
    ]);
  }

  return { plugin: { manifest: result.manifest, source: 'user', path: pluginDir } };
}

/**
 * Load a single external plugin from {pluginsDir}/{id}/.
 * Returns null when the directory has no parseable, valid manifest or the
 * manifest id doesn't match its directory name (prevents id spoofing).
 */
export function loadExternalPlugin(pluginsDir: string, id: string): LoadedPlugin | null {
  return loadExternalPluginDetailed(pluginsDir, id)?.plugin ?? null;
}

/**
 * Discover all external plugins under {configDir}/plugins/, keeping both the
 * valid plugins and the directories whose manifest failed to load. Invalid
 * entries carry human-readable reasons so the host can surface them in
 * Settings instead of dropping them silently.
 */
export function loadExternalPluginsDetailed(configDir?: string): ExternalPluginDiscovery {
  const pluginsDir = getPluginsDir(configDir);
  if (!existsSync(pluginsDir)) return { plugins: [], invalid: [] };

  const plugins: LoadedPlugin[] = [];
  const invalid: InvalidExternalPlugin[] = [];
  try {
    for (const entry of readdirSync(pluginsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const loaded = loadExternalPluginDetailed(pluginsDir, entry.name);
      if (!loaded) continue;
      if (loaded.plugin) plugins.push(loaded.plugin);
      else invalid.push(loaded.invalid);
    }
  } catch {
    // Ignore errors reading the plugins directory itself
  }
  return { plugins, invalid };
}

/**
 * Discover all valid external plugins under {configDir}/plugins/.
 * (Thin wrapper over loadExternalPluginsDetailed for callers that don't need
 * the invalid list.)
 */
export function loadExternalPlugins(configDir?: string): LoadedPlugin[] {
  return loadExternalPluginsDetailed(configDir).plugins;
}

/**
 * Resolve an external plugin's entry file to an absolute path, guarding
 * against path escapes — a manifest entry like `../../evil.js` is refused so
 * a plugin can only load code from inside its own directory. Returns null
 * when the plugin declares no such entry, the entry escapes the plugin
 * directory, or the target file does not exist.
 *
 * Built-in plugins have their code compiled in and always resolve to null.
 */
export function resolvePluginEntryFile(
  plugin: LoadedPlugin,
  which: 'renderer' | 'main',
): string | null {
  if (plugin.source !== 'user' || !plugin.path) return null;
  const rel = plugin.manifest.entries?.[which];
  if (!rel) return null;

  const root = resolve(plugin.path);
  const abs = resolve(root, rel);
  // Must stay within the plugin directory (defends against '../' traversal).
  if (abs !== root && !abs.startsWith(root + sep)) return null;
  if (!existsSync(abs) || !statSync(abs).isFile()) return null;
  return abs;
}

// ============================================================
// Enablement state
// ============================================================

function emptyPluginsConfig(): PluginsConfig {
  return { version: PLUGINS_CONFIG_VERSION, plugins: {} };
}

/** Load plugins.json; tolerates a missing or corrupt file */
export function loadPluginsConfig(configDir?: string): PluginsConfig {
  const path = getPluginsConfigPath(configDir);
  if (!existsSync(path)) return emptyPluginsConfig();

  try {
    const raw = safeJsonParse(readFileSync(path, 'utf-8'));
    if (!raw || typeof raw !== 'object') return emptyPluginsConfig();
    const parsed = raw as Partial<PluginsConfig>;
    if (!parsed.plugins || typeof parsed.plugins !== 'object') return emptyPluginsConfig();

    const plugins: PluginsConfig['plugins'] = {};
    for (const [id, entry] of Object.entries(parsed.plugins)) {
      if (entry && typeof entry === 'object' && typeof entry.enabled === 'boolean') {
        plugins[id] = { enabled: entry.enabled };
      }
    }
    return { version: PLUGINS_CONFIG_VERSION, plugins };
  } catch {
    return emptyPluginsConfig();
  }
}

/** Persist plugins.json (atomic write, creates configDir if needed) */
export function savePluginsConfig(config: PluginsConfig, configDir?: string): void {
  const dir = configDir ?? defaultConfigDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  atomicWriteFileSync(getPluginsConfigPath(dir), JSON.stringify(config, null, 2));
}

/**
 * Effective enablement for a plugin: explicit user state wins, otherwise the
 * manifest's defaultEnabled (built-ins may opt into enabled-by-default;
 * external plugins are disabled until the user enables them).
 */
export function isPluginEnabled(
  manifest: PluginManifest,
  config: PluginsConfig,
  source: LoadedPlugin['source'],
): boolean {
  const entry = config.plugins[manifest.id];
  if (entry) return entry.enabled;
  if (source === 'user') return false;
  return manifest.defaultEnabled ?? false;
}

/** Set and persist enablement for a plugin id */
export function setPluginEnabled(id: string, enabled: boolean, configDir?: string): PluginsConfig {
  const config = loadPluginsConfig(configDir);
  config.plugins[id] = { enabled };
  savePluginsConfig(config, configDir);
  return config;
}
