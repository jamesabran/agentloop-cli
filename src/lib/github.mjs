/**
 * GitHub access through the `gh` CLI.
 *
 * The review loop is local, so this module is deliberately small. GitHub is
 * used for exactly two things:
 *
 *  1. Reading a task brief, when the task identifier is an issue number and no
 *     local brief was supplied. Read-only, once, before any agent starts.
 *  2. Confirming the repository is reachable before the approved branch is
 *     published.
 *
 * There is nothing here that writes: no labels, no comments, no pull requests,
 * no merges. Claude and Codex never exchange anything through GitHub, so a
 * half-finished task leaves no trace on it.
 *
 * Authentication belongs to `gh`. The controller never handles a token.
 */

import { LIMITS, REPO } from './config.mjs';
import { CommandError, npmGlobalDirs, resolveExecutable, run, runOrThrow } from './process.mjs';

let ghPath = null;

function gh() {
  ghPath ??= resolveExecutable('gh', {
    override: process.env.AGENTLOOP_GH_BIN,
    extraDirs: npmGlobalDirs(),
  });
  return ghPath;
}

/**
 * Run `gh`.
 * @param {string[]} args
 * @param {{ timeoutMs?: number, allowFailure?: boolean }} [options]
 */
export async function ghRun(args, options = {}) {
  const merged = { timeoutMs: LIMITS.cliTimeoutMs, ...options };
  if (merged.allowFailure) {
    const outcome = await run(gh(), args, merged);
    return outcome.code === 0 ? outcome.stdout.trim() : null;
  }
  return runOrThrow(gh(), args, merged);
}

/** Run `gh` and parse its `--json` output. */
export async function ghJson(args, options = {}) {
  const stdout = await ghRun(args, options);
  if (stdout === null) return null;
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new CommandError(`gh ${args.join(' ')} did not return JSON: ${error.message}`);
  }
}

/**
 * Verify `gh` is installed, authenticated, and can see the repository.
 *
 * Called only when the controller is about to use GitHub — to read a brief or
 * to publish. The local loop itself never needs the network.
 */
export async function checkAuth() {
  if (!REPO) {
    throw new CommandError(
      'No repository is configured. Set "repo" in agentloop.config.json, or add a GitHub ' +
        'remote to this project, before reading an issue or publishing.',
    );
  }
  const outcome = await run(gh(), ['auth', 'status'], { timeoutMs: 60_000 });
  if (outcome.code !== 0) {
    throw new CommandError(
      'gh is not authenticated. Run `gh auth login` and try again.\n' +
        (outcome.stderr || outcome.stdout).trim(),
    );
  }
  const repo = await ghJson(['repo', 'view', REPO, '--json', 'nameWithOwner'], {
    timeoutMs: 60_000,
  });
  if (repo?.nameWithOwner?.toLowerCase() !== REPO) {
    throw new CommandError(`Cannot access ${REPO} with the current gh credentials.`);
  }
  return repo.nameWithOwner;
}

/**
 * Read an issue so it can be used as the task brief.
 *
 * This is a read. The issue is not labelled, commented on, or closed by the
 * controller at any point — workflow state lives in `.agent/`, not on GitHub.
 *
 * @param {number|string} number
 * @returns {Promise<{ number: number, title: string, body: string, url: string } | null>}
 */
export async function getIssue(number) {
  if (!REPO) {
    throw new CommandError(
      'No repository is configured. Set "repo" in agentloop.config.json, or add a GitHub ' +
        'remote to this project, before reading an issue by number.',
    );
  }
  return ghJson(
    ['issue', 'view', String(number), '--repo', REPO, '--json', 'number,title,body,url,state'],
    { allowFailure: true },
  );
}
