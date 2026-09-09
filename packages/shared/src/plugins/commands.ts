/**
 * Plugin Command Registry
 *
 * Host-agnostic registry mapping fully-qualified command ids
 * (`{pluginId}.{commandId}`, see qualifiedCommandId) to handlers registered by
 * activated plugins. Commands are the universal editor extensibility
 * primitive — VS Code commands, Emacs interactive commands, Vim ex
 * commands — and everything user-invocable (keybindings, future palette/menu
 * items) dispatches through this one registry.
 *
 * The registry is deliberately dumb: it does not know about manifests, lazy
 * activation, or keybindings. Hosts compose those on top (the Electron
 * renderer's command store resolves declared-but-unregistered commands by
 * activating the owning plugin first, then executing).
 */

import type { PluginDisposable } from './types.ts';
import { qualifiedCommandId } from './types.ts';

export type PluginCommandHandler = (args?: unknown) => unknown | Promise<unknown>;

export interface RegisteredPluginCommand {
  /** Fully-qualified id: `{pluginId}.{commandId}` */
  qualifiedId: string;
  pluginId: string;
  commandId: string;
}

export class PluginCommandRegistry {
  private handlers = new Map<string, { pluginId: string; commandId: string; handler: PluginCommandHandler }>();

  /**
   * Register a handler for `{pluginId}.{commandId}`. Duplicate registrations
   * throw (a plugin registering the same command twice is a bug worth
   * surfacing at activation time, when the registry isolates the error).
   * Returns a disposable that unregisters the handler.
   */
  register(pluginId: string, commandId: string, handler: PluginCommandHandler): PluginDisposable {
    const qualifiedId = qualifiedCommandId(pluginId, commandId);
    if (this.handlers.has(qualifiedId)) {
      throw new Error(`Plugin command already registered: ${qualifiedId}`);
    }
    this.handlers.set(qualifiedId, { pluginId, commandId, handler });
    return {
      dispose: () => {
        const entry = this.handlers.get(qualifiedId);
        if (entry && entry.handler === handler) this.handlers.delete(qualifiedId);
      },
    };
  }

  has(qualifiedId: string): boolean {
    return this.handlers.has(qualifiedId);
  }

  /** All currently registered commands (not declared-but-inactive ones) */
  list(): RegisteredPluginCommand[] {
    return Array.from(this.handlers.values()).map(({ pluginId, commandId }) => ({
      qualifiedId: qualifiedCommandId(pluginId, commandId),
      pluginId,
      commandId,
    }));
  }

  /** Remove every command a plugin registered (deactivation sweep) */
  unregisterPlugin(pluginId: string): void {
    for (const [qualifiedId, entry] of this.handlers) {
      if (entry.pluginId === pluginId) this.handlers.delete(qualifiedId);
    }
  }

  /**
   * Execute a registered command. Rejects when the command is not registered
   * (hosts that support lazy activation resolve the plugin *before* calling
   * this) or when the handler throws — the error stays scoped to this call,
   * never to the registry.
   */
  async execute(qualifiedId: string, args?: unknown): Promise<unknown> {
    const entry = this.handlers.get(qualifiedId);
    if (!entry) {
      throw new Error(`No handler registered for plugin command '${qualifiedId}'`);
    }
    return await entry.handler(args);
  }
}
