/**
 * Interactive Claude Permission Relay — PreToolUse hook integration.
 *
 * Claude Code's PreToolUse hook fires before every tool call and can return
 * `permissionDecision: "allow" | "deny"`.  This module provides both sides:
 *
 *  **Hook side** — runs as a Claude Code PreToolUse hook command.  Reads the
 *    tool-call JSON from stdin and resolves it to allow/ask/deny before
 *    anything reaches the relay: ALCLI hard-deny rules and the static
 *    `--allowedTools` list are checked first (exits silently when a tool is
 *    already allowed — Claude's own `--allowedTools` grant covers it), then
 *    a Bash `rm` is classified by blast radius (see {@link classifyDeletion})
 *    so a narrow, project-scoped removal is approved directly and a
 *    dangerous target is denied directly. Only a genuinely uncertain request
 *    writes a nonce-protected request file to a temp directory outside the
 *    repository.
 *
 *  **Controller side** — polls the temp directory while Claude runs,
 *    re-applies the same hard-deny and deletion-scope checks
 *    (belt-and-braces), prompts the interactive user for what remains, and
 *    writes a nonce-correlated decision back. With no user available (the
 *    unattended `auto` relay mode), a request that reaches this point is
 *    denied rather than approved without review.
 *
 * ## Safety boundaries
 *
 *  **Temp directory outside the repo.**  Hook artefacts (script, settings,
 *    request/response files) live under `os.tmpdir()`, which is not in
 *    `--add-dir`.  Claude's Write and Edit tools are restricted to the repo
 *    root, so Claude cannot read, modify, or forge the relay files.
 *
 *  **Per-call file scoping.**  Each request/response pair is keyed by the
 *    hook's `tool_use_id`, so concurrent PreToolUse invocations never
 *    overwrite one another's files.
 *
 *  **Nonce correlation.**  Every request carries a cryptographic nonce; only
 *    a response that echoes it is accepted.
 *
 *  **No invented permission rules.**  The relay only ever approves or denies
 *    individual calls.  It does not derive, store, or forward reusable
 *    permission scopes because the PreToolUse hook input does not carry a
 *    Claude-supplied permission rule.
 *
 * Non-interactive runs never auto-approve an ask-tier request — the relay
 * hook is skipped entirely when stdin is not a TTY and the relay mode is not
 * explicitly `auto`; and within `auto` mode, an ask-tier request has no user
 * to prompt and is denied. Only requests ALCLI itself classifies as routine
 * (a narrow, project-scoped `rm`, or a tool already on the static allowlist)
 * execute without a human in the loop.
 *
 * The relay is only enabled for the standard `claude` binary.  When
 * `AGENTLOOP_CLAUDE_BIN` points to `claude-ds` or another tool, the hook
 * settings are skipped so no Claude Code-specific flags reach an unsupported
 * binary.
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';

/* ------------------------------------------------------------------ *
 * Shared utilities                                                    *
 * ------------------------------------------------------------------ */

export function buildToolEntry(toolName, toolInput) {
  if (!toolName || typeof toolName !== 'string') return null;
  const args = _toolArgs(toolInput);
  return args ? `${toolName}(${args})` : toolName;
}

function _toolArgs(input) {
  if (!input || typeof input !== 'object') return '';
  if (typeof input.command === 'string') return input.command;
  if (typeof input.file_path === 'string') return input.file_path;
  if (typeof input.pattern === 'string') return input.pattern;
  if (typeof input.url === 'string') return input.url;
  const pairs = Object.entries(input)
    .filter(([, v]) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
    .map(([k, v]) => `${String(k)}=${String(v)}`)
    .join(' ');
  return pairs || '';
}

export function patternMatches(entry, pattern) {
  let p = pattern;
  if (p.endsWith(':*)')) p = p.slice(0, -3) + ' *)';
  else if (p.endsWith(':*')) p = p.slice(0, -2) + ' *';

  if (!p.includes('(') && !p.includes('*') && !p.includes('?')) {
    const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp('^' + escaped + '(\\(.*\\))?$').test(entry);
  }

  return _globToRegex(p).test(entry);
}

function _globToRegex(pattern) {
  let re = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === '*') re += '.*';
    else if (ch === '?') re += '.';
    else if ('()[]{}:\\^$.|+'.includes(ch)) re += '\\' + ch;
    else re += ch;
  }
  return new RegExp('^' + re + '$');
}

export function checkHardDeny(toolName, toolInput, deniedPatterns) {
  if (!Array.isArray(deniedPatterns) || deniedPatterns.length === 0) return { denied: false };
  const entry = buildToolEntry(toolName, toolInput);
  if (!entry) return { denied: false };
  for (const pattern of deniedPatterns) {
    if (patternMatches(entry, pattern)) return { denied: true, matchedPattern: pattern };
  }
  return { denied: false };
}

export function isAllowedByConfig(toolName, toolInput, allowedPatterns) {
  if (!Array.isArray(allowedPatterns) || allowedPatterns.length === 0) return false;
  const entry = buildToolEntry(toolName, toolInput);
  if (!entry) return false;
  for (const pattern of allowedPatterns) {
    if (patternMatches(entry, pattern)) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * Deletion-scope classification (Bash `rm` only)                       *
 *                                                                      *
 * The static allowlist above is an exact-match list, so it can never   *
 * cover `rm` — a safe removal and a catastrophic one share the same    *
 * tool name and differ only in target and flags. This classifies a     *
 * plain `rm` invocation by blast radius, using only the command string *
 * and the project root already known to the runtime permission path —  *
 * no shell parsing, no chained-command inference: anything with        *
 * pipes/substitutions/chaining, or that isn't a bare `rm`, is left for *
 * the normal ask-tier relay.                                           *
 * ------------------------------------------------------------------ */

const _SHELL_METACHARACTERS = /[|;&`$<>]/;
const _WILDCARD_CHARS = /[*?[\]]/;
const _WINDOWS_DRIVE_ROOT = /^[A-Za-z]:[\\/]?$/;

function _rmInvocation(command) {
  const trimmed = String(command ?? '').trim();
  if (!/^rm\s+/.test(trimmed)) return null;

  // `$HOME` is a known destructive target, not an ambiguous substitution.
  // Recognise it before the general shell-metacharacter guard below so it
  // reaches the hard-deny tier rather than the relay.
  const rawTokens = trimmed.split(/\s+/).slice(1);
  if (rawTokens.some((token) => token === '$HOME' || token.startsWith('$HOME/') || token.startsWith('$HOME\\'))) {
    return 'dangerous';
  }
  if (_SHELL_METACHARACTERS.test(trimmed)) return 'ambiguous';

  const tokens = trimmed.split(/\s+/).slice(1);
  const flags = [];
  const targets = [];
  for (const token of tokens) {
    if (token.length > 1 && token.startsWith('-')) flags.push(token);
    else targets.push(token);
  }
  return { flags, targets };
}

function _isRecursiveRmFlag(flag) {
  if (flag === '--recursive') return true;
  if (/^-[A-Za-z]+$/.test(flag)) return /[rR]/.test(flag);
  return false;
}

function _isDangerousRmTarget(target) {
  const t = target.trim();
  if (t === '' || t === '/' || t === '.' || t === '..' || t === '*' || t === '~') return true;
  if (t.startsWith('~')) return true;
  if (t === '$HOME' || t.startsWith('$HOME')) return true;
  if (_WINDOWS_DRIVE_ROOT.test(t)) return true;
  const normalised = t.replace(/\\/g, '/').replace(/\/+$/, '');
  if (
    normalised === '.git' ||
    normalised.startsWith('.git/') ||
    normalised.endsWith('/.git') ||
    normalised.includes('/.git/')
  ) return true;
  return false;
}

function _isOutsideProject(target, repoRoot) {
  if (!repoRoot) return false;
  const resolved = path.resolve(repoRoot, target);
  const rel = path.relative(repoRoot, resolved);
  if (rel === '') return true; // targets the project root itself
  return rel.startsWith('..') || path.isAbsolute(rel);
}

/**
 * Classify a Bash `rm` invocation by blast radius.
 *
 * @returns {'allow'|'ask'|'deny'|null} `null` when this is not a plain `rm`
 *   command — the caller should fall through to its normal ask-tier default.
 */
export function classifyDeletion(toolName, toolInput, repoRoot) {
  if (toolName !== 'Bash') return null;
  const command = typeof toolInput?.command === 'string' ? toolInput.command : null;
  if (command === null) return null;

  const parsed = _rmInvocation(command);
  if (parsed === null) return null;
  if (parsed === 'dangerous') return 'deny';
  if (parsed === 'ambiguous') return 'ask';

  const { flags, targets } = parsed;
  if (targets.length === 0) return 'ask';

  for (const target of targets) {
    if (_isDangerousRmTarget(target)) return 'deny';
    if (repoRoot && path.resolve(repoRoot, target) === path.resolve(repoRoot)) return 'deny';
  }

  if (flags.some(_isRecursiveRmFlag)) return 'ask';

  for (const target of targets) {
    if (_WILDCARD_CHARS.test(target)) return 'ask';
    if (_isOutsideProject(target, repoRoot)) return 'ask';
  }

  return 'allow';
}

/* ------------------------------------------------------------------ *
 * File-naming helpers (tool_use_id-scoped)                             *
 * ------------------------------------------------------------------ */

function _requestPath(workDir, toolUseId) {
  return path.join(workDir, `perm-req-${_safeId(toolUseId)}.json`);
}

function _responsePath(workDir, toolUseId) {
  return path.join(workDir, `perm-res-${_safeId(toolUseId)}.json`);
}

function _safeId(id) {
  // Sanitise to a filesystem-safe token.
  return String(id ?? 'unknown').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128);
}

/* ------------------------------------------------------------------ *
 * Hook-side logic                                                      *
 * ------------------------------------------------------------------ */

function _randomHex(len) {
  const bytes = new Uint8Array(len);
  try { crypto.getRandomValues(bytes); }
  catch { for (let i = 0; i < len; i++) bytes[i] = Math.random() * 256 | 0; }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function _sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function _readHookInput() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => {
      try { resolve(JSON.parse(data)); }
      catch { resolve(null); }
    });
  });
}

function _writeDecision({ decision, reason } = {}) {
  if (!decision) { process.exit(0); }
  const output = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
    },
  };
  if (reason) output.hookSpecificOutput.permissionDecisionReason = reason;
  process.stdout.write(JSON.stringify(output), 'utf8');
  process.exit(0);
}

export async function runHook({ workDir, denyPatterns, allowPatterns, repoRoot }) {
  const input = await _readHookInput();
  if (!input || !input.tool_name) { process.exit(0); }

  const toolName = input.tool_name;
  const toolInput = input.tool_input ?? {};
  const toolUseId = typeof input.tool_use_id === 'string' ? input.tool_use_id : 'unknown';

  // 1. Hard-deny — deny immediately, no file IPC.
  const hardCheck = checkHardDeny(toolName, toolInput, denyPatterns);
  if (hardCheck.denied) {
    _writeDecision({
      decision: 'deny',
      reason: `Blocked by ALCLI hard-deny rule: ${hardCheck.matchedPattern}`,
    });
  }

  // 2. Static allowlist — exit silently, normal flow auto-approves.
  if (isAllowedByConfig(toolName, toolInput, allowPatterns)) {
    _writeDecision();
  }

  // 2b. Deletion-scope classification — narrow, project-scoped `rm` is
  // approved directly; recursive/wildcard/ambiguous falls through to the
  // relay (step 3); a dangerous target is denied before any file IPC.
  const deletionDecision = classifyDeletion(toolName, toolInput, repoRoot);
  if (deletionDecision === 'deny') {
    _writeDecision({ decision: 'deny', reason: 'Blocked by ALCLI policy: dangerous deletion target.' });
  }
  if (deletionDecision === 'allow') {
    _writeDecision({ decision: 'allow', reason: 'Narrow, project-scoped removal.' });
  }

  // 3. Relay to controller via nonce-protected file IPC in temp directory.
  const reqPath = _requestPath(workDir, toolUseId);
  const resPath = _responsePath(workDir, toolUseId);
  const nonce = _randomHex(16);

  const request = {
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: toolUseId,
    nonce,
    timestamp: Date.now(),
  };

  // Delete any stale response before writing our request.
  try { fs.unlinkSync(resPath); } catch { /* ok */ }

  try {
    fs.mkdirSync(workDir, { recursive: true });
    fs.writeFileSync(reqPath, JSON.stringify(request), 'utf8');
  } catch {
    _writeDecision({ decision: 'deny', reason: 'Permission relay unavailable.' });
  }

  // Poll for a response carrying our nonce.
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    await _sleep(200);
    try {
      if (!fs.existsSync(resPath)) continue;
      const raw = fs.readFileSync(resPath, 'utf8');
      const response = JSON.parse(raw);

      if (!response.nonce || response.nonce !== nonce) {
        try { fs.unlinkSync(resPath); } catch { /* ok */ }
        continue;
      }

      // Claim the response.
      try { fs.unlinkSync(reqPath); } catch { /* ok */ }
      try { fs.unlinkSync(resPath); } catch { /* ok */ }

      if (response.approved) {
        _writeDecision({ decision: 'allow', reason: response.reason });
      } else {
        _writeDecision({ decision: 'deny', reason: response.reason ?? 'Permission denied by user.' });
      }
    } catch { /* partially written; keep polling */ }
  }

  // Timeout.
  try { fs.unlinkSync(reqPath); } catch { /* ok */ }
  _writeDecision({ decision: 'deny', reason: 'Permission relay timed out.' });
}

/* ------------------------------------------------------------------ *
 * Controller-side logic                                               *
 * ------------------------------------------------------------------ */

/**
 * Create a temp directory for the relay artefacts, outside the repo.
 * @returns {string} absolute path
 */
export function createRelayWorkDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentloop-permrelay-'));
  return dir;
}

/**
 * Write the hook settings file and helper script into `workDir`.
 *
 * @param {string} workDir
 * @param {{ denyPatterns?: string[], allowPatterns?: string[], repoRoot?: string|null }} config
 * @returns {{ settingsPath: string, hookScriptPath: string }}
 */
export function writeHookSettings(workDir, { denyPatterns = [], allowPatterns = [], repoRoot = null } = {}) {
  const settingsPath = path.join(workDir, 'hook-settings.json');
  const hookScriptPath = path.join(workDir, 'permission-hook.mjs');

  const script = _generateHookScript({ workDir, denyPatterns, allowPatterns, repoRoot });
  fs.writeFileSync(hookScriptPath, script, 'utf8');

  const settings = {
    hooks: {
      PreToolUse: [
        {
          matcher: '*',
          hooks: [
            {
              type: 'command',
              command: process.execPath,
              args: [hookScriptPath],
              timeout: 300,
            },
          ],
        },
      ],
    },
  };

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
  return { settingsPath, hookScriptPath };
}

/**
 * Remove the temp relay directory and all its contents.
 */
export function removeRelayWorkDir(workDir) {
  try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ok */ }
}

/**
 * Poll for a permission-request file in `workDir`.
 * Returns the parsed request when found, or `null` when the interval elapsed.
 */
export async function pollForRequest(workDir, timeoutMs = 200) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const entries = fs.readdirSync(workDir);
      for (const name of entries) {
        if (!name.startsWith('perm-req-') || !name.endsWith('.json')) continue;
        const p = path.join(workDir, name);
        const raw = fs.readFileSync(p, 'utf8');
        const request = JSON.parse(raw);
        // Claim ownership: delete the request file so a second poll cycle
        // never re-reads and re-prompts for the same tool call.  The hook
        // script also tries to delete it when it consumes the response;
        // that is harmless (ENOENT in a try/catch).
        try { fs.unlinkSync(p); } catch { /* ok */ }
        return request;
      }
    } catch { /* directory may not exist yet */ }
    await _sleep(50);
  }

  return null;
}

/**
 * Write a permission-response file.
 */
export function writeResponse(workDir, toolUseId, response) {
  const resPath = _responsePath(workDir, toolUseId);
  try { fs.unlinkSync(resPath); } catch { /* ok */ }
  fs.writeFileSync(resPath, JSON.stringify(response), 'utf8');
}

/**
 * Clean up stale request/response files for a given tool_use_id.
 */
export function cleanRelayFiles(workDir, toolUseId) {
  try { fs.unlinkSync(_requestPath(workDir, toolUseId)); } catch { /* ok */ }
  try { fs.unlinkSync(_responsePath(workDir, toolUseId)); } catch { /* ok */ }
}

export function formatPrompt(request) {
  const lines = [
    '',
    '╔═══════════════════════════════════════════════════════════════╗',
    '║  Claude requests permission                                 ║',
    '╠═══════════════════════════════════════════════════════════════╣',
    '',
    `  Tool: ${request.toolName ?? '(unknown)'}`,
  ];

  if (request.toolInput) {
    const cmd = _toolArgs(request.toolInput);
    if (cmd) lines.push(`  Action: ${cmd}`);
    for (const [key, value] of Object.entries(request.toolInput)) {
      if (key === 'command') continue;
      lines.push(`  ${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
    }
  }

  lines.push('');
  lines.push('  [1] Yes — allow once');
  lines.push('  [2] No — deny');
  lines.push('');
  lines.push('╚═══════════════════════════════════════════════════════════════╝');
  lines.push('');
  lines.push('Choice: ');

  return lines.join('\n');
}

export function parseChoice(input) {
  const trimmed = String(input ?? '').trim();

  if (trimmed === '1') return { kind: 'allow-once', raw: trimmed };
  if (trimmed === '2') return { kind: 'deny', raw: trimmed };

  const lower = trimmed.toLowerCase();
  if (lower === 'y' || lower === 'yes') return { kind: 'allow-once', raw: trimmed };
  if (lower === 'n' || lower === 'no') return { kind: 'deny', raw: trimmed };

  return { kind: 'invalid', raw: trimmed };
}

export function promptUser(request) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      resolve(null);
      return;
    }

    const text = formatPrompt(request);
    const rl = createInterface({ input: process.stdin, output: process.stdout });

    function ask() {
      rl.question(text, (answer) => {
        const choice = parseChoice(answer);
        if (choice.kind === 'invalid') {
          process.stdout.write(
            `  Unrecognised choice "${answer.trim()}". Please enter 1 or 2.\n`,
          );
          ask();
          return;
        }
        rl.close();
        resolve({ kind: choice.kind });
      });
    }

    ask();
  });
}

/* ------------------------------------------------------------------ *
 * Inline hook helper script template                                   *
 * Written to workDir/permission-hook.mjs with __WORK_DIR__,           *
 * __DENY_PATTERNS__, __ALLOW_PATTERNS__ replaced at gen time.         *
 * ------------------------------------------------------------------ */

const HOOK_SCRIPT_TEMPLATE = `// ALCLI permission-relay hook helper — PreToolUse integration.
// Auto-generated; do not edit by hand.

import fs from 'node:fs';
import path from 'node:path';

var WORK_DIR = __WORK_DIR__;
var DENY_PATTERNS = __DENY_PATTERNS__;
var ALLOW_PATTERNS = __ALLOW_PATTERNS__;
var REPO_ROOT = __REPO_ROOT__;

/* ----- inlined utilities ----- */

function buildToolEntry(toolName, toolInput) {
  if (!toolName || typeof toolName !== 'string') return null;
  var a = _toolArgs(toolInput);
  return a ? toolName + '(' + a + ')' : toolName;
}

function _toolArgs(input) {
  if (!input || typeof input !== 'object') return '';
  if (typeof input.command === 'string') return input.command;
  if (typeof input.file_path === 'string') return input.file_path;
  if (typeof input.pattern === 'string') return input.pattern;
  if (typeof input.url === 'string') return input.url;
  var pk = Object.keys(input);
  var pa = [];
  for (var pi = 0; pi < pk.length; pi++) {
    var v = input[pk[pi]];
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      pa.push(String(pk[pi]) + '=' + String(v));
    }
  }
  return pa.join(' ');
}

function patternMatches(entry, pattern) {
  var p = pattern;
  if (p.endsWith(':*))')) p = p.slice(0, -3) + ' *)';
  else if (p.endsWith(':*')) p = p.slice(0, -2) + ' *';
  if (p.indexOf('(') === -1 && p.indexOf('*') === -1 && p.indexOf('?') === -1) {
    var esc = p.replace(/[.*+?^\\$\\{}()|[\\]\\\\\\\\]/g, '\\\\\\\\$&');
    return new RegExp('^' + esc + '(\\\\\\\\(.*\\\\\\\\))?$').test(entry);
  }
  var re = '';
  for (var i = 0; i < p.length; i++) {
    var ch = p[i];
    if (ch === '*') re += '.*';
    else if (ch === '?') re += '.';
    else if ('()[]{}:\\\\^$.|+'.indexOf(ch) !== -1) re += '\\\\\\\\' + ch;
    else re += ch;
  }
  return new RegExp('^' + re + '$').test(entry);
}

function checkHardDeny(toolName, toolInput, deniedPatterns) {
  if (!Array.isArray(deniedPatterns) || deniedPatterns.length === 0) return { denied: false };
  var entry = buildToolEntry(toolName, toolInput);
  if (!entry) return { denied: false };
  for (var i = 0; i < deniedPatterns.length; i++) {
    if (patternMatches(entry, deniedPatterns[i])) return { denied: true, matchedPattern: deniedPatterns[i] };
  }
  return { denied: false };
}

function isAllowedByConfig(toolName, toolInput, allowedPatterns) {
  if (!Array.isArray(allowedPatterns) || allowedPatterns.length === 0) return false;
  var entry = buildToolEntry(toolName, toolInput);
  if (!entry) return false;
  for (var i = 0; i < allowedPatterns.length; i++) {
    if (patternMatches(entry, allowedPatterns[i])) return true;
  }
  return false;
}

/* ----- deletion-scope classification (Bash \`rm\` only) ----- */

var TAB_CHAR = String.fromCharCode(9);
var BACKSLASH_CHAR = String.fromCharCode(92);
var BACKTICK_CHAR = String.fromCharCode(96);
var SHELL_META_CHARS = '|;&$<>' + BACKTICK_CHAR;
var WILDCARD_CHARS = '*?[]';

function _hasAnyChar(s, chars) {
  for (var i = 0; i < s.length; i++) {
    if (chars.indexOf(s.charAt(i)) !== -1) return true;
  }
  return false;
}

function _replaceAll(s, find, repl) {
  return s.split(find).join(repl);
}

function _splitWhitespace(s) {
  var tokens = [];
  var current = '';
  for (var i = 0; i < s.length; i++) {
    var c = s.charAt(i);
    if (c === ' ' || c === TAB_CHAR) {
      if (current !== '') { tokens.push(current); current = ''; }
    } else {
      current += c;
    }
  }
  if (current !== '') tokens.push(current);
  return tokens;
}

function _startsWithRmWord(s) {
  if (s === 'rm') return true;
  if (s.length < 3 || s.slice(0, 2) !== 'rm') return false;
  var c = s.charAt(2);
  return c === ' ' || c === TAB_CHAR;
}

function _hasHomeTargetToken(s) {
  var tokens = _splitWhitespace(s).slice(1);
  for (var i = 0; i < tokens.length; i++) {
    var token = tokens[i];
    if (
      token === '$HOME' ||
      token.slice(0, 6) === '$HOME/' ||
      token.slice(0, 6) === '$HOME' + BACKSLASH_CHAR
    ) return true;
  }
  return false;
}

function _isRecursiveRmFlag(flag) {
  if (flag === '--recursive') return true;
  if (flag.charAt(0) !== '-' || flag.charAt(1) === '-') return false;
  for (var i = 1; i < flag.length; i++) {
    var c = flag.charAt(i);
    if (c === 'r' || c === 'R') return true;
  }
  return false;
}

function _isWindowsDriveRoot(t) {
  if (t.length < 2 || t.length > 3) return false;
  var c0 = t.charAt(0);
  var isLetter = (c0 >= 'A' && c0 <= 'Z') || (c0 >= 'a' && c0 <= 'z');
  if (!isLetter || t.charAt(1) !== ':') return false;
  if (t.length === 2) return true;
  var c2 = t.charAt(2);
  return c2 === BACKSLASH_CHAR || c2 === '/';
}

function _isDangerousRmTarget(target) {
  if (target === '' || target === '/' || target === '.' || target === '..' || target === '*' || target === '~') return true;
  if (target.charAt(0) === '~') return true;
  if (target.slice(0, 5) === '$HOME') return true;
  if (_isWindowsDriveRoot(target)) return true;
  var normalised = _replaceAll(target, BACKSLASH_CHAR, '/');
  while (normalised.length > 1 && normalised.charAt(normalised.length - 1) === '/') {
    normalised = normalised.slice(0, -1);
  }
  if (
    normalised === '.git' ||
    normalised.slice(0, 5) === '.git/' ||
    normalised.slice(-5) === '/.git' ||
    normalised.indexOf('/.git/') !== -1
  ) return true;
  return false;
}

function _isOutsideProject(target, repoRoot) {
  if (!repoRoot) return false;
  var resolved = path.resolve(repoRoot, target);
  var rel = path.relative(repoRoot, resolved);
  if (rel === '') return true;
  return rel.slice(0, 2) === '..' || path.isAbsolute(rel);
}

function classifyDeletion(toolName, toolInput, repoRoot) {
  if (toolName !== 'Bash') return null;
  var command = toolInput && typeof toolInput.command === 'string' ? toolInput.command : null;
  if (command === null) return null;

  var trimmed = command.trim();
  if (!_startsWithRmWord(trimmed)) return null;
  if (_hasHomeTargetToken(trimmed)) return 'deny';
  if (_hasAnyChar(trimmed, SHELL_META_CHARS)) return 'ask';

  var tokens = _splitWhitespace(trimmed).slice(1);
  var flags = [];
  var targets = [];
  for (var i = 0; i < tokens.length; i++) {
    var tok = tokens[i];
    if (tok.length > 1 && tok.charAt(0) === '-') flags.push(tok);
    else targets.push(tok);
  }
  if (targets.length === 0) return 'ask';

  for (var j = 0; j < targets.length; j++) {
    if (_isDangerousRmTarget(targets[j])) return 'deny';
    if (repoRoot && path.resolve(repoRoot, targets[j]) === path.resolve(repoRoot)) return 'deny';
  }

  for (var k = 0; k < flags.length; k++) {
    if (_isRecursiveRmFlag(flags[k])) return 'ask';
  }

  for (var m = 0; m < targets.length; m++) {
    if (_hasAnyChar(targets[m], WILDCARD_CHARS)) return 'ask';
    if (_isOutsideProject(targets[m], repoRoot)) return 'ask';
  }

  return 'allow';
}

function _safeId(id) {
  return String(id || 'unknown').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128);
}

function _randomHex(len) {
  var bytes = new Uint8Array(len);
  try { crypto.getRandomValues(bytes); } catch (e) { for (var i = 0; i < len; i++) bytes[i] = Math.random() * 256 | 0; }
  var hex = '';
  for (var j = 0; j < bytes.length; j++) hex += bytes[j].toString(16).padStart(2, '0');
  return hex;
}

function _sleep(ms) {
  return new Promise(function(r) { setTimeout(r, ms); });
}

function _writeDecision(opts) {
  if (!opts || !opts.decision) { process.exit(0); }
  var out = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: opts.decision,
    },
  };
  if (opts.reason) out.hookSpecificOutput.permissionDecisionReason = opts.reason;
  process.stdout.write(JSON.stringify(out), 'utf8');
  process.exit(0);
}

/* ----- main ----- */

function readStdinSync() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch (e) {
    return '';
  }
}

async function main() {
  var data = readStdinSync();

  var input;
  try { input = JSON.parse(data); } catch (e) { process.exit(0); }
  if (!input || !input.tool_name) { process.exit(0); }

  var toolName = input.tool_name;
  var toolInput = input.tool_input || {};
  var toolUseId = typeof input.tool_use_id === 'string' ? input.tool_use_id : 'unknown';

  // 1. Hard-deny.
  var hardCheck = checkHardDeny(toolName, toolInput, DENY_PATTERNS);
  if (hardCheck.denied) {
    _writeDecision({
      decision: 'deny',
      reason: 'Blocked by ALCLI hard-deny rule: ' + hardCheck.matchedPattern,
    });
  }

  // 2. Static allowlist.
  if (isAllowedByConfig(toolName, toolInput, ALLOW_PATTERNS)) {
    _writeDecision();
  }

  // 2b. Deletion-scope classification: narrow, project-scoped \`rm\` is
  // approved directly; a dangerous target is denied before any file IPC;
  // anything recursive/wildcarded/ambiguous falls through to the relay.
  var deletionDecision = classifyDeletion(toolName, toolInput, REPO_ROOT);
  if (deletionDecision === 'deny') {
    _writeDecision({ decision: 'deny', reason: 'Blocked by ALCLI policy: dangerous deletion target.' });
  }
  if (deletionDecision === 'allow') {
    _writeDecision({ decision: 'allow', reason: 'Narrow, project-scoped removal.' });
  }

  // 3. Relay via temp directory (outside repo — Claude cannot Write here).
  var reqPath = path.join(WORK_DIR, 'perm-req-' + _safeId(toolUseId) + '.json');
  var resPath = path.join(WORK_DIR, 'perm-res-' + _safeId(toolUseId) + '.json');
  var nonce = _randomHex(16);

  var request = {
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: toolUseId,
    nonce: nonce,
    timestamp: Date.now(),
  };

  try { fs.unlinkSync(resPath); } catch (e) {}

  try {
    fs.mkdirSync(WORK_DIR, { recursive: true });
    fs.writeFileSync(reqPath, JSON.stringify(request), 'utf8');
  } catch (e) {
    _writeDecision({ decision: 'deny', reason: 'Permission relay unavailable.' });
  }

  var deadline = Date.now() + 300000;
  while (Date.now() < deadline) {
    await _sleep(200);
    try {
      if (!fs.existsSync(resPath)) continue;
      var raw = fs.readFileSync(resPath, 'utf8');
      var response = JSON.parse(raw);

      if (!response.nonce || response.nonce !== nonce) {
        try { fs.unlinkSync(resPath); } catch (e) {}
        continue;
      }

      try { fs.unlinkSync(reqPath); } catch (e) {}
      try { fs.unlinkSync(resPath); } catch (e) {}

      if (response.approved) {
        _writeDecision({ decision: 'allow', reason: response.reason });
      } else {
        _writeDecision({ decision: 'deny', reason: response.reason || 'Permission denied by user.' });
      }
    } catch (e) {}
  }

  try { fs.unlinkSync(reqPath); } catch (e) {}
  _writeDecision({ decision: 'deny', reason: 'Permission relay timed out.' });
}

main();
`;

function _generateHookScript({ workDir, denyPatterns, allowPatterns, repoRoot }) {
  return HOOK_SCRIPT_TEMPLATE
    .replace('__WORK_DIR__', JSON.stringify(workDir))
    .replace('__DENY_PATTERNS__', JSON.stringify(denyPatterns))
    .replace('__ALLOW_PATTERNS__', JSON.stringify(allowPatterns))
    .replace('__REPO_ROOT__', JSON.stringify(repoRoot ?? null));
}
