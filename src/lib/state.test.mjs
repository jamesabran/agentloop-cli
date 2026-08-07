// @vitest-environment node
/**
 * Local task state.
 *
 * The loop is local-first, so this file is the only record of where a task
 * has got to. It is gitignored and hand-editable, which makes it untrusted
 * input: a value that fails its check is dropped rather than carried forward,
 * and a state whose task or branch is unusable restarts rather than inheriting
 * a verdict that might describe different work.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  STATE_VERSION,
  clearFailures,
  clearUsageLimit,
  emptyState,
  loadState,
  recordAudit,
  recordFailure,
  recordImplementation,
  recordUsageLimit,
  requireRecovery,
  beginRecovery,
  saveState,
  selectTask,
  usageLimitRemainingMs,
} from './state.mjs';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

const tempDirs = [];

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentloop-state-'));
  tempDirs.push(dir);
  return path.join(dir, 'state.json');
}

function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value), 'utf8');
  return file;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe('loadState', () => {
  it('returns a fresh state when the file is missing', () => {
    const state = loadState(path.join(os.tmpdir(), 'agentloop-does-not-exist', 'state.json'));
    expect(state.task).toBeNull();
    expect(state.round).toBe(0);
    expect(state.blockers).toEqual([]);
  });

  it('returns a fresh state when the file is not JSON', () => {
    const file = tempFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'not json at all', 'utf8');
    expect(loadState(file).task).toBeNull();
  });

  it('returns a fresh state for a version it does not understand', () => {
    const file = write(tempFile(), { version: 999, task: '5', branch: 'agent/task-5' });
    expect(loadState(file).task).toBeNull();
  });

  it('rejects the preceding controller state version rather than resuming it', () => {
    const file = write(tempFile(), { version: STATE_VERSION - 1, task: '5', branch: 'agent/task-5' });
    expect(loadState(file).task).toBeNull();
  });

  it('round-trips a complete state', () => {
    const file = tempFile();
    saveState(
      {
        ...emptyState(),
        task: '5',
        branch: 'agent/task-5',
        implementationHead: B,
        lastAuditedHead: A,
        round: 1,
        changeRounds: 1,
        verdict: 'REQUEST_CHANGES',
        blockers: ['One finding'],
      },
      file,
    );

    const loaded = loadState(file);
    expect(loaded.version).toBe(STATE_VERSION);
    expect(loaded.task).toBe('5');
    expect(loaded.implementationHead).toBe(B);
    expect(loaded.lastAuditedHead).toBe(A);
    expect(loaded.verdict).toBe('REQUEST_CHANGES');
    expect(loaded.blockers).toEqual(['One finding']);
    expect(loaded.dropped).toEqual([]);
  });

  it('drops an abbreviated commit rather than carrying it forward', () => {
    // A verdict is pinned to one commit; a 7-character prefix cannot pin it.
    const file = write(tempFile(), {
      version: STATE_VERSION,
      task: '5',
      branch: 'agent/task-5',
      lastAuditedHead: 'a1b2c3d',
    });
    const loaded = loadState(file);
    expect(loaded.dropped).toContain('lastAuditedHead');
    expect(loaded.lastAuditedHead).toBeNull();
  });

  it('drops a verdict that is not one the loop produces', () => {
    const file = write(tempFile(), {
      version: STATE_VERSION,
      task: '5',
      branch: 'agent/task-5',
      verdict: 'LGTM',
    });
    const loaded = loadState(file);
    expect(loaded.dropped).toContain('verdict');
    expect(loaded.verdict).toBeNull();
  });

  it('ignores keys that are not part of the schema', () => {
    const file = write(tempFile(), {
      version: STATE_VERSION,
      task: '5',
      branch: 'agent/task-5',
      githubToken: 'ghp_should_never_be_here',
    });
    expect(loadState(file).githubToken).toBeUndefined();
  });

  it('restarts the task when the branch is unusable', () => {
    // The commits and the verdict are only identifiable through the task and
    // its branch. Without them they might describe entirely different work.
    const file = write(tempFile(), {
      version: STATE_VERSION,
      task: '5',
      branch: 42,
      implementationHead: A,
      lastAuditedHead: A,
      verdict: 'APPROVED',
    });
    const loaded = loadState(file);
    expect(loaded.dropped).toContain('branch');
    expect(loaded.verdict).toBeNull();
    expect(loaded.lastAuditedHead).toBeNull();
    expect(loaded.implementationHead).toBeNull();
  });
});

describe('selectTask', () => {
  it('resumes the saved position for the same task', () => {
    const saved = { ...emptyState(), task: '5', branch: 'agent/task-5', lastAuditedHead: A };
    const { state, resumed } = selectTask(saved, { task: '5', branch: 'agent/task-5' });
    expect(resumed).toBe(true);
    expect(state.lastAuditedHead).toBe(A);
  });

  it('discards everything when the task changes', () => {
    const saved = {
      ...emptyState(),
      task: '5',
      branch: 'agent/task-5',
      lastAuditedHead: A,
      verdict: 'APPROVED',
      claudeSessionId: '11111111-2222-3333-4444-555555555555',
    };
    const { state, resumed } = selectTask(saved, { task: '6', branch: 'agent/task-6' });
    expect(resumed).toBe(false);
    expect(state.task).toBe('6');
    expect(state.lastAuditedHead).toBeNull();
    expect(state.verdict).toBeNull();
    expect(state.claudeSessionId).toBeNull();
  });
});

describe('recordImplementation', () => {
  it('voids the verdict, because it belonged to an older commit', () => {
    const approved = {
      ...emptyState(),
      implementationHead: A,
      lastAuditedHead: A,
      verdict: 'APPROVED',
    };
    const next = recordImplementation(approved, B);
    expect(next.implementationHead).toBe(B);
    expect(next.implementationHandoffValid).toBe(true);
    expect(next.verdict).toBeNull();
    // Kept: it is where the next audit's range starts.
    expect(next.lastAuditedHead).toBe(A);
  });

  it('clears readyToPublishHead — new commit invalidates prior manual readiness', () => {
    const manualReady = {
      ...emptyState(),
      implementationHead: A,
      lastAuditedHead: A,
      verdict: 'APPROVED',
      readyToPublishHead: A,
    };
    const next = recordImplementation(manualReady, B);
    expect(next.readyToPublishHead).toBeNull();
    expect(next.verdict).toBeNull();
    expect(next.implementationHead).toBe(B);
  });
});

describe('recordAudit', () => {
  it('counts a change round and keeps the blockers', () => {
    const next = recordAudit(emptyState(), {
      head: A,
      verdict: 'REQUEST_CHANGES',
      blockers: ['One', 'Two'],
    });
    expect(next.lastAuditedHead).toBe(A);
    expect(next.round).toBe(1);
    expect(next.changeRounds).toBe(1);
    expect(next.blockers).toEqual(['One', 'Two']);
  });

  it('does not count an approval as a change round, and clears the blockers', () => {
    const after = recordAudit(
      recordAudit(emptyState(), { head: A, verdict: 'REQUEST_CHANGES', blockers: ['One'] }),
      { head: B, verdict: 'APPROVED' },
    );
    expect(after.round).toBe(2);
    expect(after.changeRounds).toBe(1);
    expect(after.verdict).toBe('APPROVED');
    expect(after.blockers).toEqual([]);
  });
});

describe('failure counting', () => {
  it('counts consecutive failures on the same step only', () => {
    let outcome = recordFailure(emptyState(), 'audit', 3);
    expect(outcome.state.consecutiveFailures).toBe(1);
    expect(outcome.exhausted).toBe(false);

    outcome = recordFailure(outcome.state, 'audit', 3);
    expect(outcome.state.consecutiveFailures).toBe(2);

    outcome = recordFailure(outcome.state, 'implement', 3);
    expect(outcome.state.consecutiveFailures).toBe(1);

    const cleared = clearFailures(outcome.state);
    expect(cleared.consecutiveFailures).toBe(0);
    expect(cleared.failingStep).toBeNull();
  });

  it('reports exhaustion at the limit', () => {
    const first = recordFailure(emptyState(), 'audit', 2);
    const second = recordFailure(first.state, 'audit', 2);
    expect(second.exhausted).toBe(true);
  });
});

describe('usage limits are a pause, not a failure', () => {
  it('keeps the Claude session across a pause', () => {
    const session = '11111111-2222-3333-4444-555555555555';
    const paused = recordUsageLimit(
      { ...emptyState(), claudeSessionId: session },
      Date.now() + 10_000,
    );
    expect(paused.claudeSessionId).toBe(session);
    expect(usageLimitRemainingMs(paused)).toBeGreaterThan(0);
  });

  it('reports no remaining pause once it has elapsed', () => {
    const paused = recordUsageLimit(emptyState(), Date.now() - 1000);
    expect(usageLimitRemainingMs(paused)).toBe(0);
    expect(usageLimitRemainingMs(clearUsageLimit(paused))).toBe(0);
  });
});

describe('terminal Claude recovery', () => {
  it('discards the session and requires an explicit fresh recovery', () => {
    const session = '11111111-2222-3333-4444-555555555555';
    const stopped = requireRecovery({ ...emptyState(), claudeSessionId: session }, 'Claude timed out');
    expect(stopped.claudeSessionId).toBeNull();
    expect(stopped.recoveryRequired).toBe(true);
    expect(stopped.recoveryReason).toBe('Claude timed out');

    const recovered = beginRecovery(stopped);
    expect(recovered.recoveryRequired).toBe(false);
    expect(recovered.recoveryReason).toBeNull();
    expect(recovered.claudeSessionId).toBeNull();
  });

  it('clears readyToPublishHead in both recovery transitions', () => {
    const before = {
      ...emptyState(),
      task: '5',
      branch: 'agent/task-5',
      verdict: 'APPROVED',
      readyToPublishHead: A,
      claudeSessionId: '11111111-2222-3333-4444-555555555555',
    };

    // requireRecovery clears readiness.
    const stopped = requireRecovery(before, 'Claude timed out');
    expect(stopped.readyToPublishHead).toBeNull();
    expect(stopped.recoveryRequired).toBe(true);

    // beginRecovery also clears readiness.
    const recovered = beginRecovery({ ...stopped, readyToPublishHead: A });
    expect(recovered.readyToPublishHead).toBeNull();
    expect(recovered.recoveryRequired).toBe(false);
  });
});
