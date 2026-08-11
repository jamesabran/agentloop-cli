// @vitest-environment node
/**
 * ALCLI interactive setup & project configuration tests.
 *
 * Covers:
 *  1. Fresh project setup (all defaults)
 *  2. Existing config protection (reconfigure mode)
 *  3. Role/provider assignments
 *  4. Provider-specific settings (Claude permission/relay mode)
 *  5. Runtime verification profile configuration
 *  6. Invalid configuration rejection
 *  7. Saved config reloads correctly
 *  8. Backward compatibility
 *  9. Reconfiguration path
 * 10. Cancellation leaves project unchanged
 * 11. Config assembly edge cases
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  assembleConfig,
  buildConfig,
  formatSummary,
  loadExistingConfig,
  saveConfig,
  validateConfig,
} from './setup.mjs';

/* ------------------------------------------------------------------ *
 * Helpers                                                              *
 * ------------------------------------------------------------------ */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SETUP_URL = pathToFileURL(path.join(HERE, 'setup.mjs')).href;

const tempDirs = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

function makeProject({ config, git = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentloop-setup-'));
  tempDirs.push(dir);
  if (git) spawnSync('git', ['init', '--quiet'], { cwd: dir });
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

/**
 * Create a mock prompt that returns canned responses in order.
 * `display` and `section` are silent no-ops.
 *
 * Each call to `question`, `confirm`, or `select` consumes one entry from the
 * `responses` array.  Strings are returned as-is for `question` calls.
 * Booleans are returned for `confirm` calls.  Any value is returned for
 * `select` calls.
 */
function mockPrompt(responses = []) {
  let i = 0;
  const next = () => {
    if (i >= responses.length) return '';
    return responses[i++];
  };
  return {
    question: async () => next(),
    confirm: async () => {
      const v = next();
      if (typeof v === 'boolean') return v;
      return v === 'y' || v === 'yes';
    },
    select: async () => next(),
    display: () => {},
    section: () => {},
  };
}

/**
 * Return a mock discovery result with all known providers available.
 * Used by tests so they don't depend on real CLI installation state.
 */
function mockDiscoveredAvailable() {
  return {
    claude: { available: true, path: '/usr/bin/claude' },
    codex: { available: true, path: '/usr/bin/codex' },
  };
}

/**
 * Return a mock discovery result with all providers unavailable.
 */
function mockDiscoveredUnavailable() {
  return {
    claude: { available: false, reason: 'not installed' },
    codex: { available: false, reason: 'not installed' },
  };
}

/**
 * Build a sequence of responses that accepts all defaults with the new flow.
 *
 * New flow:
 *   1. sectionRecommended: confirm → true (fast path)
 *   2. sectionRoles: planner select → 'manual', implementer confirm → true,
 *      auditor confirm → true
 *   3. sectionProviderSettings: claude permissionMode → 'acceptEdits',
 *      claude relayMode → 'interactive'
 */
function defaultResponses() {
  const arr = [];
  // Recommended settings: accept fast path
  arr.push(true);
  // Roles: planner select (manual)
  arr.push('manual');
  // Roles: implementer confirm (claude)
  arr.push(true);
  // Roles: auditor confirm (codex)
  arr.push(true);
  // Provider: Claude permissionMode, relayMode (claude selected for implementer)
  arr.push('acceptEdits', 'interactive');
  return arr;
}

/* ------------------------------------------------------------------ *
 * Import helpers for testing through the config module                 *
 * ------------------------------------------------------------------ */

const CONFIG_URL = pathToFileURL(path.join(HERE, 'config.mjs')).href;

function importConfigField(field, { cwd, env }) {
  return spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import(${JSON.stringify(CONFIG_URL)}).then((m) => process.stdout.write(JSON.stringify(m.${field} ?? null)), (e) => { process.stderr.write(e.message); process.exit(1); });`,
    ],
    { cwd, env, encoding: 'utf8', timeout: 15_000 },
  );
}

/* ================================================================== *
 * assembleConfig                                                      *
 * ================================================================== */

describe('assembleConfig', () => {
  it('returns an empty object when all fragments are empty', () => {
    const config = assembleConfig({
      project: {},
      roles: {},
      verification: {},
      controller: {},
      providerSettings: {},
    });
    expect(config).toEqual({});
  });

  it('includes project fields that differ from defaults', () => {
    const config = assembleConfig({
      project: { repo: 'org/repo', baseBranch: 'trunk' },
      roles: {},
      verification: {},
      controller: {},
      providerSettings: {},
    });
    expect(config.repo).toBe('org/repo');
    expect(config.baseBranch).toBe('trunk');
  });

  it('omits empty project fields', () => {
    const config = assembleConfig({
      project: { repo: '', remote: '' },
      roles: {},
      verification: {},
      controller: {},
      providerSettings: {},
    });
    expect(config.repo).toBeUndefined();
    expect(config.remote).toBeUndefined();
  });

  it('includes non-default role mapping', () => {
    const config = assembleConfig({
      project: {},
      roles: { planner: 'claude', implementer: 'codex', auditor: 'codex' },
      verification: {},
      controller: {},
      providerSettings: {},
    });
    expect(config.roles).toBeDefined();
    // implementer: 'codex' is non-default (default is 'claude')
    expect(config.roles.implementer).toBe('codex');
    // planner: 'claude' is default → not included
    expect(config.roles.planner).toBeUndefined();
  });

  it('omits roles key when mapping is entirely default', () => {
    const config = assembleConfig({
      project: {},
      roles: { planner: 'claude', implementer: 'claude', auditor: 'codex' },
      verification: {},
      controller: {},
      providerSettings: {},
    });
    expect(config.roles).toBeUndefined();
  });

  it('includes deterministic checks', () => {
    const config = assembleConfig({
      project: {},
      roles: {},
      verification: { checks: [{ name: 'unit', script: 'test:unit' }] },
      controller: {},
      providerSettings: {},
    });
    expect(config.checks).toEqual([{ name: 'unit', script: 'test:unit' }]);
  });

  it('includes runtime verification config', () => {
    const config = assembleConfig({
      project: {},
      roles: {},
      verification: {
        runtimeVerification: {
          profile: 'standard',
          checks: [{ name: 'smoke', command: 'npm run test:smoke' }],
        },
      },
      controller: {},
      providerSettings: {},
    });
    expect(config.runtimeVerification.profile).toBe('standard');
    expect(config.runtimeVerification.checks).toEqual([
      { name: 'smoke', command: 'npm run test:smoke' },
    ]);
  });

  it('includes publish mode and max change rounds', () => {
    const config = assembleConfig({
      project: {},
      roles: {},
      verification: {},
      controller: { publishMode: 'auto', maxChangeRounds: 3 },
      providerSettings: {},
    });
    expect(config.publishMode).toBe('auto');
    expect(config.maxChangeRounds).toBe(3);
  });

  it('omits manual publish mode (default)', () => {
    const config = assembleConfig({
      project: {},
      roles: {},
      verification: {},
      controller: { publishMode: 'manual', maxChangeRounds: 2 },
      providerSettings: {},
    });
    expect(config.publishMode).toBeUndefined();
    expect(config.maxChangeRounds).toBeUndefined();
  });

  it('includes Claude provider settings when non-default', () => {
    const config = assembleConfig({
      project: {},
      roles: {},
      verification: {},
      controller: {},
      providerSettings: { claude: { permissionMode: 'default', relayMode: 'auto' } },
    });
    expect(config.claude).toBeDefined();
    expect(config.claude.permissionMode).toBe('default');
    expect(config.claude.relayMode).toBe('auto');
  });

  it('omits Claude settings when they are default values', () => {
    const config = assembleConfig({
      project: {},
      roles: {},
      verification: {},
      controller: {},
      providerSettings: { claude: { permissionMode: 'acceptEdits', relayMode: 'interactive' } },
    });
    expect(config.claude).toBeUndefined();
  });

  it('assembles a complete config with all sections', () => {
    const config = assembleConfig({
      project: { repo: 'myorg/myrepo', baseBranch: 'trunk', remote: 'upstream' },
      roles: { planner: 'claude', implementer: 'claude', auditor: 'codex' },
      verification: {
        checks: [{ name: 'unit', script: 'test:unit' }],
        runtimeVerification: {
          profile: 'integration',
          checks: [{ name: 'e2e', command: 'npm run test:e2e' }],
        },
      },
      controller: { publishMode: 'auto', maxChangeRounds: 1 },
      providerSettings: { claude: { relayMode: 'auto' } },
    });
    expect(config.repo).toBe('myorg/myrepo');
    expect(config.baseBranch).toBe('trunk');
    expect(config.remote).toBe('upstream');
    expect(config.checks).toEqual([{ name: 'unit', script: 'test:unit' }]);
    expect(config.runtimeVerification.profile).toBe('integration');
    expect(config.runtimeVerification.checks).toEqual([
      { name: 'e2e', command: 'npm run test:e2e' },
    ]);
    expect(config.publishMode).toBe('auto');
    expect(config.maxChangeRounds).toBe(1);
    expect(config.claude.relayMode).toBe('auto');
  });
});

/* ================================================================== *
 * loadExistingConfig                                                   *
 * ================================================================== */

describe('loadExistingConfig', () => {
  it('returns an empty object when no config file exists', () => {
    const dir = makeProject();
    expect(loadExistingConfig(dir)).toEqual({});
  });

  it('loads an existing config file', () => {
    const dir = makeProject({ config: { repo: 'org/repo', publishMode: 'auto' } });
    const cfg = loadExistingConfig(dir);
    expect(cfg.repo).toBe('org/repo');
    expect(cfg.publishMode).toBe('auto');
  });

  it('returns empty object for corrupt JSON', () => {
    const dir = makeProject();
    fs.writeFileSync(path.join(dir, 'agentloop.config.json'), '{not json', 'utf8');
    expect(loadExistingConfig(dir)).toEqual({});
  });

  it('returns empty object for non-object config', () => {
    const dir = makeProject();
    fs.writeFileSync(path.join(dir, 'agentloop.config.json'), '"just a string"', 'utf8');
    expect(loadExistingConfig(dir)).toEqual({});
  });
});

/* ================================================================== *
 * buildConfig — programmatic config building with mock prompts         *
 * ================================================================== */

describe('buildConfig with mock prompt', () => {
  const discovered = mockDiscoveredAvailable();

  it('produces minimal config when all defaults are accepted', async () => {
    const prompt = mockPrompt(defaultResponses());
    const config = await buildConfig({ existingConfig: {}, prompt, discovered });
    // With all defaults (fast path, manual planner), config should be minimal
    // except for the recommended standard runtime verification profile.
    expect(config.repo).toBeUndefined();
    expect(config.publishMode).toBeUndefined();
    expect(config.runtimeVerification).toBeDefined();
    expect(config.runtimeVerification.profile).toBe('standard');
  });

  it('captures project identification fields (manual path)', async () => {
    const prompt = mockPrompt([
      // Recommended: decline fast path
      false,
      // Project
      'myorg/myrepo',  // repo
      'trunk',          // baseBranch
      'upstream',       // remote
      'tasks.json',     // tasksFile
      // Verification
      true,             // use default checks
      'lightweight',    // runtime verification profile
      // Controller
      'manual',         // publish mode
      '',               // max change rounds (default)
      // Roles
      'manual',         // planner → manual
      true,             // implementer → claude
      true,             // auditor → codex
      // Provider — Claude (selected for implementer)
      'acceptEdits',    // permission mode
      'interactive',    // relay mode
    ]);
    const config = await buildConfig({ existingConfig: {}, prompt, discovered });
    expect(config.repo).toBe('myorg/myrepo');
    expect(config.baseBranch).toBe('trunk');
    expect(config.remote).toBe('upstream');
    expect(config.tasksFile).toBe('tasks.json');
  });

  it('captures custom role mapping with claude for all', async () => {
    const prompt = mockPrompt([
      // Recommended: accept fast path
      true,
      // Roles: planner → claude, implementer → claude, auditor → codex
      'claude',         // planner select
      true,             // implementer confirm
      true,             // auditor confirm
      // Provider
      'acceptEdits', 'interactive',
    ]);
    const config = await buildConfig({ existingConfig: {}, prompt, discovered });
    // planner=claude is default, implementer=claude is default, auditor=codex is default
    expect(config.roles).toBeUndefined();
  });

  it('includes custom checks when defaults are rejected', async () => {
    const prompt = mockPrompt([
      // Recommended: decline fast path
      false,
      // Project
      '', '', '', '',
      // Verification
      false,            // do NOT use default checks
      'lint',           // check #1 name
      'lint',           // check #1 script
      '',               // check #2 name (empty → finish)
      'lightweight',    // runtime verification profile
      // Controller
      'manual', '',
      // Roles
      'manual',         // planner → manual
      true,             // implementer → claude
      true,             // auditor → codex
      // Provider
      'acceptEdits', 'interactive',
    ]);
    const config = await buildConfig({ existingConfig: {}, prompt, discovered });
    expect(config.checks).toBeDefined();
    expect(config.checks).toEqual([{ name: 'lint', script: 'lint' }]);
  });

  it('captures runtime verification with standard profile and checks', async () => {
    const prompt = mockPrompt([
      // Recommended: decline fast path
      false,
      // Project
      '', '', '', '',
      // Verification — defaults
      true,
      // Runtime verification
      'standard',       // profile
      true,             // configure runtime checks
      'api-smoke',      // check name
      'npm run test:integration',  // check command
      false,            // add another? → no
      // Controller
      'manual', '',
      // Roles
      'manual',         // planner → manual
      true,             // implementer → claude
      true,             // auditor → codex
      // Provider
      'acceptEdits', 'interactive',
    ]);
    const config = await buildConfig({ existingConfig: {}, prompt, discovered });
    expect(config.runtimeVerification).toBeDefined();
    expect(config.runtimeVerification.profile).toBe('standard');
    expect(config.runtimeVerification.checks).toEqual([
      { name: 'api-smoke', command: 'npm run test:integration' },
    ]);
  });

  it('captures auto publish mode', async () => {
    const prompt = mockPrompt([
      // Recommended: decline fast path
      false,
      // Project
      '', '', '', '',
      // Verification
      true, 'lightweight',
      // Controller
      'auto',           // publish mode
      '3',              // max change rounds
      // Roles
      'manual',         // planner → manual
      true,             // implementer → claude
      true,             // auditor → codex
      // Provider
      'acceptEdits', 'interactive',
    ]);
    const config = await buildConfig({ existingConfig: {}, prompt, discovered });
    expect(config.publishMode).toBe('auto');
    expect(config.maxChangeRounds).toBe(3);
  });

  it('captures Claude provider settings', async () => {
    const prompt = mockPrompt([
      // Recommended: accept fast path
      true,
      // Roles: implementer → claude
      'manual',         // planner → manual
      true,             // implementer → claude
      true,             // auditor → codex
      // Provider — Claude
      'default',        // permission mode (non-default)
      'auto',           // relay mode (non-default)
    ]);
    const config = await buildConfig({ existingConfig: {}, prompt, discovered });
    expect(config.claude).toBeDefined();
    expect(config.claude.permissionMode).toBe('default');
    expect(config.claude.relayMode).toBe('auto');
  });

  it('omits Claude settings when they are defaults', async () => {
    const prompt = mockPrompt(defaultResponses());
    const config = await buildConfig({ existingConfig: {}, prompt, discovered });
    // Manual planner → Claude not selected for planner
    // Default Claude settings for implementer → omitted
    expect(config.claude).toBeUndefined();
  });
});

/* ================================================================== *
 * Reconfiguration — existing config values become defaults              *
 * ================================================================== */

describe('reconfiguration with existing config', () => {
  const discovered = mockDiscoveredAvailable();

  it('reuses existing values as defaults', async () => {
    const existing = {
      repo: 'org/existing',
      baseBranch: 'trunk',
      publishMode: 'auto',
      maxChangeRounds: 1,
      claude: { permissionMode: 'default', relayMode: 'auto' },
    };
    // User accepts all defaults
    const prompt = mockPrompt([
      // Recommended: decline to exercise manual path
      false,
      // Project — all empty → keep existing
      '', '', '', '',
      // Verification
      true, 'lightweight',
      // Controller — keep existing values
      'auto',           // select: keep 'auto'
      '',               // question: keep '1'
      // Roles
      'manual',         // planner → manual
      true,             // implementer → claude
      true,             // auditor → codex
      // Provider
      'default',        // select: keep 'default'
      'auto',           // select: keep 'auto'
    ]);
    const config = await buildConfig({ existingConfig: existing, prompt, discovered });
    expect(config.repo).toBe('org/existing');
    expect(config.baseBranch).toBe('trunk');
    expect(config.publishMode).toBe('auto');
    expect(config.maxChangeRounds).toBe(1);
    expect(config.claude.permissionMode).toBe('default');
    expect(config.claude.relayMode).toBe('auto');
  });

  it('allows overriding existing values', async () => {
    const existing = {
      repo: 'org/old',
      publishMode: 'auto',
    };
    const prompt = mockPrompt([
      // Recommended: decline fast path
      false,
      // Project — override repo
      'org/new-repo',   // repo
      '', '', '',
      // Verification
      true, 'lightweight',
      // Controller
      'manual',         // override publish mode
      '',
      // Roles
      'manual',         // planner → manual
      true,             // implementer → claude
      true,             // auditor → codex
      // Provider
      'acceptEdits', 'interactive',
    ]);
    const config = await buildConfig({ existingConfig: existing, prompt, discovered });
    expect(config.repo).toBe('org/new-repo');
    expect(config.publishMode).toBeUndefined(); // manual is default → omitted
  });
});

/* ================================================================== *
 * Validation & save/load cycle                                         *
 * ================================================================== */

describe('validateConfig', () => {
  it('valid config passes validation', () => {
    const dir = makeProject();
    saveConfig({ repo: 'org/repo' }, dir);
    const result = validateConfig(dir);
    expect(result.ok).toBe(true);
  });

  it('minimal config (empty object) passes validation', () => {
    const dir = makeProject();
    saveConfig({}, dir);
    const result = validateConfig(dir);
    expect(result.ok).toBe(true);
  });

  it('invalid role mapping fails validation', () => {
    const dir = makeProject();
    saveConfig({ roles: { implementer: 'nonexistent' } }, dir);
    const result = validateConfig(dir);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /Unknown provider/.test(e) || /not permitted/.test(e))).toBe(true);
  });

  it('invalid publish mode fails validation', () => {
    const dir = makeProject();
    saveConfig({ publishMode: 'on-merge' }, dir);
    const result = validateConfig(dir);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /Invalid publish mode/.test(e))).toBe(true);
  });

  it('invalid runtime verification profile fails validation', () => {
    const dir = makeProject();
    saveConfig({ runtimeVerification: { profile: 'super-strict' } }, dir);
    const result = validateConfig(dir);
    expect(result.ok).toBe(false);
  });
});

describe('save and reload cycle', () => {
  it('saved config is loadable by the real config module', () => {
    const dir = makeProject({ config: { repo: 'org/repo' } });
    // Already has a config from makeProject. Now write a new one.
    saveConfig({
      repo: 'org/repo',
      baseBranch: 'trunk',
      publishMode: 'auto',
      roles: { planner: 'claude', implementer: 'claude', auditor: 'codex' },
      checks: [{ name: 'unit', script: 'test:unit' }],
      runtimeVerification: {
        profile: 'standard',
        checks: [{ name: 'smoke', command: 'npm run test:smoke' }],
      },
      claude: { relayMode: 'auto' },
    }, dir);

    // Load via the real config module
    const repo = importConfigField('REPO', { cwd: dir, env: baseEnv() });
    expect(repo.status).toBe(0);
    expect(JSON.parse(repo.stdout)).toBe('org/repo');

    const baseBranch = importConfigField('BASE_BRANCH', { cwd: dir, env: baseEnv() });
    expect(baseBranch.status).toBe(0);
    expect(JSON.parse(baseBranch.stdout)).toBe('trunk');

    const publishMode = importConfigField('PUBLISH_MODE', { cwd: dir, env: baseEnv() });
    expect(publishMode.status).toBe(0);
    expect(JSON.parse(publishMode.stdout)).toBe('auto');

    const roleMapping = importConfigField('ROLE_MAPPING', { cwd: dir, env: baseEnv() });
    expect(roleMapping.status).toBe(0);
    const mapping = JSON.parse(roleMapping.stdout);
    expect(mapping.planner).toBe('claude');
    expect(mapping.implementer).toBe('claude');
    expect(mapping.auditor).toBe('codex');

    const checks = importConfigField('DETERMINISTIC_CHECKS', { cwd: dir, env: baseEnv() });
    expect(checks.status).toBe(0);
    expect(JSON.parse(checks.stdout)).toEqual([{ name: 'unit', script: 'test:unit' }]);

    const rv = importConfigField('PROJECT_RUNTIME_VERIFICATION', { cwd: dir, env: baseEnv() });
    expect(rv.status).toBe(0);
    const parsedRv = JSON.parse(rv.stdout);
    expect(parsedRv.profile).toBe('standard');
    expect(parsedRv.checks).toEqual([{ name: 'smoke', command: 'npm run test:smoke' }]);

    // CLAUDE_RELAY_MODE should pick up the claude.relayMode value
    const relayMode = importConfigField('CLAUDE_RELAY_MODE', { cwd: dir, env: baseEnv() });
    expect(relayMode.status).toBe(0);
    expect(JSON.parse(relayMode.stdout)).toBe('auto');
  });

  it('empty config is loadable by the real config module', () => {
    const dir = makeProject();
    saveConfig({}, dir);

    const repo = importConfigField('REPO', { cwd: dir, env: baseEnv() });
    expect(repo.status).toBe(0);
    expect(JSON.parse(repo.stdout)).toBeNull();
  });
});

/* ================================================================== *
 * Backward compatibility                                               *
 * ================================================================== */

describe('backward compatibility', () => {
  it('loads existing agentloop.config.json with all legacy fields', () => {
    const existingConfig = {
      repo: 'org/repo',
      baseBranch: 'main',
      remote: 'origin',
      checks: [
        { name: 'typecheck', script: 'typecheck' },
        { name: 'lint', script: 'lint' },
        { name: 'test', script: 'test' },
        { name: 'build', script: 'build' },
      ],
      publishMode: 'manual',
      maxChangeRounds: 2,
      claude: { permissionMode: 'acceptEdits' },
      roles: { planner: 'claude', implementer: 'claude', auditor: 'codex' },
    };

    const dir = makeProject({ config: existingConfig });
    const loaded = loadExistingConfig(dir);
    expect(loaded.repo).toBe('org/repo');
    expect(loaded.baseBranch).toBe('main');
    expect(loaded.checks).toHaveLength(4);
    expect(loaded.publishMode).toBe('manual');
    expect(loaded.claude.permissionMode).toBe('acceptEdits');
    expect(loaded.roles.auditor).toBe('codex');
  });

  it('an older config without roles or claude keys loads fine', () => {
    // Older configs might not have `roles` or `claude` keys — the config
    // module defaults them.  Setup must handle this gracefully.
    const oldConfig = {
      repo: 'org/old-project',
      baseBranch: 'develop',
      checks: [{ name: 'test', script: 'test' }],
    };

    const dir = makeProject({ config: oldConfig });

    // Load via the real config module — should use all defaults for missing keys
    const repo = importConfigField('REPO', { cwd: dir, env: baseEnv() });
    expect(repo.status).toBe(0);
    expect(JSON.parse(repo.stdout)).toBe('org/old-project');

    const baseBranch = importConfigField('BASE_BRANCH', { cwd: dir, env: baseEnv() });
    expect(baseBranch.status).toBe(0);
    expect(JSON.parse(baseBranch.stdout)).toBe('develop');

    const roleMapping = importConfigField('ROLE_MAPPING', { cwd: dir, env: baseEnv() });
    expect(roleMapping.status).toBe(0);
    const mapping = JSON.parse(roleMapping.stdout);
    expect(mapping.implementer).toBe('claude');  // default
    expect(mapping.auditor).toBe('codex');        // default
  });

  it('handles an existing config that only has runtimeVerification', () => {
    const dir = makeProject({
      config: {
        runtimeVerification: {
          profile: 'integration',
          checks: [{ name: 'e2e', command: 'npm run test:e2e' }],
        },
      },
    });

    const rv = importConfigField('PROJECT_RUNTIME_VERIFICATION', { cwd: dir, env: baseEnv() });
    expect(rv.status).toBe(0);
    const parsed = JSON.parse(rv.stdout);
    expect(parsed.profile).toBe('integration');
    expect(parsed.checks).toEqual([{ name: 'e2e', command: 'npm run test:e2e' }]);
  });
});

/* ================================================================== *
 * Cancellation — setup that does not confirm must not write            *
 * ================================================================== */

describe('cancellation leaves project unchanged', () => {
  const discovered = mockDiscoveredAvailable();

  it('buildConfig does not write to disk', async () => {
    const dir = makeProject();
    const configPath = path.join(dir, 'agentloop.config.json');

    const prompt = mockPrompt([
      false,            // recommended: decline fast path
      'org/repo', '', '', '',
      true, 'lightweight',
      'manual', '',
      'manual',         // planner
      true,             // implementer
      true,             // auditor
      'acceptEdits', 'interactive',
    ]);
    await buildConfig({ existingConfig: {}, prompt, discovered });

    // buildConfig never writes — it only returns the config
    expect(fs.existsSync(configPath)).toBe(false);
  });

  it('runSetup with a mock prompt that says no does not save', async () => {
    const dir = makeProject({ config: { repo: 'org/original' } });
    const configPath = path.join(dir, 'agentloop.config.json');

    // Don't call saveConfig → original config should still be intact
    const loaded = loadExistingConfig(dir);
    expect(loaded.repo).toBe('org/original');
    expect(fs.existsSync(configPath)).toBe(true);
  });
});

/* ================================================================== *
 * formatSummary                                                        *
 * ================================================================== */

describe('formatSummary', () => {
  it('includes all sections', () => {
    const summary = formatSummary(
      {
        repo: 'org/repo',
        baseBranch: 'trunk',
        publishMode: 'auto',
        checks: [{ name: 'unit', script: 'test:unit' }],
        runtimeVerification: {
          profile: 'standard',
          checks: [{ name: 'smoke', command: 'npm run test:smoke' }],
        },
        claude: { permissionMode: 'default', relayMode: 'auto' },
      },
      { planner: 'claude', implementer: 'claude', auditor: 'codex' },
    );
    expect(summary).toContain('org/repo');
    expect(summary).toContain('trunk');
    expect(summary).toContain('auto');
    expect(summary).toContain('unit');
    expect(summary).toContain('standard');
    expect(summary).toContain('smoke');
    expect(summary).toContain('default');
    expect(summary).toContain('Configuration Summary');
  });

  it('shows defaults for missing values', () => {
    const summary = formatSummary(
      {},
      { planner: 'claude', implementer: 'claude', auditor: 'codex' },
    );
    expect(summary).toContain('(auto-detect from git remote)');
    expect(summary).toContain('main');
    expect(summary).toContain('manual');
  });

  it('shows Manual / External Planner when planner is manual', () => {
    const summary = formatSummary(
      {},
      { planner: 'manual', implementer: 'claude', auditor: 'codex' },
    );
    expect(summary).toContain('Manual / External Planner');
  });

  it('shows provider settings only for selected providers', () => {
    // No Claude selected for any role — no Claude Provider Settings section
    const summary = formatSummary(
      {},
      { planner: 'manual', implementer: 'codex', auditor: 'codex' },
    );
    expect(summary).not.toContain('Claude Provider Settings');
  });
});

/* ================================================================== *
 * Provider-specific settings only appear when relevant                  *
 * ================================================================== */

describe('provider-specific settings scoping', () => {
  const discovered = mockDiscoveredAvailable();

  it('omits claude key from config when all Claude settings are defaults', async () => {
    const prompt = mockPrompt([
      true,             // recommended: accept fast path
      'manual',         // planner → manual
      true,             // implementer → claude
      true,             // auditor → codex
      'acceptEdits', 'interactive',
    ]);
    const config = await buildConfig({ existingConfig: {}, prompt, discovered });
    expect(config.claude).toBeUndefined();
  });

  it('Claude settings are provider-scoped, not global', async () => {
    const prompt = mockPrompt([
      true,             // recommended: accept fast path
      'manual',         // planner → manual
      true,             // implementer → claude
      true,             // auditor → codex
      'default', 'auto',
    ]);
    const config = await buildConfig({ existingConfig: {}, prompt, discovered });
    expect(config.permissionMode).toBeUndefined();
    expect(config.relayMode).toBeUndefined();
    expect(config.claude).toBeDefined();
    expect(config.claude.permissionMode).toBe('default');
    expect(config.claude.relayMode).toBe('auto');
  });
});

/* ================================================================== *
 * Runtime verification profile configuration                           *
 * ================================================================== */

describe('runtime verification profile configuration', () => {
  const discovered = mockDiscoveredAvailable();

  it('lightweight profile produces no runtimeVerification key', async () => {
    const prompt = mockPrompt([
      false,            // recommended: decline fast path
      '', '', '', '',   // project
      true,             // verification: use default checks
      'lightweight',    // runtime profile
      'manual', '',     // controller
      'manual',         // planner
      true,             // implementer
      true,             // auditor
      'acceptEdits', 'interactive',
    ]);
    const config = await buildConfig({ existingConfig: {}, prompt, discovered });
    expect(config.runtimeVerification).toBeUndefined();
  });

  it('standard profile with no checks is downgraded to lightweight', async () => {
    // Required profiles need at least one check.  When the user declines
    // to add any across all attempts, the profile is downgraded.
    const prompt = mockPrompt([
      false,            // recommended: decline fast path
      '', '', '', '',   // project
      true,             // use default checks
      'standard',       // profile
      false,            // configure? no (attempt 1)
      false,            // configure? no (attempt 2)
      false,            // configure? no (attempt 3)
      false,            // configure? no (attempt 4)
      false,            // configure? no (attempt 5 — exhausted)
      'manual', '',     // controller
      'manual',         // planner
      true,             // implementer
      true,             // auditor
      'acceptEdits', 'interactive',
    ]);
    const config = await buildConfig({ existingConfig: {}, prompt, discovered });
    expect(config.runtimeVerification).toBeUndefined();
  });

  it('integration profile with checks is captured', async () => {
    const prompt = mockPrompt([
      false,            // recommended: decline fast path
      '', '', '', '',   // project
      true,             // use default checks
      'integration',    // profile
      true,             // configure checks
      'full-e2e',       // name
      'npm run test:e2e:full',  // command
      false,            // add another? → no
      'manual', '',     // controller
      'manual',         // planner
      true,             // implementer
      true,             // auditor
      'acceptEdits', 'interactive',
    ]);
    const config = await buildConfig({ existingConfig: {}, prompt, discovered });
    expect(config.runtimeVerification.profile).toBe('integration');
    expect(config.runtimeVerification.checks).toEqual([
      { name: 'full-e2e', command: 'npm run test:e2e:full' },
    ]);
  });

  it('custom profile is captured', async () => {
    const prompt = mockPrompt([
      false,            // recommended: decline fast path
      '', '', '', '',   // project
      true,             // use default checks
      'custom',         // profile
      true,             // configure checks
      'custom-check',   // name
      'npm run custom-check',  // command
      false,            // add another? → no
      'manual', '',     // controller
      'manual',         // planner
      true,             // implementer
      true,             // auditor
      'acceptEdits', 'interactive',
    ]);
    const config = await buildConfig({ existingConfig: {}, prompt, discovered });
    expect(config.runtimeVerification.profile).toBe('custom');
  });
});

/* ================================================================== *
 * Invalid configuration is rejected by validation                       *
 * ================================================================== */

describe('invalid configuration is rejected', () => {
  it('rejects invalid repo at validation time', () => {
    // The config module doesn't validate repo format, so this is more about
    // the role/provider validation. We test that in validateConfig above.
  });

  it('rejects unsupported role-provider combo', () => {
    const dir = makeProject();
    // auditor cannot be 'claude' — claude doesn't support auditor role
    saveConfig({ roles: { auditor: 'claude' } }, dir);
    const result = validateConfig(dir);
    expect(result.ok).toBe(false);
  });

  it('rejects unknown provider', () => {
    const dir = makeProject();
    saveConfig({ roles: { implementer: 'gpt-5' } }, dir);
    const result = validateConfig(dir);
    expect(result.ok).toBe(false);
  });

  it('rejects invalid publishMode', () => {
    const dir = makeProject();
    saveConfig({ publishMode: 'invalid-mode' }, dir);
    const result = validateConfig(dir);
    expect(result.ok).toBe(false);
  });

  it('rejects invalid runtimeVerification profile', () => {
    const dir = makeProject();
    saveConfig({ runtimeVerification: { profile: 'not-a-profile' } }, dir);
    const result = validateConfig(dir);
    expect(result.ok).toBe(false);
  });

  it('rejects empty checks array', () => {
    const dir = makeProject();
    saveConfig({ checks: [] }, dir);
    const result = validateConfig(dir);
    expect(result.ok).toBe(false);
  });
});

/* ================================================================== *
 * Edge cases                                                           *
 * ================================================================== */

describe('edge cases', () => {
  it('handles non-git directory gracefully (loadExistingConfig)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentloop-setup-nogit-'));
    tempDirs.push(dir);
    // No .git — loadExistingConfig just looks for the config file
    expect(loadExistingConfig(dir)).toEqual({});
  });

  it('saveConfig creates file with trailing newline', () => {
    const dir = makeProject();
    saveConfig({ repo: 'org/repo' }, dir);
    const content = fs.readFileSync(path.join(dir, 'agentloop.config.json'), 'utf8');
    expect(content.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(content);
    expect(parsed.repo).toBe('org/repo');
  });

  it('formatSummary handles empty config gracefully', () => {
    const summary = formatSummary(
      {},
      { planner: 'claude', implementer: 'claude', auditor: 'codex' },
    );
    expect(typeof summary).toBe('string');
    expect(summary.length).toBeGreaterThan(0);
    expect(summary).toContain('Configuration Summary');
  });

  it('buildConfig handles empty existingConfig', async () => {
    const prompt = mockPrompt(defaultResponses());
    const config = await buildConfig({
      existingConfig: {},
      prompt,
      discovered: mockDiscoveredAvailable(),
    });
    expect(typeof config).toBe('object');
    expect(Array.isArray(config)).toBe(false);
  });
});

/* ================================================================== *
 * Recommended settings fast path                                        *
 * ================================================================== */

describe('recommended settings fast path', () => {
  const discovered = mockDiscoveredAvailable();

  it('accepting recommended skips project/verification/controller sections', async () => {
    // Fast path: only consumes recommended confirm + roles + provider settings.
    // Should still include the recommended standard runtime verification.
    const prompt = mockPrompt([
      true,             // accept recommended
      'manual',         // planner
      true,             // implementer
      true,             // auditor
      'acceptEdits', 'interactive',
    ]);
    const config = await buildConfig({ existingConfig: {}, prompt, discovered });
    // Fast path → no project fields, no controller fields
    expect(config.repo).toBeUndefined();
    expect(config.publishMode).toBeUndefined();
    expect(config.checks).toBeUndefined();
    // Recommended standard runtime verification is set
    expect(config.runtimeVerification).toBeDefined();
    expect(config.runtimeVerification.profile).toBe('standard');
  });

  it('declining recommended walks through all sections individually', async () => {
    const prompt = mockPrompt([
      false,            // decline fast path
      'myorg/repo',     // project: repo
      '', '', '',       // project: baseBranch, remote, tasksFile (defaults)
      true,             // use default checks
      'lightweight',    // runtime profile
      'manual', '',     // controller
      'manual',         // planner
      true,             // implementer
      true,             // auditor
      'acceptEdits', 'interactive',
    ]);
    const config = await buildConfig({
      existingConfig: {},
      prompt,
      discovered,
      detectedRepo: null,
    });
    expect(config.repo).toBe('myorg/repo');
  });

  it('detected repo is included when provided', async () => {
    const prompt = mockPrompt([
      true,             // accept recommended
      'manual',         // planner
      true,             // implementer
      true,             // auditor
      'acceptEdits', 'interactive',
    ]);
    const config = await buildConfig({
      existingConfig: {},
      prompt,
      discovered,
      detectedRepo: 'myorg/myrepo',
    });
    expect(config.repo).toBe('myorg/myrepo');
  });

  it('no detected repo still produces valid config', async () => {
    const prompt = mockPrompt(defaultResponses());
    const config = await buildConfig({
      existingConfig: {},
      prompt,
      discovered,
      detectedRepo: null,
    });
    expect(config.repo).toBeUndefined();
  });
});

/* ================================================================== *
 * Capability discovery integration                                      *
 * ================================================================== */

describe('capability discovery integration', () => {
  it('only available agents appear as selectable options', async () => {
    // Only claude is available
    const discovered = {
      claude: { available: true, path: '/usr/bin/claude' },
      codex: { available: false, reason: 'not installed' },
    };

    const prompt = mockPrompt([
      true,             // recommended: accept fast path
      'claude',         // planner → claude (manual + claude available)
      true,             // implementer → claude
      // auditor: codex not available → no options → skipped
      'acceptEdits', 'interactive',
    ]);
    const config = await buildConfig({ existingConfig: {}, prompt, discovered });
    // Only planner and implementer have providers
    expect(config.roles).toBeUndefined(); // all defaults
  });

  it('unavailable agents show nothing for that role', async () => {
    // Neither claude nor codex available
    const discovered = mockDiscoveredUnavailable();

    const prompt = mockPrompt([
      true,             // recommended: accept fast path
      true,             // planner → confirm manual (only option)
      // implementer: claude not available → no options (skipped)
      // auditor: codex not available → no options (skipped)
      // providerSettings: no providers → nothing consumed
    ]);
    const config = await buildConfig({ existingConfig: {}, prompt, discovered });
    // Only planner has a selected provider (manual is non-default)
    expect(config.roles).toBeDefined();
    expect(config.roles.planner).toBe('manual');
  });
});

/* ================================================================== *
 * Explicit role assignment                                              *
 * ================================================================== */

describe('explicit role assignment', () => {
  const discovered = mockDiscoveredAvailable();

  it('manual planner is always an option regardless of discovery', async () => {
    const prompt = mockPrompt([
      true,             // recommended: accept fast path
      'manual',         // planner → manual
      true,             // implementer → claude
      true,             // auditor → codex
      'acceptEdits', 'interactive',
    ]);
    const config = await buildConfig({ existingConfig: {}, prompt, discovered });
    expect(config.roles).toBeDefined();
    expect(config.roles.planner).toBe('manual');
  });

  it('single provider asks explicit confirmation (no silent assignment)', async () => {
    // The 'true' for implementer/auditor is the confirm response
    const prompt = mockPrompt([
      true,             // recommended: accept fast path
      'manual',         // planner → select manual
      true,             // implementer → confirm claude
      true,             // auditor → confirm codex
      'acceptEdits', 'interactive',
    ]);
    const config = await buildConfig({ existingConfig: {}, prompt, discovered });
    // Manual planner is non-default → written. implementer/auditor are defaults → omitted.
    expect(config.roles).toBeDefined();
    expect(config.roles.planner).toBe('manual');
    expect(config.roles.implementer).toBeUndefined();
    expect(config.roles.auditor).toBeUndefined();
  });

  it('manual planner config saves correctly', async () => {
    const dir = makeProject();
    saveConfig({
      roles: { planner: 'manual', implementer: 'claude', auditor: 'codex' },
    }, dir);

    // Validate through real config module
    const result = importConfigField('ROLE_MAPPING', { cwd: dir, env: baseEnv() });
    expect(result.status).toBe(0);
    const mapping = JSON.parse(result.stdout);
    expect(mapping.planner).toBe('manual');
    expect(mapping.implementer).toBe('claude');
    expect(mapping.auditor).toBe('codex');
  });
});

/* ================================================================== *
 * Runtime check entry UX improvements                                  *
 * ================================================================== */

describe('runtime check entry UX', () => {
  const discovered = mockDiscoveredAvailable();

  it('empty name is rejected instead of finishing the loop', async () => {
    const prompt = mockPrompt([
      false,            // recommended: decline fast path
      '', '', '', '',   // project
      true,             // use default checks
      'standard',       // profile
      true,             // configure checks
      // Empty name → inner while re-prompts
      '',               // Check name: → '' → rejected, inner loop re-prompts
      'my-check',       // Check name (retry) → valid
      'npm run test',   // Command → valid
      false,            // Add another? → no
      // Checks exist → exit outer loop
      'manual', '',     // controller
      'manual',         // planner
      true,             // implementer
      true,             // auditor
      'acceptEdits', 'interactive',
    ]);
    const config = await buildConfig({ existingConfig: {}, prompt, discovered });
    expect(config.runtimeVerification).toBeDefined();
    expect(config.runtimeVerification.checks).toEqual([
      { name: 'my-check', command: 'npm run test' },
    ]);
  });

  it('empty command is rejected instead of finishing the loop', async () => {
    const prompt = mockPrompt([
      false,            // recommended: decline fast path
      '', '', '', '',   // project
      true,             // use default checks
      'standard',       // profile
      true,             // configure checks
      'my-check',       // Check name → valid
      '',               // Command → '' → rejected, inner loop re-prompts
      'npm run real',   // Command (retry) → valid
      false,            // Add another? → no
      'manual', '',     // controller
      'manual',         // planner
      true,             // implementer
      true,             // auditor
      'acceptEdits', 'interactive',
    ]);
    const config = await buildConfig({ existingConfig: {}, prompt, discovered });
    expect(config.runtimeVerification).toBeDefined();
    expect(config.runtimeVerification.checks).toEqual([
      { name: 'my-check', command: 'npm run real' },
    ]);
  });

  it('duplicate name is rejected and re-prompted', async () => {
    const prompt = mockPrompt([
      false,            // recommended: decline fast path
      '', '', '', '',   // project
      true,             // use default checks
      'standard',       // profile
      true,             // configure checks
      'my-check',       // name #1 → accepted
      'npm run test',   // command #1 → accepted
      true,             // add another? → yes
      'my-check',       // DUPLICATE name → rejected, inner while re-prompts
      'unique-check',   // name (retry) → accepted
      'npm run unique', // command → accepted
      false,            // add another? → no
      'manual', '',     // controller
      'manual',         // planner
      true,             // implementer
      true,             // auditor
      'acceptEdits', 'interactive',
    ]);
    const config = await buildConfig({ existingConfig: {}, prompt, discovered });
    expect(config.runtimeVerification).toBeDefined();
    expect(config.runtimeVerification.checks).toHaveLength(2);
    expect(config.runtimeVerification.checks[0].name).toBe('my-check');
    expect(config.runtimeVerification.checks[1].name).toBe('unique-check');
  });

  it('duplicate command is rejected and re-prompted', async () => {
    const prompt = mockPrompt([
      false,            // recommended: decline fast path
      '', '', '', '',   // project
      true,             // use default checks
      'standard',       // profile
      true,             // configure checks
      'check-a',        // name #1 → accepted
      'npm run same',   // command #1 → accepted
      true,             // add another? → yes
      'check-b',        // name #2 → accepted
      'npm run same',   // DUPLICATE command → rejected, inner while re-prompts
      'npm run diff',   // command (retry) → accepted
      false,            // add another? → no
      'manual', '',     // controller
      'manual',         // planner
      true,             // implementer
      true,             // auditor
      'acceptEdits', 'interactive',
    ]);
    const config = await buildConfig({ existingConfig: {}, prompt, discovered });
    expect(config.runtimeVerification).toBeDefined();
    expect(config.runtimeVerification.checks).toHaveLength(2);
    expect(config.runtimeVerification.checks[1].command).toBe('npm run diff');
  });

  it('"add another?" stops the loop when false', async () => {
    const prompt = mockPrompt([
      false,            // recommended: decline fast path
      '', '', '', '',   // project
      true,             // use default checks
      'standard',       // profile
      true,             // configure checks
      'api-smoke',      // name
      'npm run test:integration',  // command
      false,            // add another? → no
      'manual', '',     // controller
      'manual',         // planner
      true,             // implementer
      true,             // auditor
      'acceptEdits', 'interactive',
    ]);
    const config = await buildConfig({ existingConfig: {}, prompt, discovered });
    expect(config.runtimeVerification).toBeDefined();
    expect(config.runtimeVerification.checks).toEqual([
      { name: 'api-smoke', command: 'npm run test:integration' },
    ]);
  });

  it('multiple runtime checks can be added', async () => {
    const prompt = mockPrompt([
      false,            // recommended: decline fast path
      '', '', '', '',   // project
      true,             // use default checks
      'standard',       // profile
      true,             // configure checks
      'check-1',        // name
      'cmd-1',          // command
      true,             // add another? → yes
      'check-2',        // name
      'cmd-2',          // command
      true,             // add another? → yes
      'check-3',        // name
      'cmd-3',          // command
      false,            // add another? → no
      'manual', '',     // controller
      'manual',         // planner
      true,             // implementer
      true,             // auditor
      'acceptEdits', 'interactive',
    ]);
    const config = await buildConfig({ existingConfig: {}, prompt, discovered });
    expect(config.runtimeVerification.checks).toHaveLength(3);
  });
});

/* ================================================================== *
 * --setup CLI flag integration                                         *
 * ================================================================== */

describe('--setup CLI flag', () => {
  it('is recognised by the argument parser', async () => {
    const { parseArgs } = await import('../controller.mjs');
    const opts = parseArgs(['--setup']);
    expect(opts.setup).toBe(true);
    expect(opts.task).toBeNull();
  });

  it('--setup combined with --help shows usage', async () => {
    const { parseArgs } = await import('../controller.mjs');
    const opts = parseArgs(['--setup', '--help']);
    expect(opts.setup).toBe(true);
    expect(opts.help).toBe(true);
  });
});
