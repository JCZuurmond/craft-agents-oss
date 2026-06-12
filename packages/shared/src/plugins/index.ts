/**
 * Plugin System
 *
 * Manifest types and validation, on-disk discovery and enablement state, and
 * the host-agnostic lifecycle registry. Hosts live in apps/electron
 * (src/main/plugin-host.ts and src/renderer/plugins/).
 */

export {
  PLUGIN_PERMISSIONS,
  PLUGINS_CONFIG_VERSION,
  PLUGIN_WEBVIEW_PARTITION_PREFIX,
  getPluginWebviewPartition,
  manifestHasPermission,
  type PluginPermission,
  type PluginEntries,
  type PluginManifest,
  type PluginSource,
  type LoadedPlugin,
  type PluginStatus,
  type PluginRegistryEntry,
  type PluginInfo,
  type PluginsConfig,
  type PluginsConfigEntry,
  type PluginDisposable,
  type PluginManifestValidationResult,
} from './types.ts';

export {
  PluginManifestSchema,
  validatePluginManifest,
} from './validation.ts';

export {
  PLUGIN_MANIFEST_FILE,
  PLUGINS_CONFIG_FILE,
  PLUGINS_DIR_NAME,
  getPluginsDir,
  getPluginsConfigPath,
  loadExternalPlugin,
  loadExternalPlugins,
  loadPluginsConfig,
  savePluginsConfig,
  isPluginEnabled,
  setPluginEnabled,
} from './storage.ts';

export {
  PluginRegistry,
  type PluginActivator,
  type PluginRegistryOptions,
} from './registry.ts';
