# AgentLoop CLI

A small Node.js program that runs on your machine and carries one task through
an implement-and-review loop **locally**, then publishes the branch once it has
been approved.

Point it at a task, leave it: Claude implements and makes a local checkpoint
commit, your project's own deterministic checks run against that commit,
Codex audits it read-only, findings go back to Claude as another local
commit, and the re-audit sees only the new commits. Nothing is pushed until
Codex approves the commit that is still `HEAD`.

```text
implement ──► checks ──► audit ──► publish
    ▲                      │
    └──────── fix ◄────────┘   (at most twice)
```

Everything before that push happens in this working copy. Claude and Codex do
not talk to each other through GitHub: no labels, no comments, no draft pull
request, no polling. A task that never gets approved leaves no trace on GitHub
at all.

This is tuned for throughput. You are involved for product decisions and
genuine problems, not routine results. If your project has an `AGENTS.md`,
the agents are told to follow it; this file is how to run the loop itself.

## Install

AgentLoop is local-first and meant to be installed straight from GitHub as a
dev dependency of the project it will work on — it is not published to the
npm registry.

```sh
npm install --save-dev github:jamesabran/agentloop-cli
```

Then add scripts to that project's `package.json` (or call the `agentloop`
bin directly):

```json
{
  "scripts": {
    "agent": "agentloop",
    "agent:dry-run": "node node_modules/agentloop-cli/src/dry-run.mjs",
    "agent:self-check": "agentloop --self-check",
    "agent:verify-dry-run": "node node_modules/agentloop-cli/src/verify-dry-run.mjs"
  }
}
```

## What it does

1. Selects the task from `--task` (or the one saved in `.agent/`).
2. Resolves the task brief: `--brief <file>`, the cached copy in `.agent/`, or —
   when the task id is an issue number — a single read of that issue.
3. Checks out one local working branch for the task, creating it from the
   configured base branch.
4. Decides the next step from the saved state and the live local `HEAD`.
5. Runs Claude to implement or to fix, and records the commit it made.
6. Runs the project's configured verification commands against that commit.
7. Runs Codex read-only over `<base>..HEAD`, or `lastAuditedHead..HEAD` on a
   re-audit, together with the findings still unresolved.
8. On `APPROVED` for the commit that is still `HEAD`, pushes the branch.
9. Writes `.agent/report.md` whenever it stops.

It does not open, update, merge, or close a pull request. A published branch is
yours to do something with.

## Requirements

| Tool | Checked with | Notes |
|---|---|---|
| Node.js 20+ | `node --version` | |
| Git | `git --version` | |
| Claude Code | `claude --version` | |
| Codex CLI | `codex --version` | |
| GitHub CLI | `gh auth status` | Only needed to read an issue brief and to publish |

`claude` and `codex` are installed by npm as `.cmd` shims in `%APPDATA%\npm`.
The controller looks there as well as on `PATH`. If either lives somewhere
else, point at it explicitly:

```powershell
$env:AGENTLOOP_CLAUDE_BIN = "C:\path\to\claude.cmd"
$env:AGENTLOOP_CODEX_BIN  = "C:\path\to\codex.cmd"
```

All three CLIs must already be signed in. The controller never reads, stores,
or forwards a credential.

## Project configuration

AgentLoop makes no assumptions about the project it runs in. It resolves the
project root by walking up from the current directory to the nearest `.git`,
and resolves the repository boundary from that project's own `origin` git
remote. An optional `agentloop.config.json` at the project root lets you
override any of that:

```json
{
  "baseBranch": "main",
  "remote": "origin",
  "repo": null,
  "maxChangeRounds": 2,
  "checks": [
    { "name": "typecheck", "script": "typecheck" },
    { "name": "lint", "script": "lint" },
    { "name": "test", "script": "test" },
    { "name": "build", "script": "build" }
  ],
  "claude": {
    "permissionMode": "acceptEdits"
  }
}
```

Every field is optional and defaults to the value shown above (`repo:
null` means "resolve it from the git remote"). `checks` is the ordered list of
`npm run <script>` commands the controller runs — and the only ones it grants
Claude permission to run — before handing a commit to Codex; the default
matches a typical `typecheck`/`lint`/`test`/`build` project. If your project
uses different script names, or a different number of checks, list them here.

## `AGENTS.md` is optional

If the project has an `AGENTS.md` at its root, Claude and Codex are both told
to read it first — it's the natural place for project-specific rules: roles,
verification commands, commit conventions, scope boundaries. AgentLoop does
not require one; a project with no `AGENTS.md` still works, just without that
extra context.

## First run

Start with the two safe modes. Neither starts an agent.

```powershell
# Offline. Walks the whole loop and prints every transition.
npm run agent:self-check

# Reports the step it would take next, changes nothing.
npm run agent:dry-run -- --task 7 --brief docs/task-7.md
```

Then, when you are ready to let it act:

```powershell
npx agentloop --task 7 --brief docs/task-7.md
# or, equivalently, if you added the npm script above:
npm run agent -- --task 7 --brief docs/task-7.md
```

The `npm run agent --` form works from Windows PowerShell too. On PowerShell,
`npm run <script> -- --flag value` can otherwise lose the flag *names* — a
native-argument-passing quirk that eats npm's own `--` separator whenever it is
immediately followed by another `--`-prefixed token, leaving npm to swallow
`--task`/`--branch` as its own unrecognized config instead of forwarding them.
The controller recovers `--task` and `--branch` from the npm config values that
mangling leaves behind (`src/lib/npm-args.mjs`), the same way
`agent:dry-run` already did.

Each invocation starts at most one Claude process. After a valid Claude handoff,
the controller stops so the next invocation can run checks and the Codex audit;
this prevents a single controller process from silently retrying Claude. Every
resting point writes `.agent/report.md`. Run it again to continue; it picks the
task back up from `.agent/`, so later rounds need no flags:

```powershell
npx agentloop
```

All options:

```text
agentloop --task <id> [options]

  --task <id>       Task or issue identifier (required the first time)
  --brief <file>    Task description to use instead of reading the issue
  --branch <name>   Local working branch (default: agent/task-<id>)
  --dry-run         Report the next local step, change nothing
  --recover         Explicitly clear a terminal Claude failure; starts a new session
  --self-check      Offline demonstration of the loop; no agents, no network
  --verbose         Include debug logging
  --help            Show this message
```

## Starting a piece of work

1. Write the scope, acceptance criteria, and exclusions — as a GitHub issue, or
   as a local Markdown file.
2. Run the controller with `--task`, and leave the machine awake.
3. When it stops, read `.agent/report.md`.

An issue number as the task id makes the controller read that issue once for
the brief. It never labels, comments on, or closes it.

## When it stops

| It stops because | You do |
|---|---|
| Published | Open a pull request for the branch if you want one |
| Two change rounds used | Read the report and the audit; decide the scope question yourself |
| A deterministic check failed | Fix it, or run again — the report has the output |
| Claude times out, exits non-zero, reaches a process limit, or has an invalid status | Inspect the report and worktree; rerun with `--recover` only when ready to start a new Claude session |
| Codex reported `BLOCKED` | Resolve what it names, then run again |

Exit code 0 means it reached a resting point the loop planned for. Exit code 1
means something went wrong and the report is worth reading.

Claude timeouts, non-zero exits, usage/process-limit exhaustion, and invalid
handoffs are terminal for the current session. The controller writes its local
report, discards the session ID, and refuses another Claude process until a
human explicitly passes `--recover`. This prevents expensive automatic retries.

## Files

```text
agentloop-cli/
  bin/
    agentloop.mjs        the `agentloop` CLI entry point
  src/
    controller.mjs        entry point: decide → act → report
    self-check.mjs        offline demonstration of every transition
    verify-dry-run.mjs    proves a dry run changes no file
    dry-run.mjs           npm-args-safe --dry-run wrapper
    lib/
      config.mjs           project root/repo resolution, agentloop.config.json, limits
      local-loop.mjs        the decision engine (pure, no I/O)
      status-block.mjs      AGENTLOOP_AGENT_STATUS parser (pure, no I/O)
      state.mjs             versioned local task state, validated as untrusted input
      checks.mjs             runs the configured verification commands
      git.mjs                local git, and the one publishing push
      git-url.mjs            GitHub remote URL parsing
      github.mjs             gh: read an issue brief, confirm access before pushing
      claude-agent.mjs       non-interactive Claude runs and stream-json progress
      codex-agent.mjs        read-only Codex audits
      prompts.mjs            what each agent is told
      process.mjs            Windows-aware process launching
      logger.mjs             console and file logging
      npm-args.mjs           recovers --task/--branch from npm's Windows arg loss

<your project>/
  agentloop.config.json  optional — base branch, checks, repo, agent settings
  AGENTS.md               optional — project-specific rules for both agents
  .agent/                 gitignored — everything the controller writes
    state.json            task, branch, heads, round, verdict, blockers
    brief-<task>.md        the task description, cached on first resolution
    audit-<task>-round-N.md   each Codex report, verbatim
    report.md               the local report, rewritten whenever the loop stops
    logs/                    one log file per day
```

`.agent/` is gitignored and holds execution detail only. Deleting it is safe:
the branch and its commits are the work, and the controller rebuilds its
picture from them — you lose the review position and the ability to resume the
current Claude session, nothing else. It never contains credentials.

## Safeguards that are actually load-bearing

This is tuned for throughput, treating Claude and Codex as trusted
collaborators, not hostile processes. They run under your OS user with your
credentials. What the controller guards against is the loop doing the *wrong
thing* — publishing an unreviewed commit, auditing a tree that does not match
the commit, looping forever on a finding — not an agent trying to escape.

- **Publishing is gated on an exact commit match.** The controller pushes only
  on a Codex `APPROVED`, only when that commit is still `HEAD`, and it pushes
  that OID specifically. Anything committed behind the approval is re-audited,
  not published. This is the one guard between an approval and GitHub, so it is
  strict.
- **Claude cannot publish, at all.** `git push` and the whole `gh` CLI are in
  the unconditional disallow list for the implementation turn, and no env var
  can grant them back. "No partial work reaches GitHub" is a property of the
  loop, not a promise in a prompt.
- **Claude starts clean and Codex has an exact handoff.** Claude is never
  started over a dirty worktree. Codex starts only when `implementationHead`
  was recorded from a valid Claude handoff and exactly equals the current
  `HEAD`. A `READY_FOR_AUDIT` with no new commit is accepted as that handoff,
  and the existing `HEAD` recorded as the checkpoint, only when verification
  passed, there are no blockers, the reported `HEAD` matches exactly, the tree
  is clean, and the report came from this invocation's own Claude process —
  the same conditions a new-commit handoff must meet.
- **Claude cannot run away.** Each invocation starts at most one Claude
  process, has a six-minute default timeout capped at fifteen minutes, streams
  supported `stream-json` progress to the console, and kills its full Windows
  process tree on timeout.
- **Claude failures require an explicit recovery.** Timeout, non-zero exit,
  usage/process-limit exhaustion, or a missing/invalid status writes the local
  report, discards the session, and requires `--recover`; no retry is implicit.
- **Deterministic checks run before Codex.** A failing check stops the loop
  with the output; it never costs a review round.
- **Re-audits are incremental.** The second and later audits see
  `lastAuditedHead..HEAD` plus the unresolved findings, so Codex is not asked
  to re-read what it already accepted.
- **Two change rounds, then stop** (configurable — see `maxChangeRounds`
  above). A third round almost always means a scope disagreement rather than
  a defect, and that is yours to settle.
- **Codex stays read-only** (`--sandbox read-only`), which is role separation:
  the auditor must not quietly become the implementer.
- **The repository boundary cannot be redirected from the environment.**
  `REPO` and the base branch are resolved once, from `agentloop.config.json`
  or the project's own git remote; `AGENTLOOP_REPO` and
  `AGENTLOOP_BASE_BRANCH` may only assert whichever value was actually
  resolved, never point the loop at a different repository or branch.
  `AGENTLOOP_CLAUDE_ALLOWED_TOOLS` is refused the same way if it tries to
  grant `git push` or `gh`.
- **Stops on contradictory state.** A status naming a different task or commit,
  an ambiguous or truncated report, an uncommitted tree — each stops with a
  report rather than a guess.
- **Everything is on disk.** Each audit report is written to `.agent/`
  verbatim, so a run can be read back afterwards.

### What is deliberately not here

No container isolation, no separate OS user, no credential hardening, no
signing secrets, no approval gate beyond Codex, and no MCP support. Those cost
real complexity and, with agents and controller sharing one OS user, buy
little at this stage.

## Dry run mutates nothing

`npm run agent:dry-run -- --task <id>` reports the step it would take. It writes
nothing: no state file, no report, no `.agent/` directory, and **no log file** —
file logging is off for `--dry-run` and `--self-check`. Console output is the
only effect.

Verify it yourself:

```powershell
npm run agent:verify-dry-run
```

That snapshots every file in the project — including the gitignored
`.agent/` — plus `git status`, runs a real dry run as a child process with a
task and a brief so it exercises the full decision path, snapshots again, and
fails if anything at all changed. `npm test` runs the same comparison around
`--self-check`, which is offline.

## Environment variables

All optional.

| Variable | Default | Purpose |
|---|---|---|
| `AGENTLOOP_CLAUDE_BIN` | resolved | Path to `claude` |
| `AGENTLOOP_CODEX_BIN` | resolved | Path to `codex` |
| `AGENTLOOP_GH_BIN` | resolved | Path to `gh` |
| `AGENTLOOP_GIT_BIN` | resolved | Path to `git` |
| `AGENTLOOP_NPM_BIN` | resolved | Path to `npm`, used for the checks |
| `AGENTLOOP_CLAUDE_MODEL` | CLI default | Model for implementation |
| `AGENTLOOP_CODEX_MODEL` | CLI default | Model for audits |
| `AGENTLOOP_CLAUDE_PERMISSION_MODE` | `acceptEdits`, or `claude.permissionMode` in config | Claude permission mode |
| `AGENTLOOP_CLAUDE_ALLOWED_TOOLS` | see above | Claude tool allowlist |
| `AGENTLOOP_CLAUDE_TIMEOUT_MS` | `360000` (maximum `900000`) | One Claude process wall-clock timeout |
| `AGENTLOOP_CODEX_TIMEOUT_MS` | `1800000` | One audit turn |
| `AGENTLOOP_CHECK_TIMEOUT_MS` | `1200000` | One deterministic check |
| `AGENTLOOP_MAX_CHANGE_ROUNDS` | `2`, or `maxChangeRounds` in config | `REQUEST_CHANGES` rounds before stopping |
| `AGENTLOOP_MAX_FAILURES` | `3` | Failures on one step before stopping |
| `AGENTLOOP_REPO` | resolved | May only assert the resolved repository, not redirect it |
| `AGENTLOOP_BASE_BRANCH` | resolved | May only assert the resolved base branch, not redirect it |

## Tests

AgentLoop's own test suite:

```powershell
npm test
```

They cover status-block parsing and rejection, every loop transition including
the full implement-to-published path, the exact-head gate on publishing, the
change-round limit, incremental re-audit ranges, blocking-finding extraction,
check ordering and short-circuit, untrusted local state, usage-limit detection,
the read-only audit guard, the tool boundary that keeps Claude off GitHub, a
verified no-change Claude handoff and its rejection cases (HEAD mismatch,
dirty tree, failed verification, outstanding blockers), npm argument recovery
on Windows, project/repository resolution from `agentloop.config.json` and the
git remote, and dry-run non-mutation.

## Known limits of this phase

- One task at a time. Switching `--task` discards the previous task's review
  position; its branch and commits are untouched, but it restarts the loop.
- The machine must be awake for agents to run. The branch and `.agent/` survive
  a restart; the controller resumes from them.
- Agents run under your OS user with your credentials, by design for this
  phase. Watch the first few runs.
- No Windows service, no self-hosted runner, and no MCP support. All deferred.
