/**
 * Command registry semantics: registration/duplicate rules, qualified-id
 * dispatch, per-plugin unregistration, and error scoping on execute.
 */

import { describe, test, expect } from 'bun:test';
import { PluginCommandRegistry } from '../commands.ts';
import { qualifiedCommandId } from '../types.ts';

describe('qualifiedCommandId', () => {
  test('joins plugin and command ids with a dot', () => {
    expect(qualifiedCommandId('web-browser', 'open')).toBe('web-browser.open');
  });
});

describe('PluginCommandRegistry', () => {
  test('registers and executes a command with args', async () => {
    const registry = new PluginCommandRegistry();
    registry.register('demo', 'greet', (args) => `hello ${(args as { name: string }).name}`);

    expect(registry.has('demo.greet')).toBe(true);
    expect(await registry.execute('demo.greet', { name: 'world' })).toBe('hello world');
  });

  test('rejects duplicate registrations for the same qualified id', () => {
    const registry = new PluginCommandRegistry();
    registry.register('demo', 'greet', () => {});
    expect(() => registry.register('demo', 'greet', () => {})).toThrow('already registered');
  });

  test('same command id under different plugins does not collide', () => {
    const registry = new PluginCommandRegistry();
    registry.register('a', 'run', () => 'a');
    registry.register('b', 'run', () => 'b');
    expect(registry.list().map((c) => c.qualifiedId).sort()).toEqual(['a.run', 'b.run']);
  });

  test('dispose unregisters exactly the registered handler', async () => {
    const registry = new PluginCommandRegistry();
    const disposable = registry.register('demo', 'greet', () => 'one');
    disposable.dispose();
    expect(registry.has('demo.greet')).toBe(false);

    // Re-registration works, and a stale dispose of the old handler is a no-op.
    registry.register('demo', 'greet', () => 'two');
    disposable.dispose();
    expect(await registry.execute('demo.greet')).toBe('two');
  });

  test('unregisterPlugin sweeps only that plugin', () => {
    const registry = new PluginCommandRegistry();
    registry.register('a', 'one', () => {});
    registry.register('a', 'two', () => {});
    registry.register('b', 'one', () => {});
    registry.unregisterPlugin('a');
    expect(registry.list().map((c) => c.qualifiedId)).toEqual(['b.one']);
  });

  test('execute rejects for unknown commands', async () => {
    const registry = new PluginCommandRegistry();
    await expect(registry.execute('nope.missing')).rejects.toThrow("No handler registered");
  });

  test('a throwing handler rejects that call without corrupting the registry', async () => {
    const registry = new PluginCommandRegistry();
    registry.register('demo', 'boom', () => {
      throw new Error('handler exploded');
    });
    await expect(registry.execute('demo.boom')).rejects.toThrow('handler exploded');
    expect(registry.has('demo.boom')).toBe(true);
  });

  test('async handlers resolve through execute', async () => {
    const registry = new PluginCommandRegistry();
    registry.register('demo', 'later', async () => {
      await Promise.resolve();
      return 42;
    });
    expect(await registry.execute('demo.later')).toBe(42);
  });
});
