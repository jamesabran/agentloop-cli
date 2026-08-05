# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/) —
though it is pre-1.0, so minor versions may still include breaking changes.

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
