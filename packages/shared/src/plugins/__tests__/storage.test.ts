import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  getPluginsDir,
  loadExternalPlugins,
  loadPluginsConfig,
  savePluginsConfig,
  isPluginEnabled,
  setPluginEnabled,
} from '../storage.ts';
import { PLUGINS_CONFIG_VERSION, type PluginManifest } from '../types.ts';

let configDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'craft-plugins-test-'));
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

function writePlugin(id: string, manifest: object): void {
  const dir = join(getPluginsDir(configDir), id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify(manifest));
}

const manifest = (id: string, extra: object = {}): object => ({
  id,
  name: id,
  version: '1.0.0',
  permissions: [],
  ...extra,
});

describe('loadExternalPlugins', () => {
  test('returns empty array when plugins dir is missing', () => {
    expect(loadExternalPlugins(configDir)).toEqual([]);
  });

  test('discovers valid plugins with source=user and path', () => {
    writePlugin('alpha', manifest('alpha'));
    writePlugin('beta', manifest('beta'));

    const plugins = loadExternalPlugins(configDir);
    expect(plugins.map((p) => p.manifest.id).sort()).toEqual(['alpha', 'beta']);
    expect(plugins.every((p) => p.source === 'user')).toBe(true);
    expect(plugins.every((p) => p.path?.endsWith(p.manifest.id))).toBe(true);
  });

  test('skips invalid manifests and corrupt JSON', () => {
    writePlugin('good', manifest('good'));
    writePlugin('bad-schema', { id: 'bad-schema', name: 'x' });
    const corruptDir = join(getPluginsDir(configDir), 'corrupt');
    mkdirSync(corruptDir, { recursive: true });
    writeFileSync(join(corruptDir, 'plugin.json'), '{not json');

    const plugins = loadExternalPlugins(configDir);
    expect(plugins.map((p) => p.manifest.id)).toEqual(['good']);
  });

  test('skips plugins whose manifest id does not match the directory name', () => {
    writePlugin('claims-other-id', manifest('web-browser'));
    expect(loadExternalPlugins(configDir)).toEqual([]);
  });
});

describe('plugins config persistence', () => {
  test('loads empty config when file is missing or corrupt', () => {
    expect(loadPluginsConfig(configDir)).toEqual({
      version: PLUGINS_CONFIG_VERSION,
      plugins: {},
    });

    writeFileSync(join(configDir, 'plugins.json'), 'garbage');
    expect(loadPluginsConfig(configDir).plugins).toEqual({});
  });

  test('round-trips enablement state', () => {
    savePluginsConfig(
      { version: PLUGINS_CONFIG_VERSION, plugins: { alpha: { enabled: true } } },
      configDir,
    );
    expect(loadPluginsConfig(configDir).plugins.alpha?.enabled).toBe(true);
  });

  test('setPluginEnabled persists and returns updated config', () => {
    const updated = setPluginEnabled('alpha', true, configDir);
    expect(updated.plugins.alpha?.enabled).toBe(true);
    expect(loadPluginsConfig(configDir).plugins.alpha?.enabled).toBe(true);

    setPluginEnabled('alpha', false, configDir);
    expect(loadPluginsConfig(configDir).plugins.alpha?.enabled).toBe(false);
  });

  test('drops malformed entries on load', () => {
    writeFileSync(
      join(configDir, 'plugins.json'),
      JSON.stringify({ version: 1, plugins: { ok: { enabled: true }, bad: { enabled: 'yes' } } }),
    );
    const config = loadPluginsConfig(configDir);
    expect(config.plugins.ok?.enabled).toBe(true);
    expect(config.plugins.bad).toBeUndefined();
  });
});

describe('isPluginEnabled', () => {
  const base: PluginManifest = { id: 'p', name: 'P', version: '1.0.0', permissions: [] };
  const emptyConfig = { version: PLUGINS_CONFIG_VERSION, plugins: {} };

  test('explicit user state wins over defaultEnabled', () => {
    const config = { version: PLUGINS_CONFIG_VERSION, plugins: { p: { enabled: false } } };
    expect(isPluginEnabled({ ...base, defaultEnabled: true }, config, 'builtin')).toBe(false);
  });

  test('builtin plugins honor manifest defaultEnabled', () => {
    expect(isPluginEnabled({ ...base, defaultEnabled: true }, emptyConfig, 'builtin')).toBe(true);
    expect(isPluginEnabled(base, emptyConfig, 'builtin')).toBe(false);
  });

  test('external plugins are disabled by default regardless of manifest', () => {
    expect(isPluginEnabled({ ...base, defaultEnabled: true }, emptyConfig, 'user')).toBe(false);
  });
});
