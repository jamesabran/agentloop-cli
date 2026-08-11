// @vitest-environment node
/**
 * Task-file loading, validation, deterministic selection, and brief generation.
 *
 * The committed task file is durable planning data. Every validation error must
 * be caught before any branch, state, or agent mutation occurs.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  dependencyStatuses,
  encodeCacheKey,
  findTask,
  generateTaskBrief,
  isLegacySafeTaskId,
  isValidTaskId,
  loadTaskFile,
  resolveTaskFilePath,
  selectNextTask,
  SUPPORTED_VERSION,
  validateTaskFile,
} from './tasks.mjs';

const tempDirs = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentloop-tasks-'));
  tempDirs.push(dir);
  return dir;
}

function writeTaskFile(repoDir, content, filename = 'agentloop.tasks.json') {
  const filePath = path.join(repoDir, filename);
  fs.writeFileSync(filePath, JSON.stringify(content, null, 2), 'utf8');
  return filePath;
}

/* ------------------------------------------------------------------ *
 * Helpers for test tasks                                              *
 * ------------------------------------------------------------------ */

function validTasks() {
  return [
    {
      id: 'setup',
      title: 'Project setup',
      status: 'completed',
      dependsOn: [],
      goal: 'Set up the project.',
      requirements: ['Initialise repo'],
      exclusions: ['CI configuration'],
    },
    {
      id: '3c-1',
      title: 'First feature',
      status: 'next',
      dependsOn: ['setup'],
      goal: 'Implement the first feature.',
      requirements: ['Feature A', 'Tests'],
      exclusions: ['Documentation'],
    },
    {
      id: '3c-2',
      title: 'Second feature',
      status: 'planned',
      dependsOn: ['setup'],
      goal: 'Implement the second feature.',
      requirements: ['Feature B'],
      exclusions: ['Performance tuning'],
    },
  ];
}

/* ------------------------------------------------------------------ *
 * Path resolution                                                     *
 * ------------------------------------------------------------------ */

describe('resolveTaskFilePath', () => {
  it('uses the default path when none is configured', () => {
    const repo = makeRepo();
    const resolved = resolveTaskFilePath(undefined, repo);
    expect(resolved).toBe(path.join(repo, 'agentloop.tasks.json'));
  });

  it('uses a configured relative path', () => {
    const repo = makeRepo();
    const resolved = resolveTaskFilePath('custom/tasks.json', repo);
    expect(resolved).toBe(path.join(repo, 'custom/tasks.json'));
  });

  it('rejects an absolute path', () => {
    const repo = makeRepo();
    expect(() => resolveTaskFilePath('/etc/tasks.json', repo)).toThrow(/absolute path/);
    expect(() => resolveTaskFilePath('C:\\tasks.json', repo)).toThrow(/absolute path/);
  });

  it('rejects Windows absolute paths regardless of the host OS', () => {
    const repo = makeRepo();
    // Forward-slash variant of a drive-letter path.
    expect(() => resolveTaskFilePath('C:/tasks.json', repo)).toThrow(/absolute path/);
    // Lower-case drive letter.
    expect(() => resolveTaskFilePath('d:\\path\\to\\tasks.json', repo)).toThrow(/absolute path/);
  });

  it('rejects Windows UNC paths regardless of the host OS', () => {
    const repo = makeRepo();
    expect(() => resolveTaskFilePath('\\\\server\\share\\tasks.json', repo)).toThrow(/absolute path/);
    expect(() => resolveTaskFilePath('//server/share/tasks.json', repo)).toThrow(/absolute path/);
  });

  it('does not reject drive-relative paths (C:file — not absolute on any platform)', () => {
    const repo = makeRepo();
    // A drive-relative path like C:file.txt is NOT absolute on Windows — it
    // resolves relative to the current directory on that drive.  Only
    // C:\...  or C:/...  is absolute.
    const resolved = resolveTaskFilePath('C:relative-tasks.json', repo);
    // On Windows this would be resolved against the repo root (harmless).
    // The key property is the function does not throw.
    expect(resolved).toBe(path.resolve(repo, 'C:relative-tasks.json'));
  });

  it('rejects a path that traverses outside the repository', () => {
    const repo = makeRepo();
    expect(() => resolveTaskFilePath('../../../etc/tasks.json', repo)).toThrow(
      /outside the repository/,
    );
  });

  it('rejects an empty path', () => {
    const repo = makeRepo();
    expect(() => resolveTaskFilePath('', repo)).toThrow(/must not be empty/);
  });
});

/* ------------------------------------------------------------------ *
 * Loading                                                             *
 * ------------------------------------------------------------------ */

describe('loadTaskFile', () => {
  it('loads and parses a valid task file', () => {
    const repo = makeRepo();
    const filePath = writeTaskFile(repo, { version: 1, tasks: validTasks() });
    const data = loadTaskFile(filePath);
    expect(data.version).toBe(1);
    expect(data.tasks.length).toBe(3);
  });

  it('throws when the file is missing', () => {
    const repo = makeRepo();
    expect(() => loadTaskFile(path.join(repo, 'nonexistent.json'))).toThrow(/not found/);
  });

  it('throws on invalid JSON', () => {
    const repo = makeRepo();
    const filePath = path.join(repo, 'tasks.json');
    fs.writeFileSync(filePath, 'not json {{{', 'utf8');
    expect(() => loadTaskFile(filePath)).toThrow(/not valid JSON/);
  });

  it('parses a UTF-8 BOM-prefixed task file', () => {
    const repo = makeRepo();
    const tasks = validTasks();
    const filePath = path.join(repo, 'agentloop.tasks.json');
    // Write the file with a leading UTF-8 BOM (U+FEFF)
    const content = JSON.stringify({ version: 1, tasks }, null, 2);
    fs.writeFileSync(filePath, '﻿' + content, 'utf8');
    const data = loadTaskFile(filePath);
    expect(data.version).toBe(1);
    expect(data.tasks.length).toBe(3);
    // Verify validation also passes
    const validated = validateTaskFile(data, filePath);
    expect(validated.version).toBe(1);
  });
});

/* ------------------------------------------------------------------ *
 * Validation                                                          *
 * ------------------------------------------------------------------ */

describe('validateTaskFile — happy path', () => {
  it('accepts a valid task file', () => {
    const repo = makeRepo();
    const filePath = writeTaskFile(repo, { version: 1, tasks: validTasks() });
    const data = loadTaskFile(filePath);
    const validated = validateTaskFile(data, filePath);
    expect(validated.version).toBe(1);
    expect(validated.tasks.length).toBe(3);
  });
});

describe('validateTaskFile — structure', () => {
  it('rejects null data', () => {
    const repo = makeRepo();
    expect(() => validateTaskFile(null, path.join(repo, 'x.json'))).toThrow(/JSON object/);
  });

  it('rejects an array at the root', () => {
    const repo = makeRepo();
    expect(() => validateTaskFile([], path.join(repo, 'x.json'))).toThrow(/JSON object/);
  });

  it('rejects a non-integer version', () => {
    const repo = makeRepo();
    const filePath = writeTaskFile(repo, { version: '1', tasks: [] });
    expect(() => validateTaskFile(loadTaskFile(filePath), filePath)).toThrow(/version/);
  });

  it('rejects an unsupported version', () => {
    const repo = makeRepo();
    const filePath = writeTaskFile(repo, { version: 999, tasks: [] });
    expect(() => validateTaskFile(loadTaskFile(filePath), filePath)).toThrow(
      /unsupported schema version/,
    );
  });

  it('rejects a non-array tasks field', () => {
    const repo = makeRepo();
    const filePath = writeTaskFile(repo, { version: 1, tasks: 'not-an-array' });
    expect(() => validateTaskFile(loadTaskFile(filePath), filePath)).toThrow(
      /must be an array/,
    );
  });

  it('rejects an empty tasks array', () => {
    const repo = makeRepo();
    const filePath = writeTaskFile(repo, { version: 1, tasks: [] });
    expect(() => validateTaskFile(loadTaskFile(filePath), filePath)).toThrow(/must not be empty/);
  });
});

describe('validateTaskFile — task-level validation', () => {
  it('rejects duplicate task IDs', () => {
    const repo = makeRepo();
    const tasks = [
      { id: 'dup', title: 'A', status: 'planned', dependsOn: [], goal: 'G', requirements: [], exclusions: [] },
      { id: 'dup', title: 'B', status: 'planned', dependsOn: [], goal: 'G', requirements: [], exclusions: [] },
    ];
    const filePath = writeTaskFile(repo, { version: 1, tasks });
    expect(() => validateTaskFile(loadTaskFile(filePath), filePath)).toThrow(/duplicate/);
  });

  it('rejects a missing task ID', () => {
    const repo = makeRepo();
    const tasks = [{ title: 'No ID', status: 'planned', dependsOn: [], goal: 'G', requirements: [], exclusions: [] }];
    const filePath = writeTaskFile(repo, { version: 1, tasks });
    expect(() => validateTaskFile(loadTaskFile(filePath), filePath)).toThrow(/missing required field "id"/);
  });

  it('rejects an invalid task ID', () => {
    const repo = makeRepo();
    const tasks = [{ id: '', title: 'T', status: 'planned', dependsOn: [], goal: 'G', requirements: [], exclusions: [] }];
    const filePath = writeTaskFile(repo, { version: 1, tasks });
    expect(() => validateTaskFile(loadTaskFile(filePath), filePath)).toThrow(/"id" must be a non-empty string/);
  });

  it('accepts a task ID containing a dot (e.g. release.1)', () => {
    const repo = makeRepo();
    const tasks = [
      { id: 'release.1', title: 'T', status: 'planned', dependsOn: [], goal: 'G', requirements: [], exclusions: [] },
    ];
    const filePath = writeTaskFile(repo, { version: 1, tasks });
    const validated = validateTaskFile(loadTaskFile(filePath), filePath);
    expect(validated.tasks[0].id).toBe('release.1');
  });

  it('accepts a task ID containing a slash (e.g. feature/api)', () => {
    const repo = makeRepo();
    const tasks = [
      { id: 'feature/api', title: 'T', status: 'planned', dependsOn: [], goal: 'G', requirements: [], exclusions: [] },
    ];
    const filePath = writeTaskFile(repo, { version: 1, tasks });
    const validated = validateTaskFile(loadTaskFile(filePath), filePath);
    expect(validated.tasks[0].id).toBe('feature/api');
  });

  it('rejects a task ID containing a ".." path-traversal segment', () => {
    const repo = makeRepo();
    const tasks = [{ id: 'x/../../escaped', title: 'T', status: 'planned', dependsOn: [], goal: 'G', requirements: [], exclusions: [] }];
    const filePath = writeTaskFile(repo, { version: 1, tasks });
    expect(() => validateTaskFile(loadTaskFile(filePath), filePath)).toThrow(/not a valid task identifier/);
  });

  it('rejects a task ID containing a "." path-traversal segment', () => {
    const repo = makeRepo();
    const tasks = [{ id: 'x/./escaped', title: 'T', status: 'planned', dependsOn: [], goal: 'G', requirements: [], exclusions: [] }];
    const filePath = writeTaskFile(repo, { version: 1, tasks });
    expect(() => validateTaskFile(loadTaskFile(filePath), filePath)).toThrow(/not a valid task identifier/);
  });

  it('rejects a task ID containing an empty segment (//)', () => {
    const repo = makeRepo();
    const tasks = [{ id: 'x//y', title: 'T', status: 'planned', dependsOn: [], goal: 'G', requirements: [], exclusions: [] }];
    const filePath = writeTaskFile(repo, { version: 1, tasks });
    expect(() => validateTaskFile(loadTaskFile(filePath), filePath)).toThrow(/not a valid task identifier/);
  });

  it('rejects a missing title', () => {
    const repo = makeRepo();
    const tasks = [{ id: 't1', status: 'planned', dependsOn: [], goal: 'G', requirements: [], exclusions: [] }];
    const filePath = writeTaskFile(repo, { version: 1, tasks });
    expect(() => validateTaskFile(loadTaskFile(filePath), filePath)).toThrow(/missing required field "title"/);
  });

  it('rejects a missing goal', () => {
    const repo = makeRepo();
    const tasks = [{ id: 't1', title: 'T', status: 'planned', dependsOn: [], requirements: [], exclusions: [] }];
    const filePath = writeTaskFile(repo, { version: 1, tasks });
    expect(() => validateTaskFile(loadTaskFile(filePath), filePath)).toThrow(/missing required field "goal"/);
  });

  it('rejects an invalid status', () => {
    const repo = makeRepo();
    const tasks = [{ id: 't1', title: 'T', status: 'invalid-status', dependsOn: [], goal: 'G', requirements: [], exclusions: [] }];
    const filePath = writeTaskFile(repo, { version: 1, tasks });
    expect(() => validateTaskFile(loadTaskFile(filePath), filePath)).toThrow(/status/);
  });

  it('rejects a non-array dependsOn', () => {
    const repo = makeRepo();
    const tasks = [{ id: 't1', title: 'T', status: 'planned', dependsOn: 'not-array', goal: 'G', requirements: [], exclusions: [] }];
    const filePath = writeTaskFile(repo, { version: 1, tasks });
    expect(() => validateTaskFile(loadTaskFile(filePath), filePath)).toThrow(/must be an array/);
  });

  it('rejects a dependency entry that is not a string', () => {
    const repo = makeRepo();
    const tasks = [{ id: 't1', title: 'T', status: 'planned', dependsOn: [42], goal: 'G', requirements: [], exclusions: [] }];
    const filePath = writeTaskFile(repo, { version: 1, tasks });
    expect(() => validateTaskFile(loadTaskFile(filePath), filePath)).toThrow(/must be a non-empty string/);
  });

  it('rejects a dependency on a non-existent task', () => {
    const repo = makeRepo();
    const tasks = [{ id: 't1', title: 'T', status: 'planned', dependsOn: ['nonexistent'], goal: 'G', requirements: [], exclusions: [] }];
    const filePath = writeTaskFile(repo, { version: 1, tasks });
    expect(() => validateTaskFile(loadTaskFile(filePath), filePath)).toThrow(/does not exist/);
  });

  it('rejects a self-dependency', () => {
    const repo = makeRepo();
    const tasks = [{ id: 't1', title: 'T', status: 'planned', dependsOn: ['t1'], goal: 'G', requirements: [], exclusions: [] }];
    const filePath = writeTaskFile(repo, { version: 1, tasks });
    expect(() => validateTaskFile(loadTaskFile(filePath), filePath)).toThrow(/references itself/);
  });

  it('rejects a dependency cycle', () => {
    const repo = makeRepo();
    const tasks = [
      { id: 'a', title: 'A', status: 'planned', dependsOn: ['b'], goal: 'G', requirements: [], exclusions: [] },
      { id: 'b', title: 'B', status: 'planned', dependsOn: ['c'], goal: 'G', requirements: [], exclusions: [] },
      { id: 'c', title: 'C', status: 'planned', dependsOn: ['a'], goal: 'G', requirements: [], exclusions: [] },
    ];
    const filePath = writeTaskFile(repo, { version: 1, tasks });
    expect(() => validateTaskFile(loadTaskFile(filePath), filePath)).toThrow(/cycle/);
  });

  it('rejects a longer dependency cycle', () => {
    const repo = makeRepo();
    const tasks = [
      { id: 'a', title: 'A', status: 'planned', dependsOn: ['d'], goal: 'G', requirements: [], exclusions: [] },
      { id: 'b', title: 'B', status: 'planned', dependsOn: ['a'], goal: 'G', requirements: [], exclusions: [] },
      { id: 'c', title: 'C', status: 'planned', dependsOn: ['b'], goal: 'G', requirements: [], exclusions: [] },
      { id: 'd', title: 'D', status: 'planned', dependsOn: ['c'], goal: 'G', requirements: [], exclusions: [] },
    ];
    const filePath = writeTaskFile(repo, { version: 1, tasks });
    expect(() => validateTaskFile(loadTaskFile(filePath), filePath)).toThrow(/cycle/);
  });

  it('rejects invalid requirements (non-array)', () => {
    const repo = makeRepo();
    const tasks = [{ id: 't1', title: 'T', status: 'planned', dependsOn: [], goal: 'G', requirements: 'not-array', exclusions: [] }];
    const filePath = writeTaskFile(repo, { version: 1, tasks });
    expect(() => validateTaskFile(loadTaskFile(filePath), filePath)).toThrow(/must be an array/);
  });

  it('rejects invalid exclusions (non-array)', () => {
    const repo = makeRepo();
    const tasks = [{ id: 't1', title: 'T', status: 'planned', dependsOn: [], goal: 'G', requirements: [], exclusions: 'not-array' }];
    const filePath = writeTaskFile(repo, { version: 1, tasks });
    expect(() => validateTaskFile(loadTaskFile(filePath), filePath)).toThrow(/must be an array/);
  });

  it('reports multiple errors at once', () => {
    const repo = makeRepo();
    const tasks = [
      { id: 'dup', title: '', status: 'bad', dependsOn: [42], goal: '', requirements: 'x', exclusions: 'y' },
      { id: 'dup', title: '', status: 'bad', dependsOn: [], goal: '', requirements: [], exclusions: [] },
    ];
    const filePath = writeTaskFile(repo, { version: 1, tasks });
    expect(() => validateTaskFile(loadTaskFile(filePath), filePath)).toThrow(/duplicate/);
  });

  it('validates later tasks fully even when an earlier task has errors', () => {
    const repo = makeRepo();
    const tasks = [
      // First task missing required fields — should not block validation of the second
      { id: 'bad', title: 'Bad', status: 'planned', dependsOn: [], goal: '', requirements: [], exclusions: [] },
      // Second task has a non-existent dependency — should still be caught
      { id: 'good', title: 'Good', status: 'planned', dependsOn: ['nonexistent'], goal: 'G', requirements: [], exclusions: [] },
    ];
    const filePath = writeTaskFile(repo, { version: 1, tasks });
    expect(() => validateTaskFile(loadTaskFile(filePath), filePath)).toThrow(/does not exist/);
  });

  it('validates later tasks even when an earlier task is missing required fields', () => {
    const repo = makeRepo();
    const tasks = [
      // First task is missing "goal" and "requirements" entirely — triggers the
      // per-field skip for task[0] but must not block task[1] validation.
      { id: 'incomplete', title: 'Incomplete', status: 'planned', dependsOn: [], exclusions: [] },
      // Second task has an invalid status — must still be caught.
      { id: 'second', title: 'Second', status: 'not-a-status', dependsOn: [], goal: 'G', requirements: [], exclusions: [] },
    ];
    const filePath = writeTaskFile(repo, { version: 1, tasks });
    let message;
    try {
      validateTaskFile(loadTaskFile(filePath), filePath);
    } catch (error) {
      message = error.message;
    }
    // Task 0 missing-field errors must be present
    expect(message).toMatch(/missing required field "goal"/);
    // Task 1 status error must also be present — proves later tasks are validated
    expect(message).toMatch(/must be one of/);
  });
});

/* ------------------------------------------------------------------ *
 * Selection                                                           *
 * ------------------------------------------------------------------ */

describe('selectNextTask', () => {
  it('selects an eligible task marked "next"', () => {
    const result = selectNextTask(validTasks());
    expect(result.task.id).toBe('3c-1');
    expect(result.reason).toMatch(/marked "next"/);
  });

  it('falls back to the first eligible "planned" task when no "next" exists', () => {
    const tasks = [
      { id: 'setup', title: 'S', status: 'completed', dependsOn: [], goal: 'G', requirements: [], exclusions: [] },
      { id: 'a', title: 'A', status: 'planned', dependsOn: ['setup'], goal: 'G', requirements: [], exclusions: [] },
      { id: 'b', title: 'B', status: 'planned', dependsOn: ['setup'], goal: 'G', requirements: [], exclusions: [] },
    ];
    const result = selectNextTask(tasks);
    expect(result.task.id).toBe('a');
    expect(result.reason).toMatch(/file order/);
  });

  it('skips completed tasks', () => {
    const tasks = [
      { id: 'done', title: 'D', status: 'completed', dependsOn: [], goal: 'G', requirements: [], exclusions: [] },
    ];
    expect(() => selectNextTask(tasks)).toThrow(/No eligible task/);
  });

  it('skips blocked tasks', () => {
    const tasks = [
      { id: 'stuck', title: 'S', status: 'blocked', dependsOn: [], goal: 'G', requirements: [], exclusions: [] },
      { id: 'next-one', title: 'N', status: 'planned', dependsOn: [], goal: 'G', requirements: [], exclusions: [] },
    ];
    const result = selectNextTask(tasks);
    expect(result.task.id).toBe('next-one');
  });

  it('skips tasks with incomplete dependencies', () => {
    const tasks = [
      { id: 'dep', title: 'D', status: 'planned', dependsOn: [], goal: 'G', requirements: [], exclusions: [] },
      { id: 'child', title: 'C', status: 'next', dependsOn: ['dep'], goal: 'G', requirements: [], exclusions: [] },
    ];
    // dep is not completed, so child is ineligible despite "next" status
    // fallback: dep is planned and has no deps → eligible
    const result = selectNextTask(tasks);
    expect(result.task.id).toBe('dep');
  });

  it('rejects multiple eligible "next" tasks', () => {
    const tasks = [
      { id: 'a', title: 'A', status: 'next', dependsOn: [], goal: 'G', requirements: [], exclusions: [] },
      { id: 'b', title: 'B', status: 'next', dependsOn: [], goal: 'G', requirements: [], exclusions: [] },
    ];
    expect(() => selectNextTask(tasks)).toThrow(/Multiple eligible tasks are marked "next"/);
  });

  it('rejects when no eligible task exists', () => {
    const tasks = [
      { id: 'a', title: 'A', status: 'blocked', dependsOn: [], goal: 'G', requirements: [], exclusions: [] },
      { id: 'b', title: 'B', status: 'completed', dependsOn: [], goal: 'G', requirements: [], exclusions: [] },
    ];
    expect(() => selectNextTask(tasks)).toThrow(/No eligible task/);
  });

  it('proves selection is deterministic (file order)', () => {
    const tasks = [
      { id: 'z', title: 'Z', status: 'planned', dependsOn: [], goal: 'G', requirements: [], exclusions: [] },
      { id: 'a', title: 'A', status: 'planned', dependsOn: [], goal: 'G', requirements: [], exclusions: [] },
    ];
    // Run multiple times to prove determinism
    for (let i = 0; i < 10; i += 1) {
      const result = selectNextTask(tasks);
      expect(result.task.id).toBe('z');
    }
  });

  it('requires dependencies to be explicitly completed', () => {
    const tasks = [
      { id: 'dep', title: 'D', status: 'next', dependsOn: [], goal: 'G', requirements: [], exclusions: [] },
      { id: 'child', title: 'C', status: 'next', dependsOn: ['dep'], goal: 'G', requirements: [], exclusions: [] },
    ];
    // dep is "next" and has no deps → eligible. child depends on dep which is
    // "next" not "completed" → ineligible. So dep is selected (only eligible
    // "next"). Multiple eligible "next" is not triggered because child is
    // ineligible.
    const result = selectNextTask(tasks);
    expect(result.task.id).toBe('dep');
  });
});

/* ------------------------------------------------------------------ *
 * Brief generation                                                    *
 * ------------------------------------------------------------------ */

describe('generateTaskBrief', () => {
  it('includes the task ID, title, goal, requirements, and exclusions', () => {
    const task = {
      id: 'test-1',
      title: 'Test Task',
      status: 'next',
      dependsOn: [],
      goal: 'Implement the test.',
      requirements: ['Req 1', 'Req 2'],
      exclusions: ['Excl 1'],
    };
    const checks = [{ name: 'test', script: 'test' }];
    const brief = generateTaskBrief(task, [], checks, 2);
    expect(brief).toMatch(/# Task test-1: Test Task/);
    expect(brief).toMatch(/Implement the test\./);
    expect(brief).toMatch(/- Req 1/);
    expect(brief).toMatch(/- Excl 1/);
    expect(brief).toMatch(/npm run test/);
    expect(brief).toMatch(/Maximum correction rounds: 2/);
    expect(brief).toMatch(/committed task file/);
  });

  it('includes dependency statuses when present', () => {
    const task = validTasks()[1]; // 3c-1
    const deps = [{ id: 'setup', status: 'completed' }];
    const brief = generateTaskBrief(task, deps, [], 2);
    expect(brief).toMatch(/- \*\*setup\*\*: completed/);
  });

  it('reports no dependencies when the list is empty', () => {
    const task = { id: 't', title: 'T', status: 'planned', dependsOn: [], goal: 'G', requirements: [], exclusions: [] };
    const brief = generateTaskBrief(task, [], [], 2);
    expect(brief).toMatch(/None\./);
  });
});

/* ------------------------------------------------------------------ *
 * Helpers                                                             *
 * ------------------------------------------------------------------ */

describe('findTask', () => {
  it('finds a task by ID', () => {
    const tasks = validTasks();
    expect(findTask(tasks, '3c-1')?.title).toBe('First feature');
  });

  it('returns undefined for a missing task', () => {
    expect(findTask(validTasks(), 'nonexistent')).toBeUndefined();
  });
});

describe('dependencyStatuses', () => {
  it('returns status for each dependency', () => {
    const tasks = validTasks();
    const taskMap = new Map(tasks.map((t) => [t.id, t]));
    const statuses = dependencyStatuses(tasks[1], taskMap);
    expect(statuses).toEqual([{ id: 'setup', status: 'completed' }]);
  });

  it('reports missing for an unknown dependency', () => {
    const tasks = validTasks();
    const taskMap = new Map(tasks.map((t) => [t.id, t]));
    const task = { ...tasks[1], dependsOn: ['nonexistent'] };
    const statuses = dependencyStatuses(task, taskMap);
    expect(statuses).toEqual([{ id: 'nonexistent', status: 'missing' }]);
  });
});

/* ------------------------------------------------------------------ *
 * Cache key encoding                                                  *
 * ------------------------------------------------------------------ */

describe('encodeCacheKey', () => {
  it('produces deterministic fixed-width hex keys', () => {
    // Each UTF-16 code unit → exactly 4 lowercase hex digits.
    expect(encodeCacheKey('3c-1')).toBe('00330063002d0031');
    expect(encodeCacheKey('setup')).toBe('00730065007400750070');
    expect(encodeCacheKey('feature-a')).toBe('0066006500610074007500720065002d0061');
  });

  it('is injective — distinct task IDs produce distinct keys', () => {
    // Collision regression: the old variable-width encoding mapped both
    // "⍅" and "ģE" to "012345".
    var a = encodeCacheKey('⍅');
    var b = encodeCacheKey('ģE');
    expect(a).not.toBe(b);
    expect(a).toBe('00012345');
    expect(b).toBe('01230045');

    // Original collision case: feature/api vs feature.api
    var slashKey = encodeCacheKey('feature/api');
    var dotKey = encodeCacheKey('feature.api');
    expect(slashKey).not.toBe(dotKey);
    expect(slashKey).toMatch(/002f/); // '/' is U+002F
    expect(dotKey).toMatch(/002e/);  // '.' is U+002E
  });

  it('distinguishes other punctuation combinations', () => {
    var pairs = [
      ['task#1', 'task-1'],
      ['a.b', 'a-b'],
      ['x_y', 'x-y'],
      ['ns/task', 'ns-task'],
    ];
    for (var pi = 0; pi < pairs.length; pi++) {
      var a = pairs[pi][0];
      var b = pairs[pi][1];
      expect(encodeCacheKey(a), a + ' vs ' + b).not.toBe(encodeCacheKey(b));
    }
  });

  it('handles Unicode including surrogate pairs', () => {
    // BMP character (U+00E9 é = code unit 0x00e9)
    var key = encodeCacheKey('café');
    expect(key).toMatch(/^[0-9a-f]+$/);
    expect(key).toContain('00e9');

    // Supplementary-plane character (U+1F600 😀 = surrogate pair D83D DE00)
    var emoji = encodeCacheKey('\u{1F600}');
    expect(emoji).toMatch(/^[0-9a-f]+$/);
    expect(emoji).toBe('d83dde00');
    expect(emoji).not.toBe(encodeCacheKey('\u{1F601}')); // different emoji

    // Fixed-width: each code unit is exactly 4 hex digits
    expect(emoji.length).toBe(8); // 2 code units × 4 digits
  });

  it('contains only lowercase hex digits', () => {
    var key = encodeCacheKey('x/../../escaped!@#$%^&*()');
    expect(key).toMatch(/^[0-9a-f]*$/);
    expect(key).not.toBe('');
  });

  it('handles traversal-shaped input safely', () => {
    var key = encodeCacheKey('x/../../escaped');
    expect(key).not.toMatch(/\.\./);
    expect(key).not.toMatch(/\//);
    expect(key).toMatch(/^[0-9a-f]+$/);
  });

  it('handles an empty string', () => {
    expect(encodeCacheKey('')).toBe('');
  });
});

/* ------------------------------------------------------------------ *
 * Task-ID validation                                                  *
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * Legacy-safe task ID subset                                          *
 * ------------------------------------------------------------------ */

describe('isLegacySafeTaskId', () => {
  it('accepts simple alphanumeric IDs used by existing installations', () => {
    expect(isLegacySafeTaskId('3c-1')).toBe(true);
    expect(isLegacySafeTaskId('setup')).toBe(true);
    expect(isLegacySafeTaskId('5')).toBe(true);
    expect(isLegacySafeTaskId('agent-task-42')).toBe(true);
    expect(isLegacySafeTaskId('fix-bug-123')).toBe(true);
  });

  it('rejects IDs containing dots', () => {
    // Dots collapse to hyphens under the legacy encoder, so legacy-safe
    // must be false (collision risk: a.b → a-b, which is another valid ID).
    expect(isLegacySafeTaskId('release.1')).toBe(false);
    expect(isLegacySafeTaskId('feature.api')).toBe(false);
  });

  it('rejects IDs containing slashes', () => {
    // Slashes collapse to hyphens; also path-traversal risk.
    expect(isLegacySafeTaskId('feature/api')).toBe(false);
    expect(isLegacySafeTaskId('ns/task')).toBe(false);
  });

  it('rejects IDs with consecutive hyphens', () => {
    // 'task--v2' and 'task-v2' would collide (both → task-v2).
    expect(isLegacySafeTaskId('task--v2')).toBe(false);
  });

  it('rejects IDs with leading or trailing hyphens', () => {
    expect(isLegacySafeTaskId('-task')).toBe(false);
    expect(isLegacySafeTaskId('task-')).toBe(false);
  });

  it('rejects IDs with other punctuation', () => {
    expect(isLegacySafeTaskId('task#1')).toBe(false);
    expect(isLegacySafeTaskId('a_b')).toBe(false);
  });

  it('rejects non-strings', () => {
    expect(isLegacySafeTaskId(null)).toBe(false);
    expect(isLegacySafeTaskId(undefined)).toBe(false);
    expect(isLegacySafeTaskId(42)).toBe(false);
    expect(isLegacySafeTaskId('')).toBe(false);
  });
});

describe('isValidTaskId', () => {
  it('accepts simple alphanumeric IDs', () => {
    expect(isValidTaskId('3c-1')).toBe(true);
    expect(isValidTaskId('setup')).toBe(true);
  });

  it('accepts dotted IDs (e.g. release.1)', () => {
    expect(isValidTaskId('release.1')).toBe(true);
  });

  it('accepts slashed IDs (e.g. feature/api)', () => {
    expect(isValidTaskId('feature/api')).toBe(true);
  });

  it('rejects empty string', () => {
    expect(isValidTaskId('')).toBe(false);
  });

  it('rejects IDs longer than 128 characters', () => {
    expect(isValidTaskId('a'.repeat(129))).toBe(false);
  });

  it('accepts IDs at the 128-character limit', () => {
    expect(isValidTaskId('a'.repeat(128))).toBe(true);
  });

  it('rejects ".." as a path-traversal segment', () => {
    expect(isValidTaskId('x/../escaped')).toBe(false);
    expect(isValidTaskId('x/../../escaped')).toBe(false);
  });

  it('rejects "." as a path-traversal segment', () => {
    expect(isValidTaskId('x/./escaped')).toBe(false);
  });

  it('rejects an empty path segment (//)', () => {
    expect(isValidTaskId('x//y')).toBe(false);
  });

  it('rejects a leading slash', () => {
    expect(isValidTaskId('/leading')).toBe(false);
  });

  it('rejects a trailing slash', () => {
    expect(isValidTaskId('trailing/')).toBe(false);
  });

  it('rejects characters outside the allowed set', () => {
    expect(isValidTaskId('bad id')).toBe(false);
    expect(isValidTaskId('bad@id')).toBe(false);
    expect(isValidTaskId('bad?id')).toBe(false);
  });

  it('rejects null and non-strings', () => {
    expect(isValidTaskId(null)).toBe(false);
    expect(isValidTaskId(undefined)).toBe(false);
    expect(isValidTaskId(42)).toBe(false);
  });
});
