// @vitest-environment node
/**
 * The local review loop's decision engine.
 *
 * Two properties matter more than the rest, and most of these tests exist for
 * them:
 *
 *  - An approval covers exactly one commit. If HEAD has moved, the work is
 *    re-audited, never published.
 *  - A task cannot loop indefinitely. After the configured number of
 *    REQUEST_CHANGES rounds the loop stops with a report instead of starting
 *    another round.
 */
import { describe, expect, it } from 'vitest';

import { MAX_CHANGE_ROUNDS } from './config.mjs';
import {
  ACTIONS,
  auditScope,
  decideLocal,
  extractBlockingFindings,
  formatLocalReport,
} from './local-loop.mjs';
import { emptyState, recordAudit, recordImplementation } from './state.mjs';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);

function task(overrides = {}) {
  return { ...emptyState(), task: '5', branch: 'agent/task-5', ...overrides };
}

function act(state, head) {
  return decideLocal({ state, head }).action;
}

describe('decideLocal — the normal path', () => {
  it('implements when the branch has no commits yet', () => {
    expect(act(task(), null)).toBe(ACTIONS.IMPLEMENT);
  });

  it('implements when commits exist but none is a recorded checkpoint', () => {
    // Someone committed on the branch by hand before the loop ran.
    expect(act(task(), A)).toBe(ACTIONS.IMPLEMENT);
  });

  it('audits the first checkpoint', () => {
    expect(act(recordImplementation(task(), A), A)).toBe(ACTIONS.AUDIT);
  });

  it('returns findings to Claude after REQUEST_CHANGES', () => {
    const state = recordAudit(recordImplementation(task(), A), {
      head: A,
      verdict: 'REQUEST_CHANGES',
      blockers: ['One finding'],
    });
    expect(act(state, A)).toBe(ACTIONS.FIX);
  });

  it('re-audits once the fix is committed', () => {
    const requested = recordAudit(recordImplementation(task(), A), {
      head: A,
      verdict: 'REQUEST_CHANGES',
      blockers: ['One finding'],
    });
    expect(act(recordImplementation(requested, B), B)).toBe(ACTIONS.AUDIT);
  });

  it('publishes an approval of the exact current HEAD', () => {
    const state = recordAudit(task({ implementationHead: B, lastAuditedHead: A, round: 1 }), {
      head: B,
      verdict: 'APPROVED',
    });
    expect(act(state, B)).toBe(ACTIONS.PUBLISH);
  });

  it('is done once the approved commit is published', () => {
    const state = task({
      implementationHead: B,
      lastAuditedHead: B,
      verdict: 'APPROVED',
      publishedHead: B,
    });
    expect(act(state, B)).toBe(ACTIONS.DONE);
  });
});

describe('decideLocal — an approval covers one commit and no other', () => {
  it('stops rather than auditing when HEAD moved without a new Claude handoff', () => {
    const approved = recordAudit(task({ implementationHead: B, lastAuditedHead: A, round: 1 }), {
      head: B,
      verdict: 'APPROVED',
    });
    expect(act(approved, C)).toBe(ACTIONS.STOP);
  });

  it('re-audits a newer HEAD only after Claude records that exact checkpoint', () => {
    const approved = recordAudit(task({ implementationHead: B, lastAuditedHead: A, round: 1 }), {
      head: B,
      verdict: 'APPROVED',
    });
    expect(act(recordImplementation(approved, C), C)).toBe(ACTIONS.AUDIT);
  });

  it('re-publishes nothing when the published commit is no longer HEAD', () => {
    // A commit after publishing means there is unreviewed work again.
    const state = task({
      implementationHead: C,
      lastAuditedHead: B,
      verdict: 'APPROVED',
      publishedHead: B,
    });
    expect(act(state, C)).toBe(ACTIONS.AUDIT);
  });

  it('re-audits when a commit was audited but no verdict was recorded', () => {
    const state = task({ implementationHead: A, lastAuditedHead: A, verdict: null });
    expect(act(state, A)).toBe(ACTIONS.AUDIT);
  });
});

describe('decideLocal — manual publish mode', () => {
  function decide(state, head, mode) {
    return decideLocal({ state, head, publishMode: mode }).action;
  }

  it('stops when manual-ready head matches, without setting publishedHead', () => {
    const state = task({
      implementationHead: B,
      lastAuditedHead: B,
      verdict: 'APPROVED',
      readyToPublishHead: B,
    });
    expect(decide(state, B, 'manual')).toBe(ACTIONS.STOP);
  });

  it('still publishes in auto mode even with readyToPublishHead set', () => {
    const state = task({
      implementationHead: B,
      lastAuditedHead: B,
      verdict: 'APPROVED',
      readyToPublishHead: B,
    });
    expect(decide(state, B, 'auto')).toBe(ACTIONS.PUBLISH);
  });

  it('publishes an approval normally in manual mode when not yet manual-ready', () => {
    const state = recordAudit(task({ implementationHead: B, lastAuditedHead: A, round: 1 }), {
      head: B,
      verdict: 'APPROVED',
    });
    expect(decide(state, B, 'manual')).toBe(ACTIONS.PUBLISH);
  });

  it('publishes an approval in auto mode', () => {
    const state = recordAudit(task({ implementationHead: B, lastAuditedHead: A, round: 1 }), {
      head: B,
      verdict: 'APPROVED',
    });
    expect(decide(state, B, 'auto')).toBe(ACTIONS.PUBLISH);
  });

  it('marks done when publishedHead matches in auto mode', () => {
    const state = task({
      implementationHead: B,
      lastAuditedHead: B,
      verdict: 'APPROVED',
      publishedHead: B,
    });
    expect(decide(state, B, 'auto')).toBe(ACTIONS.DONE);
  });

  it('manual-ready state does not return DONE', () => {
    const state = task({
      implementationHead: B,
      lastAuditedHead: B,
      verdict: 'APPROVED',
      readyToPublishHead: B,
    });
    expect(decide(state, B, 'auto')).not.toBe(ACTIONS.DONE);
  });

  it('re-audits when HEAD moved past a manual-ready commit', () => {
    const state = task({
      implementationHead: C,
      lastAuditedHead: B,
      verdict: 'APPROVED',
      readyToPublishHead: B,
    });
    expect(decide(state, C, 'manual')).toBe(ACTIONS.AUDIT);
  });
});

describe('decideLocal — stopping instead of looping', () => {
  it(`stops after ${MAX_CHANGE_ROUNDS} change rounds`, () => {
    const state = task({
      implementationHead: B,
      lastAuditedHead: B,
      verdict: 'REQUEST_CHANGES',
      changeRounds: MAX_CHANGE_ROUNDS,
      round: MAX_CHANGE_ROUNDS,
      blockers: ['Still unresolved'],
    });
    const decision = decideLocal({ state, head: B });
    expect(decision.action).toBe(ACTIONS.STOP);
    expect(decision.reason).toMatch(/maximum/);
  });

  it('still fixes on the round before the limit', () => {
    const state = task({
      implementationHead: B,
      lastAuditedHead: B,
      verdict: 'REQUEST_CHANGES',
      changeRounds: MAX_CHANGE_ROUNDS - 1,
      round: MAX_CHANGE_ROUNDS - 1,
      blockers: ['One finding'],
    });
    expect(act(state, B)).toBe(ACTIONS.FIX);
  });

  it('honours a lower limit passed explicitly', () => {
    const state = task({
      implementationHead: B,
      lastAuditedHead: B,
      verdict: 'REQUEST_CHANGES',
      changeRounds: 1,
      blockers: ['One finding'],
    });
    expect(decideLocal({ state, head: B, maxChangeRounds: 1 }).action).toBe(ACTIONS.STOP);
  });

  it('stops when Codex could not complete the audit', () => {
    const state = task({ implementationHead: A, lastAuditedHead: A, verdict: 'BLOCKED' });
    expect(act(state, A)).toBe(ACTIONS.STOP);
  });

  it('stops on BLOCKED even before anything was committed', () => {
    expect(act(task({ verdict: 'BLOCKED' }), null)).toBe(ACTIONS.STOP);
  });

  it('stops until the owner explicitly clears a terminal Claude recovery', () => {
    const decision = decideLocal({ state: task({ recoveryRequired: true }), head: null });
    expect(decision.action).toBe(ACTIONS.STOP);
    expect(decision.reason).toMatch(/recovery/i);
  });
});

describe('auditScope', () => {
  it('reviews the whole branch on the first audit', () => {
    const scope = auditScope({ state: recordImplementation(task(), A), head: A });
    expect(scope.incremental).toBe(false);
    expect(scope.range).toBe(`main..${A}`);
    expect(scope.unresolved).toEqual([]);
  });

  it('reviews only the new commits on a re-audit', () => {
    const state = task({
      implementationHead: B,
      lastAuditedHead: A,
      blockers: ['One finding'],
    });
    const scope = auditScope({ state, head: B });
    expect(scope.incremental).toBe(true);
    expect(scope.range).toBe(`${A}..${B}`);
    expect(scope.from).toBe(A);
  });

  it('carries the unresolved findings into the re-audit', () => {
    const state = task({ implementationHead: B, lastAuditedHead: A, blockers: ['One', 'Two'] });
    expect(auditScope({ state, head: B }).unresolved).toEqual(['One', 'Two']);
  });

  it('treats a re-audit of the same commit as a full review', () => {
    const state = task({ implementationHead: A, lastAuditedHead: A, blockers: ['One'] });
    const scope = auditScope({ state, head: A });
    expect(scope.incremental).toBe(false);
    expect(scope.range).toBe(`main..${A}`);
  });
});

describe('extractBlockingFindings', () => {
  it('reads enumerated findings under a blocking heading', () => {
    const report = [
      '## Summary',
      'Looks reasonable overall.',
      '',
      '## Blocking findings',
      '',
      '1. `parse()` drops the last row',
      '2. No test covers the empty input',
      '',
      '## Non-blocking observations',
      '',
      '- Consider renaming `tmp`',
    ].join('\n');

    expect(extractBlockingFindings(report, { count: 2, round: 1 })).toEqual([
      '`parse()` drops the last row',
      'No test covers the empty input',
    ]);
  });

  it('does not mistake the non-blocking section for findings', () => {
    const report = '## Non-blocking observations\n\n- Consider renaming `tmp`\n';
    const findings = extractBlockingFindings(report, { count: 1, round: 1 });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatch(/see the audit report/);
  });

  it('falls back to a pointer at the report when it has no list', () => {
    const findings = extractBlockingFindings('The change is wrong.', { count: 3, round: 2 });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatch(/3 blocking finding\(s\) from audit round 2/);
  });

  it('tolerates an empty or missing report', () => {
    expect(extractBlockingFindings('')).toHaveLength(1);
    expect(extractBlockingFindings(undefined)).toHaveLength(1);
  });
});

describe('formatLocalReport', () => {
  it('records everything needed to pick the task back up', () => {
    const state = task({
      implementationHead: B,
      lastAuditedHead: B,
      round: 2,
      changeRounds: 2,
      verdict: 'REQUEST_CHANGES',
      blockers: ['Still unresolved'],
    });

    const body = formatLocalReport({
      state,
      head: B,
      decision: { action: ACTIONS.STOP, reason: 'Change rounds exhausted.' },
      checks: [{ name: 'test', script: 'test', ok: true }],
      commits: [{ sha: A, subject: 'feat: first pass' }],
      files: ['src/thing.ts'],
    });

    expect(body).toMatch(/task 5/);
    expect(body).toMatch(/agent\/task-5/);
    expect(body).toMatch(new RegExp(B));
    expect(body).toMatch(/Change rounds used: 2/);
    expect(body).toMatch(/Still unresolved/);
    expect(body).toMatch(/src\/thing\.ts/);
    // Nothing was published, and the report has to say so plainly.
    expect(body).toMatch(/Nothing has been pushed/);
  });

  it('says so when there are no blockers', () => {
    const body = formatLocalReport({
      state: task(),
      head: null,
      decision: { action: ACTIONS.STOP, reason: 'Nothing to do.' },
    });
    expect(body).toMatch(/None recorded\./);
  });
});
