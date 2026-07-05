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
 * - `ui.sidePanel` — contribute panes to the plugin pane hosts (left or right
 *                    edge of the shell; see PluginPanelLocation)
 * - `ui.webview`  — embed remote web content in a hardened <webview> with a
 *                   dedicated `persist:craft-plugin-{id}` session partition.
 *                   This is a sub-capability of a side panel, not a standalone
 *                   contribution: the <webview> renders inside a panel the
 *                   plugin contributes via `ui.sidePanel`.
 * - `commands`    — contribute user-invocable commands (and their keybindings)
 *                   and execute commands through the host command registry
 * - `storage`     — persistent key-value storage scoped to the plugin
 * - `ipc`         — invoke main-process handlers registered for this plugin
 *                   (channels namespaced `plugin:{id}:{channel}`)
 *
 * Reserved (documented, intentionally not implemented yet — see
 * docs/plugins/DESIGN.md): `events.read` for a read-only client mirror of the
 * WorkspaceEventBus agent/tool events.
 */
export const PLUGIN_PERMISSIONS = [
  'ui.sidePanel',
  'ui.webview',
  'commands',
  'storage',
  'ipc',
] as const;

export type PluginPermission = (typeof PLUGIN_PERMISSIONS)[number];

// ============================================================
// Plugin API versioning
// ============================================================

/**
 * The plugin API version this host implements. Bumped when the plugin↔host
 * contract (PluginContext surfaces, manifest semantics, IPC envelope) changes
 * incompatibly. Manifests pin the version they target via `apiVersion`
 * (missing = 1); hosts refuse to activate plugins that target a version they
 * cannot satisfy, surfacing the reason in Settings instead of failing
 * silently on upgrade.
 */
export const PLUGIN_API_VERSION = 1;

/** Oldest manifest apiVersion this host still activates */
export const MIN_SUPPORTED_PLUGIN_API_VERSION = 1;

/** The API version a manifest targets (missing = 1, the initial version) */
export function getManifestApiVersion(manifest: PluginManifest): number {
  return manifest.apiVersion ?? 1;
}

/**
 * Check whether this host can activate a plugin targeting the manifest's
 * apiVersion. Returns a human-readable incompatibility reason, or null when
 * compatible.
 */
export function checkPluginApiCompatibility(manifest: PluginManifest): string | null {
  const target = getManifestApiVersion(manifest);
  if (target > PLUGIN_API_VERSION) {
    return `Requires plugin API v${target}; this app provides v${PLUGIN_API_VERSION}. Update the app to use this plugin.`;
  }
  if (target < MIN_SUPPORTED_PLUGIN_API_VERSION) {
    return `Targets plugin API v${target}, which this app no longer supports (minimum v${MIN_SUPPORTED_PLUGIN_API_VERSION}). Update the plugin.`;
  }
  return null;
}

// ============================================================
// Declarative contributions (manifest `contributes` block)
// ============================================================

/**
 * Shell edges that host plugin side panels. New UI locations become new
 * members of this union plus a host mount — a data change, not a new
 * architecture (the contribution-slot indirection from REVIEW.md M1).
 */
export const PLUGIN_PANEL_LOCATIONS = ['left', 'right'] as const;

export type PluginPanelLocation = (typeof PLUGIN_PANEL_LOCATIONS)[number];

export const DEFAULT_PLUGIN_PANEL_LOCATION: PluginPanelLocation = 'right';

/**
 * A side panel declared statically in the manifest. Declared panels are
 * introspectable without running plugin code (Settings can list them) and
 * enable lazy activation: the host renders the panel's toggle button from
 * this data and only activates the plugin when the panel is first opened.
 * The plugin's renderer entry supplies the panel component at activation
 * time via `ctx.ui.registerSidePanel()` with the same panel id.
 */
export interface PluginSidePanelDeclaration {
  /** Panel id, unique within the plugin (slug-style) */
  id: string;
  /** Title shown in the pane header and toggle-rail tooltip */
  title: string;
  /** Emoji shown in the toggle rail (falls back to the manifest icon) */
  icon?: string;
  /** Which shell edge hosts the panel (default 'right') */
  location?: PluginPanelLocation;
}

/**
 * A command declared statically in the manifest — the universal extensibility
 * primitive shared by VS Code (`contributes.commands`), Emacs (interactive
 * commands), and Vim (ex commands). Declared commands are introspectable
 * without running plugin code and enable lazy activation: a keybinding (or an
 * `executeCommand` call) for a declared command activates the plugin first,
 * then dispatches. The plugin's renderer entry supplies the handler at
 * activation time via `ctx.commands.register()` with the same command id.
 */
export interface PluginCommandDeclaration {
  /** Command id, unique within the plugin (slug-style) */
  id: string;
  /** Human-readable title, e.g. shown next to the keybinding in Settings */
  title: string;
  /**
   * Optional keybinding in the app's hotkey format, e.g. 'mod+shift+b'
   * ('mod' = Cmd on macOS, Ctrl elsewhere; modifiers: mod/shift/alt).
   * Must include 'mod' or 'alt' — bare keys and shift-only chords are
   * reserved for typing. Core app shortcuts always take precedence.
   */
  keybinding?: string;
}

/**
 * Static contribution metadata — what a plugin offers, separated from what it
 * does (`activate()`), following the VS Code/Eclipse declarative model.
 *
 * Reserved vocabulary (documented, intentionally not implemented yet):
 * `settingsPages`, `statusItems`, and a top-level manifest `dependencies`
 * field. See docs/plugins/DESIGN.md before adding any of them.
 */
export interface PluginContributions {
  /** Side panels rendered by the plugin pane hosts (requires 'ui.sidePanel') */
  sidePanels?: PluginSidePanelDeclaration[];
  /** User-invocable commands with optional keybindings (requires 'commands') */
  commands?: PluginCommandDeclaration[];
}

/**
 * Fully-qualified command id used by the host command registry:
 * `{pluginId}.{commandId}` (the VS Code dotted-id convention).
 */
export function qualifiedCommandId(pluginId: string, commandId: string): string {
  return `${pluginId}.${commandId}`;
}

// ============================================================
// Activation events (lazy activation vocabulary)
// ============================================================

/**
 * When a plugin's `activate()` runs — the VS Code `activationEvents` idea
 * (and the spirit of Vim's autoload: code loads when first used).
 *
 * - `onStartup`            — activate eagerly when the host initializes
 * - `onPanel:{panelId}`    — activate when the declared panel is first opened
 * - `onCommand:{commandId}` — activate when the declared command is first
 *                             executed (keybinding or `executeCommand`)
 *
 * When `activationEvents` is absent the host infers a policy that preserves
 * pre-activationEvents behavior: plugins with declared side panels are lazy
 * (as if `onPanel:` were listed for each), plugins with declared commands are
 * lazy on those commands, and plugins with no declarative contributions
 * activate at startup (their contributions exist only in code).
 */
export type PluginActivationEvent =
  | 'onStartup'
  | `onPanel:${string}`
  | `onCommand:${string}`;

/** Parsed form of one activation event */
export type ParsedActivationEvent =
  | { kind: 'onStartup' }
  | { kind: 'onPanel'; panelId: string }
  | { kind: 'onCommand'; commandId: string };

/** Parse one activation-event string; returns null when malformed */
export function parseActivationEvent(event: string): ParsedActivationEvent | null {
  if (event === 'onStartup') return { kind: 'onStartup' };
  if (event.startsWith('onPanel:')) {
    const panelId = event.slice('onPanel:'.length);
    return panelId ? { kind: 'onPanel', panelId } : null;
  }
  if (event.startsWith('onCommand:')) {
    const commandId = event.slice('onCommand:'.length);
    return commandId ? { kind: 'onCommand', commandId } : null;
  }
  return null;
}

/**
 * Should the host activate this plugin at startup (vs lazily on first use)?
 * Explicit `activationEvents` win; the implicit default keeps plugins with
 * declarative contributions lazy and code-only plugins eager.
 */
export function shouldActivateOnStartup(manifest: PluginManifest): boolean {
  const events = manifest.activationEvents;
  if (events && events.length > 0) {
    return events.some((e) => parseActivationEvent(e)?.kind === 'onStartup');
  }
  const panels = manifest.contributes?.sidePanels?.length ?? 0;
  const commands = manifest.contributes?.commands?.length ?? 0;
  return panels === 0 && commands === 0;
}

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
  /**
   * Plugin API version this plugin targets (missing = 1). Hosts refuse to
   * activate plugins targeting a version outside their supported range and
   * surface the reason in Settings (see checkPluginApiCompatibility).
   */
  apiVersion?: number;
  /** Static contribution metadata (introspectable without running code) */
  contributes?: PluginContributions;
  /**
   * When the plugin activates (see PluginActivationEvent). Absent = inferred
   * from declared contributions (declared panels/commands → lazy, else eager).
   */
  activationEvents?: PluginActivationEvent[];
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
  /**
   * Populated when the host cannot activate this plugin at all (e.g. it
   * targets an unsupported apiVersion). Incompatible plugins are listed in
   * Settings with this reason but can never be activated or enabled.
   */
  incompatibility?: string;
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
  /** Static contribution metadata declared in the manifest */
  contributes?: PluginContributions;
  source: PluginSource;
  enabled: boolean;
  status: PluginStatus;
  error?: string;
  /** Set when the host can never activate this plugin (see PluginRegistryEntry) */
  incompatibility?: string;
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

/** Does the manifest declare a permission? */
export function manifestHasPermission(
  manifest: PluginManifest,
  permission: PluginPermission,
): boolean {
  return manifest.permissions.includes(permission);
}
