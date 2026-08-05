/**
 * Deterministic verification, run before Codex sees anything.
 *
 * The configured checks (typecheck, lint, test, build by default) run in
 * order against the committed local HEAD. They are cheap relative to an audit
 * and they are not a matter of opinion, so a failure here should never
 * consume a review round: the loop stops and reports instead of asking Codex
 * to notice what `tsc` already knows.
 *
 * This module is the only place these checks run. The controller calls it
 * directly from `runAuditStep`, independently of anything Claude did —
 * Claude has no Bash access to `npm run <script>` at all (see
 * `CLAUDE_DEFAULT_ALLOWED` in config.mjs), so this is the sole authority on
 * whether verification passed.
 *
 * The runner is injected so the ordering, the short-circuit, and the summary
 * are testable without spawning anything.
 */

import { DETERMINISTIC_CHECKS, LIMITS, REPO_ROOT } from './config.mjs';
import { npmGlobalDirs, resolveExecutable, run } from './process.mjs';

let npmPath = null;

function npm() {
  npmPath ??= resolveExecutable('npm', {
    override: process.env.AGENTLOOP_NPM_BIN,
    extraDirs: npmGlobalDirs(),
  });
  return npmPath;
}

/** Run one `npm run <script>` in the project. */
async function runNpmScript(script) {
  const outcome = await run(npm(), ['run', script], {
    cwd: REPO_ROOT,
    timeoutMs: LIMITS.checkTimeoutMs,
  });
  return {
    ok: outcome.code === 0 && !outcome.timedOut,
    code: outcome.code,
    timedOut: Boolean(outcome.timedOut),
    output: `${outcome.stdout ?? ''}${outcome.stderr ?? ''}`,
  };
}

/**
 * Run the deterministic checks in order, stopping at the first failure.
 *
 * Stopping early is deliberate: once the typecheck fails the remaining
 * commands are usually failing for the same reason, and the first failure is
 * the one worth reporting.
 *
 * @param {{
 *   checks?: typeof DETERMINISTIC_CHECKS,
 *   runner?: (script: string) => Promise<{ ok: boolean, output?: string }>,
 *   onStart?: (name: string) => void,
 * }} [options]
 * @returns {Promise<{ ok: boolean, results: object[], failed: object|null }>}
 */
export async function runChecks({
  checks = DETERMINISTIC_CHECKS,
  runner = runNpmScript,
  onStart,
} = {}) {
  const results = [];

  for (const check of checks) {
    onStart?.(check.name);
    const started = Date.now();
    const outcome = await runner(check.script);
    const result = {
      name: check.name,
      script: check.script,
      ok: Boolean(outcome.ok),
      durationMs: Date.now() - started,
      output: outcome.output ?? '',
    };
    results.push(result);
    if (!result.ok) return { ok: false, results, failed: result };
  }

  return { ok: true, results, failed: null };
}

/** One line per check, for the console and the local report. */
export function summariseChecks(results = []) {
  return results
    .map((result) => `${result.ok ? 'PASS' : 'FAIL'}  ${result.name} (npm run ${result.script})`)
    .join('\n');
}

/**
 * The tail of a failing check's output.
 *
 * The interesting part of a `tsc` or `vitest` failure is at the end, and the
 * whole buffer can be megabytes.
 */
export function failureExcerpt(result, lines = 40) {
  if (!result?.output) return '(no output captured)';
  return result.output.split(/\r?\n/).slice(-lines).join('\n').trim();
}
