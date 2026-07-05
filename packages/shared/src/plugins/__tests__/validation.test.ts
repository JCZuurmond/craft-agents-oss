import { describe, test, expect } from 'bun:test';
import { validatePluginManifest } from '../validation.ts';
import {
  manifestHasPermission,
  getManifestApiVersion,
  checkPluginApiCompatibility,
  parseActivationEvent,
  shouldActivateOnStartup,
  PLUGIN_API_VERSION,
  type PluginManifest,
} from '../types.ts';

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

  test('accepts declarative sidePanels contributions', () => {
    const result = validatePluginManifest({
      ...VALID_MANIFEST,
      contributes: {
        sidePanels: [
          { id: 'main', title: 'Main Panel', icon: '🌐' },
          { id: 'secondary', title: 'Secondary', location: 'left' },
        ],
      },
    });
    expect(result.valid).toBe(true);
    expect(result.manifest?.contributes?.sidePanels?.[1]?.location).toBe('left');
  });

  test('rejects invalid panel locations', () => {
    const result = validatePluginManifest({
      ...VALID_MANIFEST,
      contributes: { sidePanels: [{ id: 'main', title: 'Main', location: 'bottom' }] },
    });
    expect(result.valid).toBe(false);
  });

  test('rejects duplicate panel ids within a plugin', () => {
    const result = validatePluginManifest({
      ...VALID_MANIFEST,
      contributes: {
        sidePanels: [
          { id: 'main', title: 'One' },
          { id: 'main', title: 'Two' },
        ],
      },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('duplicate panel ids'))).toBe(true);
  });

  test('rejects non-slug panel ids', () => {
    const result = validatePluginManifest({
      ...VALID_MANIFEST,
      contributes: { sidePanels: [{ id: 'Main Panel', title: 'Main' }] },
    });
    expect(result.valid).toBe(false);
  });

  test('rejects sidePanels without the ui.sidePanel permission', () => {
    const result = validatePluginManifest({
      ...VALID_MANIFEST,
      permissions: ['storage'],
      contributes: { sidePanels: [{ id: 'main', title: 'Main' }] },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("'ui.sidePanel'"))).toBe(true);
  });

  test('accepts a valid apiVersion and rejects invalid ones', () => {
    expect(validatePluginManifest({ ...VALID_MANIFEST, apiVersion: 1 }).valid).toBe(true);
    expect(validatePluginManifest({ ...VALID_MANIFEST, apiVersion: 0 }).valid).toBe(false);
    expect(validatePluginManifest({ ...VALID_MANIFEST, apiVersion: 1.5 }).valid).toBe(false);
    expect(validatePluginManifest({ ...VALID_MANIFEST, apiVersion: '1' }).valid).toBe(false);
  });

  const COMMANDS_MANIFEST = {
    ...VALID_MANIFEST,
    permissions: ['commands'],
    contributes: {
      commands: [
        { id: 'open', title: 'Open Browser', keybinding: 'mod+shift+b' },
        { id: 'reload', title: 'Reload Page' },
      ],
    },
  };

  test('accepts declarative command contributions with keybindings', () => {
    const result = validatePluginManifest(COMMANDS_MANIFEST);
    expect(result.valid).toBe(true);
    expect(result.manifest?.contributes?.commands?.[0]?.keybinding).toBe('mod+shift+b');
  });

  test('rejects commands without the commands permission', () => {
    const result = validatePluginManifest({ ...COMMANDS_MANIFEST, permissions: ['storage'] });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("'commands'"))).toBe(true);
  });

  test('rejects duplicate command ids within a plugin', () => {
    const result = validatePluginManifest({
      ...COMMANDS_MANIFEST,
      contributes: {
        commands: [
          { id: 'open', title: 'One' },
          { id: 'open', title: 'Two' },
        ],
      },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('duplicate command ids'))).toBe(true);
  });

  test('rejects malformed and modifier-less keybindings', () => {
    for (const keybinding of ['b', 'shift+b', 'mod+', 'super+b', 'mod+F1', 'mod shift b']) {
      const result = validatePluginManifest({
        ...COMMANDS_MANIFEST,
        contributes: { commands: [{ id: 'open', title: 'Open', keybinding }] },
      });
      expect(result.valid).toBe(false);
    }
  });

  test('accepts alt-modifier and special-key keybindings', () => {
    for (const keybinding of ['alt+p', 'mod+left', 'mod+alt+[', 'mod+shift+escape']) {
      const result = validatePluginManifest({
        ...COMMANDS_MANIFEST,
        contributes: { commands: [{ id: 'open', title: 'Open', keybinding }] },
      });
      expect(result.valid).toBe(true);
    }
  });

  test('accepts activation events referencing declared contributions', () => {
    const result = validatePluginManifest({
      ...VALID_MANIFEST,
      permissions: ['ui.sidePanel', 'commands'],
      contributes: {
        sidePanels: [{ id: 'main', title: 'Main' }],
        commands: [{ id: 'open', title: 'Open' }],
      },
      activationEvents: ['onStartup', 'onPanel:main', 'onCommand:open'],
    });
    expect(result.valid).toBe(true);
  });

  test('rejects activation events referencing undeclared ids', () => {
    const missingPanel = validatePluginManifest({
      ...VALID_MANIFEST,
      activationEvents: ['onPanel:ghost'],
    });
    expect(missingPanel.valid).toBe(false);
    expect(missingPanel.errors.some((e) => e.includes('onPanel:ghost'))).toBe(true);

    const missingCommand = validatePluginManifest({
      ...COMMANDS_MANIFEST,
      activationEvents: ['onCommand:ghost'],
    });
    expect(missingCommand.valid).toBe(false);
    expect(missingCommand.errors.some((e) => e.includes('onCommand:ghost'))).toBe(true);
  });

  test('rejects malformed and duplicate activation events', () => {
    expect(validatePluginManifest({ ...VALID_MANIFEST, activationEvents: ['onLoad'] }).valid).toBe(false);
    expect(validatePluginManifest({ ...VALID_MANIFEST, activationEvents: ['onPanel:'] }).valid).toBe(false);
    expect(
      validatePluginManifest({ ...VALID_MANIFEST, activationEvents: ['onStartup', 'onStartup'] }).valid,
    ).toBe(false);
  });
});

describe('checkPluginApiCompatibility', () => {
  const base = validatePluginManifest(VALID_MANIFEST).manifest as PluginManifest;

  test('a manifest without apiVersion targets v1 and is compatible', () => {
    expect(getManifestApiVersion(base)).toBe(1);
    expect(checkPluginApiCompatibility(base)).toBeNull();
  });

  test('the current host version is compatible', () => {
    expect(checkPluginApiCompatibility({ ...base, apiVersion: PLUGIN_API_VERSION })).toBeNull();
  });

  test('a future apiVersion is rejected with a readable reason', () => {
    const reason = checkPluginApiCompatibility({ ...base, apiVersion: PLUGIN_API_VERSION + 1 });
    expect(reason).toContain(`v${PLUGIN_API_VERSION + 1}`);
    expect(reason).toContain(`v${PLUGIN_API_VERSION}`);
  });
});

describe('manifestHasPermission', () => {
  const manifest = validatePluginManifest(VALID_MANIFEST).manifest as PluginManifest;

  test('reports declared and undeclared permissions', () => {
    expect(manifestHasPermission(manifest, 'ui.webview')).toBe(true);
    expect(manifestHasPermission(manifest, 'ipc')).toBe(false);
  });
});

describe('parseActivationEvent', () => {
  test('parses the three event kinds', () => {
    expect(parseActivationEvent('onStartup')).toEqual({ kind: 'onStartup' });
    expect(parseActivationEvent('onPanel:main')).toEqual({ kind: 'onPanel', panelId: 'main' });
    expect(parseActivationEvent('onCommand:open')).toEqual({ kind: 'onCommand', commandId: 'open' });
  });

  test('returns null for malformed events', () => {
    for (const event of ['onLoad', 'onPanel:', 'onCommand:', 'startup', '']) {
      expect(parseActivationEvent(event)).toBeNull();
    }
  });
});

describe('shouldActivateOnStartup', () => {
  const base = validatePluginManifest(VALID_MANIFEST).manifest as PluginManifest;
  const panel = { id: 'main', title: 'Main' };
  const command = { id: 'open', title: 'Open' };

  test('explicit onStartup wins even with declared contributions', () => {
    expect(
      shouldActivateOnStartup({
        ...base,
        contributes: { sidePanels: [panel] },
        activationEvents: ['onStartup', 'onPanel:main'],
      }),
    ).toBe(true);
  });

  test('explicit lazy-only events defer activation', () => {
    expect(
      shouldActivateOnStartup({
        ...base,
        contributes: { sidePanels: [panel] },
        activationEvents: ['onPanel:main'],
      }),
    ).toBe(false);
  });

  test('inferred default: declarative contributions are lazy, code-only is eager', () => {
    expect(shouldActivateOnStartup(base)).toBe(true);
    expect(shouldActivateOnStartup({ ...base, contributes: { sidePanels: [panel] } })).toBe(false);
    expect(shouldActivateOnStartup({ ...base, contributes: { commands: [command] } })).toBe(false);
    expect(shouldActivateOnStartup({ ...base, contributes: {} })).toBe(true);
  });
});
