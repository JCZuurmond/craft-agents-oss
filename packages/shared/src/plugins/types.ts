/**
 * Plugin System Types
 *
 * Plugins extend Craft Agents without modifying core. A plugin is described
 * by a `plugin.json` manifest, declares the permissions it needs, and is
 * activated by a host (the Electron renderer and/or main process).
 *
 * Storage layout:
 * - Built-in plugins ship with the app and register their manifests in code.
 * - External plugins live at `~/.craft-agent/plugins/{id}/plugin.json`.
 * - Enable/disable state is app-level at `~/.craft-agent/plugins.json`.
 */

/**
 * Capabilities a plugin may request. The host only grants what is declared,
 * and surfaces the declared set to the user in Settings → Plugins.
 *
 * - `ui.sidePanel` — contribute panes to the right-hand plugin pane host
 * - `ui.webview`  — embed remote web content in a hardened <webview> with a
 *                   dedicated `persist:craft-plugin-{id}` session partition
 * - `storage`     — persistent key-value storage scoped to the plugin
 * - `ipc`         — invoke main-process handlers registered for this plugin
 *                   (channels namespaced `plugin:{id}:{channel}`)
 */
export const PLUGIN_PERMISSIONS = [
  'ui.sidePanel',
  'ui.webview',
  'storage',
  'ipc',
] as const;

export type PluginPermission = (typeof PLUGIN_PERMISSIONS)[number];

/** Entry points relative to the plugin directory (informational for built-in plugins) */
export interface PluginEntries {
  /** Renderer entry — module exporting `activate(ctx)` */
  renderer?: string;
  /** Main-process entry — module exporting `activate(ctx)` */
  main?: string;
}

/** Parsed and validated plugin.json */
export interface PluginManifest {
  /** Unique slug-style id, e.g. 'web-browser' */
  id: string;
  /** Display name */
  name: string;
  /** Semver version string */
  version: string;
  /** Short description shown in Settings → Plugins */
  description?: string;
  /** Emoji or https URL (same rules as skill/source icons) */
  icon?: string;
  /** Declared capabilities — the host grants nothing else */
  permissions: PluginPermission[];
  /** Entry points relative to the plugin directory */
  entries?: PluginEntries;
  /**
   * Whether the plugin starts enabled before the user has toggled it.
   * Built-in plugins may default to true; external plugins default to false.
   */
  defaultEnabled?: boolean;
}

/** Where a plugin was discovered from */
export type PluginSource = 'builtin' | 'user';

/** A discovered plugin: manifest + provenance */
export interface LoadedPlugin {
  manifest: PluginManifest;
  source: PluginSource;
  /** Absolute path to the plugin directory (external plugins only) */
  path?: string;
}

/** Runtime lifecycle status tracked by a host's registry */
export type PluginStatus = 'inactive' | 'active' | 'error';

/** Registry entry: discovered plugin + persisted enablement + runtime status */
export interface PluginRegistryEntry extends LoadedPlugin {
  enabled: boolean;
  status: PluginStatus;
  /** Populated when status === 'error' */
  error?: string;
}

/**
 * Serializable snapshot of a registry entry, safe to send over IPC and render
 * in the Settings UI.
 */
export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  description?: string;
  icon?: string;
  permissions: PluginPermission[];
  source: PluginSource;
  enabled: boolean;
  status: PluginStatus;
  error?: string;
}

// ============================================================
// Persisted enablement state (~/.craft-agent/plugins.json)
// ============================================================

export interface PluginsConfigEntry {
  enabled: boolean;
}

export interface PluginsConfig {
  version: number;
  plugins: Record<string, PluginsConfigEntry>;
}

export const PLUGINS_CONFIG_VERSION = 1;

// ============================================================
// Host-side lifecycle plumbing
// ============================================================

/** Anything that can be torn down on deactivate */
export interface PluginDisposable {
  dispose(): void;
}

/**
 * Result of validating a plugin manifest.
 * Mirrors the `{ valid, errors }` shape used by automations validation.
 */
export interface PluginManifestValidationResult {
  valid: boolean;
  manifest: PluginManifest | null;
  errors: string[];
}

/** Prefix for per-plugin webview session partitions */
export const PLUGIN_WEBVIEW_PARTITION_PREFIX = 'persist:craft-plugin-';

/** Session partition for a plugin granted `ui.webview` */
export function getPluginWebviewPartition(pluginId: string): string {
  return `${PLUGIN_WEBVIEW_PARTITION_PREFIX}${pluginId}`;
}
