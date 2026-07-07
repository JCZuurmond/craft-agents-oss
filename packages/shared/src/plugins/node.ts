/**
 * Plugin System — Node-only surface
 *
 * External-plugin discovery and enablement persistence (fs/os access).
 * Import from '@craft-agent/shared/plugins/node' in the Electron main
 * process and tests; the browser-safe surface is '@craft-agent/shared/plugins'.
 */

export * from './index.ts';

export {
  PLUGIN_MANIFEST_FILE,
  PLUGINS_CONFIG_FILE,
  PLUGINS_DIR_NAME,
  getPluginsDir,
  getPluginsConfigPath,
  loadExternalPlugin,
  loadExternalPlugins,
  loadExternalPluginsDetailed,
  resolvePluginEntryFile,
  loadPluginsConfig,
  savePluginsConfig,
  isPluginEnabled,
  setPluginEnabled,
} from './storage.ts';

export {
  validatePluginDirectory,
  scaffoldPlugin,
  renderPluginScaffold,
  type PluginDirValidation,
  type ScaffoldOptions,
  type ScaffoldResult,
} from './authoring.ts';
