/**
 * Non-interactive Codex audits.
 *
 * Flags used here were checked against the installed `codex exec --help`
 * (codex-cli 0.146.0): `-s/--sandbox`, `-C/--cd`, `-o/--output-last-message`,
 * `--color`, and the `-` prompt-from-stdin form. `codex exec` has no
 * `--ask-for-approval` flag, so it is not passed.
 *
 * Codex is an auditor. `--sandbox read-only` is always passed, and the
 * write-capable and approval-bypassing flags are refused before the process
 * starts.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { LIMITS, REPO_ROOT } from './config.mjs';
import { CommandError, npmGlobalDirs, resolveExecutable, run } from './process.mjs';

let codexPath = null;

export function codexExecutable() {
  codexPath ??= resolveExecutable('codex', {
    override: process.env.AGENTLOOP_CODEX_BIN,
    extraDirs: npmGlobalDirs(),
  });
  return codexPath;
}

/** Flags that would let the auditor write, or skip its sandbox entirely. */
const FORBIDDEN_AUDIT_FLAGS = [
  '--dangerously-bypass-approvals-and-sandbox',
  '--dangerously-bypass-hook-trust',
  '--add-dir',
];

const WRITE_SANDBOXES = ['workspace-write', 'danger-full-access'];

/**
 * Refuse to launch an audit that is not read-only.
 * @param {string[]} args
 */
export function assertReadOnlyAudit(args) {
  for (const flag of FORBIDDEN_AUDIT_FLAGS) {
    if (args.includes(flag)) {
      throw new CommandError(
        `Refusing to run Codex with ${flag}. Audits are read-only.`,
      );
    }
  }

  const sandboxIndex = args.findIndex((arg) => arg === '-s' || arg === '--sandbox');
  if (sandboxIndex === -1 || args[sandboxIndex + 1] !== 'read-only') {
    throw new CommandError('Refusing to run Codex without --sandbox read-only.');
  }

  if (args.some((arg) => WRITE_SANDBOXES.includes(arg))) {
    throw new CommandError('Refusing to run Codex with a write-capable sandbox.');
  }

  return args;
}

/**
 * @param {{ lastMessageFile: string }} options
 * @returns {string[]}
 */
export function buildCodexArgs({ lastMessageFile }) {
  const args = [
    'exec',
    '--sandbox',
    'read-only',
    '--cd',
    REPO_ROOT,
    '--color',
    'never',
    '--output-last-message',
    lastMessageFile,
  ];

  if (process.env.AGENTLOOP_CODEX_MODEL) {
    args.push('--model', process.env.AGENTLOOP_CODEX_MODEL);
  }

  // `-` makes Codex read the prompt from stdin.
  args.push('-');

  return assertReadOnlyAudit(args);
}

/**
 * Run one read-only Codex audit.
 *
 * @param {{ prompt: string, onStdout?: (chunk: string) => void }} options
 * @returns {Promise<{ ok: boolean, text: string, raw: string, error: string|null }>}
 */
export async function runCodexAudit({ prompt, onStdout }) {
  const lastMessageFile = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'agentloop-audit-')),
    'audit.md',
  );

  // `--sandbox read-only` keeps the auditor from editing the code it is
  // reviewing. That is role separation — Codex must not quietly become the
  // implementer — not containment of a hostile process.
  try {
    const args = buildCodexArgs({ lastMessageFile });

    const outcome = await run(codexExecutable(), args, {
      cwd: REPO_ROOT,
      input: prompt,
      timeoutMs: LIMITS.codexTimeoutMs,
      onStdout,
    });

    if (outcome.timedOut) {
      throw new CommandError(`Codex timed out after ${LIMITS.codexTimeoutMs}ms.`);
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
      text,
      raw: outcome.stdout,
      error: outcome.code === 0 ? null : (outcome.stderr || outcome.stdout).slice(0, 2000),
    };
  } finally {
    fs.rmSync(path.dirname(lastMessageFile), { recursive: true, force: true });
  }
}
