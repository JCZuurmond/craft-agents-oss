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
import { join } from 'path';
import { atomicWriteFileSync, safeJsonParse } from '../utils/files.ts';
import { validatePluginManifest } from './validation.ts';
import {
  PLUGINS_CONFIG_VERSION,
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
 * Load a single external plugin from {pluginsDir}/{id}/.
 * Returns null when the directory has no parseable, valid manifest or the
 * manifest id doesn't match its directory name (prevents id spoofing).
 */
export function loadExternalPlugin(pluginsDir: string, id: string): LoadedPlugin | null {
  const pluginDir = join(pluginsDir, id);
  const manifestPath = join(pluginDir, PLUGIN_MANIFEST_FILE);

  if (!existsSync(pluginDir) || !statSync(pluginDir).isDirectory()) return null;
  if (!existsSync(manifestPath)) return null;

  let raw: unknown;
  try {
    raw = safeJsonParse(readFileSync(manifestPath, 'utf-8'));
  } catch {
    return null;
  }

  const result = validatePluginManifest(raw);
  if (!result.valid || !result.manifest) return null;
  if (result.manifest.id !== id) return null;

  return { manifest: result.manifest, source: 'user', path: pluginDir };
}

/**
 * Discover all external plugins under {configDir}/plugins/.
 * Invalid or unparseable plugins are skipped silently, matching how
 * sources/skills tolerate broken directories.
 */
export function loadExternalPlugins(configDir?: string): LoadedPlugin[] {
  const pluginsDir = getPluginsDir(configDir);
  if (!existsSync(pluginsDir)) return [];

  const plugins: LoadedPlugin[] = [];
  try {
    for (const entry of readdirSync(pluginsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const plugin = loadExternalPlugin(pluginsDir, entry.name);
      if (plugin) plugins.push(plugin);
    }
  } catch {
    // Ignore errors reading the plugins directory
  }
  return plugins;
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
