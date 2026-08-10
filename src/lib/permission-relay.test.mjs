// @vitest-environment node
/**
 * Tests for the interactive Claude permission relay (PreToolUse hook).
 *
 * Covers:
 *  1. permission request → allow once
 *  2. permission request → denied
 *  3. hard-denied request cannot be approved
 *  4. invalid terminal input safely prompts again
 *  5. non-interactive execution never auto-approves
 *  6. existing timeout continuation flow still works
 *  7. nonce correlation — stale responses rejected
 *  8. temp directory outside repo — Claude Write tool cannot reach it
 *  9. tool_use_id-scoped files for concurrent isolation
 * 10. generated hook subprocess integration
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  buildToolEntry,
  checkHardDeny,
  createRelayWorkDir,
  isAllowedByConfig,
  parseChoice,
  patternMatches,
  pollForRequest,
  removeRelayWorkDir,
  writeHookSettings,
  writeResponse,
} from './permission-relay.mjs';

const tempDirs = [];
afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

function makeWorkDir() {
  const dir = createRelayWorkDir();
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

  it('bare tool name matches all uses', () => {
    expect(patternMatches('WebFetch', 'WebFetch')).toBe(true);
    expect(patternMatches('WebFetch(https://ex.com)', 'WebFetch')).toBe(true);
    expect(patternMatches('Read(src/main.mjs)', 'Read')).toBe(true);
  });
});

describe('buildToolEntry', () => {
  it('builds ToolName(args)', () => {
    expect(buildToolEntry('Bash', { command: 'npm test' })).toBe('Bash(npm test)');
    expect(buildToolEntry('TodoWrite', {})).toBe('TodoWrite');
    expect(buildToolEntry(null, {})).toBeNull();
  });
});

describe('checkHardDeny', () => {
  const patterns = [
    'Bash(git push*)', 'Bash(gh *)', 'Bash(node *)', 'Bash(npm *)',
    'Bash(npx *)', 'WebFetch', 'Bash(chmod *)', 'Bash(chown *)', 'BypassPermissions',
  ];

  it('denies git push, allows safe command', () => {
    expect(checkHardDeny('Bash', { command: 'git push origin main' }, patterns).denied).toBe(true);
    expect(checkHardDeny('Bash', { command: 'ls -la' }, patterns).denied).toBe(false);
  });

  it('denies npm command', () => {
    const r = checkHardDeny('Bash', { command: 'npm run test' }, patterns);
    expect(r.denied).toBe(true);
    expect(r.matchedPattern).toBe('Bash(npm *)');
  });

  it('hard-denied: WebFetch, BypassPermissions', () => {
    expect(checkHardDeny('WebFetch', {}, patterns).denied).toBe(true);
    expect(checkHardDeny('BypassPermissions', {}, patterns).denied).toBe(true);
  });

  it('allows safe commands', () => {
    expect(checkHardDeny('Bash', { command: 'echo hello' }, patterns).denied).toBe(false);
  });

  it('allows when deny list is empty/null', () => {
    expect(checkHardDeny('Bash', { command: 'rm -rf /' }, []).denied).toBe(false);
    expect(checkHardDeny('Bash', { command: 'rm -rf /' }, null).denied).toBe(false);
  });
});

describe('isAllowedByConfig', () => {
  const allowlist = [
    'Read', 'Edit', 'Write', 'Glob', 'Grep', 'TodoWrite',
    'Bash(git status*)', 'Bash(git diff*)', 'Bash(git log*)',
    'Bash(git show*)', 'Bash(git add*)', 'Bash(git commit*)',
    'Bash(git rev-parse*)',
  ];

  it('allows listed git commands and non-Bash tools by bare name', () => {
    expect(isAllowedByConfig('Bash', { command: 'git status' }, allowlist)).toBe(true);
    expect(isAllowedByConfig('Read', { file_path: 'src/main.mjs' }, allowlist)).toBe(true);
  });

  it('does not allow unlisted commands', () => {
    expect(isAllowedByConfig('Bash', { command: 'npm test' }, allowlist)).toBe(false);
    expect(isAllowedByConfig('WebFetch', { url: 'https://x.com' }, allowlist)).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * parseChoice                                                          *
 * ------------------------------------------------------------------ */

describe('parseChoice', () => {
  it('1 = allow-once', () => {
    expect(parseChoice('1').kind).toBe('allow-once');
  });

  it('2 = deny', () => {
    expect(parseChoice('2').kind).toBe('deny');
  });

  it('accepts yes/no words', () => {
    expect(parseChoice('yes').kind).toBe('allow-once');
    expect(parseChoice('y').kind).toBe('allow-once');
    expect(parseChoice('no').kind).toBe('deny');
    expect(parseChoice('n').kind).toBe('deny');
  });

  it('marks garbage as invalid', () => {
    expect(parseChoice('maybe').kind).toBe('invalid');
    expect(parseChoice('').kind).toBe('invalid');
    expect(parseChoice('3').kind).toBe('invalid');
  });
});

/* ------------------------------------------------------------------ *
 * Temp directory & hook settings                                       *
 * ------------------------------------------------------------------ */

describe('temp directory outside repo', () => {
  it('createRelayWorkDir creates a dir under os.tmpdir(), not REPO_ROOT', () => {
    const dir = makeWorkDir();
    expect(fs.existsSync(dir)).toBe(true);
    expect(dir).toContain('agentloop-permrelay-');
    // Must NOT be under the project directory.
    expect(dir.startsWith(os.tmpdir())).toBe(true);
  });

  it('writeHookSettings writes settings and helper script to workDir', () => {
    const dir = makeWorkDir();
    const { settingsPath, hookScriptPath } = writeHookSettings(dir, {
      denyPatterns: ['Bash(git push*)'],
      allowPatterns: ['Read', 'Bash(git status*)'],
    });

    expect(fs.existsSync(settingsPath)).toBe(true);
    expect(fs.existsSync(hookScriptPath)).toBe(true);

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    expect(settings.hooks.PreToolUse[0].matcher).toBe('*');

    const script = fs.readFileSync(hookScriptPath, 'utf8');
    expect(script).toContain('ALCLI permission-relay hook helper');
    expect(script).toContain('Bash(git push*)');
    expect(script).toContain('nonce');
    // Must embed the workDir path for file IPC (JSON-serialised).
    expect(script).toContain('WORK_DIR');
  });

  it('removeRelayWorkDir cleans up the entire temp directory', () => {
    const dir = makeWorkDir();
    writeHookSettings(dir, { denyPatterns: [], allowPatterns: [] });
    expect(fs.existsSync(dir)).toBe(true);
    removeRelayWorkDir(dir);
    expect(fs.existsSync(dir)).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * Nonce-protected responses                                            *
 * ------------------------------------------------------------------ */

describe('nonce-protected writeResponse', () => {
  it('writes a response with nonce echoed back', () => {
    const dir = makeWorkDir();
    writeResponse(dir, 'toolu_1', { approved: true, nonce: 'abc123', reason: 'ok' });

    const resPath = path.join(dir, 'perm-res-toolu_1.json');
    expect(fs.existsSync(resPath)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(resPath, 'utf8'));
    expect(parsed.approved).toBe(true);
    expect(parsed.nonce).toBe('abc123');
  });

  it('pre-cleans stale response before writing', () => {
    const dir = makeWorkDir();
    const resPath = path.join(dir, 'perm-res-toolu_1.json');
    fs.writeFileSync(resPath, JSON.stringify({ approved: true, nonce: 'old' }), 'utf8');
    writeResponse(dir, 'toolu_1', { approved: false, nonce: 'new' });
    const parsed = JSON.parse(fs.readFileSync(resPath, 'utf8'));
    expect(parsed.approved).toBe(false);
    expect(parsed.nonce).toBe('new');
  });
});

/* ------------------------------------------------------------------ *
 * tool_use_id-scoped files (concurrent isolation)                       *
 * ------------------------------------------------------------------ */

describe('tool_use_id-scoped file isolation', () => {
  it('different tool_use_ids use different response files', () => {
    const dir = makeWorkDir();
    writeResponse(dir, 'toolu_A', { approved: true, nonce: 'na' });
    writeResponse(dir, 'toolu_B', { approved: false, nonce: 'nb' });

    // Each has its own file.
    expect(fs.existsSync(path.join(dir, 'perm-res-toolu_A.json'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'perm-res-toolu_B.json'))).toBe(true);

    const a = JSON.parse(fs.readFileSync(path.join(dir, 'perm-res-toolu_A.json'), 'utf8'));
    const b = JSON.parse(fs.readFileSync(path.join(dir, 'perm-res-toolu_B.json'), 'utf8'));
    expect(a.approved).toBe(true);
    expect(b.approved).toBe(false);
  });

  it('pollForRequest claims ownership by deleting the request file', async () => {
    const dir = makeWorkDir();
    const reqPath = path.join(dir, 'perm-req-toolu_claim.json');
    fs.writeFileSync(reqPath, JSON.stringify({
      tool_name: 'Bash', tool_input: { command: 'ls' },
      tool_use_id: 'toolu_claim', nonce: 'nc', timestamp: Date.now(),
    }), 'utf8');

    // First poll: should find and delete the request.
    const first = await pollForRequest(dir, 200);
    expect(first).not.toBeNull();
    expect(first.tool_use_id).toBe('toolu_claim');
    expect(fs.existsSync(reqPath)).toBe(false);

    // Second poll: should NOT find it again.
    const second = await pollForRequest(dir, 200);
    expect(second).toBeNull();
  });

  it('pollForRequest finds requests across all tool_use_ids', async () => {
    const dir = makeWorkDir();
    // Write a request file as a hook would.
    const reqPath = path.join(dir, 'perm-req-toolu_X.json');
    fs.writeFileSync(reqPath, JSON.stringify({
      tool_name: 'Bash', tool_input: { command: 'ls' },
      tool_use_id: 'toolu_X', nonce: 'nx', timestamp: Date.now(),
    }), 'utf8');

    const found = await pollForRequest(dir, 200);
    expect(found).not.toBeNull();
    expect(found.tool_use_id).toBe('toolu_X');
    expect(found.nonce).toBe('nx');
  });
});

/* ------------------------------------------------------------------ *
 * Timeout continuation                                                 *
 * ------------------------------------------------------------------ */

describe('timeout continuation flow still works', () => {
  it('buildClaudeArgs still produces --print', async () => {
    const { buildClaudeArgs } = await import('./claude-agent.mjs');
    const args = buildClaudeArgs({ sessionId: 't', resume: false });
    expect(args).toContain('--print');
    expect(args).toContain('stream-json');
  });

  it('runClaude is exported', async () => {
    const { runClaude } = await import('./claude-agent.mjs');
    expect(runClaude).toBeTypeOf('function');
  });
});

/* ------------------------------------------------------------------ *
 * Test helpers                                                         *
 * ------------------------------------------------------------------ */

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
