/**
 * ALCLI interactive project setup / configuration.
 *
 * Walks through project identification, agent roles, verification, and
 * controller defaults in a clean terminal prompt.  Every section has sensible
 * defaults — press Enter to accept them.  Provider-specific settings (e.g.
 * Claude permission mode) only appear when the provider is assigned to at
 * least one role.
 *
 * The module is split into two layers so both the terminal UX and the
 * configuration model are independently testable:
 *
 *   buildConfig(existingConfig, prompt) → new config object (no I/O)
 *   runSetup()                          → full terminal flow (writes to disk)
 *
 * Reconfiguration reuses the same code path: when an existing
 * `agentloop.config.json` is present its values become the defaults.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { LOGICAL_ROLES, MANUAL_EXTERNAL } from './roles.mjs';
import { discoverAgents } from './discovery.mjs';
import { parseGithubOwnerRepo } from './git-url.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_MODULE_URL = pathToFileURL(path.join(HERE, 'config.mjs')).href;

/**
 * Find the nearest ancestor directory that contains a `.git` directory.
 * Falls back to `startDir` itself — same logic as config.mjs's
 * `findProjectRoot`, duplicated so setup.mjs can resolve the project
 * root without importing the config module (which has load-time side effects).
 *
 * @param {string} startDir
 * @returns {string}
 */
function findProjectRoot(startDir) {
  let dir = path.resolve(startDir);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(startDir);
    dir = parent;
  }
}

/**
 * Detect the repository owner/name from a git remote.
 *
 * Returns `owner/repo` when the remote URL resolves to a GitHub repository,
 * or `null` when detection fails (no remote, non-GitHub URL, etc.).
 *
 * @param {string} projectRoot
 * @param {string} remote — git remote name (e.g. "origin")
 * @returns {string|null}
 */
function detectRepo(projectRoot, remote) {
  const result = spawnSync('git', ['remote', 'get-url', remote], {
    cwd: projectRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 5_000,
  });
  if (result.status !== 0) return null;
  return parseGithubOwnerRepo(result.stdout.trim());
}

/* ------------------------------------------------------------------ *
 * Constants                                                            *
 * ------------------------------------------------------------------ */

const CONFIG_FILE_NAME = 'agentloop.config.json';

const PUBLISH_MODES = Object.freeze(['manual', 'auto']);
const CLAUDE_PERMISSION_MODES = Object.freeze([
  'default',
  'acceptEdits',
  'bypassPermissions',
  'plan',
]);
const CLAUDE_RELAY_MODES = Object.freeze(['interactive', 'auto']);

const RV_PROFILE_CHOICES = Object.freeze([
  { value: 'lightweight', label: 'Lightweight — runtime verification is NOT required (static checks only)' },
  { value: 'standard', label: 'Standard — basic smoke / integration checks required (recommended)' },
  { value: 'integration', label: 'Integration — full integration suite required' },
  { value: 'custom', label: 'Custom — project-defined verification commands' },
]);

const DEFAULT_CHECKS = Object.freeze([
  { name: 'typecheck', script: 'typecheck' },
  { name: 'lint', script: 'lint' },
  { name: 'test', script: 'test' },
  { name: 'build', script: 'build' },
]);

/** Provider defaults — used to omit default values from saved config. */
const PROVIDER_DEFAULTS = Object.freeze({
  claude: Object.freeze({ permissionMode: 'acceptEdits', relayMode: 'interactive' }),
});

/** Human-readable display names for agents. */
const AGENT_DISPLAY = Object.freeze({
  claude: 'Claude',
  codex: 'Codex',
});

/**
 * Claude agent-specific settings handler.
 *
 * Registered in AGENT_SETTINGS and only invoked when Claude is selected
 * for at least one role.
 */
async function claudeSettingsHandler(existing, prompt) {
  const existingClaude = (existing.claude && typeof existing.claude === 'object')
    ? existing.claude
    : {};

  const currentPerm = CLAUDE_PERMISSION_MODES.includes(existingClaude.permissionMode)
    ? existingClaude.permissionMode
    : 'acceptEdits';
  const permissionMode = await prompt.select(
    'Claude permission mode (--permission-mode flag):',
    [
      { value: 'default', label: 'default — prompt for each tool use' },
      { value: 'acceptEdits', label: 'acceptEdits — auto-approve file edits (recommended)' },
      { value: 'bypassPermissions', label: 'bypassPermissions — skip all permission prompts (not recommended)' },
      { value: 'plan', label: 'plan — read-only mode, no edits' },
    ],
    currentPerm,
  );
  prompt.display('');

  const currentRelay = CLAUDE_RELAY_MODES.includes(existingClaude.relayMode)
    ? existingClaude.relayMode
    : 'interactive';
  const relayMode = await prompt.select(
    'ALCLI relay mode (permission requests outside the allowlist):',
    [
      { value: 'interactive', label: 'Interactive — relay to terminal for user approval (safe default)' },
      { value: 'auto', label: 'Auto — auto-approve after hard-deny checks (unattended operation)' },
    ],
    currentRelay,
  );

  return {
    claude: {
      ...(permissionMode !== 'acceptEdits' ? { permissionMode } : {}),
      ...(relayMode !== 'interactive' ? { relayMode } : {}),
    },
  };
}

/**
 * Provider-specific settings registry.
 *
 * Maps provider names to their settings sections.  Adding a new provider
 * with configurable settings means adding an entry here and supplying the
 * settings handler.  Only providers selected for at least one role receive
 * their settings section during setup.
 */
const AGENT_SETTINGS = Object.freeze({
  claude: {
    label: 'Claude Agent Settings',
    handler: claudeSettingsHandler,
  },
  // codex has no agent-specific settings currently.
});

/* ------------------------------------------------------------------ *
 * Prompt interface                                                     *
 * ------------------------------------------------------------------ */

/**
 * Terminal implementation of the prompt interface.  Uses `readline` for
 * interactive input.  Instantiated once per `runSetup()` call.
 */
class TerminalPrompt {
  #rl;

  constructor() {
    this.#rl = null;
  }

  _rl() {
    if (!this.#rl) {
      this.#rl = createInterface({ input: process.stdin, output: process.stdout });
    }
    return this.#rl;
  }

  close() {
    if (this.#rl) {
      this.#rl.close();
      this.#rl = null;
    }
  }

  async question(text) {
    const rl = this._rl();
    return new Promise((resolve) => rl.question(text, resolve));
  }

  display(text) {
    process.stdout.write(`${text}\n`);
  }

  section(title) {
    this.display(`\n${'─'.repeat(60)}`);
    this.display(`  ${title}`);
    this.display(`${'─'.repeat(60)}`);
  }

  async confirm(text, defaultValue = true) {
    const hint = defaultValue ? '[Y/n]' : '[y/N]';
    let answer = await this.question(`  ${text} ${hint} `);
    answer = answer.trim().toLowerCase();
    if (answer === '') return defaultValue;
    return answer === 'y' || answer === 'yes';
  }

  async select(text, options, defaultValue) {
    this.display(`  ${text}`);
    let defaultIdx = -1;
    for (let i = 0; i < options.length; i += 1) {
      const marker = options[i].value === defaultValue ? ' ★' : '  ';
      if (options[i].value === defaultValue) defaultIdx = i;
      this.display(`    ${i + 1}. ${options[i].label}${marker}`);
    }
    const hint = defaultIdx >= 0 ? ` [${defaultIdx + 1}]` : '';
    const raw = await this.question(`  Choose 1-${options.length}${hint}: `);
    const trimmed = raw.trim();
    if (trimmed === '' && defaultIdx >= 0) return defaultValue;
    const idx = Number(trimmed) - 1;
    if (Number.isInteger(idx) && idx >= 0 && idx < options.length) {
      return options[idx].value;
    }
    this.display(`  Invalid choice. Using default: ${defaultValue}`);
    return defaultValue;
  }
}

/* ------------------------------------------------------------------ *
 * Validation helpers                                                   *
 * ------------------------------------------------------------------ */

const CHECK_TOKEN = /^[A-Za-z0-9][A-Za-z0-9:_-]*$/;
const COMMAND_TOKEN = /^[A-Za-z0-9][A-Za-z0-9:_\-\s./]*$/;

function isValidCheckName(name) {
  return CHECK_TOKEN.test(name);
}

function isValidCheckScript(script) {
  return CHECK_TOKEN.test(script);
}

function isValidRvCommand(command) {
  return COMMAND_TOKEN.test(command);
}

/**
 * Validate a complete config object by loading it through the real config
 * module in a subprocess.  Returns { ok: true } or { ok: false, errors: [...] }.
 *
 * We write the candidate config to the target path first so the subprocess
 * reads the exact file we intend to save.  The original file (if any) is
 * restored afterwards when `restoreOriginal` is provided.
 */
function validateAgainstConfigModule(configPath, { env } = {}) {
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import(${JSON.stringify(CONFIG_MODULE_URL)}).then(() => process.exit(0), (e) => { process.stderr.write(e.message); process.exit(1); });`,
    ],
    {
      cwd: path.dirname(configPath),
      env: env ?? process.env,
      encoding: 'utf8',
      timeout: 15_000,
    },
  );

  if (result.status === 0) return { ok: true };
  return {
    ok: false,
    errors: (result.stderr || 'Unknown validation error')
      .split(/\r?\n/)
      .filter(Boolean),
  };
}

/* ------------------------------------------------------------------ *
 * Section handlers                                                     *
 * ------------------------------------------------------------------ */

/**
 * Section 0 — Existing configuration detected.
 *
 * When an agentloop.config.json already exists, ask the user how they want
 * to proceed before showing any detailed questions.
 *
 * @param {object} existing — current config values (may be {})
 * @param {object} prompt — prompt interface
 * @returns {Promise<object>} { action: 'recommended' | 'review' | 'cancel' }
 */
async function sectionExistingConfig(existing, prompt) {
  prompt.section('Existing Setup Found');

  prompt.display('  ALCLI is already configured for this project.');
  prompt.display('');
  prompt.display('  What would you like to do?');
  prompt.display('');

  const action = await prompt.select(
    '',
    [
      { value: 'recommended', label: 'Use recommended project settings' },
      { value: 'review', label: 'Review or change current settings' },
      { value: 'cancel', label: 'Cancel' },
    ],
    'recommended',
  );

  if (action === 'review') {
    prompt.display('');
    prompt.display('  Your current settings are shown as defaults.');
    prompt.display('  Press Enter to keep a setting unchanged.');
  }

  return { action };
}

/**
 * Section 1 — Project settings mode.
 *
 * Silently detects the repository (no diagnostic output) and offers a clean
 * two-choice menu.  Returns the same shape as before so the rest of the flow
 * does not need to change.
 *
 * @param {object} existing — current config values (may be {})
 * @param {object} prompt — prompt interface
 * @param {string|null} detectedRepo — pre-detected repository, or null
 * @returns {Promise<object>} { fastPath: boolean, detectedRepo: string|null }
 */
async function sectionRecommended(existing, prompt, detectedRepo) {
  prompt.section('Project Settings');

  prompt.display('  How would you like to configure this project?');
  prompt.display('');

  const choice = await prompt.select(
    '',
    [
      { value: 'recommended', label: 'Use recommended project settings' },
      { value: 'custom', label: 'Customize every setting' },
    ],
    'recommended',
  );

  return {
    fastPath: choice === 'recommended',
    detectedRepo,
  };
}

/**
 * Section 2 — Agent discovery.
 *
 * Discovers which agents are actually usable on this machine and displays
 * the results so the user can see what is available before making role
 * assignments.
 *
 * @param {object} prompt — prompt interface
 * @returns {Promise<Record<string, {available: boolean, reason?: string, path?: string}>>}
 */
async function sectionDiscovery(prompt) {
  prompt.section('Available Agents');
  prompt.display('');

  const discovered = discoverAgents();

  for (const [agent, result] of Object.entries(discovered)) {
    const label = AGENT_DISPLAY[agent] || agent;
    if (result.available) {
      prompt.display(`  ✓ ${label}`);
    } else {
      prompt.display(`  ✗ ${label} — ${result.reason || 'not installed/configured'}`);
    }
  }

  prompt.display('');
  return discovered;
}

/**
 * Section 1 — Project identification.
 *
 * @param {object} existing — current config values (may be {})
 * @param {object} prompt — prompt interface
 * @returns {Promise<object>} config fragment
 */
async function sectionProject(existing, prompt, detectedRepo = undefined) {
  prompt.section('Project');

  // Resolve the repo default.  When detectedRepo is explicitly provided
  // (even as null, meaning "no repo detected"), use it directly.  When it
  // is undefined (not passed at all), auto-detect from the git remote.
  const resolvedDefault = detectedRepo !== undefined
    ? (detectedRepo || existing.repo || undefined)
    : (existing.repo || detectRepo(findProjectRoot(process.cwd()), existing.remote || 'origin') || undefined);

  const repoDisplay = resolvedDefault
    ? `${resolvedDefault}`
    : '(auto-detect from git remote)';

  const repo = await prompt.question(
    `  Repository (owner/repo) [${repoDisplay}]: `,
  );
  const baseBranch = await prompt.question(
    `  Base branch [${existing.baseBranch || 'main'}]: `,
  );
  const remote = await prompt.question(
    `  Git remote [${existing.remote || 'origin'}]: `,
  );
  const tasksFile = await prompt.question(
    `  Task-file path (relative to repo root) [${existing.tasksFile || 'agentloop.tasks.json'}]: `,
  );

  const resolvedRepo = repo.trim() || resolvedDefault || undefined;

  return {
    ...(resolvedRepo ? { repo: resolvedRepo } : {}),
    ...(baseBranch.trim() ? { baseBranch: baseBranch.trim() } : (existing.baseBranch ? { baseBranch: existing.baseBranch } : {})),
    ...(remote.trim() ? { remote: remote.trim() } : (existing.remote ? { remote: existing.remote } : {})),
    ...(tasksFile.trim() ? { tasksFile: tasksFile.trim() } : (existing.tasksFile ? { tasksFile: existing.tasksFile } : {})),
  };
}

/**
 * Section 3 — Agent roles.
 *
 * Every logical role (planner, implementer, auditor) is assigned to an agent
 * or to Manual / External.  The user chooses from all agents that are both
 * capable of the role AND currently available on this machine.
 *
 * Manual / External is always available for every role — it means the work
 * is done outside ALCLI by a human or external tool.
 *
 * @param {object} existing — current config values
 * @param {object} prompt — prompt interface
 * @param {object} discovered — results from discoverAgents()
 * @returns {Promise<object>} config fragment with `roles`
 */
async function sectionRoles(existing, prompt, discovered) {
  prompt.section('Agent Roles');

  const existingRoles = existing.roles || {};
  const roles = {};

  const ROLE_DESCRIPTIONS = {
    planner: 'Plans the work before implementation begins.',
    implementer: 'Carries out the task and makes the required changes.',
    auditor: 'Reviews the completed work and reports any problems.',
  };

  for (const role of LOGICAL_ROLES) {
    const opts = [];

    // Manual / External is always available for every role.
    opts.push({
      value: MANUAL_EXTERNAL,
      label: 'Manual / External',
    });

    // Add every discovered agent that is available on this machine.
    // All known agents support every role at the configuration level.
    for (const [agent, result] of Object.entries(discovered)) {
      if (result.available === true) {
        const display = AGENT_DISPLAY[agent] || agent;
        opts.push({ value: agent, label: display });
      }
    }

    prompt.display(`  ${role.charAt(0).toUpperCase() + role.slice(1)}`);
    prompt.display(`  ${ROLE_DESCRIPTIONS[role]}`);
    prompt.display('');

    // Default to Manual / External for safety, or to the existing
    // choice if it is still available.
    const currentValue =
      (typeof existingRoles[role] === 'string' && existingRoles[role].trim()) || null;
    const matched = opts.find((o) => o.value === currentValue);
    const defaultValue = matched ? matched.value : MANUAL_EXTERNAL;

    roles[role] = await prompt.select('', opts, defaultValue);
    prompt.display('');
  }

  return { roles };
}

/**
 * Section 3 — Verification.
 *
 * Deterministic checks (compile, lint, test, build) and runtime verification
 * profile selection.  Uses plain-language descriptions first, technical
 * details second.
 *
 * @param {object} existing — current config values
 * @param {object} prompt — prompt interface
 * @returns {Promise<object>} config fragment
 */
async function sectionVerification(existing, prompt) {
  prompt.section('Automatic Project Checks');

  prompt.display('  Before ALCLI sends work for audit, it can verify that:');
  prompt.display('');
  prompt.display('    ✓ The code compiles correctly');
  prompt.display('    ✓ Code-quality checks pass');
  prompt.display('    ✓ Automated tests pass');
  prompt.display('    ✓ The production build succeeds');
  prompt.display('');

  // --- Deterministic checks ---
  const existingChecks = existing.checks || [];
  const hasCustomChecks = existingChecks.length > 0;

  prompt.display('  Advanced: typecheck, lint, test, build');
  prompt.display('');
  if (hasCustomChecks) {
    prompt.display(`    Currently configured: ${existingChecks.map((c) => `${c.name}=${c.script}`).join(', ')}`);
  }

  const useDefaults = await prompt.confirm('Use these recommended checks?', !hasCustomChecks);

  let checks;
  if (useDefaults) {
    checks = DEFAULT_CHECKS.map((c) => ({ ...c }));
  } else {
    checks = [];
    prompt.display('  Enter checks one at a time.');
    let idx = 1;
    while (true) {
      const name = await prompt.question(`    Check #${idx} name: `);
      if (!name.trim()) break;
      if (!isValidCheckName(name.trim())) {
        prompt.display(`    Invalid name — must match ${CHECK_TOKEN}. Skipping.`);
        continue;
      }
      const script = await prompt.question(`    Check #${idx} script: `);
      if (!script.trim()) break;
      if (!isValidCheckScript(script.trim())) {
        prompt.display(`    Invalid script — must match ${CHECK_TOKEN}. Skipping.`);
        continue;
      }
      checks.push({ name: name.trim(), script: script.trim() });
      idx += 1;
    }
    if (checks.length === 0) {
      prompt.display('  No checks entered — using defaults.');
      checks = DEFAULT_CHECKS.map((c) => ({ ...c }));
    }
  }

  // --- Runtime verification ---
  const existingRv = existing.runtimeVerification || {};
  prompt.display('');
  prompt.display('  Runtime Checks');
  prompt.display('');
  prompt.display('  ALCLI can run the project and verify that it actually works,');
  prompt.display('  not just that the code passes automated checks.');
  prompt.display('');
  prompt.display('  How thoroughly should ALCLI check the running project?');
  prompt.display('');

  const currentProfile = existingRv.profile || 'standard';
  const profile = await prompt.select(
    'Select the runtime verification level:',
    RV_PROFILE_CHOICES,
    currentProfile,
  );
  prompt.display('');

  let rvChecks = [];
  if (profile !== 'lightweight') {
    const existingRvChecks = existingRv.checks || [];
    const hasRvChecks = existingRvChecks.length > 0;
    const usedNames = new Set();
    const usedCommands = new Set();

    // Required profiles need at least one check so the runtime gate is
    // not silently bypassed.  Loop until the user provides at least one,
    // up to a safety limit.
    const MAX_RV_ATTEMPTS = 5;
    let firstPass = true;
    let attempts = 0;
    while (rvChecks.length === 0 && attempts < MAX_RV_ATTEMPTS) {
      attempts += 1;
      if (!firstPass) {
        prompt.display('');
        prompt.display('    A runtime check is required for this profile.');
        prompt.display('    Without any checks, every task requiring runtime verification will fail.');
      }
      firstPass = false;

      if (hasRvChecks) {
        prompt.display(`    Existing checks: ${existingRvChecks.map((c) => c.name).join(', ')}`);
      }
      const configureRv = await prompt.confirm(
        'Configure runtime verification commands?',
        !hasRvChecks || rvChecks.length === 0,
      );
      if (!configureRv && hasRvChecks && rvChecks.length === 0) {
        // Carry forward existing checks rather than leaving the list empty.
        rvChecks = existingRvChecks.map((c) => ({ ...c }));
        break;
      }
      if (!configureRv) {
        // No existing checks and user declined to add any — keep looping.
        continue;
      }

      prompt.display('    Enter runtime checks one at a time.');
      prompt.display('    Example: name=api-smoke, command=npm run test:integration');
      prompt.display('');

      do {
        // --- Name ---
        let enteredName;
        while (true) {
          enteredName = await prompt.question('      Check name: ');
          if (!enteredName.trim()) {
            prompt.display('      Name is required.');
            continue;
          }
          if (!isValidCheckName(enteredName.trim())) {
            prompt.display(`      Invalid name — must match ${CHECK_TOKEN}.`);
            continue;
          }
          if (usedNames.has(enteredName.trim())) {
            prompt.display(`      A check named "${enteredName.trim()}" already exists.`);
            continue;
          }
          break;
        }
        enteredName = enteredName.trim();

        // --- Command ---
        let enteredCommand;
        while (true) {
          enteredCommand = await prompt.question('      Command (e.g. "npm run test:integration"): ');
          if (!enteredCommand.trim()) {
            prompt.display('      Command is required.');
            continue;
          }
          if (!isValidRvCommand(enteredCommand.trim())) {
            prompt.display(`      Invalid command — must match ${COMMAND_TOKEN}.`);
            continue;
          }
          if (usedCommands.has(enteredCommand.trim())) {
            prompt.display(`      Command "${enteredCommand.trim()}" is already used by another check.`);
            continue;
          }
          break;
        }
        enteredCommand = enteredCommand.trim();

        // Record
        rvChecks.push({ name: enteredName, command: enteredCommand });
        usedNames.add(enteredName);
        usedCommands.add(enteredCommand);
        prompt.display(`      ✓ Added: ${enteredName} → ${enteredCommand}`);
      } while (await prompt.confirm('  Add another runtime check?', false));
    }

    if (rvChecks.length === 0) {
      // User declined to add checks — downgrade to lightweight so the
      // config does not silently create a required gate with no checks.
      prompt.display('');
      prompt.display('    No runtime checks configured — the profile will be set to lightweight.');
      prompt.display('    Run `agentloop --setup` again to add checks and upgrade the profile.');
    }
  }

  // If a required profile was selected but no checks were configured,
  // downgrade to lightweight so the config is never saved in a state
  // where required verification would always fail.
  const effectiveProfile = (profile !== 'lightweight' && rvChecks.length === 0)
    ? 'lightweight'
    : profile;

  const result = {};
  if (!useDefaults || hasCustomChecks) {
    result.checks = checks;
  }
  if (effectiveProfile !== 'lightweight' || rvChecks.length > 0 || existingRv.profile) {
    result.runtimeVerification = {
      ...(effectiveProfile !== 'lightweight' ? { profile: effectiveProfile } : {}),
      ...(rvChecks.length > 0 ? { checks: rvChecks } : {}),
    };
  }

  return result;
}

/**
 * Section 4 — Controller defaults.
 *
 * Publish behaviour and correction/retry limits.
 *
 * @param {object} existing — current config values
 * @param {object} prompt — prompt interface
 * @returns {Promise<object>} config fragment
 */
async function sectionController(existing, prompt) {
  prompt.section('Controller Defaults');

  // Publish mode
  const currentPublish = PUBLISH_MODES.includes(existing.publishMode)
    ? existing.publishMode
    : 'manual';
  const publishMode = await prompt.select(
    'Publishing behaviour for approved commits:',
    [
      {
        value: 'manual',
        label: 'Manual — controller stops before pushing; you inspect and push',
      },
      {
        value: 'auto',
        label: 'Auto — controller pushes immediately after Codex approval',
      },
    ],
    currentPublish,
  );

  // Max change rounds
  const currentRounds =
    Number.isInteger(existing.maxChangeRounds) && existing.maxChangeRounds > 0
      ? String(existing.maxChangeRounds)
      : '2';
  const roundsRaw = await prompt.question(
    `  Max correction/retry rounds per task [${currentRounds}]: `,
  );
  const maxChangeRounds = roundsRaw.trim()
    ? Number(roundsRaw.trim())
    : Number(currentRounds);

  const result = {};
  if (publishMode !== 'manual') result.publishMode = publishMode;
  if (maxChangeRounds !== 2) result.maxChangeRounds = maxChangeRounds;

  return result;
}

/**
 * Section 5 — Agent-specific settings.
 *
 * Only shown for agents that are assigned to at least one role in the
 * current mapping.  The registry (AGENT_SETTINGS) determines which
 * agents have configurable settings and how to collect them.
 *
 * @param {object} existing — current config values
 * @param {object} roles — the resolved role mapping ({ planner, implementer, auditor })
 * @param {object} prompt — prompt interface
 * @returns {Promise<object>} config fragment
 */
async function sectionProviderSettings(existing, prompt, roles) {
  const usedAgents = new Set(Object.values(roles));
  // Remove manual — it is not a real agent with settings.
  usedAgents.delete(MANUAL_EXTERNAL);

  const result = {};

  for (const [agent, { label, handler }] of Object.entries(AGENT_SETTINGS)) {
    if (usedAgents.has(agent)) {
      prompt.section(label);
      const settings = await handler(existing, prompt);
      if (settings && typeof settings === 'object') {
        Object.assign(result, settings);
      }
    }
  }

  return result;
}

/* ------------------------------------------------------------------ *
 * Config assembly & persistence                                        *
 * ------------------------------------------------------------------ */

/**
 * Strip provider settings that match defaults so the saved config is
 * minimal.  Each provider declares its defaults in PROVIDER_DEFAULTS.
 *
 * @param {string} provider
 * @param {object} settings
 * @returns {object} settings with default-valued keys removed
 */
function normaliseProviderSettings(provider, settings) {
  const defaults = PROVIDER_DEFAULTS[provider] || {};
  const result = {};
  for (const [key, value] of Object.entries(settings)) {
    if (value !== undefined && value !== defaults[key]) {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Build a complete `agentloop.config.json` object from the collected
 * section fragments.  Only writes keys that differ from defaults.
 *
 * @param {object} fragments — collected section results
 * @returns {object} config object suitable for JSON serialization
 */
export function assembleConfig(fragments) {
  const {
    project = {},
    roles = {},
    verification = {},
    controller = {},
    providerSettings = {},
  } = fragments;

  const config = {};

  // Project
  if (project.repo) config.repo = project.repo;
  if (project.baseBranch) config.baseBranch = project.baseBranch;
  if (project.remote) config.remote = project.remote;
  if (project.tasksFile) config.tasksFile = project.tasksFile;

  // Roles — always write when explicitly configured by the user.
  // Every role gets an explicit choice during setup; write them all so
  // the config reflects the user's actual selections.
  if (Object.keys(roles).length > 0) {
    config.roles = {};
    for (const role of LOGICAL_ROLES) {
      if (roles[role]) {
        config.roles[role] = roles[role];
      }
    }
  }

  // Deterministic checks
  if (verification.checks && verification.checks.length > 0) {
    config.checks = verification.checks.map((c) => ({ name: c.name, script: c.script }));
  }

  // Runtime verification
  if (verification.runtimeVerification) {
    const rv = {};
    if (verification.runtimeVerification.profile) {
      rv.profile = verification.runtimeVerification.profile;
    }
    if (verification.runtimeVerification.checks && verification.runtimeVerification.checks.length > 0) {
      rv.checks = verification.runtimeVerification.checks.map((c) => ({
        name: c.name,
        command: c.command,
      }));
    }
    if (Object.keys(rv).length > 0) config.runtimeVerification = rv;
  }

  // Controller — only write values that differ from defaults.
  if (controller.publishMode && controller.publishMode !== 'manual') {
    config.publishMode = controller.publishMode;
  }
  if (Number.isInteger(controller.maxChangeRounds) && controller.maxChangeRounds !== 2) {
    config.maxChangeRounds = controller.maxChangeRounds;
  }

  // Provider settings — only write non-default values for any provider.
  for (const [provider, settings] of Object.entries(providerSettings)) {
    if (settings && typeof settings === 'object') {
      const normalised = normaliseProviderSettings(provider, settings);
      if (Object.keys(normalised).length > 0) {
        config[provider] = normalised;
      }
    }
  }

  return config;
}

/**
 * Write config to `agentloop.config.json` at the project root.
 *
 * Does NOT validate — call `validateConfig` first.
 *
 * @param {object} config — the config object to write
 * @param {string} projectRoot — absolute path to the project root
 */
export function saveConfig(config, projectRoot, filePath = null) {
  const file = filePath || path.join(projectRoot, CONFIG_FILE_NAME);
  const json = JSON.stringify(config, null, 2) + '\n';
  fs.writeFileSync(file, json, 'utf8');
}

/**
 * Validate a config file by importing the real config module in a subprocess.
 *
 * @param {string} projectRoot — absolute path to the project root
 * @param {object} [options]
 * @param {object} [options.env] — environment variables for the subprocess
 * @returns {{ ok: boolean, errors?: string[] }}
 */
export function validateConfig(projectRoot, { configPath, env } = {}) {
  const target = configPath || path.join(projectRoot, CONFIG_FILE_NAME);
  return validateAgainstConfigModule(target, { env });
}

/**
 * Load the existing project config (if any) from `agentloop.config.json`.
 *
 * Returns an empty object when no config file exists.  Does NOT delegate to
 * the config module — it reads the raw JSON so we can present values as
 * defaults during reconfiguration.
 *
 * @param {string} projectRoot — absolute path to the project root
 * @returns {object}
 */
export function loadExistingConfig(projectRoot) {
  const file = path.join(projectRoot, CONFIG_FILE_NAME);
  if (!fs.existsSync(file)) return {};

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // Corrupt config — treat as empty; the validation step will catch it.
    return {};
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {};
  }
  return parsed;
}

/* ------------------------------------------------------------------ *
 * Summary formatting                                                   *
 * ------------------------------------------------------------------ */

/**
 * Return a human-readable summary of the config that will be saved.
 *
 * @param {object} config — the assembled config object
 * @param {object} roles — the resolved role mapping
 * @returns {string}
 */
export function formatSummary(config, roles) {
  const lines = [];

  lines.push('');
  lines.push('═══════════════════════════════════════════════════════════');
  lines.push('  Configuration Summary');
  lines.push('═══════════════════════════════════════════════════════════');

  // Project
  lines.push('');
  lines.push('  Project');
  lines.push(`    Repository:    ${config.repo || '(auto-detect from git remote)'}`);
  lines.push(`    Base branch:   ${config.baseBranch || 'main'}`);
  lines.push(`    Remote:        ${config.remote || 'origin'}`);
  lines.push(`    Task file:     ${config.tasksFile || 'agentloop.tasks.json'}`);

  // Roles
  lines.push('');
  lines.push('  Agent Roles');
  for (const role of LOGICAL_ROLES) {
    const provider = roles[role] || 'claude';
    if (provider === MANUAL_EXTERNAL) {
      lines.push(`    ${role.charAt(0).toUpperCase() + role.slice(1)}: Manual / External`);
    } else {
      const display = AGENT_DISPLAY[provider] || provider;
      lines.push(`    ${role.charAt(0).toUpperCase() + role.slice(1)}: ${display}`);
    }
  }

  // Verification
  lines.push('');
  lines.push('  Verification');
  const checks = config.checks || DEFAULT_CHECKS.map((c) => ({ name: c.name, script: c.script }));
  lines.push(`    Checks:   ${checks.map((c) => c.name).join(', ')}`);
  if (config.runtimeVerification) {
    lines.push(`    Profile:  ${config.runtimeVerification.profile || 'lightweight'}`);
    if (config.runtimeVerification.checks && config.runtimeVerification.checks.length > 0) {
      for (const c of config.runtimeVerification.checks) {
        lines.push(`              ${c.name}: ${c.command}`);
      }
    } else {
      lines.push('              (no checks configured)');
    }
  } else {
    lines.push('    Profile:  lightweight (runtime verification not required)');
  }

  // Controller
  lines.push('');
  lines.push('  Controller');
  lines.push(`    Publish mode:       ${config.publishMode || 'manual'}`);
  lines.push(`    Max change rounds:  ${config.maxChangeRounds ?? 2}`);

  // Agent settings — only for agents actually selected.
  const usedProviders = new Set(Object.values(roles));
  usedProviders.delete(MANUAL_EXTERNAL);

  for (const provider of usedProviders) {
    const providerConfig = config[provider] || {};
    lines.push('');
    const display = AGENT_DISPLAY[provider]
      ? `${AGENT_DISPLAY[provider]} Agent Settings`
      : `${provider} Agent Settings`;
    lines.push(`  ${display}`);

    // Show saved values
    for (const [key, value] of Object.entries(providerConfig)) {
      lines.push(`    ${key}: ${value}`);
    }

    // Show defaults for known settings keys not present in config
    const defaults = PROVIDER_DEFAULTS[provider] || {};
    for (const [key, defaultValue] of Object.entries(defaults)) {
      if (!(key in providerConfig)) {
        lines.push(`    ${key}: ${defaultValue} (default)`);
      }
    }
  }

  lines.push('');
  lines.push('═══════════════════════════════════════════════════════════');

  return lines.join('\n');
}

/* ------------------------------------------------------------------ *
 * Main entry point                                                     *
 * ------------------------------------------------------------------ */

/**
 * Run the full interactive setup flow against the terminal.
 *
 * 1. Detect existing configuration — show choice menu if found
 * 2. Project settings mode
 * 3. Agent discovery, role assignment, agent settings
 * 4. Show summary and confirm
 * 5. Write `agentloop.config.json` (with validation)
 *
 * @param {object} [options]
 * @param {string} [options.projectRoot] — project root directory (default: cwd)
 * @param {object} [options.prompt] — prompt interface (default: TerminalPrompt)
 * @returns {Promise<{ saved: boolean, config: object|null, reason: string }>}
 */
export async function runSetup({
  projectRoot = findProjectRoot(process.cwd()),
  prompt: injectedPrompt = null,
} = {}) {
  const prompt = injectedPrompt || new TerminalPrompt();
  const configPath = path.join(projectRoot, CONFIG_FILE_NAME);
  const tmpPath = path.join(projectRoot, `${CONFIG_FILE_NAME}.tmp`);

  try {
    // Load existing config for display defaults.
    const existing = loadExistingConfig(projectRoot);
    const oldFileExists = fs.existsSync(configPath);

    // Step 1: If a config already exists, ask how to proceed.
    if (oldFileExists) {
      const { action } = await sectionExistingConfig(existing, prompt);
      if (action === 'cancel') {
        prompt.display('');
        prompt.display('  Setup cancelled — existing configuration was not changed.');
        return { saved: false, config: null, reason: 'User cancelled at existing-config prompt.' };
      }
      if (action === 'recommended') {
        // Apply recommended defaults for project/verification/controller.
        // Agent role selection still runs — the user must choose.
        // Deliberately pass empty config so prior selections do NOT leak as defaults.
        const detectedRepo = detectRepo(projectRoot, existing.remote || 'origin');
        const project = { ...(detectedRepo ? { repo: detectedRepo } : {}) };
        const verification = {};
        const controller = {};

        const discovered = await sectionDiscovery(prompt);
        const { roles } = await sectionRoles({}, prompt, discovered);
        const providerSettings = await sectionProviderSettings({}, prompt, roles);

        const config = assembleConfig({ project, roles, verification, controller, providerSettings });
        prompt.display(formatSummary(config, roles));

        const confirmed = await prompt.confirm('Save this configuration?', true);
        if (!confirmed) {
          return { saved: false, config, reason: 'User chose not to save.' };
        }

        return commitConfig({ config, projectRoot, configPath, tmpPath, oldFileExists, prompt });
      }
      // action === 'review' — fall through to full flow with existing defaults.
      prompt.display('');
      prompt.display('  Your current settings are shown as defaults.');
      prompt.display('  Press Enter to keep a setting unchanged.');
    }

    // Step 2: Project settings — recommended or customize?
    // Silently detect the repo; no diagnostic output for the user.
    const detectedRepo = detectRepo(projectRoot, existing.remote || 'origin');
    const recommended = await sectionRecommended(existing, prompt, detectedRepo);

    let project, verification, controller;

    if (recommended.fastPath) {
      project = { ...(detectedRepo ? { repo: detectedRepo } : {}) };
      verification = {};
      controller = {};
      prompt.display('  ✓ Using recommended project settings.');
    } else {
      project = await sectionProject(existing, prompt, detectedRepo);
      verification = await sectionVerification(existing, prompt);
      controller = await sectionController(existing, prompt);
    }

    // Step 3: Agent discovery (always runs).
    const discovered = await sectionDiscovery(prompt);

    // Step 4: Agent roles (always runs — explicit choice for every role).
    const { roles } = await sectionRoles(existing, prompt, discovered);

    // Step 5: Agent-specific settings (only for selected agents).
    const providerSettings = await sectionProviderSettings(existing, prompt, roles);

    // Assemble
    const config = assembleConfig({
      project,
      roles,
      verification,
      controller,
      providerSettings,
    });

    // Summary
    prompt.display(formatSummary(config, roles));

    const confirmed = await prompt.confirm('Save this configuration?', true);
    if (!confirmed) {
      return { saved: false, config, reason: 'User chose not to save.' };
    }

    return commitConfig({ config, projectRoot, configPath, tmpPath, oldFileExists, prompt });
  } finally {
    if (!injectedPrompt) {
      prompt.close();
    }
  }
}

/**
 * Crash-safe config write with validate-then-commit semantics.
 *
 * 1. Snapshot the old canonical file (copy, not move).
 * 2. Write the candidate to a temp file and atomically rename.
 * 3. Validate the canonical file through the real config module.
 * 4. On failure: restore from backup. On success: promote backup → .bak.
 *
 * @param {object} options
 * @returns {{ saved: boolean, config: object, reason: string }}
 */
function commitConfig({ config, projectRoot, configPath, tmpPath, oldFileExists, prompt }) {
  // Phase 1: snapshot the existing config (copy, not move).
  //
  // Use .pre-update as the snapshot target, but if a file already
  // exists at that path (retained from a previous interrupted run),
  // rotate it to a timestamped name first.
  let snapshotPath = path.join(projectRoot, `${CONFIG_FILE_NAME}.pre-update`);
  if (fs.existsSync(snapshotPath)) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const baseStamped = path.join(projectRoot, `${CONFIG_FILE_NAME}.pre-update.${ts}`);

    let stampedPath = baseStamped;
    if (fs.existsSync(stampedPath)) {
      for (let i = 1; i < 100; i += 1) {
        stampedPath = path.join(projectRoot, `${CONFIG_FILE_NAME}.pre-update.${ts}-${i}`);
        if (!fs.existsSync(stampedPath)) break;
      }
    }
    if (fs.existsSync(stampedPath)) {
      prompt.display('');
      prompt.display('  ✖  Cannot create a unique recovery file name.');
      prompt.display('  Too many recovery files exist — clean up old .pre-update.* files and try again.');
      return { saved: false, config, reason: 'Cannot create unique recovery file name.' };
    }

    try {
      fs.renameSync(snapshotPath, stampedPath);
      prompt.display(`  Rotated previous recovery file to ${path.basename(stampedPath)}`);
    } catch {
      snapshotPath = baseStamped;
      if (fs.existsSync(snapshotPath)) {
        for (let i = 1; i < 100; i += 1) {
          snapshotPath = path.join(projectRoot, `${CONFIG_FILE_NAME}.pre-update.${ts}-${i}`);
          if (!fs.existsSync(snapshotPath)) break;
        }
      }
      if (fs.existsSync(snapshotPath)) {
        prompt.display('');
        prompt.display('  ✖  Cannot create a unique snapshot file name.');
        prompt.display('  Too many recovery files exist — clean up old .pre-update.* files and try again.');
        return { saved: false, config, reason: 'Cannot create unique snapshot file name.' };
      }
      prompt.display('  Warning: could not rotate the existing .pre-update recovery file.');
      prompt.display(`  Using ${path.basename(snapshotPath)} for this run instead.`);
      prompt.display('  The existing .pre-update was not modified.');
    }
  }

  let hadOldFile = false;
  if (oldFileExists) {
    try {
      fs.copyFileSync(configPath, snapshotPath);
      hadOldFile = true;
    } catch {
      prompt.display('');
      prompt.display('  ✖  Could not create a backup of the existing configuration.');
      prompt.display('  The existing config was not modified.');
      return {
        saved: false,
        config,
        reason: 'Could not snapshot the existing config — nothing was changed.',
      };
    }
  }

  // Phase 2: atomically write the candidate.
  saveConfig(config, projectRoot, tmpPath);
  try {
    fs.renameSync(tmpPath, configPath);
  } catch {
    try { fs.unlinkSync(tmpPath); } catch { /* best-effort */ }
    prompt.display('');
    prompt.display('  ✖  Could not write the configuration file.');
    if (hadOldFile) {
      try { fs.unlinkSync(snapshotPath); } catch { /* best-effort */ }
    }
    return { saved: false, config, reason: 'File write failed — nothing was changed.' };
  }

  // Phase 3: validate the newly written canonical file.
  const validation = validateConfig(projectRoot);
  if (!validation.ok) {
    if (hadOldFile) {
      let restored = false;
      try {
        fs.copyFileSync(snapshotPath, tmpPath);
        fs.renameSync(tmpPath, configPath);
        restored = true;
      } catch {
        try { fs.unlinkSync(tmpPath); } catch { /* best-effort */ }
      }

      if (restored) {
        try { fs.unlinkSync(snapshotPath); } catch { /* best-effort */ }
      } else {
        prompt.display('');
        prompt.display('  ✖  Validation failed and the previous config could not be restored.');
        prompt.display(`  The previous config is at ${CONFIG_FILE_NAME}.pre-update`);
        prompt.display('  Rename it back to agentloop.config.json to recover.');
        return {
          saved: false,
          config,
          reason: 'Validation failed and restore also failed — manual recovery required.',
        };
      }
    } else {
      try { fs.unlinkSync(configPath); } catch { /* best-effort */ }
    }

    prompt.display('');
    prompt.display('  ✖  Configuration validation failed — nothing was saved.');
    prompt.display('  Errors:');
    for (const err of validation.errors || []) {
      prompt.display(`    ${err}`);
    }
    return {
      saved: false,
      config,
      reason: 'Configuration validation failed — see errors above.',
    };
  }

  // Phase 4: validation passed.  Promote the pre-update backup → .bak.
  if (hadOldFile) {
    const bakPath = path.join(projectRoot, `${CONFIG_FILE_NAME}.bak`);

    if (fs.existsSync(bakPath)) {
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const stampedPath = path.join(projectRoot, `${CONFIG_FILE_NAME}.bak.${ts}`);
      try {
        fs.renameSync(bakPath, stampedPath);
        prompt.display(`  Moved previous backup to ${path.basename(stampedPath)}`);
      } catch {
        prompt.display('  Warning: could not rotate the existing .bak file.');
        prompt.display(`  The previous config is preserved at ${CONFIG_FILE_NAME}.pre-update`);
        prompt.display('  You can remove it once you have a safe copy of the .bak file.');
        return { saved: true, config, reason: 'Configuration saved but backup rotation failed — see warning above.' };
      }
    }

    try {
      fs.renameSync(snapshotPath, bakPath);
      prompt.display(`  Backed up previous config to ${CONFIG_FILE_NAME}.bak`);
    } catch {
      prompt.display('  Warning: could not back up the previous config.');
      prompt.display(`  The previous config is preserved at ${CONFIG_FILE_NAME}.pre-update`);
      prompt.display('  Rename it to agentloop.config.json.bak to keep it as a backup,');
      prompt.display('  or delete it once you are satisfied with the new configuration.');
    }
  }

  prompt.display('');
  prompt.display('  Configuration saved and validated successfully.');
  prompt.display(`  File: ${configPath}`);
  prompt.display('  Run `agentloop --setup` anytime to reconfigure.');

  return { saved: true, config, reason: 'Configuration saved and validated.' };
}

/**
 * Build config programmatically (no terminal interaction).
 *
 * Each section handler is called with the given prompt interface so tests can
 * supply canned responses.  Returns the assembled config without writing to disk.
 *
 * Follows the same sequence as `runSetup`: recommended fast path → discovery →
 * roles → provider settings.  Tests can inject pre-computed discovery results
 * and a detected repo to avoid I/O.
 *
 * @param {object} options
 * @param {object} [options.existingConfig] — current config values (default: {})
 * @param {object} options.prompt — prompt interface (must supply all methods)
 * @param {object|null} [options.discovered] — pre-computed discovery results (default: run discoverAgents)
 * @param {string|null} [options.detectedRepo] — pre-detected repository (default: null)
 * @returns {Promise<object>} the assembled config
 */
export async function buildConfig({
  existingConfig = {},
  prompt,
  discovered = null,
  detectedRepo = null,
}) {
  const d = discovered ?? discoverAgents();

  // Section 0: Recommended settings
  const recommended = await sectionRecommended(existingConfig, prompt, detectedRepo);

  let project, verification, controller;

  if (recommended.fastPath) {
    project = {
      ...(recommended.detectedRepo ? { repo: recommended.detectedRepo } : {}),
    };
    // Fast path does not enable runtime verification — a required
    // profile needs user-provided checks which the fast path skips.
    verification = {};
    controller = {};
  } else {
    project = await sectionProject(existingConfig, prompt, detectedRepo);
    verification = await sectionVerification(existingConfig, prompt);
    controller = await sectionController(existingConfig, prompt);
  }

  // Agent Roles (always — with discovery results)
  const { roles } = await sectionRoles(existingConfig, prompt, d);

  // Provider-specific settings (always — for selected providers)
  const providerSettings = await sectionProviderSettings(existingConfig, prompt, roles);

  return assembleConfig({
    project,
    roles,
    verification,
    controller,
    providerSettings,
  });
}
