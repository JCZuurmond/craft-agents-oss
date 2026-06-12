/**
 * Plugin Manifest Validation
 *
 * Zod schema for plugin.json, mirroring the automations schema conventions.
 */

import { z } from 'zod';
import {
  PLUGIN_PERMISSIONS,
  type PluginManifest,
  type PluginManifestValidationResult,
} from './types.ts';

/** Slug rule shared with sources/skills/statuses: lowercase, digits, hyphens */
const PLUGIN_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const PluginEntriesSchema = z.object({
  renderer: z.string().min(1).optional(),
  main: z.string().min(1).optional(),
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
  entries: PluginEntriesSchema.optional(),
  defaultEnabled: z.boolean().optional(),
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
