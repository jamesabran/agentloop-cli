// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { buildDryRunArgs } from './dry-run.mjs';

describe('npm dry-run argument forwarding', () => {
  it('recovers npm-consumed paired task and branch flags on Windows', () => {
    expect(buildDryRunArgs(['4', 'feat/agent-automation-foundation'], {
      npm_config_task: 'true',
      npm_config_branch: 'true',
    })).toEqual([
      '--dry-run',
      '--task',
      '4',
      '--branch',
      'feat/agent-automation-foundation',
    ]);
  });

  it('keeps explicitly forwarded options intact', () => {
    expect(buildDryRunArgs(['--task', '4', '--branch', 'feature/demo'], {})).toEqual([
      '--dry-run',
      '--task',
      '4',
      '--branch',
      'feature/demo',
    ]);
  });
});
