/**
 * Agent-router — role → provider dispatch.
 *
 * Given a logical role and the role mapping, resolves the provider and
 * dispatches to the correct agent runner.  Provider-specific configuration
 * stays attached to the provider, not the role.
 *
 * The two exported runner functions mirror the two agent interfaces the
 * controller already uses:
 *
 *   runImplementer  — full Claude session (implement / fix)
 *   runAuditor      — read-only Codex audit
 *
 * Each validates its role mapping at call time and fails clearly when the
 * configured provider does not support the role.
 */

import { ROLE_MAPPING } from './config.mjs';
import { runClaude, streamClaudeProgress } from './claude-agent.mjs';
import { runCodexAudit } from './codex-agent.mjs';
import { getProviderIdentity, resolveProvider } from './roles.mjs';

/**
 * Resolve which provider fills a role and return its status-block identity.
 *
 * @param {string} role — one of LOGICAL_ROLES
 * @param {Record<string, string>} [mapping] — defaults to ROLE_MAPPING
 * @returns {{ provider: string, identity: string }}
 */
export function resolveRoleProvider(role, mapping = ROLE_MAPPING) {
  const { provider } = resolveProvider(role, mapping);
  return { provider, identity: getProviderIdentity(provider) };
}

/**
 * Run the implementer for one turn.
 *
 * Currently only "claude" supports the implementer role; any other
 * mapping fails with a clear error at call time.
 *
 * @param {{
 *   prompt: string,
 *   sessionId?: string|null,
 *   resume?: boolean,
 *   onStdout?: (chunk: string) => void,
 *   onLog?: (line: string) => void,
 * }} options
 * @returns {Promise<object>} Claude run result
 */
export async function runImplementer({ prompt, sessionId = null, resume = false, onStdout, onLog }) {
  const { provider } = resolveRoleProvider('implementer');

  if (provider === 'claude') {
    return runClaude({ prompt, sessionId, resume, onStdout, onLog });
  }

  throw new Error(
    `Provider "${provider}" does not have an implementer runner. ` +
      'Only "claude" is currently supported for the implementer role.',
  );
}

/**
 * Run the auditor for one read-only review turn.
 *
 * Currently only "codex" supports the auditor role; any other mapping
 * fails with a clear error at call time.
 *
 * @param {{
 *   prompt: string,
 *   onStdout?: (chunk: string) => void,
 * }} options
 * @returns {Promise<{ ok: boolean, text: string, raw: string, error: string|null }>}
 */
export async function runAuditor({ prompt, onStdout }) {
  const { provider } = resolveRoleProvider('auditor');

  if (provider === 'codex') {
    return runCodexAudit({ prompt, onStdout });
  }

  throw new Error(
    `Provider "${provider}" does not have an auditor runner. ` +
      'Only "codex" is currently supported for the auditor role.',
  );
}

// Re-export streamClaudeProgress so the controller can use it when the
// implementer role is backed by Claude (the default and only current case).
export { streamClaudeProgress };
