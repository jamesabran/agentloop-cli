/**
 * AgentLoop workflow controller.
 *
 * Carries one task through a local implement-and-review loop, and publishes
 * only what has been approved:
 *
 *   implement ─► checks ─► audit ─► publish
 *       ▲                    │
 *       └──────── fix ◄──────┘   (at most two rounds)
 *
 * Everything up to the push happens in this working copy. Claude implements
 * and makes a local checkpoint commit; the controller runs the deterministic
 * checks against that commit and hands it to Codex read-only; Codex's findings
 * come back to Claude as another local commit, and the re-audit sees only the
 * new commit range. Nothing is pushed, and nothing is posted to GitHub, until
 * Codex approves the exact commit that is still HEAD.
 *
 * Usage: agentloop --task <id> [--dry-run] [...]
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import {
  AGENT_DIR,
  BASE_BRANCH,
  DETERMINISTIC_CHECKS,
  LIMITS,
  MAX_CHANGE_ROUNDS,
  REPO,
  REPORT_FILE,
  REPO_ROOT,
  TASKS_FILE_RELATIVE,
} from './lib/config.mjs';
import { runClaude, streamClaudeProgress } from './lib/claude-agent.mjs';
import { runCodexAudit } from './lib/codex-agent.mjs';
import { classifyAuditOutcome } from './lib/audit.mjs';
import { failureExcerpt, runChecks, summariseChecks } from './lib/checks.mjs';
import { checkAuth, getIssue } from './lib/github.mjs';
import {
  commitsIn,
  currentBranch,
  ensureBranch,
  filesChanged,
  headCommit,
  publishBranch,
  workingTreeStatus,
} from './lib/git.mjs';
import { configureLogger, log } from './lib/logger.mjs';
import { recoverCliArgs } from './lib/npm-args.mjs';
import { CommandError } from './lib/process.mjs';
import {
  ACTIONS,
  auditScope,
  decideLocal,
  extractBlockingFindings,
  formatLocalReport,
} from './lib/local-loop.mjs';
import { auditPrompt, fixPrompt, implementationPrompt } from './lib/prompts.mjs';
import {
  clearFailures,
  beginRecovery,
  loadState,
  recordAudit,
  recordFailure,
  recordImplementation,
  requireRecovery,
  saveState,
  selectTask,
} from './lib/state.mjs';
import { readStatus } from './lib/status-block.mjs';
import {
  dependencyStatuses,
  findTask,
  generateTaskBrief,
  loadTaskFile,
  resolveTaskFilePath,
  selectNextTask,
  validateTaskFile,
} from './lib/tasks.mjs';

const USAGE = `AgentLoop workflow controller — local implement-and-review loop

  agentloop --task <id> [options]
  agentloop --next [--dry-run]

Options:
  --task <id>       Task or issue identifier to work on (required the first time)
  --next            Select the next task from agentloop.tasks.json deterministically
  --brief <file>    Task description to use instead of reading the issue
  --branch <name>   Local working branch (default: agent/task-<id>)
  --dry-run         Report the next local step, change nothing
  --recover         Explicitly clear a terminal Claude failure and start a new session
  --self-check      Offline demonstration of the loop; no agents, no network
  --verbose         Include debug logging
  --help            Show this message

Task selection with --next is deterministic and auditable: the controller owns
the decision; Claude and Codex never choose which task comes next.

Local state, logs, audit reports, and the final report live in .agent/.
That directory is gitignored and never contains credentials.
`;

export function parseArgs(argv) {
  const options = {
    task: null,
    brief: null,
    branch: null,
    dryRun: false,
    next: false,
    selfCheck: false,
    recover: false,
    verbose: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--next':
        options.next = true;
        break;
      case '--self-check':
        options.selfCheck = true;
        break;
      case '--recover':
        options.recover = true;
        break;
      case '--verbose':
        options.verbose = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      case '--task':
        options.task = argv[i + 1] ?? null;
        i += 1;
        break;
      case '--brief':
        options.brief = argv[i + 1] ?? null;
        i += 1;
        break;
      case '--branch':
        options.branch = argv[i + 1] ?? null;
        i += 1;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  // --next conflicts with explicit --task and --brief
  if (options.next) {
    if (options.task !== null) {
      throw new Error('--next and --task are mutually exclusive. Use --next to select the next task deterministically, or --task <id> to work on a specific task.');
    }
    if (options.brief !== null) {
      throw new Error('--next and --brief are mutually exclusive. A custom brief is only valid with an explicitly supplied --task.');
    }
  }

  if (options.task !== null && !/^#?[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/.test(options.task)) {
    throw new Error(`--task ${JSON.stringify(options.task)} is not a valid task identifier.`);
  }
  if (options.task) options.task = options.task.replace(/^#/, '');

  // Caught here, before anything else runs, so `--branch main` never reaches
  // a checkout or an agent. This is the CLI half of the guard; selectBranch
  // below catches the other way `main` could end up selected — a saved
  // .agent/state.json whose branch field is the base branch.
  if (options.branch !== null && options.branch === BASE_BRANCH) {
    throw new Error(
      `--branch ${BASE_BRANCH} is not permitted. ${BASE_BRANCH} is the base branch; local ` +
        'implementation commits must go on a task branch instead.',
    );
  }

  return options;
}

/** A task the loop owns gets one branch, named from the task. */
export function defaultBranch(task) {
  return `agent/task-${String(task).replace(/[^A-Za-z0-9._-]+/g, '-')}`;
}

/**
 * Resolve the local working branch for a run, and refuse the base branch.
 *
 * `main` must never become the task branch: a checkout of it would let local
 * checkpoint commits land in the history every task shares, and the eventual
 * publishing push would try to fast-forward `main` itself instead of
 * publishing a task branch. `parseArgs` already refuses an explicit
 * `--branch main`; this catches the other way it could end up selected — a
 * saved `.agent/state.json` whose `branch` field is the base branch, whether
 * hand-edited or left over from an earlier bug.
 *
 * @param {{ optionsBranch: string|null, loaded: object, task: string }} input
 * @returns {{ rejected: true, branch: string } | { rejected: false, branch: string }}
 */
export function selectBranch({ optionsBranch, loaded, task }) {
  const branch =
    optionsBranch ?? (loaded.task === task ? loaded.branch : null) ?? defaultBranch(task);
  return branch === BASE_BRANCH ? { rejected: true, branch } : { rejected: false, branch };
}

class LoopStopped extends Error {}

/* ------------------------------------------------------------------ *
 * Task brief                                                          *
 * ------------------------------------------------------------------ */

/**
 * Resolve the task description both agents are given.
 *
 * A local file wins, then the copy cached in `.agent/`, then — only when the
 * task identifier is an issue number — a single read of that issue. That read
 * is the one time the loop touches GitHub before publishing, and it is a read:
 * the issue is never labelled, commented on, or closed.
 */
async function resolveBrief({ task, options, generatedBrief }) {
  const cache = path.join(AGENT_DIR, `brief-${task}.md`);

  // Cached on first resolution so later rounds — which may be separate
  // invocations, days apart — need neither the flag nor the network again.
  const remember = (brief) => {
    if (options.dryRun) return;
    fs.mkdirSync(AGENT_DIR, { recursive: true });
    fs.writeFileSync(cache, brief, 'utf8');
  };

  // A generated brief from --next / the committed task file takes highest
  // precedence. Cache it for resume, but the committed file is the durable
  // source of truth.
  if (generatedBrief !== undefined && generatedBrief !== null) {
    remember(generatedBrief);
    return { brief: generatedBrief, source: 'generated from committed task file' };
  }

  if (options.brief) {
    const brief = fs.readFileSync(options.brief, 'utf8');
    remember(brief);
    return { brief, source: options.brief };
  }

  if (fs.existsSync(cache)) {
    return { brief: fs.readFileSync(cache, 'utf8'), source: cache };
  }

  if (!/^\d+$/.test(task)) {
    throw new LoopStopped(
      `No brief for task "${task}". Pass --brief <file>, or use an issue number as the task id.`,
    );
  }

  await checkAuth();
  const issue = await getIssue(task);
  if (!issue) {
    throw new LoopStopped(`Issue #${task} could not be read from ${REPO}.`);
  }

  const brief = `Issue #${issue.number}: ${issue.title}\n${issue.url ?? ''}\n\n${
    issue.body ?? '(no description)'
  }`;
  remember(brief);

  return { brief, source: `${REPO} issue #${issue.number}` };
}

/* ------------------------------------------------------------------ *
 * Steps                                                               *
 * ------------------------------------------------------------------ */

/** Claim this invocation's one permitted Claude process. */
export function claimClaudeProcess(context) {
  if (context.claudeProcessesStarted >= 1) return false;
  context.claudeProcessesStarted += 1;
  return true;
}

/** A terminal Claude failure discards its session and requires --recover. */
function stopClaudeTerminal(context, step, reason) {
  const message = `Claude ${step} failed: ${reason}. ` +
    'Its session was discarded; inspect the local report and rerun with --recover only when ready.';
  context.state = requireRecovery(context.state, message);
  throw new LoopStopped(message);
}

/** Start or resume Claude, and record the local commit it produced. */
async function runClaudeStep({ decision, context, options }) {
  const { state, brief } = context;
  const fixing = decision.action === ACTIONS.FIX;

  const prompt = fixing
    ? fixPrompt({
        task: state.task,
        branch: state.branch,
        findings: readAuditReport(state),
        auditedCommit: state.lastAuditedHead,
        round: state.changeRounds,
      })
    : implementationPrompt({
        task: state.task,
        branch: state.branch,
        brief,
        resumed: Boolean(state.claudeSessionId),
      });

  if (options.dryRun) {
    log.info(
      `[dry-run] would ${fixing ? 'return Codex findings to' : 'start'} Claude on task ` +
        `${state.task} (${prompt.length} character prompt)`,
    );
    return { continue: false, stopReason: 'Dry run: no agent was started.' };
  }

  if (!claimClaudeProcess(context)) {
    stopClaudeTerminal(
      context,
      fixing ? 'fix' : 'implementation',
      'the one-Claude-process limit for this controller invocation is exhausted',
    );
  }

  const treeBefore = await workingTreeStatus();
  if (!treeBefore.clean) {
    stopClaudeTerminal(
      context,
      fixing ? 'fix' : 'implementation',
      `the working tree is dirty (${treeBefore.changes.length} change(s)); Claude was not started`,
    );
  }

  const before = await headCommit();

  log.info(`${fixing ? 'Returning Codex findings to Claude' : 'Starting Claude'} on ${state.task}…`);
  const resume = Boolean(state.claudeSessionId);
  let outcome;
  try {
    outcome = await runClaude({
      prompt,
      sessionId: resume ? state.claudeSessionId : null,
      resume,
      onStdout: streamClaudeProgress((progress) => {
        for (const line of progress.split(/\r?\n/)) {
          if (line.trim() !== '') log.info(`Claude: ${line}`);
        }
      }),
    });
  } catch (error) {
    stopClaudeTerminal(context, fixing ? 'fix' : 'implementation', error.message ?? 'process error');
  }

  context.state = { ...state, claudeSessionId: outcome.sessionId ?? state.claudeSessionId };

  if (outcome.usageLimited) {
    stopClaudeTerminal(
      context,
      fixing ? 'fix' : 'implementation',
      `Claude process limit exhausted (${outcome.error ?? 'usage limit reached'})`,
    );
  }

  if (!outcome.ok) {
    stopClaudeTerminal(context, fixing ? 'fix' : 'implementation', outcome.error ?? 'non-zero process exit');
  }

  const read = readStatus(outcome.text, { role: 'CLAUDE' });
  if (!read.ok) {
    const detail = read.errors.length > 0 ? ` Errors: ${read.errors.join('; ')}` : '';
    stopClaudeTerminal(
      context,
      fixing ? 'fix status' : 'implementation status',
      `Claude finished without exactly one valid AGENTLOOP_AGENT_STATUS block.${detail}`,
    );
  }

  const status = read.status;

  if (status.task !== state.task) {
    stopClaudeTerminal(context, fixing ? 'fix status' : 'implementation status',
      `Claude reported TASK ${status.task} but the active task is ${state.task}.`,
    );
  }

  if (status.status === 'BLOCKED') {
    context.state = { ...context.state, blockers: [status.reason ?? 'no reason given'] };
    stopClaudeTerminal(context, fixing ? 'fix' : 'implementation',
      `Claude reported BLOCKED: ${status.reason ?? 'no reason given'}`);
  }

  // The checkpoint has to exist, be HEAD, and be the whole of the change.
  const head = await headCommit();
  const tree = await workingTreeStatus();

  if (!tree.clean) {
    stopClaudeTerminal(context, fixing ? 'fix status' : 'implementation status',
      `Claude reported READY_FOR_AUDIT but the working tree has ${tree.changes.length} ` +
        'uncommitted change(s). The commit under review must be the whole change.',
    );
  }
  if (status.head !== head) {
    stopClaudeTerminal(context, fixing ? 'fix status' : 'implementation status',
      `Claude reported HEAD ${short(status.head)} but the branch is at ${short(head)}. ` +
        'A verdict is pinned to one commit, so the reported commit must be the real one.',
    );
  }
  // A no-change handoff — READY_FOR_AUDIT with HEAD exactly where it already
  // was — is only a valid checkpoint when every part of the contract holds for
  // that existing commit. The checks above already establish a clean tree and
  // a matching reported HEAD, from a status this invocation's own Claude
  // process just produced; isValidNoChangeHandoff re-asserts the rest (PASS,
  // no blockers) so the gate is legible and testable on its own.
  if (head === before && !isValidNoChangeHandoff({ status, head, treeClean: tree.clean })) {
    stopClaudeTerminal(context, fixing ? 'fix status' : 'implementation status',
      `Claude reported READY_FOR_AUDIT without adding a commit; HEAD is still ${short(head)}.`,
    );
  }

  context.state = clearFailures(recordImplementation(context.state, head));
  log.info(
    head === before
      ? `Claude reported a verified no-change handoff; local checkpoint ${short(head)} stands for task ${state.task}.`
      : `Local checkpoint ${short(head)} recorded for task ${state.task}.`,
  );
  // Deliberately end this invocation after a successful Claude process. A
  // later explicit controller invocation can run checks/audit or a fix, but
  // no loop can silently launch a second Claude process in the same run.
  return {
    continue: false,
    stopReason: 'Claude handoff recorded. Run the controller again to continue with checks and Codex.',
  };
}

/** Run the deterministic checks, then Codex read-only, against the current HEAD. */
async function runAuditStep({ context, options }) {
  const { state, brief } = context;
  const head = await headCommit();

  if (!hasValidImplementationHandoff(state, head)) {
    throw new LoopStopped(
      `Refusing to start Codex: implementationHead ${short(state.implementationHead)} does not ` +
        `match current HEAD ${short(head)} from a valid Claude handoff.`,
    );
  }
  const scope = auditScope({ state, head });

  const tree = await workingTreeStatus();
  if (!tree.clean) {
    throw new LoopStopped(
      `The working tree has ${tree.changes.length} uncommitted change(s). ` +
        'Codex audits a commit, so the tree must be clean before an audit starts.',
    );
  }

  if (options.dryRun) {
    log.info(
      `[dry-run] would run ${describeChecks()} against ${short(head)}, then start Codex ` +
        `read-only over ${scope.range}`,
    );
    return { continue: false, stopReason: 'Dry run: no checks and no agent were run.' };
  }

  log.info(`Running the deterministic checks against ${short(head)}…`);
  const checks = await runChecks({ onStart: (name) => log.info(`  npm run ${name}`) });
  context.checks = checks.results;
  log.info(summariseChecks(checks.results));

  if (!checks.ok) {
    // Not a review round: this is not a matter of opinion, and Codex should
    // not be spending an audit on something `tsc` or `vitest` already caught.
    throw new LoopStopped(
      `The deterministic check "${checks.failed.name}" failed against ${short(head)}.\n\n` +
        `${failureExcerpt(checks.failed)}`,
    );
  }

  log.info(`Starting Codex (read-only) over ${scope.range}…`);
  const outcome = await runCodexAudit({
    prompt: auditPrompt({
      task: state.task,
      brief,
      head,
      scope,
      round: state.round + 1,
      checks: summariseChecks(checks.results),
    }),
  });

  const classified = classifyAuditOutcome(outcome, readStatus(outcome.text, { role: 'CODEX' }));

  if (classified.kind === 'audit_failed') {
    return afterFailedStep(context, 'audit', classified.reason);
  }
  if (classified.kind === 'unusable_status') {
    const detail = classified.errors.length > 0 ? ` Errors: ${classified.errors.join('; ')}` : '';
    return afterFailedStep(
      context,
      'audit-status',
      `Codex finished without exactly one valid AGENTLOOP_AGENT_STATUS block.${detail}`,
    );
  }

  const status = classified.status;

  if (status.task !== state.task) {
    throw new LoopStopped(`Codex reported TASK ${status.task} but the active task is ${state.task}.`);
  }
  if (status.status !== 'BLOCKED' && status.head !== head) {
    // The verdict is only meaningful for the commit that was actually audited.
    throw new LoopStopped(`Codex was asked to audit ${head} but reported on ${status.head}.`);
  }

  const round = state.round + 1;
  writeAuditReport(state, round, outcome.text);

  if (status.status === 'BLOCKED') {
    context.state = recordAudit(context.state, {
      head,
      verdict: 'BLOCKED',
      blockers: [status.reason ?? 'no reason given'],
    });
    throw new LoopStopped(`Codex reported BLOCKED: ${status.reason ?? 'no reason given'}`);
  }

  const blockers =
    status.status === 'REQUEST_CHANGES'
      ? extractBlockingFindings(outcome.text, { count: status.blockers, round })
      : [];

  context.state = clearFailures(
    recordAudit(context.state, { head, verdict: status.status, blockers }),
  );

  log.info(
    `Codex ${status.status} on ${short(head)} (round ${round}, ` +
      `${status.blockers ?? 0} blocker(s)). Report: ${auditReportPath(state, round)}`,
  );
  return { continue: true };
}

/** Codex may audit only the exact checkpoint named by Claude's valid handoff. */
export function hasValidImplementationHandoff(state, head) {
  return typeof head === 'string' &&
    state?.implementationHandoffValid === true &&
    state.implementationHead === head;
}

/**
 * A no-change Claude handoff — READY_FOR_AUDIT reported without a new commit —
 * is a valid checkpoint only when every part of the READY_FOR_AUDIT contract
 * holds for the commit that is already HEAD: verification passed, no
 * blockers, the reported HEAD is exactly the real one, and the tree is clean.
 * Without this, "no commit" would otherwise always be treated as a terminal
 * failure, even when Claude correctly found nothing left to change.
 */
export function isValidNoChangeHandoff({ status, head, treeClean }) {
  return (
    status?.status === 'READY_FOR_AUDIT' &&
    status?.verification === 'PASS' &&
    status?.blockers === 0 &&
    typeof head === 'string' &&
    status?.head === head &&
    treeClean === true
  );
}

/** Push the approved branch. The only network write the loop performs. */
async function runPublishStep({ context, options }) {
  const { state } = context;
  const head = await headCommit();

  // decideLocal already established these; re-checking here is what makes the
  // push itself safe to read in isolation.
  if (state.verdict !== 'APPROVED' || state.lastAuditedHead !== head) {
    throw new LoopStopped(
      `Refusing to publish ${short(head)}: the approval on file is ` +
        `${state.verdict ?? 'none'} for ${short(state.lastAuditedHead)}.`,
    );
  }

  const tree = await workingTreeStatus();
  if (!tree.clean) {
    throw new LoopStopped(
      `Refusing to publish: the working tree has ${tree.changes.length} uncommitted change(s), ` +
        'so HEAD is not the whole of the approved work.',
    );
  }

  if (options.dryRun) {
    log.info(`[dry-run] would push ${short(head)} to ${state.branch}`);
    return { continue: false, stopReason: 'Dry run: nothing was pushed.' };
  }

  await checkAuth();
  log.info(`Publishing approved commit ${short(head)} to ${state.branch}…`);
  await publishBranch({ branch: state.branch, head });

  context.state = clearFailures({ ...context.state, publishedHead: head });
  log.info(
    `Published. Open a pull request for ${state.branch} when you want it reviewed for merge; ` +
      'the controller does not open, update, merge, or close one.',
  );
  return { continue: true };
}

/**
 * Record a retryable failure, or stop once the same step has failed enough.
 *
 * Retries happen on the next invocation, not in a spin loop: the controller
 * runs to a resting point and reports.
 */
function afterFailedStep(context, step, reason) {
  const failure = recordFailure(context.state, step, LIMITS.maxConsecutiveFailures);
  context.state = failure.state;
  if (failure.exhausted) {
    throw new LoopStopped(
      `The step "${step}" failed ${failure.state.consecutiveFailures} times: ${reason}`,
    );
  }
  log.warn(`Step "${step}" failed (${failure.state.consecutiveFailures}): ${reason}`);
  return { continue: false, stopReason: `${step} failed; run again to retry.` };
}

/* ------------------------------------------------------------------ *
 * Audit reports on disk                                               *
 * ------------------------------------------------------------------ */

function auditReportPath(state, round) {
  return path.join(AGENT_DIR, `audit-${state.task}-round-${round}.md`);
}

function writeAuditReport(state, round, text) {
  fs.mkdirSync(AGENT_DIR, { recursive: true });
  fs.writeFileSync(auditReportPath(state, round), text, 'utf8');
}

/**
 * The findings Claude has to answer.
 *
 * Read from disk rather than kept in memory so a fix round survives the
 * controller being restarted between the audit and the fix.
 */
function readAuditReport(state) {
  const file = auditReportPath(state, state.round);
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return (state.blockers ?? []).map((finding, index) => `${index + 1}. ${finding}`).join('\n');
  }
}

/* ------------------------------------------------------------------ *
 * Next-task resolution                                                *
 * ------------------------------------------------------------------ */

/**
 * Resolve the next task from the committed task file when `--next` is used.
 *
 * Validates the entire task file before any branch or state mutation, then
 * either resumes the active runtime task or selects the next one
 * deterministically from the validated file.
 *
 * @param {{ loaded: object, options: object }} input
 * @returns {{ task: string, generatedBrief: string }}
 */
function resolveNextTask({ loaded, options }) {
  const tasksFilePath = resolveTaskFilePath(TASKS_FILE_RELATIVE, REPO_ROOT);

  if (options.dryRun) {
    log.info(`Task file: ${tasksFilePath}`);
  }

  const taskData = loadTaskFile(tasksFilePath);
  const validated = validateTaskFile(taskData, tasksFilePath);
  const tasks = validated.tasks;
  const taskMap = new Map(tasks.map((t) => [t.id, t]));

  // Active-task resume: when valid runtime state already identifies an
  // active task, resume it through the existing recovery/resume rules.
  // Do not silently replace it with a newly selected task.
  const activeTaskId = loaded.task;
  const activeTask = activeTaskId ? findTask(tasks, activeTaskId) : null;

  if (activeTaskId && activeTask && activeTask.status !== 'completed') {
    // Verify the active task still exists in the committed task file and
    // has not been completed.
    if (options.dryRun) {
      log.info(
        `Resuming active task: ${JSON.stringify(activeTaskId)} ("${activeTask.title}") ` +
          `(status: ${activeTask.status})`,
      );
      log.info('  This is a resume, not a new selection — runtime state identifies an active task.');
    } else {
      log.info(
        `Resuming active task ${JSON.stringify(activeTaskId)} ("${activeTask.title}") ` +
          'from saved runtime state.',
      );
    }

    const deps = dependencyStatuses(activeTask, taskMap);
    const brief = generateTaskBrief(
      activeTask,
      deps,
      DETERMINISTIC_CHECKS,
      MAX_CHANGE_ROUNDS,
    );

    if (options.dryRun) {
      logDryRunNext({
        task: activeTask,
        deps,
        tasksFilePath,
        branch: options.branch ?? loaded.branch ?? defaultBranch(activeTaskId),
        isResume: true,
      });
    }

    return { task: activeTaskId, generatedBrief: brief };
  }

  // No resumable active task — select the next task deterministically.
  const selection = selectNextTask(tasks);
  const nextTask = selection.task;

  if (options.dryRun) {
    log.info(
      `Selecting next task: ${JSON.stringify(nextTask.id)} ("${nextTask.title}")`,
    );
    log.info(`  Reason: ${selection.reason}`);
  } else {
    log.info(
      `Selected next task: ${JSON.stringify(nextTask.id)} ("${nextTask.title}")`,
    );
    log.info(`  ${selection.reason}`);
  }

  const deps = dependencyStatuses(nextTask, taskMap);
  const brief = generateTaskBrief(
    nextTask,
    deps,
    DETERMINISTIC_CHECKS,
    MAX_CHANGE_ROUNDS,
  );

  if (options.dryRun) {
    logDryRunNext({
      task: nextTask,
      deps,
      tasksFilePath,
      branch: options.branch ?? defaultBranch(nextTask.id),
      isResume: false,
    });
  }

  return { task: nextTask.id, generatedBrief: brief };
}

/**
 * Show detailed dry-run information for `--dry-run --next`.
 *
 * Dry-run must not create branches, switch branches, write files, create
 * `.agent/`, modify runtime state, invoke Claude, or invoke Codex.
 */
function logDryRunNext({ task, deps, tasksFilePath, branch, isResume }) {
  log.info(`  Task ID: ${task.id}`);
  log.info(`  Title: ${task.title}`);
  log.info(`  Status: ${task.status}`);
  log.info(`  Goal: ${task.goal}`);

  if (deps.length > 0) {
    log.info('  Dependencies:');
    for (const dep of deps) {
      log.info(`    - ${dep.id}: ${dep.status}`);
    }
  } else {
    log.info('  Dependencies: none');
  }

  log.info(`  Branch: ${branch}`);
  log.info(`  Checks: ${DETERMINISTIC_CHECKS.map((c) => c.name).join(', ')}`);
  log.info(`  Max correction rounds: ${MAX_CHANGE_ROUNDS}`);
  log.info('  Brief: generated from the committed task file');
  log.info(`  Selection: ${isResume ? 'resuming active task' : 'new task selected deterministically'}`);
  log.info(`  Task file: ${tasksFilePath}`);
}

/* ------------------------------------------------------------------ *
 * Run                                                                 *
 * ------------------------------------------------------------------ */

async function runLoop(options) {
  const loaded = loadState();

  if (loaded.dropped?.length > 0) {
    log.warn(
      `Local state had unusable fields (${loaded.dropped.join(', ')}); they were discarded. ` +
        'Git remains the authority for what is actually committed.',
    );
  }

  let task;
  let generatedBrief = null;

  if (options.next) {
    const result = resolveNextTask({ loaded, options });
    task = result.task;
    generatedBrief = result.generatedBrief;
  } else {
    task = options.task ?? loaded.task;
  }

  if (!task) {
    // Nothing has been selected, so there is no state to report against and
    // nothing to resume. This is a usage problem, not a stopped task.
    log.info('No task selected and none saved in .agent/. Pass --task <id> or --next.');
    return { stopReason: 'No task selected.', usage: !options.dryRun };
  }

  const chosen = selectBranch({ optionsBranch: options.branch, loaded, task });
  if (chosen.rejected) {
    log.error(
      `Refusing to use "${BASE_BRANCH}" as the task branch — it is the base branch. Pass a ` +
        'different --branch, or fix .agent/state.json if it was saved with this one.',
    );
    return { stopReason: `"${BASE_BRANCH}" cannot be used as the task branch.`, stopped: true };
  }
  const branch = chosen.branch;
  const selected = selectTask(loaded, { task, branch });
  const context = { state: selected.state, checks: [], claudeProcessesStarted: 0 };

  log.section(`Task ${task} — ${branch}`);
  log.info(selected.resumed ? 'Resuming the saved review position.' : 'Starting a fresh task.');

  if (context.state.recoveryRequired) {
    if (!options.recover) {
      return {
        stopReason: `${context.state.recoveryReason ?? 'Claude recovery is required.'} Pass --recover to start a new session.`,
        state: context.state,
        checks: context.checks,
        decision: { action: ACTIONS.STOP, reason: 'Explicit Claude recovery required.' },
        stopped: true,
      };
    }
    if (!options.dryRun) context.state = beginRecovery(context.state);
    log.warn('Explicit Claude recovery accepted. The prior Claude session remains discarded.');
  }

  let stopReason = 'Reached the per-run step limit.';
  let decision = { action: ACTIONS.STOP, reason: stopReason };

  // A stop is a normal outcome, not a crash: the state and the local report
  // are what the owner picks the task back up from, so they are written on
  // every path out of the loop.
  try {
    const resolved = await resolveBrief({ task, options, generatedBrief });
    context.brief = resolved.brief;
    log.debug(`Task brief from ${resolved.source}.`);

    if (options.dryRun) {
      const live = await currentBranch();
      if (live !== branch) log.info(`[dry-run] would check out ${branch} (currently on ${live}).`);
    } else {
      const ensured = await ensureBranch(branch);
      if (ensured.created) log.info(`Created ${branch} from ${BASE_BRANCH}.`);
    }

    for (let step = 0; step < LIMITS.maxStepsPerRun; step += 1) {
      const head = await headCommit();
      decision = decideLocal({ state: context.state, head });

      log.state({
        'Live HEAD': short(head) ?? '(none)',
        'Implementation HEAD': short(context.state.implementationHead) ?? '(none)',
        'Last audited HEAD': short(context.state.lastAuditedHead) ?? '(none)',
        Round: `${context.state.round} (${context.state.changeRounds}/${MAX_CHANGE_ROUNDS} change rounds)`,
        Verdict: context.state.verdict ?? '(none)',
        Blockers: String((context.state.blockers ?? []).length),
      });
      log.info(`Next: ${decision.action} — ${decision.reason}`);

      let outcome;
      switch (decision.action) {
        case ACTIONS.IMPLEMENT:
        case ACTIONS.FIX:
          outcome = await runClaudeStep({ decision, context, options });
          break;
        case ACTIONS.AUDIT:
          outcome = await runAuditStep({ context, options });
          break;
        case ACTIONS.PUBLISH:
          outcome = await runPublishStep({ context, options });
          break;
        case ACTIONS.DONE:
        case ACTIONS.STOP:
          outcome = { continue: false, stopReason: decision.reason };
          break;
        default:
          throw new Error(`Unhandled action: ${decision.action}`);
      }

      if (!options.dryRun) saveState(context.state);

      if (!outcome.continue) {
        stopReason = outcome.stopReason ?? stopReason;
        break;
      }
    }
  } catch (error) {
    // A failed `gh` or `git` command is an operational stop, not a crash: it
    // gets the same saved state and the same local report as any other, so the
    // task is always resumable from where it actually got to.
    if (!(error instanceof LoopStopped) && !(error instanceof CommandError)) throw error;
    log.error(error.message);
    stopReason = error.message;
    decision = { action: ACTIONS.STOP, reason: error.message };
    if (!options.dryRun) saveState(context.state);
    return { stopReason, state: context.state, checks: context.checks, decision, stopped: true };
  }

  return { stopReason, state: context.state, checks: context.checks, decision };
}

/** Write and print the local report the run leaves behind. */
async function report({ state, checks, decision, stopReason, options }) {
  if (!state) return;

  const head = await headCommit().catch(() => null);
  // The whole of the branch's work, not just the last round: the report is
  // what someone picking the task up reads first.
  const commits = head ? await commitsIn(BASE_BRANCH, head).catch(() => []) : [];
  const files = head ? await filesChanged(BASE_BRANCH, head).catch(() => []) : [];

  const body = formatLocalReport({
    state,
    head,
    decision: decision ?? { action: 'STOP', reason: stopReason },
    checks,
    commits,
    files,
  });

  if (options.dryRun) {
    log.debug('[dry-run] the local report was not written.');
    return;
  }

  fs.mkdirSync(AGENT_DIR, { recursive: true });
  fs.writeFileSync(REPORT_FILE, body, 'utf8');
  log.info(`Local report: ${REPORT_FILE}`);
}

/* ------------------------------------------------------------------ *
 * Entry point                                                         *
 * ------------------------------------------------------------------ */

export async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${USAGE}`);
    return 2;
  }

  if (options.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  // Dry run and self-check write nothing at all — not even a log file. Their
  // contract is that the filesystem is identical afterwards.
  const mutating = !options.dryRun && !options.selfCheck;
  configureLogger({ verbose: options.verbose, toFile: mutating });

  if (options.selfCheck) {
    const { runSelfCheck } = await import('./self-check.mjs');
    return runSelfCheck();
  }

  log.info(`AgentLoop workflow controller — local loop${options.dryRun ? ' (dry run)' : ''}`);
  if (log.file()) log.debug(`Log file: ${log.file()}`);

  let outcome;
  try {
    outcome = await runLoop(options);
  } catch (error) {
    // Only reached before there is any task state to report against; runLoop
    // handles everything after that itself.
    log.error(error.stack ?? error.message);
    return 1;
  }

  if (outcome.usage) {
    process.stderr.write(USAGE);
    return 2;
  }

  await report({ ...outcome, options });
  log.info(`Stopped: ${outcome.stopReason}`);
  // Reaching a resting point the loop planned for — approved and published,
  // or the change-round limit — is success. `stopped` means something went
  // wrong and a person has to look at the report.
  return outcome.stopped ? 1 : 0;
}

function short(sha) {
  return typeof sha === 'string' ? sha.slice(0, 7) : sha;
}

function describeChecks() {
  return 'typecheck, lint, test, and build';
}

const invokedDirectly =
  process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;

if (invokedDirectly) {
  // `npm run agent -- --task <id> --branch <name>` can lose the flag names on
  // Windows PowerShell; see lib/npm-args.mjs for why and how this recovers them.
  main(recoverCliArgs(process.argv.slice(2))).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`${error.stack ?? error.message}\n`);
      process.exitCode = 1;
    },
  );
}
