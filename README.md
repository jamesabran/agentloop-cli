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

1. Selects the task from `--task`, `--next` (deterministic roadmap-driven
   selection), or the one saved in `.agent/`.
2. Resolves the task brief: `--brief <file>`, generated from the committed
   task file (for `--next`), the cached copy in `.agent/`, or — when the task
   id is an issue number — a single read of that issue.
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
  "tasksFile": "agentloop.tasks.json",
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
`npm run <script>` commands the **controller** runs, through `checks.mjs`,
before handing a commit to Codex; the default matches a typical
`typecheck`/`lint`/`test`/`build` project. If your project uses different
script names, or a different number of checks, list them here.

`tasksFile` is the path to the committed roadmap file, relative to the
repository root. It must be a relative path inside the repository — absolute
paths and traversal outside the repository are rejected. See
[Task roadmap](#task-roadmap-agentlooptasksjson) below.

Claude is never granted any of these commands, or any `npm`/`node`/`npx`
command at all — see [Verification runs only in the
controller](#verification-runs-only-in-the-controller) below.

## `AGENTS.md` is optional

If the project has an `AGENTS.md` at its root, Claude and Codex are both told
to read it first — it's the natural place for project-specific rules: roles,
commit conventions, scope boundaries, and documentation of what the
verification commands are (informational for Claude; the controller is what
actually runs them). AgentLoop does not require one; a project with no
`AGENTS.md` still works, just without that extra context.

## Task roadmap (`agentloop.tasks.json`)

A committed, structured file at the repository root that defines the project's
planned work. It is durable planning data, designed for version control.
`.agent/` remains disposable, gitignored runtime state — the task file is the
source of truth for what to work on next.

```json
{
  "version": 1,
  "tasks": [
    {
      "id": "setup",
      "title": "Project setup",
      "status": "completed",
      "dependsOn": [],
      "goal": "Set up the project structure and configuration.",
      "requirements": [
        "Initialise the repository with the standard tooling"
      ],
      "exclusions": [
        "CI/CD pipeline configuration"
      ]
    },
    {
      "id": "3c-1",
      "title": "First feature",
      "status": "next",
      "dependsOn": ["setup"],
      "goal": "Implement the first feature.",
      "requirements": [
        "Feature A implementation",
        "Tests for feature A"
      ],
      "exclusions": [
        "Documentation updates"
      ]
    },
    {
      "id": "3c-2",
      "title": "Second feature",
      "status": "planned",
      "dependsOn": ["setup"],
      "goal": "Implement the second feature.",
      "requirements": [
        "Feature B implementation"
      ],
      "exclusions": [
        "Performance tuning"
      ]
    }
  ]
}
```

### Task fields

| Field | Required | Description |
|---|---|---|
| `id` | yes | Unique task identifier (letters, digits, `.`, `_`, `/`, `-`) |
| `title` | yes | Human-readable task name |
| `status` | yes | One of: `planned`, `next`, `in_progress`, `completed`, `blocked` |
| `dependsOn` | yes | Array of task IDs that must be `completed` before this task is eligible |
| `goal` | yes | What this task should accomplish |
| `requirements` | yes | Array of required behaviours for the implementation |
| `exclusions` | yes | Array of behaviours explicitly outside this task's scope |

### Status meanings

| Status | Meaning |
|---|---|
| `planned` | Ready to be worked on once dependencies are met |
| `next` | The one task that should be selected next (at most one eligible at a time) |
| `in_progress` | Currently being worked on |
| `completed` | Done — dependencies on this task are now satisfied |
| `blocked` | Cannot proceed — skipped during selection |

### Deterministic task selection

When you run `--next`, the controller — not Claude and not Codex — chooses the
task:

1. Ignore `completed` tasks.
2. Ignore `blocked` tasks.
3. Every dependency must reference an existing task.
4. Every dependency must have status `completed`.
5. Determine all otherwise eligible tasks.
6. Prefer one eligible task marked `next`.
7. **Fail** when more than one eligible task is marked `next`.
8. When no eligible `next` exists, choose the first eligible `planned` task in
   file order.
9. Do not infer completion from ordering.
10. **Fail** clearly when no eligible task exists.

The selection is deterministic and independently testable. The task file is
**committed planning data** — the controller does not automatically modify
committed statuses in this phase.

### Active-task resume

When `--next` is run and valid resumable runtime state (`.agent/state.json`)
already identifies an active task:

- The active task is **resumed** through the existing recovery/resume rules.
- It is not silently replaced with a newly selected task.
- The task file is still validated before any mutations.
- The controller verifies the active task still exists in the committed task file.
- A clear message reports that the active task is being resumed.

### Generated runtime brief

When `--next` selects a task, the controller converts it into the implementation
brief consumed by Claude and Codex. The generated brief includes:

- Task ID, title, goal, requirements, and explicit exclusions
- Dependency IDs and statuses
- Configured verification commands
- Maximum correction rounds and other constraints

The generated brief may be cached under `.agent/` for resume, but it is
reproducible from the committed task file and configuration. The cached brief is
never the durable source of truth.

### Dry-run with `--next`

```powershell
agentloop --dry-run --next
```

Shows, without mutating anything:

- Resolved task-file path
- Selected task ID and title
- Why the task is eligible
- Dependency IDs and statuses
- Generated branch name
- Configured checks and maximum correction rounds
- That the brief will be generated from the committed task file
- Whether the command is selecting a new task or resuming an active task

Dry-run does not create branches, write files, create `.agent/`, modify runtime
state, or invoke any agent.

## Verification runs only in the controller

Claude implements and commits, but it cannot run the project's build, lint,
test, or any other npm command — `npm`, `node`, and `npx` are all outside its
allowed tools, unconditionally, regardless of what `checks` in
`agentloop.config.json` configures. This is deliberate, not a missing
feature:

- Claude can edit `package.json` (it needs to, to implement most changes),
  and an npm script name only resolves to a real command *at run time*, by
  reading `package.json`. Granting Claude `npm run test` while also letting
  it edit `package.json` would let it redefine what "test" runs and then
  invoke exactly the command it was "restricted" to.
- The configured `checks[].script` values come from project configuration,
  not from AgentLoop itself. Deriving Claude's allowed tools from them would
  make a project's own config file a source of Claude's permissions.

So verification is the controller's job, exclusively: it runs the configured
checks itself, through `checks.mjs`, against Claude's committed HEAD,
independently of anything Claude reports. Claude's `VERIFICATION: PASS` in
its handoff means it re-read its own diff and believes the change is
correct — not that it ran the verification commands, because it cannot. The
controller's own check run, immediately after handoff and before Codex, is
the actual gate.

## First run

Start with the two safe modes. Neither starts an agent.

```powershell
# Offline. Walks the whole loop and prints every transition.
npm run agent:self-check

# With a task file: see which task --next would select (changes nothing).
npm run agent:dry-run -- --next

# With an explicit task: reports the step it would take next, changes nothing.
npm run agent:dry-run -- --task 7 --brief docs/task-7.md
```

Then, when you are ready to let it act:

```powershell
# Roadmap-driven: select the next task deterministically.
npx agentloop --next

# Or with an explicit task ID and brief:
npx agentloop --task 7 --brief docs/task-7.md
# or, equivalently, if you added the npm script above:
npm run agent -- --task 7 --brief docs/task-7.md
```

The `npm run agent --` form works from Windows PowerShell too. On PowerShell,
`npm run <script> -- --flag value` can otherwise lose the flag *names* — a
native-argument-passing quirk that eats npm's own `--` separator whenever it is
immediately followed by another `--`-prefixed token, leaving npm to swallow
the option as its own unrecognized config instead of forwarding it. The
controller recovers every supported option — `--task`, `--brief`, `--branch`,
`--dry-run`, `--next`, `--recover`, `--self-check`, `--verbose`, and `--help` —
from the npm config values that mangling leaves behind (`recoverCliArgs` in
`src/lib/npm-args.mjs`), the same single function every entry point
(`agentloop`, direct `controller.mjs` invocation, and `agent:dry-run`) uses.
An option already present in argv is always left as-is; recovery only ever
fills in what npm actually swallowed.

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
agentloop --next [--dry-run]

  --task <id>       Task or issue identifier (required the first time)
  --next            Select the next task from agentloop.tasks.json deterministically
  --brief <file>    Task description to use instead of reading the issue
                    (valid only with an explicit --task, not with --next)
  --branch <name>   Local working branch (default: agent/task-<id>)
  --dry-run         Report the next local step, change nothing
  --recover         Explicitly clear a terminal Claude failure; starts a new session
  --self-check      Offline demonstration of the loop; no agents, no network
  --verbose         Include debug logging
  --help            Show this message
```

### With a task roadmap

If your project has an `agentloop.tasks.json`, `--next` selects the next task
deterministically:

```powershell
# See what would be selected, without changing anything:
npm run agent -- --dry-run --next

# Run the selected task:
npm run agent -- --next
```

The controller validates the entire task file before any branch or state
mutation — an invalid file is rejected before anything changes.

`--next` and `--task`/`--brief` are mutually exclusive. `--next` selects
deterministically; `--task <id>` works on a specific task. A custom brief is
only valid with an explicit `--task`.

## Starting a piece of work

**Roadmap-driven** (with `agentloop.tasks.json`):

1. Define your tasks in `agentloop.tasks.json` — scope, acceptance criteria,
   dependencies, and exclusions for each task.
2. Mark the next task to work on as `"status": "next"`.
3. Run `agentloop --next` and leave the machine awake.
4. When it stops, read `.agent/report.md`.
5. Update the committed task statuses by hand when a task is complete.
6. Run `agentloop --next` again for the next task.

**Explicit** (with `--task`):

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
  scripts/                repository-only tooling, never published
    typecheck.mjs          npm run typecheck: node --check every .mjs file
    build.mjs               npm run build: bin/import/metadata/pack validation
    lib/find-mjs-files.mjs  shared recursive .mjs file walker
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
      tasks.mjs              committed task-file loading, validation, and selection
      process.mjs            Windows-aware process launching
      logger.mjs             console and file logging
      npm-args.mjs           recovers every CLI option from npm's Windows arg loss

<your project>/
  agentloop.config.json   optional — base branch, checks, repo, agent settings
  agentloop.tasks.json     committed — task roadmap, the durable source of truth
  AGENTS.md                optional — project-specific rules for both agents
  .agent/                  gitignored — everything the controller writes
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
- **Claude cannot run `npm`, `node`, or `npx`, at all.** Not even the
  project's own configured verification commands. Claude can edit
  `package.json`, and an npm script name only resolves to a real command by
  reading it at run time — granting any `npm run <script>` would let Claude
  redefine what that script runs and then invoke exactly the command it was
  "restricted" to. This is unconditional too: an env var override, or a
  crafted `checks[].script` value in `agentloop.config.json`, cannot grant it
  back — Claude's allowed tools are never derived from the configured checks
  at all.
- **`AGENTLOOP_CLAUDE_ALLOWED_TOOLS` accepts a `Bash(...)` entry only on an
  exact match to the fixed safe command list — never by recognising a shape
  as safe or dangerous.** An override entry is not checked by asking whether
  it *looks like* `git`, `node`, `npm`, or `npx`; it is checked against a
  fixed list of exact strings, and anything not on that list is refused,
  whatever it is. This closes wrapper commands that reach the same
  destination without ever being the first word of the entry —
  `Bash(cmd /c npm test)`, a PowerShell or `pwsh` wrapper, `Bash(sh -c ...)`
  / `Bash(bash -c ...)`, `Bash(env npm test)`, npm/node/npx invoked by its
  full executable path, a nested shell, or even a bare `Bash` grant with no
  pattern at all — none of which a check keyed on recognising `git`/`node`/
  `npm`/`npx` as a prefix ever looks at. Non-Bash tools are held to the same
  standard: an override entry must exactly match one of Claude's explicitly
  supported tool names (`Read`, `Edit`, `Write`, `Glob`, `Grep`,
  `TodoWrite`), not merely avoid looking dangerous.
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
- **Deterministic checks run before Codex, and only in the controller.** The
  controller runs the configured checks itself, through `checks.mjs`, against
  Claude's committed HEAD — independently of anything Claude reports. A
  failing check stops the loop with the output; it never costs a review
  round.
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
dirty tree, failed verification, outstanding blockers), full CLI-option
recovery from npm's Windows PowerShell argument loss — every value and
boolean option, mixed/partial loss within one invocation, explicit-argv
precedence, strict boolean parsing, and ordinary direct/POSIX invocation left
unchanged — project/repository resolution from `agentloop.config.json` and
the git remote, and dry-run non-mutation. They also cover the
`AGENTLOOP_CLAUDE_ALLOWED_TOOLS` exact-match boundary directly: `cmd`,
PowerShell/`pwsh`, `sh -c`/`bash -c`, `env`, nested-shell, and
executable-path wrapper attempts around `npm`/`node`/`npx` are all refused,
alongside the git-push/gh/wildcard cases and the one valid safe entry and
default-configuration cases that must keep working.

Two more scripts validate the package itself rather than the workflow logic —
there is no compiler for this plain ESM JavaScript CLI, so neither is a
placeholder:

```powershell
npm run typecheck   # node --check on every .mjs file under src/, bin/, scripts/
npm run build       # bin target, runtime imports, package metadata, and a real npm pack --dry-run
```

`typecheck` fails on any file that does not parse. `build` additionally
confirms `package.json`'s `bin` target exists and has a shebang, that every
relative import in a runtime file resolves to a real file, that
`package.json` and `package-lock.json` agree on the version, and — by
actually running `npm pack --dry-run --json` and inspecting the result —
that every runtime file and the bin entry point would be published while no
test file would be.

## Known limits of this phase

- One task at a time. Switching `--task` discards the previous task's review
  position; its branch and commits are untouched, but it restarts the loop.
- The controller does not automatically modify committed task statuses. Mark a
  task as `completed` in `agentloop.tasks.json` by hand after it is published.
- The machine must be awake for agents to run. The branch and `.agent/` survive
  a restart; the controller resumes from them.
- Agents run under your OS user with your credentials, by design for this
  phase. Watch the first few runs.
- Configurable manual/auto pushing of committed statuses is not yet implemented.
- No Windows service, no self-hosted runner, and no MCP support. All deferred.
