import { describe, test, expect } from 'bun:test';
import { PluginRegistry } from '../registry.ts';
import type { LoadedPlugin, PluginDisposable } from '../types.ts';

function plugin(id: string): LoadedPlugin {
  return {
    manifest: { id, name: id, version: '1.0.0', permissions: [] },
    source: 'builtin',
  };
}

describe('PluginRegistry', () => {
  test('register rejects duplicate ids (first wins)', () => {
    const registry = new PluginRegistry({ activate: () => {} });
    expect(registry.register(plugin('a'), true)).toBe(true);
    expect(registry.register(plugin('a'), false)).toBe(false);
    expect(registry.get('a')?.enabled).toBe(true);
  });

  test('activateEnabled activates only enabled plugins', async () => {
    const activated: string[] = [];
    const registry = new PluginRegistry({
      activate: (p) => {
        activated.push(p.manifest.id);
      },
    });
    registry.register(plugin('on'), true);
    registry.register(plugin('off'), false);

    await registry.activateEnabled();

    expect(activated).toEqual(['on']);
    expect(registry.get('on')?.status).toBe('active');
    expect(registry.get('off')?.status).toBe('inactive');
  });

  test('a throwing plugin is marked errored and does not break others', async () => {
    const registry = new PluginRegistry({
      activate: (p) => {
        if (p.manifest.id === 'broken') throw new Error('boom');
      },
    });
    registry.register(plugin('broken'), true);
    registry.register(plugin('fine'), true);

    await registry.activateEnabled();

    expect(registry.get('broken')?.status).toBe('error');
    expect(registry.get('broken')?.error).toBe('boom');
    expect(registry.get('fine')?.status).toBe('active');
  });

  test('deactivate disposes registrations in reverse order, tolerating throws', async () => {
    const order: string[] = [];
    const disposables: PluginDisposable[] = [
      { dispose: () => order.push('first') },
      {
        dispose: () => {
          order.push('second');
          throw new Error('teardown fail');
        },
      },
      { dispose: () => order.push('third') },
    ];
    const registry = new PluginRegistry({ activate: () => disposables });
    registry.register(plugin('a'), true);
    await registry.activateEnabled();

    expect(registry.deactivate('a')).toBe(true);
    expect(order).toEqual(['third', 'second', 'first']);
    expect(registry.get('a')?.status).toBe('inactive');
  });

  test('setEnabled toggles activation at runtime', async () => {
    let active = 0;
    const registry = new PluginRegistry({
      activate: () => {
        active += 1;
        return { dispose: () => { active -= 1; } };
      },
    });
    registry.register(plugin('a'), false);

    await registry.setEnabled('a', true);
    expect(active).toBe(1);
    expect(registry.get('a')?.status).toBe('active');

    await registry.setEnabled('a', false);
    expect(active).toBe(0);
    expect(registry.get('a')?.status).toBe('inactive');
  });

  test('re-enabling an errored plugin retries activation', async () => {
    let shouldFail = true;
    const registry = new PluginRegistry({
      activate: () => {
        if (shouldFail) throw new Error('first try fails');
      },
    });
    registry.register(plugin('flaky'), true);
    await registry.activateEnabled();
    expect(registry.get('flaky')?.status).toBe('error');

    shouldFail = false;
    await registry.setEnabled('flaky', true);
    expect(registry.get('flaky')?.status).toBe('active');
    expect(registry.get('flaky')?.error).toBeUndefined();
  });

  test('listInfo returns serializable snapshots', async () => {
    const registry = new PluginRegistry({ activate: () => {} });
    registry.register(plugin('a'), true);
    await registry.activateEnabled();

    const info = registry.listInfo();
    expect(info).toHaveLength(1);
    expect(info[0]).toMatchObject({
      id: 'a',
      name: 'a',
      version: '1.0.0',
      source: 'builtin',
      enabled: true,
      status: 'active',
    });
    // Snapshot must be structured-clone safe for IPC
    expect(() => structuredClone(info)).not.toThrow();
  });

  test('onDidChange fires on lifecycle transitions', async () => {
    let changes = 0;
    const registry = new PluginRegistry({
      activate: () => {},
      onDidChange: () => { changes += 1; },
    });
    registry.register(plugin('a'), false);
    await registry.setEnabled('a', true);
    await registry.setEnabled('a', false);
    expect(changes).toBeGreaterThanOrEqual(2);
  });
});
