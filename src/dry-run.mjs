/**
 * npm treats unknown CLI options as npm config values on Windows. Preserve
 * the documented `npm run agent:dry-run -- --task ...` invocation by
 * translating those values back to controller arguments; see
 * lib/npm-args.mjs for the full recovery this shares with every other entry
 * point.
 */

import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { main } from './controller.mjs';
import { recoverCliArgs } from './lib/npm-args.mjs';

export function buildDryRunArgs(rawArgs, env = process.env) {
  return ['--dry-run', ...recoverCliArgs(rawArgs, env)];
}

const invokedDirectly =
  process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;

if (invokedDirectly) {
  const code = await main(buildDryRunArgs(process.argv.slice(2)));
  process.exitCode = code;
}
