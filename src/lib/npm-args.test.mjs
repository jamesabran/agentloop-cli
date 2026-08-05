// @vitest-environment node
/**
 * On Windows PowerShell, `npm run <script> -- --task 4 --branch <name>` can
 * lose the `--task`/`--branch` flag names entirely: PowerShell's native
 * argument passing drops a bare `--` when it is immediately followed by
 * another `--`-prefixed token, taking npm's own script/args separator with
 * it. Without that separator npm treats `--task`/`--branch` as its own
 * unrecognized config flags instead of forwarding them.
 */
import { describe, expect, it } from 'vitest';

import { recoverTaskAndBranch } from './npm-args.mjs';

describe('recoverTaskAndBranch', () => {
  it('recovers task and branch when npm recorded them as boolean config and left bare values', () => {
    expect(
      recoverTaskAndBranch(['4', 'feat/agent-automation-foundation'], {
        npm_config_task: 'true',
        npm_config_branch: 'true',
      }),
    ).toEqual(['--task', '4', '--branch', 'feat/agent-automation-foundation']);
  });

  it('recovers task and branch from the npm config values set by the `--flag=value` spelling', () => {
    expect(
      recoverTaskAndBranch([], {
        npm_config_task: '4',
        npm_config_branch: 'feat/agent-automation-foundation',
      }),
    ).toEqual(['--task', '4', '--branch', 'feat/agent-automation-foundation']);
  });

  it('leaves already-correct argv untouched', () => {
    expect(
      recoverTaskAndBranch(['--task', '4', '--branch', 'feature/demo'], {}),
    ).toEqual(['--task', '4', '--branch', 'feature/demo']);
  });

  it('does nothing when neither flag nor npm config is present', () => {
    expect(recoverTaskAndBranch([], {})).toEqual([]);
    expect(recoverTaskAndBranch(['--dry-run'], {})).toEqual(['--dry-run']);
  });

  it('recovers only the flag that was actually lost', () => {
    // `--branch` survived (real flag present); only `--task` needs recovery.
    expect(
      recoverTaskAndBranch(['--branch', 'feature/demo'], { npm_config_task: '4' }),
    ).toEqual(['--branch', 'feature/demo', '--task', '4']);
  });

  it('does not duplicate a flag already present in argv', () => {
    expect(
      recoverTaskAndBranch(['--task', '4'], { npm_config_task: '9' }),
    ).toEqual(['--task', '4']);
  });

  it('recovers task, branch, and the boolean --recover flag together', () => {
    expect(
      recoverTaskAndBranch(['4', 'feat/agent-automation-foundation'], {
        npm_config_task: 'true',
        npm_config_branch: 'true',
        npm_config_recover: 'true',
      }),
    ).toEqual([
      '--task',
      '4',
      '--branch',
      'feat/agent-automation-foundation',
      '--recover',
    ]);
  });

  it('does not add --recover when it was not passed', () => {
    expect(
      recoverTaskAndBranch(['4', 'feat/agent-automation-foundation'], {
        npm_config_task: 'true',
        npm_config_branch: 'true',
      }),
    ).toEqual(['--task', '4', '--branch', 'feat/agent-automation-foundation']);
  });

  it('leaves an already-present --recover flag from direct node invocation untouched', () => {
    expect(
      recoverTaskAndBranch(['--task', '4', '--branch', 'feature/demo', '--recover'], {}),
    ).toEqual(['--task', '4', '--branch', 'feature/demo', '--recover']);
  });

  it('recovers --recover regardless of where the surviving flags fall', () => {
    expect(
      recoverTaskAndBranch(['--branch', 'feature/demo', '--recover'], {
        npm_config_task: '4',
      }),
    ).toEqual(['--branch', 'feature/demo', '--recover', '--task', '4']);
  });

  it('does not duplicate --recover already present in argv even if npm config also set it', () => {
    expect(
      recoverTaskAndBranch(['--task', '4', '--recover'], { npm_config_recover: 'true' }),
    ).toEqual(['--task', '4', '--recover']);
  });

  it('does not infer --recover from a task id or branch name that happens to look like it', () => {
    expect(
      recoverTaskAndBranch(['4', 'recover'], {
        npm_config_task: 'true',
        npm_config_branch: 'true',
      }),
    ).toEqual(['--task', '4', '--branch', 'recover']);
  });

  it('does not add --recover from an unrelated truthy npm config value', () => {
    expect(recoverTaskAndBranch(['--dry-run'], { npm_config_recover: '1' })).toEqual([
      '--dry-run',
    ]);
    expect(recoverTaskAndBranch([], {})).not.toContain('--recover');
  });
});
