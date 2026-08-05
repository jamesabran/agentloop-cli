// @vitest-environment node
/**
 * On Windows PowerShell, `npm run <script> -- --task 4 --branch <name>` can
 * lose the flag *names* entirely: PowerShell's native argument passing drops
 * a bare `--` when it is immediately followed by another `--`-prefixed
 * token, taking npm's own script/args separator with it. Without that
 * separator npm treats every option as its own unrecognized config flag
 * instead of forwarding it, and only `recoverCliArgs` puts it back —
 * previously only `--task`/`--branch`/`--recover` were covered; this now
 * covers every option `controller.mjs`'s `parseArgs` accepts.
 *
 * The loss can also be *partial*, within a single invocation: PowerShell
 * only eats the separator and the flag immediately following it, so later
 * flags on the same command line can survive untouched while an earlier one
 * is swallowed — `--task 4 --verbose` can arrive as `['4', '--verbose']`,
 * a mix of one orphaned bare value and one perfectly ordinary flag, not an
 * all-or-nothing loss. See "mixed PowerShell/npm forwarding" below for the
 * regression this covers: a naive "any real flag survived, so nothing was
 * lost" check misses this mix entirely and leaves the orphaned bare value
 * to reach `parseArgs` as `Unknown option: 4`.
 */
import { describe, expect, it } from 'vitest';

import { recoverCliArgs } from './npm-args.mjs';

describe('recoverCliArgs — task and branch recovery', () => {
  it('recovers task and branch when npm recorded them as boolean config and left bare values', () => {
    expect(
      recoverCliArgs(['4', 'feat/agent-automation-foundation'], {
        npm_config_task: 'true',
        npm_config_branch: 'true',
      }),
    ).toEqual(['--task', '4', '--branch', 'feat/agent-automation-foundation']);
  });

  it('recovers task and branch from the npm config values set by the `--flag=value` spelling', () => {
    expect(
      recoverCliArgs([], {
        npm_config_task: '4',
        npm_config_branch: 'feat/agent-automation-foundation',
      }),
    ).toEqual(['--task', '4', '--branch', 'feat/agent-automation-foundation']);
  });

  it('recovers only the flag that was actually lost', () => {
    // `--branch` survived (real flag present); only `--task` needs recovery.
    expect(
      recoverCliArgs(['--branch', 'feature/demo'], { npm_config_task: '4' }),
    ).toEqual(['--branch', 'feature/demo', '--task', '4']);
  });

  it('does not duplicate a flag already present in argv', () => {
    expect(recoverCliArgs(['--task', '4'], { npm_config_task: '9' })).toEqual(['--task', '4']);
  });
});

describe('recoverCliArgs — brief recovery', () => {
  it('recovers a lone --brief from its boolean config and bare value', () => {
    expect(recoverCliArgs(['docs/task-7.md'], { npm_config_brief: 'true' })).toEqual([
      '--brief',
      'docs/task-7.md',
    ]);
  });

  it('recovers --brief from the `--flag=value` spelling', () => {
    expect(recoverCliArgs([], { npm_config_brief: 'docs/task-7.md' })).toEqual([
      '--brief',
      'docs/task-7.md',
    ]);
  });

  it('recovers task, brief, and branch together, in the documented order', () => {
    // The documented invocation is `--task <id> --brief <file> --branch
    // <name>`; the surviving bare values are claimed in that same order,
    // since npm's fallout preserves relative position but not which flag a
    // value belonged to.
    expect(
      recoverCliArgs(['7', 'docs/task-7.md', 'agent/task-7-retry'], {
        npm_config_task: 'true',
        npm_config_brief: 'true',
        npm_config_branch: 'true',
      }),
    ).toEqual(['--task', '7', '--brief', 'docs/task-7.md', '--branch', 'agent/task-7-retry']);
  });

  it('does not duplicate an already-present --brief', () => {
    expect(
      recoverCliArgs(['--task', '7', '--brief', 'docs/task-7.md'], {
        npm_config_brief: 'true',
      }),
    ).toEqual(['--task', '7', '--brief', 'docs/task-7.md']);
  });
});

describe('recoverCliArgs — --recover recovery', () => {
  it('recovers task, branch, and the boolean --recover flag together', () => {
    expect(
      recoverCliArgs(['4', 'feat/agent-automation-foundation'], {
        npm_config_task: 'true',
        npm_config_branch: 'true',
        npm_config_recover: 'true',
      }),
    ).toEqual(['--task', '4', '--branch', 'feat/agent-automation-foundation', '--recover']);
  });

  it('does not add --recover when it was not passed', () => {
    expect(
      recoverCliArgs(['4', 'feat/agent-automation-foundation'], {
        npm_config_task: 'true',
        npm_config_branch: 'true',
      }),
    ).toEqual(['--task', '4', '--branch', 'feat/agent-automation-foundation']);
  });

  it('leaves an already-present --recover flag from direct node invocation untouched', () => {
    expect(
      recoverCliArgs(['--task', '4', '--branch', 'feature/demo', '--recover'], {}),
    ).toEqual(['--task', '4', '--branch', 'feature/demo', '--recover']);
  });

  it('recovers --recover regardless of where the surviving flags fall', () => {
    expect(
      recoverCliArgs(['--branch', 'feature/demo', '--recover'], { npm_config_task: '4' }),
    ).toEqual(['--branch', 'feature/demo', '--recover', '--task', '4']);
  });

  it('does not duplicate --recover already present in argv even if npm config also set it', () => {
    expect(
      recoverCliArgs(['--task', '4', '--recover'], { npm_config_recover: 'true' }),
    ).toEqual(['--task', '4', '--recover']);
  });

  it('does not infer --recover from a task id or branch name that happens to look like it', () => {
    expect(
      recoverCliArgs(['4', 'recover'], {
        npm_config_task: 'true',
        npm_config_branch: 'true',
      }),
    ).toEqual(['--task', '4', '--branch', 'recover']);
  });

  it('does not add --recover from an unrelated truthy npm config value', () => {
    expect(recoverCliArgs(['--dry-run'], { npm_config_recover: '1' })).toEqual(['--dry-run']);
    expect(recoverCliArgs([], {})).not.toContain('--recover');
  });
});

describe('recoverCliArgs — the other boolean options (--dry-run, --self-check, --verbose, --help)', () => {
  it('recovers --dry-run from its boolean config', () => {
    expect(recoverCliArgs([], { npm_config_dry_run: 'true' })).toEqual(['--dry-run']);
  });

  it('recovers --self-check from its boolean config', () => {
    expect(recoverCliArgs([], { npm_config_self_check: 'true' })).toEqual(['--self-check']);
  });

  it('recovers --verbose from its boolean config', () => {
    expect(recoverCliArgs([], { npm_config_verbose: 'true' })).toEqual(['--verbose']);
  });

  it('recovers --help from its boolean config', () => {
    expect(recoverCliArgs([], { npm_config_help: 'true' })).toEqual(['--help']);
  });

  it('recovers every boolean option together, alongside task and branch', () => {
    expect(
      recoverCliArgs(['4', 'feature/demo'], {
        npm_config_task: 'true',
        npm_config_branch: 'true',
        npm_config_dry_run: 'true',
        npm_config_self_check: 'true',
        npm_config_verbose: 'true',
      }),
    ).toEqual([
      '--task',
      '4',
      '--branch',
      'feature/demo',
      '--dry-run',
      '--self-check',
      '--verbose',
    ]);
  });
});

describe('recoverCliArgs — boolean environment values are parsed strictly', () => {
  // npm always represents "the flag was seen" as the exact string 'true'.
  // Anything else — a literal 'false', a falsy-looking '0', an empty
  // string, or some other truthy-looking value npm never actually
  // produces — must not enable the option.
  const boolean = [
    ['--dry-run', 'npm_config_dry_run'],
    ['--recover', 'npm_config_recover'],
    ['--self-check', 'npm_config_self_check'],
    ['--verbose', 'npm_config_verbose'],
    ['--help', 'npm_config_help'],
  ];

  for (const [flag, configKey] of boolean) {
    for (const notEnabled of ['false', '0', '', 'no', 'undefined', 'null']) {
      it(`does not enable ${flag} from ${configKey}=${JSON.stringify(notEnabled)}`, () => {
        expect(recoverCliArgs([], { [configKey]: notEnabled })).not.toContain(flag);
      });
    }

    it(`enables ${flag} only from ${configKey}='true'`, () => {
      expect(recoverCliArgs([], { [configKey]: 'true' })).toEqual([flag]);
    });
  }
});

describe('recoverCliArgs — explicit argv takes precedence over recovered env values', () => {
  it('leaves already-correct argv untouched', () => {
    expect(recoverCliArgs(['--task', '4', '--branch', 'feature/demo'], {})).toEqual([
      '--task',
      '4',
      '--branch',
      'feature/demo',
    ]);
  });

  it('does not reinterpret npm config fallout as a value-option value once a real flag survived', () => {
    // A real `--flag` anywhere in argv means the bare positional values are
    // no longer trustworthy as recovered task/brief/branch values — there
    // are none left to claim, since nothing was actually lost from argv
    // itself. `--task`/`--branch` here are noise (e.g. from `npm_config_*`
    // set for a different option this same invocation lost) and must not
    // consume or duplicate anything.
    expect(
      recoverCliArgs(['--verbose'], {
        npm_config_task: 'true',
        npm_config_branch: 'true',
      }),
    ).toEqual(['--verbose']);
  });

  it('still recovers a lost boolean option even when a different flag from the same invocation survived', () => {
    // PowerShell's quirk eats the bare `--` together with only the very
    // next `--`-prefixed token; a flag later in the same command line is no
    // longer immediately after a lone `--` and can survive intact. So one
    // invocation can lose one flag while keeping another as a real argv
    // token — a specific boolean option recovers whenever it is not already
    // present, independently of what else happened to survive.
    expect(recoverCliArgs(['--verbose'], { npm_config_recover: 'true' })).toEqual([
      '--verbose',
      '--recover',
    ]);
  });

  it('prefers the explicit value over a conflicting npm config value for the same option', () => {
    expect(recoverCliArgs(['--task', '4'], { npm_config_task: '9' })).toEqual(['--task', '4']);
  });

  it('does not re-add a boolean option already present in argv', () => {
    expect(recoverCliArgs(['--dry-run'], { npm_config_dry_run: 'true' })).toEqual(['--dry-run']);
  });
});

describe('recoverCliArgs — ordinary direct invocation is unchanged', () => {
  it('does nothing when neither a flag nor npm config is present', () => {
    expect(recoverCliArgs([], {})).toEqual([]);
    expect(recoverCliArgs(['--dry-run'], {})).toEqual(['--dry-run']);
  });

  it('passes every option straight through on a full, ordinary direct invocation', () => {
    // `npx agentloop ...` and a direct `node bin/agentloop.mjs ...` never go
    // through npm's config-flag fallout at all — argv is exactly what was
    // typed, and there is nothing to recover.
    const argv = [
      '--task',
      '7',
      '--brief',
      'docs/task-7.md',
      '--branch',
      'agent/task-7',
      '--dry-run',
      '--verbose',
    ];
    expect(recoverCliArgs(argv, {})).toEqual(argv);
  });

  it('passes a POSIX npm-script invocation through unchanged (separator survives on POSIX shells)', () => {
    // On bash/zsh, `npm run agent -- --task 4 --branch demo` forwards the
    // real flags in argv with no npm_config_* fallout at all — this is the
    // baseline behaviour the Windows PowerShell case is a fallback for.
    expect(recoverCliArgs(['--task', '4', '--branch', 'demo'], {})).toEqual([
      '--task',
      '4',
      '--branch',
      'demo',
    ]);
  });
});

describe('recoverCliArgs — mixed PowerShell/npm forwarding', () => {
  // Regression: PowerShell's quirk eats only the bare `--` and the single
  // flag immediately following it, so one invocation can lose one flag's
  // name while a later flag on the same command line survives intact. The
  // old implementation decided, once for the whole array, "did any real
  // `--flag` survive anywhere?" — and if so, treated every bare token as
  // already-correct argv, never eligible for recovery. That is wrong
  // whenever the survivor and the casualty are different flags in the same
  // command: the casualty's orphaned value is left sitting in argv, and
  // `parseArgs` rejects it as `Unknown option: <value>`.

  it('1. recovers a swallowed --task even though --verbose survived as a real flag', () => {
    // The reported case, verbatim: --task's name was swallowed (its bare
    // value '4' survives ahead of --verbose), while --verbose itself was
    // never touched.
    expect(recoverCliArgs(['4', '--verbose'], { npm_config_task: 'true' })).toEqual([
      '--task',
      '4',
      '--verbose',
    ]);
  });

  it('2. recovers a swallowed task plus multiple surviving direct flags', () => {
    expect(
      recoverCliArgs(['4', '--verbose', '--dry-run'], { npm_config_task: 'true' }),
    ).toEqual(['--task', '4', '--verbose', '--dry-run']);
  });

  it('2b. recovers a swallowed task with a surviving flag positioned before it', () => {
    // Order-agnostic: the orphan does not have to come first. --verbose
    // does not consume a following token as its own value (it takes none),
    // so a bare token right after it is still a legitimate orphan.
    expect(recoverCliArgs(['--verbose', '4'], { npm_config_task: 'true' })).toEqual([
      '--verbose',
      '--task',
      '4',
    ]);
  });

  it('3. recovers swallowed task and branch markers together with their remaining bare values', () => {
    expect(
      recoverCliArgs(['4', 'feature-x'], {
        npm_config_task: 'true',
        npm_config_branch: 'true',
      }),
    ).toEqual(['--task', '4', '--branch', 'feature-x']);
  });

  it('3b. recovers a swallowed branch alongside an explicit, already-correct --task', () => {
    // A mix in the other direction: --task survived explicitly (with its
    // value correctly attached), --branch's name was swallowed and its bare
    // value is the remaining orphan.
    expect(
      recoverCliArgs(['--task', '4', 'feature-x'], { npm_config_branch: 'true' }),
    ).toEqual(['--task', '4', '--branch', 'feature-x']);
  });

  it('4. an explicit --task still takes precedence over npm_config_task even with other flags around it', () => {
    expect(
      recoverCliArgs(['--task', '4', '--verbose'], { npm_config_task: '9' }),
    ).toEqual(['--task', '4', '--verbose']);
  });

  it('5. a bare positional with no matching npm_config_* marker is left invalid, not guessed at', () => {
    // No npm_config_task at all here — '4' has nothing to prove it is
    // --task's orphaned value, so it must not be reinterpreted. It passes
    // through unchanged and parseArgs is still expected to reject it.
    expect(recoverCliArgs(['4', '--verbose'], {})).toEqual(['4', '--verbose']);
  });

  it('5b. an unmarked bare value survives untouched even when a different option next to it is recovered', () => {
    // Only the option with a proving marker (--task) is recovered; the
    // second bare token ('bogus') has no marker of its own and is left
    // exactly where it was, still invalid.
    expect(recoverCliArgs(['4', 'bogus'], { npm_config_task: 'true' })).toEqual([
      '--task',
      '4',
      'bogus',
    ]);
  });

  it('6. recovers a swallowed task value alongside an explicit --recover flag', () => {
    expect(recoverCliArgs(['4', '--recover'], { npm_config_task: 'true' })).toEqual([
      '--task',
      '4',
      '--recover',
    ]);
  });

  it('6b. recovers a swallowed --recover alongside an explicit, already-correct --task', () => {
    expect(
      recoverCliArgs(['--task', '5'], { npm_config_recover: 'true' }),
    ).toEqual(['--task', '5', '--recover']);
  });

  it('7. a falsy-looking boolean config value leaves the option disabled even amid mixed forwarding', () => {
    for (const notEnabled of ['false', '0', '']) {
      const result = recoverCliArgs(['4', '--branch', 'demo'], {
        npm_config_task: 'true',
        npm_config_verbose: notEnabled,
      });
      expect(result, notEnabled).toEqual(['--task', '4', '--branch', 'demo']);
      expect(result, notEnabled).not.toContain('--verbose');
    }
  });
});
