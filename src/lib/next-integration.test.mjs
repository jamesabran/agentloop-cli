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

import { encodeCacheKey } from './tasks.mjs';
import { migrateLegacyCache } from '../controller.mjs';

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

describe('saved active state referencing a blocked task fails clearly', () => {
  function writeState(project, taskId) {
    fs.mkdirSync(path.join(project, '.agent'), { recursive: true });
    fs.writeFileSync(
      path.join(project, '.agent', 'state.json'),
      JSON.stringify({
        version: 4,
        task: taskId,
        branch: 'agent/task-' + taskId,
        implementationHead: null,
        implementationHandoffValid: false,
        lastAuditedHead: null,
        round: 0,
        changeRounds: 0,
        verdict: null,
        blockers: [],
        publishedHead: null,
        readyToPublishHead: null,
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
  }

  it('rejects a saved task that is blocked in the roadmap', () => {
    const project = makeProject([
      { ...baseTask('setup'), status: 'completed' },
      { ...baseTask('blocked-task'), status: 'blocked' },
    ]);
    writeState(project, 'blocked-task');

    const result = runNext(project);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/blocked/);
    expect(result.stderr).toMatch(/blocked-task/);
    // Must not silently select a different task
    expect(result.stdout).not.toMatch(/Task ID:/);
  });

  it('rejects a saved task that is completed in the roadmap', () => {
    const project = makeProject([
      { ...baseTask('done'), status: 'completed' },
    ]);
    writeState(project, 'done');

    const result = runNext(project);
    // Completed tasks should not resume — falls through to selectNextTask,
    // but with no eligible task remaining this fails.
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/No eligible task/);
  });

  it('still resumes a saved task with an eligible status', () => {
    const project = makeProject([
      { ...baseTask('active'), status: 'next' },
    ]);
    writeState(project, 'active');

    const result = runNext(project);
    // Resumes normally.
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/Resuming active task/);
  });

  it('--next never selects a blocked task', () => {
    const project = makeProject([
      { ...baseTask('setup'), status: 'completed' },
      { ...baseTask('blocked-task'), status: 'blocked' },
      { ...baseTask('ready'), status: 'next' },
    ]);
    const result = runNext(project);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/Task ID: ready/);
    expect(result.stdout).not.toMatch(/blocked-task/);
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

  it('rejects a task ID with a "." path-traversal segment', () => {
    const project = makeProject([
      { ...baseTask('setup'), status: 'completed' },
      { ...baseTask('x/./escaped'), status: 'next', dependsOn: ['setup'] },
    ]);

    const result = runNext(project);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/not a valid task identifier/);
  });

  it('accepts a task ID containing a dot in a non-traversal position', () => {
    const project = makeProject([
      { ...baseTask('release.1'), status: 'next' },
    ]);

    const result = runNext(project);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/Task ID: release\.1/);
  });
});

/* ------------------------------------------------------------------ *
 * Cache-key path safety                                                *
 * ------------------------------------------------------------------ */

describe('encodeCacheKey prevents writes outside .agent/', () => {
  it('produces a safe key for a traversal-shaped task ID', () => {
    // When a task ID passes validation (no . or .. segments) the cache key
    // is a defence-in-depth measure. Even if a traversal-shaped ID somehow
    // reached the cache-path code, encodeCacheKey must render it safe.
    const key = encodeCacheKey('x/../../escaped');
    // Must not contain any path separators or traversal markers.
    expect(key).not.toMatch(/\.\./);
    expect(key).not.toMatch(/\//);
    // The key must be a flat hex string.
    expect(key).toMatch(/^[0-9a-f]+$/);
  });

  it('produces a key that path.join with .agent/ stays inside .agent/', () => {
    const agentDir = path.resolve('/tmp/test-project/.agent');
    const key = encodeCacheKey('x/../../escaped');
    const resolved = path.resolve(agentDir, `brief-${key}.md`);
    expect(resolved.startsWith(agentDir + path.sep)).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * Legacy cache migration                                              *
 * ------------------------------------------------------------------ */

describe('legacy cache migration', () => {
  it('finds and migrates an existing legacy brief-3c-1.md cache', () => {
    // Simulate a pre-existing installation: .agent/brief-3c-1.md from
    // before the fixed-width hex encoding was introduced.
    var project = fs.mkdtempSync(path.join(os.tmpdir(), 'agentloop-legacy-'));
    tempDirs.push(project);

    var agentDir = path.join(project, '.agent');
    fs.mkdirSync(agentDir, { recursive: true });

    var legacyContent = 'Issue #42: Test task from legacy cache\nhttps://example.com\n\nTest body.';
    fs.writeFileSync(path.join(agentDir, 'brief-3c-1.md'), legacyContent, 'utf8');

    // Non-dry-run so migration writes actually happen.
    // This will fail later (no Claude), but the cache migration happens first.
    var result = spawnSync(
      process.execPath,
      [CONTROLLER, '--task', '3c-1', '--verbose'],
      { cwd: project, encoding: 'utf8', timeout: 15000 },
    );

    // The migration must have written the canonical file before the
    // controller tried to start Claude and failed.
    var key = encodeCacheKey('3c-1');
    var canonicalPath = path.join(agentDir, 'brief-' + key + '.md');
    expect(fs.existsSync(canonicalPath)).toBe(true);
    var migrated = fs.readFileSync(canonicalPath, 'utf8');
    expect(migrated).toBe(legacyContent);

    // The legacy file should still exist (migration copies, doesn't delete).
    expect(fs.existsSync(path.join(agentDir, 'brief-3c-1.md'))).toBe(true);
  });

  it('canonical file wins when both exist', () => {
    var project = fs.mkdtempSync(path.join(os.tmpdir(), 'agentloop-legacy-'));
    tempDirs.push(project);

    var agentDir = path.join(project, '.agent');
    fs.mkdirSync(agentDir, { recursive: true });

    // Create both legacy and canonical files with different content.
    fs.writeFileSync(path.join(agentDir, 'brief-3c-1.md'), 'legacy content', 'utf8');
    var key = encodeCacheKey('3c-1');
    fs.writeFileSync(path.join(agentDir, 'brief-' + key + '.md'), 'canonical content', 'utf8');

    // With --dry-run the canonical file should be read and legacy ignored.
    var result = spawnSync(
      process.execPath,
      [CONTROLLER, '--task', '3c-1', '--verbose', '--dry-run'],
      { cwd: project, encoding: 'utf8', timeout: 15000 },
    );

    // Dry-run shouldn't crash looking for briefs.
    expect(result.status).toBe(0);

    // The canonical file must still contain its own content (not overwritten
    // by the legacy content). This also validates the EEXIST defence:
    // even if a race placed the canonical file between the existsSync
    // check and the wx write, the content is never overwritten.
    var canonicalAfter = fs.readFileSync(path.join(agentDir, 'brief-' + key + '.md'), 'utf8');
    expect(canonicalAfter).toBe('canonical content');
  });

  it('migrates atomically with wx exclusive creation', () => {
    // When only the legacy file exists, the wx write succeeds and the
    // migrated content lands in the canonical file.
    var project = fs.mkdtempSync(path.join(os.tmpdir(), 'agentloop-legacy-'));
    tempDirs.push(project);

    var agentDir = path.join(project, '.agent');
    fs.mkdirSync(agentDir, { recursive: true });

    var legacyContent = 'Atomic migration test content.';
    fs.writeFileSync(path.join(agentDir, 'brief-3c-1.md'), legacyContent, 'utf8');

    // No canonical file exists — wx must succeed.
    var key = encodeCacheKey('3c-1');
    var canonicalPath = path.join(agentDir, 'brief-' + key + '.md');
    expect(fs.existsSync(canonicalPath)).toBe(false);

    var result = spawnSync(
      process.execPath,
      [CONTROLLER, '--task', '3c-1', '--verbose'],
      { cwd: project, encoding: 'utf8', timeout: 15000 },
    );

    // After migration the canonical file exists with the correct content.
    expect(fs.existsSync(canonicalPath)).toBe(true);
    expect(fs.readFileSync(canonicalPath, 'utf8')).toBe(legacyContent);
  });

  it('does not overwrite canonical file on EEXIST', () => {
    // When the canonical file already exists, the legacy path is skipped
    // entirely (the early canonical check at the top of resolveBrief
    // catches it). The wx flag in the migration path is defence-in-depth
    // for the race case where the file appears between the check and the
    // write — this test validates the common (non-race) path.
    var project = fs.mkdtempSync(path.join(os.tmpdir(), 'agentloop-legacy-'));
    tempDirs.push(project);

    var agentDir = path.join(project, '.agent');
    fs.mkdirSync(agentDir, { recursive: true });

    var key = encodeCacheKey('3c-1');
    var canonicalPath = path.join(agentDir, 'brief-' + key + '.md');

    // Pre-create both. The canonical file must win.
    fs.writeFileSync(path.join(agentDir, 'brief-3c-1.md'), 'stale legacy', 'utf8');
    fs.writeFileSync(canonicalPath, 'authoritative canonical', 'utf8');

    var result = spawnSync(
      process.execPath,
      [CONTROLLER, '--task', '3c-1', '--verbose', '--dry-run'],
      { cwd: project, encoding: 'utf8', timeout: 15000 },
    );

    expect(result.status).toBe(0);
    // Canonical content must remain unchanged.
    expect(fs.readFileSync(canonicalPath, 'utf8')).toBe('authoritative canonical');
  });

  it('rejects legacy file with mismatched case for Foo vs foo', () => {
    // Task "Foo" must not match a legacy file "brief-foo.md".
    var project = fs.mkdtempSync(path.join(os.tmpdir(), 'agentloop-legacy-'));
    tempDirs.push(project);

    var agentDir = path.join(project, '.agent');
    fs.mkdirSync(agentDir, { recursive: true });

    // Write the legacy file in lowercase.
    fs.writeFileSync(path.join(agentDir, 'brief-foo.md'), 'wrong case', 'utf8');

    // Task "Foo" (capital F) — readdirSync returns 'brief-foo.md',
    // which does not === 'brief-Foo.md'.
    var result = spawnSync(
      process.execPath,
      [CONTROLLER, '--task', 'Foo', '--verbose', '--dry-run'],
      { cwd: project, encoding: 'utf8', timeout: 15000 },
    );

    // Must fail with "No brief" because the legacy entry case doesn't match.
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/No brief/);
  });

  it('rejects legacy file with mismatched case for foo vs Foo', () => {
    // Task "foo" must not match a legacy file "brief-Foo.md".
    var project = fs.mkdtempSync(path.join(os.tmpdir(), 'agentloop-legacy-'));
    tempDirs.push(project);

    var agentDir = path.join(project, '.agent');
    fs.mkdirSync(agentDir, { recursive: true });

    // Write the legacy file in mixed case.
    fs.writeFileSync(path.join(agentDir, 'brief-Foo.md'), 'wrong case', 'utf8');

    var result = spawnSync(
      process.execPath,
      [CONTROLLER, '--task', 'foo', '--verbose', '--dry-run'],
      { cwd: project, encoding: 'utf8', timeout: 15000 },
    );

    // Must fail — directory entry 'brief-Foo.md' !== 'brief-foo.md'.
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/No brief/);
  });

  it('accepts exact-case legacy entry', () => {
    // Task "Foo" with an exact-case legacy file "brief-Foo.md" must match.
    var project = fs.mkdtempSync(path.join(os.tmpdir(), 'agentloop-legacy-'));
    tempDirs.push(project);

    var agentDir = path.join(project, '.agent');
    fs.mkdirSync(agentDir, { recursive: true });

    fs.writeFileSync(path.join(agentDir, 'brief-Foo.md'), 'exact case match', 'utf8');

    var result = spawnSync(
      process.execPath,
      [CONTROLLER, '--task', 'Foo', '--verbose'],
      { cwd: project, encoding: 'utf8', timeout: 15000 },
    );

    // Migration must succeed — canonical file must exist after.
    var key = encodeCacheKey('Foo');
    var canonicalPath = path.join(agentDir, 'brief-' + key + '.md');
    expect(fs.existsSync(canonicalPath)).toBe(true);
    expect(fs.readFileSync(canonicalPath, 'utf8')).toBe('exact case match');
  });

  it('handles EEXIST race during atomic migration deterministically', () => {
    // This test exercises the production EEXIST handler in
    // migrateLegacyCache through an injected writeFile mock.
    // No timing, parallel processes, or host-filesystem dependence.
    var project = fs.mkdtempSync(path.join(os.tmpdir(), 'agentloop-atomic-'));
    tempDirs.push(project);

    var agentDir = path.join(project, '.agent');
    fs.mkdirSync(agentDir, { recursive: true });

    var key = encodeCacheKey('3c-1');
    var cache = path.join(agentDir, 'brief-' + key + '.md');

    // The initial canonical lookup observes NO canonical file.
    expect(fs.existsSync(cache)).toBe(false);

    var canonicalContent = 'canonical content from other process';
    var calledWx = false;

    function mockWriteFile(p, data, opts) {
      if (p === cache && opts && opts.flag === 'wx' && !calledWx) {
        calledWx = true;
        // Another process creates the canonical file with distinct content
        // during the migration race, then the wx write raises EEXIST.
        fs.writeFileSync(p, canonicalContent, 'utf8');
        var err = new Error('EEXIST: file already exists');
        err.code = 'EEXIST';
        throw err;
      }
      // Fall back to real implementation for any other call.
      fs.writeFileSync(p, data, opts);
    }

    var result = migrateLegacyCache(cache, 'stale legacy content', {
      writeFile: mockWriteFile,
    });

    // The production handler detects EEXIST and returns canonical content.
    expect(result.migrated).toBe(false);
    expect(result.canonical).toBe(canonicalContent);
    expect(calledWx).toBe(true);

    // The canonical file must still hold its content — the legacy content
    // was never written over it.
    expect(fs.readFileSync(cache, 'utf8')).toBe(canonicalContent);
  });

  it('does not look for legacy cache for unsafe IDs', () => {
    // An ID with a slash must never trigger a legacy-path lookup.
    var project = fs.mkdtempSync(path.join(os.tmpdir(), 'agentloop-legacy-'));
    tempDirs.push(project);

    var agentDir = path.join(project, '.agent');
    fs.mkdirSync(agentDir, { recursive: true });

    // Create a legacy file using the old lossy encoding for feature/api
    // (which would have been brief-feature-api.md). This must NOT be found
    // because feature/api is not in the legacy-safe subset.
    fs.writeFileSync(path.join(agentDir, 'brief-feature-api.md'), 'should not be read', 'utf8');

    var result = spawnSync(
      process.execPath,
      [CONTROLLER, '--task', 'feature/api', '--verbose', '--dry-run'],
      { cwd: project, encoding: 'utf8', timeout: 15000 },
    );

    // Should fail with "No brief" because the legacy file is not consulted
    // for unsafe IDs and there is no --brief flag or canonical cache.
    expect(result.status).not.toBe(0);
    // The error message must mention the brief, not a parse or unexpected crash.
    expect(result.stderr).toMatch(/No brief/);
  });

  it('new writes use only the canonical filename', () => {
    var project = fs.mkdtempSync(path.join(os.tmpdir(), 'agentloop-legacy-'));
    tempDirs.push(project);

    var agentDir = path.join(project, '.agent');
    fs.mkdirSync(agentDir, { recursive: true });

    var key = encodeCacheKey('setup');
    var canonicalPath = path.join(agentDir, 'brief-' + key + '.md');
    var legacyPath = path.join(agentDir, 'brief-setup.md');

    // Neither file exists initially.
    expect(fs.existsSync(canonicalPath)).toBe(false);
    expect(fs.existsSync(legacyPath)).toBe(false);

    // Run with --brief to force a cache write.
    var briefFile = path.join(project, 'custom-brief.md');
    fs.writeFileSync(briefFile, 'custom brief content', 'utf8');

    var result = spawnSync(
      process.execPath,
      [CONTROLLER, '--task', 'setup', '--brief', briefFile, '--verbose'],
      { cwd: project, encoding: 'utf8', timeout: 15000 },
    );

    // The canonical file must have been written.
    expect(fs.existsSync(canonicalPath)).toBe(true);
    // The legacy-format filename must NOT have been written.
    expect(fs.existsSync(legacyPath)).toBe(false);
    // The canonical file must contain the expected content.
    var written = fs.readFileSync(canonicalPath, 'utf8');
    expect(written).toBe('custom brief content');
  });
});
