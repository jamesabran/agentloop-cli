/**
 * The local review loop's decision engine.
 *
 * Given the saved task state and the live local HEAD, decide the single next
 * step. This module is pure — no I/O, no mutation of its inputs — so every
 * transition is directly testable.
 *
 * The loop it describes:
 *
 *   implement ─► audit ─► publish
 *       ▲          │
 *       └── fix ◄──┘   (at most MAX_CHANGE_ROUNDS times)
 *
 * Two rules shape everything here:
 *
 *  - **A verdict belongs to one commit.** `PUBLISH` requires an `APPROVED`
 *    whose audited commit is the commit at HEAD right now. Any newer commit
 *    voids the approval and sends the work back for a re-audit, so what gets
 *    pushed is exactly what was approved.
 *  - **Re-audits are incremental.** The second and later audits review
 *    `lastAuditedHead..HEAD` — the new commits only — plus whatever findings
 *    are still unresolved.
 */

import { BASE_BRANCH, MAX_CHANGE_ROUNDS } from './config.mjs';

export const ACTIONS = Object.freeze({
  /** Start or resume Claude on the first implementation of the task. */
  IMPLEMENT: 'IMPLEMENT',
  /** Return Codex's unresolved findings to Claude for another local commit. */
  FIX: 'FIX',
  /** Run the deterministic checks, then Codex, against the current HEAD. */
  AUDIT: 'AUDIT',
  /** Codex approved the exact current HEAD. Push the branch. */
  PUBLISH: 'PUBLISH',
  /** Nothing left to do; the branch is published. */
  DONE: 'DONE',
  /** Stop and hand back a local report. */
  STOP: 'STOP',
});

/**
 * @param {{
 *   state: object,
 *   head: string|null,
 *   maxChangeRounds?: number,
 * }} input
 * @returns {{ action: string, reason: string }}
 */
export function decideLocal({ state, head, maxChangeRounds = MAX_CHANGE_ROUNDS, publishMode = 'manual' }) {
  if (state.recoveryRequired) {
    return step(
      ACTIONS.STOP,
      'Claude recovery is required before another implementation process may start.',
    );
  }

  if (state.publishedHead && state.publishedHead === head) {
    return step(ACTIONS.DONE, `The approved commit ${head} is already published.`);
  }

  // Manual mode: the commit was approved, gates passed, but AgentLoop has
  // not pushed it.  Stop with the exact information the owner needs to
  // push manually.
  if (publishMode === 'manual' && state.readyToPublishHead && state.readyToPublishHead === head) {
    return step(
      ACTIONS.STOP,
      `Commit ${head} was approved and passed all publication gates on ` +
        `${state.branch ?? '(unknown branch)'}. Nothing has been pushed. ` +
        'Push this branch manually when you are ready.',
    );
  }

  // In auto mode an existing readyToPublishHead from a prior manual run
  // is ignored — the publish step re-validates every gate and pushes.
  if (publishMode === 'auto' && state.readyToPublishHead === head) {
    // Fall through to the APPROVED verdict check below so the publish
    // step re-runs all safety gates against the current HEAD.
  }

  if (state.verdict === 'BLOCKED') {
    return step(
      ACTIONS.STOP,
      'Codex reported BLOCKED. The loop does not work around an audit it could not complete.',
    );
  }

  // No commits on the branch yet: nothing has been implemented.
  if (!head || !state.implementationHead) {
    return step(ACTIONS.IMPLEMENT, 'No local checkpoint commit for this task yet.');
  }

  // The verdict on file is only about `lastAuditedHead`. Anything newer at
  // HEAD — a fix round, or a commit made outside the loop — is unreviewed.
  if (state.lastAuditedHead !== head) {
    if (state.implementationHead !== head) {
      return step(
        ACTIONS.STOP,
        `HEAD ${short(head)} has no matching valid Claude handoff, so Codex will not audit it.`,
      );
    }
    return step(
      ACTIONS.AUDIT,
      state.lastAuditedHead
        ? `HEAD moved to ${short(head)} since ${short(state.lastAuditedHead)} was audited.`
        : `Local checkpoint ${short(head)} has not been audited.`,
    );
  }

  if (state.verdict === 'APPROVED') {
    return step(
      ACTIONS.PUBLISH,
      `Codex approved ${short(head)}, which is still HEAD. Publishing the branch.`,
    );
  }

  if (state.verdict === 'REQUEST_CHANGES') {
    if (state.changeRounds >= maxChangeRounds) {
      return step(
        ACTIONS.STOP,
        `Codex requested changes ${state.changeRounds} times, the maximum for one task. ` +
          'Stopping with a local report rather than starting another round.',
      );
    }
    return step(
      ACTIONS.FIX,
      `Codex requested changes on ${short(head)} (${state.blockers.length} unresolved). ` +
        'Returning the findings to Claude.',
    );
  }

  // Audited, but no verdict recorded: the run was interrupted between the two.
  return step(ACTIONS.AUDIT, `No verdict recorded for ${short(head)}. Re-auditing.`);
}

/**
 * What Codex should be shown for the next audit.
 *
 * The first audit reviews everything the branch adds to the base. A re-audit
 * reviews only the commits added since the last audited HEAD — that is the
 * point of checkpoint commits — while the unresolved findings carry the
 * context for why those commits exist.
 *
 * @param {{ state: object, head: string, baseBranch?: string }} input
 * @returns {{ from: string, to: string, range: string, incremental: boolean, unresolved: string[] }}
 */
export function auditScope({ state, head, baseBranch = BASE_BRANCH }) {
  const incremental = Boolean(state.lastAuditedHead) && state.lastAuditedHead !== head;
  const from = incremental ? state.lastAuditedHead : baseBranch;
  return {
    from,
    to: head,
    range: `${from}..${head}`,
    incremental,
    unresolved: incremental ? (state.blockers ?? []) : [],
  };
}

/**
 * Pull the blocking findings out of a Codex report.
 *
 * The full report is written to `.agent/` and handed back to Claude verbatim,
 * so this only has to produce something the controller and the local report
 * can show as "still unresolved". It looks for the enumerated findings under a
 * heading that mentions blocking, and falls back to a pointer at the report
 * rather than inventing structure that is not there.
 *
 * @param {string} text the Codex report
 * @param {{ count?: number, round?: number }} context
 * @returns {string[]}
 */
export function extractBlockingFindings(text, { count = 0, round = 0 } = {}) {
  const lines = String(text ?? '').split(/\r?\n/);
  const findings = [];
  let inside = false;

  for (const line of lines) {
    const heading = /^#{1,6}\s+(.*)$/.exec(line.trim());
    if (heading) {
      // Enter on a blocking-findings heading, leave on the next heading.
      inside = /block/i.test(heading[1]) && !/non-?block/i.test(heading[1]);
      continue;
    }
    if (!inside) continue;

    const item = /^\s*(?:[-*+]|\d+[.)])\s+(.+)$/.exec(line);
    if (item) findings.push(item[1].trim().slice(0, 4000));
  }

  if (findings.length > 0) return findings.slice(0, 100);

  return [
    `${count || 'Unspecified'} blocking finding(s) from audit round ${round}; ` +
      'see the audit report in .agent/.',
  ];
}

/**
 * Render the local report the loop leaves behind when it stops.
 *
 * Everything the owner needs to decide what happens next, from local state
 * only: nothing here was posted anywhere, and nothing was pushed.
 *
 * @param {{
 *   state: object,
 *   head: string|null,
 *   decision: { action: string, reason: string },
 *   checks?: object[],
 *   commits?: { sha: string, subject: string }[],
 *   files?: string[],
 * }} input
 */
export function formatLocalReport({
  state,
  head,
  decision,
  checks = [],
  commits = [],
  files = [],
}) {
  const lines = [
    `# Local review report — task ${state.task ?? '(none)'}`,
    '',
    `Stopped: ${decision.action} — ${decision.reason}`,
    '',
    '## State',
    '',
    `- Task: ${state.task ?? '(none)'}`,
    `- Branch: ${state.branch ?? '(none)'}`,
    `- Implementation HEAD: ${state.implementationHead ?? '(none)'}`,
    `- Last audited HEAD: ${state.lastAuditedHead ?? '(none)'}`,
    `- Live HEAD: ${head ?? '(none)'}`,
    `- Review round: ${state.round}`,
    `- Change rounds used: ${state.changeRounds} of ${MAX_CHANGE_ROUNDS}`,
    `- Codex verdict: ${state.verdict ?? '(none)'}`,
    `- Published: ${state.publishedHead ?? 'no'}`,
    `- Ready to publish (manual): ${state.readyToPublishHead ?? 'no'}`,
    `- Claude recovery required: ${state.recoveryRequired ? 'yes' : 'no'}`,
  ];

  if (commits.length > 0) {
    lines.push('', '## Local commits', '');
    for (const commit of commits) lines.push(`- ${short(commit.sha)} ${commit.subject}`);
  }

  if (files.length > 0) {
    lines.push('', '## Files changed', '');
    for (const file of files) lines.push(`- ${file}`);
  }

  if (checks.length > 0) {
    lines.push('', '## Deterministic checks', '');
    for (const check of checks) {
      lines.push(`- ${check.ok ? 'PASS' : 'FAIL'} ${check.name} (npm run ${check.script})`);
    }
  }

  lines.push('', '## Unresolved blockers', '');
  if ((state.blockers ?? []).length === 0) {
    lines.push('None recorded.');
  } else {
    for (const blocker of state.blockers) lines.push(`- ${blocker}`);
  }

  lines.push(
    '',
    '## Next',
    '',
    'Nothing has been pushed and no pull request exists. Review the commits above,',
    state.recoveryRequired
      ? `then rerun with --recover --task ${state.task ?? '<task>'} only when it is safe to start a new Claude session.`
      : 'then either continue the loop with the same `--task`, or take the branch over by hand.',
    '',
  );

  return lines.join('\n');
}

function step(action, reason) {
  return { action, reason };
}

function short(sha) {
  return typeof sha === 'string' ? sha.slice(0, 7) : String(sha);
}
