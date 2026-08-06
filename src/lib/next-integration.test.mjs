// @vitest-environment node
/**
 * Temporary-project integration tests for `--dry-run --next`.
 *
 * Each test creates an isolated git repository with a committed
 * `agentloop.tasks.json`, runs `controller.mjs --dry-run --next` as a child
 * process, and verifies:
 *  - The correct task is selected
 *  - No `.agent/` directory is created
 *  - No branch is created or switched
 *  - No files are modified
 *  - No agent is invoked
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONTROLLER = path.resolve(HERE, '..', 'controller.mjs');

const tempDirs = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

function makeProject(tasks) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentloop-next-'));
  tempDirs.push(dir);
  spawnSync('git', ['init', '--quiet'], { cwd: dir });
  spawnSync('git', ['config', 'user.email', 'test@test.test'], { cwd: dir });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: dir });

  const tasksFile = { version: 1, tasks };
  fs.writeFileSync(
    path.join(dir, 'agentloop.tasks.json'),
    JSON.stringify(tasksFile, null, 2),
    'utf8',
  );

  return dir;
}

function snapshot(dir) {
  const skip = new Set(['.git']);
  const into = new Map();

  function walk(current, base) {
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (skip.has(entry.name)) continue;
      const full = path.join(current, entry.name);
      const relative = path.relative(base, full).split(path.sep).join('/');
      if (entry.isDirectory()) {
        into.set(`${relative}/`, 'dir');
        walk(full, base);
      } else if (entry.isFile()) {
        into.set(relative, crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex'));
      }
    }
  }

  walk(dir, dir);
  return into;
}

function runNext(projectDir, extraArgs = []) {
  return spawnSync(
    process.execPath,
    [CONTROLLER, '--dry-run', '--next', ...extraArgs],
    { cwd: projectDir, encoding: 'utf8' },
  );
}

function baseTask(id, overrides = {}) {
  return {
    id,
    title: `Task ${id}`,
    status: 'planned',
    dependsOn: [],
    goal: `Goal for ${id}.`,
    requirements: [`Requirement for ${id}.`],
    exclusions: [],
    ...overrides,
  };
}

/* ------------------------------------------------------------------ *
 * Selection tests                                                     *
 * ------------------------------------------------------------------ */

describe('--dry-run --next selects the expected task', () => {
  it('selects an explicit eligible "next" task', () => {
    const project = makeProject([
      { ...baseTask('setup'), status: 'completed' },
      { ...baseTask('feature-a'), status: 'next', dependsOn: ['setup'] },
      { ...baseTask('feature-b'), status: 'planned', dependsOn: ['setup'] },
    ]);
    const before = snapshot(project);

    const result = runNext(project);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/Task ID: feature-a/);
    expect(result.stdout).toMatch(/Title: Task feature-a/);
    expect(result.stdout).toMatch(/marked "next"/);

    const after = snapshot(project);
    expect(after.size).toBe(before.size); // no new files
    expect(fs.existsSync(path.join(project, '.agent'))).toBe(false);
  });

  it('falls back to first eligible "planned" when no "next" exists', () => {
    const project = makeProject([
      { ...baseTask('setup'), status: 'completed' },
      { ...baseTask('feature-a'), status: 'planned', dependsOn: ['setup'] },
      { ...baseTask('feature-b'), status: 'planned', dependsOn: ['setup'] },
    ]);
    const result = runNext(project);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/Task ID: feature-a/);
    expect(result.stdout).toMatch(/file order/);
  });

  it('skips tasks with incomplete dependencies', () => {
    const project = makeProject([
      { ...baseTask('dep'), status: 'planned' },
      { ...baseTask('child'), status: 'next', dependsOn: ['dep'] },
    ]);
    const result = runNext(project);
    expect(result.status).toBe(0);
    // child is ineligible (dep not completed), so dep is selected (only eligible planned)
    expect(result.stdout).toMatch(/Task ID: dep/);
  });

  it('fails cleanly when no eligible task exists', () => {
    const project = makeProject([
      { ...baseTask('done'), status: 'completed' },
      { ...baseTask('stuck'), status: 'blocked' },
    ]);
    const result = runNext(project);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/No eligible task/);
  });

  it('fails when multiple eligible tasks are marked "next"', () => {
    const project = makeProject([
      { ...baseTask('a'), status: 'next' },
      { ...baseTask('b'), status: 'next' },
    ]);
    const result = runNext(project);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/Multiple eligible tasks are marked "next"/);
  });
});

/* ------------------------------------------------------------------ *
 * Mutation safety                                                     *
 * ------------------------------------------------------------------ */

describe('--dry-run --next causes no mutations', () => {
  it('does not create .agent/', () => {
    const project = makeProject([
      { ...baseTask('t1'), status: 'next' },
    ]);
    const before = snapshot(project);

    const result = runNext(project);
    expect(result.status).toBe(0);

    const after = snapshot(project);
    expect(fs.existsSync(path.join(project, '.agent'))).toBe(false);
    expect(after.size).toBe(before.size);
  });

  it('does not create or switch branches', () => {
    const project = makeProject([
      { ...baseTask('t1'), status: 'next' },
    ]);
    const branchesBefore = spawnSync('git', ['branch'], { cwd: project, encoding: 'utf8' }).stdout;

    const result = runNext(project);
    expect(result.status).toBe(0);

    const branchesAfter = spawnSync('git', ['branch'], { cwd: project, encoding: 'utf8' }).stdout;
    expect(branchesAfter).toBe(branchesBefore);
  });

  it('does not modify any files', () => {
    const project = makeProject([
      { ...baseTask('t1'), status: 'next' },
    ]);
    const before = snapshot(project);

    runNext(project);

    const after = snapshot(project);
    const changes = [];
    for (const [file, hash] of after) {
      if (!before.has(file)) changes.push(`created: ${file}`);
      else if (before.get(file) !== hash) changes.push(`modified: ${file}`);
    }
    for (const file of before.keys()) {
      if (!after.has(file)) changes.push(`deleted: ${file}`);
    }
    expect(changes).toEqual([]);
  });

  it('does not invoke any agent', () => {
    const project = makeProject([
      { ...baseTask('t1'), status: 'next' },
    ]);
    const result = runNext(project);
    expect(result.stdout).toMatch(/Dry run: no agent was started/);
    // The dry-run should stop before running Claude
    expect(result.stdout).not.toMatch(/Starting Claude/);
    expect(result.stdout).not.toMatch(/Starting Codex/);
  });
});

/* ------------------------------------------------------------------ *
 * Dry-run output completeness                                         *
 * ------------------------------------------------------------------ */

describe('--dry-run --next output includes all required fields', () => {
  it('shows resolved task-file path', () => {
    const project = makeProject([{ ...baseTask('t1'), status: 'next' }]);
    const result = runNext(project);
    expect(result.stdout).toMatch(/Task file:/);
  });

  it('shows selected task ID and title', () => {
    const project = makeProject([{ ...baseTask('t1'), status: 'next' }]);
    const result = runNext(project);
    expect(result.stdout).toMatch(/Task ID: t1/);
    expect(result.stdout).toMatch(/Title: Task t1/);
  });

  it('shows why the task is eligible', () => {
    const project = makeProject([{ ...baseTask('t1'), status: 'next' }]);
    const result = runNext(project);
    expect(result.stdout).toMatch(/marked "next"/);
  });

  it('shows dependency IDs and statuses', () => {
    const project = makeProject([
      { ...baseTask('setup'), status: 'completed' },
      { ...baseTask('feature-a'), status: 'next', dependsOn: ['setup'] },
    ]);
    const result = runNext(project);
    expect(result.stdout).toMatch(/setup: completed/);
  });

  it('shows generated branch name', () => {
    const project = makeProject([{ ...baseTask('t1'), status: 'next' }]);
    const result = runNext(project);
    expect(result.stdout).toMatch(/Branch: agent\/task-t1/);
  });

  it('shows configured checks', () => {
    const project = makeProject([{ ...baseTask('t1'), status: 'next' }]);
    const result = runNext(project);
    expect(result.stdout).toMatch(/Checks:/);
  });

  it('shows maximum correction rounds', () => {
    const project = makeProject([{ ...baseTask('t1'), status: 'next' }]);
    const result = runNext(project);
    expect(result.stdout).toMatch(/Max correction rounds:/);
  });

  it('shows that the brief will be generated from the committed task file', () => {
    const project = makeProject([{ ...baseTask('t1'), status: 'next' }]);
    const result = runNext(project);
    expect(result.stdout).toMatch(/Brief: generated from the committed task file/);
  });

  it('shows whether selecting a new task or resuming', () => {
    const project = makeProject([{ ...baseTask('t1'), status: 'next' }]);
    const result = runNext(project);
    expect(result.stdout).toMatch(/new task selected deterministically/);
  });
});

/* ------------------------------------------------------------------ *
 * Invalid task file rejection before mutations                        *
 * ------------------------------------------------------------------ */

describe('invalid task files are rejected before any mutation', () => {
  it('rejects invalid JSON and does not create .agent/', () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'agentloop-next-'));
    tempDirs.push(project);
    spawnSync('git', ['init', '--quiet'], { cwd: project });
    fs.writeFileSync(path.join(project, 'agentloop.tasks.json'), 'not json {{{', 'utf8');

    const result = runNext(project);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/not valid JSON/);
    expect(fs.existsSync(path.join(project, '.agent'))).toBe(false);
  });

  it('rejects an unsupported version and does not mutate', () => {
    const project = makeProject([
      { ...baseTask('t1'), status: 'next' },
    ]);
    // Corrupt the file after creation
    fs.writeFileSync(
      path.join(project, 'agentloop.tasks.json'),
      JSON.stringify({ version: 999, tasks: [] }),
      'utf8',
    );

    const result = runNext(project);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/unsupported schema version/);
    expect(fs.existsSync(path.join(project, '.agent'))).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * Stale active-state handling                                         *
 * ------------------------------------------------------------------ */

describe('saved active state referencing a missing task fails clearly', () => {
  it('fails when .agent/state.json references a task not in the roadmap', () => {
    const project = makeProject([
      { ...baseTask('setup'), status: 'completed' },
      { ...baseTask('feature-a'), status: 'next', dependsOn: ['setup'] },
    ]);

    // Write a state file referencing a task that does not exist in the roadmap
    fs.mkdirSync(path.join(project, '.agent'), { recursive: true });
    fs.writeFileSync(
      path.join(project, '.agent', 'state.json'),
      JSON.stringify({
        version: 4,
        task: 'removed-task',
        branch: 'agent/task-removed-task',
        implementationHead: null,
        implementationHandoffValid: false,
        lastAuditedHead: null,
        round: 0,
        changeRounds: 0,
        verdict: null,
        blockers: [],
        publishedHead: null,
        claudeSessionId: null,
        consecutiveFailures: 0,
        failingStep: null,
        usageLimitUntil: null,
        usageLimitCount: 0,
        recoveryRequired: false,
        recoveryReason: null,
        updatedAt: new Date().toISOString(),
      }),
      'utf8',
    );

    const result = runNext(project);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/not found/);
    // Must not silently select a different task
    expect(result.stdout).not.toMatch(/Task ID:/);
  });

  it('does not discard review/recovery state when the active task is missing', () => {
    const project = makeProject([
      { ...baseTask('setup'), status: 'completed' },
      { ...baseTask('feature-a'), status: 'next', dependsOn: ['setup'] },
    ]);

    // Write a state file with active review state that references a removed task
    fs.mkdirSync(path.join(project, '.agent'), { recursive: true });
    fs.writeFileSync(
      path.join(project, '.agent', 'state.json'),
      JSON.stringify({
        version: 4,
        task: 'deleted-task',
        branch: 'agent/task-deleted-task',
        implementationHead: 'a'.repeat(40),
        implementationHandoffValid: true,
        lastAuditedHead: 'a'.repeat(40),
        round: 1,
        changeRounds: 1,
        verdict: 'REQUEST_CHANGES',
        blockers: ['Needs more tests'],
        publishedHead: null,
        claudeSessionId: '11111111-2222-3333-4444-555555555555',
        consecutiveFailures: 0,
        failingStep: null,
        usageLimitUntil: null,
        usageLimitCount: 0,
        recoveryRequired: false,
        recoveryReason: null,
        updatedAt: new Date().toISOString(),
      }),
      'utf8',
    );

    const result = runNext(project);
    expect(result.status).not.toBe(0);
    // Must fail referencing the missing task
    expect(result.stderr).toMatch(/deleted-task/);
    expect(result.stderr).toMatch(/not found/);
    // Must not silently fall through to selectNextTask
    expect(result.stdout).not.toMatch(/file order/);
    // .agent/ must not be cleared — the caller must decide
    expect(fs.existsSync(path.join(project, '.agent', 'state.json'))).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * Path-traversal task IDs are rejected before any mutation            *
 * ------------------------------------------------------------------ */

describe('task IDs with path traversal are rejected', () => {
  it('rejects "x/../../escaped" before any filesystem mutation', () => {
    const project = makeProject([
      { ...baseTask('setup'), status: 'completed' },
      { ...baseTask('x/../../escaped'), status: 'next', dependsOn: ['setup'] },
    ]);

    const result = runNext(project);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/not a valid task identifier/);
    expect(fs.existsSync(path.join(project, '.agent'))).toBe(false);
  });

  it('rejects a task ID containing "." in the committed file', () => {
    const project = makeProject([
      { ...baseTask('bad.id'), status: 'next' },
    ]);

    const result = runNext(project);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/not a valid task identifier/);
  });
});
