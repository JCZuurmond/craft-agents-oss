/**
 * Plugin Manifest Validation
 *
 * Zod schema for plugin.json, mirroring the automations schema conventions.
 */

import { z } from 'zod';
import {
  PLUGIN_PERMISSIONS,
  PLUGIN_PANEL_LOCATIONS,
  type PluginManifest,
  type PluginManifestValidationResult,
} from './types.ts';

/** Slug rule shared with sources/skills/statuses: lowercase, digits, hyphens */
const PLUGIN_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const PluginEntriesSchema = z.object({
  renderer: z.string().min(1).optional(),
  main: z.string().min(1).optional(),
});

export const PluginSidePanelDeclarationSchema = z.object({
  id: z
    .string()
    .min(1, 'panel id cannot be empty')
    .max(64, 'panel id must be 64 characters or fewer')
    .regex(PLUGIN_ID_PATTERN, 'panel id must be slug-style: lowercase letters, digits, and hyphens'),
  title: z.string().min(1, 'panel title cannot be empty').max(128),
  icon: z.string().max(64).optional(),
  location: z.enum(PLUGIN_PANEL_LOCATIONS).optional(),
});

/**
 * Keybinding format shared with the app's action registry: optional
 * mod/shift/alt modifiers plus one final key (letter, digit, or a supported
 * special key). Plugin keybindings must include 'mod' or 'alt' so bare keys
 * and shift-only chords stay reserved for typing.
 */
const KEYBINDING_KEY = '(?:[a-z0-9]|escape|tab|left|right|up|down|\\[|\\]|,|\\.)';
const KEYBINDING_PATTERN = new RegExp(`^(?:(?:mod|shift|alt)\\+)+${KEYBINDING_KEY}$`);

export const PluginCommandDeclarationSchema = z.object({
  id: z
    .string()
    .min(1, 'command id cannot be empty')
    .max(64, 'command id must be 64 characters or fewer')
    .regex(PLUGIN_ID_PATTERN, 'command id must be slug-style: lowercase letters, digits, and hyphens'),
  title: z.string().min(1, 'command title cannot be empty').max(128),
  keybinding: z
    .string()
    .regex(
      KEYBINDING_PATTERN,
      "keybinding must be modifier(s) + key, e.g. 'mod+shift+b' (modifiers: mod, shift, alt)",
    )
    .refine(
      (kb) => kb.includes('mod+') || kb.includes('alt+'),
      "keybinding must include 'mod' or 'alt' (bare and shift-only chords are reserved for typing)",
    )
    .optional(),
});

export const PluginContributionsSchema = z.object({
  sidePanels: z
    .array(PluginSidePanelDeclarationSchema)
    .refine(
      (panels) => new Set(panels.map((p) => p.id)).size === panels.length,
      'sidePanels must not contain duplicate panel ids',
    )
    .optional(),
  commands: z
    .array(PluginCommandDeclarationSchema)
    .refine(
      (commands) => new Set(commands.map((c) => c.id)).size === commands.length,
      'commands must not contain duplicate command ids',
    )
    .optional(),
});

/** `onStartup`, `onPanel:{panelId}`, `onCommand:{commandId}` */
const ACTIVATION_EVENT_PATTERN = /^(?:onStartup|onPanel:.+|onCommand:.+)$/;

export const PluginManifestSchema = z.object({
  id: z
    .string()
    .min(1, 'id cannot be empty')
    .max(64, 'id must be 64 characters or fewer')
    .regex(PLUGIN_ID_PATTERN, 'id must be slug-style: lowercase letters, digits, and hyphens'),
  name: z.string().min(1, 'name cannot be empty').max(128),
  version: z
    .string()
    .regex(/^\d+\.\d+\.\d+(?:[-+].*)?$/, 'version must be a semver string (e.g. 1.0.0)'),
  description: z.string().max(512).optional(),
  icon: z.string().max(2048).optional(),
  permissions: z
    .array(z.enum(PLUGIN_PERMISSIONS))
    .refine((perms) => new Set(perms).size === perms.length, 'permissions must not contain duplicates'),
  apiVersion: z
    .number()
    .int('apiVersion must be an integer')
    .min(1, 'apiVersion must be 1 or greater')
    .optional(),
  contributes: PluginContributionsSchema.optional(),
  activationEvents: z
    .array(
      z
        .string()
        .regex(
          ACTIVATION_EVENT_PATTERN,
          "activation events must be 'onStartup', 'onPanel:{panelId}', or 'onCommand:{commandId}'",
        ),
    )
    .refine((events) => new Set(events).size === events.length, 'activationEvents must not contain duplicates')
    .optional(),
  entries: PluginEntriesSchema.optional(),
  defaultEnabled: z.boolean().optional(),
}).superRefine((manifest, ctx) => {
  if ((manifest.contributes?.sidePanels?.length ?? 0) > 0 && !manifest.permissions.includes('ui.sidePanel')) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['contributes', 'sidePanels'],
      message: "declaring sidePanels requires the 'ui.sidePanel' permission",
    });
  }
  if ((manifest.contributes?.commands?.length ?? 0) > 0 && !manifest.permissions.includes('commands')) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['contributes', 'commands'],
      message: "declaring commands requires the 'commands' permission",
    });
  }
  // Lazy-activation targets must exist in the declared contributions —
  // an activation event referencing an undeclared id would never fire.
  const panelIds = new Set((manifest.contributes?.sidePanels ?? []).map((p) => p.id));
  const commandIds = new Set((manifest.contributes?.commands ?? []).map((c) => c.id));
  for (const event of manifest.activationEvents ?? []) {
    if (event.startsWith('onPanel:') && !panelIds.has(event.slice('onPanel:'.length))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['activationEvents'],
        message: `'${event}' references a panel id not declared in contributes.sidePanels`,
      });
    }
    if (event.startsWith('onCommand:') && !commandIds.has(event.slice('onCommand:'.length))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['activationEvents'],
        message: `'${event}' references a command id not declared in contributes.commands`,
      });
    }
  }
});

/**
 * Validate raw plugin.json content.
 * Returns the parsed manifest on success, or human-readable errors.
 */
export function validatePluginManifest(raw: unknown): PluginManifestValidationResult {
  const result = PluginManifestSchema.safeParse(raw);

  if (!result.success) {
    const errors = result.error.issues.map((issue) => {
      const path = issue.path.join('.');
      return path ? `${path}: ${issue.message}` : issue.message;
    });
    return { valid: false, manifest: null, errors };
  }

  return { valid: true, manifest: result.data as PluginManifest, errors: [] };
}
