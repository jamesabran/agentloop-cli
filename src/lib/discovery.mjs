/**
 * Agent CLI capability discovery.
 *
 * Discovers which provider CLIs are available on the machine so setup can
 * present only usable choices.  Discovery is registry-driven — each provider
 * known to PROVIDER_CAPABILITIES declares how to check its availability.
 *
 *   discoverAgents() → { claude: { available: true }, codex: { available: false, reason: '...' } }
 *
 * Only providers defined in PROVIDER_CAPABILITIES are discovered.  Adding a
 * new provider means adding it to both PROVIDER_CAPABILITIES (roles.mjs) and
 * PROVIDER_DISCOVERY (here).
 */

import { spawnSync } from 'node:child_process';
import process from 'node:process';
import path from 'node:path';

import { resolveExecutable, npmGlobalDirs } from './process.mjs';
import { PROVIDER_CAPABILITIES } from './roles.mjs';

/**
 * Run a command through spawnSync, handling Windows .cmd shims.
 *
 * On Windows, Node refuses to spawn .cmd files directly (CVE-2024-27980).
 * We must route them through cmd.exe, matching the pattern in process.mjs.
 *
 * @param {string} binPath — resolved executable path
 * @param {string[]} args
 * @returns {ReturnType<typeof spawnSync>}
 */
function spawnForDiscovery(binPath, args) {
  const isWindowsShim = process.platform === 'win32' && /\.(cmd|bat)$/i.test(binPath);

  if (!isWindowsShim) {
    return spawnSync(binPath, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
    });
  }

  // Quote the command and arguments for cmd.exe.
  // Safe for version flags — no user-provided text on the command line.
  const quote = (/** @type {string} */ arg) => (/\s/.test(arg) ? `"${arg}"` : arg);
  const line = [binPath, ...args.map(quote)].join(' ');
  const shell = process.env.ComSpec || 'cmd.exe';

  return spawnSync(shell, ['/d', '/s', '/c', line], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000,
    windowsVerbatimArguments: true,
  });
}

/**
 * Discovery configuration for each supported provider.
 *
 * Each entry defines the CLI command name and the flag to use for a
 * lightweight availability check (e.g. `--version`).  The command is
 * resolved via `resolveExecutable` from process.mjs, which searches PATH
 * and respects AGENTLOOP_<PROVIDER>_BIN overrides.
 *
 * Extensibility: add a provider here when adding it to PROVIDER_CAPABILITIES
 * so setup can discover whether the CLI is installed.
 */
export const PROVIDER_DISCOVERY = Object.freeze({
  claude: Object.freeze({ command: 'claude', versionFlag: '--version' }),
  codex: Object.freeze({ command: 'codex', versionFlag: '--version' }),
});

/**
 * Check whether a single provider CLI is available on this machine.
 *
 * Resolves the binary (respecting PATH and AGENTLOOP_*_BIN overrides),
 * then runs it with the version flag to verify it responds.  Timeout is
 * 10 seconds — a hung binary is treated as unavailable.
 *
 * @param {string} provider — a key in PROVIDER_CAPABILITIES
 * @returns {{ available: boolean, reason?: string, path?: string }}
 */
export function checkProvider(provider) {
  const discovery = PROVIDER_DISCOVERY[provider];

  if (!discovery) {
    return {
      available: false,
      reason: `Provider "${provider}" has no discovery configuration.`,
    };
  }

  // Respect AGENTLOOP_<PROVIDER>_BIN overrides via resolveExecutable.
  const envKey = `AGENTLOOP_${provider.toUpperCase()}_BIN`;
  const override = process.env[envKey] || undefined;

  let binPath;
  try {
    binPath = resolveExecutable(discovery.command, {
      override,
      extraDirs: npmGlobalDirs(),
    });
  } catch {
    return {
      available: false,
      reason: `${discovery.command} binary lookup failed.`,
    };
  }

  const result = spawnForDiscovery(binPath, [discovery.versionFlag]);

  if (result.status === 0) {
    return { available: true, path: binPath };
  }

  if (result.error) {
    return {
      available: false,
      reason: `${discovery.command} could not be started: ${result.error.message}`,
    };
  }

  return {
    available: false,
    reason: `${discovery.command} exited with status ${result.status}.`,
  };
}

/**
 * Discover all providers known to the capability registry.
 *
 * Returns a result for every provider in PROVIDER_CAPABILITIES.  Providers
 * without a PROVIDER_DISCOVERY entry are reported as unavailable rather
 * than omitted — the caller always gets a complete picture.
 *
 * @returns {Record<string, { available: boolean, reason?: string, path?: string }>}
 */
export function discoverAgents() {
  /** @type {Record<string, { available: boolean, reason?: string, path?: string }>} */
  const results = {};

  for (const provider of Object.keys(PROVIDER_CAPABILITIES)) {
    results[provider] = checkProvider(provider);
  }

  return results;
}
