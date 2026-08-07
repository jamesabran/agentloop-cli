/**
 * Local controller state for one task.
 *
 * The loop is local-first, so this file is the only record of where a task has
 * got to: which branch it is on, which commit Claude last produced, which
 * commit Codex last audited, what the verdict was, and what is still
 * unresolved. It lives in `.agent/`, is gitignored, and must never contain
 * credentials or patient data.
 *
 * Git remains the authority for what the code actually is. Every commit here
 * is re-read from the repository before it is acted on, so a stale or
 * hand-edited state file can slow the loop down but cannot make it audit or
 * publish the wrong thing.
 */

import fs from 'node:fs';
import path from 'node:path';

import { STATE_FILE } from './config.mjs';

// Version 4 intentionally rejects sessions from the retired GitHub-label
// controller and from the first local-first controller. Neither has the
// explicit-recovery and validated-handoff contracts required before Claude or
// Codex may run again.
export const STATE_VERSION = 4;

export const VERDICTS = Object.freeze(['APPROVED', 'REQUEST_CHANGES', 'BLOCKED']);

const SHA = /^[0-9a-f]{40}$/i;
/** Issue numbers, `#5`, and local slugs all qualify as a task identifier. */
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._\/#-]{0,127}$/;

/**
 * Every persisted key, with the shape it must have.
 *
 * The file is gitignored, editable by hand, and not authenticated, so it is
 * treated as untrusted input. A value that fails its check is dropped rather
 * than carried forward.
 */
const SCHEMA = Object.freeze({
  version: (value) => value === STATE_VERSION,
  /** Task or issue identifier this state belongs to. */
  task: (value) => value === null || (typeof value === 'string' && TASK_ID.test(value)),
  /** The one local working branch for the task. */
  branch: (value) => value === null || (typeof value === 'string' && value.length <= 255),
  /** Local commit Claude last reported as complete. */
  implementationHead: (value) => value === null || SHA.test(String(value)),
  /** Set only after the controller accepts Claude's complete handoff block. */
  implementationHandoffValid: (value) => typeof value === 'boolean',
  /** Local commit Codex last returned a verdict on. */
  lastAuditedHead: (value) => value === null || SHA.test(String(value)),
  /** Review round: 1 is the first audit, 2 the first re-audit, and so on. */
  round: (value) => Number.isInteger(value) && value >= 0 && value <= 1000,
  /** How many REQUEST_CHANGES verdicts this task has received. */
  changeRounds: (value) => Number.isInteger(value) && value >= 0 && value <= 1000,
  /** Codex's verdict on `lastAuditedHead`. */
  verdict: (value) => value === null || VERDICTS.includes(value),
  /** Findings Codex raised that have not yet been approved away. */
  blockers: (value) =>
    Array.isArray(value) &&
    value.length <= 100 &&
    value.every((entry) => typeof entry === 'string' && entry.length <= 4000),
  /** Set once the approved HEAD has been pushed. */
  publishedHead: (value) => value === null || SHA.test(String(value)),
  /** Set when manual mode approves and gates pass but nothing is pushed. */
  readyToPublishHead: (value) => value === null || SHA.test(String(value)),
  claudeSessionId: (value) => value === null || isUuid(value),
  consecutiveFailures: (value) => Number.isInteger(value) && value >= 0 && value <= 1000,
  failingStep: (value) => value === null || (typeof value === 'string' && value.length <= 64),
  usageLimitUntil: (value) => value === null || isIsoDate(value),
  usageLimitCount: (value) => Number.isInteger(value) && value >= 0 && value <= 100_000,
  /** A Claude terminal failure requires an owner-selected --recover run. */
  recoveryRequired: (value) => typeof value === 'boolean',
  recoveryReason: (value) => value === null || (typeof value === 'string' && value.length <= 4000),
  updatedAt: (value) => value === null || isIsoDate(value),
});

const ALLOWED_KEYS = Object.freeze(Object.keys(SCHEMA));

function isUuid(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
}

function isIsoDate(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

export function emptyState() {
  return {
    version: STATE_VERSION,
    task: null,
    branch: null,
    implementationHead: null,
    implementationHandoffValid: false,
    lastAuditedHead: null,
    round: 0,
    changeRounds: 0,
    verdict: null,
    blockers: [],
    publishedHead: null,
    readyToPublishHead: null,
    claudeSessionId: null,
    consecutiveFailures: 0,
    failingStep: null,
    usageLimitUntil: null,
    usageLimitCount: 0,
    recoveryRequired: false,
    recoveryReason: null,
    updatedAt: null,
    /** Fields rejected by the schema on the last load. Never persisted. */
    dropped: [],
  };
}

/**
 * Read the state file.
 *
 * A missing, unreadable, incompatible, or hand-edited file yields a fresh
 * state rather than an error. Losing it means the task restarts from its
 * branch rather than from mid-review — inconvenient, never unsafe.
 *
 * @param {string} [file]
 * @returns {object} state, with `dropped` listing any rejected fields
 */
export function loadState(file = STATE_FILE) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return emptyState();
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return emptyState();
  if (parsed.version !== STATE_VERSION) return emptyState();

  const clean = emptyState();
  const dropped = [];

  for (const key of ALLOWED_KEYS) {
    if (!(key in parsed)) continue;
    if (SCHEMA[key](parsed[key])) clean[key] = parsed[key];
    else dropped.push(key);
  }

  // The review position is only meaningful as a whole. If the task or the
  // branch it belongs to was rejected, the commits and the verdict describe
  // work we can no longer identify, so the task restarts rather than
  // inheriting a verdict that might belong to something else.
  if (dropped.includes('task') || dropped.includes('branch')) {
    return { ...emptyState(), dropped };
  }

  return { ...clean, dropped };
}

/**
 * Write the state file, creating `.agent/` if needed.
 * @param {object} state
 * @param {string} [file]
 */
export function saveState(state, file = STATE_FILE) {
  const next = { ...pick(state), version: STATE_VERSION, updatedAt: new Date().toISOString() };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}

/**
 * Select the task this run is working on.
 *
 * A different task is unrelated work: the review position, the Claude session,
 * and the blockers all belong to the previous one and are discarded. The same
 * task resumes exactly where it left off.
 *
 * @param {object} state
 * @param {{ task: string, branch: string }} context
 * @returns {{ state: object, resumed: boolean }}
 */
export function selectTask(state, { task, branch }) {
  if (state.task === task) {
    return { state: { ...state, branch: branch ?? state.branch }, resumed: true };
  }
  return { state: { ...emptyState(), task, branch }, resumed: false };
}

/** Record the local commit Claude just produced, voiding any earlier verdict. */
export function recordImplementation(state, head) {
  return {
    ...state,
    implementationHead: head,
    implementationHandoffValid: true,
    // A new commit invalidates the previous verdict: it was for a commit that
    // is no longer HEAD. `lastAuditedHead` is kept, because it is the start of
    // the range the next audit reviews.
    verdict: null,
    // A new commit also invalidates any previous manual-readiness — the new
    // commit has not been audited or approved.
    readyToPublishHead: null,
  };
}

/**
 * Record a Codex verdict against the commit it actually audited.
 *
 * @param {object} state
 * @param {{ head: string, verdict: string, blockers?: string[] }} audit
 */
export function recordAudit(state, { head, verdict, blockers = [] }) {
  return {
    ...state,
    lastAuditedHead: head,
    round: state.round + 1,
    changeRounds: verdict === 'REQUEST_CHANGES' ? state.changeRounds + 1 : state.changeRounds,
    verdict,
    blockers: verdict === 'APPROVED' ? [] : blockers,
  };
}

/** Record a failure on a named step and report whether the limit is reached. */
export function recordFailure(state, step, maxConsecutiveFailures) {
  const consecutiveFailures = state.failingStep === step ? state.consecutiveFailures + 1 : 1;
  return {
    state: { ...state, failingStep: step, consecutiveFailures },
    exhausted: consecutiveFailures >= maxConsecutiveFailures,
  };
}

/** Clear the failure counter after a step succeeds. */
export function clearFailures(state) {
  return { ...state, failingStep: null, consecutiveFailures: 0 };
}

/**
 * Record a temporary Claude usage-limit pause.
 *
 * This deliberately preserves `claudeSessionId`: a usage limit is a pause, and
 * the task resumes on the same session when usage returns.
 *
 * @param {object} state
 * @param {number} resumeAtMs epoch milliseconds
 */
export function recordUsageLimit(state, resumeAtMs) {
  return {
    ...state,
    usageLimitUntil: new Date(resumeAtMs).toISOString(),
    usageLimitCount: (state.usageLimitCount ?? 0) + 1,
  };
}

export function clearUsageLimit(state) {
  return { ...state, usageLimitUntil: null, usageLimitCount: 0 };
}

/**
 * Stop automatic Claude re-entry after a terminal failure.
 *
 * Session IDs are capabilities to continue an earlier conversation, so they
 * are deliberately discarded here. A later run must opt in with --recover
 * and will start a new Claude session.
 */
export function requireRecovery(state, reason) {
  return {
    ...clearUsageLimit(state),
    claudeSessionId: null,
    recoveryRequired: true,
    recoveryReason: String(reason).slice(0, 4000),
    // Recovery means the previous ready-to-publish state must be
    // revalidated through the workflow.
    readyToPublishHead: null,
  };
}

/** Clear the explicit-recovery marker immediately before a fresh Claude run. */
export function beginRecovery(state) {
  return {
    ...state,
    recoveryRequired: false,
    recoveryReason: null,
    // A recovered Claude session must revalidate any prior readiness.
    readyToPublishHead: null,
  };
}

/** Milliseconds still to wait, or 0 when the pause has elapsed. */
export function usageLimitRemainingMs(state, now = Date.now()) {
  if (!state.usageLimitUntil) return 0;
  const until = Date.parse(state.usageLimitUntil);
  if (Number.isNaN(until)) return 0;
  return Math.max(0, until - now);
}

function pick(object) {
  const out = {};
  for (const key of ALLOWED_KEYS) {
    if (object[key] !== undefined) out[key] = object[key];
  }
  return out;
}
