/**
 * Plugin System
 *
 * Manifest types and validation, and the host-agnostic lifecycle registry.
 * This entry point is browser-safe: it never touches Node built-ins, so the
 * renderer can import it directly. Discovery and enablement persistence use
 * the filesystem and live in the './plugins/node' subpath (main process /
 * tests only). Hosts live in apps/electron (src/main/plugin-host.ts and
 * src/renderer/plugins/).
 */

export {
  PLUGIN_PERMISSIONS,
  PLUGIN_API_VERSION,
  MIN_SUPPORTED_PLUGIN_API_VERSION,
  PLUGIN_PANEL_LOCATIONS,
  DEFAULT_PLUGIN_PANEL_LOCATION,
  PLUGINS_CONFIG_VERSION,
  PLUGIN_WEBVIEW_PARTITION_PREFIX,
  getPluginWebviewPartition,
  manifestHasPermission,
  getManifestApiVersion,
  checkPluginApiCompatibility,
  qualifiedCommandId,
  parseActivationEvent,
  shouldActivateOnStartup,
  type PluginPermission,
  type PluginPanelLocation,
  type PluginSidePanelDeclaration,
  type PluginCommandDeclaration,
  type PluginActivationEvent,
  type ParsedActivationEvent,
  type PluginContributions,
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
  PluginContributionsSchema,
  PluginSidePanelDeclarationSchema,
  PluginCommandDeclarationSchema,
  validatePluginManifest,
} from './validation.ts';

export {
  PluginRegistry,
  type PluginActivator,
  type PluginRegistryOptions,
} from './registry.ts';

export {
  PluginCommandRegistry,
  type PluginCommandHandler,
  type RegisteredPluginCommand,
} from './commands.ts';

export {
  PluginHookRegistry,
  type PluginHookListener,
} from './hooks.ts';
