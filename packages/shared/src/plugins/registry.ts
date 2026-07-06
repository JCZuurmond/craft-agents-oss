/**
 * Plugin Registry
 *
 * Host-agnostic registry tracking discovered plugins, their persisted
 * enablement, and their runtime lifecycle (inactive → active → inactive,
 * with error isolation). Hosts (Electron main, renderer) supply an activator
 * that performs the actual side effects and returns disposables.
 */

import type {
  LoadedPlugin,
  PluginDisposable,
  PluginInfo,
  PluginRegistryEntry,
} from './types.ts';

/**
 * Performs host-specific activation for one plugin (mount UI, register IPC…).
 * May return disposables that the registry tears down on deactivate.
 * Throwing marks the plugin as errored without affecting other plugins.
 */
export type PluginActivator = (
  plugin: LoadedPlugin,
) => PluginDisposable | PluginDisposable[] | void | Promise<PluginDisposable | PluginDisposable[] | void>;

export interface PluginRegistryOptions {
  activate: PluginActivator;
  /** Optional hook invoked after a plugin is fully deactivated */
  onDidChange?: () => void;
}

export class PluginRegistry {
  private entries = new Map<string, PluginRegistryEntry>();
  private disposables = new Map<string, PluginDisposable[]>();
  /** In-flight async activations, deduped per plugin id */
  private pendingActivations = new Map<string, Promise<boolean>>();
  /** Set by disposeAll(): late async activations must not commit after teardown */
  private disposed = false;
  private readonly activator: PluginActivator;
  private readonly onDidChange?: () => void;

  constructor(options: PluginRegistryOptions) {
    this.activator = options.activate;
    this.onDidChange = options.onDidChange;
  }

  /**
   * Register a discovered plugin. Duplicate ids are rejected (first
   * registration wins — built-ins are registered before external plugins, so
   * an external plugin can never shadow a built-in).
   *
   * A plugin registered with an `incompatibility` reason (e.g. it targets an
   * unsupported apiVersion) is listed with status 'error' and can never be
   * activated or enabled — the reason is surfaced instead of a silent no-op.
   */
  register(plugin: LoadedPlugin, enabled: boolean, options?: { incompatibility?: string }): boolean {
    if (this.entries.has(plugin.manifest.id)) return false;
    const incompatibility = options?.incompatibility;
    this.entries.set(plugin.manifest.id, {
      ...plugin,
      enabled: incompatibility ? false : enabled,
      status: incompatibility ? 'error' : 'inactive',
      error: incompatibility,
      incompatibility,
    });
    return true;
  }

  get(id: string): PluginRegistryEntry | undefined {
    return this.entries.get(id);
  }

  list(): PluginRegistryEntry[] {
    return Array.from(this.entries.values());
  }

  /** Serializable snapshot for IPC / Settings UI */
  listInfo(): PluginInfo[] {
    return this.list().map((entry) => ({
      id: entry.manifest.id,
      name: entry.manifest.name,
      version: entry.manifest.version,
      description: entry.manifest.description,
      icon: entry.manifest.icon,
      permissions: entry.manifest.permissions,
      contributes: entry.manifest.contributes,
      source: entry.source,
      enabled: entry.enabled,
      status: entry.status,
      error: entry.error,
      incompatibility: entry.incompatibility,
    }));
  }

  /** Activate every registered, enabled, inactive plugin */
  async activateEnabled(): Promise<void> {
    for (const entry of this.entries.values()) {
      if (entry.enabled && entry.status === 'inactive') {
        await this.activate(entry.manifest.id);
      }
    }
  }

  /**
   * Activate one plugin; errors are captured on the entry, never thrown.
   *
   * Async-safe: concurrent calls for the same id share one in-flight
   * activation, and a result that resolves after the plugin was disabled
   * mid-flight (or the registry was disposed) is discarded — its disposables
   * are torn down immediately and the entry stays 'inactive'. Without this,
   * `setEnabled(id, false)` during a slow activator would leave an active
   * disabled plugin behind.
   */
  activate(id: string): Promise<boolean> {
    const pending = this.pendingActivations.get(id);
    if (pending) return pending;

    const entry = this.entries.get(id);
    if (!entry || entry.status === 'active' || entry.incompatibility || this.disposed) {
      return Promise.resolve(false);
    }

    const activation = (async (): Promise<boolean> => {
      try {
        const result = await this.activator(entry);
        const disposables = result == null ? [] : Array.isArray(result) ? result : [result];
        // Commit only if the plugin is still wanted: `enabled` reflects the
        // latest setEnabled() intent, `disposed` covers teardown.
        if (!entry.enabled || this.disposed) {
          for (const disposable of disposables.reverse()) {
            try {
              disposable.dispose();
            } catch {
              // ignore teardown failures
            }
          }
          this.onDidChange?.();
          return false;
        }
        this.disposables.set(id, disposables);
        entry.status = 'active';
        entry.error = undefined;
        this.onDidChange?.();
        return true;
      } catch (error) {
        // A failure for a plugin that was disabled mid-flight is moot — the
        // user already turned it off; don't surface a stale error state.
        if (entry.enabled && !this.disposed) {
          entry.status = 'error';
          entry.error = error instanceof Error ? error.message : String(error);
        }
        this.onDidChange?.();
        return false;
      }
    })();
    // Register before attaching cleanup: a synchronously-throwing activator
    // settles `activation` before this line runs, so an inline finally-delete
    // would be overwritten by the set() below and leave a stale pending entry.
    this.pendingActivations.set(id, activation);
    void activation.finally(() => this.pendingActivations.delete(id));
    return activation;
  }

  /** Deactivate one plugin, disposing everything it registered */
  deactivate(id: string): boolean {
    const entry = this.entries.get(id);
    if (!entry || entry.status !== 'active') return false;

    const disposables = this.disposables.get(id) ?? [];
    this.disposables.delete(id);
    // Dispose in reverse registration order; a throwing disposable must not
    // leak the rest.
    for (const disposable of disposables.reverse()) {
      try {
        disposable.dispose();
      } catch {
        // ignore teardown failures
      }
    }
    entry.status = 'inactive';
    this.onDidChange?.();
    return true;
  }

  /**
   * Apply a new enablement value: persists are the caller's job, this just
   * updates runtime state (activating or deactivating as needed).
   */
  async setEnabled(id: string, enabled: boolean): Promise<boolean> {
    const entry = this.entries.get(id);
    if (!entry) return false;
    if (entry.incompatibility) return false;

    entry.enabled = enabled;
    if (enabled && entry.status === 'inactive') {
      return this.activate(id);
    }
    if (!enabled && entry.status === 'active') {
      return this.deactivate(id);
    }
    // Re-enabling an errored plugin retries activation
    if (enabled && entry.status === 'error') {
      entry.status = 'inactive';
      return this.activate(id);
    }
    this.onDidChange?.();
    return true;
  }

  /**
   * Tear down all active plugins (app shutdown / window unload). Terminal:
   * in-flight async activations are discarded when they resolve, and no new
   * activation can start afterwards.
   */
  disposeAll(): void {
    this.disposed = true;
    for (const id of this.entries.keys()) {
      this.deactivate(id);
    }
  }
}
