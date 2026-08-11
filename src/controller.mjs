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
 * Everything up to the push happens in this working copy. The implementer
 * (default: Claude) makes a local checkpoint commit; the controller runs the
 * deterministic checks against that commit and hands it to the auditor
 * (default: Codex) read-only; the auditor's findings come back to the
 * implementer as another local commit, and the re-audit sees only the new
 * commit range. Nothing is pushed, and nothing is posted to GitHub, until
 * the auditor approves the exact commit that is still HEAD.
 *
 * Agent roles (planner, implementer, auditor) are independently configurable
 * via `roles` in agentloop.config.json. Each maps to a supported provider;
 * the defaults preserve the existing Claude/Codex workflow.
 *
 * Usage: agentloop --task <id> [--dry-run] [...]
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

import {
  AGENT_DIR,
  BASE_BRANCH,
  DETERMINISTIC_CHECKS,
  LIMITS,
  MAX_CHANGE_ROUNDS,
  PROJECT_RUNTIME_VERIFICATION,
  PUBLISH_MODE,
  REMOTE,
  REPO,
  REPORT_FILE,
  REPO_ROOT,
  TASKS_FILE_RELATIVE,
} from './lib/config.mjs';
import { runImplementer, runAuditor, resolveRoleProvider, streamClaudeProgress } from './lib/agent-router.mjs';
import { classifyAuditOutcome } from './lib/audit.mjs';
import { failureExcerpt, runChecks, summariseChecks } from './lib/checks.mjs';
import {
  isRuntimeVerificationRequired,
  normaliseTaskRuntimeVerification,
  resolveRuntimeVerification,
  runRuntimeChecks,
  runtimeFailureExcerpt,
  summariseRuntimeChecks,
} from './lib/runtime-verification.mjs';
import { checkAuth, getIssue } from './lib/github.mjs';
import {
  assertRemoteMatchesRepo,
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
  recordImplementerRuntimeVerification,
  recordRuntimeVerification,
  requireRecovery,
  saveState,
  selectTask,
} from './lib/state.mjs';
import { readStatus } from './lib/status-block.mjs';
import {
  dependencyStatuses,
  encodeCacheKey,
  findTask,
  generateTaskBrief,
  isLegacySafeTaskId,
  isValidTaskId,
  loadTaskFile,
  resolveTaskFilePath,
  selectNextTask,
  validateTaskFile,
} from './lib/tasks.mjs';

const USAGE = `AgentLoop workflow controller — local implement-and-review loop

  agentloop --task <id> [options]
  agentloop --next [--dry-run]
  agentloop --setup

Options:
  --task <id>       Task or issue identifier to work on (required the first time)
  --next            Select the next task from agentloop.tasks.json deterministically
  --brief <file>    Task description to use instead of reading the issue
  --branch <name>   Local working branch (default: agent/task-<id>)
  --push-mode <mode> Publish mode: "manual" (default) or "auto". Overrides
                     AGENTLOOP_PUBLISH_MODE and publishMode in config.
  --dry-run         Report the next local step, change nothing
  --recover         Explicitly clear a terminal implementer failure and start a new session
  --self-check      Offline demonstration of the loop; no agents, no network
  --setup           Interactive first-run project setup and configuration
  --verbose         Include debug logging
  --help            Show this message

Task selection with --next is deterministic and auditable: the controller owns
the decision; the agents never choose which task comes next.

Local state, logs, audit reports, and the final report live in .agent/.
That directory is gitignored and never contains credentials.
`;

export function parseArgs(argv) {
  const options = {
    task: null,
    brief: null,
    branch: null,
    pushMode: null,
    dryRun: false,
    next: false,
    selfCheck: false,
    recover: false,
    setup: false,
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
      case '--setup':
        options.setup = true;
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
      case '--push-mode':
        {
          const raw = argv[i + 1] ?? null;
          i += 1;
          if (raw !== 'manual' && raw !== 'auto') {
            throw new Error(
              `--push-mode must be "manual" or "auto", got ${JSON.stringify(raw)}.`,
            );
          }
          options.pushMode = raw;
        }
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

  if (options.task !== null && !isValidTaskId(options.task.replace(/^#/, ''))) {
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
  const cache = path.join(AGENT_DIR, `brief-${encodeCacheKey(task)}.md`);

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

  // Legacy cache fallback: before the encoding changed to fixed-width
  // hex, cache files for simple alphanumeric-dash IDs were written
  // directly as `brief-<id>.md`. When the canonical file is missing
  // and the task ID is in the legacy-safe subset, check for an
  // exact-case directory entry and migrate atomically.
  if (isLegacySafeTaskId(task)) {
    var legacyName = 'brief-' + task + '.md';
    var exactMatch = false;
    try {
      var dirEntries = fs.readdirSync(AGENT_DIR);
      for (var di = 0; di < dirEntries.length; di++) {
        if (dirEntries[di] === legacyName) { exactMatch = true; break; }
      }
    } catch (dirErr) {
      if (dirErr.code !== 'ENOENT') throw dirErr;
    }
    if (exactMatch) {
      var legacyPath = path.join(AGENT_DIR, legacyName);
      var legacyBrief = fs.readFileSync(legacyPath, 'utf8');
      if (!options.dryRun) {
        var result = migrateLegacyCache(cache, legacyBrief);
        if (!result.migrated) {
          return { brief: result.canonical, source: cache };
        }
      }
      return { brief: legacyBrief, source: legacyPath + ' (migrated to canonical)' };
    }
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

/** Claim this invocation's one permitted implementer process. */
export function claimClaudeProcess(context) {
  if (context.claudeProcessesStarted >= 1) return false;
  context.claudeProcessesStarted += 1;
  return true;
}

/**
 * Ask whether to continue after a timeout.
 *
 * Empty input (Enter) defaults to yes — the `[Y/n]` convention. Only used when
 * stdin is a TTY; non-interactive runs never call this.
 *
 * @returns {Promise<boolean>} true to continue, false to stop
 */
function promptContinue() {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question('Execution timeout reached. Continue task? [Y/n] ', (answer) => {
      rl.close();
      const trimmed = answer.trim().toLowerCase();
      resolve(trimmed === '' || trimmed === 'y' || trimmed === 'yes');
    });
  });
}

/** A terminal implementer failure discards its session and requires --recover. */
function stopClaudeTerminal(context, step, reason) {
  const message = `${step} failed: ${reason}. ` +
    'The implementer session was discarded; inspect the local report and rerun with --recover only when ready.';
  context.state = requireRecovery(context.state, message);
  throw new LoopStopped(message);
}

/**
 * Pure state-transition for manual implementation — no I/O, fully testable.
 *
 * When `manualImplementationPending` is true and HEAD is a real commit,
 * the handoff accepts the first commit even if `implementHeadBefore` was
 * null (e.g. on an unborn branch).  Every subsequent run records a fresh
 * baseline so fixes after REQUEST_CHANGES require a new commit.
 *
 * @param {object} state — current controller state
 * @param {string|null} currentHead — current HEAD commit, or null if unavailable
 * @returns {{ action: 'accept' | 'wait', state: object }}
 */
export function manualImplementationAction(state, currentHead) {
  const recordedHead = state.implementHeadBefore;
  const isPending = state.manualImplementationPending === true;

  // Pending + real HEAD → check for acceptance.
  if (isPending && currentHead) {
    // First commit on an unborn branch: baseline was null, HEAD is now set.
    if (recordedHead === null) {
      return {
        action: 'accept',
        state: {
          ...state,
          implementHeadBefore: null,
          manualImplementationPending: false,
          claudeSessionId: null,
        },
      };
    }
    // New commit after a recorded baseline.
    if (currentHead !== recordedHead) {
      return {
        action: 'accept',
        state: {
          ...state,
          implementHeadBefore: null,
          manualImplementationPending: false,
          claudeSessionId: null,
        },
      };
    }
    // HEAD matches baseline — still waiting.
    return {
      action: 'wait',
      state: { ...state, claudeSessionId: null },
    };
  }

  // Not yet pending, or HEAD is still null.
  // Record baseline and set the pending flag so the next run can detect a commit.
  return {
    action: 'wait',
    state: {
      ...state,
      implementHeadBefore: currentHead,
      manualImplementationPending: true,
      claudeSessionId: null,
    },
  };
}

/**
 * Manual / External implementation handoff.
 *
 * When the implementer role is set to Manual / External, ALCLI does not
 * launch an agent.  Instead it records the current HEAD and stops.  The
 * user makes changes, commits, and re-runs ALCLI.  On re-run the
 * controller detects the new commit and proceeds to audit.
 */
async function handleManualImplementation({ context, options, fixing }) {
  const { state } = context;

  if (options.dryRun) {
    log.info('[dry-run] would pause for manual implementation.');
    throw new LoopStopped('Dry run: manual implementation step not executed.');
  }

  const before = await headCommit();
  const { action, state: nextState } = manualImplementationAction(state, before);

  if (action === 'accept') {
    log.info('Manual implementation detected — HEAD has advanced. Proceeding to audit.');

    // Run implementer-gate runtime verification, same as the automated path.
    if (context.runtimeVerification && isRuntimeVerificationRequired(context.runtimeVerification)) {
      const rvChecks = context.runtimeVerification.checks;
      if (rvChecks.length === 0) {
        throw new LoopStopped(
          `Runtime verification is required (profile: ${context.runtimeVerification.profile}) but no checks are configured. ` +
            'Add runtime verification checks to agentloop.config.json or the task configuration.',
        );
      }
      log.info('Running implementer-gate runtime verification for manual handoff…');
      const rvResult = await runRuntimeChecks({
        checks: rvChecks,
        onStart: (name) => log.info(`  ${name}`),
      });
      log.info(summariseRuntimeChecks(rvResult.results));
      if (!rvResult.ok) {
        const failedOutput = runtimeFailureExcerpt(rvResult.failed);
        throw new LoopStopped(
          `Implementer-gate runtime check "${rvResult.failed.name}" failed against ${short(before)}.\n\n${failedOutput}`,
        );
      }
      context.state = recordImplementerRuntimeVerification(nextState, {
        head: before,
        status: 'PASS',
        output: 'Implementer-gate runtime verification passed (manual).',
      });
    } else {
      context.state = recordImplementerRuntimeVerification(nextState, {
        head: before,
        status: 'NOT_REQUIRED',
      });
    }

    // Clear the baseline so the next manual run (including fixes) starts fresh.
    context.state = recordImplementation(
      clearFailures({ ...context.state, claudeSessionId: null, implementHeadBefore: null }),
      before,
    );
    return;
  }

  // action === 'wait': record baseline and stop.
  context.state = nextState;
  saveState(context.state);

  log.warn('═══════════════════════════════════════════════════════');
  log.warn('  Manual Implementation Required');
  log.warn('═══════════════════════════════════════════════════════');
  log.warn('');
  log.warn('  Implementer is set to Manual / External.');
  log.warn('  Make your changes, commit them, then re-run ALCLI.');
  log.warn('');

  throw new LoopStopped(
    'Manual implementation required. Make changes, commit, and re-run ALCLI to continue.',
  );
}

/**
 * Manual / External audit handoff.
 *
 * When the auditor role is set to Manual / External, ALCLI writes the audit
 * prompt and a decision template to .agent/, then stops.  The user reviews
 * the changes, records their decision, and re-runs ALCLI.  On re-run the
 * controller reads the decision and proceeds accordingly.
 */
async function handleManualAudit({ context, state, scope, head, checksResult, runtimeChecksResult, brief, identity, options }) {
  if (options.dryRun) {
    log.info('[dry-run] would pause for manual audit.');
    throw new LoopStopped('Dry run: manual audit step not executed.');
  }

  const decisionFile = path.join(AGENT_DIR, 'manual-audit-decision.json');

  // Check for an existing decision (from a previous run).
  if (fs.existsSync(decisionFile)) {
    let decision;
    try {
      decision = JSON.parse(fs.readFileSync(decisionFile, 'utf8'));
    } catch {
      log.warn('Could not parse manual audit decision file. Fix or delete it and re-run.');
      throw new LoopStopped(
        'Manual audit decision file is corrupt. Fix or delete ' + decisionFile + ' and re-run ALCLI.',
      );
    }

    if (decision.approved === true) {
      log.info('Manual audit: APPROVED.');
      fs.unlinkSync(decisionFile);
      // Record an audit result the controller can continue from.
      context.state = recordAudit(context.state, {
        head,
        verdict: 'APPROVED',
        blockers: [],
      });
      // Clear the prompt file if it exists.
      const promptFile = path.join(AGENT_DIR, 'manual-audit-prompt.md');
      try { fs.unlinkSync(promptFile); } catch { /* ok */ }
      return;
    }

    if (decision.approved === false) {
      log.info('Manual audit: REJECTED.');
      fs.unlinkSync(decisionFile);
      context.state = recordAudit(context.state, {
        head,
        verdict: 'REQUEST_CHANGES',
        blockers: [],
      });
      return;
    }

    // Decision exists but approved is neither true nor false.
    log.warn('Manual audit decision must have "approved": true or false.');
    throw new LoopStopped(
      'Manual audit decision must set "approved" to true or false. Edit ' + decisionFile + ' and re-run.',
    );
  }

  // No decision yet — write the prompt and a decision template.
  const promptText = auditPrompt({
    task: state.task,
    brief,
    head,
    scope,
    round: state.round + 1,
    checks: checksResult ? summariseChecks(checksResult.results) : '(none)',
    runtimeVerification: runtimeChecksResult
      ? summariseRuntimeChecks(runtimeChecksResult.results)
      : null,
    role: identity,
  });

  const promptFile = path.join(AGENT_DIR, 'manual-audit-prompt.md');
  fs.mkdirSync(AGENT_DIR, { recursive: true });
  fs.writeFileSync(promptFile, promptText, 'utf8');
  fs.writeFileSync(decisionFile, JSON.stringify({
    approved: null,
    comments: '',
    instructions: 'Set "approved" to true or false, add optional comments, save, and re-run ALCLI.',
  }, null, 2), 'utf8');

  saveState(context.state);

  log.warn('═══════════════════════════════════════════════════════');
  log.warn('  Manual Audit Required');
  log.warn('═══════════════════════════════════════════════════════');
  log.warn('');
  log.warn(`  Review the audit prompt:  ${promptFile}`);
  log.warn(`  Record your decision in:  ${decisionFile}`);
  log.warn('  Then re-run ALCLI to continue.');
  log.warn('');

  throw new LoopStopped(
    'Manual audit required. Review the prompt, record your decision, and re-run ALCLI.',
  );
}

/** Start or resume the implementer, and record the local commit it produced. */
async function runImplementerStep({ decision, context, options }) {
  const { state, brief } = context;
  const fixing = decision.action === ACTIONS.FIX;

  // Resolve the provider identity for status-block validation and prompts.
  const { provider, identity } = resolveRoleProvider('implementer');

  if (provider === 'manual') {
    return handleManualImplementation({ context, options, fixing });
  }

  const prompt = fixing
    ? fixPrompt({
        task: state.task,
        branch: state.branch,
        findings: readAuditReport(state),
        auditedCommit: state.lastAuditedHead,
        round: state.changeRounds,
        role: identity,
      })
    : implementationPrompt({
        task: state.task,
        branch: state.branch,
        brief,
        resumed: Boolean(state.claudeSessionId),
        role: identity,
      });

  if (options.dryRun) {
    log.info(
      `[dry-run] would ${fixing ? 'return audit findings to' : 'start'} implementer on task ` +
        `${state.task} (${prompt.length} character prompt)`,
    );
    return { continue: false, stopReason: 'Dry run: no agent was started.' };
  }

  if (!claimClaudeProcess(context)) {
    stopClaudeTerminal(
      context,
      fixing ? 'fix' : 'implementation',
      'the one-implementer-process limit for this controller invocation is exhausted',
    );
  }

  const treeBefore = await workingTreeStatus();
  if (!treeBefore.clean) {
    stopClaudeTerminal(
      context,
      fixing ? 'fix' : 'implementation',
      `the working tree is dirty (${treeBefore.changes.length} change(s)); implementer was not started`,
    );
  }

  const before = await headCommit();

  log.info(`${fixing ? 'Returning audit findings to' : 'Starting'} implementer (${identity}) on ${state.task}…`);
  let outcome;
  for (;;) {
    const resume = Boolean(context.state.claudeSessionId);
    try {
      outcome = await runImplementer({
        prompt,
        sessionId: resume ? context.state.claudeSessionId : null,
        resume,
        onStdout: streamClaudeProgress((progress) => {
          for (const line of progress.split(/\r?\n/)) {
            if (line.trim() !== '') log.info(`${identity}: ${line}`);
          }
        }),
        onLog: (line) => log.debug(line),
      });
    } catch (error) {
      stopClaudeTerminal(context, fixing ? 'fix' : 'implementation', error.message ?? 'process error');
    }

    context.state = { ...context.state, claudeSessionId: outcome.sessionId ?? context.state.claudeSessionId };

    if (outcome.usageLimited) {
      stopClaudeTerminal(
        context,
        fixing ? 'fix' : 'implementation',
        `${identity} process limit exhausted (${outcome.error ?? 'usage limit reached'})`,
      );
    }

    if (outcome.timedOut) {
      // Non-interactive runs must remain deterministic: no prompt, no wait.
      if (!process.stdin.isTTY) {
        stopClaudeTerminal(context, fixing ? 'fix' : 'implementation', outcome.error);
      }
      log.warn(`${identity} timed out after ${LIMITS.claudeTimeoutMs}ms.`);
      const cont = await promptContinue();
      if (!cont) {
        stopClaudeTerminal(context, fixing ? 'fix' : 'implementation', 'User chose to stop after timeout.');
      }
      log.info('Continuing with a fresh timeout window…');
      continue;
    }

    if (!outcome.ok) {
      stopClaudeTerminal(context, fixing ? 'fix' : 'implementation', outcome.error ?? 'non-zero process exit');
    }

    break;
  }

  const read = readStatus(outcome.text, { role: identity });
  if (!read.ok) {
    const detail = read.errors.length > 0 ? ` Errors: ${read.errors.join('; ')}` : '';
    stopClaudeTerminal(
      context,
      fixing ? 'fix status' : 'implementation status',
      `${identity} finished without exactly one valid AGENTLOOP_AGENT_STATUS block.${detail}`,
    );
  }

  const status = read.status;

  if (status.task !== state.task) {
    stopClaudeTerminal(context, fixing ? 'fix status' : 'implementation status',
      `${identity} reported TASK ${status.task} but the active task is ${state.task}.`,
    );
  }

  if (status.status === 'BLOCKED') {
    context.state = { ...context.state, blockers: [status.reason ?? 'no reason given'] };
    stopClaudeTerminal(context, fixing ? 'fix' : 'implementation',
      `${identity} reported BLOCKED: ${status.reason ?? 'no reason given'}`);
  }

  // The checkpoint has to exist, be HEAD, and be the whole of the change.
  const head = await headCommit();
  const tree = await workingTreeStatus();

  if (!tree.clean) {
    stopClaudeTerminal(context, fixing ? 'fix status' : 'implementation status',
      `${identity} reported READY_FOR_AUDIT but the working tree has ${tree.changes.length} ` +
        'uncommitted change(s). The commit under review must be the whole change.',
    );
  }
  if (status.head !== head) {
    stopClaudeTerminal(context, fixing ? 'fix status' : 'implementation status',
      `${identity} reported HEAD ${short(status.head)} but the branch is at ${short(head)}. ` +
        'A verdict is pinned to one commit, so the reported commit must be the real one.',
    );
  }
  // A no-change handoff — READY_FOR_AUDIT with HEAD exactly where it already
  // was — is only a valid checkpoint when every part of the contract holds for
  // that existing commit. The checks above already establish a clean tree and
  // a matching reported HEAD, from a status this invocation's own implementer
  // process just produced; isValidNoChangeHandoff re-asserts the rest (PASS,
  // no blockers) so the gate is legible and testable on its own.
  if (head === before && !isValidNoChangeHandoff({ status, head, treeClean: tree.clean })) {
    stopClaudeTerminal(context, fixing ? 'fix status' : 'implementation status',
      `${identity} reported READY_FOR_AUDIT without adding a commit; HEAD is still ${short(head)}.`,
    );
  }

  // Implementer-gate runtime verification: run before the handoff is accepted.
  // A FAIL here means the implementer must fix the code; the handoff is
  // rejected and the implementer session is discarded.
  if (context.runtimeVerification && isRuntimeVerificationRequired(context.runtimeVerification)) {
    const rvChecks = context.runtimeVerification.checks;
    if (rvChecks.length === 0) {
      // Required profile with no checks configured — fail safe.
      stopClaudeTerminal(
        context,
        fixing ? 'fix runtime verification' : 'implementation runtime verification',
        `Runtime verification is required (profile: ${context.runtimeVerification.profile}) but no checks are configured. ` +
          'Add runtime verification checks to agentloop.config.json or the task configuration.',
      );
    }

    log.info('Running implementer-gate runtime verification…');
    const rvResult = await runRuntimeChecks({
      checks: rvChecks,
      onStart: (name) => log.info(`  ${name}`),
    });
    log.info(summariseRuntimeChecks(rvResult.results));

    if (!rvResult.ok) {
      const failedOutput = runtimeFailureExcerpt(rvResult.failed);
      stopClaudeTerminal(
        context,
        fixing ? 'fix runtime verification' : 'implementation runtime verification',
        `Implementer-gate runtime check "${rvResult.failed.name}" failed against ${short(head)}.\n\n${failedOutput}`,
      );
    }

    // Record implementer-gate PASS so the auditor and publish gates can read it.
    context.state = recordImplementerRuntimeVerification(context.state, {
      head,
      status: 'PASS',
      output: 'Implementer-gate runtime verification passed.',
    });
  } else {
    context.state = recordImplementerRuntimeVerification(context.state, {
      head,
      status: 'NOT_REQUIRED',
    });
  }

  context.state = clearFailures(recordImplementation(context.state, head));
  log.info(
    head === before
      ? `${identity} reported a verified no-change handoff; local checkpoint ${short(head)} stands for task ${state.task}.`
      : `Local checkpoint ${short(head)} recorded for task ${state.task}.`,
  );
  // Deliberately end this invocation after a successful implementer process. A
  // later explicit controller invocation can run checks/audit or a fix, but
  // no loop can silently launch a second implementer process in the same run.
  return {
    continue: false,
    stopReason: `${identity} handoff recorded. Run the controller again to continue with checks and audit.`,
  };
}

/** Run the deterministic checks, then audit read-only, against the current HEAD. */
async function runAuditStep({ context, options }) {
  const { state, brief } = context;
  const head = await headCommit();

  if (!hasValidImplementationHandoff(state, head)) {
    throw new LoopStopped(
      `Refusing to start audit: implementationHead ${short(state.implementationHead)} does not ` +
        `match current HEAD ${short(head)} from a valid implementer handoff.`,
    );
  }
  const scope = auditScope({ state, head });

  const tree = await workingTreeStatus();
  if (!tree.clean) {
    throw new LoopStopped(
      `The working tree has ${tree.changes.length} uncommitted change(s). ` +
        'The auditor reviews a commit, so the tree must be clean before an audit starts.',
    );
  }

  // Resolve the provider identity for status-block validation.
  const { provider, identity } = resolveRoleProvider('auditor');

  if (options.dryRun) {
    log.info(
      `[dry-run] would run ${describeChecks()} against ${short(head)}, then start auditor ` +
        `(${identity}) read-only over ${scope.range}`,
    );
    return { continue: false, stopReason: 'Dry run: no checks and no agent were run.' };
  }

  log.info(`Running the deterministic checks against ${short(head)}…`);
  const checks = await runChecks({ onStart: (name) => log.info(`  npm run ${name}`) });
  context.checks = checks.results;
  log.info(summariseChecks(checks.results));

  if (!checks.ok) {
    // Not a review round: this is not a matter of opinion, and the auditor
    // should not be spending a review on something `tsc` or `vitest` already caught.
    throw new LoopStopped(
      `The deterministic check "${checks.failed.name}" failed against ${short(head)}.\n\n` +
        `${failureExcerpt(checks.failed)}`,
    );
  }

  // Runtime-verification auditor gate: when required for this task, run the
  // configured runtime checks independently against the current HEAD before
  // starting the auditor.  A failure here is a hard blocker — same as a
  // failed deterministic check.
  let runtimeChecksResult = null;
  if (context.runtimeVerification && isRuntimeVerificationRequired(context.runtimeVerification)) {
    const rvChecks = context.runtimeVerification.checks;
    if (rvChecks.length === 0) {
      // Required profile with no checks configured — fail safe.
      context.state = recordRuntimeVerification(context.state, {
        head,
        status: 'FAIL',
        output: `Runtime verification is required (profile: ${context.runtimeVerification.profile}) but no checks are configured.`,
        required: true,
        profile: context.runtimeVerification.profile,
      });
      throw new LoopStopped(
        `Runtime verification is required (profile: ${context.runtimeVerification.profile}) but no checks are configured. ` +
          'Add runtime verification checks to agentloop.config.json or the task configuration.',
      );
    }

    log.info('Running auditor-gate runtime verification…');
    runtimeChecksResult = await runRuntimeChecks({
      checks: rvChecks,
      onStart: (name) => log.info(`  ${name}`),
    });
    log.info(summariseRuntimeChecks(runtimeChecksResult.results));

    if (!runtimeChecksResult.ok) {
      const failedOutput = runtimeFailureExcerpt(runtimeChecksResult.failed);
      // Persist the failure so the state reflects it for resume/report.
      context.state = recordRuntimeVerification(context.state, {
        head,
        status: 'FAIL',
        output: failedOutput,
        required: true,
        profile: context.runtimeVerification.profile,
      });
      throw new LoopStopped(
        `The auditor-gate runtime check "${runtimeChecksResult.failed.name}" failed against ${short(head)}.\n\n` +
          `${failedOutput}`,
      );
    }

    // Persist the PASS result.
    context.state = recordRuntimeVerification(context.state, {
      head,
      status: 'PASS',
      output: summariseRuntimeChecks(runtimeChecksResult.results),
      required: true,
      profile: context.runtimeVerification.profile,
    });
  } else {
    // Runtime verification is not required — record that explicitly so the
    // publish gate knows it does not apply.
    context.state = recordRuntimeVerification(context.state, {
      head,
      status: 'NOT_REQUIRED',
      required: false,
    });
  }

  if (provider === 'manual') {
    return handleManualAudit({
      context, state, scope, head,
      checksResult: checks,
      runtimeChecksResult,
      brief, identity, options,
    });
  }

  log.info(`Starting auditor (${identity}, read-only) over ${scope.range}…`);
  const outcome = await runAuditor({
    prompt: auditPrompt({
      task: state.task,
      brief,
      head,
      scope,
      round: state.round + 1,
      checks: summariseChecks(checks.results),
      runtimeVerification: runtimeChecksResult
        ? summariseRuntimeChecks(runtimeChecksResult.results)
        : null,
      role: identity,
    }),
  });

  const classified = classifyAuditOutcome(outcome, readStatus(outcome.text, { role: identity }));

  if (classified.kind === 'audit_failed') {
    return afterFailedStep(context, 'audit', classified.reason);
  }
  if (classified.kind === 'unusable_status') {
    const detail = classified.errors.length > 0 ? ` Errors: ${classified.errors.join('; ')}` : '';
    return afterFailedStep(
      context,
      'audit-status',
      `${identity} finished without exactly one valid AGENTLOOP_AGENT_STATUS block.${detail}`,
    );
  }

  const status = classified.status;

  if (status.task !== state.task) {
    throw new LoopStopped(`${identity} reported TASK ${status.task} but the active task is ${state.task}.`);
  }
  if (status.status !== 'BLOCKED' && status.head !== head) {
    // The verdict is only meaningful for the commit that was actually audited.
    throw new LoopStopped(`${identity} was asked to audit ${head} but reported on ${status.head}.`);
  }

  const round = state.round + 1;
  writeAuditReport(state, round, outcome.text);

  if (status.status === 'BLOCKED') {
    context.state = recordAudit(context.state, {
      head,
      verdict: 'BLOCKED',
      blockers: [status.reason ?? 'no reason given'],
    });
    throw new LoopStopped(`${identity} reported BLOCKED: ${status.reason ?? 'no reason given'}`);
  }

  const blockers =
    status.status === 'REQUEST_CHANGES'
      ? extractBlockingFindings(outcome.text, { count: status.blockers, round })
      : [];

  context.state = clearFailures(
    recordAudit(context.state, { head, verdict: status.status, blockers }),
  );

  log.info(
    `${identity} ${status.status} on ${short(head)} (round ${round}, ` +
      `${status.blockers ?? 0} blocker(s)). Report: ${auditReportPath(state, round)}`,
  );
  return { continue: true };
}

/** The auditor may review only the exact checkpoint produced by a valid implementer handoff. */
export function hasValidImplementationHandoff(state, head) {
  return typeof head === 'string' &&
    state?.implementationHandoffValid === true &&
    state.implementationHead === head;
}

/**
 * A no-change implementer handoff — READY_FOR_AUDIT reported without a new
 * commit — is a valid checkpoint only when every part of the READY_FOR_AUDIT
 * contract holds for the commit that is already HEAD: verification passed, no
 * blockers, the reported HEAD is exactly the real one, and the tree is clean.
 * Without this, "no commit" would otherwise always be treated as a terminal
 * failure, even when the implementer correctly found nothing left to change.
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

/**
 * Atomically write legacy brief content to the canonical cache path.
 *
 * Uses exclusive creation (`wx` flag) so a canonical file created by
 * another process is never overwritten. On `EEXIST` the canonical
 * content is read and returned instead.
 *
 * The optional `opts.writeFile` parameter is a test seam: tests can
 * inject a function that intercepts the `writeFileSync` call for the
 * canonical cache path, creates the file with distinct content, and
 * throws `EEXIST` — deterministically exercising the race handler.
 *
 * @param {string} cache - canonical cache file path
 * @param {string} content - legacy brief content to migrate
 * @param {object} [opts]
 * @param {Function} [opts.writeFile] - injectable writeFileSync (test seam)
 * @returns {{ migrated: true } | { migrated: false, canonical: string }}
 */
export function migrateLegacyCache(cache, content, opts) {
  var _opts = opts || {};
  var writeFn = _opts.writeFile || fs.writeFileSync;
  try {
    fs.mkdirSync(path.dirname(cache), { recursive: true });
    writeFn(cache, content, { flag: 'wx' });
    return { migrated: true };
  } catch (writeErr) {
    if (writeErr.code === 'EEXIST') {
      return { migrated: false, canonical: fs.readFileSync(cache, 'utf8') };
    }
    throw writeErr;
  }
}

/**
 * Push the approved branch, or report it ready when publish mode is manual.
 *
 * The optional `_git` parameter is a test seam: tests inject mock
 * implementations of the git helpers (`headCommit`, `workingTreeStatus`,
 * `assertRemoteMatchesRepo`, `publishBranch`, `checkAuth`) so the full
 * publish control flow can be exercised without real git operations.
 *
 * @param {{ context: object, options: object, _git?: object }} input
 */
export async function runPublishStep({ context, options, _git, pushMode = PUBLISH_MODE }) {
  const g = _git || {};
  const hc = g.headCommit || headCommit;
  const wts = g.workingTreeStatus || workingTreeStatus;
  const armr = g.assertRemoteMatchesRepo || assertRemoteMatchesRepo;
  const pb = g.publishBranch || publishBranch;
  const ca = g.checkAuth || checkAuth;

  const { state } = context;
  const head = await hc();

  // decideLocal already established these; re-checking here is what makes the
  // push itself safe to read in isolation.
  if (state.verdict !== 'APPROVED' || state.lastAuditedHead !== head) {
    throw new LoopStopped(
      `Refusing to publish ${short(head)}: the approval on file is ` +
        `${state.verdict ?? 'none'} for ${short(state.lastAuditedHead)}.`,
    );
  }

  const tree = await wts();
  if (!tree.clean) {
    throw new LoopStopped(
      `Refusing to publish: the working tree has ${tree.changes.length} uncommitted change(s), ` +
        'so HEAD is not the whole of the approved work.',
    );
  }

  // Runtime-verification gate: both the implementer gate and the auditor
  // gate must be PASS for the exact commit being published or marked ready.
  if (state.runtimeVerificationRequired) {
    const auditorOk =
      state.runtimeVerificationStatus === 'PASS' &&
      state.runtimeVerificationHead === head;
    const implementerOk =
      state.implementerRuntimeVerificationStatus === 'PASS' &&
      state.implementerRuntimeVerificationHead === head;

    if (!auditorOk || !implementerOk) {
      throw new LoopStopped(
        `Refusing to publish ${short(head)}: required runtime verification gates are not satisfied. ` +
          `Auditor gate: ${state.runtimeVerificationStatus ?? 'not run'} ` +
          `(head: ${short(state.runtimeVerificationHead)}). ` +
          `Implementer gate: ${state.implementerRuntimeVerificationStatus ?? 'not run'} ` +
          `(head: ${short(state.implementerRuntimeVerificationHead)}). ` +
          'Both gates must be PASS for the exact commit being published.',
      );
    }
  }

  if (options.dryRun) {
    log.info(
      `[dry-run] ${pushMode === 'auto' ? 'would push' : 'would report ready for manual publishing'} ` +
        `${short(head)} on ${state.branch}`,
    );
    return { continue: false, stopReason: 'Dry run: nothing was pushed.' };
  }

  if (pushMode === 'manual') {
    // Re-validate the live remote against the pinned repository before
    // reporting readiness — the same check auto mode runs before pushing.
    await armr();
    context.state = clearFailures({ ...context.state, readyToPublishHead: head });
    log.info(
      `Commit ${head} on ${state.branch} was approved and passed all publication gates. ` +
        'Publish mode is manual — push this branch when you are ready.',
    );
    log.info(`  Branch:  ${state.branch}`);
    log.info(`  Remote:  ${REMOTE}`);
    log.info(`  Repo:    ${REPO}`);
    log.info('  Nothing has been pushed.');
    log.info(
      '  Safe manual action:\n' +
        `    git push ${REMOTE} ${head}:refs/heads/${state.branch}`,
    );
    log.info(
      'Open a pull request for this branch if you want one merged; ' +
        'the controller does not open, update, merge, or close one.',
    );
    return { continue: false, stopReason: 'Manual publish mode — the branch is ready for you to push.' };
  }

  await ca();
  log.info(`Publishing approved commit ${short(head)} to ${state.branch}…`);
  await pb({ branch: state.branch, head });

  context.state = clearFailures({ ...context.state, publishedHead: head, readyToPublishHead: null });
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
  return path.join(AGENT_DIR, `audit-${encodeCacheKey(state.task)}-round-${round}.md`);
}

function writeAuditReport(state, round, text) {
  fs.mkdirSync(AGENT_DIR, { recursive: true });
  fs.writeFileSync(auditReportPath(state, round), text, 'utf8');
}

/**
 * The findings the implementer has to answer.
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

  // When saved state references a task that no longer exists in the
  // committed roadmap, fail clearly. Silently selecting a different task
  // would discard the existing review/recovery state without the owner
  // ever knowing the active task went missing.
  if (activeTaskId && !activeTask) {
    throw new Error(
      `Saved active task ${JSON.stringify(activeTaskId)} was not found in ${tasksFilePath}. ` +
        'The task may have been removed, renamed, or the wrong task file is configured. ' +
        'Review the task file and either restore the missing task or remove .agent/state.json ' +
        'to start fresh.',
    );
  }

  if (activeTaskId && activeTask) {
    // Completed tasks must not resume. Blocked tasks must not resume —
    // they are deferred or genuinely blocked in the roadmap.
    if (activeTask.status === 'completed') {
      // Fall through to new-task selection below (completed tasks should
      // not be the active task, but if state was hand-edited, don't resume).
    } else if (activeTask.status === 'blocked') {
      throw new Error(
        `Saved active task ${JSON.stringify(activeTaskId)} ("${activeTask.title}") ` +
          `is blocked in ${tasksFilePath}. ` +
          'It cannot be resumed. Review the task file and either unblock the task ' +
          'or remove .agent/state.json to clear the saved state.',
      );
    } else {
      // Verify the active task still exists in the committed task file and
      // has an eligible status.
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
      const taskRv = normaliseTaskRuntimeVerification(activeTask.runtimeVerification, activeTaskId);
      const rv = resolveRuntimeVerification({ project: PROJECT_RUNTIME_VERIFICATION, task: taskRv });
      const brief = generateTaskBrief(
        activeTask,
        deps,
        DETERMINISTIC_CHECKS,
        MAX_CHANGE_ROUNDS,
        rv,
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
  const taskRv = normaliseTaskRuntimeVerification(nextTask.runtimeVerification, nextTask.id);
  const rv = resolveRuntimeVerification({ project: PROJECT_RUNTIME_VERIFICATION, task: taskRv });
  const brief = generateTaskBrief(
    nextTask,
    deps,
    DETERMINISTIC_CHECKS,
    MAX_CHANGE_ROUNDS,
    rv,
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
 * `.agent/`, modify runtime state, or invoke any agent.
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

/**
 * Resolve the effective push mode for this invocation.
 *
 * CLI --push-mode > AGENTLOOP_PUBLISH_MODE > agentloop.config.json publishMode > 'manual'.
 */
function resolvePushMode(options) {
  if (options.pushMode !== null) return options.pushMode;
  return PUBLISH_MODE;
}

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
  const pushMode = resolvePushMode(options);

  if (options.next) {
    const result = resolveNextTask({ loaded, options });
    task = result.task;
    generatedBrief = result.generatedBrief;
  } else {
    task = options.task ?? loaded.task;
    // `options.task` is already validated by parseArgs. `loaded.task`
    // comes from a hand-editable state file and must be re-checked here
    // because it bypasses the CLI guard.
    if (task && options.task === null && !isValidTaskId(task)) {
      log.error(
        `Saved task identifier ${JSON.stringify(task)} is not a valid task identifier. ` +
          'It may need repair in .agent/state.json, or select a task explicitly with --task or --next.',
      );
      return { stopReason: `Invalid saved task identifier: ${JSON.stringify(task)}.`, stopped: true };
    }
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

  // Resolve runtime-verification config for this task.
  // If the task file exists, look up the task-level config. For projects
  // without a task file (legacy), the task-level config is null and only
  // the project-level config matters.
  let taskRuntimeVerification = null;
  try {
    const tasksFilePath = resolveTaskFilePath(TASKS_FILE_RELATIVE, REPO_ROOT);
    if (fs.existsSync(tasksFilePath)) {
      const taskData = loadTaskFile(tasksFilePath);
      const validated = validateTaskFile(taskData, tasksFilePath);
      const taskEntry = findTask(validated.tasks, task);
      if (taskEntry) {
        taskRuntimeVerification = normaliseTaskRuntimeVerification(
          taskEntry.runtimeVerification,
          taskEntry.id,
        );
      }
    }
  } catch (error) {
    // Only ENOENT (task file not found) means "no task-level config".
    // Any other error — malformed file, invalid config, failed validation —
    // must propagate rather than silently treating runtime verification as
    // NOT_REQUIRED.
    if (error.code === 'ENOENT') {
      // No task file — treat as no task-level config.
    } else {
      throw error;
    }
  }
  const resolvedRv = resolveRuntimeVerification({
    project: PROJECT_RUNTIME_VERIFICATION,
    task: taskRuntimeVerification,
  });
  const rvRequired = isRuntimeVerificationRequired(resolvedRv);

  // Carry the runtime-verification requirement into the state so the decision
  // engine and the publish step can read it without re-resolving config.
  if (rvRequired !== selected.state.runtimeVerificationRequired ||
      (resolvedRv ? resolvedRv.profile : null) !== selected.state.runtimeVerificationProfile) {
    selected.state = {
      ...selected.state,
      runtimeVerificationRequired: rvRequired,
      runtimeVerificationProfile: resolvedRv ? resolvedRv.profile : null,
    };
  }

  const context = {
    state: selected.state,
    checks: [],
    claudeProcessesStarted: 0,
    runtimeVerification: resolvedRv,
  };

  log.section(`Task ${task} — ${branch}`);
  log.info(selected.resumed ? 'Resuming the saved review position.' : 'Starting a fresh task.');

  if (context.state.recoveryRequired) {
    if (!options.recover) {
      return {
        stopReason: `${context.state.recoveryReason ?? 'Implementer recovery is required.'} Pass --recover to start a new session.`,
        state: context.state,
        checks: context.checks,
        decision: { action: ACTIONS.STOP, reason: 'Explicit implementer recovery required.' },
        stopped: true,
      };
    }
    if (!options.dryRun) context.state = beginRecovery(context.state);
    log.warn('Explicit implementer recovery accepted. The prior implementer session remains discarded.');
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
      decision = decideLocal({ state: context.state, head, publishMode: pushMode });

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
          outcome = await runImplementerStep({ decision, context, options });
          break;
        case ACTIONS.AUDIT:
          outcome = await runAuditStep({ context, options });
          break;
        case ACTIONS.PUBLISH:
          outcome = await runPublishStep({ context, options, pushMode });
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
  const mutating = !options.dryRun && !options.selfCheck && !options.setup;
  configureLogger({ verbose: options.verbose, toFile: mutating });

  if (options.selfCheck) {
    const { runSelfCheck } = await import('./self-check.mjs');
    return runSelfCheck();
  }

  if (options.setup) {
    const { runSetup } = await import('./lib/setup.mjs');
    const result = await runSetup();
    return result.saved ? 0 : 0;
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
