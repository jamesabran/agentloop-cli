# Setup/Onboarding UX Redesign — Implementation Handoff

## Commits

1. `55a4d86` — feat: redesigned setup UX — discovery, manual planner, improved verification
2. `af4a915` — fix: address audit findings — Windows discovery and recommended runtime verification

## Summary

Redesigned the ALCLI `npx agentloop --setup` onboarding experience from a Claude + Codex-specific workflow to a community-facing orchestration tool where the user decides how each role is fulfilled.

### What changed

1. **Manual / External Planner** (`src/lib/roles.mjs`)
   - New `MANUAL_PLANNER = 'manual'` constant
   - `resolveProvider` short-circuits for manual planner — returns `{ provider: 'manual' }` without looking up `PROVIDER_CAPABILITIES`
   - `manual` is only valid for the planner role; other roles reject it with a clear error
   - `getProviderIdentity('manual')` returns `'MANUAL'` via existing fallback
   - Backward compatible — no existing configs have `planner: 'manual'`, and the new value validates correctly through the config module

2. **Capability discovery** (`src/lib/discovery.mjs` — new)
   - Registry-driven: `PROVIDER_DISCOVERY` maps each provider to `{command, versionFlag}`
   - `checkProvider(provider)` resolves the binary via `process.mjs` (respects `AGENTLOOP_*_BIN` overrides), runs `--version`, returns `{available, reason?, path?}`
   - `discoverAgents()` iterates all `PROVIDER_CAPABILITIES` keys
   - Cross-reference test ensures `PROVIDER_DISCOVERY` stays in sync with `PROVIDER_CAPABILITIES`

3. **Recommended settings fast path** (`src/lib/setup.mjs`)
   - First question: "Use recommended project settings? [Y/n]"
   - If accepted: auto-applies project/verification/controller defaults, skips those sections
   - Agent role selection is NOT included — must still be explicitly configured
   - Repository detection shows actual repo name: "Repository detected: owner/repo"
   - If declined: walks through each section individually with improved prompts

4. **Explicit role assignment**
   - Agent discovery runs first, showing `✓ Claude` / `✗ Gemini — not installed/configured`
   - Manual / External Planner always appears as planner option
   - Numbered choices generated from available + supported agents
   - Single-provider roles ask explicit confirmation — no silent assignment
   - No "(only provider that supports this role)" text unless genuinely capability-driven

5. **Improved verification wording**
   - "Automatic Project Checks" preamble explaining typecheck/lint/test/build in plain language
   - "Runtime Checks" section: "ALCLI can run the project and verify that it actually works, not just that the code passes automated checks"
   - Runtime profile default changed from `lightweight` to `standard` (recommended)
   - Technical details follow plain-language explanations

6. **Runtime check entry UX fixes**
   - Replaced "empty name to finish" sentinel with explicit "Add another runtime check? [y/N]" loop
   - Missing name/command validated immediately with specific errors
   - Shows `✓ Added: name → command` on successful entry
   - Tracks valid check count
   - Rejects duplicate names and duplicate commands
   - Example shown before entry loop

7. **Provider-specific settings registry**
   - `PROVIDER_SETTINGS` maps providers to their settings handlers
   - `PROVIDER_DEFAULTS` maps providers to their default values
   - Only selected providers receive settings sections
   - `assembleConfig` uses `normaliseProviderSettings()` for dynamic non-default detection
   - `formatSummary` iterates used providers dynamically — no hardcoded Claude-only display

### Architecture

The provider/discovery architecture is registry-driven:
- `PROVIDER_CAPABILITIES` (roles.mjs) — which roles each provider can fill
- `PROVIDER_DISCOVERY` (discovery.mjs) — how to check if each provider is available
- `PROVIDER_SETTINGS` (setup.mjs) — which providers have configurable settings
- `PROVIDER_DEFAULTS` (setup.mjs) — provider default values for minimal config writing
- `MANUAL_PLANNER` (roles.mjs) — sentinel for non-agent planner

Adding a new provider means adding entries to these registries — no conditionals to hunt down.

### Files changed

| File | Δ |
|------|---|
| `src/lib/roles.mjs` | +20 |
| `src/lib/roles.test.mjs` | +72 |
| `src/lib/discovery.mjs` | +115 (new) |
| `src/lib/discovery.test.mjs` | +130 (new) |
| `src/lib/setup.mjs` | +586/-271 |
| `src/lib/setup.test.mjs` | +662/-271 |

### Verification

- Full test suite: **776 tests pass** (20 test files, zero failures)
- No regressions in existing config loading, role resolution, or setup/config parsing
- Backward compatibility: existing configs without `roles.planner` continue to default to `claude`
- New configs with `{ roles: { planner: 'manual' } }` validate correctly through the config module

### Not included (by design)

- No changes to controller execution behavior (planner is not launched by controller currently)
- No changes to `agent-router.mjs` (runner dispatch remains provider-specific)
- No changes to `config.mjs` (already correctly validates through `resolveProvider`)
- No universal plugin/provider framework — the registries are small, frozen, and purpose-fit

### Audit fixes (af4a915)

Two blocking issues found and fixed:

1. **Windows discovery** — `spawnSync` does not handle `.cmd` shims on Windows.
   Added `spawnForDiscovery()` helper that routes `.cmd`/`.bat` files through
   `cmd.exe /d /s /c`, matching the existing pattern in `process.mjs`.

2. **Recommended fast path runtime verification** — `verification = {}` silently
   disabled runtime verification. Now sets `runtimeVerification: { profile: 'standard' }`
   which matches the recommended default. The verification gate will fail until
   the user adds checks via `--setup`, which is the correct prompt to configure.

AGENTLOOP_AGENT_STATUS
ROLE: CLAUDE
STATUS: COMPLETE
TASK: setup-onboarding-ux
HEAD: af4a91593ab9f51c8ec3451b34440a5181cc062c
BLOCKERS: 0
NEXT: CODEX_AUDIT
END_STATUS
