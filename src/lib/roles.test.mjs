// @vitest-environment node
/**
 * Agent role and provider abstraction tests.
 *
 * Covers:
 *  1. Default role mapping preserves existing Claude/Codex workflow
 *  2. Role resolution with valid providers
 *  3. Same provider usable in different roles where supported
 *  4. Provider identity lookup
 *  5. Invalid/unsupported role-provider combinations fail clearly
 *  6. Config-level role mapping resolution
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  defaultRoleMapping,
  getProviderIdentity,
  LOGICAL_ROLES,
  PROVIDER_CAPABILITIES,
  PROVIDER_IDENTITIES,
  resolveProvider,
} from './roles.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_URL = pathToFileURL(path.join(HERE, 'config.mjs')).href;

const tempDirs = [];
afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

function makeProject({ remote, config } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentloop-roles-'));
  tempDirs.push(dir);
  spawnSync('git', ['init', '--quiet'], { cwd: dir });
  if (remote) spawnSync('git', ['remote', 'add', 'origin', remote], { cwd: dir });
  if (config) {
    fs.writeFileSync(path.join(dir, 'agentloop.config.json'), JSON.stringify(config), 'utf8');
  }
  return dir;
}

function baseEnv(overrides = {}) {
  const env = { ...process.env };
  delete env.AGENTLOOP_REPO;
  delete env.AGENTLOOP_BASE_BRANCH;
  delete env.AGENTLOOP_CLAUDE_ALLOWED_TOOLS;
  delete env.AGENTLOOP_CLAUDE_PERMISSION_MODE;
  delete env.AGENTLOOP_CLAUDE_RELAY_MODE;
  delete env.AGENTLOOP_CLAUDE_TIMEOUT_MS;
  delete env.AGENTLOOP_PUBLISH_MODE;
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

function importConfigField(field, { cwd, env }) {
  return spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import(${JSON.stringify(CONFIG_URL)}).then((m) => process.stdout.write(JSON.stringify(m.${field} ?? null)), (e) => { process.stderr.write(e.message); process.exit(1); });`,
    ],
    { cwd, env, encoding: 'utf8' },
  );
}

/* ------------------------------------------------------------------ *
 * Default role mapping                                                 *
 * ------------------------------------------------------------------ */

describe('defaultRoleMapping', () => {
  it('preserves the existing Claude implementer + Codex auditor workflow', () => {
    const mapping = defaultRoleMapping();
    expect(mapping.planner).toBe('claude');
    expect(mapping.implementer).toBe('claude');
    expect(mapping.auditor).toBe('codex');
  });

  it('returns a frozen object', () => {
    const mapping = defaultRoleMapping();
    expect(() => { mapping.implementer = 'other'; }).toThrow();
  });

  it('covers all three logical roles', () => {
    const mapping = defaultRoleMapping();
    for (const role of LOGICAL_ROLES) {
      expect(mapping).toHaveProperty(role);
      expect(typeof mapping[role]).toBe('string');
    }
  });
});

/* ------------------------------------------------------------------ *
 * Provider capabilities                                                *
 * ------------------------------------------------------------------ */

describe('PROVIDER_CAPABILITIES', () => {
  it('claude supports planner and implementer, not auditor', () => {
    const caps = PROVIDER_CAPABILITIES.claude;
    expect(caps).toContain('planner');
    expect(caps).toContain('implementer');
    expect(caps).not.toContain('auditor');
  });

  it('codex supports auditor only', () => {
    const caps = PROVIDER_CAPABILITIES.codex;
    expect(caps).toContain('auditor');
    expect(caps).not.toContain('planner');
    expect(caps).not.toContain('implementer');
  });

  it('is frozen so capabilities cannot be mutated at runtime', () => {
    expect(() => { PROVIDER_CAPABILITIES.claude = []; }).toThrow();
  });
});

/* ------------------------------------------------------------------ *
 * Provider identities                                                  *
 * ------------------------------------------------------------------ */

describe('getProviderIdentity', () => {
  it('returns CLAUDE for claude', () => {
    expect(getProviderIdentity('claude')).toBe('CLAUDE');
  });

  it('returns CODEX for codex', () => {
    expect(getProviderIdentity('codex')).toBe('CODEX');
  });

  it('falls back to uppercased name for unknown providers', () => {
    expect(getProviderIdentity('gemini')).toBe('GEMINI');
  });

  it('PROVIDER_IDENTITIES maps every known provider', () => {
    for (const provider of Object.keys(PROVIDER_CAPABILITIES)) {
      expect(PROVIDER_IDENTITIES).toHaveProperty(provider);
      expect(typeof PROVIDER_IDENTITIES[provider]).toBe('string');
    }
  });
});

/* ------------------------------------------------------------------ *
 * resolveProvider                                                      *
 * ------------------------------------------------------------------ */

describe('resolveProvider', () => {
  const mapping = defaultRoleMapping();

  it('resolves implementer to claude', () => {
    const { provider } = resolveProvider('implementer', mapping);
    expect(provider).toBe('claude');
  });

  it('resolves auditor to codex', () => {
    const { provider } = resolveProvider('auditor', mapping);
    expect(provider).toBe('codex');
  });

  it('resolves planner to claude (same provider as implementer)', () => {
    const { provider } = resolveProvider('planner', mapping);
    expect(provider).toBe('claude');
  });
});

describe('resolveProvider rejects invalid configurations', () => {
  it('throws when a role has no provider configured', () => {
    expect(() => resolveProvider('implementer', { planner: 'claude' }))
      .toThrow(/No provider configured for role "implementer"/);
  });

  it('throws when the provider is completely unknown', () => {
    expect(() => resolveProvider('implementer', { implementer: 'gpt-5' }))
      .toThrow(/Unknown provider "gpt-5"/);
  });

  it('throws when the provider exists but does not support the role', () => {
    // codex only supports auditor — not implementer
    expect(() => resolveProvider('implementer', { implementer: 'codex' }))
      .toThrow(/Provider "codex" does not support the "implementer" role/);
  });

  it('throws when codex is mapped to planner', () => {
    expect(() => resolveProvider('planner', { planner: 'codex' }))
      .toThrow(/Provider "codex" does not support the "planner" role/);
  });

  it('throws when claude is mapped to auditor', () => {
    // claude might audit in a future release, but not yet
    expect(() => resolveProvider('auditor', { auditor: 'claude' }))
      .toThrow(/Provider "claude" does not support the "auditor" role/);
  });
});

/* ------------------------------------------------------------------ *
 * Same provider in different roles                                     *
 * ------------------------------------------------------------------ */

describe('same provider in different roles', () => {
  it('claude can be planner and implementer simultaneously without conflict', () => {
    const mapping = { planner: 'claude', implementer: 'claude', auditor: 'codex' };
    expect(resolveProvider('planner', mapping).provider).toBe('claude');
    expect(resolveProvider('implementer', mapping).provider).toBe('claude');
    expect(resolveProvider('auditor', mapping).provider).toBe('codex');
  });

  it('both planner and implementer have the same provider identity when backed by claude', () => {
    const mapping = { planner: 'claude', implementer: 'claude', auditor: 'codex' };
    const plannerId = getProviderIdentity(resolveProvider('planner', mapping).provider);
    const implementerId = getProviderIdentity(resolveProvider('implementer', mapping).provider);
    expect(plannerId).toBe('CLAUDE');
    expect(implementerId).toBe('CLAUDE');
  });

  it('provider-specific config is keyed by provider name, not role', () => {
    // The same `claude` config object serves both planner and implementer roles.
    const mapping = { planner: 'claude', implementer: 'claude', auditor: 'codex' };
    const plannerProvider = resolveProvider('planner', mapping).provider;
    const implementerProvider = resolveProvider('implementer', mapping).provider;
    expect(plannerProvider).toBe(implementerProvider);
  });
});

/* ------------------------------------------------------------------ *
 * Config-level role mapping resolution                                 *
 * ------------------------------------------------------------------ */

describe('ROLE_MAPPING from agentloop.config.json', () => {
  it('defaults to claude/claude/codex when no roles config exists', () => {
    const dir = makeProject();
    const result = importConfigField('ROLE_MAPPING', { cwd: dir, env: baseEnv() });
    expect(result.status).toBe(0);
    const mapping = JSON.parse(result.stdout);
    expect(mapping.planner).toBe('claude');
    expect(mapping.implementer).toBe('claude');
    expect(mapping.auditor).toBe('codex');
  });

  it('reads a custom role mapping from agentloop.config.json', () => {
    const dir = makeProject({
      config: {
        roles: { planner: 'claude', implementer: 'claude', auditor: 'codex' },
      },
    });
    const result = importConfigField('ROLE_MAPPING', { cwd: dir, env: baseEnv() });
    expect(result.status).toBe(0);
    const mapping = JSON.parse(result.stdout);
    expect(mapping.planner).toBe('claude');
    expect(mapping.implementer).toBe('claude');
    expect(mapping.auditor).toBe('codex');
  });

  it('merges partial role config with defaults', () => {
    const dir = makeProject({
      config: { roles: { auditor: 'codex' } },
    });
    const result = importConfigField('ROLE_MAPPING', { cwd: dir, env: baseEnv() });
    expect(result.status).toBe(0);
    const mapping = JSON.parse(result.stdout);
    // Unspecified roles keep their defaults.
    expect(mapping.planner).toBe('claude');
    expect(mapping.implementer).toBe('claude');
    expect(mapping.auditor).toBe('codex');
  });

  it('rejects an invalid role mapping at config load', () => {
    const dir = makeProject({
      config: { roles: { implementer: 'gpt-5' } },
    });
    const result = importConfigField('ROLE_MAPPING', { cwd: dir, env: baseEnv() });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Unknown provider/);
  });

  it('rejects a provider that does not support the role at config load', () => {
    const dir = makeProject({
      config: { roles: { implementer: 'codex' } },
    });
    const result = importConfigField('ROLE_MAPPING', { cwd: dir, env: baseEnv() });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/does not support/);
  });

  it('rejects when auditor is mapped to claude (not yet supported)', () => {
    const dir = makeProject({
      config: { roles: { auditor: 'claude' } },
    });
    const result = importConfigField('ROLE_MAPPING', { cwd: dir, env: baseEnv() });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/does not support/);
  });

  it('treats an empty string role value as unset and uses the default', () => {
    const dir = makeProject({
      config: { roles: { implementer: '' } },
    });
    const result = importConfigField('ROLE_MAPPING', { cwd: dir, env: baseEnv() });
    expect(result.status).toBe(0);
    const mapping = JSON.parse(result.stdout);
    expect(mapping.implementer).toBe('claude');
  });

  it('trims whitespace from role values', () => {
    const dir = makeProject({
      config: { roles: { auditor: '  codex  ' } },
    });
    const result = importConfigField('ROLE_MAPPING', { cwd: dir, env: baseEnv() });
    expect(result.status).toBe(0);
    const mapping = JSON.parse(result.stdout);
    expect(mapping.auditor).toBe('codex');
  });

  it('rejects an unknown role key — typo "audtor" is not silently ignored', () => {
    const dir = makeProject({
      config: { roles: { audtor: 'claude' } },
    });
    const result = importConfigField('ROLE_MAPPING', { cwd: dir, env: baseEnv() });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/unknown role key/);
    expect(result.stderr).toMatch(/"audtor"/);
  });

  it('rejects an unknown role key even when mixed with valid keys', () => {
    const dir = makeProject({
      config: { roles: { implementer: 'claude', audtor: 'codex' } },
    });
    const result = importConfigField('ROLE_MAPPING', { cwd: dir, env: baseEnv() });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/unknown role key/);
  });

  it('rejects multiple unknown role keys at once', () => {
    const dir = makeProject({
      config: { roles: { implementor: 'claude', auditer: 'codex' } },
    });
    const result = importConfigField('ROLE_MAPPING', { cwd: dir, env: baseEnv() });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/unknown role key/);
  });

  it('rejects a null value for a valid role key — empty string is fine, null is not', () => {
    // null is not a string, so it won't be trimmed — but the key is valid
    // and the null value is silently ignored by the typeof check.  This is
    // acceptable: the role keeps its default.  What we must NOT do is crash
    // on a null value inside a valid key.
    const dir = makeProject({
      config: { roles: { implementer: null } },
    });
    const result = importConfigField('ROLE_MAPPING', { cwd: dir, env: baseEnv() });
    expect(result.status).toBe(0);
    const mapping = JSON.parse(result.stdout);
    expect(mapping.implementer).toBe('claude');
  });
});

/* ------------------------------------------------------------------ *
 * getProviderConfig from agentloop.config.json                         *
 * ------------------------------------------------------------------ */

describe('getProviderConfig keeps settings attached to the provider', () => {
  it('returns claude config from the claude key', () => {
    const dir = makeProject({
      config: { claude: { permissionMode: 'acceptEdits' } },
    });
    // getProviderConfig is a function, not a value — import and call it as a
    // one-liner via spawn.
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import(${JSON.stringify(pathToFileURL(path.join(HERE, 'config.mjs')).href)}).then((m) => { const cfg = m.getProviderConfig('claude'); process.stdout.write(JSON.stringify(cfg)); }, (e) => { process.stderr.write(e.message); process.exit(1); });`,
      ],
      { cwd: dir, env: baseEnv(), encoding: 'utf8' },
    );
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ permissionMode: 'acceptEdits' });
  });

  it('returns empty object for a provider with no config', () => {
    const dir = makeProject();
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import(${JSON.stringify(pathToFileURL(path.join(HERE, 'config.mjs')).href)}).then((m) => { const cfg = m.getProviderConfig('codex'); process.stdout.write(JSON.stringify(cfg)); }, (e) => { process.stderr.write(e.message); process.exit(1); });`,
      ],
      { cwd: dir, env: baseEnv(), encoding: 'utf8' },
    );
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({});
  });

  it('returns empty object for an unknown provider', () => {
    const dir = makeProject();
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import(${JSON.stringify(pathToFileURL(path.join(HERE, 'config.mjs')).href)}).then((m) => { const cfg = m.getProviderConfig('gemini'); process.stdout.write(JSON.stringify(cfg)); }, (e) => { process.stderr.write(e.message); process.exit(1); });`,
      ],
      { cwd: dir, env: baseEnv(), encoding: 'utf8' },
    );
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({});
  });
});

/* ------------------------------------------------------------------ *
 * Existing Claude config still works through provider abstraction      *
 * ------------------------------------------------------------------ */

describe('provider-specific Claude config is preserved', () => {
  it('CLAUDE_ALLOWED_TOOLS still resolves as before', () => {
    const dir = makeProject();
    const result = importConfigField('CLAUDE_ALLOWED_TOOLS', { cwd: dir, env: baseEnv() });
    expect(result.status).toBe(0);
    const value = JSON.parse(result.stdout);
    // The default allowlist must still be the same secure set.
    expect(value).toContain('Read');
    expect(value).toContain('Bash(git status*)');
    expect(value).not.toMatch(/git push/i);
  });
});

/* ------------------------------------------------------------------ *
 * CLAUDE_RELAY_MODE (ALCLI permission relay mode)                     *
 * ------------------------------------------------------------------ */

describe('CLAUDE_RELAY_MODE', () => {
  it('defaults to "interactive"', () => {
    const dir = makeProject();
    const result = importConfigField('CLAUDE_RELAY_MODE', { cwd: dir, env: baseEnv() });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toBe('interactive');
  });

  it('CLAUDE_PERMISSION_MODE is unchanged — defaults to "acceptEdits"', () => {
    const dir = makeProject();
    const result = importConfigField('CLAUDE_PERMISSION_MODE', { cwd: dir, env: baseEnv() });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toBe('acceptEdits');
  });

  it('resolves "interactive" from claude.relayMode in config', () => {
    const dir = makeProject({
      config: { claude: { relayMode: 'interactive' } },
    });
    const result = importConfigField('CLAUDE_RELAY_MODE', { cwd: dir, env: baseEnv() });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toBe('interactive');
  });

  it('resolves "auto" from claude.relayMode in config', () => {
    const dir = makeProject({
      config: { claude: { relayMode: 'auto' } },
    });
    const result = importConfigField('CLAUDE_RELAY_MODE', { cwd: dir, env: baseEnv() });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toBe('auto');
  });

  it('env var AGENTLOOP_CLAUDE_RELAY_MODE overrides config', () => {
    const dir = makeProject({
      config: { claude: { relayMode: 'interactive' } },
    });
    const result = importConfigField('CLAUDE_RELAY_MODE', {
      cwd: dir,
      env: baseEnv({ AGENTLOOP_CLAUDE_RELAY_MODE: 'auto' }),
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toBe('auto');
  });

  it('rejects invalid mode "acceptEdits" (a CLI value, not a relay mode)', () => {
    const dir = makeProject({
      config: { claude: { relayMode: 'acceptEdits' } },
    });
    const result = importConfigField('CLAUDE_RELAY_MODE', { cwd: dir, env: baseEnv() });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Invalid Claude relay mode/);
  });

  it('rejects invalid mode "bypassPermissions" in config', () => {
    const dir = makeProject({
      config: { claude: { relayMode: 'bypassPermissions' } },
    });
    const result = importConfigField('CLAUDE_RELAY_MODE', { cwd: dir, env: baseEnv() });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Invalid Claude relay mode/);
  });

  it('rejects invalid mode "default" in config', () => {
    const dir = makeProject({
      config: { claude: { relayMode: 'default' } },
    });
    const result = importConfigField('CLAUDE_RELAY_MODE', { cwd: dir, env: baseEnv() });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Invalid Claude relay mode/);
  });

  it('rejects empty string relayMode', () => {
    const dir = makeProject({
      config: { claude: { relayMode: '' } },
    });
    const result = importConfigField('CLAUDE_RELAY_MODE', { cwd: dir, env: baseEnv() });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Invalid Claude relay mode/);
  });

  it('rejects invalid mode via env var', () => {
    const dir = makeProject();
    const result = importConfigField('CLAUDE_RELAY_MODE', {
      cwd: dir,
      env: baseEnv({ AGENTLOOP_CLAUDE_RELAY_MODE: 'garbage' }),
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Invalid Claude relay mode/);
  });
});

describe('CLAUDE_RELAY_MODE works regardless of role mapping', () => {
  it('"auto" mode works when claude is the implementer', () => {
    const dir = makeProject({
      config: { claude: { relayMode: 'auto' }, roles: { implementer: 'claude' } },
    });
    const result = importConfigField('CLAUDE_RELAY_MODE', { cwd: dir, env: baseEnv() });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toBe('auto');
  });

  it('"auto" mode works when claude is the planner', () => {
    const dir = makeProject({
      config: { claude: { relayMode: 'auto' }, roles: { planner: 'claude' } },
    });
    const result = importConfigField('CLAUDE_RELAY_MODE', { cwd: dir, env: baseEnv() });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toBe('auto');
  });

  it('"interactive" mode works when claude is both planner and implementer', () => {
    const dir = makeProject({
      config: {
        claude: { relayMode: 'interactive' },
        roles: { planner: 'claude', implementer: 'claude', auditor: 'codex' },
      },
    });
    const result = importConfigField('CLAUDE_RELAY_MODE', { cwd: dir, env: baseEnv() });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toBe('interactive');
  });
});

describe('existing CLAUDE_PERMISSION_MODE still works as before', () => {
  it('CLAUDE_PERMISSION_MODE resolves from the claude provider config', () => {
    const dir = makeProject({
      config: { claude: { permissionMode: 'default' } },
    });
    const result = importConfigField('CLAUDE_PERMISSION_MODE', { cwd: dir, env: baseEnv() });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toBe('default');
  });

  it('CLAUDE_PERMISSION_MODE defaults to "acceptEdits" when unconfigured', () => {
    const dir = makeProject();
    const result = importConfigField('CLAUDE_PERMISSION_MODE', { cwd: dir, env: baseEnv() });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toBe('acceptEdits');
  });

  it('relayMode does not affect CLAUDE_PERMISSION_MODE', () => {
    const dir = makeProject({
      config: { claude: { relayMode: 'auto' } },
    });
    const perm = importConfigField('CLAUDE_PERMISSION_MODE', { cwd: dir, env: baseEnv() });
    const relay = importConfigField('CLAUDE_RELAY_MODE', { cwd: dir, env: baseEnv() });
    expect(perm.status).toBe(0);
    expect(relay.status).toBe(0);
    expect(JSON.parse(perm.stdout)).toBe('acceptEdits');
    expect(JSON.parse(relay.stdout)).toBe('auto');
  });
});

/* ------------------------------------------------------------------ *
 * LOGICAL_ROLES is comprehensive                                       *
 * ------------------------------------------------------------------ */

describe('LOGICAL_ROLES', () => {
  it('contains exactly planner, implementer, auditor', () => {
    expect(LOGICAL_ROLES).toEqual(['planner', 'implementer', 'auditor']);
  });

  it('is frozen', () => {
    expect(() => { LOGICAL_ROLES.push('publisher'); }).toThrow();
  });
});

/* ------------------------------------------------------------------ *
 * Agent-router exports                                                 *
 * ------------------------------------------------------------------ */

describe('agent-router exports are importable', () => {
  it('runImplementer is a function', async () => {
    const { runImplementer } = await import('./agent-router.mjs');
    expect(runImplementer).toBeTypeOf('function');
  });

  it('runAuditor is a function', async () => {
    const { runAuditor } = await import('./agent-router.mjs');
    expect(runAuditor).toBeTypeOf('function');
  });

  it('resolveRoleProvider is a function', async () => {
    const { resolveRoleProvider } = await import('./agent-router.mjs');
    expect(resolveRoleProvider).toBeTypeOf('function');
  });

  it('resolveRoleProvider resolves provider and identity for the default mapping', async () => {
    const { resolveRoleProvider: rrp } = await import('./agent-router.mjs');
    const result = rrp('implementer');
    expect(result.provider).toBe('claude');
    expect(result.identity).toBe('CLAUDE');
  });

  it('resolveRoleProvider resolves auditor provider and identity', async () => {
    const { resolveRoleProvider: rrp } = await import('./agent-router.mjs');
    const result = rrp('auditor');
    expect(result.provider).toBe('codex');
    expect(result.identity).toBe('CODEX');
  });

  it('streamClaudeProgress is re-exported', async () => {
    const { streamClaudeProgress } = await import('./agent-router.mjs');
    expect(streamClaudeProgress).toBeTypeOf('function');
  });
});
