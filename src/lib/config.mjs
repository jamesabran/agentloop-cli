/**
 * Static configuration for the AgentLoop workflow controller.
 *
 * Nothing here is a secret. Authentication is delegated entirely to the
 * already-authenticated `gh`, `claude`, and `codex` CLIs on the owner's
 * machine. The controller never reads, stores, or forwards a token.
 *
 * The loop this configures is local-first: Claude implements and commits
 * locally, Codex audits the exact local commit, and only an approved local
 * HEAD is ever pushed. GitHub is a publishing target, not a message bus.
 *
 * AgentLoop is installed as a dev dependency into whatever project it runs
 * in — it never assumes anything about that project's name, purpose, or
 * remote. Everything project-specific is resolved at load time, from the
 * project's own git remote and from an optional `agentloop.config.json` at
 * its root.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { parseGithubOwnerRepo } from './git-url.mjs';

/**
 * Find the project AgentLoop is running in: the nearest ancestor of the
 * current working directory that has a `.git` directory. Falls back to the
 * starting directory itself so the controller still runs somewhere sane
 * outside a git checkout (a scratch directory in a test, for instance).
 */
export function findProjectRoot(startDir = process.cwd()) {
  let dir = path.resolve(startDir);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(startDir);
    dir = parent;
  }
}

export const REPO_ROOT = findProjectRoot();

const CONFIG_FILE = path.join(REPO_ROOT, 'agentloop.config.json');

/**
 * Everything project-specific the controller needs, in one small file at the
 * project root: the base branch, the deterministic verification commands,
 * the repository boundary, and agent settings. Optional — every field has a
 * sensible default, and a project with none of this still works.
 */
function loadProjectConfig(file) {
  if (!fs.existsSync(file)) return {};

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${error.message}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${file} must contain a JSON object.`);
  }
  return parsed;
}

const PROJECT_CONFIG = loadProjectConfig(CONFIG_FILE);

/** The remote an approved branch is published to. */
export const REMOTE =
  typeof PROJECT_CONFIG.remote === 'string' && PROJECT_CONFIG.remote.trim() !== ''
    ? PROJECT_CONFIG.remote.trim()
    : 'origin';

function resolveRepoFromGitRemote(repoRoot, remote) {
  try {
    const url = execFileSync('git', ['remote', 'get-url', remote], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return parseGithubOwnerRepo(url);
  } catch {
    return null;
  }
}

const CONFIGURED_REPO =
  typeof PROJECT_CONFIG.repo === 'string' && PROJECT_CONFIG.repo.trim() !== ''
    ? PROJECT_CONFIG.repo.trim().toLowerCase()
    : null;

/**
 * The one repository this controller run is allowed to touch.
 *
 * Resolved once, at load time — from `agentloop.config.json`'s `repo` field
 * if it sets one, otherwise from this project's `{@link REMOTE}` git remote.
 * There is no hardcoded target: AgentLoop runs in whatever project installs
 * it, so the boundary has to come from that project itself.
 *
 * `AGENTLOOP_REPO` may only assert whichever value was actually resolved —
 * never redirect it. This is the same boundary a previous, single-project
 * version of this controller enforced with a fixed default: without it, an
 * exported `AGENTLOOP_REPO` could aim every `gh` call, and the publishing
 * push, at a different repository than the one this checkout belongs to.
 * When neither the config file nor the git remote resolves a repository,
 * there is nothing yet to protect, so `AGENTLOOP_REPO` may supply one
 * directly — `assertRemoteMatchesRepo` in git.mjs still re-checks the live
 * `{@link REMOTE}` remote immediately before every push, regardless of how
 * REPO was resolved.
 */
const RESOLVED_REPO = CONFIGURED_REPO ?? resolveRepoFromGitRemote(REPO_ROOT, REMOTE);

const REPO_OVERRIDE = process.env.AGENTLOOP_REPO;
if (REPO_OVERRIDE !== undefined && REPO_OVERRIDE !== '') {
  if (RESOLVED_REPO !== null && REPO_OVERRIDE.toLowerCase() !== RESOLVED_REPO) {
    throw new Error(
      `AGENTLOOP_REPO=${JSON.stringify(REPO_OVERRIDE)} is not permitted. This run resolved ` +
        `${RESOLVED_REPO} from ${CONFIGURED_REPO ? 'agentloop.config.json' : `the "${REMOTE}" git remote`}, ` +
        'and an environment variable may only assert that value, not redirect it.',
    );
  }
}

export const REPO = RESOLVED_REPO ?? (REPO_OVERRIDE ? REPO_OVERRIDE.toLowerCase() : null);

/**
 * The branch feature work is cut from and compared against.
 *
 * Locked for the same reason as {@link REPO}: the review boundary must be a
 * property of the project's own configuration, not of the environment. The
 * first audit of a task reviews `BASE_BRANCH..HEAD`, so pointing this
 * elsewhere would silently change what Codex is shown.
 */
export const BASE_BRANCH =
  typeof PROJECT_CONFIG.baseBranch === 'string' && PROJECT_CONFIG.baseBranch.trim() !== ''
    ? PROJECT_CONFIG.baseBranch.trim()
    : 'main';

const BASE_BRANCH_OVERRIDE = process.env.AGENTLOOP_BASE_BRANCH;
if (
  BASE_BRANCH_OVERRIDE !== undefined &&
  BASE_BRANCH_OVERRIDE !== '' &&
  BASE_BRANCH_OVERRIDE !== BASE_BRANCH
) {
  throw new Error(
    `AGENTLOOP_BASE_BRANCH=${JSON.stringify(BASE_BRANCH_OVERRIDE)} is not permitted. ` +
      `This project's base branch is ${BASE_BRANCH} (set in agentloop.config.json, or the ` +
      'default "main"); an environment variable may only assert that value.',
  );
}

/**
 * Everything the controller writes while a task is in flight.
 *
 * One directory, gitignored, at the project root: state, logs, and the local
 * report. It is runtime detail, never repository state, and deleting it
 * costs at most the ability to resume the current Claude session.
 */
export const AGENT_DIR = path.join(REPO_ROOT, '.agent');
export const STATE_FILE = path.join(AGENT_DIR, 'state.json');
export const LOG_DIR = path.join(AGENT_DIR, 'logs');
export const REPORT_FILE = path.join(AGENT_DIR, 'report.md');

const DEFAULT_CHECKS = Object.freeze([
  Object.freeze({ name: 'typecheck', script: 'typecheck' }),
  Object.freeze({ name: 'lint', script: 'lint' }),
  Object.freeze({ name: 'test', script: 'test' }),
  Object.freeze({ name: 'build', script: 'build' }),
]);

/**
 * A conservative token shape for a check's `name`/`script`: no spaces,
 * quotes, commas, parentheses, or other characters a shell or a
 * comma-separated tool-pattern list could reinterpret.
 *
 * This is hygiene for the controller's own `npm run <script>` invocation
 * (`checks.mjs`, via `process.mjs`'s argv-array spawn — never a shell), not
 * what makes these values safe to hand to Claude. They never are: Claude's
 * allowed tools are never derived from this list at all, however it is
 * shaped. See the comment on {@link CLAUDE_DEFAULT_ALLOWED} below.
 */
const CHECK_TOKEN = /^[A-Za-z0-9][A-Za-z0-9:_-]*$/;

function normaliseChecks(value) {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(
      `${CONFIG_FILE}: "checks" must be a non-empty array of { "name": string, "script": string }.`,
    );
  }
  return Object.freeze(
    value.map((entry, index) => {
      if (!entry || typeof entry.name !== 'string' || typeof entry.script !== 'string') {
        throw new Error(
          `${CONFIG_FILE}: checks[${index}] must have string "name" and "script" fields.`,
        );
      }
      if (!CHECK_TOKEN.test(entry.name) || !CHECK_TOKEN.test(entry.script)) {
        throw new Error(
          `${CONFIG_FILE}: checks[${index}].name and .script must match ${CHECK_TOKEN} — no ` +
            'spaces, quotes, commas, or other punctuation.',
        );
      }
      return Object.freeze({ name: entry.name, script: entry.script });
    }),
  );
}

/**
 * Deterministic checks, run in this order before Codex is asked for an
 * opinion. Configurable per project via `checks` in `agentloop.config.json`;
 * the default is the common `npm run <script>` set. They run against the
 * committed local HEAD, so a Codex audit never spends a round on something
 * these would have caught.
 *
 * Run only by the controller, through `checks.mjs`. Claude is never granted
 * any command derived from this list — see {@link CLAUDE_DEFAULT_ALLOWED}.
 */
export const DETERMINISTIC_CHECKS = normaliseChecks(PROJECT_CONFIG.checks) ?? DEFAULT_CHECKS;

/**
 * How many Codex `REQUEST_CHANGES` rounds the loop will work through before
 * it stops and hands the task back with a local report.
 *
 * Two is the default. A third round almost always means the finding is a
 * disagreement about scope rather than a defect, and that is the owner's call.
 */
export const MAX_CHANGE_ROUNDS = Number(
  process.env.AGENTLOOP_MAX_CHANGE_ROUNDS ??
    (Number.isInteger(PROJECT_CONFIG.maxChangeRounds) ? PROJECT_CONFIG.maxChangeRounds : 2),
);

const CLAUDE_CONFIG = PROJECT_CONFIG.claude ?? {};

/**
 * Claude tool permissions for unattended runs.
 *
 * `acceptEdits` plus a scoped tool allowlist is the least-privilege default
 * that still lets Claude implement and commit. Verification is not among
 * Claude's tools — see {@link CLAUDE_DEFAULT_ALLOWED} — and nothing here can
 * reach the network: the local loop must not push, and must not talk to
 * GitHub at all. Publishing is the controller's job, and only after Codex
 * approves the exact local HEAD.
 */
export const CLAUDE_PERMISSION_MODE =
  process.env.AGENTLOOP_CLAUDE_PERMISSION_MODE ?? CLAUDE_CONFIG.permissionMode ?? 'acceptEdits';

/**
 * The exact local git operations Claude needs: inspecting the working tree
 * and history, staging files, and making the checkpoint commit.
 *
 * Deliberately not `Bash(git *)`. That wildcard does not just admit `git
 * push` — it also admits every option-prefixed form of it, such as
 * `git -C . push` or `git --git-dir=... push origin`, none of which start
 * with the literal string `git push` and so slip straight past a
 * `Bash(git push*)` entry in the disallow list below. A disallow pattern can
 * only ever enumerate prefixes it has thought of; an allowlist that
 * enumerates only the safe subcommands has no such gap, because anything not
 * listed here — whatever form it takes — is simply not an allowed command.
 */
const CLAUDE_GIT_SUBCOMMANDS = [
  'Bash(git status*)',
  'Bash(git diff*)',
  'Bash(git log*)',
  'Bash(git show*)',
  'Bash(git add*)',
  'Bash(git commit*)',
  'Bash(git rev-parse*)',
];

/**
 * Claude is never granted `npm run <script>`, `npm test`, or any other
 * node/npm/npx command — not even the ones {@link DETERMINISTIC_CHECKS}
 * itself runs.
 *
 * Two independent reasons, either one sufficient on its own:
 *
 *  1. Claude can edit `package.json` (it needs `Edit`/`Write` to implement at
 *     all), and an npm script name only resolves to a command *at run time*,
 *     by reading `package.json`. Granting `Bash(npm run test)` while also
 *     granting `Write` on `package.json` means Claude can redefine what
 *     "test" runs and then invoke exactly the command it was "restricted"
 *     to — including a script that shells out to `git push` or `gh`, which
 *     no `Bash(git push*)` or `Bash(gh *)` disallow entry can see, because
 *     the invocation is npm, not git or gh.
 *  2. Deriving the allowlist from the *configured* `checks[].script` values
 *     (`agentloop.config.json`) turns project configuration into a source of
 *     Claude's tool permissions. A `script` value is joined into a
 *     comma-separated `--allowedTools` list; a crafted value containing a
 *     comma can inject an unrelated `Bash(...)` pattern into that list
 *     regardless of how the individual token is validated.
 *
 * There is no fix that keeps some npm command granted here — the point of
 * both gaps is that *any* npm invocation Claude can run is a path to
 * something else once `package.json` (or the check config) is not fully
 * trusted input. Verification is the controller's job: it runs
 * {@link DETERMINISTIC_CHECKS} itself, through `checks.mjs`, independently of
 * whatever Claude did, after Claude hands off.
 */
const CLAUDE_DEFAULT_ALLOWED = ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'TodoWrite', ...CLAUDE_GIT_SUBCOMMANDS].join(
  ',',
);

/**
 * Patterns Claude may never run, whatever the allowlist says.
 *
 * Belt-and-braces on top of the allowlist above: the disallowlist takes
 * precedence over the allowlist inside Claude Code, so even if the allowlist
 * were ever widened back to something unbounded, a literal `git push` or `gh`
 * invocation is still refused here. It cannot be the *only* guard — as the
 * allowlist comment explains, an option-prefixed push does not match these
 * prefixes either — which is why the real boundary is what the allowlist
 * enumerates, not what this list excludes.
 */
export const CLAUDE_DISALLOWED_TOOLS = [
  'Bash(git push*)',
  'Bash(git push:*)',
  'Bash(gh *)',
  'Bash(gh:*)',
  'Bash(node *)',
  'Bash(node:*)',
  'Bash(npm *)',
  'Bash(npm:*)',
  'Bash(npx *)',
  'Bash(npx:*)',
  'WebFetch',
].join(',');

/** Every entry in an allowedTools value, exactly as written, trimmed. */
function splitToolList(value) {
  return value.split(',').map((entry) => entry.trim()).filter(Boolean);
}

/**
 * Recognises any `Bash(...)` entry that invokes `git`, in whatever form.
 *
 * Deliberately broad — it exists only to find entries the exact-match check
 * below must then approve or refuse, so over-matching costs nothing and
 * under-matching would let a disguised git invocation through unchecked.
 */
const GIT_BASH_ENTRY = /^bash\(\s*git\b/i;

const CLAUDE_GIT_ALLOWED_SET = new Set(CLAUDE_GIT_SUBCOMMANDS);

/**
 * Recognises any `Bash(...)` entry that invokes `node`, `npm`, or `npx`, in
 * whatever form. Unlike {@link GIT_BASH_ENTRY}, there is no safe subset to
 * compare against here — every such entry is refused outright. `npm run
 * <script>` only resolves to a real command by reading `package.json` at run
 * time, and Claude can edit `package.json`; there is no npm invocation that
 * stays safe once the thing that defines what it does is not trusted input.
 * Any of the three can also shell out to `git push` or `gh` through
 * `child_process`, which no `Bash(git push*)` or `Bash(gh *)` disallow entry
 * can see, because the invocation is Node, not git or gh.
 */
const NODE_BASH_ENTRY = /^bash\(\s*(?:node|npm|npx)\b/i;

/**
 * Any env-provided override must still refuse Claude the publishing tools.
 *
 * The previous version of this check rejected specific shapes it recognised
 * as dangerous — a literal `git push`, an unbounded `Bash(git *)`. That is a
 * denylist, and `Bash(git -C . push*)` shows why a denylist over git
 * invocations does not work: it grants push through an option that comes
 * before the subcommand, so it never contains the substring `git push` and
 * never matches a bare `git *` wildcard either, yet it still runs `git push`.
 * There is no bounded set of prefixes that denies every such form.
 *
 * So every override entry that invokes git through `Bash(...)` is now
 * compared against the fixed, safe subcommand list above instead, and must
 * match one of them exactly. Anything else — an option-prefixed push, `git
 * remote`, `git fetch`, or any git command not on that list — is refused,
 * whatever shape it takes, because the check is "is this exactly one of the
 * commands we enumerated" rather than "does this look like the specific
 * dangerous thing we thought of".
 *
 * `git push` and `gh` are also refused as plain substrings, matching the
 * treatment of `AGENTLOOP_REPO` and `AGENTLOOP_BASE_BRANCH`, in case either
 * is granted in a form that is not a clean `Bash(...)` entry.
 */
export function validateAllowedTools(value) {
  if (value === undefined || value === '') return CLAUDE_DEFAULT_ALLOWED;

  const normalised = value.toLowerCase().replace(/\s+/g, ' ');

  if (/git\s+push/.test(normalised) || /\bgh\b/.test(normalised)) {
    throw new Error(
      `AGENTLOOP_CLAUDE_ALLOWED_TOOLS=${JSON.stringify(value)} is not permitted. ` +
        'The allowlist may not grant `git push` or the `gh` CLI; the controller is the ' +
        'only actor that publishes, and only after Codex approves the local HEAD.',
    );
  }

  for (const entry of splitToolList(value)) {
    if (GIT_BASH_ENTRY.test(entry) && !CLAUDE_GIT_ALLOWED_SET.has(entry)) {
      throw new Error(
        `AGENTLOOP_CLAUDE_ALLOWED_TOOLS=${JSON.stringify(value)} is not permitted: ` +
          `${JSON.stringify(entry)} is not one of the fixed local git commands Claude may ` +
          `run (${CLAUDE_GIT_SUBCOMMANDS.join(', ')}). An option-prefixed push, a remote ` +
          'mutation, or any other git invocation is refused the same way — the entry has to ' +
          'match one of these exactly, not merely avoid looking like `git push`.',
      );
    }

    if (NODE_BASH_ENTRY.test(entry)) {
      throw new Error(
        `AGENTLOOP_CLAUDE_ALLOWED_TOOLS=${JSON.stringify(value)} is not permitted: ` +
          `${JSON.stringify(entry)} grants a node, npm, or npx command. Claude may not run any ` +
          'of these, verification commands included: `npm run <script>` only resolves to a real ' +
          'command by reading `package.json`, which Claude can edit, so no npm invocation stays ' +
          'restricted once the thing that defines what it does is not trusted input. Any of the ' +
          'three can also shell out to `git push` or `gh pr merge` through `child_process`, which ' +
          'no `Bash(git push*)` or `Bash(gh *)` disallow entry can see, because the invocation is ' +
          'Node, not git or gh. Verification runs only in the controller, through checks.mjs, ' +
          "after Claude's commit — never as a tool Claude itself can invoke.",
      );
    }
  }

  return value;
}

/**
 * Comma-separated, because the tool patterns themselves contain spaces.
 * Passed to `--allowedTools` as a single argument.
 */
export const CLAUDE_ALLOWED_TOOLS = validateAllowedTools(
  process.env.AGENTLOOP_CLAUDE_ALLOWED_TOOLS,
);

const DEFAULT_CLAUDE_TIMEOUT_MS = 6 * 60 * 1000;
const MAX_CLAUDE_TIMEOUT_MS = 15 * 60 * 1000;

function boundedPositiveInteger(value, fallback, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), maximum);
}

export const LIMITS = Object.freeze({
  /**
   * One Claude process gets a short wall-clock window. The ceiling is
   * deliberate: an environment override must not turn one controller run
   * into an unattended hours-long session.
   */
  claudeTimeoutMs: boundedPositiveInteger(
    process.env.AGENTLOOP_CLAUDE_TIMEOUT_MS,
    DEFAULT_CLAUDE_TIMEOUT_MS,
    MAX_CLAUDE_TIMEOUT_MS,
  ),
  claudeTimeoutMaxMs: MAX_CLAUDE_TIMEOUT_MS,
  /** A single Codex audit turn. */
  codexTimeoutMs: Number(process.env.AGENTLOOP_CODEX_TIMEOUT_MS ?? 30 * 60 * 1000),
  /** Short-lived helper commands (`gh`, `git`). */
  cliTimeoutMs: Number(process.env.AGENTLOOP_CLI_TIMEOUT_MS ?? 120 * 1000),
  /** One deterministic check (`npm run typecheck`, and so on). */
  checkTimeoutMs: Number(process.env.AGENTLOOP_CHECK_TIMEOUT_MS ?? 20 * 60 * 1000),
  /** Consecutive failures on the same step before the loop stops. */
  maxConsecutiveFailures: Number(process.env.AGENTLOOP_MAX_FAILURES ?? 3),
  /** Fallback pause when a usage limit gives no reset timestamp. */
  usageLimitFallbackMs: Number(process.env.AGENTLOOP_USAGE_PAUSE_MS ?? 15 * 60 * 1000),
  /** Steps one invocation will take before it stops and reports. */
  maxStepsPerRun: 12,
});
