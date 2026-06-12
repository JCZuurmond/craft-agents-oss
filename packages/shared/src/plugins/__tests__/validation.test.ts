import { describe, test, expect } from 'bun:test';
import { validatePluginManifest } from '../validation.ts';
import { manifestHasPermission, type PluginManifest } from '../types.ts';

const VALID_MANIFEST = {
  id: 'web-browser',
  name: 'Browser Pane',
  version: '0.1.0',
  description: 'A browser in a side pane',
  icon: '🌐',
  permissions: ['ui.sidePanel', 'ui.webview'],
  entries: { renderer: 'renderer.tsx' },
  defaultEnabled: true,
};

describe('validatePluginManifest', () => {
  test('accepts a complete valid manifest', () => {
    const result = validatePluginManifest(VALID_MANIFEST);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.manifest?.id).toBe('web-browser');
    expect(result.manifest?.permissions).toEqual(['ui.sidePanel', 'ui.webview']);
  });

  test('accepts a minimal manifest', () => {
    const result = validatePluginManifest({
      id: 'minimal',
      name: 'Minimal',
      version: '1.0.0',
      permissions: [],
    });
    expect(result.valid).toBe(true);
  });

  test('rejects non-object input', () => {
    for (const input of [null, undefined, 42, 'plugin', []]) {
      expect(validatePluginManifest(input).valid).toBe(false);
    }
  });

  test('rejects missing required fields', () => {
    const result = validatePluginManifest({ name: 'No id', version: '1.0.0', permissions: [] });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.startsWith('id'))).toBe(true);
  });

  test('rejects non-slug ids', () => {
    for (const id of ['Web Browser', 'UPPER', 'trailing-', '-leading', 'dots.bad', 'a/b']) {
      const result = validatePluginManifest({ ...VALID_MANIFEST, id });
      expect(result.valid).toBe(false);
    }
  });

  test('rejects invalid semver versions', () => {
    for (const version of ['1', '1.0', 'v1.0.0', 'latest']) {
      const result = validatePluginManifest({ ...VALID_MANIFEST, version });
      expect(result.valid).toBe(false);
    }
  });

  test('rejects unknown permissions', () => {
    const result = validatePluginManifest({
      ...VALID_MANIFEST,
      permissions: ['ui.sidePanel', 'fs.readAll'],
    });
    expect(result.valid).toBe(false);
  });

  test('rejects duplicate permissions', () => {
    const result = validatePluginManifest({
      ...VALID_MANIFEST,
      permissions: ['ui.sidePanel', 'ui.sidePanel'],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('duplicates'))).toBe(true);
  });

  test('error messages include field paths', () => {
    const result = validatePluginManifest({ ...VALID_MANIFEST, version: 'nope' });
    expect(result.errors.some((e) => e.startsWith('version:'))).toBe(true);
  });
});

describe('manifestHasPermission', () => {
  const manifest = validatePluginManifest(VALID_MANIFEST).manifest as PluginManifest;

  test('reports declared and undeclared permissions', () => {
    expect(manifestHasPermission(manifest, 'ui.webview')).toBe(true);
    expect(manifestHasPermission(manifest, 'ipc')).toBe(false);
  });
});
