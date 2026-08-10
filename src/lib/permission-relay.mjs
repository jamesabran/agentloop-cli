/**
 * Interactive Claude Permission Relay — PreToolUse hook integration.
 *
 * Claude Code's PreToolUse hook fires before every tool call and can return
 * `permissionDecision: "allow" | "deny"`.  This module provides both sides:
 *
 *  **Hook side** — runs as a Claude Code PreToolUse hook command.  Reads the
 *    tool-call JSON from stdin, checks against ALCLI hard-deny rules and the
 *    static `--allowedTools` list, and either exits silently (tools that are
 *    already allowed) or writes a nonce-protected permission-request file that
 *    the controller picks up.
 *
 *  **Controller side** — polls `.agent/permission-request.json` while Claude
 *    runs, checks hard-deny rules (belt-and-braces), prompts the interactive
 *    user, and writes a nonce-correlated decision back.
 *
 * Every request carries a cryptographic nonce; only a response that echoes it
 * is accepted.  Stale or pre-placed response files are deleted before writing
 * the request and ignored if they don't carry the matching nonce.
 *
 * Non-interactive runs never auto-approve — the controller denies every
 * request that reaches it when stdin is not a TTY.
 *
 * The relay is only enabled for the standard `claude` binary.  When
 * `AGENTLOOP_CLAUDE_BIN` points to `claude-ds` or another tool, the hook
 * settings are skipped entirely so no Claude Code-specific flags reach an
 * unsupported binary.
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';

/* ------------------------------------------------------------------ *
 * Shared utilities                                                    *
 * ------------------------------------------------------------------ */

/**
 * Build a canonical tool-entry string for pattern matching —
 * `ToolName(args)` or plain `ToolName`.
 */
export function buildToolEntry(toolName, toolInput) {
  if (!toolName || typeof toolName !== 'string') return null;
  const args = toolArgs(toolInput);
  return args ? `${toolName}(${args})` : toolName;
}

/** Best-effort serialisation of a tool's input for the entry string. */
function toolArgs(input) {
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

/**
 * Derive a permission rule string from a tool call for the "allow similar"
 * option.  Returns null when no meaningful rule can be derived (empty
 * input, wildcard-only, etc.).
 */
export function derivePermissionRule(toolName, toolInput) {
  const args = toolArgs(toolInput);
  if (!args || args.trim() === '') return null;
  // Never offer a bare wildcard as a reusable rule.
  if (args === '*') return null;
  return `${toolName}(${args})`;
}

/**
 * Match a tool entry against a glob-style permission-rule pattern.
 *
 * Pattern syntax is Claude Code's: `*` matches any sequence, anchored at
 * both ends.  The `:*` trailing suffix is equivalent to ` *`.  A bare
 * tool name (no parens, no glob characters) matches all uses of that tool.
 */
export function patternMatches(entry, pattern) {
  let p = pattern;
  // Normalise trailing `:*)` or `:*` to ` *)` / ` *`.
  if (p.endsWith(':*)')) p = p.slice(0, -3) + ' *)';
  else if (p.endsWith(':*')) p = p.slice(0, -2) + ' *';

  // Bare tool name (no parens AND no glob chars) matches all uses.
  if (!p.includes('(') && !p.includes('*') && !p.includes('?')) {
    const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp('^' + escaped + '(\\(.*\\))?$').test(entry);
  }

  const regex = globToRegex(p);
  return regex.test(entry);
}

function globToRegex(pattern) {
  let re = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    switch (ch) {
      case '*': re += '.*'; break;
      case '?': re += '.'; break;
      case '(': case ')': case '[': case ']':
      case '{': case '}': case '\\': case '^':
      case '$': case '.': case '|': case '+':
      case ':':
        re += '\\' + ch;
        break;
      default:
        re += ch;
    }
  }
  return new RegExp('^' + re + '$');
}

/**
 * Check whether a tool call matches any hard-deny pattern.
 */
export function checkHardDeny(toolName, toolInput, deniedPatterns) {
  if (!Array.isArray(deniedPatterns) || deniedPatterns.length === 0) {
    return { denied: false };
  }
  const entry = buildToolEntry(toolName, toolInput);
  if (!entry) return { denied: false };
  for (const pattern of deniedPatterns) {
    if (patternMatches(entry, pattern)) {
      return { denied: true, matchedPattern: pattern };
    }
  }
  return { denied: false };
}

/**
 * Check whether a tool call is covered by the static allowlist.
 */
export function isAllowedByConfig(toolName, toolInput, allowedPatterns) {
  if (!Array.isArray(allowedPatterns) || allowedPatterns.length === 0) {
    return false;
  }
  const entry = buildToolEntry(toolName, toolInput);
  if (!entry) return false;
  for (const pattern of allowedPatterns) {
    if (patternMatches(entry, pattern)) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * Hook-side logic (runs as a PreToolUse hook command)                  *
 * ------------------------------------------------------------------ */

const REQUEST_FILE = '.agent/permission-request.json';
const RESPONSE_FILE = '.agent/permission-response.json';

function readHookInput() {
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

function writeDecision({ decision, reason } = {}) {
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

function randomHex(len) {
  const bytes = new Uint8Array(len);
  try { crypto.getRandomValues(bytes); }
  catch { for (let i = 0; i < len; i++) bytes[i] = Math.random() * 256 | 0; }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Entry point for the hook helper script (runHook).
 *
 * Used both by the stand-alone generated hook and by tests.
 */
export async function runHook({ repoRoot, denyPatterns, allowPatterns }) {
  const input = await readHookInput();
  if (!input || !input.tool_name) { process.exit(0); }

  const toolName = input.tool_name;
  const toolInput = input.tool_input ?? {};

  // 1. Hard-deny — deny immediately, no file IPC.
  const hardCheck = checkHardDeny(toolName, toolInput, denyPatterns);
  if (hardCheck.denied) {
    writeDecision({
      decision: 'deny',
      reason: 'Blocked by ALCLI hard-deny rule: ' + hardCheck.matchedPattern,
    });
  }

  // 2. Static allowlist — exit silently, normal flow auto-approves.
  if (isAllowedByConfig(toolName, toolInput, allowPatterns)) {
    writeDecision();
  }

  // 3. Relay to controller via nonce-protected file IPC.
  const reqPath = path.join(repoRoot, REQUEST_FILE);
  const resPath = path.join(repoRoot, RESPONSE_FILE);
  const nonce = randomHex(16);

  const request = {
    tool_name: toolName,
    tool_input: toolInput,
    nonce,
    timestamp: Date.now(),
  };

  // Delete any stale response BEFORE writing our request.
  try { fs.unlinkSync(resPath); } catch { /* ok */ }

  try {
    fs.mkdirSync(path.dirname(reqPath), { recursive: true });
    fs.writeFileSync(reqPath, JSON.stringify(request), 'utf8');
  } catch {
    writeDecision({ decision: 'deny', reason: 'Permission relay unavailable.' });
  }

  // Poll for a response carrying our nonce.
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    await sleep(200);
    try {
      if (!fs.existsSync(resPath)) continue;
      const raw = fs.readFileSync(resPath, 'utf8');
      const response = JSON.parse(raw);

      // Nonce must match — reject stale / forged responses.
      if (!response.nonce || response.nonce !== nonce) {
        try { fs.unlinkSync(resPath); } catch { /* ok */ }
        continue;
      }

      // Claim the response by deleting both files.
      try { fs.unlinkSync(reqPath); } catch { /* ok */ }
      try { fs.unlinkSync(resPath); } catch { /* ok */ }

      if (response.approved) {
        writeDecision({ decision: 'allow', reason: response.reason });
      } else {
        writeDecision({
          decision: 'deny',
          reason: response.reason ?? 'Permission denied by user.',
        });
      }
    } catch {
      // File may be partially written; keep polling.
    }
  }

  // Timeout — deny and clean up.
  try { fs.unlinkSync(reqPath); } catch { /* ok */ }
  writeDecision({ decision: 'deny', reason: 'Permission relay timed out.' });
}

/* ------------------------------------------------------------------ *
 * Controller-side logic                                               *
 * ------------------------------------------------------------------ */

/**
 * Write the Claude Code PreToolUse hook settings file and helper script.
 */
export function writeHookSettings(repoRoot, { denyPatterns = [], allowPatterns = [] } = {}) {
  const settingsPath = path.join(repoRoot, '.agent', 'hook-settings.json');
  const hookScriptPath = path.join(repoRoot, '.agent', 'permission-hook.mjs');

  fs.mkdirSync(path.dirname(hookScriptPath), { recursive: true });

  const script = generateHookScript({ repoRoot, denyPatterns, allowPatterns });
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
 * Clean up the hook artefacts.
 */
export function removeHookSettings(repoRoot) {
  const files = [
    path.join(repoRoot, '.agent', 'hook-settings.json'),
    path.join(repoRoot, '.agent', 'permission-hook.mjs'),
    path.join(repoRoot, '.agent', 'permission-request.json'),
    path.join(repoRoot, '.agent', 'permission-response.json'),
  ];
  for (const f of files) {
    try { fs.unlinkSync(f); } catch { /* ok */ }
  }
}

/**
 * Poll for a permission-request file.  Returns the parsed request when
 * found, or `null` when the poll interval elapsed with nothing.
 */
export async function pollForRequest(repoRoot, timeoutMs = 200) {
  const reqPath = path.join(repoRoot, REQUEST_FILE);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      if (fs.existsSync(reqPath)) {
        const raw = fs.readFileSync(reqPath, 'utf8');
        return JSON.parse(raw);
      }
    } catch { /* file not ready yet */ }
    await sleep(50);
  }

  return null;
}

/**
 * Write a permission-response file with nonce correlation.
 */
export function writeResponse(repoRoot, response) {
  const resPath = path.join(repoRoot, RESPONSE_FILE);
  fs.mkdirSync(path.dirname(resPath), { recursive: true });

  // Clean any pre-existing stale response before writing ours.
  try { fs.unlinkSync(resPath); } catch { /* ok */ }

  fs.writeFileSync(resPath, JSON.stringify(response), 'utf8');
}

/**
 * Format the permission-request prompt shown to the user.
 */
export function formatPrompt(request) {
  const lines = [
    '',
    '╔═══════════════════════════════════════════════════════════════╗',
    '║  Claude requests permission                                 ║',
    '╠═══════════════════════════════════════════════════════════════╣',
    '',
    '  Tool: ' + (request.toolName ?? '(unknown)'),
  ];

  if (request.toolInput) {
    const cmd = toolArgs(request.toolInput);
    if (cmd) lines.push('  Action: ' + cmd);
    for (const [key, value] of Object.entries(request.toolInput)) {
      if (key === 'command') continue;
      lines.push('  ' + key + ': ' + (typeof value === 'string' ? value : JSON.stringify(value)));
    }
  }

  lines.push('');

  if (request.hasReusableRule && request.permissionRule) {
    lines.push('  [1] Yes — allow once');
    lines.push('  [2] Yes — accept reusable permission: ' + request.permissionRule);
    lines.push('  [3] No — deny');
  } else {
    lines.push('  [1] Yes — allow once');
    lines.push('  [2] No — deny');
  }

  lines.push('');
  lines.push('╚═══════════════════════════════════════════════════════════════╝');
  lines.push('');
  lines.push('Choice: ');

  return lines.join('\n');
}

/**
 * Parse the user's terminal input.
 */
export function parseChoice(input, { hasReusableRule = false } = {}) {
  const trimmed = String(input ?? '').trim();

  if (trimmed === '1') return { kind: 'allow-once', raw: trimmed };

  if (trimmed === '2') {
    return hasReusableRule
      ? { kind: 'allow-similar', raw: trimmed }
      : { kind: 'deny', raw: trimmed };
  }

  if (trimmed === '3') {
    return hasReusableRule
      ? { kind: 'deny', raw: trimmed }
      : { kind: 'invalid', raw: trimmed };
  }

  const lower = trimmed.toLowerCase();
  if (lower === 'y' || lower === 'yes') return { kind: 'allow-once', raw: trimmed };
  if (lower === 'n' || lower === 'no') return { kind: 'deny', raw: trimmed };

  return { kind: 'invalid', raw: trimmed };
}

/**
 * Prompt the user for a permission decision.
 *
 * Returns `null` when stdin is not a TTY (non-interactive); the caller must
 * deny in that case, never auto-approve.
 */
export function promptUser(request) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      resolve(null);
      return;
    }

    const hasReusable = Boolean(request.hasReusableRule && request.permissionRule);
    const text = formatPrompt(request);

    const rl = createInterface({ input: process.stdin, output: process.stdout });

    function ask() {
      rl.question(text, (answer) => {
        const choice = parseChoice(answer, { hasReusableRule: hasReusable });
        if (choice.kind === 'invalid') {
          process.stdout.write(
            '  Unrecognised choice "' + answer.trim() + '". ' +
            'Please enter 1, ' + (hasReusable ? '2, 3' : 'or 2') + '.\n',
          );
          ask();
          return;
        }
        rl.close();
        if (choice.kind === 'allow-similar') {
          resolve({ kind: choice.kind, permissionRule: request.permissionRule });
        } else {
          resolve({ kind: choice.kind });
        }
      });
    }

    ask();
  });
}

/* ------------------------------------------------------------------ *
 * Inline hook helper script template                                   *
 *                                                                      *
 * Written to `.agent/permission-hook.mjs` with __REPO_ROOT__,          *
 * __DENY_PATTERNS__, and __ALLOW_PATTERNS__ replaced at generation     *
 * time.  Zero dependencies outside Node.js built-ins.                  *
 * ------------------------------------------------------------------ */

const HOOK_SCRIPT_TEMPLATE = `// ALCLI permission-relay hook helper — PreToolUse integration.
// Auto-generated; do not edit by hand.

import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = __REPO_ROOT__;
const DENY_PATTERNS = __DENY_PATTERNS__;
const ALLOW_PATTERNS = __ALLOW_PATTERNS__;

const REQUEST_FILE = '.agent/permission-request.json';
const RESPONSE_FILE = '.agent/permission-response.json';

/* ----- shared utilities (inlined) ----- */

function buildToolEntry(toolName, toolInput) {
  if (!toolName || typeof toolName !== 'string') return null;
  var a = toolArgs(toolInput);
  return a ? toolName + '(' + a + ')' : toolName;
}

function toolArgs(input) {
  if (!input || typeof input !== 'object') return '';
  if (typeof input.command === 'string') return input.command;
  if (typeof input.file_path === 'string') return input.file_path;
  if (typeof input.pattern === 'string') return input.pattern;
  if (typeof input.url === 'string') return input.url;
  var pairs = Object.entries(input)
    .filter(function(e) { var v = e[1]; return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'; })
    .map(function(e) { return String(e[0]) + '=' + String(e[1]); })
    .join(' ');
  return pairs || '';
}

function patternMatches(entry, pattern) {
  var p = pattern;
  if (p.endsWith(':*)')) p = p.slice(0, -3) + ' *)';
  else if (p.endsWith(':*')) p = p.slice(0, -2) + ' *';
  if (p.indexOf('(') === -1 && p.indexOf('*') === -1 && p.indexOf('?') === -1) {
    var esc = p.replace(/[.*+?^\\\${}()|[\\]\\\\\\\\]/g, '\\\\\\\\$&');
    return new RegExp('^' + esc + '(\\\\\\\\(.*\\\\\\\\))?$').test(entry);
  }
  var re = '';
  for (var i = 0; i < p.length; i++) {
    var ch = p[i];
    if (ch === '*') re += '.*';
    else if (ch === '?') re += '.';
    else if ('()[]{}\\\\\\\\^$.|+'.indexOf(ch) !== -1) re += '\\\\\\\\' + ch;
    else re += ch;
  }
  return new RegExp('^' + re + '$').test(entry);
}

function checkHardDeny(toolName, toolInput, deniedPatterns) {
  if (!Array.isArray(deniedPatterns) || deniedPatterns.length === 0) return { denied: false };
  var entry = buildToolEntry(toolName, toolInput);
  if (!entry) return { denied: false };
  for (var i = 0; i < deniedPatterns.length; i++) {
    if (patternMatches(entry, deniedPatterns[i])) {
      return { denied: true, matchedPattern: deniedPatterns[i] };
    }
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

function randomHex(len) {
  var bytes = new Uint8Array(len);
  try { crypto.getRandomValues(bytes); } catch (e) { for (var i = 0; i < len; i++) bytes[i] = Math.random() * 256 | 0; }
  var hex = '';
  for (var j = 0; j < bytes.length; j++) hex += bytes[j].toString(16).padStart(2, '0');
  return hex;
}

function sleep(ms) {
  return new Promise(function(r) { setTimeout(r, ms); });
}

function writeDecision(opts) {
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

async function main() {
  var data = '';
  process.stdin.setEncoding('utf8');
  for await (var chunk of process.stdin) { data += chunk; }

  var input;
  try { input = JSON.parse(data); } catch (e) { process.exit(0); }
  if (!input || !input.tool_name) { process.exit(0); }

  var toolName = input.tool_name;
  var toolInput = input.tool_input || {};

  // 1. Hard-deny — deny immediately, no file IPC.
  var hardCheck = checkHardDeny(toolName, toolInput, DENY_PATTERNS);
  if (hardCheck.denied) {
    writeDecision({
      decision: 'deny',
      reason: 'Blocked by ALCLI hard-deny rule: ' + hardCheck.matchedPattern,
    });
  }

  // 2. Static allowlist — exit silently, normal flow auto-approves.
  if (isAllowedByConfig(toolName, toolInput, ALLOW_PATTERNS)) {
    writeDecision();
  }

  // 3. Relay to controller via nonce-protected file IPC.
  var reqPath = path.join(REPO_ROOT, REQUEST_FILE);
  var resPath = path.join(REPO_ROOT, RESPONSE_FILE);
  var nonce = randomHex(16);

  var request = {
    tool_name: toolName,
    tool_input: toolInput,
    nonce: nonce,
    timestamp: Date.now(),
  };

  // Delete any stale response BEFORE writing our request.
  try { fs.unlinkSync(resPath); } catch (e) {}

  try {
    fs.mkdirSync(path.dirname(reqPath), { recursive: true });
    fs.writeFileSync(reqPath, JSON.stringify(request), 'utf8');
  } catch (e) {
    writeDecision({ decision: 'deny', reason: 'Permission relay unavailable.' });
  }

  // Poll for a response carrying our nonce.
  var deadline = Date.now() + 300000;
  while (Date.now() < deadline) {
    await sleep(200);
    try {
      if (!fs.existsSync(resPath)) continue;
      var raw = fs.readFileSync(resPath, 'utf8');
      var response = JSON.parse(raw);

      // Nonce must match — reject stale / forged responses.
      if (!response.nonce || response.nonce !== nonce) {
        try { fs.unlinkSync(resPath); } catch (e) {}
        continue;
      }

      // Claim the response by deleting both files.
      try { fs.unlinkSync(reqPath); } catch (e) {}
      try { fs.unlinkSync(resPath); } catch (e) {}

      if (response.approved) {
        writeDecision({ decision: 'allow', reason: response.reason });
      } else {
        writeDecision({
          decision: 'deny',
          reason: response.reason || 'Permission denied by user.',
        });
      }
    } catch (e) {}
  }

  // Timeout — deny and clean up.
  try { fs.unlinkSync(reqPath); } catch (e) {}
  writeDecision({ decision: 'deny', reason: 'Permission relay timed out.' });
}

main();
`;

function generateHookScript({ repoRoot, denyPatterns, allowPatterns }) {
  return HOOK_SCRIPT_TEMPLATE
    .replace('__REPO_ROOT__', JSON.stringify(repoRoot))
    .replace('__DENY_PATTERNS__', JSON.stringify(denyPatterns))
    .replace('__ALLOW_PATTERNS__', JSON.stringify(allowPatterns));
}
