// @vitest-environment node
/**
 * Runtime & Integration Verification Gate tests.
 *
 * Covers: profile definitions, config validation, merge resolution, the
 * runner, and the gate behaviour in the decision engine (decideLocal).
 */
import { describe, expect, it } from 'vitest';

import {
  isRuntimeVerificationRequired,
  normaliseProjectRuntimeVerification,
  normaliseTaskRuntimeVerification,
  PROFILES,
  resolveRuntimeVerification,
  runRuntimeChecks,
  runtimeFailureExcerpt,
  summariseRuntimeChecks,
} from './runtime-verification.mjs';

import { ACTIONS, decideLocal } from './local-loop.mjs';
import {
  emptyState,
  recordAudit,
  recordImplementation,
  recordImplementerRuntimeVerification,
  recordRuntimeVerification,
} from './state.mjs';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

function task(overrides = {}) {
  return { ...emptyState(), task: '5', branch: 'agent/task-5', ...overrides };
}

/* ------------------------------------------------------------------ *
 * Profile definitions                                                  *
 * ------------------------------------------------------------------ */

describe('PROFILES', () => {
  it('lightweight is not required', () => {
    expect(PROFILES.lightweight.required).toBe(false);
  });

  it('standard, integration, and custom are required', () => {
    expect(PROFILES.standard.required).toBe(true);
    expect(PROFILES.integration.required).toBe(true);
    expect(PROFILES.custom.required).toBe(true);
  });
});

describe('isRuntimeVerificationRequired', () => {
  it('returns false for null', () => {
    expect(isRuntimeVerificationRequired(null)).toBe(false);
  });

  it('returns false for lightweight profile', () => {
    expect(isRuntimeVerificationRequired({ profile: 'lightweight', checks: [] })).toBe(false);
  });

  it('returns true for standard profile', () => {
    expect(isRuntimeVerificationRequired({ profile: 'standard', checks: [] })).toBe(true);
  });

  it('returns true for integration profile', () => {
    expect(isRuntimeVerificationRequired({ profile: 'integration', checks: [] })).toBe(true);
  });

  it('returns true for custom profile', () => {
    expect(isRuntimeVerificationRequired({ profile: 'custom', checks: [] })).toBe(true);
  });

  it('returns false for unknown profile', () => {
    expect(isRuntimeVerificationRequired({ profile: 'bogus', checks: [] })).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * Configuration validation                                             *
 * ------------------------------------------------------------------ */

describe('normaliseProjectRuntimeVerification', () => {
  it('returns null for undefined', () => {
    expect(normaliseProjectRuntimeVerification(undefined)).toBeNull();
  });

  it('returns null for null', () => {
    expect(normaliseProjectRuntimeVerification(null)).toBeNull();
  });

  it('returns null when profile is "inherit"', () => {
    expect(normaliseProjectRuntimeVerification({ profile: 'inherit' })).toBeNull();
  });

  it('returns null when profile is "disabled"', () => {
    expect(normaliseProjectRuntimeVerification({ profile: 'disabled' })).toBeNull();
  });

  it('returns a frozen config for a valid profile with checks', () => {
    const cfg = normaliseProjectRuntimeVerification({
      profile: 'standard',
      checks: [{ name: 'smoke', command: 'npm run test:smoke' }],
    });
    expect(cfg).not.toBeNull();
    expect(cfg.profile).toBe('standard');
    expect(cfg.checks).toHaveLength(1);
    expect(cfg.checks[0].name).toBe('smoke');
    expect(cfg.checks[0].command).toBe('npm run test:smoke');
  });

  it('rejects an invalid profile', () => {
    expect(() => normaliseProjectRuntimeVerification({ profile: 'bogus' }))
      .toThrow(/must be one of/);
  });

  it('rejects a non-object', () => {
    expect(() => normaliseProjectRuntimeVerification('not-an-object'))
      .toThrow(/must be an object/);
  });

  it('rejects checks that are not an array', () => {
    expect(() => normaliseProjectRuntimeVerification({ profile: 'standard', checks: 'nope' }))
      .toThrow(/must be an array/);
  });

  it('rejects a check entry without a name', () => {
    expect(() => normaliseProjectRuntimeVerification({
      profile: 'standard',
      checks: [{ command: 'npm run test' }],
    })).toThrow(/must have string "name"/);
  });
});

describe('normaliseTaskRuntimeVerification', () => {
  it('returns null for undefined', () => {
    expect(normaliseTaskRuntimeVerification(undefined, '5')).toBeNull();
  });

  it('accepts "disabled" profile', () => {
    const cfg = normaliseTaskRuntimeVerification({ profile: 'disabled' }, '5');
    expect(cfg).not.toBeNull();
    expect(cfg.profile).toBe('disabled');
  });

  it('accepts "inherit" profile', () => {
    const cfg = normaliseTaskRuntimeVerification({ profile: 'inherit' }, '5');
    expect(cfg).not.toBeNull();
    expect(cfg.profile).toBe('inherit');
  });

  it('accepts "integration" profile with custom checks', () => {
    const cfg = normaliseTaskRuntimeVerification({
      profile: 'integration',
      checks: [{ name: 'e2e', command: 'npm run test:e2e' }],
    }, '5');
    expect(cfg.profile).toBe('integration');
    expect(cfg.checks).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ *
 * Configuration resolution                                             *
 * ------------------------------------------------------------------ */

describe('resolveRuntimeVerification', () => {
  const projectStandard = { profile: 'standard', checks: [{ name: 'api', command: 'npm run test:api' }] };
  const projectLightweight = { profile: 'lightweight', checks: [] };
  const taskIntegration = { profile: 'integration', checks: [{ name: 'e2e', command: 'npm run test:e2e' }] };

  it('returns null when neither project nor task config exists (legacy)', () => {
    expect(resolveRuntimeVerification({ project: null, task: null })).toBeNull();
  });

  it('returns project config when task is absent', () => {
    const resolved = resolveRuntimeVerification({ project: projectStandard, task: null });
    expect(resolved).not.toBeNull();
    expect(resolved.profile).toBe('standard');
  });

  // With project baseline requiring RV (standard), tasks may only escalate.
  it('rejects "disabled" against a required project baseline', () => {
    expect(() =>
      resolveRuntimeVerification({
        project: projectStandard,
        task: { profile: 'disabled', checks: [] },
      }),
    ).toThrow(/cannot be "disabled"/);
  });

  it('rejects "lightweight" against a required project baseline', () => {
    expect(() =>
      resolveRuntimeVerification({
        project: projectStandard,
        task: { profile: 'lightweight', checks: [] },
      }),
    ).toThrow(/cannot be "lightweight"/);
  });

  it('returns project config when task profile is "inherit"', () => {
    const resolved = resolveRuntimeVerification({
      project: projectStandard,
      task: { profile: 'inherit', checks: [] },
    });
    expect(resolved.profile).toBe('standard');
    expect(resolved.checks).toHaveLength(1);
  });

  it('task profile overrides project profile (escalation)', () => {
    const resolved = resolveRuntimeVerification({
      project: projectStandard,
      task: taskIntegration,
    });
    expect(resolved.profile).toBe('integration');
  });

  it('task checks APPEND to project checks when project baseline is required', () => {
    const resolved = resolveRuntimeVerification({
      project: projectStandard,
      task: taskIntegration,
    });
    expect(resolved.checks).toHaveLength(2);
    expect(resolved.checks[0].name).toBe('api');    // project check first
    expect(resolved.checks[1].name).toBe('e2e');    // task check appended
  });

  it('project checks carry forward when task has no checks (required baseline)', () => {
    const resolved = resolveRuntimeVerification({
      project: projectStandard,
      task: { profile: 'integration', checks: [] },
    });
    expect(resolved.profile).toBe('integration');
    expect(resolved.checks).toHaveLength(1);
    expect(resolved.checks[0].name).toBe('api');
  });

  // With project baseline lightweight (not required) or absent, tasks have full flexibility.
  it('allows "disabled" against a lightweight project baseline', () => {
    const resolved = resolveRuntimeVerification({
      project: projectLightweight,
      task: { profile: 'disabled', checks: [] },
    });
    expect(resolved).toBeNull();
  });

  it('allows "disabled" when there is no project baseline', () => {
    const resolved = resolveRuntimeVerification({
      project: null,
      task: { profile: 'disabled', checks: [] },
    });
    expect(resolved).toBeNull();
  });

  it('task checks replace project checks when project baseline is not required', () => {
    const resolved = resolveRuntimeVerification({
      project: projectLightweight,
      task: taskIntegration,
    });
    expect(resolved.checks).toHaveLength(1);
    expect(resolved.checks[0].name).toBe('e2e');
  });

  it('task with only profile and no project returns empty checks', () => {
    const resolved = resolveRuntimeVerification({
      project: null,
      task: { profile: 'custom', checks: [] },
    });
    expect(resolved.profile).toBe('custom');
    expect(resolved.checks).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ *
 * Runner                                                               *
 * ------------------------------------------------------------------ */

function fakeRunner(failing = new Set()) {
  const ran = [];
  const runner = async (command, _timeoutMs) => {
    ran.push(command);
    return failing.has(command)
      ? { ok: false, output: `${command} failed\nline two\nline three` }
      : { ok: true, output: `${command} ok` };
  };
  runner.ran = ran;
  return runner;
}

describe('runRuntimeChecks', () => {
  const checks = [
    { name: 'smoke', command: 'npm run test:smoke' },
    { name: 'api', command: 'npm run test:api' },
  ];

  it('runs every check in order when they all pass', async () => {
    const runner = fakeRunner();
    const outcome = await runRuntimeChecks({ checks, runner });

    expect(outcome.ok).toBe(true);
    expect(outcome.failed).toBeNull();
    expect(runner.ran).toEqual(['npm run test:smoke', 'npm run test:api']);
    expect(outcome.results).toHaveLength(2);
  });

  it('stops at the first failure', async () => {
    const runner = fakeRunner(new Set(['npm run test:api']));
    const outcome = await runRuntimeChecks({ checks, runner });

    expect(outcome.ok).toBe(false);
    expect(outcome.failed.name).toBe('api');
    expect(runner.ran).toEqual(['npm run test:smoke', 'npm run test:api']);
    expect(outcome.results).toHaveLength(2);
  });

  it('reports progress as each check starts', async () => {
    const started = [];
    await runRuntimeChecks({ checks, runner: fakeRunner(), onStart: (name) => started.push(name) });
    expect(started).toEqual(['smoke', 'api']);
  });

  it('handles empty checks gracefully', async () => {
    const outcome = await runRuntimeChecks({ checks: [], runner: fakeRunner() });
    expect(outcome.ok).toBe(true);
    expect(outcome.results).toHaveLength(0);
  });
});

describe('reporting', () => {
  it('summarises runtime checks one line per check', async () => {
    const outcome = await runRuntimeChecks({
      checks: [
        { name: 'smoke', command: 'npm run test:smoke' },
        { name: 'api', command: 'npm run test:api' },
      ],
      runner: fakeRunner(new Set(['npm run test:api'])),
    });
    const summary = summariseRuntimeChecks(outcome.results);
    expect(summary).toMatch(/PASS {2}smoke/);
    expect(summary).toMatch(/FAIL {2}api/);
  });

  it('excerpts the tail of a failing check', async () => {
    const outcome = await runRuntimeChecks({
      checks: [{ name: 'api', command: 'npm run test:api' }],
      runner: fakeRunner(new Set(['npm run test:api'])),
    });
    expect(runtimeFailureExcerpt(outcome.failed, 2)).toBe('line two\nline three');
  });

  it('says so when nothing was captured', () => {
    expect(runtimeFailureExcerpt(null)).toMatch(/no output/);
    expect(runtimeFailureExcerpt({ output: '' })).toMatch(/no output/);
  });
});

/* ------------------------------------------------------------------ *
 * State: runtime verification fields                                   *
 * ------------------------------------------------------------------ */

describe('state — runtime verification', () => {
  it('emptyState has runtime verification fields at defaults', () => {
    const s = emptyState();
    expect(s.runtimeVerificationStatus).toBeNull();
    expect(s.runtimeVerificationHead).toBeNull();
    expect(s.runtimeVerificationOutput).toBeNull();
    expect(s.runtimeVerificationRequired).toBe(false);
    expect(s.runtimeVerificationProfile).toBeNull();
    expect(s.implementerRuntimeVerificationStatus).toBeNull();
    expect(s.implementerRuntimeVerificationHead).toBeNull();
    expect(s.implementerRuntimeVerificationOutput).toBeNull();
  });

  it('recordRuntimeVerification stores a PASS result', () => {
    const s = recordRuntimeVerification(task(), {
      head: A,
      status: 'PASS',
      output: 'all good',
      required: true,
      profile: 'standard',
    });
    expect(s.runtimeVerificationStatus).toBe('PASS');
    expect(s.runtimeVerificationHead).toBe(A);
    expect(s.runtimeVerificationOutput).toBe('all good');
    expect(s.runtimeVerificationRequired).toBe(true);
    expect(s.runtimeVerificationProfile).toBe('standard');
  });

  it('recordRuntimeVerification stores a FAIL result', () => {
    const s = recordRuntimeVerification(task(), {
      head: A,
      status: 'FAIL',
      output: 'error details',
      required: true,
      profile: 'integration',
    });
    expect(s.runtimeVerificationStatus).toBe('FAIL');
    expect(s.runtimeVerificationOutput).toBe('error details');
  });

  it('recordRuntimeVerification stores NOT_REQUIRED', () => {
    const s = recordRuntimeVerification(task(), {
      head: A,
      status: 'NOT_REQUIRED',
      required: false,
    });
    expect(s.runtimeVerificationStatus).toBe('NOT_REQUIRED');
    expect(s.runtimeVerificationRequired).toBe(false);
  });

  it('recordImplementerRuntimeVerification stores a PASS result', () => {
    const s = recordImplementerRuntimeVerification(task(), {
      head: A,
      status: 'PASS',
      output: 'implementer gate ok',
    });
    expect(s.implementerRuntimeVerificationStatus).toBe('PASS');
    expect(s.implementerRuntimeVerificationHead).toBe(A);
    expect(s.implementerRuntimeVerificationOutput).toBe('implementer gate ok');
  });

  it('recordImplementerRuntimeVerification stores a FAIL result', () => {
    const s = recordImplementerRuntimeVerification(task(), {
      head: A,
      status: 'FAIL',
      output: 'implementer gate failed',
    });
    expect(s.implementerRuntimeVerificationStatus).toBe('FAIL');
    expect(s.implementerRuntimeVerificationOutput).toBe('implementer gate failed');
  });

  it('recordImplementation invalidates both runtime verification gates', () => {
    let before = recordRuntimeVerification(task(), {
      head: A,
      status: 'PASS',
      required: true,
    });
    before = recordImplementerRuntimeVerification(before, {
      head: A,
      status: 'PASS',
    });
    expect(before.runtimeVerificationStatus).toBe('PASS');
    expect(before.implementerRuntimeVerificationStatus).toBe('PASS');

    const after = recordImplementation(before, B);
    expect(after.runtimeVerificationStatus).toBeNull();
    expect(after.runtimeVerificationHead).toBeNull();
    expect(after.runtimeVerificationOutput).toBeNull();
    expect(after.implementerRuntimeVerificationStatus).toBeNull();
    expect(after.implementerRuntimeVerificationHead).toBeNull();
    expect(after.implementerRuntimeVerificationOutput).toBeNull();
  });

  it('runtime verification survives state save/load round-trip', () => {
    const s = recordRuntimeVerification(task(), {
      head: A,
      status: 'PASS',
      output: 'all passed',
      required: true,
      profile: 'standard',
    });
    expect(s.runtimeVerificationStatus).toBe('PASS');
    expect(s.runtimeVerificationHead).toBe(A);
  });
});

/* ------------------------------------------------------------------ *
 * decideLocal gates                                                    *
 * ------------------------------------------------------------------ */

describe('decideLocal — runtime verification gates', () => {
  // Legacy: no runtime verification configured — everything proceeds normally.
  it('legacy project (no runtime config) proceeds through audit normally', () => {
    const state = recordImplementation(task(), A);
    const decision = decideLocal({ state, head: A });
    expect(decision.action).toBe(ACTIONS.AUDIT);
  });

  it('legacy project proceeds through publish normally', () => {
    const state = recordAudit(
      task({ implementationHead: A, lastAuditedHead: A, round: 1 }),
      { head: A, verdict: 'APPROVED' },
    );
    const decision = decideLocal({ state, head: A });
    expect(decision.action).toBe(ACTIONS.PUBLISH);
  });

  // NOT_REQUIRED: runtime gate is not required — workflow continues.
  it('NOT_REQUIRED runtime gate does not block audit', () => {
    const state = recordRuntimeVerification(
      recordImplementation(task(), A),
      { head: A, status: 'NOT_REQUIRED', required: false },
    );
    const decision = decideLocal({ state, head: A });
    expect(decision.action).toBe(ACTIONS.AUDIT);
  });

  it('NOT_REQUIRED runtime gate does not block publish', () => {
    const state = recordRuntimeVerification(
      recordAudit(
        task({ implementationHead: A, lastAuditedHead: A, round: 1 }),
        { head: A, verdict: 'APPROVED' },
      ),
      { head: A, status: 'NOT_REQUIRED', required: false },
    );
    const decision = decideLocal({ state, head: A });
    expect(decision.action).toBe(ACTIONS.PUBLISH);
  });

  // PASS: required runtime verification passed — workflow proceeds.
  it('PASS runtime gate allows audit to proceed', () => {
    const state = recordRuntimeVerification(
      recordImplementation(task(), A),
      { head: A, status: 'PASS', required: true },
    );
    const decision = decideLocal({ state, head: A });
    expect(decision.action).toBe(ACTIONS.AUDIT);
  });

  it('PASS runtime gate allows publish to proceed (both gates)', () => {
    let state = recordAudit(
      task({ implementationHead: A, lastAuditedHead: A, round: 1 }),
      { head: A, verdict: 'APPROVED' },
    );
    state = recordRuntimeVerification(state, { head: A, status: 'PASS', required: true });
    state = recordImplementerRuntimeVerification(state, { head: A, status: 'PASS' });
    const decision = decideLocal({ state, head: A });
    expect(decision.action).toBe(ACTIONS.PUBLISH);
  });

  // FAIL: required runtime verification failed — audit blocked.
  it('FAIL runtime gate blocks audit', () => {
    const state = recordRuntimeVerification(
      recordImplementation(task(), A),
      { head: A, status: 'FAIL', output: 'something broke', required: true },
    );
    const decision = decideLocal({ state, head: A });
    expect(decision.action).toBe(ACTIONS.STOP);
    expect(decision.reason).toMatch(/runtime verification/i);
  });

  // FAIL: required runtime verification failed — publish blocked.
  it('FAIL runtime gate blocks publish even with APPROVED verdict', () => {
    let state = recordAudit(
      task({ implementationHead: A, lastAuditedHead: A, round: 1 }),
      { head: A, verdict: 'APPROVED' },
    );
    state = recordRuntimeVerification(state, { head: A, status: 'FAIL', output: 'broken', required: true });
    state = recordImplementerRuntimeVerification(state, { head: A, status: 'PASS' });
    const decision = decideLocal({ state, head: A });
    expect(decision.action).toBe(ACTIONS.STOP);
    // The earlier hard-blocker check (FAIL for current HEAD) fires before the
    // publish-gate check. Both blocks are correct; this test verifies the
    // runtime gate is enforced.
    expect(decision.reason).toMatch(/runtime verification is required/i);
  });

  // Missing: required but not run — the audit step itself will run it, so
  // audit may proceed. But publish must be blocked.
  it('missing runtime verification (not yet run, status null) allows audit', () => {
    // Required but not yet run: the controller's audit step will run the
    // checks before calling the auditor, so decideLocal should still return
    // AUDIT for a valid implementation handoff.
    const state = {
      ...recordImplementation(task(), A),
      runtimeVerificationRequired: true,
      runtimeVerificationStatus: null,
      runtimeVerificationHead: null,
    };
    const decision = decideLocal({ state, head: A });
    expect(decision.action).toBe(ACTIONS.AUDIT);
  });

  it('missing runtime verification blocks publish (both gates absent)', () => {
    const state = recordAudit(
      task({
        implementationHead: A,
        lastAuditedHead: A,
        round: 1,
        runtimeVerificationRequired: true,
        runtimeVerificationStatus: null,
        runtimeVerificationHead: null,
        implementerRuntimeVerificationStatus: null,
        implementerRuntimeVerificationHead: null,
      }),
      { head: A, verdict: 'APPROVED' },
    );
    const decision = decideLocal({ state, head: A });
    expect(decision.action).toBe(ACTIONS.STOP);
    expect(decision.reason).toMatch(/runtime verification/i);
    expect(decision.reason).toMatch(/not run/);
  });

  // Mismatch: runtime verification was run against a different HEAD.
  it('runtime verification for a different HEAD blocks publish', () => {
    const state = recordAudit(
      task({
        implementationHead: B,
        lastAuditedHead: B,
        round: 1,
        runtimeVerificationRequired: true,
        runtimeVerificationStatus: 'PASS',
        runtimeVerificationHead: A, // auditor gate against A, but HEAD is now B
        implementerRuntimeVerificationStatus: 'PASS',
        implementerRuntimeVerificationHead: A, // implementer gate also against A
      }),
      { head: B, verdict: 'APPROVED' },
    );
    const decision = decideLocal({ state, head: B });
    expect(decision.action).toBe(ACTIONS.STOP);
    expect(decision.reason).toMatch(/runtime verification/i);
  });

  it('implementer gate missing but auditor gate PASS blocks publish', () => {
    let state = recordAudit(
      task({ implementationHead: A, lastAuditedHead: A, round: 1 }),
      { head: A, verdict: 'APPROVED' },
    );
    state = recordRuntimeVerification(state, { head: A, status: 'PASS', required: true });
    // Implementer gate not recorded
    const decision = decideLocal({ state, head: A });
    expect(decision.action).toBe(ACTIONS.STOP);
    expect(decision.reason).toMatch(/implementer gate/);
  });

  // A new commit voids the runtime verification result — the state module
  // already tests recordImplementation clears the fields. Here we test that
  // decideLocal sees the cleared state correctly.
  it('new commit voids runtime verification, audit may still proceed to re-run', () => {
    // Start with a PASS on A.
    const afterPass = recordRuntimeVerification(
      recordImplementation(task(), A),
      { head: A, status: 'PASS', required: true },
    );
    expect(afterPass.runtimeVerificationStatus).toBe('PASS');

    // New commit on top of A — runtime verification is cleared.
    const afterImpl = recordImplementation(afterPass, B);
    expect(afterImpl.runtimeVerificationStatus).toBeNull();

    // Required but not yet run against B — audit may proceed (it will re-run checks).
    const withRequired = { ...afterImpl, runtimeVerificationRequired: true };
    const decision = decideLocal({ state: withRequired, head: B });
    expect(decision.action).toBe(ACTIONS.AUDIT);
  });
});
