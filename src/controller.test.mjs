// @vitest-environment node
/**
 * The base branch must never become the task's local working branch.
 *
 * A checkout of `main` would let local checkpoint commits land in the history
 * every task shares, and the eventual publishing push would try to
 * fast-forward `main` itself instead of publishing a task branch. There are
 * two ways `main` could end up selected: an explicit `--branch main` on the
 * command line, and a saved `.agent/state.json` whose `branch` field is the
 * base branch — hand-edited, or left over from an earlier bug. Both are
 * covered here, separately, because they are caught at different points:
 * `parseArgs` fails before anything else runs; `selectBranch` is what
 * `runLoop` calls after loading state, so it has to catch the saved-state
 * case that `parseArgs` cannot see.
 */
import { describe, expect, it } from 'vitest';

import {
  claimClaudeProcess,
  defaultBranch,
  hasValidImplementationHandoff,
  isValidNoChangeHandoff,
  parseArgs,
  selectBranch,
} from './controller.mjs';
import { emptyState, recordImplementation } from './lib/state.mjs';

describe('parseArgs refuses the base branch', () => {
  it('rejects --branch main before anything else runs', () => {
    expect(() => parseArgs(['--task', '5', '--branch', 'main'])).toThrow(/not permitted/);
    expect(() => parseArgs(['--task', '5', '--branch', 'main'])).toThrow(/base branch/);
  });

  it('accepts an ordinary task branch', () => {
    const options = parseArgs(['--task', '5', '--branch', 'agent/task-5']);
    expect(options.branch).toBe('agent/task-5');
  });

  it('does not reject when no --branch is given at all', () => {
    const options = parseArgs(['--task', '5']);
    expect(options.branch).toBeNull();
  });

  it('requires an explicit recovery flag rather than silently resuming Claude', () => {
    expect(parseArgs(['--task', '5', '--recover']).recover).toBe(true);
    expect(parseArgs(['--task', '5']).recover).toBe(false);
  });
});

describe('parseArgs --next', () => {
  it('parses --next', () => {
    expect(parseArgs(['--next']).next).toBe(true);
    expect(parseArgs([]).next).toBe(false);
  });

  it('parses --dry-run --next', () => {
    const options = parseArgs(['--dry-run', '--next']);
    expect(options.dryRun).toBe(true);
    expect(options.next).toBe(true);
  });

  it('rejects --next with --task', () => {
    expect(() => parseArgs(['--next', '--task', '5'])).toThrow(/mutually exclusive/);
    expect(() => parseArgs(['--task', '5', '--next'])).toThrow(/mutually exclusive/);
  });

  it('rejects --next with --brief', () => {
    expect(() => parseArgs(['--next', '--brief', 'custom.md'])).toThrow(/mutually exclusive/);
  });

  it('preserves existing --task and --brief support', () => {
    const options = parseArgs(['--task', '3c-1', '--brief', 'docs/task.md']);
    expect(options.task).toBe('3c-1');
    expect(options.brief).toBe('docs/task.md');
    expect(options.next).toBe(false);
  });

  it('preserves --self-check', () => {
    expect(parseArgs(['--self-check']).selfCheck).toBe(true);
  });
});

describe('Claude process and Codex handoff gates', () => {
  it('permits only one Claude process in a controller invocation', () => {
    const context = { claudeProcessesStarted: 0 };
    expect(claimClaudeProcess(context)).toBe(true);
    expect(claimClaudeProcess(context)).toBe(false);
    expect(context.claudeProcessesStarted).toBe(1);
  });

  it('admits Codex only for the exact Claude checkpoint at HEAD', () => {
    const head = 'a'.repeat(40);
    expect(hasValidImplementationHandoff({ implementationHead: head, implementationHandoffValid: true }, head))
      .toBe(true);
    expect(hasValidImplementationHandoff({ implementationHead: head, implementationHandoffValid: false }, head))
      .toBe(false);
    expect(hasValidImplementationHandoff({ implementationHead: 'b'.repeat(40), implementationHandoffValid: true }, head))
      .toBe(false);
    expect(hasValidImplementationHandoff({ implementationHead: null, implementationHandoffValid: true }, head))
      .toBe(false);
  });
});

describe('isValidNoChangeHandoff', () => {
  const head = 'a'.repeat(40);
  const validStatus = { status: 'READY_FOR_AUDIT', verification: 'PASS', blockers: 0, head };

  it('accepts a verified no-change handoff: PASS, no blockers, matching HEAD, clean tree', () => {
    expect(isValidNoChangeHandoff({ status: validStatus, head, treeClean: true })).toBe(true);
  });

  it('recording the checkpoint at the unchanged HEAD carries the same provenance Codex requires', () => {
    // The accepted no-change handoff is recorded through the identical
    // recordImplementation() call the normal (new-commit) path uses, so the
    // exact-head Codex gate (hasValidImplementationHandoff) sees no difference.
    const before = { ...emptyState(), task: '5', branch: 'agent/task-5' };
    const after = recordImplementation(before, head);
    expect(after.implementationHead).toBe(head);
    expect(after.implementationHandoffValid).toBe(true);
    expect(hasValidImplementationHandoff(after, head)).toBe(true);
  });

  it('rejects a HEAD mismatch', () => {
    const other = 'b'.repeat(40);
    expect(
      isValidNoChangeHandoff({ status: { ...validStatus, head: other }, head, treeClean: true }),
    ).toBe(false);
    expect(isValidNoChangeHandoff({ status: validStatus, head: other, treeClean: true })).toBe(
      false,
    );
  });

  it('rejects a dirty worktree', () => {
    expect(isValidNoChangeHandoff({ status: validStatus, head, treeClean: false })).toBe(false);
  });

  it('rejects when verification did not pass', () => {
    expect(
      isValidNoChangeHandoff({
        status: { ...validStatus, verification: 'FAIL' },
        head,
        treeClean: true,
      }),
    ).toBe(false);
  });

  it('rejects when blockers exist', () => {
    expect(
      isValidNoChangeHandoff({ status: { ...validStatus, blockers: 1 }, head, treeClean: true }),
    ).toBe(false);
  });

  it('rejects a status that is not READY_FOR_AUDIT', () => {
    expect(
      isValidNoChangeHandoff({ status: { ...validStatus, status: 'BLOCKED' }, head, treeClean: true }),
    ).toBe(false);
  });
});

describe('selectBranch refuses the base branch', () => {
  it('rejects an explicit --branch main', () => {
    const result = selectBranch({ optionsBranch: 'main', loaded: emptyState(), task: '5' });
    expect(result.rejected).toBe(true);
    expect(result.branch).toBe('main');
  });

  it('rejects a saved state whose branch is main, for the same resumed task', () => {
    // Nothing was passed on the command line; the base branch came from a
    // hand-edited or corrupted .agent/state.json instead.
    const loaded = { ...emptyState(), task: '5', branch: 'main' };
    const result = selectBranch({ optionsBranch: null, loaded, task: '5' });
    expect(result.rejected).toBe(true);
    expect(result.branch).toBe('main');
  });

  it('does not inherit a saved main branch when the task differs', () => {
    // Unrelated work: the saved branch belongs to a different task and must
    // not be reused, so defaultBranch(task) is what actually gets selected.
    const loaded = { ...emptyState(), task: '5', branch: 'main' };
    const result = selectBranch({ optionsBranch: null, loaded, task: '6' });
    expect(result.rejected).toBe(false);
    expect(result.branch).toBe(defaultBranch('6'));
  });

  it('accepts the default branch derived from the task', () => {
    const result = selectBranch({ optionsBranch: null, loaded: emptyState(), task: '5' });
    expect(result.rejected).toBe(false);
    expect(result.branch).toBe(defaultBranch('5'));
  });

  it('resumes an ordinary saved branch for the same task', () => {
    const loaded = { ...emptyState(), task: '5', branch: 'agent/task-5' };
    const result = selectBranch({ optionsBranch: null, loaded, task: '5' });
    expect(result.rejected).toBe(false);
    expect(result.branch).toBe('agent/task-5');
  });

  it('lets an explicit --branch override a saved branch, as long as it is not main', () => {
    const loaded = { ...emptyState(), task: '5', branch: 'agent/task-5' };
    const result = selectBranch({ optionsBranch: 'agent/task-5-retry', loaded, task: '5' });
    expect(result.rejected).toBe(false);
    expect(result.branch).toBe('agent/task-5-retry');
  });
});

describe('defaultBranch never collides with the base branch', () => {
  it('always prefixes agent/task- regardless of the task id', () => {
    for (const task of ['5', 'main', 'MAIN', 'local-spike']) {
      expect(defaultBranch(task)).toMatch(/^agent\/task-/);
      expect(defaultBranch(task)).not.toBe('main');
    }
  });
});
