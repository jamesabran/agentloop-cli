/**
 * Interactive Claude Permission Relay.
 *
 * When Claude or `claude-ds` requests permission during a stream-json session,
 * the controller intercepts the request, checks it against ALCLI hard-deny
 * rules, and — when running interactively — prompts the user for a decision.
 * The decision is relayed back to Claude's stdin so the session continues
 * without being terminated.
 *
 * Non-interactive runs never auto-approve: permission requests are denied and
 * Claude may adapt or the task stops.
 */

import { createInterface } from 'node:readline';

/**
 * Recognise a permission-request event in Claude's stream-json output.
 *
 * Claude Code's `--output-format stream-json` emits identifiable system-level
 * permission requests.  This detector looks for the supported shapes without
 * scraping rendered terminal prompts.
 *
 * Supported shapes (Claude Code / claude-ds):
 *  - `{"type":"system","subtype":"permission_request","tool_name":"...","tool_input":{...},"permission_rule":"..."}`
 *  - `{"type":"permission_request","tool_name":"...","tool_input":{...},"permission_rule":"..."}`
 *
 * @param {object} event - a parsed stream-json event
 * @returns {object|null} the permission request, or null if not a permission event
 */
export function detectPermissionRequest(event) {
  if (!event || typeof event !== 'object') return null;

  // Claude Code: system event with a permission_request subtype.
  if (event.type === 'system' && event.subtype === 'permission_request') {
    return normalise(event);
  }

  // Top-level permission_request event.
  if (event.type === 'permission_request') {
    return normalise(event);
  }

  return null;
}

function normalise(event) {
  return {
    toolName: typeof event.tool_name === 'string' ? event.tool_name : null,
    toolInput: event.tool_input ?? null,
    // The reusable permission rule Claude supplies, e.g. "Bash(npm test):/"
    // Only present when Claude offers a concrete scope the user can accept.
    permissionRule: typeof event.permission_rule === 'string' && event.permission_rule.trim() !== ''
      ? event.permission_rule.trim()
      : null,
    // Raw event preserved so the response can include any required correlation id.
    raw: event,
  };
}

/**
 * Check whether a requested tool matches any hard-deny pattern.
 *
 * Hard-deny rules are the existing disallowed-tool patterns plus additional
 * safety boundaries.  A match means the request is refused automatically —
 * the user is never offered a choice.
 *
 * @param {string} toolName - the requested tool name, e.g. "Bash"
 * @param {object} toolInput - the tool's input arguments
 * @param {string[]} deniedPatterns - patterns to check against,
 *   e.g. `["Bash(git push*)", "Bash(gh *)", "Bash(node *)", ...]`
 * @returns {{ denied: boolean, matchedPattern?: string }}
 */
export function checkHardDeny(toolName, toolInput, deniedPatterns) {
  if (!Array.isArray(deniedPatterns) || deniedPatterns.length === 0) {
    return { denied: false };
  }

  const entry = toolEntry(toolName, toolInput);
  if (!entry) return { denied: false };

  for (const pattern of deniedPatterns) {
    if (patternMatches(entry, pattern)) {
      return { denied: true, matchedPattern: pattern };
    }
  }

  return { denied: false };
}

/**
 * Build a canonical tool-entry string from a tool name and input for
 * pattern matching — same shape as the `--allowedTools` / `--disallowedTools`
 * comma-separated entries: `ToolName(args)` or plain `ToolName`.
 *
 * @param {string} toolName
 * @param {object} toolInput
 * @returns {string}
 */
function toolEntry(toolName, toolInput) {
  if (!toolName || typeof toolName !== 'string') return null;
  const args = toolArgs(toolInput);
  return args ? `${toolName}(${args})` : toolName;
}

/**
 * Format a tool's input as the string that appears inside `Bash(...)`.
 *
 * For Bash, the input is the command string.  For other tools, use a
 * best-effort serialisation.
 */
function toolArgs(input) {
  if (!input || typeof input !== 'object') return '';
  if (typeof input.command === 'string') return input.command;
  if (typeof input.file_path === 'string') return input.file_path;
  if (typeof input.pattern === 'string') return input.pattern;
  if (typeof input.url === 'string') return input.url;
  // Fallback: key=value pairs
  const pairs = Object.entries(input)
    .filter(([, v]) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
  return pairs || '';
}

/**
 * Match a tool entry against a glob-style pattern.
 *
 * The pattern language is Claude Code's: `*` matches any sequence of
 * characters, and the pattern is anchored at both ends (implicit `^...$`).
 *
 * @param {string} entry - the canonical tool entry, e.g. "Bash(git push origin main)"
 * @param {string} pattern - the deny pattern, e.g. "Bash(git push*)"
 * @returns {boolean}
 */
function patternMatches(entry, pattern) {
  const regex = globToRegex(pattern);
  return regex.test(entry);
}

/** Turn a Claude Code glob pattern into an anchored RegExp. */
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
        re += '\\' + ch;
        break;
      default:
        re += ch;
    }
  }
  return new RegExp(`^${re}$`);
}

/**
 * Format the permission-request prompt shown to the user.
 *
 * @param {{ toolName: string, toolInput: object, permissionRule: string|null }} request
 * @returns {string}
 */
export function formatPrompt(request) {
  const lines = [
    '',
    '╔══════════════════════════════════════════════════════════════╗',
    '║  Claude requests permission                                 ║',
    '╠══════════════════════════════════════════════════════════════╣',
    '',
    `  Tool: ${request.toolName ?? '(unknown)'}`,
  ];

  if (request.toolInput) {
    const cmd = toolArgs(request.toolInput);
    if (cmd) lines.push(`  Action: ${cmd}`);
    // Show relevant input fields
    for (const [key, value] of Object.entries(request.toolInput)) {
      if (key === 'command') continue; // already shown as Action
      lines.push(`  ${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
    }
  }

  lines.push('');

  if (request.permissionRule) {
    lines.push('  [1] Yes — allow once');
    lines.push(`  [2] Yes — accept Claude's reusable permission rule: ${request.permissionRule}`);
    lines.push('  [3] No — deny');
  } else {
    lines.push('  [1] Yes — allow once');
    lines.push('  [2] No — deny');
  }

  lines.push('');
  lines.push('╚══════════════════════════════════════════════════════════════╝');
  lines.push('');
  lines.push('Choice: ');

  return lines.join('\n');
}

/**
 * Parse the user's terminal input into a choice.
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

  // Acceptable words.
  const lower = trimmed.toLowerCase();
  if (lower === 'y' || lower === 'yes') return { kind: 'allow-once', raw: trimmed };
  if (lower === 'n' || lower === 'no') return { kind: 'deny', raw: trimmed };

  return { kind: 'invalid', raw: trimmed };
}

/**
 * Format a permission-approval response to write to Claude's stdin.
 *
 * @param {object} request - the original permission request (from detectPermissionRequest)
 * @param {{ rule?: string }} options
 * @returns {string} a JSON line
 */
export function formatApprovalResponse(request, { rule = null } = {}) {
  const response = {
    type: 'permission_response',
    approved: true,
  };

  // Include whatever correlation id the request carried so Claude Code can
  // route the response to the right pending request.
  if (request.raw?.id) response.id = request.raw.id;
  if (request.raw?.request_id) response.request_id = request.raw.request_id;

  // Accept the reusable scope when the user chose "allow similar".
  if (rule !== null) {
    response.permission_rule = rule;
  }

  return JSON.stringify(response) + '\n';
}

/**
 * Format a permission-denial response to write to Claude's stdin.
 *
 * @param {object} request - the original permission request
 * @returns {string} a JSON line
 */
export function formatDenialResponse(request) {
  const response = {
    type: 'permission_response',
    approved: false,
  };
  if (request.raw?.id) response.id = request.raw.id;
  if (request.raw?.request_id) response.request_id = request.raw.request_id;
  return JSON.stringify(response) + '\n';
}

/**
 * Prompt the user for a permission decision and return the choice.
 *
 * Returns `null` when stdin is not a TTY (non-interactive mode); the caller
 * must deny the request, never auto-approve.
 *
 * @param {object} request - the normalised permission request
 * @returns {Promise<{ kind: string, rule?: string } | null>}
 */
export function promptUser(request) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      resolve(null);
      return;
    }

    const hasReusable = request.permissionRule !== null;
    const prompt = formatPrompt(request);

    const rl = createInterface({ input: process.stdin, output: process.stdout });

    function ask() {
      rl.question(prompt, (answer) => {
        const choice = parseChoice(answer, { hasReusableRule: hasReusable });
        if (choice.kind === 'invalid') {
          process.stdout.write(`  Unrecognised choice "${answer.trim()}". Please enter 1, ${hasReusable ? '2, 3' : 'or 2'}.\n`);
          ask();
          return;
        }
        rl.close();
        if (choice.kind === 'allow-similar') {
          resolve({ kind: choice.kind, rule: request.permissionRule });
        } else {
          resolve({ kind: choice.kind });
        }
      });
    }

    ask();
  });
}

/**
 * Handle one permission request: check hard-deny, then either auto-deny or
 * prompt the user.  Returns the JSON line to write to Claude's stdin, or
 * `null` when the caller should stop (non-interactive denial where no safe
 * response is possible — the controller will terminate the session).
 *
 * @param {object} request - the normalised permission request
 * @param {string[]} deniedPatterns - hard-deny patterns from config
 * @returns {Promise<{ response: string|null, autoDenied: boolean, hardDenied: boolean }>}
 */
export async function handlePermissionRequest(request, deniedPatterns) {
  const hardDeny = checkHardDeny(request.toolName, request.toolInput, deniedPatterns);
  if (hardDeny.denied) {
    return {
      response: formatDenialResponse(request),
      autoDenied: true,
      hardDenied: true,
    };
  }

  const choice = await promptUser(request);

  if (choice === null) {
    // Non-interactive: deny, never auto-approve.
    return {
      response: formatDenialResponse(request),
      autoDenied: true,
      hardDenied: false,
    };
  }

  if (choice.kind === 'deny') {
    return {
      response: formatDenialResponse(request),
      autoDenied: false,
      hardDenied: false,
    };
  }

  return {
    response: formatApprovalResponse(request, { rule: choice.rule ?? null }),
    autoDenied: false,
    hardDenied: false,
  };
}
