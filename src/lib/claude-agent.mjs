/**
 * Non-interactive Claude runs.
 *
 * Flags used here were checked against the installed `claude --help`
 * (2.1.221): `-p/--print`, `--output-format stream-json`, `--verbose`,
 * `--session-id`, `--resume`,
 * `--permission-mode`, `--allowedTools`, `--add-dir`, `--model`. The prompt is
 * supplied on stdin.
 *
 * Claude's progress stream is shown to the controller console as it arrives.
 * A process failure or usage limit is reported to the controller, which
 * records a terminal local report and requires explicit recovery.
 */

import { randomUUID } from 'node:crypto';

import {
  CLAUDE_ALLOWED_TOOLS,
  CLAUDE_DISALLOWED_TOOLS,
  CLAUDE_PERMISSION_MODE,
  LIMITS,
  REPO_ROOT,
} from './config.mjs';
import { CommandError, npmGlobalDirs, resolveExecutable, run } from './process.mjs';

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
    // The CLI reports seconds; tolerate milliseconds.
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
    CLAUDE_PERMISSION_MODE,
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

  // One argument: the tool patterns contain spaces, so they cannot be split.
  args.push('--allowedTools', CLAUDE_ALLOWED_TOOLS);

  // The disallow list is applied unconditionally and takes precedence over
  // the allowlist inside Claude Code, so even a mistaken `--allowedTools`
  // value cannot re-open `gh pr merge` or the `gh api` HTTP client.
  args.push('--disallowedTools', CLAUDE_DISALLOWED_TOOLS);

  return args;
}

/** Pull the `type: "result"` object out of `--output-format json` stdout. */
export function parseClaudeResult(stdout) {
  const text = String(stdout ?? '').trim();
  if (text === '') return null;

  // Normally a single JSON object; be tolerant of leading progress lines.
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
 * Unknown events stay private implementation detail rather than being dumped
 * as raw JSON into the controller log.
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
 *
 * Usage-limit text is only authoritative next to a genuine failure signal —
 * a non-zero exit or an explicit `result.is_error === true`. On a fully
 * successful run, the same phrases can appear legitimately in ordinary
 * transcript or tool content (Claude reading this file's tests, for
 * example), so detection is skipped entirely rather than risk a false
 * positive. The text searched is also kept narrow — stderr and an explicitly
 * parsed `result.result` string, never the raw stream-json stdout (which
 * carries the full transcript including tool output) even when it is the
 * only text available, such as when `result` failed to parse.
 *
 * @param {{
 *   outcome: { code: number|null, stdout: string, stderr: string, timedOut: boolean },
 *   result: { is_error?: boolean, result?: string, session_id?: string }|null,
 *   text: string,
 *   session: string,
 * }} args
 */
export function classifyClaudeOutcome({ outcome, result, text, session }) {
  const failed = outcome.code !== 0 || result?.is_error === true;

  // Quota evidence may only come from stderr and an explicitly parsed final
  // result message — never the raw stdout. `text` falls back to that raw
  // stdout when `result` failed to parse, so it is unsafe to reuse here.
  const parsedResultText = typeof result?.result === 'string' ? result.result : '';
  const usage = failed
    ? detectUsageLimit([outcome.stderr, parsedResultText].join('\n'))
    : { limited: false, resumeAtMs: null, evidence: null };

  if (usage.limited) {
    return {
      ok: false,
      usageLimited: true,
      resumeAtMs: usage.resumeAtMs,
      // The session is kept precisely so the paused task can be resumed.
      sessionId: result?.session_id ?? session,
      text,
      raw: outcome.stdout,
      error: `Temporary usage limit: ${usage.evidence}`,
    };
  }

  // Not quota evidence, but still useful for the terminal report: prefer the
  // parsed result, then stderr, then whatever raw diagnostic `text` carries
  // (its own stdout fallback when `result` didn't parse), before giving up
  // with a generic message rather than an empty string.
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
 * Run one Claude turn.
 *
 * @param {{
 *   prompt: string,
 *   sessionId?: string|null,
 *   resume?: boolean,
 *   onStdout?: (chunk: string) => void,
 * }} options
 * @returns {Promise<{
 *   ok: boolean, usageLimited: boolean, resumeAtMs: number|null,
 *   sessionId: string|null, text: string, raw: string, error: string|null,
 * }>}
 */
export async function runClaude({ prompt, sessionId = null, resume = false, onStdout }) {
  const session = sessionId ?? randomUUID();
  const args = buildClaudeArgs({ sessionId: session, resume });

  // Claude runs on the host with the owner's credentials, as a trusted
  // collaborator. That is a deliberate choice for this experimental phase.
  const outcome = await run(claudeExecutable(), args, {
    cwd: REPO_ROOT,
    input: prompt,
    timeoutMs: LIMITS.claudeTimeoutMs,
    onStdout,
  });

  const result = parseClaudeResult(outcome.stdout);
  const text = typeof result?.result === 'string' ? result.result : outcome.stdout;

  const classified = classifyClaudeOutcome({ outcome, result, text, session });
  if (classified.usageLimited) return classified;

  if (outcome.timedOut) {
    throw new CommandError(`Claude timed out after ${LIMITS.claudeTimeoutMs}ms.`);
  }

  return classified;
}
