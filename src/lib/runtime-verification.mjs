/**
 * Runtime & Integration Verification Gate.
 *
 * Where the existing deterministic checks (typecheck, lint, test, build) are
 * static — they run against the source tree without executing the application —
 * this module adds a project-configurable runtime gate that can require the
 * application to actually start and pass integration-level acceptance checks
 * before an audit or publication may proceed.
 *
 * The controller orchestrates project-supplied commands; it does not embed
 * browser automation or any one testing tool.  Projects supply `npm run <script>`
 * entries (or raw shell commands) for Playwright, Cypress, curl-based API
 * checks, or whatever tooling they already use.
 *
 * ## Profiles
 *
 *   lightweight — runtime verification is NOT_REQUIRED (static checks suffice)
 *   standard    — runtime verification IS required; basic smoke / integration
 *   integration — runtime verification IS required; full integration suite
 *   custom      — runtime verification IS required; project-defined commands
 *
 * ## Configuration
 *
 * Project-level (agentloop.config.json):
 *
 *   "runtimeVerification": {
 *     "profile": "standard",
 *     "checks": [
 *       { "name": "api-smoke", "command": "npm run test:integration" }
 *     ]
 *   }
 *
 * Task-level (agentloop.tasks.json) may inherit, disable, or escalate:
 *
 *   "runtimeVerification": {
 *     "profile": "integration",
 *     "checks": [
 *       { "name": "e2e-critical", "command": "npm run test:e2e:critical" }
 *     ]
 *   }
 *
 * A task `profile` of "inherit" (or absent) uses the project baseline.
 * "disabled" means NOT_REQUIRED regardless of the project setting.
 * An explicit profile overrides the project baseline.
 * Task-level `checks`, when present, replace the project-level checks for that
 * task so stricter verification is self-contained rather than additive.
 */

import { REPO_ROOT } from './config.mjs';
import { npmGlobalDirs, resolveExecutable, run } from './process.mjs';

/* ------------------------------------------------------------------ *
 * Profile definitions                                                  *
 * ------------------------------------------------------------------ */

/**
 * Each profile answers one question: is runtime verification required?
 *
 * The `required` flag is what the controller and the decision engine read.
 * `label` is for reporting only.
 */
export const PROFILES = Object.freeze({
  lightweight: Object.freeze({ required: false, label: 'Lightweight' }),
  standard: Object.freeze({ required: true, label: 'Standard' }),
  integration: Object.freeze({ required: true, label: 'Integration' }),
  custom: Object.freeze({ required: true, label: 'Custom' }),
});

const VALID_PROFILES = Object.freeze([...Object.keys(PROFILES), 'inherit', 'disabled']);

/** Sentinel meaning "use whatever the project has configured." */
export const INHERIT = 'inherit';

/** Sentinel meaning "runtime verification is explicitly not required." */
export const DISABLED = 'disabled';

/* ------------------------------------------------------------------ *
 * Token shape for check entries                                        *
 * ------------------------------------------------------------------ */

const CHECK_TOKEN = /^[A-Za-z0-9][A-Za-z0-9:_-]*$/;
const COMMAND_TOKEN = /^[A-Za-z0-9][A-Za-z0-9:_\-\s./]*$/;

/* ------------------------------------------------------------------ *
 * Configuration validation & resolution                                *
 * ------------------------------------------------------------------ */

/**
 * Validate a single runtime-verification config object.
 *
 * @param {object} cfg — raw value from config file
 * @param {string} source — human-readable label for error messages
 * @returns {{ profile: string, checks: { name: string, command: string }[] }}
 */
function validateConfig(cfg, source) {
  const errors = [];

  if (cfg === null || typeof cfg !== 'object' || Array.isArray(cfg)) {
    throw new Error(`${source}: "runtimeVerification" must be an object.`);
  }

  let profile = cfg.profile;
  if (profile !== undefined) {
    if (typeof profile !== 'string' || !VALID_PROFILES.includes(profile)) {
      throw new Error(
        `${source}: runtimeVerification.profile must be one of: ${VALID_PROFILES.join(', ')}. ` +
          `Got: ${JSON.stringify(profile)}.`,
      );
    }
  } else {
    profile = INHERIT;
  }

  const checks = [];
  if (cfg.checks !== undefined) {
    if (!Array.isArray(cfg.checks)) {
      throw new Error(
        `${source}: runtimeVerification.checks must be an array of { name, command } objects.`,
      );
    }
    for (let i = 0; i < cfg.checks.length; i += 1) {
      const entry = cfg.checks[i];
      if (!entry || typeof entry.name !== 'string' || typeof entry.command !== 'string') {
        throw new Error(
          `${source}: runtimeVerification.checks[${i}] must have string "name" and "command" fields.`,
        );
      }
      if (!CHECK_TOKEN.test(entry.name)) {
        throw new Error(
          `${source}: runtimeVerification.checks[${i}].name must match ${CHECK_TOKEN} — no ` +
            'spaces, quotes, commas, or other punctuation.',
        );
      }
      if (!COMMAND_TOKEN.test(entry.command)) {
        throw new Error(
          `${source}: runtimeVerification.checks[${i}].command must match ${COMMAND_TOKEN}.`,
        );
      }
      checks.push(Object.freeze({ name: entry.name, command: entry.command }));
    }
  }

  return { profile, checks: Object.freeze(checks) };
}

/**
 * Validate the project-level runtime-verification config.
 *
 * @param {object|undefined} value — PROJECT_CONFIG.runtimeVerification
 * @returns {{ profile: string, checks: { name: string, command: string }[] } | null}
 */
export function normaliseProjectRuntimeVerification(value) {
  if (value === undefined || value === null) return null;

  const cfg = validateConfig(value, 'agentloop.config.json');

  // "inherit" / "disabled" are only meaningful at the task level. A project
  // config that explicitly sets one of those means "no runtime verification".
  if (cfg.profile === INHERIT || cfg.profile === DISABLED) return null;

  return Object.freeze({
    profile: cfg.profile,
    checks: cfg.checks,
  });
}

/**
 * Validate task-level runtime-verification config.
 *
 * @param {object|undefined} value — raw task.runtimeVerification
 * @param {string} taskId — for error messages
 * @returns {{ profile: string, checks: { name: string, command: string }[] } | null}
 */
export function normaliseTaskRuntimeVerification(value, taskId) {
  if (value === undefined || value === null) return null;

  const cfg = validateConfig(value, `tasks[${JSON.stringify(taskId)}].runtimeVerification`);
  return Object.freeze({
    profile: cfg.profile,
    checks: cfg.checks,
  });
}

/**
 * Profile strictness ordering: a task may only select a profile at the same
 * or higher strictness level as the project baseline.
 *
 *   lightweight (0) < standard (1) < integration (2) < custom (3)
 */
const PROFILE_ORDER = Object.freeze({
  lightweight: 0,
  standard: 1,
  integration: 2,
  custom: 3,
});

/**
 * The project baseline profile, when set, establishes a floor that tasks may
 * only escalate — never weaken.  "disabled" and "lightweight" are not
 * permitted as task profiles when the project baseline requires runtime
 * verification.
 */
const PROJECT_REQUIRED_PROFILES = new Set(['standard', 'integration', 'custom']);

/**
 * Resolve the effective runtime-verification configuration for one task.
 *
 * Merge rules:
 *  1. No project config and no task config → null (NOT_REQUIRED).
 *  2. Project baseline is required (standard/integration/custom):
 *     a. Task `"disabled"` is rejected — a task cannot opt out of a
 *        required project baseline.
 *     b. Task `"lightweight"` is rejected — cannot weaken a required
 *        baseline.
 *     c. Task `"inherit"` (or absent) → project config as-is.
 *     d. Task checks APPEND to project checks — the baseline is a floor,
 *        never replaced.
 *  3. Project baseline is lightweight or absent:
 *     a. Task `"disabled"` → null (NOT_REQUIRED).
 *     b. Task `"inherit"` (or absent) → project config as-is (may be null).
 *     c. Task explicit profile → use it; task checks replace when present.
 *  4. A task with no runtimeVerification in a project that also has none → null.
 *
 * @param {{
 *   project: { profile: string, checks: { name: string, command: string }[] } | null,
 *   task: { profile: string, checks: { name: string, command: string }[] } | null,
 * }} input
 * @returns {{ profile: string, checks: { name: string, command: string }[] } | null}
 */
export function resolveRuntimeVerification({ project, task }) {
  // No config at either level → NOT_REQUIRED.
  if (!project && !task) return null;

  const projectRequired =
    project !== null && PROJECT_REQUIRED_PROFILES.has(project.profile);

  if (projectRequired) {
    // Project baseline requires runtime verification — tasks may only
    // escalate, never weaken.

    if (task && task.profile === DISABLED) {
      throw new Error(
        'Task runtimeVerification.profile cannot be "disabled" when the project ' +
          `baseline requires runtime verification (profile: ${project.profile}). ` +
          'A required project baseline is a floor — tasks may only escalate it.',
      );
    }

    if (task && task.profile === 'lightweight') {
      throw new Error(
        'Task runtimeVerification.profile cannot be "lightweight" when the project ' +
          `baseline requires runtime verification (profile: ${project.profile}). ` +
          'Tasks may only maintain or escalate the project baseline.',
      );
    }

    // Task inherits or is absent → project as-is.
    if (!task || task.profile === INHERIT) return { ...project };

    // Task sets an explicit profile → must be same or higher strictness.
    const taskOrder = PROFILE_ORDER[task.profile];
    const projectOrder = PROFILE_ORDER[project.profile];
    if (taskOrder === undefined) {
      throw new Error(
        `Task runtimeVerification.profile ${JSON.stringify(task.profile)} is not a valid profile. ` +
          `Valid profiles: ${Object.keys(PROFILE_ORDER).join(', ')}.`,
      );
    }
    if (taskOrder < projectOrder) {
      throw new Error(
        `Task runtimeVerification.profile ${JSON.stringify(task.profile)} (level ${taskOrder}) ` +
          `cannot weaken the project baseline ${JSON.stringify(project.profile)} (level ${projectOrder}). ` +
          'Tasks may only maintain or escalate the project baseline. ' +
          `Valid profiles at or above the baseline: ` +
          Object.entries(PROFILE_ORDER)
            .filter(([, o]) => o >= projectOrder)
            .map(([p]) => p)
            .join(', ') + '.',
      );
    }

    // Task checks APPEND to project checks — the baseline is a floor.
    const checks = [...project.checks, ...task.checks];
    return Object.freeze({ profile: task.profile, checks: Object.freeze(checks) });
  }

  // Project baseline is lightweight or absent — tasks have full flexibility.

  // Task explicitly disabled.
  if (task && task.profile === DISABLED) return null;

  // Task inherits or is absent → project as-is (may be null).
  if (!task || task.profile === INHERIT) return project ? { ...project } : null;

  // Task sets an explicit profile → use it, with task checks replacing project
  // checks when present.
  const profile = task.profile;
  const checks = task.checks.length > 0 ? task.checks : (project ? project.checks : []);
  return Object.freeze({ profile, checks });
}

/**
 * Is runtime verification required for this resolved config?
 *
 * @param {{ profile: string, checks: { name: string, command: string }[] } | null} resolved
 * @returns {boolean}
 */
export function isRuntimeVerificationRequired(resolved) {
  if (!resolved) return false;
  const def = PROFILES[resolved.profile];
  if (!def) return false;
  return def.required;
}

/* ------------------------------------------------------------------ *
 * Runner                                                               *
 * ------------------------------------------------------------------ */

let npmPath = null;

function npm() {
  npmPath ??= resolveExecutable('npm', {
    override: process.env.AGENTLOOP_NPM_BIN,
    extraDirs: npmGlobalDirs(),
  });
  return npmPath;
}

/**
 * Run one runtime check command.
 *
 * Supports `npm run <script>` commands (run through the resolved npm binary)
 * and raw shell commands.  A command that starts with `npm run ` is executed
 * via the npm binary to avoid shell-injection through the script name; all
 * other commands are passed to the system shell.
 *
 * @param {string} command — e.g. "npm run test:integration" or "curl -sf http://localhost:3000"
 * @param {number} timeoutMs
 * @returns {Promise<{ ok: boolean, code: number|null, timedOut: boolean, output: string }>}
 */
async function runCheckCommand(command, timeoutMs) {
  const npmRunPrefix = 'npm run ';

  if (command.startsWith(npmRunPrefix)) {
    const script = command.slice(npmRunPrefix.length).trim();
    if (script.length === 0) {
      return { ok: false, code: null, timedOut: false, output: 'Empty npm script name.' };
    }
    const outcome = await run(npm(), ['run', script], {
      cwd: REPO_ROOT,
      timeoutMs,
    });
    return {
      ok: outcome.code === 0 && !outcome.timedOut,
      code: outcome.code,
      timedOut: Boolean(outcome.timedOut),
      output: `${outcome.stdout ?? ''}${outcome.stderr ?? ''}`,
    };
  }

  // Raw shell command — pass to the platform shell.
  const shell = process.platform === 'win32' ? 'cmd' : '/bin/sh';
  const shellFlag = process.platform === 'win32' ? '/c' : '-c';
  const outcome = await run(shell, [shellFlag, command], {
    cwd: REPO_ROOT,
    timeoutMs,
  });
  return {
    ok: outcome.code === 0 && !outcome.timedOut,
    code: outcome.code,
    timedOut: Boolean(outcome.timedOut),
    output: `${outcome.stdout ?? ''}${outcome.stderr ?? ''}`,
  };
}

/**
 * Run the configured runtime verification checks in order, stopping at the
 * first failure.
 *
 * @param {{
 *   checks?: { name: string, command: string }[],
 *   runner?: (command: string, timeoutMs: number) => Promise<{ ok: boolean, output?: string }>,
 *   timeoutMs?: number,
 *   onStart?: (name: string) => void,
 * }} [options]
 * @returns {Promise<{ ok: boolean, results: object[], failed: object|null }>}
 */
export async function runRuntimeChecks({
  checks = [],
  runner = runCheckCommand,
  timeoutMs = 120_000,
  onStart,
} = {}) {
  const results = [];

  for (const check of checks) {
    onStart?.(check.name);
    const started = Date.now();
    const outcome = await runner(check.command, timeoutMs);
    const result = {
      name: check.name,
      command: check.command,
      ok: Boolean(outcome.ok),
      durationMs: Date.now() - started,
      output: outcome.output ?? '',
    };
    results.push(result);
    if (!result.ok) return { ok: false, results, failed: result };
  }

  return { ok: true, results, failed: null };
}

/**
 * One line per check, for the console and the local report.
 *
 * @param {object[]} results
 * @returns {string}
 */
export function summariseRuntimeChecks(results = []) {
  return results
    .map((result) => `${result.ok ? 'PASS' : 'FAIL'}  ${result.name} (${result.command})`)
    .join('\n');
}

/**
 * The tail of a failing check's output.
 *
 * @param {object} result
 * @param {number} [lines=40]
 * @returns {string}
 */
export function runtimeFailureExcerpt(result, lines = 40) {
  if (!result?.output) return '(no output captured)';
  return result.output.split(/\r?\n/).slice(-lines).join('\n').trim();
}
