# AGENTS.md

Project-specific rules for automated agents working in this repository.

## Execution rules

- **Minimal change.** Prefer the smallest robust change that satisfies the task.
  Exclusions and scope are hard boundaries — do not work outside them.
- **Start narrow.** Inspect the most relevant files first. Broaden exploration
  only when a narrow search fails to locate what you need.
- **No parallel exploration for small tasks.** A single agent reading a few
  files is cheaper and faster than fan-out. Reserve parallel agents for tasks
  that genuinely span many subsystems.
- **Do not redesign unrelated systems.** If a system is not named in the task,
  do not refactor, review, or restructure it.
- **Reuse before adding.** Reuse existing abstractions, patterns, and execution
  paths before introducing new ones. New indirection must earn its keep.
- **Focused tests.** Add tests for the changed behaviour. Do not rewrite or
  extend unrelated test suites.
- **Verify before handoff.** The controller runs `typecheck` → `lint` →
  `test` → `build` against every commit. You cannot run these commands
  yourself — re-read your diff and confirm it is correct before handing off.
- **Token efficiency.** Optimize for correctness with the fewest files read and
  the least exploration. Large context burns time and money without improving
  results.

## Project context

This is the AgentLoop CLI itself — the controller, not a project being driven
by it. Tests live alongside source files as `*.test.mjs` and are run with
Vitest. The `scripts/` directory is repository-only tooling, never published.
`node --check` validates every `.mjs` file under `src/`, `bin/`, and
`scripts/`.
