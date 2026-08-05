// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  buildClaudeArgs,
  classifyClaudeOutcome,
  detectUsageLimit,
  formatClaudeProgress,
  parseClaudeResult,
  streamClaudeProgress,
} from './claude-agent.mjs';
import { assertReadOnlyAudit, buildCodexArgs } from './codex-agent.mjs';
import { assertSafeArg, run } from './process.mjs';

describe('detectUsageLimit', () => {
  it('reads the reset timestamp from the CLI message', () => {
    const resetSeconds = Math.floor(Date.now() / 1000) + 3600;
    const detected = detectUsageLimit(`Claude AI usage limit reached|${resetSeconds}`);
    expect(detected.limited).toBe(true);
    expect(detected.resumeAtMs).toBe(resetSeconds * 1000);
  });

  it('recognises a limit without a reset timestamp and falls back to a fixed pause', () => {
    const now = Date.now();
    const detected = detectUsageLimit('You have reached your usage limit for this period.', now);
    expect(detected.limited).toBe(true);
    expect(detected.resumeAtMs).toBeGreaterThan(now);
  });

  it('recognises the five-hour limit phrasing', () => {
    expect(detectUsageLimit('You have hit the 5-hour limit').limited).toBe(true);
  });

  it('recognises a rate-limit error', () => {
    expect(detectUsageLimit('{"type":"rate_limit_error"}').limited).toBe(true);
  });

  it('does not mistake ordinary output for a usage limit', () => {
    expect(detectUsageLimit('Implementation complete. All tests pass.').limited).toBe(false);
    expect(detectUsageLimit('').limited).toBe(false);
    expect(detectUsageLimit(undefined).limited).toBe(false);
  });
});

describe('classifyClaudeOutcome', () => {
  it('stays successful when a fully successful transcript happens to contain usage-limit text as repository content', () => {
    // Regression: during Task 4, Claude read claude-agent.mjs and its tests as
    // part of a successful run. The stream-json stdout — which includes tool
    // output like the file it read — contained the literal phrase "usage
    // limit reached" from this very detector's source and docstrings. A
    // successful process (exit 0, is_error false) must never be reclassified
    // as usage-limited on the strength of transcript content alone.
    const outcome = {
      code: 0,
      stdout:
        '{"type":"tool_result","content":"export function detectUsageLimit...  usage limit reached ..."}\n' +
        '{"type":"result","is_error":false,"session_id":"s1","result":"Implementation complete. All tests pass."}',
      stderr: '',
      timedOut: false,
    };
    const result = { is_error: false, session_id: 's1', result: 'Implementation complete. All tests pass.' };
    const text = result.result;

    const classified = classifyClaudeOutcome({ outcome, result, text, session: 's1' });

    expect(classified.ok).toBe(true);
    expect(classified.usageLimited).toBe(false);
    expect(classified.error).toBeNull();
  });

  it('reports a genuine usage limit when a failed run carries the reset phrase in its result', () => {
    const resetSeconds = Math.floor(Date.now() / 1000) + 3600;
    const outcome = { code: 1, stdout: '', stderr: '', timedOut: false };
    const result = {
      is_error: true,
      session_id: 's2',
      result: `Claude AI usage limit reached|${resetSeconds}`,
    };
    const text = result.result;

    const classified = classifyClaudeOutcome({ outcome, result, text, session: 's2' });

    expect(classified.ok).toBe(false);
    expect(classified.usageLimited).toBe(true);
    expect(classified.resumeAtMs).toBe(resetSeconds * 1000);
    expect(classified.sessionId).toBe('s2');
  });

  it('reports a genuine usage limit surfaced only on stderr of a failed run', () => {
    const outcome = { code: 1, stdout: '', stderr: 'Error: rate_limit_error', timedOut: false };

    const classified = classifyClaudeOutcome({ outcome, result: null, text: '', session: 's3' });

    expect(classified.usageLimited).toBe(true);
    expect(classified.ok).toBe(false);
  });

  it('reports an ordinary failure, not a usage limit, when a failed run has no limit phrase', () => {
    const outcome = { code: 1, stdout: '', stderr: 'TypeError: something broke', timedOut: false };
    const result = { is_error: true, session_id: 's4', result: 'TypeError: something broke' };

    const classified = classifyClaudeOutcome({ outcome, result, text: result.result, session: 's4' });

    expect(classified.ok).toBe(false);
    expect(classified.usageLimited).toBe(false);
    expect(classified.error).toBe('TypeError: something broke');
  });

  it('does not scan the raw transcript for a failed run when the result text is available', () => {
    // The failed run's *stdout* (full stream-json transcript) contains the
    // phrase from unrelated tool output, but the actual result text does
    // not — the narrower result/error fields must win.
    const outcome = {
      code: 1,
      stdout: 'some earlier tool output mentioned "usage limit reached" in a file it read',
      stderr: '',
      timedOut: false,
    };
    const result = { is_error: true, session_id: 's5', result: 'TypeError: something broke' };

    const classified = classifyClaudeOutcome({ outcome, result, text: result.result, session: 's5' });

    expect(classified.usageLimited).toBe(false);
    expect(classified.ok).toBe(false);
  });

  it('does not scan the stdout fallback for a failed run with no parsed result at all', () => {
    // Regression: when Claude's final result never parses, runClaude's `text`
    // falls back to the raw stdout transcript. That fallback must not reach
    // quota detection — with `result: null` and empty stderr, a failed run
    // whose raw stdout/tool output happens to contain "usage limit reached"
    // must be reported as an ordinary failure, not a quota error.
    const outcome = {
      code: 1,
      stdout: '{"type":"tool_result","content":"...usage limit reached... (unrelated tool output)"}',
      stderr: '',
      timedOut: false,
    };

    const classified = classifyClaudeOutcome({
      outcome,
      result: null,
      text: outcome.stdout,
      session: 's6',
    });

    expect(classified.usageLimited).toBe(false);
    expect(classified.ok).toBe(false);
  });

  it('still reports the raw stdout diagnostic as an ordinary failure when nothing else is available', () => {
    // Regression: excluding stdout from quota detection must not also drop
    // it as the terminal report's diagnostic. With no parsed result and no
    // stderr, the raw stdout/text is the only useful thing to show — it must
    // not be silently discarded into an empty error string.
    const outcome = {
      code: 1,
      stdout: 'Fatal: could not resolve tool "Edit" — unexpected internal error.',
      stderr: '',
      timedOut: false,
    };

    const classified = classifyClaudeOutcome({
      outcome,
      result: null,
      text: outcome.stdout,
      session: 's7',
    });

    expect(classified.ok).toBe(false);
    expect(classified.usageLimited).toBe(false);
    expect(classified.error).toContain('could not resolve tool "Edit"');
  });

  it('falls back to a generic failure message when result, stderr, and text are all empty', () => {
    const outcome = { code: 1, stdout: '', stderr: '', timedOut: false };

    const classified = classifyClaudeOutcome({ outcome, result: null, text: '', session: 's8' });

    expect(classified.ok).toBe(false);
    expect(classified.usageLimited).toBe(false);
    expect(classified.error).toBeTruthy();
    expect(classified.error).toBe('claude exited 1');
  });
});

describe('parseClaudeResult', () => {
  it('parses the result object', () => {
    const parsed = parseClaudeResult('{"type":"result","session_id":"abc","result":"done"}');
    expect(parsed.session_id).toBe('abc');
  });

  it('ignores leading non-JSON output', () => {
    const parsed = parseClaudeResult('warning: something\n{"type":"result","session_id":"abc"}');
    expect(parsed.session_id).toBe('abc');
  });

  it('returns null for unparsable output', () => {
    expect(parseClaudeResult('not json at all')).toBeNull();
    expect(parseClaudeResult('')).toBeNull();
  });
});

describe('buildClaudeArgs', () => {
  it('starts a new session with an explicit id', () => {
    const args = buildClaudeArgs({ sessionId: 'uuid-1', resume: false });
    expect(args).toContain('--session-id');
    expect(args).toContain('uuid-1');
    expect(args).not.toContain('--resume');
  });

  it('resumes an existing session', () => {
    const args = buildClaudeArgs({ sessionId: 'uuid-1', resume: true });
    expect(args).toContain('--resume');
    expect(args).not.toContain('--session-id');
  });

  it('requests verbose stream-json output without unsupported max-turns', () => {
    const args = buildClaudeArgs({ sessionId: 'uuid-1', resume: false });
    expect(args).toContain('--print');
    expect(args.join(' ')).toContain('--output-format stream-json');
    expect(args).toContain('--verbose');
    expect(args).not.toContain('--max-turns');
  });

  it('produces only arguments that are safe to pass through cmd.exe', () => {
    expect(() => buildClaudeArgs({ sessionId: 'uuid-1', resume: false }).forEach(assertSafeArg))
      .not.toThrow();
  });

  it('always passes --disallowedTools that refuses git push and gh', () => {
    // Publishing belongs to the controller, and only after Codex approves the
    // exact local HEAD. The disallowlist is passed to Claude Code
    // unconditionally, so an implementation turn has no command available that
    // could push partial work or coordinate through GitHub.
    const args = buildClaudeArgs({ sessionId: 'uuid-1', resume: false });
    const disallowIndex = args.indexOf('--disallowedTools');
    expect(disallowIndex).toBeGreaterThan(-1);
    const value = args[disallowIndex + 1];
    expect(value).toMatch(/git push/i);
    expect(value).toMatch(/gh/i);
  });

  it('never grants gh or git push in the default allowlist', () => {
    const args = buildClaudeArgs({ sessionId: 'uuid-1', resume: false });
    const allowIndex = args.indexOf('--allowedTools');
    const value = args[allowIndex + 1];
    expect(value).not.toMatch(/\bgh\b/i);
    expect(value).not.toMatch(/git push/i);
  });

  it('never grants an unbounded Bash(git *) in the default allowlist', () => {
    // `git *` would also admit option-prefixed forms like `git -C . push`,
    // which do not start with the literal string "git push" and so are not
    // caught by the --disallowedTools entries above. The allowlist enumerates
    // only specific git subcommands instead, so nothing else is grantable.
    const args = buildClaudeArgs({ sessionId: 'uuid-1', resume: false });
    const allowIndex = args.indexOf('--allowedTools');
    const value = args[allowIndex + 1];
    expect(value).not.toMatch(/Bash\(git \*\)/);
    expect(value).toMatch(/Bash\(git status\*\)/);
    expect(value).toMatch(/Bash\(git commit\*\)/);
  });
});

describe('Claude stream progress', () => {
  it('formats only supported stream-json progress events', () => {
    expect(formatClaudeProgress({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Inspecting files' }] },
    })).toBe('Inspecting files');
    expect(formatClaudeProgress({ type: 'content_block_delta', delta: { type: 'text_delta', text: '…' } }))
      .toBe('…');
    expect(formatClaudeProgress({ type: 'tool_use', name: 'Bash' })).toBe('using Bash');
    expect(formatClaudeProgress({ type: 'result', result: 'final report' })).toBeNull();
    expect(formatClaudeProgress({ type: 'unknown' })).toBeNull();
  });

  it('buffers split stdout chunks and ignores malformed lines', () => {
    const received = [];
    const onStdout = streamClaudeProgress((progress) => received.push(progress));
    onStdout('{"type":"assistant","message":{"content":[{"type":"text","text":"hello');
    onStdout(' world"}]}}\nnot-json\n');
    expect(received).toEqual(['hello world']);
  });
});

describe('command timeouts', () => {
  it('reports a timeout after terminating the spawned process tree', async () => {
    const outcome = await run(process.execPath, ['-e', 'setTimeout(console.log,10000)'], {
      timeoutMs: 25,
    });
    expect(outcome.timedOut).toBe(true);
    expect(outcome.code).not.toBe(0);
  }, 10_000);
});

describe('codex audits are read-only', () => {
  it('always passes --sandbox read-only', () => {
    const args = buildCodexArgs({ lastMessageFile: 'audit.md' });
    expect(args.slice(args.indexOf('--sandbox'), args.indexOf('--sandbox') + 2)).toEqual([
      '--sandbox',
      'read-only',
    ]);
  });

  it('reads the prompt from stdin rather than the command line', () => {
    expect(buildCodexArgs({ lastMessageFile: 'audit.md' })).toContain('-');
  });

  it('refuses a write-capable sandbox', () => {
    expect(() => assertReadOnlyAudit(['exec', '--sandbox', 'workspace-write'])).toThrow(/read-only/);
    expect(() => assertReadOnlyAudit(['exec', '--sandbox', 'danger-full-access'])).toThrow(
      /read-only/,
    );
  });

  it('refuses a missing sandbox flag', () => {
    expect(() => assertReadOnlyAudit(['exec', '-'])).toThrow(/without --sandbox read-only/);
  });

  it('refuses the approval and hook-trust bypasses', () => {
    expect(() =>
      assertReadOnlyAudit(['exec', '--sandbox', 'read-only', '--dangerously-bypass-approvals-and-sandbox']),
    ).toThrow(/read-only/);
    expect(() =>
      assertReadOnlyAudit(['exec', '--sandbox', 'read-only', '--dangerously-bypass-hook-trust']),
    ).toThrow(/read-only/);
  });

  it('refuses to widen the writable directories', () => {
    expect(() =>
      assertReadOnlyAudit(['exec', '--sandbox', 'read-only', '--add-dir', 'C:/']),
    ).toThrow(/read-only/);
  });

  it('produces only arguments that are safe to pass through cmd.exe', () => {
    expect(() => buildCodexArgs({ lastMessageFile: 'audit.md' }).forEach(assertSafeArg)).not.toThrow();
  });
});

describe('assertSafeArg', () => {
  it('refuses shell metacharacters', () => {
    for (const bad of ['a&b', 'a|b', 'a>b', 'a<b', 'a^b', '%PATH%', 'say "hi"', 'a\nb']) {
      expect(() => assertSafeArg(bad)).toThrow(/metacharacters|stdin/);
    }
  });

  it('allows the arguments the controller actually builds', () => {
    for (const good of [
      '--sandbox',
      'read-only',
      'C:\\Users\\example\\Projects\\example-repo',
      'Read,Edit,Bash(git *)',
      'a1b2c3d4e5f6',
      'feat/agent-automation-foundation',
    ]) {
      expect(assertSafeArg(good)).toBe(good);
    }
  });

  it('refuses a non-string argument', () => {
    expect(() => assertSafeArg(5)).toThrow(/must be strings/);
  });
});
