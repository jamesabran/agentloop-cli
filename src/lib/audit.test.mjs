// @vitest-environment node
/**
 * A failing Codex process must not produce an actionable APPROVED verdict.
 *
 * The regression this guards: an earlier branch accepted the parsed status
 * whenever `readStatus` was OK, even if `codex exec` had itself exited
 * non-zero. That let a crash during the audit produce a syntactically valid
 * APPROVED block, which the controller then recorded — and the next cycle
 * would publish the branch on the strength of that unaudited verdict.
 */
import { describe, expect, it } from 'vitest';

import { classifyAuditOutcome } from './audit.mjs';

const HEAD = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

const validApproved = {
  ok: true,
  none: false,
  status: {
    valid: true,
    role: 'CODEX',
    status: 'APPROVED',
    task: '5',
    head: HEAD,
    blockers: 0,
    next: 'CONTROLLER_PUBLISH',
  },
  errors: [],
};

const parseErrors = {
  ok: false,
  none: false,
  status: null,
  errors: ['STATUS must be one of …'],
};

describe('classifyAuditOutcome', () => {
  it('accepts a clean exit paired with a valid status', () => {
    const result = classifyAuditOutcome({ ok: true, error: null }, validApproved);
    expect(result.kind).toBe('ok');
    expect(result.status.status).toBe('APPROVED');
  });

  it('rejects a non-zero Codex exit even when the status parses as APPROVED', () => {
    // The exact regression: codex exited non-zero, but the last message it
    // wrote happens to be a syntactically valid APPROVED block. Accepting it
    // would record the approval and let the next step publish unaudited work.
    const result = classifyAuditOutcome(
      { ok: false, error: 'codex exec exited 1: sandbox aborted mid-audit' },
      validApproved,
    );
    expect(result.kind).toBe('audit_failed');
    expect(result.kind).not.toBe('ok');
    expect(result.reason).toMatch(/exited/);
  });

  it('rejects a non-zero exit paired with an unparsable status', () => {
    const result = classifyAuditOutcome({ ok: false, error: 'killed' }, parseErrors);
    expect(result.kind).toBe('audit_failed');
  });

  it('reports unusable_status when the exit was clean but the block was not', () => {
    const result = classifyAuditOutcome({ ok: true, error: null }, parseErrors);
    expect(result.kind).toBe('unusable_status');
    expect(result.errors).toContain('STATUS must be one of …');
  });

  it('supplies a fallback reason when the failing outcome has none', () => {
    const result = classifyAuditOutcome({ ok: false, error: null }, validApproved);
    expect(result.kind).toBe('audit_failed');
    expect(result.reason).toBeTruthy();
  });
});
