/**
 * Pure helpers around a completed Codex audit.
 *
 * Kept separate from `controller.mjs` so the audit-outcome classification is
 * directly testable. No I/O and no imports from the controller itself.
 */

/**
 * Classify a completed Codex run.
 *
 * Two rules matter here:
 *
 *  1. A non-zero Codex exit means the audit did not complete cleanly, even if
 *     the process wrote a syntactically valid status block on its way out.
 *     Accepting the verdict of a failed process would let a crash produce an
 *     unaudited merge, so any non-zero exit is treated as an `audit_failed`
 *     — regardless of what parsed out of the output.
 *  2. Only after the exit is clean is the status block trusted.
 *
 * @param {{ ok: boolean, error: string|null }} outcome result from runCodexAudit
 * @param {{ ok: boolean, status: object|null, errors: string[] }} read result from readStatus
 * @returns {{ kind: 'audit_failed'|'unusable_status'|'ok',
 *             reason?: string, errors?: string[], status?: object }}
 */
export function classifyAuditOutcome(outcome, read) {
  if (!outcome.ok) {
    return { kind: 'audit_failed', reason: outcome.error ?? 'Codex exited non-zero.' };
  }
  if (!read.ok) {
    return { kind: 'unusable_status', errors: read.errors ?? [] };
  }
  return { kind: 'ok', status: read.status };
}
