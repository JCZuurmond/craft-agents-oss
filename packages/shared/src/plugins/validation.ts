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

export const PluginContributionsSchema = z.object({
  sidePanels: z
    .array(PluginSidePanelDeclarationSchema)
    .refine(
      (panels) => new Set(panels.map((p) => p.id)).size === panels.length,
      'sidePanels must not contain duplicate panel ids',
    )
    .optional(),
});

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
