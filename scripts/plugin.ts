#!/usr/bin/env bun
/**
 * plugin.ts — dev CLI for Craft Agents plugins.
 *
 *   bun run plugin:validate <path>          # validate a plugin dir or plugin.json
 *   bun run plugin:new <id> [--dir <dir>]   # scaffold a runnable starter plugin
 *
 * `new` defaults to ~/.craft-agent/plugins (honoring CRAFT_CONFIG_DIR), so the
 * scaffold is discovered by the app on next launch with no rebuild. Wraps the
 * same validation the host runs at discovery, so an author sees *why* a plugin
 * is rejected before launching the app.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  validatePluginDirectory,
  scaffoldPlugin,
} from '@craft-agent/shared/plugins/node';

function pluginsDir(): string {
  return join(process.env.CRAFT_CONFIG_DIR || join(homedir(), '.craft-agent'), 'plugins');
}

function usage(): never {
  console.error('Usage:\n  plugin validate <path>\n  plugin new <id> [--dir <dir>] [--force]');
  process.exit(2);
}

function runValidate(pathArg: string | undefined): number {
  if (!pathArg) usage();
  const result = validatePluginDirectory(pathArg);
  for (const w of result.warnings) console.warn(`⚠️  ${w}`);
  if (result.valid) {
    const m = result.manifest!;
    console.log(`✓ ${m.name} (${m.id}) v${m.version} — valid`);
    return 0;
  }
  console.error(`✗ ${result.dir} — invalid:`);
  for (const e of result.errors) console.error(`  • ${e}`);
  return 1;
}

function runNew(args: string[]): number {
  const id = args[0];
  if (!id) usage();
  const force = args.includes('--force');
  const dirFlag = args.indexOf('--dir');
  const dir = dirFlag >= 0 ? args[dirFlag + 1] : undefined;
  if (dirFlag >= 0 && !dir) usage();

  try {
    const { path, files } = scaffoldPlugin({ id, dir: dir ?? pluginsDir(), force });
    console.log(`✓ created plugin '${id}' at ${path}`);
    for (const f of files) console.log(`  • ${f}`);
    console.log(`\nEnable it in Settings → Plugins (restart the app to discover it first).`);
    return 0;
  } catch (error) {
    console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

function main(): void {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case 'validate':
      process.exit(runValidate(rest[0]));
      break;
    case 'new':
      process.exit(runNew(rest));
      break;
    default:
      usage();
  }
}

main();
