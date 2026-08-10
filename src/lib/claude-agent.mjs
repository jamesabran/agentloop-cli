/**
 * Claude agent runs — print mode with optional PreToolUse permission relay.
 *
 * Flags used here were checked against the installed `claude --help`
 * (2.1.221): `-p/--print`, `--output-format stream-json`, `--verbose`,
 * `--session-id`, `--resume`,
 * `--permission-mode`, `--allowedTools`, `--add-dir`, `--model`,
 * `--settings`. The prompt is supplied on stdin.
 *
 * Claude's progress stream is shown to the controller console as it arrives.
 * A process failure or usage limit is reported to the controller, which
 * records a terminal local report and requires explicit recovery.
 *
 * When an interactive terminal is available, a PreToolUse hook is
 * configured so that permission requests for tools outside the static
 * allowlist are relayed to the user via `.agent/permission-request.json`
 * and `.agent/permission-response.json` file IPC.
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';

import {
  CLAUDE_ALLOWED_TOOLS,
  CLAUDE_CLI_PERMISSION_MODE,
  CLAUDE_DISALLOWED_TOOLS,
  CLAUDE_HARD_DENY_PATTERNS,
  CLAUDE_PERMISSION_MODE,
  LIMITS,
  REPO_ROOT,
} from './config.mjs';
import {
  checkHardDeny,
  cleanRelayFiles,
  createRelayWorkDir,
  pollForRequest,
  promptUser,
  removeRelayWorkDir,
  writeHookSettings,
  writeResponse,
} from './permission-relay.mjs';
import { npmGlobalDirs, resolveExecutable, run } from './process.mjs';

let claudePath = null;

export function claudeExecutable() {
  claudePath ??= resolveExecutable('claude', {
    override: process.env.AGENTLOOP_CLAUDE_BIN,
    extraDirs: npmGlobalDirs(),
  });
  return claudePath;
}

/**
 * Recognise a temporary usage limit in Claude's output.
 *
 * Print mode reports the limit as text rather than a distinct exit code, so
 * this matches the known phrasings. `Claude AI usage limit reached|<epoch>`
 * carries the reset time in Unix seconds; the other forms do not, and fall
 * back to a fixed pause.
 *
 * @param {string} text combined stdout, stderr, and result text
 * @param {number} [now] epoch milliseconds
 * @returns {{ limited: boolean, resumeAtMs: number|null, evidence: string|null }}
 */
export function detectUsageLimit(text, now = Date.now()) {
  const haystack = String(text ?? '');

  const withReset = /usage limit reached\|(\d{9,13})/i.exec(haystack);
  if (withReset) {
    const raw = Number(withReset[1]);
    const resumeAtMs = raw > 1e12 ? raw : raw * 1000;
    return { limited: true, resumeAtMs, evidence: withReset[0] };
  }

  const phrases = [
    /usage limit reached/i,
    /(?:reached|hit|exceeded) your (?:usage |account )?limit/i,
    /rate[_ -]?limit(?:ed|_error)?\b/i,
    /\b(?:5|five)[- ]hour limit\b/i,
    /upgrade to increase your usage limit/i,
    /resets? at \d/i,
  ];

  for (const pattern of phrases) {
    const match = pattern.exec(haystack);
    if (match) {
      return {
        limited: true,
        resumeAtMs: now + LIMITS.usageLimitFallbackMs,
        evidence: match[0],
      };
    }
  }

  return { limited: false, resumeAtMs: null, evidence: null };
}

/**
 * Build the argument list for a Claude run.
 *
 * @param {{ sessionId: string|null, resume: boolean }} options
 * @returns {string[]}
 */
export function buildClaudeArgs({ sessionId, resume }) {
  const args = [
    '--print',
    '--output-format',
    'stream-json',
    '--verbose',
    '--permission-mode',
    CLAUDE_CLI_PERMISSION_MODE,
    '--add-dir',
    REPO_ROOT,
  ];

  if (resume && sessionId) {
    args.push('--resume', sessionId);
  } else if (sessionId) {
    args.push('--session-id', sessionId);
  }

  if (process.env.AGENTLOOP_CLAUDE_MODEL) {
    args.push('--model', process.env.AGENTLOOP_CLAUDE_MODEL);
  }

  args.push('--allowedTools', CLAUDE_ALLOWED_TOOLS);
  args.push('--disallowedTools', CLAUDE_DISALLOWED_TOOLS);

  return args;
}

/** Pull the `type: "result"` object out of `--output-format json` stdout. */
export function parseClaudeResult(stdout) {
  const text = String(stdout ?? '').trim();
  if (text === '') return null;

  const candidates = [text, ...text.split(/\r?\n/).reverse()];
  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      // Keep looking.
    }
  }
  return null;
}

/**
 * Return human-readable progress from supported Claude stream-json events.
 */
export function formatClaudeProgress(event) {
  if (!event || typeof event !== 'object') return null;

  if (event.type === 'assistant') {
    const content = event.message?.content;
    if (!Array.isArray(content)) return null;
    const text = content
      .filter((part) => part?.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('')
      .trim();
    return text || null;
  }

  if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
    return typeof event.delta.text === 'string' && event.delta.text !== '' ? event.delta.text : null;
  }

  if (event.type === 'tool_use' && typeof event.name === 'string') {
    return `using ${event.name}`;
  }

  return null;
}

/** Turn arbitrarily split stdout chunks into supported progress messages. */
export function streamClaudeProgress(onProgress) {
  let buffered = '';
  return (chunk) => {
    buffered += String(chunk ?? '');
    const lines = buffered.split(/\r?\n/);
    buffered = lines.pop() ?? '';
    for (const line of lines) {
      try {
        const progress = formatClaudeProgress(JSON.parse(line));
        if (progress) onProgress(progress);
      } catch {
        // Stream output is untrusted. Only well-formed supported events print.
      }
    }
  };
}

/** The first non-blank string among `candidates`, or `null` if none qualify. */
function firstNonEmpty(...candidates) {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate;
  }
  return null;
}

/**
 * Turn a completed Claude process outcome into the run's final result.
 */
export function classifyClaudeOutcome({ outcome, result, text, session }) {
  const failed = outcome.code !== 0 || result?.is_error === true;

  const parsedResultText = typeof result?.result === 'string' ? result.result : '';
  const usage = failed
    ? detectUsageLimit([outcome.stderr, parsedResultText].join('\n'))
    : { limited: false, resumeAtMs: null, evidence: null };

  if (usage.limited) {
    return {
      ok: false,
      usageLimited: true,
      resumeAtMs: usage.resumeAtMs,
      sessionId: result?.session_id ?? session,
      text,
      raw: outcome.stdout,
      error: `Temporary usage limit: ${usage.evidence}`,
    };
  }

  const diagnostic =
    firstNonEmpty(result?.result, outcome.stderr, text) ?? `claude exited ${outcome.code}`;

  return {
    ok: !failed,
    usageLimited: false,
    resumeAtMs: null,
    sessionId: result?.session_id ?? session,
    text,
    raw: outcome.stdout,
    error: failed ? diagnostic.slice(0, 2000) : null,
  };
}

/**
 * Run one Claude turn, with optional interactive permission relay.
 *
 * When stdin is a TTY, a PreToolUse hook is configured so permission
 * requests for tools outside the static `--allowedTools` list are relayed
 * to the controller's terminal.  The hook is only set up when TTY is
 * available and `AGENTLOOP_DISABLE_PERMISSION_RELAY` is not set.
 *
 * @param {{
 *   prompt: string,
 *   sessionId?: string|null,
 *   resume?: boolean,
 *   onStdout?: (chunk: string) => void,
 *   onLog?: (line: string) => void,
 * }} options
 * @returns {Promise<{
 *   ok: boolean, usageLimited: boolean, resumeAtMs: number|null,
 *   sessionId: string|null, text: string, raw: string, error: string|null,
 *   timedOut?: boolean,
 * }>}
 */
export async function runClaude({ prompt, sessionId = null, resume = false, onStdout, onLog }) {
  const session = sessionId ?? randomUUID();
  const args = buildClaudeArgs({ sessionId: session, resume });

  // Permission relay: only for standard `claude` binary in interactive mode.
  const isStandardClaude =
    !process.env.AGENTLOOP_CLAUDE_BIN ||
    path.basename(process.env.AGENTLOOP_CLAUDE_BIN) === 'claude' ||
    path.basename(process.env.AGENTLOOP_CLAUDE_BIN) === 'claude.cmd';

  const relayEnabled =
    CLAUDE_PERMISSION_MODE === 'interactive' &&
    process.stdin.isTTY &&
    isStandardClaude &&
    !process.env.AGENTLOOP_DISABLE_PERMISSION_RELAY;

  // Temp directory OUTSIDE the repo — Claude's Write tool is restricted to
  // REPO_ROOT, so it cannot reach the hook artefacts or forge a response.
  let relayWorkDir = null;

  if (relayEnabled) {
    relayWorkDir = createRelayWorkDir();
    const allowedList = CLAUDE_ALLOWED_TOOLS.split(',').map((s) => s.trim()).filter(Boolean);
    const { settingsPath } = writeHookSettings(relayWorkDir, {
      denyPatterns: [...CLAUDE_HARD_DENY_PATTERNS],
      allowPatterns: allowedList,
    });

    args.push('--settings', settingsPath);
    onLog?.('[claude-agent] permission relay enabled (workDir: ' + relayWorkDir + ')');
  } else if (!isStandardClaude) {
    onLog?.('[claude-agent] permission relay skipped (non-standard binary)');
  }

  onLog?.('[claude-agent] starting session');
  onLog?.(`[claude-agent] session ${session}${resume ? ' (resume)' : ''}`);

  // Permission watcher runs concurrently with the Claude process.
  let watcherStop = false;

  const watcher = relayEnabled
    ? (async () => {
        const wd = relayWorkDir;
        while (!watcherStop) {
          const request = await pollForRequest(wd, 500);
          if (!request) continue;

          const toolName = request.tool_name;
          const toolInput = request.tool_input ?? {};
          const nonce = typeof request.nonce === 'string' ? request.nonce : null;
          const toolUseId = typeof request.tool_use_id === 'string' ? request.tool_use_id : 'unknown';

          // Belt-and-braces hard-deny re-check.
          const hardCheck = checkHardDeny(toolName, toolInput, CLAUDE_HARD_DENY_PATTERNS);
          if (hardCheck.denied) {
            writeResponse(wd, toolUseId, {
              approved: false,
              nonce,
              reason: 'Blocked by ALCLI hard-deny rule: ' + hardCheck.matchedPattern,
            });
            onLog?.('[claude-agent] hard-denied: ' + hardCheck.matchedPattern);
            continue;
          }

          // Prompt the user.
          const choice = await promptUser({ toolName, toolInput });

          if (choice === null) {
            writeResponse(wd, toolUseId, {
              approved: false,
              nonce,
              reason: 'Permission denied (non-interactive).',
            });
            continue;
          }

          if (choice.kind === 'deny') {
            writeResponse(wd, toolUseId, { approved: false, nonce, reason: 'Permission denied by user.' });
            onLog?.('[claude-agent] permission denied by user');
            continue;
          }

          writeResponse(wd, toolUseId, { approved: true, nonce });
          onLog?.('[claude-agent] permission approved');
        }
      })()
    : Promise.resolve();

  // Run Claude to completion.
  let outcome;
  try {
    outcome = await run(claudeExecutable(), args, {
      cwd: REPO_ROOT,
      input: prompt,
      timeoutMs: LIMITS.claudeTimeoutMs,
      onStdout,
    });
  } finally {
    // Stop the watcher and clean up the temp relay directory.
    watcherStop = true;
    if (relayEnabled) {
      await watcher;
      removeRelayWorkDir(relayWorkDir);
    }
  }

  const result = parseClaudeResult(outcome.stdout);
  const text = typeof result?.result === 'string' ? result.result : outcome.stdout;

  const classified = classifyClaudeOutcome({ outcome, result, text, session });
  if (classified.usageLimited) return classified;

  if (outcome.timedOut) {
    return {
      ok: false,
      usageLimited: false,
      resumeAtMs: null,
      sessionId: result?.session_id ?? session,
      text,
      raw: outcome.stdout,
      error: `Claude timed out after ${LIMITS.claudeTimeoutMs}ms.`,
      timedOut: true,
    };
  }

  return classified;
}
