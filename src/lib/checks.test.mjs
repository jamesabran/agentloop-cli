// @vitest-environment node
/**
 * Deterministic checks run before Codex does.
 *
 * The point is that an audit round is never spent on something `tsc` or
 * `vitest` already knows: the checks run in a fixed order against the
 * committed HEAD, and the first failure stops the sequence and the loop.
 */
import { describe, expect, it } from 'vitest';

import { DETERMINISTIC_CHECKS } from './config.mjs';
import { failureExcerpt, runChecks, summariseChecks } from './checks.mjs';

/** A runner that records what it was asked to run and fails on named scripts. */
function fakeRunner(failing = new Set()) {
  const ran = [];
  const runner = async (script) => {
    ran.push(script);
    return failing.has(script)
      ? { ok: false, output: `${script} failed\nline two\nline three` }
      : { ok: true, output: `${script} ok` };
  };
  runner.ran = ran;
  return runner;
}

describe('the configured checks', () => {
  it('are typecheck, lint, test, and build, in that order', () => {
    expect(DETERMINISTIC_CHECKS.map((check) => check.name)).toEqual([
      'typecheck',
      'lint',
      'test',
      'build',
    ]);
  });

  it('each map to an npm script', () => {
    for (const check of DETERMINISTIC_CHECKS) {
      expect(typeof check.script).toBe('string');
      expect(check.script.length).toBeGreaterThan(0);
    }
  });
});

describe('runChecks', () => {
  it('runs every check in order when they all pass', async () => {
    const runner = fakeRunner();
    const outcome = await runChecks({ runner });

    expect(outcome.ok).toBe(true);
    expect(outcome.failed).toBeNull();
    expect(runner.ran).toEqual(['typecheck', 'lint', 'test', 'build']);
    expect(outcome.results).toHaveLength(4);
  });

  it('stops at the first failure rather than running the rest', async () => {
    const runner = fakeRunner(new Set(['lint']));
    const outcome = await runChecks({ runner });

    expect(outcome.ok).toBe(false);
    expect(outcome.failed.name).toBe('lint');
    expect(runner.ran).toEqual(['typecheck', 'lint']);
    expect(outcome.results).toHaveLength(2);
  });

  it('reports a failing build even when everything before it passed', async () => {
    const runner = fakeRunner(new Set(['build']));
    const outcome = await runChecks({ runner });

    expect(outcome.ok).toBe(false);
    expect(outcome.failed.name).toBe('build');
    expect(runner.ran).toEqual(['typecheck', 'lint', 'test', 'build']);
  });

  it('reports progress as each check starts', async () => {
    const started = [];
    await runChecks({ runner: fakeRunner(), onStart: (name) => started.push(name) });
    expect(started).toEqual(['typecheck', 'lint', 'test', 'build']);
  });

  it('accepts a narrower list of checks', async () => {
    const runner = fakeRunner();
    const outcome = await runChecks({ runner, checks: [{ name: 'test', script: 'test' }] });
    expect(outcome.ok).toBe(true);
    expect(runner.ran).toEqual(['test']);
  });
});

describe('reporting', () => {
  it('summarises one line per check', async () => {
    const outcome = await runChecks({ runner: fakeRunner(new Set(['test'])) });
    const summary = summariseChecks(outcome.results);
    expect(summary).toMatch(/PASS {2}typecheck/);
    expect(summary).toMatch(/FAIL {2}test/);
  });

  it('excerpts the tail of a failing check, where the error is', async () => {
    const outcome = await runChecks({ runner: fakeRunner(new Set(['typecheck'])) });
    expect(failureExcerpt(outcome.failed, 2)).toBe('line two\nline three');
  });

  it('says so when nothing was captured', () => {
    expect(failureExcerpt(null)).toMatch(/no output/);
    expect(failureExcerpt({ output: '' })).toMatch(/no output/);
  });
});
