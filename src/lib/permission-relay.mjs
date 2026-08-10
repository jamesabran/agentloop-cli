/**
 * Interactive Claude Permission Relay — PreToolUse hook integration.
 *
 * Claude Code's PreToolUse hook fires before every tool call and can return
 * `permissionDecision: "allow" | "deny"`.  This module provides both sides:
 *
 *  **Hook side** — runs as a Claude Code PreToolUse hook command.  Reads the
 *    tool-call JSON from stdin, checks against ALCLI hard-deny rules and the
 *    static `--allowedTools` list, and either exits silently (tools that are
 *    already allowed) or writes a permission-request file that the controller
 *    picks up.
 *
 *  **Controller side** — polls `.agent/permission-request.json` while Claude
 *    runs, checks hard-deny rules (belt-and-braces), prompts the interactive
 *    user, and writes the decision back.
 *
 * Non-interactive runs never auto-approve — the controller denies every
 * request that reaches it when stdin is not a TTY.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';

/* ------------------------------------------------------------------ *
 * Shared utilities                                                    *
 * ------------------------------------------------------------------ */

/**
 * Build a canonical tool-entry string for pattern matching —
 * `ToolName(args)` or plain `ToolName`.
 *
 * @param {string} toolName
 * @param {object} toolInput
 * @returns {string}
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
 * Match a tool entry against a glob-style pattern.
 *
 * Pattern syntax is Claude Code's: `*` matches any sequence, anchored at both
 * ends.  The `:*` trailing suffix is equivalent to ` *` (word-boundary
 * wildcard).  Colons elsewhere are literal.
 *
 * @param {string} entry - canonical tool entry, e.g. "Bash(git push origin main)"
 * @param {string} pattern - e.g. "Bash(git push*)"
 * @returns {boolean}
 */
export function patternMatches(entry, pattern) {
  // Normalise trailing `:*` to ` *` (Claude Code equivalence).
  // Bash(ls:*) matches the same commands as Bash(ls *).
  let p = pattern;
  if (p.endsWith(':*)')) p = p.slice(0, -3) + ' *)';
  else if (p.endsWith(':*')) p = p.slice(0, -2) + ' *';

  // A bare tool name — no parentheses AND no glob characters — matches all
  // uses of that tool.  "Read" matches Read, Read(file), Read(*) etc.
  // If the pattern has * or ?, it is a glob and falls through to globToRegex.
  if (!p.includes('(') && !p.includes('*') && !p.includes('?')) {
    const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('^' + escaped + '(\\(.*\\))?$');
    return re.test(entry);
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
      // Escape regex metacharacters except * and ?
      case '(': case ')': case '[': case ']':
      case '{': case '}': case '\\': case '^':
      case '$': case '.': case '|': case '+':
      case ':':  // colon is literal in the pattern (after :* normalisation)
        re += '\\' + ch;
        break;
      default:
        re += ch;
    }
  }
  return new RegExp(`^${re}$`);
}

/**
 * Check whether a tool call matches any hard-deny pattern.
 *
 * @param {string} toolName
 * @param {object} toolInput
 * @param {string[]} deniedPatterns
 * @returns {{ denied: boolean, matchedPattern?: string }}
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
 *
 * @param {string} toolName
 * @param {object} toolInput
 * @param {string[]} allowedPatterns
 * @returns {boolean}
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

/**
 * Read the hook input from stdin and return the parsed tool-call.
 *
 * @returns {Promise<object>}
 */
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

/**
 * Write a JSON permission decision to stdout.
 *
 * Exit 0 + JSON body with `permissionDecision` → Claude Code blocks/allows
 * the call.  Exit 0 + no JSON → normal permission flow (auto-approve for
 * allowed-tools, deny otherwise).
 *
 * @param {{ decision?: string, reason?: string }} opts
 */
function writeDecision({ decision, reason } = {}) {
  if (!decision) {
    // No decision → normal flow (already-allowed tools take this path).
    process.exit(0);
  }

  const output = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
    },
  };
  if (reason) {
    output.hookSpecificOutput.permissionDecisionReason = reason;
  }
  process.stdout.write(JSON.stringify(output), 'utf8');
  process.exit(0);
}

/**
 * Entry point for the hook helper script.
 *
 * Called as `node .agent/permission-hook.mjs`.  Reads the tool call from
 * stdin, applies ALCLI hard-deny and allowlist checks, and either exits
 * silently (already-allowed tools) or requests a decision from the
 * controller via the file relay.
 *
 * @param {string} repoRoot - repository root for file paths
 * @param {string[]} denyPatterns - hard-deny patterns (comma-separated env)
 * @param {string[]} allowPatterns - static allowed tools (comma-separated env)
 */
export async function runHook({ repoRoot, denyPatterns, allowPatterns }) {
  const input = await readHookInput();

  if (!input || !input.tool_name) {
    // Malformed input — exit silently, let normal flow handle it.
    process.exit(0);
  }

  const toolName = input.tool_name;
  const toolInput = input.tool_input ?? {};

  // 1. Hard-deny check — deny immediately, no relay needed.
  const hardCheck = checkHardDeny(toolName, toolInput, denyPatterns);
  if (hardCheck.denied) {
    writeDecision({ decision: 'deny', reason: `Blocked by ALCLI hard-deny rule: ${hardCheck.matchedPattern}` });
  }

  // 2. Static allowlist check — exit silently, normal flow auto-approves.
  if (isAllowedByConfig(toolName, toolInput, allowPatterns)) {
    writeDecision();
  }

  // 3. Relay to controller via file IPC.
  const reqPath = path.join(repoRoot, REQUEST_FILE);
  const resPath = path.join(repoRoot, RESPONSE_FILE);

  const request = {
    tool_name: toolName,
    tool_input: toolInput,
    timestamp: Date.now(),
  };

  try {
    fs.mkdirSync(path.dirname(reqPath), { recursive: true });
    fs.writeFileSync(reqPath, JSON.stringify(request), 'utf8');
  } catch {
    // Cannot write — deny.
    writeDecision({ decision: 'deny', reason: 'Permission relay unavailable.' });
  }

  // Poll for response (max 5 minutes, 200ms interval).
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    await sleep(200);
    try {
      if (!fs.existsSync(resPath)) continue;
      const raw = fs.readFileSync(resPath, 'utf8');
      // Clean up both files.
      try { fs.unlinkSync(reqPath); } catch { /* ok */ }
      try { fs.unlinkSync(resPath); } catch { /* ok */ }

      const response = JSON.parse(raw);
      if (response.approved) {
        writeDecision({ decision: 'allow', reason: response.reason });
      } else {
        writeDecision({ decision: 'deny', reason: response.reason ?? 'Permission denied by user.' });
      }
    } catch {
      // File may be partially written; keep polling.
    }
  }

  // Timeout — deny.
  writeDecision({ decision: 'deny', reason: 'Permission relay timed out.' });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/* ------------------------------------------------------------------ *
 * Controller-side logic                                               *
 * ------------------------------------------------------------------ */

/**
 * Write the Claude Code PreToolUse hook settings file and helper script.
 *
 * @param {string} repoRoot
 * @param {{
 *   denyPatterns?: string[],
 *   allowPatterns?: string[],
 * }} config
 */
export function writeHookSettings(repoRoot, { denyPatterns = [], allowPatterns = [] } = {}) {
  const settingsPath = path.join(repoRoot, '.agent', 'hook-settings.json');
  const hookScriptPath = path.join(repoRoot, '.agent', 'permission-hook.mjs');

  fs.mkdirSync(path.dirname(hookScriptPath), { recursive: true });

  // Write the hook helper script with the patterns embedded at generation
  // time.  These are static for the lifetime of the controller invocation.
  const script = generateHookScript({ repoRoot, denyPatterns, allowPatterns });
  fs.writeFileSync(hookScriptPath, script, 'utf8');

  // Write the settings file that configures the PreToolUse hook.
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
 * Generate the hook helper script content with the given config embedded.
 *
 * @param {{ repoRoot: string, denyPatterns: string[], allowPatterns: string[] }} config
 * @returns {string}
 */
function generateHookScript({ repoRoot, denyPatterns, allowPatterns }) {
  return HOOK_SCRIPT_TEMPLATE
    .replace('__REPO_ROOT__', JSON.stringify(repoRoot))
    .replace('__DENY_PATTERNS__', JSON.stringify(denyPatterns))
    .replace('__ALLOW_PATTERNS__', JSON.stringify(allowPatterns));
}

/**
 * Clean up the hook artefacts written by `writeHookSettings`.
 *
 * @param {string} repoRoot
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
 * Permission-request watcher result.
 *
 * @typedef {{ request: object|null, stop: boolean }} WatchResult
 */

/**
 * Poll for a permission-request file.  Returns the parsed request when found,
 * or `null` when the poll interval elapsed with nothing.
 *
 * @param {string} repoRoot
 * @param {number} timeoutMs - how long to wait before returning null
 * @returns {Promise<object|null>}
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
    } catch {
      // File appeared but isn't readable yet.
    }
    await sleep(50);
  }

  return null;
}

/**
 * Write a permission-response file.
 *
 * @param {string} repoRoot
 * @param {{ approved: boolean, reason?: string }} response
 */
export function writeResponse(repoRoot, response) {
  const resPath = path.join(repoRoot, RESPONSE_FILE);
  fs.mkdirSync(path.dirname(resPath), { recursive: true });
  fs.writeFileSync(resPath, JSON.stringify(response), 'utf8');
}

/**
 * Format the permission-request prompt shown to the user.
 *
 * @param {{ toolName: string, toolInput: object, hasReusableRule: boolean, permissionRule?: string }} request
 * @returns {string}
 */
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
    const cmd = toolArgs(request.toolInput);
    if (cmd) lines.push(`  Action: ${cmd}`);
    for (const [key, value] of Object.entries(request.toolInput)) {
      if (key === 'command') continue;
      lines.push(`  ${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
    }
  }

  lines.push('');

  if (request.hasReusableRule && request.permissionRule) {
    lines.push('  [1] Yes — allow once');
    lines.push(`  [2] Yes — accept reusable permission: ${request.permissionRule}`);
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
 *
 * @param {string} input - raw input line
 * @param {{ hasReusableRule: boolean }} options
 * @returns {{ kind: 'allow-once' | 'allow-similar' | 'deny' | 'invalid', raw: string }}
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
 *
 * @param {object} request
 * @returns {Promise<{ kind: string, permissionRule?: string } | null>}
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
            `  Unrecognised choice "${answer.trim()}". ` +
            `Please enter 1, ${hasReusable ? '2, 3' : 'or 2'}.\n`,
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
 * Inline hook helper script                                            *
 * ------------------------------------------------------------------ */

/**
 * The hook helper script template.
 *
 * Written to `.agent/permission-hook.mjs` before Claude is launched, with
 * `__REPO_ROOT__`, `__DENY_PATTERNS__`, and `__ALLOW_PATTERNS__` replaced
 * at generation time.  Runs as `node .agent/permission-hook.mjs` inside the
 * PreToolUse hook, receiving the hook input JSON on stdin.
 *
 * The utilities here are duplicated from the module's shared functions so
 * the hook script has zero dependencies outside Node.js built-ins.
 */
const HOOK_SCRIPT_TEMPLATE = `// ALCLI permission-relay hook helper — PreToolUse integration.
// Auto-generated; do not edit by hand.

import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = __REPO_ROOT__;
const DENY_PATTERNS = __DENY_PATTERNS__;
const ALLOW_PATTERNS = __ALLOW_PATTERNS__;

const REQUEST_FILE = '.agent/permission-request.json';
const RESPONSE_FILE = '.agent/permission-response.json';

/* ----- shared utilities (inlined from permission-relay.mjs) ----- */

function buildToolEntry(toolName, toolInput) {
  if (!toolName || typeof toolName !== 'string') return null;
  const args = toolArgs(toolInput);
  return args ? toolName + '(' + args + ')' : toolName;
}

function toolArgs(input) {
  if (!input || typeof input !== 'object') return '';
  if (typeof input.command === 'string') return input.command;
  if (typeof input.file_path === 'string') return input.file_path;
  if (typeof input.pattern === 'string') return input.pattern;
  if (typeof input.url === 'string') return input.url;
  const pairs = Object.entries(input)
    .filter(function([, v]) { return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'; })
    .map(function([k, v]) { return String(k) + '=' + String(v); })
    .join(' ');
  return pairs || '';
}

function patternMatches(entry, pattern) {
  var p = pattern;
  if (p.endsWith(':*)')) p = p.slice(0, -3) + ' *)';
  else if (p.endsWith(':*')) p = p.slice(0, -2) + ' *';
  // Bare tool name (no parens, no glob chars) matches all uses of that tool.
  if (p.indexOf('(') === -1 && p.indexOf('*') === -1 && p.indexOf('?') === -1) {
    var escaped = p.replace(/[.*+?^\${}()|[\]\\\\]/g, '\\\\$&');
    return new RegExp('^' + escaped + '(\\\\(.*\\\\))?$').test(entry);
  }
  var re = '';
  for (var i = 0; i < p.length; i++) {
    var ch = p[i];
    if (ch === '*') re += '.*';
    else if (ch === '?') re += '.';
    else if ('()[]{}\\\\^$.|+'.indexOf(ch) !== -1) re += '\\\\' + ch;
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

function sleep(ms) {
  return new Promise(function(r) { setTimeout(r, ms); });
}

/* ----- main ----- */

async function main() {
  // Read hook input from stdin.
  var data = '';
  process.stdin.setEncoding('utf8');
  for await (var chunk of process.stdin) { data += chunk; }

  var input;
  try { input = JSON.parse(data); } catch (e) { process.exit(0); }

  if (!input || !input.tool_name) { process.exit(0); }

  var toolName = input.tool_name;
  var toolInput = input.tool_input || {};

  // 1. Hard-deny — deny immediately.
  var hardCheck = checkHardDeny(toolName, toolInput, DENY_PATTERNS);
  if (hardCheck.denied) {
    var out = JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'Blocked by ALCLI hard-deny rule: ' + hardCheck.matchedPattern,
      },
    });
    process.stdout.write(out, 'utf8');
    process.exit(0);
  }

  // 2. Static allowlist — exit silently, normal flow auto-approves.
  if (isAllowedByConfig(toolName, toolInput, ALLOW_PATTERNS)) {
    process.exit(0);
  }

  // 3. Relay to controller.
  var reqPath = path.join(REPO_ROOT, REQUEST_FILE);
  var resPath = path.join(REPO_ROOT, RESPONSE_FILE);

  var request = {
    tool_name: toolName,
    tool_input: toolInput,
    timestamp: Date.now(),
  };

  try {
    fs.mkdirSync(path.dirname(reqPath), { recursive: true });
    fs.writeFileSync(reqPath, JSON.stringify(request), 'utf8');
  } catch (e) {
    var denyOut = JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'Permission relay unavailable.',
      },
    });
    process.stdout.write(denyOut, 'utf8');
    process.exit(0);
  }

  // Poll for response.
  var deadline = Date.now() + 300000;
  while (Date.now() < deadline) {
    await sleep(200);
    try {
      if (!fs.existsSync(resPath)) continue;
      var raw = fs.readFileSync(resPath, 'utf8');
      try { fs.unlinkSync(reqPath); } catch (e) {}
      try { fs.unlinkSync(resPath); } catch (e) {}

      var response = JSON.parse(raw);
      var decision = {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: response.approved ? 'allow' : 'deny',
        },
      };
      if (response.reason) {
        decision.hookSpecificOutput.permissionDecisionReason = response.reason;
      }
      process.stdout.write(JSON.stringify(decision), 'utf8');
      process.exit(0);
    } catch (e) {
      // File not ready yet.
    }
  }

  // Timeout.
  var timeoutOut = JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: 'Permission relay timed out.',
    },
  });
  process.stdout.write(timeoutOut, 'utf8');
  process.exit(0);
}

main();
`;
