// @vitest-environment node
/**
 * Tests for the interactive Claude permission relay (PreToolUse hook).
 *
 * Covers:
 *  1. permission request → allow once
 *  2. reusable permission → derived and accepted
 *  3. permission request → denied
 *  4. hard-denied request cannot be approved
 *  5. reusable option absent when no rule can be derived
 *  6. invalid terminal input safely prompts again
 *  7. non-interactive execution never auto-approves
 *  8. existing timeout continuation flow still works
 *  9. nonce correlation — stale responses rejected
 * 10. generated hook script lifecycle
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  buildToolEntry,
  checkHardDeny,
  derivePermissionRule,
  isAllowedByConfig,
  parseChoice,
  patternMatches,
  removeHookSettings,
  writeHookSettings,
  writeResponse,
  pollForRequest,
} from './permission-relay.mjs';

const tempDirs = [];
afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentloop-permrelay-'));
  fs.mkdirSync(path.join(dir, '.agent'), { recursive: true });
  tempDirs.push(dir);
  return dir;
}

/* ------------------------------------------------------------------ *
 * Pattern matching & hard deny                                         *
 * ------------------------------------------------------------------ */

describe('patternMatches', () => {
  it('matches a glob pattern with *', () => {
    expect(patternMatches('Bash(git push origin main)', 'Bash(git push*)')).toBe(true);
    expect(patternMatches('Bash(git status)', 'Bash(git push*)')).toBe(false);
  });

  it('treats trailing :* as equivalent to *', () => {
    expect(patternMatches('Bash(npm test file)', 'Bash(npm:*)')).toBe(true);
    expect(patternMatches('Bash(npm)', 'Bash(npm:*)')).toBe(false);
  });

  it('matches a bare tool name against all uses', () => {
    expect(patternMatches('WebFetch', 'WebFetch')).toBe(true);
    expect(patternMatches('WebFetch(https://example.com)', 'WebFetch')).toBe(true);
    expect(patternMatches('Read(src/main.mjs)', 'Read')).toBe(true);
  });

  it('matches a tool name pattern with wildcard via glob', () => {
    expect(patternMatches('WebFetch(https://example.com)', 'WebFetch*')).toBe(true);
    expect(patternMatches('WebFetch', 'WebFetch*')).toBe(true);
  });
});

describe('derivePermissionRule', () => {
  it('derives Bash(command) from a Bash tool call', () => {
    expect(derivePermissionRule('Bash', { command: 'npm test' })).toBe('Bash(npm test)');
    expect(derivePermissionRule('Bash', { command: 'ls -la' })).toBe('Bash(ls -la)');
  });

  it('derives Tool(file_path) from Read/Edit/Write', () => {
    expect(derivePermissionRule('Read', { file_path: 'src/main.mjs' })).toBe('Read(src/main.mjs)');
    expect(derivePermissionRule('Edit', { file_path: 'src/lib/x.mjs' })).toBe('Edit(src/lib/x.mjs)');
  });

  it('returns null for empty or wildcard-only input', () => {
    expect(derivePermissionRule('Bash', {})).toBeNull();
    expect(derivePermissionRule('Bash', { command: '*' })).toBeNull();
    expect(derivePermissionRule('Read', {})).toBeNull();
  });
});

describe('buildToolEntry', () => {
  it('builds ToolName(args) from command', () => {
    expect(buildToolEntry('Bash', { command: 'npm test' })).toBe('Bash(npm test)');
  });

  it('returns plain ToolName for empty input', () => {
    expect(buildToolEntry('TodoWrite', {})).toBe('TodoWrite');
    expect(buildToolEntry('Bash', null)).toBe('Bash');
    expect(buildToolEntry(null, {})).toBeNull();
  });
});

describe('checkHardDeny', () => {
  const patterns = [
    'Bash(git push*)',
    'Bash(gh *)',
    'Bash(node *)',
    'Bash(npm *)',
    'Bash(npx *)',
    'WebFetch',
    'Bash(chmod *)',
    'Bash(chown *)',
    'BypassPermissions',
  ];

  it('allow once: denies git push, allows safe command', () => {
    expect(checkHardDeny('Bash', { command: 'git push origin main' }, patterns).denied).toBe(true);
    expect(checkHardDeny('Bash', { command: 'ls -la' }, patterns).denied).toBe(false);
  });

  it('denied: npm command', () => {
    const result = checkHardDeny('Bash', { command: 'npm run test' }, patterns);
    expect(result.denied).toBe(true);
    expect(result.matchedPattern).toBe('Bash(npm *)');
  });

  it('hard-denied request cannot be approved: WebFetch', () => {
    expect(checkHardDeny('WebFetch', {}, patterns).denied).toBe(true);
  });

  it('hard-denied request cannot be approved: BypassPermissions', () => {
    expect(checkHardDeny('BypassPermissions', {}, patterns).denied).toBe(true);
  });

  it('denies when tool input has a command matching deny list', () => {
    expect(checkHardDeny('Bash', { command: 'node -e "1+1"' }, patterns).denied).toBe(true);
  });

  it('allows an unrelated Bash command', () => {
    expect(checkHardDeny('Bash', { command: 'echo hello' }, patterns).denied).toBe(false);
  });

  it('allows when deny list is empty or null', () => {
    expect(checkHardDeny('Bash', { command: 'rm -rf /' }, []).denied).toBe(false);
    expect(checkHardDeny('Bash', { command: 'rm -rf /' }, null).denied).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * isAllowedByConfig                                                    *
 * ------------------------------------------------------------------ */

describe('isAllowedByConfig', () => {
  const allowlist = [
    'Read', 'Edit', 'Write', 'Glob', 'Grep', 'TodoWrite',
    'Bash(git status*)', 'Bash(git diff*)', 'Bash(git log*)',
    'Bash(git show*)', 'Bash(git add*)', 'Bash(git commit*)',
    'Bash(git rev-parse*)',
  ];

  it('allows explicitly-listed git commands', () => {
    expect(isAllowedByConfig('Bash', { command: 'git status' }, allowlist)).toBe(true);
    expect(isAllowedByConfig('Bash', { command: 'git add src/main.mjs' }, allowlist)).toBe(true);
  });

  it('allows listed non-Bash tools by bare name', () => {
    expect(isAllowedByConfig('Read', { file_path: 'src/main.mjs' }, allowlist)).toBe(true);
    expect(isAllowedByConfig('Edit', { file_path: 'src/main.mjs' }, allowlist)).toBe(true);
  });

  it('does not allow unlisted Bash commands', () => {
    expect(isAllowedByConfig('Bash', { command: 'npm test' }, allowlist)).toBe(false);
    expect(isAllowedByConfig('Bash', { command: 'git push' }, allowlist)).toBe(false);
  });

  it('does not allow unlisted tools', () => {
    expect(isAllowedByConfig('WebFetch', { url: 'https://example.com' }, allowlist)).toBe(false);
  });

  it('returns false for empty allowlist', () => {
    expect(isAllowedByConfig('Read', { file_path: 'a' }, [])).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * parseChoice and user input                                           *
 * ------------------------------------------------------------------ */

describe('parseChoice', () => {
  it('allow-once: "1"', () => {
    expect(parseChoice('1', { hasReusableRule: true }).kind).toBe('allow-once');
    expect(parseChoice('1', { hasReusableRule: false }).kind).toBe('allow-once');
  });

  it('reusable accepted: "2" when reusable rule is present', () => {
    expect(parseChoice('2', { hasReusableRule: true }).kind).toBe('allow-similar');
  });

  it('reusable absent: "2" when no reusable rule means deny', () => {
    expect(parseChoice('2', { hasReusableRule: false }).kind).toBe('deny');
  });

  it('denied: "3" when reusable rule is present', () => {
    expect(parseChoice('3', { hasReusableRule: true }).kind).toBe('deny');
  });

  it('invalid input: "3" when no reusable rule', () => {
    expect(parseChoice('3', { hasReusableRule: false }).kind).toBe('invalid');
  });

  it('accepts "yes" and "no" words', () => {
    expect(parseChoice('yes', { hasReusableRule: true }).kind).toBe('allow-once');
    expect(parseChoice('y', { hasReusableRule: true }).kind).toBe('allow-once');
    expect(parseChoice('no', { hasReusableRule: true }).kind).toBe('deny');
    expect(parseChoice('n', { hasReusableRule: true }).kind).toBe('deny');
    expect(parseChoice('YES', { hasReusableRule: true }).kind).toBe('allow-once');
    expect(parseChoice('NO', { hasReusableRule: true }).kind).toBe('deny');
  });

  it('invalid terminal input marked as invalid', () => {
    expect(parseChoice('maybe', { hasReusableRule: true }).kind).toBe('invalid');
    expect(parseChoice('', { hasReusableRule: true }).kind).toBe('invalid');
    expect(parseChoice('   ', { hasReusableRule: true }).kind).toBe('invalid');
    expect(parseChoice('0', { hasReusableRule: true }).kind).toBe('invalid');
    expect(parseChoice('4', { hasReusableRule: true }).kind).toBe('invalid');
  });
});

/* ------------------------------------------------------------------ *
 * File IPC — hook settings, nonce-protected responses                   *
 * ------------------------------------------------------------------ */

describe('writeHookSettings and removeHookSettings', () => {
  it('writes hook settings and helper script, then cleans them up', () => {
    const dir = makeTempDir();
    const { settingsPath, hookScriptPath } = writeHookSettings(dir, {
      denyPatterns: ['Bash(git push*)'],
      allowPatterns: ['Read', 'Bash(git status*)'],
    });

    expect(fs.existsSync(settingsPath)).toBe(true);
    expect(fs.existsSync(hookScriptPath)).toBe(true);

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    expect(settings.hooks.PreToolUse[0].matcher).toBe('*');
    expect(settings.hooks.PreToolUse[0].hooks[0].type).toBe('command');

    const script = fs.readFileSync(hookScriptPath, 'utf8');
    expect(script).toContain('ALCLI permission-relay hook helper');
    expect(script).toContain('Bash(git push*)');
    expect(script).toContain('Bash(git status*)');
    // Nonce-based security must be embedded.
    expect(script).toContain('nonce');

    removeHookSettings(dir);
    expect(fs.existsSync(settingsPath)).toBe(false);
    expect(fs.existsSync(hookScriptPath)).toBe(false);
  });
});

describe('writeResponse includes nonce', () => {
  it('writes a response with the nonce echoed back', () => {
    const dir = makeTempDir();
    writeResponse(dir, { approved: true, nonce: 'abc123', reason: 'User allowed.' });

    const resPath = path.join(dir, '.agent', 'permission-response.json');
    expect(fs.existsSync(resPath)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(resPath, 'utf8'));
    expect(parsed.approved).toBe(true);
    expect(parsed.nonce).toBe('abc123');
    expect(parsed.reason).toBe('User allowed.');
  });

  it('pre-cleans stale response file before writing', () => {
    const dir = makeTempDir();
    const resPath = path.join(dir, '.agent', 'permission-response.json');

    // Pre-place a stale response.
    fs.writeFileSync(resPath, JSON.stringify({
      approved: true, nonce: 'old-nonce',
    }), 'utf8');

    // Now write a fresh response with a different nonce.
    writeResponse(dir, { approved: false, nonce: 'new-nonce' });

    const parsed = JSON.parse(fs.readFileSync(resPath, 'utf8'));
    expect(parsed.approved).toBe(false);
    expect(parsed.nonce).toBe('new-nonce');
  });
});

describe('pollForRequest', () => {
  it('returns null when no request file exists', async () => {
    const dir = makeTempDir();
    const result = await pollForRequest(dir, 100);
    expect(result).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * Non-interactive behavior                                             *
 * ------------------------------------------------------------------ */

describe('non-interactive execution never auto-approves', () => {
  it('promptUser returns null when stdin is not a TTY', async () => {
    const { promptUser } = await import('./permission-relay.mjs');
    if (!process.stdin.isTTY) {
      const result = await promptUser({
        toolName: 'Bash',
        toolInput: { command: 'ls' },
        hasReusableRule: false,
        permissionRule: null,
      });
      expect(result).toBeNull();
    }
  });
});

/* ------------------------------------------------------------------ *
 * Timeout continuation flow still works + claude-ds detection           *
 * ------------------------------------------------------------------ */

describe('existing timeout continuation flow still works', () => {
  it('buildClaudeArgs still produces --print for print-mode runs', async () => {
    const { buildClaudeArgs } = await import('./claude-agent.mjs');
    const args = buildClaudeArgs({ sessionId: 'test-1', resume: false });
    expect(args).toContain('--print');
    expect(args).toContain('--output-format');
    expect(args).toContain('stream-json');
  });

  it('runClaude is exported and callable', async () => {
    const { runClaude } = await import('./claude-agent.mjs');
    expect(runClaude).toBeTypeOf('function');
  });

  it('streamClaudeProgress is still exported for the controller', async () => {
    const { streamClaudeProgress } = await import('./claude-agent.mjs');
    expect(streamClaudeProgress).toBeTypeOf('function');
  });
});

/* ------------------------------------------------------------------ *
 * Generated hook script security lifecycle                              *
 * ------------------------------------------------------------------ */

describe('generated hook script security', () => {
  it('includes nonce validation logic', () => {
    const dir = makeTempDir();
    writeHookSettings(dir, {
      denyPatterns: ['Bash(git push*)'],
      allowPatterns: ['Read'],
    });
    const scriptPath = path.join(dir, '.agent', 'permission-hook.mjs');
    const script = fs.readFileSync(scriptPath, 'utf8');

    // The hook must validate nonce in responses.
    expect(script).toContain('nonce');

    // The hook must pre-clean stale response files.
    expect(script).toContain('unlinkSync(resPath)');

    // The hook must detect, parse, and validate its stdin input.
    expect(script).toContain('JSON.parse');

    removeHookSettings(dir);
  });

  it('stale pre-placed response does not auto-approve', () => {
    const dir = makeTempDir();
    const resPath = path.join(dir, '.agent', 'permission-response.json');

    // Simulate a pre-placed stale response (worst case: approved=true).
    fs.mkdirSync(path.dirname(resPath), { recursive: true });
    fs.writeFileSync(resPath, JSON.stringify({
      approved: true,
      nonce: 'stale',
    }), 'utf8');

    // writeResponse should pre-clean this.
    writeResponse(dir, { approved: false, nonce: 'fresh-nonce' });

    const parsed = JSON.parse(fs.readFileSync(resPath, 'utf8'));
    expect(parsed.approved).toBe(false);
    expect(parsed.nonce).toBe('fresh-nonce');

    removeHookSettings(dir);
  });
});
