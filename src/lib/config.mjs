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
import { defaultRoleMapping, LOGICAL_ROLES, resolveProvider } from './roles.mjs';

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

/**
 * Committed task-file path, relative to the repository root.
 *
 * The file is durable planning data, committed alongside the code. `.agent/`
 * remains disposable, gitignored runtime state.
 *
 * Default: `agentloop.tasks.json`. An `agentloop.config.json` may override it
 * with a `tasksFile` relative path; absolute paths and paths that traverse
 * outside the repository are rejected at resolution time (see
 * `resolveTaskFilePath` in lib/tasks.mjs).
 */
export const TASKS_FILE_RELATIVE =
  typeof PROJECT_CONFIG.tasksFile === 'string' && PROJECT_CONFIG.tasksFile.trim() !== ''
    ? PROJECT_CONFIG.tasksFile.trim()
    : 'agentloop.tasks.json';

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

/**
 * Publishing behaviour for approved commits.
 *
 * `"manual"` (the default) means the controller stops before pushing —
 * the owner inspects and pushes the approved branch themselves.
 * `"auto"` means the controller pushes the branch immediately after
 * Codex approves the commit that is still HEAD.
 *
 * Configurable via `publishMode` in `agentloop.config.json` or the
 * `AGENTLOOP_PUBLISH_MODE` environment variable. An unrecognised value
 * raises an error at startup rather than silently defaulting.
 *
 * @type {'manual' | 'auto'}
 */
export const PUBLISH_MODE = validatePublishMode(
  process.env.AGENTLOOP_PUBLISH_MODE ?? PROJECT_CONFIG.publishMode,
);

function validatePublishMode(value) {
  if (value === undefined || value === null) return 'manual';
  if (value === 'manual' || value === 'auto') return value;
  throw new Error(
    `Invalid publish mode ${JSON.stringify(value)}. Valid values are "manual" and "auto".`,
  );
}

const VALID_CLAUDE_PERMISSION_MODES = Object.freeze(['interactive', 'auto']);

function validateClaudePermissionMode(value) {
  if (value === undefined || value === null) return 'interactive';
  const normalized = String(value).trim();
  if (!VALID_CLAUDE_PERMISSION_MODES.includes(normalized)) {
    throw new Error(
      `Invalid Claude permission mode ${JSON.stringify(normalized)}. ` +
        `Valid values are: ${VALID_CLAUDE_PERMISSION_MODES.join(', ')}.`,
    );
  }
  return normalized;
}

/* ------------------------------------------------------------------ *
 * Role → provider mapping                                              *
 * ------------------------------------------------------------------ */

/**
 * Which provider each logical role delegates to.
 *
 * Defaults to the existing Claude-implementer / Codex-auditor workflow so
 * current users see no behavioural regression.  Configurable per project
 * via `roles` in `agentloop.config.json`:
 *
 *   {
 *     "roles": {
 *       "planner": "claude",
 *       "implementer": "claude",
 *       "auditor": "codex"
 *     }
 *   }
 *
 * Each role must map to a supported provider, and the provider must support
 * that role — an invalid combination raises an error at config load.
 */
function resolveRoleMapping(configValue) {
  const defaults = defaultRoleMapping();
  if (!configValue || typeof configValue !== 'object') return defaults;

  // Reject unknown role keys — a typo such as "audtor" must not silently
  // fall back to the default while the user believes it was accepted.
  const known = new Set(LOGICAL_ROLES);
  for (const key of Object.keys(configValue)) {
    if (!known.has(key)) {
      throw new Error(
        `${CONFIG_FILE}: unknown role key ${JSON.stringify(key)} in "roles". ` +
          `Valid roles are: ${LOGICAL_ROLES.join(', ')}.`,
      );
    }
  }

  const merged = { ...defaults };
  for (const role of LOGICAL_ROLES) {
    if (typeof configValue[role] === 'string' && configValue[role].trim() !== '') {
      merged[role] = configValue[role].trim();
    }
  }

  // Validate every mapping before returning — fail closed on any invalid entry.
  for (const [role, provider] of Object.entries(merged)) {
    resolveProvider(role, merged);
  }

  return Object.freeze(merged);
}

export const ROLE_MAPPING = resolveRoleMapping(PROJECT_CONFIG.roles);

/**
 * Provider-specific configuration from `agentloop.config.json`.
 *
 * Each provider key (e.g. `"claude"`, `"codex"`) holds settings that are
 * specific to that provider — permission mode, tool lists, model, etc.
 * Provider settings belong to the provider, never to a generic role, so
 * changing which provider fills a role does not silently move settings
 * between providers.
 *
 * The top-level `claude` key from older configs continues to work
 * unchanged; it is the same object this returns for `"claude"`.
 *
 * @param {string} provider — provider name (e.g. "claude", "codex")
 * @returns {Record<string, unknown>}
 */
export function getProviderConfig(provider) {
  const cfg = PROJECT_CONFIG[provider];
  if (cfg && typeof cfg === 'object' && !Array.isArray(cfg)) return cfg;
  return {};
}

const CLAUDE_CONFIG = getProviderConfig('claude');

/**
 * ALCLI Claude permission mode — controls whether tool permission requests
 * are relayed to the terminal user ("interactive") or auto-approved ("auto").
 *
 * Set via `claude.permissionMode` in agentloop.config.json or the
 * `AGENTLOOP_CLAUDE_PERMISSION_MODE` environment variable. An unrecognised
 * value raises an error at startup rather than silently defaulting.
 *
 * The value passed to the Claude CLI `--permission-mode` flag is derived from
 * this setting — see {@link CLAUDE_CLI_PERMISSION_MODE}.
 *
 * @type {'interactive' | 'auto'}
 */
export const CLAUDE_PERMISSION_MODE = validateClaudePermissionMode(
  process.env.AGENTLOOP_CLAUDE_PERMISSION_MODE ?? CLAUDE_CONFIG.permissionMode,
);

/**
 * The Claude CLI `--permission-mode` flag value, derived from the ALCLI mode.
 *
 * 'interactive' → 'acceptEdits'  (relay handles further permission decisions)
 * 'auto'         → 'bypassPermissions' (Claude auto-approves, no relay needed)
 *
 * @type {string}
 */
export const CLAUDE_CLI_PERMISSION_MODE =
  CLAUDE_PERMISSION_MODE === 'auto' ? 'bypassPermissions' : 'acceptEdits';

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

/**
 * Hard-deny patterns for the interactive permission relay.
 *
 * These are the same patterns that make up `CLAUDE_DISALLOWED_TOOLS`, as a
 * plain array so the relay can check each requested tool against them inline
 * without joining, splitting, or re-parsing.  A match here is an automatic
 * denial — the user is never offered an approval choice.
 *
 * Additional patterns beyond `CLAUDE_DISALLOWED_TOOLS` that must never be
 * grantable through the relay:
 *  - Any attempt to change the permission mode itself.
 *  - `Bash(chmod *)` / `Bash(chown *)` — filesystem permission mutations.
 *  - `BypassPermissions` — the tool that would skip subsequent permission checks.
 */
export const CLAUDE_HARD_DENY_PATTERNS = Object.freeze([
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
  'Bash(chmod *)',
  'Bash(chown *)',
  'BypassPermissions',
]);

/** Every entry in an allowedTools value, exactly as written, trimmed. */
function splitToolList(value) {
  return value.split(',').map((entry) => entry.trim()).filter(Boolean);
}

/**
 * Every `Bash(...)` entry an override may grant Claude, and nothing else:
 * exactly the fixed local git commands above.
 */
const CLAUDE_BASH_ALLOWED_SET = new Set(CLAUDE_GIT_SUBCOMMANDS);

/** Claude's non-Bash tools, exactly as granted by {@link CLAUDE_DEFAULT_ALLOWED}. */
const CLAUDE_NON_BASH_ALLOWED = ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'TodoWrite'];
const CLAUDE_NON_BASH_ALLOWED_SET = new Set(CLAUDE_NON_BASH_ALLOWED);

/**
 * Recognises any entry that is trying to grant the Bash tool at all — with
 * or without a `(...)` pattern, in any casing.
 *
 * Deliberately just "does this say Bash", not "does this look like a
 * dangerous Bash command". The previous version of this check tried to
 * recognise dangerous shapes — `Bash(git ...)`, `Bash(node|npm|npx ...)` —
 * and left every other `Bash(...)` entry to pass through unexamined. That is
 * exactly the gap a wrapper walks through: `Bash(cmd /c npm test)`,
 * `Bash(powershell -Command "npm test")`, `Bash(pwsh -c "npm test")`,
 * `Bash(sh -c "npm test")`, `Bash(bash -c "npm test")`, `Bash(env npm
 * test)`, an npm/node/npx invocation by full executable path, a nested
 * shell, or a bare `Bash` grant with no pattern at all — none of these start
 * with `git`, `node`, `npm`, or `npx`, so a check keyed on recognising those
 * prefixes never even looks at them. There is no bounded set of "dangerous
 * wrapper" prefixes to enumerate instead; there are only ever more of them.
 *
 * So this recognises every attempted Bash grant, unconditionally, and routes
 * it to the exact-match check below. An allowlist that enumerates only the
 * safe commands has no such gap, because anything not listed there —
 * whatever wrapper, casing, or shape it takes — is simply not accepted.
 */
const BASH_ENTRY = /^bash\b/i;

/**
 * Every override entry is checked against a fixed, exact allowlist: a
 * `Bash(...)` entry (in any casing or shape) must exactly match one of
 * {@link CLAUDE_BASH_ALLOWED_SET}, and every other entry must exactly match
 * one of {@link CLAUDE_NON_BASH_ALLOWED_SET}. Nothing is approved by
 * recognising it as safe-looking or refused by recognising it as
 * dangerous-looking — either it is one of the enumerated commands, exactly,
 * or it is refused, whatever shape it takes. This is what closes wrapper
 * bypasses a denylist cannot: a denylist can only ever enumerate the
 * dangerous shapes someone thought of, and a wrapper is precisely a shape
 * nobody thought of yet.
 */
export function validateAllowedTools(value) {
  if (value === undefined || value === '') return CLAUDE_DEFAULT_ALLOWED;

  for (const entry of splitToolList(value)) {
    if (BASH_ENTRY.test(entry)) {
      if (!CLAUDE_BASH_ALLOWED_SET.has(entry)) {
        throw new Error(
          `AGENTLOOP_CLAUDE_ALLOWED_TOOLS=${JSON.stringify(value)} is not permitted: ` +
            `${JSON.stringify(entry)} is not one of the fixed safe Bash commands Claude may run ` +
            `(${CLAUDE_GIT_SUBCOMMANDS.join(', ')}). Every Bash grant is checked against this ` +
            'exact list, not against whether it looks dangerous — a wrapper such as `Bash(cmd /c ' +
            'npm test)`, `Bash(powershell -Command "npm test")`, `Bash(pwsh -c ...)`, `Bash(sh -c ' +
            '...)`, `Bash(bash -c ...)`, `Bash(env npm test)`, an npm/node/npx invocation by full ' +
            'executable path, a nested shell, or a bare `Bash` grant reaches exactly the same ' +
            'commands a direct `Bash(git push*)` or `Bash(npm ...)` would, and none of them start ' +
            'with a prefix a denylist could have enumerated. The entry has to match one of the ' +
            'fixed commands exactly.',
        );
      }
      continue;
    }

    if (!CLAUDE_NON_BASH_ALLOWED_SET.has(entry)) {
      throw new Error(
        `AGENTLOOP_CLAUDE_ALLOWED_TOOLS=${JSON.stringify(value)} is not permitted: ` +
          `${JSON.stringify(entry)} is not one of Claude's supported non-Bash tools ` +
          `(${CLAUDE_NON_BASH_ALLOWED.join(', ')}).`,
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

const DEFAULT_CLAUDE_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_CLAUDE_TIMEOUT_MS = 120 * 60 * 1000;

function boundedPositiveInteger(value, fallback, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), maximum);
}

export const LIMITS = Object.freeze({
  /**
   * Wall-clock timeout for one Claude process.
   *
   * Defaults to 30 minutes — enough for a substantial implementation or fix
   * round without forcing the owner to split a coherent task purely to satisfy
   * an arbitrary timeout. Tasks should still be split based on logical scope
   * and auditability, not merely to fit the clock.
   *
   * Configurable via `AGENTLOOP_CLAUDE_TIMEOUT_MS` (milliseconds). The ceiling
   * exists so an environment override cannot turn one controller run into an
   * unattended hours-long session; raise it deliberately for larger coherent
   * tasks rather than reaching for it by default.
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
