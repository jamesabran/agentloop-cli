/**
 * Local git access.
 *
 * The review loop happens entirely in this working copy: Claude commits here,
 * Codex reads commits from here, and nothing leaves the machine until an
 * approved HEAD is published. Every helper below is scoped to `REPO_ROOT`.
 *
 * Only `publishBranch` touches the network, and it is called from exactly one
 * place — after Codex approves the commit that is still HEAD.
 */

import { BASE_BRANCH, LIMITS, REMOTE, REPO, REPO_ROOT } from './config.mjs';
import { parseGithubOwnerRepo } from './git-url.mjs';
import { CommandError, resolveExecutable, run, runOrThrow } from './process.mjs';

export { parseGithubOwnerRepo } from './git-url.mjs';

let gitPath = null;

function git() {
  gitPath ??= resolveExecutable('git', { override: process.env.AGENTLOOP_GIT_BIN });
  return gitPath;
}

/** Run git in the repository, throwing on a non-zero exit. */
export async function gitRun(args, options = {}) {
  return runOrThrow(git(), args, { cwd: REPO_ROOT, timeoutMs: LIMITS.cliTimeoutMs, ...options });
}

/** Run git, returning `null` instead of throwing when the command fails. */
export async function gitTry(args, options = {}) {
  const outcome = await run(git(), args, {
    cwd: REPO_ROOT,
    timeoutMs: LIMITS.cliTimeoutMs,
    ...options,
  });
  return outcome.code === 0 ? outcome.stdout.trim() : null;
}

/** The branch currently checked out, or null in a detached HEAD. */
export async function currentBranch() {
  const name = await gitTry(['rev-parse', '--abbrev-ref', 'HEAD']);
  return name === null || name === 'HEAD' ? null : name;
}

/** The full 40-character OID at HEAD, or null on an unborn branch. */
export async function headCommit() {
  return gitTry(['rev-parse', 'HEAD']);
}

/**
 * Is the working tree free of changes?
 *
 * A checkpoint commit is the unit of review, so an audit must never run over a
 * tree that has uncommitted work in it: Codex would be reading a commit that
 * does not describe what is on disk.
 *
 * @returns {Promise<{ clean: boolean, changes: string[] }>}
 */
export async function workingTreeStatus() {
  const porcelain = await gitRun(['status', '--porcelain=v1', '--untracked-files=all']);
  const changes = porcelain.split(/\r?\n/).filter((line) => line.trim() !== '');
  return { clean: changes.length === 0, changes };
}

/**
 * Check out the task's working branch, creating it from the base branch if it
 * does not exist yet.
 *
 * One local branch per task, by contract. If the branch exists it is used as
 * it stands — the loop never resets or rebases work it did not create.
 *
 * @param {string} branch
 * @returns {Promise<{ branch: string, created: boolean }>}
 */
export async function ensureBranch(branch) {
  const existing = await gitTry(['rev-parse', '--verify', `refs/heads/${branch}`]);

  if (existing === null) {
    await gitRun(['checkout', '-b', branch, BASE_BRANCH]);
    return { branch, created: true };
  }

  if ((await currentBranch()) !== branch) {
    await gitRun(['checkout', branch]);
  }
  return { branch, created: false };
}

/**
 * One-line summaries of the commits in `from..to`.
 *
 * `--oneline --no-abbrev-commit` rather than a `--format` string: `run` refuses
 * arguments containing characters `cmd.exe` would reinterpret, and `%` is one
 * of them. This produces the same `<full-sha> <subject>` lines without it.
 *
 * @returns {Promise<{ sha: string, subject: string }[]>}
 */
export async function commitsIn(from, to) {
  const output = await gitTry(['log', '--oneline', '--no-abbrev-commit', `${from}..${to}`]);
  if (!output) return [];
  return output
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const index = line.indexOf(' ');
      return { sha: line.slice(0, index), subject: line.slice(index + 1) };
    });
}

/** Files touched by `from..to`, for the local report. */
export async function filesChanged(from, to) {
  const output = await gitTry(['diff', '--name-only', `${from}...${to}`]);
  return output ? output.split(/\r?\n/).filter(Boolean) : [];
}

/**
 * Refuse to publish unless `{@link REMOTE}`'s push URL is actually `REPO`.
 *
 * `checkAuth()` (in `github.mjs`) only confirms the `gh` CLI's own credentials
 * can see `REPO` — that is a separate channel from git's remote, which is
 * what `publishBranch` actually pushes to. `REPO` was resolved from this same
 * remote when the config loaded (or pinned explicitly in
 * `agentloop.config.json`), but fixing the remote's *name* does not fix what
 * it points at: if it were ever repointed — a stale clone, a mistyped `git
 * remote set-url`, anything — `git push` would still succeed, just against
 * the wrong repository. This is the git-level counterpart to the `REPO`
 * boundary `config.mjs` already enforces for `gh`.
 */
export async function assertRemoteMatchesRepo() {
  const url = await gitTry(['remote', 'get-url', '--push', REMOTE]);
  const ownerRepo = parseGithubOwnerRepo(url);
  if (!REPO || ownerRepo !== REPO) {
    throw new CommandError(
      `Refusing to publish: remote "${REMOTE}" is ${url ? JSON.stringify(url) : 'not configured'}, ` +
        `not ${REPO ?? '(no repository boundary resolved)'}. The controller may only publish to ${
          REPO ?? 'a resolved repository — set "repo" in agentloop.config.json or configure the remote'
        }.`,
    );
  }
}

/**
 * Publish an approved branch.
 *
 * The only network write in the loop. The remote is checked against `REPO`
 * before anything else, and the commit that was approved is re-checked
 * against HEAD, and the push is pinned to that exact OID so a commit landing
 * in between is rejected by git rather than published unaudited.
 *
 * @param {{ branch: string, head: string, force?: boolean }} options
 */
export async function publishBranch({ branch, head }) {
  await assertRemoteMatchesRepo();

  const live = await headCommit();
  if (live !== head) {
    throw new CommandError(
      `Refusing to publish: HEAD is ${short(live)} but the approved commit is ${short(head)}.`,
    );
  }
  return gitRun(['push', REMOTE, `${head}:refs/heads/${branch}`]);
}

function short(sha) {
  return typeof sha === 'string' ? sha.slice(0, 7) : String(sha);
}
