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

  test('an incompatible plugin is listed but can never activate or enable', async () => {
    let activations = 0;
    const registry = new PluginRegistry({ activate: () => { activations += 1; } });
    registry.register(plugin('too-new'), true, { incompatibility: 'Requires plugin API v99' });

    // Registered with status error and the reason, and not enabled.
    const entry = registry.get('too-new');
    expect(entry?.status).toBe('error');
    expect(entry?.enabled).toBe(false);
    expect(entry?.incompatibility).toBe('Requires plugin API v99');

    // No activation path reaches the activator.
    await registry.activateEnabled();
    expect(await registry.activate('too-new')).toBe(false);
    expect(await registry.setEnabled('too-new', true)).toBe(false);
    expect(activations).toBe(0);
    expect(registry.get('too-new')?.enabled).toBe(false);

    // The reason is part of the IPC snapshot for Settings.
    expect(registry.listInfo()[0]).toMatchObject({
      id: 'too-new',
      status: 'error',
      incompatibility: 'Requires plugin API v99',
    });
  });

  test('async activation is discarded when the plugin is disabled mid-flight', async () => {
    let resolveActivation!: () => void;
    let lateDisposed = false;
    const registry = new PluginRegistry({
      activate: () =>
        new Promise<PluginDisposable>((resolve) => {
          resolveActivation = () => resolve({ dispose: () => { lateDisposed = true; } });
        }),
    });
    registry.register(plugin('slow'), true);

    const activation = registry.activate('slow');
    await registry.setEnabled('slow', false); // user toggles off during the await

    resolveActivation();
    expect(await activation).toBe(false);

    // The late result must not leave an active disabled plugin behind; its
    // disposables are torn down immediately.
    expect(registry.get('slow')?.status).toBe('inactive');
    expect(registry.get('slow')?.enabled).toBe(false);
    expect(lateDisposed).toBe(true);
  });

  test('async activation failure after mid-flight disable stays inactive, not errored', async () => {
    let rejectActivation!: () => void;
    const registry = new PluginRegistry({
      activate: () =>
        new Promise<PluginDisposable>((_resolve, reject) => {
          rejectActivation = () => reject(new Error('late boom'));
        }),
    });
    registry.register(plugin('slow'), true);

    const activation = registry.activate('slow');
    await registry.setEnabled('slow', false);

    rejectActivation();
    expect(await activation).toBe(false);
    expect(registry.get('slow')?.status).toBe('inactive');
    expect(registry.get('slow')?.error).toBeUndefined();
  });

  test('disable then re-enable during activation commits the in-flight result once', async () => {
    let activatorRuns = 0;
    let resolveActivation!: () => void;
    const registry = new PluginRegistry({
      activate: () => {
        activatorRuns += 1;
        return new Promise<void>((resolve) => {
          resolveActivation = () => resolve();
        });
      },
    });
    registry.register(plugin('slow'), true);

    const first = registry.activate('slow');
    await registry.setEnabled('slow', false);
    const second = registry.setEnabled('slow', true); // shares the in-flight activation

    resolveActivation();
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(activatorRuns).toBe(1);
    expect(registry.get('slow')?.status).toBe('active');
  });

  test('concurrent activate calls share one in-flight activation', async () => {
    let activatorRuns = 0;
    let resolveActivation!: () => void;
    const registry = new PluginRegistry({
      activate: () => {
        activatorRuns += 1;
        return new Promise<void>((resolve) => {
          resolveActivation = () => resolve();
        });
      },
    });
    registry.register(plugin('slow'), true);

    const a = registry.activate('slow');
    const b = registry.activate('slow');
    resolveActivation();

    expect(await a).toBe(true);
    expect(await b).toBe(true);
    expect(activatorRuns).toBe(1);
  });

  test('disposeAll is terminal: late activations are discarded and new ones refused', async () => {
    let resolveActivation!: () => void;
    let lateDisposed = false;
    const registry = new PluginRegistry({
      activate: () =>
        new Promise<PluginDisposable>((resolve) => {
          resolveActivation = () => resolve({ dispose: () => { lateDisposed = true; } });
        }),
    });
    registry.register(plugin('slow'), true);

    const activation = registry.activate('slow');
    registry.disposeAll();

    resolveActivation();
    expect(await activation).toBe(false);
    expect(registry.get('slow')?.status).toBe('inactive');
    expect(lateDisposed).toBe(true);

    expect(await registry.activate('slow')).toBe(false);
  });

  test('listInfo carries declarative contributions from the manifest', () => {
    const registry = new PluginRegistry({ activate: () => {} });
    const contributing: LoadedPlugin = {
      manifest: {
        id: 'panels',
        name: 'Panels',
        version: '1.0.0',
        permissions: ['ui.sidePanel'],
        contributes: { sidePanels: [{ id: 'main', title: 'Main', location: 'left' }] },
      },
      source: 'builtin',
    };
    registry.register(contributing, true);
    expect(registry.listInfo()[0]?.contributes?.sidePanels?.[0]).toMatchObject({
      id: 'main',
      location: 'left',
    });
  });
});
