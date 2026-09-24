/**
 * Plugin Hook Registry
 *
 * Emacs-style named hooks (also the shape of Vim autocommands): the host
 * defines a fixed vocabulary of hook points and runs every listener added to
 * a hook when it fires. Listeners observe — they cannot veto or reorder host
 * behavior — and each listener is error-isolated, matching Emacs `run-hooks`
 * semantics where one broken hook function must not break the others or the
 * caller.
 *
 * The registry is generic over the hook map (hook name → payload type); the
 * Electron renderer host instantiates it with its own vocabulary. Agent and
 * session events are deliberately NOT hooks — they stay reserved behind the
 * documented `events.read` permission (a WorkspaceEventBus mirror), see
 * docs/plugins/DESIGN.md.
 */

import type { PluginDisposable } from './types.ts';

export type PluginHookListener<Payload> = (payload: Payload) => void;

export class PluginHookRegistry<HookMap> {
  private listeners = new Map<keyof HookMap, Set<PluginHookListener<never>>>();

  /**
   * Add a listener to a named hook. Returns a disposable that removes it
   * (hosts hand this to the plugin context so deactivation sweeps hooks
   * automatically).
   */
  on<K extends keyof HookMap>(hook: K, listener: PluginHookListener<HookMap[K]>): PluginDisposable {
    let set = this.listeners.get(hook);
    if (!set) {
      set = new Set();
      this.listeners.set(hook, set);
    }
    set.add(listener as PluginHookListener<never>);
    return {
      dispose: () => {
        set.delete(listener as PluginHookListener<never>);
      },
    };
  }

  /**
   * Run every listener on a hook with the payload. A throwing listener is
   * reported through `onListenerError` (default: swallowed) and never
   * prevents the remaining listeners — or the emitting host code — from
   * running.
   */
  emit<K extends keyof HookMap>(hook: K, payload: HookMap[K]): void {
    const set = this.listeners.get(hook);
    if (!set) return;
    for (const listener of Array.from(set)) {
      try {
        (listener as PluginHookListener<HookMap[K]>)(payload);
      } catch (error) {
        this.onListenerError?.(String(hook), error);
      }
    }
  }

  /** How many listeners a hook currently has (test/introspection helper) */
  count(hook: keyof HookMap): number {
    return this.listeners.get(hook)?.size ?? 0;
  }

  /** Host-installable reporter for throwing listeners */
  onListenerError?: (hook: string, error: unknown) => void;
}
