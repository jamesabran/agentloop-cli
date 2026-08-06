/**
 * Parser for the `AGENTLOOP_AGENT_STATUS` handoff block.
 *
 * The block is the machine-readable contract between Claude, Codex, and this
 * controller, and it is now purely local: an agent's report is read straight
 * from its own stdout, never from a GitHub comment. It names the task and the
 * local commit it applies to, and nothing else.
 *
 * Field names and status values are exact. This module never repairs a
 * malformed block; it reports why it is malformed so the controller can stop
 * instead of guessing.
 *
 * This module is pure: no I/O, no process state.
 */

export const START_MARKER = 'AGENTLOOP_AGENT_STATUS';
export const END_MARKER = 'END_STATUS';

export const ROLES = Object.freeze(['CLAUDE', 'CODEX']);

export const STATUSES = Object.freeze([
  'READY_FOR_AUDIT',
  'REQUEST_CHANGES',
  'APPROVED',
  'BLOCKED',
]);

/** Required fields, and the exact `NEXT` value, for each status. */
const SHAPES = Object.freeze({
  READY_FOR_AUDIT: {
    role: 'CLAUDE',
    fields: ['ROLE', 'STATUS', 'TASK', 'HEAD', 'VERIFICATION', 'BLOCKERS', 'NEXT'],
    next: 'CODEX_AUDIT',
    // Claude writes `BLOCKERS: NONE`, Codex writes `BLOCKERS: 0`. Both parse
    // to 0; each is reproduced verbatim when a block is formatted.
    zeroBlockers: 'NONE',
  },
  REQUEST_CHANGES: {
    role: 'CODEX',
    fields: ['ROLE', 'STATUS', 'TASK', 'HEAD', 'BLOCKERS', 'NEXT'],
    next: 'CLAUDE_FIX',
  },
  APPROVED: {
    role: 'CODEX',
    fields: ['ROLE', 'STATUS', 'TASK', 'HEAD', 'BLOCKERS', 'NEXT'],
    next: 'CONTROLLER_PUBLISH',
  },
  BLOCKED: {
    role: null, // either agent may report a blocker
    fields: ['ROLE', 'STATUS', 'TASK', 'REASON', 'NEXT'],
    next: 'HUMAN_ASSISTANCE',
  },
});

const KNOWN_FIELDS = Object.freeze([
  'ROLE',
  'STATUS',
  'TASK',
  'HEAD',
  'VERIFICATION',
  'BLOCKERS',
  'REASON',
  'NEXT',
]);

const FIELD_LINE = /^([A-Z_]+):\s*(.*)$/;

/**
 * Commit hashes must be the full 40 characters.
 *
 * A verdict names the commit it applies to, and a 7-character prefix can also
 * prefix a *newer* commit — so an approval of an old checkpoint could
 * authorise publishing an unaudited one. Requiring the full OID removes the
 * ambiguity at the point the value enters the loop.
 */
const SHA = /^[0-9a-f]{40}$/i;

/** Issue numbers, `#5`, and local slugs all qualify as a task identifier. */
const TASK_ID = /^#?([A-Za-z0-9][A-Za-z0-9._\/#-]{0,127})$/;

/**
 * Pull every `AGENTLOOP_AGENT_STATUS` … `END_STATUS` region out of some text.
 *
 * Tolerates the surrounding noise these blocks arrive in: Markdown code
 * fences, blockquote prefixes, and free-form prose above the block.
 *
 * An unterminated region — a start marker with no `END_STATUS`, or a second
 * start marker before the first closed — is returned with `terminated: false`
 * rather than dropped. Silently discarding one would let a truncated newer
 * report hide behind an older complete one.
 *
 * @param {string} text
 * @returns {{ raw: string, index: number, terminated: boolean }[]} in document order
 */
export function extractStatusBlocks(text) {
  if (typeof text !== 'string' || text.length === 0) return [];

  const lines = text.split(/\r?\n/);
  const blocks = [];
  let open = null;

  const close = (terminated, endLine) => {
    blocks.push({
      raw: open.lines.join('\n'),
      index: open.start,
      endIndex: endLine,
      terminated,
    });
    open = null;
  };

  lines.forEach((line, lineNumber) => {
    const bare = stripDecoration(line);
    if (open === null) {
      if (bare === START_MARKER) open = { start: lineNumber, lines: [] };
      return;
    }
    if (bare === END_MARKER) {
      close(true, lineNumber);
      return;
    }
    // A second start marker means the previous region was never closed.
    if (bare === START_MARKER) {
      close(false, lineNumber - 1);
      open = { start: lineNumber, lines: [] };
      return;
    }
    open.lines.push(bare);
  });

  if (open !== null) close(false, lines.length - 1);

  return blocks;
}

/** Remove blockquote markers and code-fence indentation from one line. */
function stripDecoration(line) {
  return line.replace(/^[\s>]*/, '').trimEnd();
}

/**
 * Parse a single extracted block body.
 *
 * @param {string} raw body between the markers
 * @param {{ terminated?: boolean }} [region]
 * @returns {{
 *   valid: boolean, template: boolean, errors: string[], raw: string,
 *   role?: string, status?: string, task?: string, head?: string|null,
 *   verification?: string, blockers?: number, reason?: string, next?: string,
 * }}
 */
export function parseStatusBlock(raw, { terminated = true } = {}) {
  const errors = [];
  const fields = new Map();
  let template = false;

  if (!terminated) {
    errors.push(`Unterminated status block: no ${END_MARKER} line`);
  }

  for (const line of String(raw).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '') continue;

    const match = FIELD_LINE.exec(trimmed);
    if (!match) {
      errors.push(`Unparsable line: ${JSON.stringify(trimmed)}`);
      continue;
    }

    const [, key, value] = match;
    // `<task-id>` style placeholders mean this is documentation, not a real
    // status. Templates are skipped rather than reported as failures.
    if (/<[^>]*>/.test(value)) template = true;

    if (fields.has(key)) errors.push(`Duplicate field: ${key}`);
    if (!KNOWN_FIELDS.includes(key)) errors.push(`Unknown field: ${key}`);
    fields.set(key, value.trim());
  }

  // A truncated region is never dismissed as documentation: a real report cut
  // short can also contain angle brackets, so it must fail closed instead.
  if (template && terminated) {
    return { valid: false, template: true, errors: [], raw };
  }

  const role = fields.get('ROLE');
  const status = fields.get('STATUS');

  if (!ROLES.includes(role)) {
    errors.push(`ROLE must be one of ${ROLES.join(', ')} (got ${format(role)})`);
  }
  if (!STATUSES.includes(status)) {
    errors.push(`STATUS must be one of ${STATUSES.join(', ')} (got ${format(status)})`);
    return { valid: false, template: false, errors, raw };
  }

  const shape = SHAPES[status];
  for (const required of shape.fields) {
    if (!fields.has(required)) errors.push(`Missing field: ${required}`);
  }
  if (shape.role && role !== shape.role) {
    errors.push(`STATUS ${status} may only be reported by ${shape.role} (got ${format(role)})`);
  }

  const next = fields.get('NEXT');
  if (next !== undefined && next !== shape.next) {
    errors.push(`NEXT must be ${shape.next} for STATUS ${status} (got ${format(next)})`);
  }

  const task = parseTask(fields.get('TASK'), errors);

  let head = null;
  if (shape.fields.includes('HEAD')) {
    const rawHead = fields.get('HEAD');
    if (rawHead !== undefined) {
      if (SHA.test(rawHead)) {
        head = rawHead.toLowerCase();
      } else {
        errors.push(
          `HEAD must be a full 40-character commit hash (got ${format(rawHead)}). ` +
            'An abbreviation can prefix more than one commit, so it cannot pin a verdict.',
        );
      }
    }
  }

  let verification;
  if (shape.fields.includes('VERIFICATION')) {
    verification = fields.get('VERIFICATION');
    // READY_FOR_AUDIT means verification succeeded. Accepting FAIL would make
    // the parser disagree with the contract it enforces, so it does not.
    if (verification !== undefined && verification !== 'PASS') {
      errors.push(
        `VERIFICATION must be PASS for STATUS ${status} (got ${format(verification)}). ` +
          'Fix the verification failure before reporting, or report BLOCKED.',
      );
    }
  }

  let blockers;
  if (shape.fields.includes('BLOCKERS')) {
    blockers = parseBlockers(fields.get('BLOCKERS'), errors);

    // The count and the verdict must agree. An APPROVED block that also
    // reports blockers is self-contradictory and must not be actionable.
    if (blockers !== undefined) {
      if (status === 'APPROVED' && blockers !== 0) {
        errors.push(`STATUS APPROVED requires BLOCKERS: 0 (got ${blockers})`);
      }
      if (status === 'REQUEST_CHANGES' && blockers < 1) {
        errors.push(`STATUS REQUEST_CHANGES requires at least one blocker (got ${blockers})`);
      }
      if (status === 'READY_FOR_AUDIT' && blockers !== 0) {
        errors.push(`STATUS READY_FOR_AUDIT requires BLOCKERS: NONE (got ${blockers})`);
      }
    }
  }

  let reason;
  if (shape.fields.includes('REASON')) {
    reason = fields.get('REASON');
    if (reason !== undefined && reason === '') errors.push('REASON must not be empty');
  }

  return {
    valid: errors.length === 0,
    template: false,
    errors,
    raw,
    role,
    status,
    task,
    head,
    verification,
    blockers,
    reason,
    next,
  };
}

/** `#5`, `5`, and `local-spike` are all accepted; the `#` is not kept. */
function parseTask(value, errors) {
  if (value === undefined) return undefined;
  const match = TASK_ID.exec(value);
  if (!match) {
    errors.push(`TASK must be an issue number or a short identifier (got ${format(value)})`);
    return undefined;
  }
  return match[1];
}

function parseBlockers(value, errors) {
  if (value === undefined) return undefined;
  if (value === 'NONE') return 0;
  if (/^\d+$/.test(value)) return Number(value);
  errors.push(`BLOCKERS must be NONE or a number (got ${format(value)})`);
  return undefined;
}

function format(value) {
  return value === undefined ? 'nothing' : JSON.stringify(value);
}

/**
 * Parse every status block in a piece of text, in document order.
 * @param {string} text
 */
export function parseAllStatusBlocks(text) {
  return extractStatusBlocks(text).map(({ raw, terminated, endIndex }) => ({
    ...parseStatusBlock(raw, { terminated }),
    endIndex,
  }));
}

/**
 * Is there anything of substance after the status block?
 *
 * The block must be the report's final section. Blank lines, HTML comments,
 * and a closing code fence do not count.
 *
 * @param {string} text
 * @param {number} endIndex line the block's END_STATUS sits on
 * @returns {string|null} the first offending line, or null
 */
export function trailingContentAfter(text, endIndex) {
  const lines = String(text ?? '').split(/\r?\n/);

  for (let i = endIndex + 1; i < lines.length; i += 1) {
    const line = lines[i].replace(/^[\s>]*/, '').trim();
    if (line === '') continue;
    if (/^<!--.*-->$/.test(line)) continue;
    if (line === '```' || line === '~~~') continue; // closing fence
    return line;
  }

  return null;
}

/**
 * Read the one status a piece of text asserts.
 *
 * The contract says a report ends with exactly one status block. This enforces
 * that literally, and fails closed on anything else:
 *
 *  - No block at all → `{ ok: false, none: true }`.
 *  - More than one real block → refused as ambiguous. There is no
 *    "last one wins" rule to exploit by appending a second block.
 *  - Malformed, truncated, or wrong-role block → refused with the reasons.
 *
 * Documentation templates — blocks whose values are `<placeholders>` — are not
 * real blocks, so quoting the contract or a prompt cannot assert a status.
 *
 * @param {string} text
 * @param {{ role?: string }} [expect]
 * @returns {{ ok: boolean, none: boolean, status: object|null, errors: string[] }}
 */
export function readStatus(text, expect = {}) {
  const blocks = parseAllStatusBlocks(text).filter((block) => !block.template);

  if (blocks.length === 0) {
    return { ok: false, none: true, status: null, errors: [] };
  }

  if (blocks.length > 1) {
    return {
      ok: false,
      none: false,
      status: null,
      errors: [
        `Ambiguous report: ${blocks.length} status blocks where the contract allows one.`,
      ],
    };
  }

  const [block] = blocks;

  if (!block.valid) {
    return { ok: false, none: false, status: null, errors: block.errors };
  }

  if (expect.role && block.role !== expect.role) {
    return {
      ok: false,
      none: false,
      status: null,
      errors: [`Expected a ${expect.role} status but the report is from ${block.role}.`],
    };
  }

  // The contract says the block is the final section of the report. Content
  // after it means the report did not end where it claimed to.
  const trailing = trailingContentAfter(text, block.endIndex);
  if (trailing !== null) {
    return {
      ok: false,
      none: false,
      status: null,
      errors: [
        'The status block must be the final section of the report, but it is followed by: ' +
          JSON.stringify(trailing.slice(0, 80)),
      ],
    };
  }

  return { ok: true, none: false, status: block, errors: [] };
}

/**
 * Render a status block. Used to show each agent the exact shape its report
 * must end with.
 *
 * @param {Record<string, string|number|null>} fields
 * @returns {string}
 */
export function formatStatusBlock(fields) {
  const status = fields.STATUS;
  const shape = SHAPES[status];
  if (!shape) throw new Error(`Unknown STATUS: ${status}`);

  const lines = [START_MARKER];
  for (const key of shape.fields) {
    let value = fields[key];
    if (value === undefined || value === null) value = 'NONE';
    if (key === 'BLOCKERS' && value === 0) value = shape.zeroBlockers ?? 0;
    lines.push(`${key}: ${value}`);
  }
  lines.push(END_MARKER);
  return lines.join('\n');
}
