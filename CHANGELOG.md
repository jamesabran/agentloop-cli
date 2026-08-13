# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/) —
though it is pre-1.0, so minor versions may still include breaking changes.

## [Unreleased]

### Changed

- **Risk-based permission classification replaces auto-relay blanket
  approval.** The PreToolUse hook and the controller's relay watcher now
  resolve every request to `allow` / `ask` / `deny` before it can execute,
  instead of the previous binary hard-deny-or-relay check. A Bash `rm` is
  classified by blast radius (`classifyDeletion` in `permission-relay.mjs`):
  a narrow, project-scoped removal is approved without reaching the relay at
  all; a target such as `/`, `~`, a Windows drive root, or `.git` is denied
  before any file IPC; anything recursive, wildcarded, chained, or outside
  the project falls through to the existing relay as a genuine ask-tier
  request. `claude.relayMode: "auto"` no longer auto-approves every
  non-hard-denied request — with no user available to prompt, an ask-tier
  request is now denied rather than approved without review, closing what
  was effectively an unrestricted bypass for unattended runs. Hard-deny
  rules, the static allowlist, and `interactive` relay mode are unchanged.

## [0.3.0] - 2026-08-11

### Added

- **Configurable agent roles via provider abstraction.** The three logical
  roles — Planner, Implementer, Auditor — are now independently mapped to
  supported providers (`claude`, `codex`) via `roles` in
  `agentloop.config.json`. Provider-specific settings (Claude permission mode,
  relay mode) stay attached to the provider, never to the role — changing which
  provider fills a role does not silently move settings between providers.
  Unknown role keys and unsupported role-provider combinations are rejected at
  config load.
- **Interactive first-run setup (`agentloop --setup`).** A guided terminal
  flow configures project identification, agent roles, deterministic checks,
  runtime verification profiles, controller defaults, and provider-specific
  settings. Existing config values become defaults during reconfiguration.
  Validation runs through the real config module before saving; a validated
  config is never left in an invalid state. Crash-safe atomic write with
  backup rotation protects existing configuration.
- **Automated Runtime & Integration Verification Gate.** Configurable
  per-project and per-task runtime verification with four profiles —
  Lightweight (not required), Standard (basic smoke/integration),
  Integration (full suite), Custom (project-defined commands). The controller
  runs configured checks at both the implementer-handoff gate and the auditor
  gate; task-level configuration may inherit, disable, or escalate the project
  baseline. A required profile with no checks configured is a hard failure,
  never a silent bypass.
- **Claude permission relay with configurable mode.** Tool permission requests
  outside the static allowlist are relayed to the terminal user
  (`interactive` mode, the default) or auto-approved after hard-deny checks
  (`auto` mode, for unattended operation). Hard-deny rules (git push, gh, npm,
  node, npx, chmod, chown, WebFetch, BypassPermissions) are always enforced
  regardless of mode. Configured via `claude.relayMode` in
  `agentloop.config.json` or `AGENTLOOP_CLAUDE_RELAY_MODE`.
- **Provider-specific Claude permission mode.** `claude.permissionMode` in
  `agentloop.config.json` controls the Claude CLI `--permission-mode` flag
  independently of the ALCLI relay mode.
- **Dual-gate runtime verification.** The controller runs runtime checks at
  both the implementer handoff (rejecting the handoff on failure) and the
  auditor gate (blocking the audit on failure). Both gates must pass for the
  exact commit being published. Profile ordering enforces that tasks may only
  maintain or escalate the project baseline, never weaken it.

### Changed

- **Role-aware status blocks and prompts.** Status-block validation, fix
  prompts, and implementation prompts use the resolved provider identity
  rather than assuming Claude/Codex.
- **Profile-ordered runtime verification.** Standard < Integration < Custom
  ordering; tasks may only escalate, never weaken, the project baseline.
- **Implementer-gate runtime verification runs before the handoff is
  accepted.** A FAIL rejects the handoff and discards the implementer session.

### Fixed

- Implementer-gate runtime verification state is no longer erased by a
  subsequent auditor-gate run.
- Runtime verification state is recorded explicitly as `NOT_REQUIRED` when the
  gate does not apply, so the publish step can distinguish "not run" from
  "not required."
- Unknown role keys in `agentloop.config.json` (e.g. `"audtor"`) are rejected
  with a clear diagnostic rather than silently ignored.

## [0.2.1] - 2026-08-09

### Changed

- **Claude execution timeout default raised from 6 minutes to 30 minutes.**
  The safety ceiling is raised from 15 minutes to 2 hours, configurable via
  `AGENTLOOP_CLAUDE_TIMEOUT_MS` (milliseconds). In interactive terminal runs,
  when the timeout is reached the controller prompts whether to continue with
  a fresh timeout window rather than immediately failing the task — the same
  session is resumed so no work is lost. Non-interactive/CI runs stop
  deterministically as before. Tasks should still be split based on logical
  scope and auditability, not merely to fit the clock; raise the timeout
  deliberately for larger coherent tasks rather than reaching for it by
  default. The separate Codex, CLI, and check timeouts are unchanged.

## [0.2.0] - 2026-08-07

### Added

- **Roadmap-driven task execution (`--next`).** A committed
  `agentloop.tasks.json` file defines the project's planned work with task
  IDs, titles, goals, requirements, exclusions, dependencies, and statuses.
  `--next` selects the next eligible task deterministically — the
  controller owns the decision; Claude and Codex never choose which task
  comes next. Full validation of the task file runs before any branch or
  state mutation; an invalid file is rejected first.
- **Configurable publish mode (`--push-mode`).** `--push-mode manual|auto`
  controls whether the controller pushes an approved branch immediately
  (`auto`) or stops after approval with the exact `git push` command
  printed for you to run (`manual`, the default). The flag overrides
  `AGENTLOOP_PUBLISH_MODE` and `publishMode` in `agentloop.config.json`.
  All existing publication safety gates run identically in both modes.
- **Lint script.** A deterministic check for leftover `debugger` statements
  and unparseable source files — things `node --check` can't see. Uses an
  acorn-based AST walker so comments, strings, template literals, regexes,
  and property names are never false positives.
- **`AGENTS.md`** with concise, token-efficient execution rules for
  automated agents working in this repository.

### Changed

- **Publication is now manual by default.** On Codex approval the
  controller validates the remote, records readiness, and prints the exact
  `git push <remote> <sha>:refs/heads/<branch>` command. Nothing is pushed
  until you run it. Set `--push-mode auto` or `publishMode: "auto"` in
  config to restore the previous automatic-push behaviour.
- **Exact-SHA publishing.** The controller pushes the exact approved commit
  SHA (`<sha>:refs/heads/<branch>`), not the branch tip, so nothing
  committed after the approval can reach GitHub.
- **Repository-boundary assertion before publish.** Manual and auto modes
  both verify the live remote matches the pinned repository before acting.

### Fixed

- Stale `readyToPublishHead` is cleared on new commits, recovery, and
  successful auto-publish, so a prior approval can never apply to a
  different commit.
- Blocked tasks in `agentloop.tasks.json` are never selected by `--next`
  and saved active state for a blocked task is rejected with a clear
  diagnostic.
- Legacy cache migration for task briefs is atomic (exclusive-create) and
  case-sensitive on Windows.

## [0.1.1] - 2026-08-05

### Fixed

- **npm-script argument recovery on Windows PowerShell now covers every
  AgentLoop CLI option**, not only `--task`/`--branch`/`--recover`. On
  PowerShell, `npm run <script> -- --flag value` can lose a flag's name
  entirely — a native-argument-passing quirk that eats npm's own `--`
  separator whenever it is immediately followed by another `--`-prefixed
  token, leaving npm to expose the option through an `npm_config_*`
  environment variable instead of forwarding it in `process.argv`.
  Previously only `--task`, `--branch`, and `--recover` were reconstructed
  from that fallout; `--brief`, `--dry-run`, `--self-check`, `--verbose`, and
  `--help` were silently dropped. All of them are now recovered.
- Boolean options are recovered only from an *exact* `npm_config_<option> ===
  'true'`; a `'false'`, `'0'`, empty, or otherwise falsy-looking config value
  can no longer enable one by accident.
- **Partial (mixed) argument loss within a single invocation is now handled
  correctly.** PowerShell's quirk only eats the separator and the one flag
  immediately following it, so a command like `--task 4 --verbose` can
  arrive as `['4', '--verbose']` — one orphaned bare value alongside one
  perfectly ordinary surviving flag, not an all-or-nothing loss. The
  previous fix still decided, once for the whole argv array, "did *any*
  real flag survive?" and disabled all recovery if so, leaving the
  orphaned value to reach `parseArgs` as `Unknown option: 4`. Recovery is
  now decided per swallowed option, proven by its own `npm_config_*=true`
  marker, and only ever claims a bare token that is not already the
  attached value of a literal flag elsewhere in the same command — an
  unmarked bare token is left exactly as it was, still invalid, rather
  than guessed at.

### Changed

- CLI argument normalization is centralized in one function,
  `recoverCliArgs` (`src/lib/npm-args.mjs`, renamed from
  `recoverTaskAndBranch`), used identically by every entry point: the
  `agentloop` bin, direct `controller.mjs` invocation, and
  `npm run agent:dry-run`. Explicit argv always takes precedence — an option
  already present is never re-added, overwritten, or duplicated.
- The published npm package no longer includes test files (`**/*.test.mjs`);
  it ships `bin/`, `src/` (runtime files only), and `README.md`/`CHANGELOG.md`.
- Added `npm run typecheck` and `npm run build`: plain-Node, cross-platform
  scripts (`scripts/typecheck.mjs`, `scripts/build.mjs`) appropriate for a
  source-distributed JavaScript CLI with no compiler. `typecheck` parses
  every `.mjs` file with `node --check`; `build` additionally verifies the
  `bin` target and every relative runtime import resolve to real files,
  checks `package.json`/`package-lock.json` version consistency, and
  cross-checks the result against a real `npm pack --dry-run` — no
  TypeScript or fake compiled-output pipeline involved, and no step merely
  prints success.

## [0.1.0] - 2026-08-05

### Added

- Initial standalone AgentLoop CLI package: the local implement-and-review
  loop (Claude implements and commits locally, the controller runs the
  project's configured checks, Codex audits read-only, and only an approved
  commit is ever published), installable as a GitHub dev dependency.
- Project configuration via an optional `agentloop.config.json` (base
  branch, verification checks, repository boundary, agent settings); the
  repository boundary and base branch are resolved from the project itself
  (its git remote, or the config file) rather than hardcoded, and
  `AGENTLOOP_*` environment variables may only assert the resolved value,
  never redirect it.
- Claude's tool permissions are least-privilege by construction: verification
  commands run only in the controller (`checks.mjs`), never as a tool Claude
  itself can invoke, and an `AGENTLOOP_CLAUDE_ALLOWED_TOOLS` override is
  accepted only on an exact match to a fixed safe command list — never by
  recognising a shape as safe or dangerous — closing wrapper-command bypasses
  (`cmd /c`, PowerShell/`pwsh`, `sh -c`/`bash -c`, `env`, executable-path
  variants) as well as direct `npm`/`node`/`npx`/`git push`/`gh` grants.
