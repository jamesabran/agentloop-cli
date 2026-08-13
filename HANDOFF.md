# Handoff — Auto Mode risk-based permission policy

## Task

Make ALCLI's Auto Mode genuinely autonomous for routine development work by
fixing the **existing** runtime permission path so routine, safe,
project-scoped operations resolve to `allow` without reaching the
interactive permission relay, while genuinely uncertain operations still
reach the relay (`ask`) and dangerous operations are hard-blocked (`deny`)
before either the relay or execution. No `bypassPermissions`-equivalent
bypass; smallest patch on the existing path; no new config surface, DSL,
command parser, or provider refactor.

## What HEAD actually did (before this change)

Traced the real runtime path (not the unused `runHook` export — dead code,
never invoked, not tested):

1. **Hook side** — `writeHookSettings()` in `src/lib/permission-relay.mjs`
   generates a self-contained script (`HOOK_SCRIPT_TEMPLATE`) written to a
   temp dir and registered as Claude Code's `PreToolUse` hook via
   `--settings`. For every tool call it checked, in order: (a) hard-deny
   patterns (`git push`, `gh`, `node`/`npm`/`npx`, `chmod`/`chown`,
   `WebFetch`, `BypassPermissions`) → deny; (b) the static `--allowedTools`
   allowlist (`Read`, `Edit`, `Write`, `Glob`, `Grep`, `TodoWrite`, and seven
   fixed `git` read/stage/commit subcommands) → silent exit (Claude's own
   `--allowedTools` covers it); (c) **everything else** → nonce-protected
   file IPC to a temp dir, i.e. the relay.

2. **Controller side** — `runClaude()` in `src/lib/claude-agent.mjs` polls
   that temp dir. It re-checked hard-deny (defense-in-depth), and then:
   `if (relayAuto) { approve, no prompt }` — **every single request that
   reached this point, in `claude.relayMode: "auto"`, was approved with zero
   classification**, purely because it wasn't on the six-item hard-deny
   list. In `interactive` mode it prompted the terminal instead.

### The actual bug

`relayMode: "auto"` (ALCLI's documented "unattended operation" mode, and the
plausible reading of "Auto Mode" here — see `setup.mjs`'s
`claudeSettingsHandler` prompt and the CHANGELOG 0.3.0 entry) was, in
practice, an unrestricted-bypass-in-all-but-name for anything not on a
six-pattern hard-deny list: `rm -rf /`, arbitrary shell commands, anything —
all silently approved with no review, no classification, no logging beyond
"auto-approved". This is exactly the shape the task explicitly forbids
("Do not use Claude `bypassPermissions` or any equivalent unrestricted
mode"). Meanwhile ordinary interactive/manual runs *did* get prompted for
routine, obviously-safe operations (e.g. `rm tmp_file.txt`, `mkdir out`)
because nothing between the six-item allowlist and "everything else" existed
— matching the "Auto Mode still prompts too often" framing for
non-headless usage of the same code path.

Both symptoms trace to the same root cause: the runtime path had only two
buckets (hard-deny, and "everything else"), with no genuine `allow`/`ask`/
`deny` classification in between.

Verification that `runHook`/tests/lint/typecheck/build were **not** part of
this gap: `checks.mjs` runs `npm run <script>` entirely in the controller,
independently of Claude — "Claude has no Bash access to `npm run <script>`
at all" (existing comment in `config.mjs`, confirmed unchanged). So
tests/lint/typecheck/build never reach Claude's permission system in the
first place; no change was needed there.

## Fix

Added `classifyDeletion(toolName, toolInput, repoRoot)` to
`src/lib/permission-relay.mjs` — a pure function returning
`'allow' | 'ask' | 'deny' | null` (`null` = not a plain `rm`, fall through
unchanged). No shell parser, no command-chain inference: any
pipe/semicolon/backtick/`$`/redirect in the command string is treated as
ambiguous (`ask`), never inferred.

Classification rules (Bash `rm` only — the one operation the task spec
details with explicit scope/blast-radius criteria):

- **deny** — target is `/`, `~`, `$HOME`, a Windows drive root (`C:\`,
  `D:`), anything under `.git`, or resolves to the project root itself.
- **ask** — no target; a recursive flag (`-r`/`-R`/`-rf`/`--recursive`); a
  wildcard (`* ? [ ]`); a target outside the project root; shell
  metacharacters anywhere in the command.
- **allow** — one or more plain relative/in-project targets, no recursive
  flag, no wildcard, nothing dangerous.

This is applied at **two points**, mirroring the codebase's existing
"belt-and-braces" pattern (already used for hard-deny):

1. **Hook side** (`HOOK_SCRIPT_TEMPLATE`, plus the unused `runHook` kept in
   sync): inserted as step "2b", between the static-allowlist check and the
   relay file-write. `allow`/`deny` write an explicit `permissionDecision`
   and exit *before* any temp-file IPC — literally zero relay invocation for
   these, matching the task's `allow → execute` / `deny → block, never
   reaches relay` diagram. Only genuine `ask`-tier (or non-`rm` requests)
   reach the relay, unchanged. Implemented in vanilla ES5-ish JS using
   character-code constants (`String.fromCharCode`) instead of
   backslash/backtick-heavy regex literals, to avoid the multi-level
   escaping trap of embedding regex inside a JS template literal that is
   itself written to a `.mjs` file (verified by generating and
   `execFileSync`-running the actual output).

2. **Controller side** (`runClaude()`'s relay watcher in `claude-agent.mjs`):
   same classification, called after the existing hard-deny recheck. `deny`
   → denies with reason. `allow` → approves without a prompt (this branch is
   normally unreachable in practice since the hook already resolves it —
   pure defense-in-depth, same as the existing hard-deny recheck).
   **`ask`-tier is what changed the actual bug**: the old
   `if (relayAuto) { approve }` blind-approve branch was replaced with
   `if (relayAuto) { deny, reason: 'no user to prompt' }`; interactive mode
   still calls `promptUser()` unchanged. `promptUser()` already resolved to
   `null` (→ deny) when `!process.stdin.isTTY`, so this change makes `auto`
   mode's failure behavior for uncertain requests consistent with what
   non-interactive `interactive`-mode already did — no new mechanism, reused
   the existing fail-closed path.

`writeHookSettings()` / `_generateHookScript()` gained a `repoRoot` option
(threaded from `REPO_ROOT` in `claude-agent.mjs`), embedded into the
generated script as `var REPO_ROOT = <JSON>;` for the outside-project check.

### Files changed

- `src/lib/permission-relay.mjs` — `classifyDeletion` (module-level, real
  code) + its char-code-based twin inlined into `HOOK_SCRIPT_TEMPLATE`;
  `runHook` and `main()` in the template both gained step "2b"; `repoRoot`
  threaded through `writeHookSettings`/`_generateHookScript`; module doc
  comment updated.
- `src/lib/claude-agent.mjs` — watcher loop: deletion-scope recheck added;
  `relayAuto` blind-approve branch replaced with fail-closed deny for
  ask-tier; `repoRoot: REPO_ROOT` passed to `writeHookSettings`; doc comments
  updated.
- `src/lib/config.mjs` — `CLAUDE_RELAY_MODE` doc comment corrected (no
  longer describes blind auto-approval).
- `src/lib/setup.mjs` — the `--setup` wizard's relay-mode prompt label
  corrected to match actual behavior.
- `README.md` — "Interactive permission relay" bullet rewritten as
  "Risk-based permission relay", describing the allow/ask/deny flow.
- `CHANGELOG.md` — new `[Unreleased]` entry.
- `src/lib/permission-relay.test.mjs` — new `describe('classifyDeletion')`
  block (14 cases: non-Bash, non-`rm`, narrow-allow, no-target, recursive,
  wildcard, outside-project, chained/substituted, dangerous targets
  including cross-platform Windows drive roots and `.git` paths, project-root
  target, and `repoRoot: null` behavior); plus two new tests on
  `writeHookSettings` — one verifies `repoRoot` and `classifyDeletion` are
  embedded in the generated script *and* that the generated file is
  syntactically valid by actually executing it via `execFileSync` with empty
  stdin (real syntax check, sidesteps a pre-existing Windows stdin-piping
  flakiness noted below), the other checks the `repoRoot: null` default.

### Pre-existing issue found, not fixed (out of scope)

While testing the generated hook script as a real subprocess with piped
JSON stdin (`execFileSync`/`spawnSync` with an `input` payload), the process
hung until timeout on this Windows/Node 22 environment — reproduced
identically on unmodified `HEAD` via `git stash`, so it predates this
change and is unrelated to the classification logic. This is presumably why
the existing test suite's doc-comment promise of "10. generated hook
subprocess integration" was never actually implemented — the existing tests
only assert on the generated script's *text content*, never spawn it with
piped stdin. The new tests here follow that same precedent (content
assertions, plus one execution with **empty** stdin, which reaches EOF
immediately and doesn't hit the hang) rather than fighting the pre-existing
flakiness.

## Acceptance criteria — status

- Routine repo-local `rm` in Auto Mode: zero relay invocation (hook resolves
  `allow` before any file IPC). Reads/edits/writes/git-read-ops were already
  zero-relay via the pre-existing static allowlist — unchanged.
- ALCLI owns and applies allow/ask/deny on the actual runtime path (both
  hook and controller-watcher layers) — done.
- `ask` still reaches the existing relay mechanism unchanged (file IPC +
  `promptUser`) — done.
- `deny` reaches neither relay nor execution (hook short-circuits before the
  file-write step; controller watcher denies before `writeResponse`
  approves) — done.
- Narrow project-scoped `rm` → allow; broad/recursive/wildcarded/ambiguous
  → ask; `/`, `~`, drive roots, `.git`, project-root → deny — done, tested.
- Outside-project `rm` targets → ask (no repoRoot match) — done, tested.
  (Non-`rm` outside-project operations were already structurally impossible
  for Write/Edit — Claude Code itself restricts those tools to `--add-dir`
  — and any other tool/command outside the static allowlist already fell to
  `ask` before this change, unchanged.)
- Representative external mutation (e.g. `WebFetch`) → already hard-denied
  (stricter than `ask`, pre-existing, unchanged); anything not covered by
  hard-deny/allowlist/deletion-rules defaults to `ask`, and in auto mode now
  correctly denies rather than blind-approving — done.
- No script/command-chain parsing or inference added — confirmed: shell
  metacharacters are detected as opaque "this is ambiguous," never expanded
  or interpreted.
- Existing `interactive`/`auto` relay modes and hard-deny/allowlist config
  continue to work — all 829 existing tests pass unchanged, plus 41 new
  assertions.
- No `bypassPermissions`-equivalent bypass — the specific bug this task
  fixes.
- Windows/macOS/Linux path handling — `_isWindowsDriveRoot`/backslash
  normalization handled explicitly and tested; outside-project check uses
  `node:path` (`resolve`/`relative`/`isAbsolute`), which is
  platform-correct by construction.
- Regression coverage — 16 new tests in `permission-relay.test.mjs`
  (14 `classifyDeletion` cases + 2 `writeHookSettings` integration checks).
- Verification: `npm test` (829/829 pass), `npm run lint` (51/51), `npm run
  typecheck` (51/51), `npm run build` (package validation) — all pass.

## Not done (explicitly out of scope per task)

Planner architecture, new workflow stages, Setup/Home UI, provider
refactors, roadmap items. No new config surface was introduced — `claude
.relayMode` and hard-deny/allowlist config are unchanged in shape; only
their *behavior* at the ask-tier boundary changed to close the bypass.

## Auditor audit — 2026-08-13

**Revision audited:** `a968e9c0d0880f76f4a02b1d64a4e64d59325e78` (`fix: apply risk-based auto permission policy`)

### Outcome: APPROVED

The committed implementation satisfies the Auto Mode risk-based permission policy. `classifyDeletion` makes a narrow, deliberately bounded decision for plain Bash `rm` calls using only the existing tool input and repository root; it is embedded in the generated PreToolUse hook and mirrored in the existing controller watcher as defense in depth.

### Behavior and safety review

- Routine repo-local non-recursive, non-wildcard `rm` receives an explicit hook-side `allow` before request-file IPC, so it has zero interactive relay invocation. Existing static allowed tools retain their existing zero-relay route through Claude's `--allowedTools` grant.
- The canonical hook path resolves hard-deny and deletion `deny` before IPC; only `ask` (and non-`rm` requests that retain their existing default) writes into the nonce-protected relay. The controller repeats hard-deny and deletion checks only as a defense-in-depth response if a request somehow reaches it.
- The watcher preserves interactive prompting for ask-tier requests. In unattended `auto` mode it now sends a denial response for ask-tier work, rather than blindly approving it; this is fail-closed and is not a `bypassPermissions`-equivalent path.
- Classifier coverage and implementation agree on the required boundaries: project-local plain targets allow; recursive flags, wildcards, shell metacharacters/command chains, missing targets, and targets outside the repository ask; `/`, home targets, project-root targets, `.git`, and Windows drive roots deny. It uses Node `path.resolve`/`path.relative` for the platform path comparison, plus explicit Windows-root detection.
- Existing hard-deny and static allowlist structures are retained. External or otherwise unclassified mutations fall through to the established ask path (or an existing hard deny such as `WebFetch`); no approval override was broadened.

### Scope and implementation review

No policy DSL, generic rules engine, command-parser framework, provider abstraction, configuration surface, or unrelated permission-system refactor was introduced. The duplicated small classifier in the generated hook is necessary because the existing hook is a self-contained generated script; the controller-side recheck follows the pre-existing hard-deny defense-in-depth pattern. No new use of `bypassPermissions` was introduced.

### Evidence reviewed

- Commit diff for `permission-relay.mjs`, `claude-agent.mjs`, and their focused regression tests.
- `permission-relay.test.mjs` coverage for allow/ask/deny classification, cross-platform drive-root handling, project-root and outside-project behavior, `$HOME`, and generated hook syntax/embedding.
- Existing configuration and relay flow, including the fixed allowed-tools and hard-deny boundaries, interactive prompt behavior, and nonce-correlated IPC.

No additional project commands were run during this audit: the project rules reserve typecheck, lint, test, and build execution for the controller, and the committed handoff records those checks passing for this exact change.

AGENTLOOP_AGENT_STATUS
ROLE: AUDITOR
STATUS: APPROVED
TASK: auto-mode-risk-based-permission-policy
HEAD: a968e9c0d0880f76f4a02b1d64a4e64d59325e78
BLOCKERS: 0
NEXT: CONTROLLER
END_STATUS
