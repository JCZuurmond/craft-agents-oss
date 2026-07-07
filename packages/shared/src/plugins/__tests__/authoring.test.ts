import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  validatePluginDirectory,
  scaffoldPlugin,
  renderPluginScaffold,
} from '../authoring.ts';
import { validatePluginManifest } from '../validation.ts';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'craft-authoring-test-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writePlugin(id: string, manifest: object, files: Record<string, string> = {}): string {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify(manifest));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}

const manifest = (id: string, extra: object = {}): object => ({
  id,
  name: id,
  version: '1.0.0',
  permissions: [],
  ...extra,
});

describe('validatePluginDirectory', () => {
  test('accepts a valid plugin and reports the manifest', () => {
    const dir = writePlugin('alpha', manifest('alpha'));
    const result = validatePluginDirectory(dir);
    expect(result.valid).toBe(true);
    expect(result.manifest?.id).toBe('alpha');
    expect(result.errors).toEqual([]);
  });

  test('accepts being pointed at the plugin.json directly', () => {
    const dir = writePlugin('alpha', manifest('alpha'));
    expect(validatePluginDirectory(join(dir, 'plugin.json')).valid).toBe(true);
  });

  test('surfaces zod errors for an invalid manifest', () => {
    const dir = writePlugin('bad', { id: 'bad', name: 'x' });
    const result = validatePluginDirectory(dir);
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toContain('version');
  });

  test('flags an id that does not match the directory name', () => {
    const dir = writePlugin('dirname', manifest('other-id'));
    const result = validatePluginDirectory(dir);
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toContain('must match its directory name');
  });

  test('flags a declared entry file that does not exist', () => {
    const dir = writePlugin('gamma', manifest('gamma', { entries: { renderer: 'renderer.mjs' } }));
    const result = validatePluginDirectory(dir);
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toContain("entries.renderer 'renderer.mjs' does not exist");
  });

  test('passes when the declared entry file exists', () => {
    const dir = writePlugin('delta', manifest('delta', { entries: { renderer: 'renderer.mjs' } }), {
      'renderer.mjs': 'export function activate() {}',
    });
    expect(validatePluginDirectory(dir).valid).toBe(true);
  });

  test('warns when a plugin contributes nothing', () => {
    const dir = writePlugin('empty', manifest('empty'));
    expect(validatePluginDirectory(dir).warnings.join(' ')).toContain('do nothing');
  });

  test('reports a missing manifest', () => {
    mkdirSync(join(root, 'nomanifest'), { recursive: true });
    const result = validatePluginDirectory(join(root, 'nomanifest'));
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toContain('missing plugin.json');
  });
});

describe('scaffoldPlugin', () => {
  test('creates a valid, discoverable starter plugin', () => {
    const { path, files } = scaffoldPlugin({ id: 'my-weather', dir: root });
    expect(files).toEqual(['plugin.json', 'renderer.mjs']);
    expect(existsSync(join(path, 'plugin.json'))).toBe(true);
    expect(existsSync(join(path, 'renderer.mjs'))).toBe(true);

    // The scaffold must itself pass validation (dir name, entry file, schema).
    const result = validatePluginDirectory(path);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test('refuses to overwrite unless forced', () => {
    scaffoldPlugin({ id: 'dup', dir: root });
    expect(() => scaffoldPlugin({ id: 'dup', dir: root })).toThrow('refusing to overwrite');
    expect(() => scaffoldPlugin({ id: 'dup', dir: root, force: true })).not.toThrow();
  });

  test('scaffold manifest passes the shared manifest schema', () => {
    const { manifest: manifestJson } = renderPluginScaffold('cool-thing');
    const parsed = validatePluginManifest(JSON.parse(manifestJson));
    expect(parsed.valid).toBe(true);
    expect(parsed.manifest?.name).toBe('Cool Thing');
  });

  test('scaffold renderer uses ctx.react (no bundler needed) and exports activate', () => {
    const { renderer } = renderPluginScaffold('x');
    expect(renderer).toContain('export function activate(ctx)');
    expect(renderer).toContain('ctx.react.createElement');
    expect(renderer).not.toContain("import 'react'");
  });
});
