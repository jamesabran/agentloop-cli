/**
 * Agent-router — role → provider dispatch.
 *
 * Given a logical role and the role mapping, resolves the provider and
 * dispatches to the correct agent runner.  Provider-specific configuration
 * stays attached to the provider, not the role.
 *
 * Every role/agent combination offered by setup is executable here:
 *   - Claude:  implementer (full session), auditor (wrapped Claude run)
 *   - Codex:   implementer (workspace-write sandbox), auditor (read-only sandbox)
 *   - Manual:  all three roles (clear stop with explanation)
 *
 * The controller handles each result uniformly — the runner, not the
 * controller, owns the difference between agents.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { LIMITS, REPO_ROOT, ROLE_MAPPING } from './config.mjs';
import { runClaude, streamClaudeProgress } from './claude-agent.mjs';
import { codexExecutable } from './codex-agent.mjs';
import { run } from './process.mjs';
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

/* ------------------------------------------------------------------ *
 * Manual / External handlers                                           *
 * ------------------------------------------------------------------ */

/**
 * Manual implementer — the user does the work outside ALCLI.
 * Returns a clean stop so the controller halts with a clear message.
 */
async function runManualImplementer() {
  return {
    ok: false,
    usageLimited: false,
    resumeAtMs: null,
    sessionId: null,
    text: '',
    raw: '',
    error: 'Manual implementation required. Complete the implementation externally, then re-run ALCLI to continue.',
  };
}

/**
 * Manual auditor — the user reviews externally.
 * Returns a clean stop so the controller halts with a clear message.
 */
async function runManualAuditor() {
  return {
    ok: false,
    text: 'Manual review required.',
    raw: '',
    error: 'Manual audit required. Complete the review externally, then re-run ALCLI to continue.',
  };
}

/* ------------------------------------------------------------------ *
 * Codex implementer                                                    *
 * ------------------------------------------------------------------ */

/**
 * Run Codex in workspace-write mode for implementation.
 *
 * Uses the same Codex CLI as the auditor but with --sandbox workspace-write
 * so Codex can edit files and make commits, and without the read-only
 * enforcement in assertReadOnlyAudit.
 *
 * @param {{ prompt: string, onStdout?: (chunk: string) => void }} options
 * @returns {Promise<{ ok: boolean, usageLimited: boolean, resumeAtMs: null, sessionId: null, text: string, raw: string, error: string|null, timedOut?: boolean }>}
 */
export async function runCodexImplement({ prompt, onStdout }) {
  const lastMessageFile = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'agentloop-implement-')),
    'output.md',
  );

  try {
    const args = [
      'exec',
      '--sandbox', 'workspace-write',
      '--cd', REPO_ROOT,
      '--color', 'never',
      '--output-last-message', lastMessageFile,
    ];

    if (process.env.AGENTLOOP_CODEX_MODEL) {
      args.push('--model', process.env.AGENTLOOP_CODEX_MODEL);
    }

    // `-` makes Codex read the prompt from stdin.
    args.push('-');

    const outcome = await run(codexExecutable(), args, {
      cwd: REPO_ROOT,
      input: prompt,
      timeoutMs: LIMITS.codexTimeoutMs,
      onStdout,
    });

    if (outcome.timedOut) {
      return {
        ok: false,
        usageLimited: false,
        resumeAtMs: null,
        sessionId: null,
        text: '',
        raw: outcome.stdout,
        error: `Codex implementer timed out after ${LIMITS.codexTimeoutMs}ms.`,
        timedOut: true,
      };
    }

    let finalMessage = '';
    try {
      finalMessage = fs.readFileSync(lastMessageFile, 'utf8');
    } catch {
      // Codex did not write a final message; fall back to stdout.
    }

    const text = finalMessage.trim() !== '' ? finalMessage : outcome.stdout;

    return {
      ok: outcome.code === 0,
      usageLimited: false,
      resumeAtMs: null,
      sessionId: null,
      text,
      raw: outcome.stdout,
      error: outcome.code === 0 ? null : (outcome.stderr || outcome.stdout).slice(0, 2000),
    };
  } finally {
    fs.rmSync(path.dirname(lastMessageFile), { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ *
 * Claude auditor                                                       *
 * ------------------------------------------------------------------ */

/**
 * Run Claude in an audit role — read-only, no file edits.
 *
 * Passes permissionMode: 'plan' to the Claude runner so the audit cannot
 * edit files, matching the read-only sandbox guarantee Codex provides.
 * Wraps the standard Claude runner so the controller receives the same
 * {ok, text, raw, error} shape it expects from runCodexAudit.
 *
 * @param {{ prompt: string, onStdout?: (chunk: string) => void }} options
 * @returns {Promise<{ ok: boolean, text: string, raw: string, error: string|null }>}
 */
export async function runClaudeAudit({ prompt, onStdout }) {
  const result = await runClaude({ prompt, onStdout, permissionMode: 'plan' });
  return {
    ok: result.ok,
    text: result.text,
    raw: result.raw,
    error: result.error,
  };
}

/* ------------------------------------------------------------------ *
 * Dispatch                                                              *
 * ------------------------------------------------------------------ */

/**
 * Run the implementer for one turn.
 *
 * Dispatches to the correct runner for the configured provider.
 *
 * @param {{
 *   prompt: string,
 *   sessionId?: string|null,
 *   resume?: boolean,
 *   onStdout?: (chunk: string) => void,
 *   onLog?: (line: string) => void,
 * }} options
 * @returns {Promise<object>} runner result
 */
export async function runImplementer({ prompt, sessionId = null, resume = false, onStdout, onLog }) {
  const { ROLE_MAPPING } = await import('./config.mjs');
  const { provider } = resolveRoleProvider('implementer', ROLE_MAPPING);

  switch (provider) {
    case 'claude':
      return runClaude({ prompt, sessionId, resume, onStdout, onLog });
    case 'codex':
      return runCodexImplement({ prompt, onStdout });
    case 'manual':
      return runManualImplementer();
    default:
      throw new Error(
        `Provider "${provider}" does not have an implementer runner. ` +
          'Supported: claude, codex, manual.',
      );
  }
}

/**
 * Run the auditor for one read-only review turn.
 *
 * Dispatches to the correct runner for the configured provider.
 *
 * @param {{
 *   prompt: string,
 *   onStdout?: (chunk: string) => void,
 * }} options
 * @returns {Promise<{ ok: boolean, text: string, raw: string, error: string|null }>}
 */
export async function runAuditor({ prompt, onStdout }) {
  const { ROLE_MAPPING } = await import('./config.mjs');
  const { provider } = resolveRoleProvider('auditor', ROLE_MAPPING);

  switch (provider) {
    case 'codex':
      const { runCodexAudit } = await import('./codex-agent.mjs');
      return runCodexAudit({ prompt, onStdout });
    case 'claude':
      return runClaudeAudit({ prompt, onStdout });
    case 'manual':
      return runManualAuditor();
    default:
      throw new Error(
        `Provider "${provider}" does not have an auditor runner. ` +
          'Supported: codex, claude, manual.',
      );
  }
}

// Re-export streamClaudeProgress so the controller can use it when the
// implementer role is backed by Claude (the default and only current case).
export { streamClaudeProgress };
