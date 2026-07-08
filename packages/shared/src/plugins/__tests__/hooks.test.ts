/**
 * Hook registry semantics: subscription/disposal, payload delivery, and
 * Emacs run-hooks error isolation (one throwing listener never blocks the
 * rest or the emitter).
 */

import { describe, test, expect } from 'bun:test';
import { PluginHookRegistry } from '../hooks.ts';

interface TestHooks extends Record<string, unknown> {
  'thing:happened': { id: string };
  'other:happened': { count: number };
}

describe('PluginHookRegistry', () => {
  test('delivers payloads to every listener on the emitted hook only', () => {
    const registry = new PluginHookRegistry<TestHooks>();
    const seen: string[] = [];
    registry.on('thing:happened', (p) => seen.push(`a:${p.id}`));
    registry.on('thing:happened', (p) => seen.push(`b:${p.id}`));
    registry.on('other:happened', (p) => seen.push(`other:${p.count}`));

    registry.emit('thing:happened', { id: 'x' });
    expect(seen).toEqual(['a:x', 'b:x']);
  });

  test('emitting a hook with no listeners is a no-op', () => {
    const registry = new PluginHookRegistry<TestHooks>();
    expect(() => registry.emit('thing:happened', { id: 'x' })).not.toThrow();
  });

  test('dispose removes exactly that listener', () => {
    const registry = new PluginHookRegistry<TestHooks>();
    const seen: string[] = [];
    const disposable = registry.on('thing:happened', () => seen.push('a'));
    registry.on('thing:happened', () => seen.push('b'));

    disposable.dispose();
    registry.emit('thing:happened', { id: 'x' });
    expect(seen).toEqual(['b']);
    expect(registry.count('thing:happened')).toBe(1);
  });

  test('a throwing listener is isolated and reported, others still run', () => {
    const registry = new PluginHookRegistry<TestHooks>();
    const errors: string[] = [];
    registry.onListenerError = (hook, error) => errors.push(`${hook}: ${String(error)}`);

    const seen: string[] = [];
    registry.on('thing:happened', () => {
      throw new Error('bad listener');
    });
    registry.on('thing:happened', () => seen.push('survivor'));

    expect(() => registry.emit('thing:happened', { id: 'x' })).not.toThrow();
    expect(seen).toEqual(['survivor']);
    expect(errors).toEqual(['thing:happened: Error: bad listener']);
  });

  test('a listener disposing itself mid-emit does not skip the others', () => {
    const registry = new PluginHookRegistry<TestHooks>();
    const seen: string[] = [];
    const disposable = registry.on('thing:happened', () => {
      seen.push('self-remover');
      disposable.dispose();
    });
    registry.on('thing:happened', () => seen.push('second'));

    registry.emit('thing:happened', { id: 'x' });
    expect(seen).toEqual(['self-remover', 'second']);
    expect(registry.count('thing:happened')).toBe(1);
  });
});
