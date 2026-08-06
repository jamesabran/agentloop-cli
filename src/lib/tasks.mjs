/**
 * Committed task-file handling and deterministic next-task selection.
 *
 * `agentloop.tasks.json` is durable planning data, committed to the target
 * repository. `.agent/` remains disposable, gitignored runtime state.
 *
 * Task selection happens entirely here, in controller-owned code. Claude and
 * Codex never decide which task comes next.
 */

import fs from 'node:fs';
import path from 'node:path';

/* ------------------------------------------------------------------ *
 * Constants                                                           *
 * ------------------------------------------------------------------ */

export const SUPPORTED_VERSION = 1;

export const VALID_STATUSES = new Set([
  'planned',
  'next',
  'in_progress',
  'completed',
  'blocked',
]);

const REQUIRED_TASK_FIELDS = [
  'id',
  'title',
  'status',
  'dependsOn',
  'goal',
  'requirements',
  'exclusions',
];

/**
 * Task identifiers are namespace-safe strings used in git branch names,
 * status-block handoff fields, and (through {@link encodeCacheKey})
 * filesystem paths.
 *
 * Dots, forward slashes, hyphens, and underscores are all permitted in task
 * IDs so that namespaced identifiers such as `release.1` and `feature/api`
 * remain valid. Path traversal is rejected separately by
 * {@link isValidTaskId} rather than by forbidding every dot and slash.
 */
const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._\/#-]{0,127}$/;

/**
 * Return `true` when `id` is a valid task identifier.
 *
 * Valid identifiers start with an alphanumeric character, are at most 128
 * characters long, and contain only `[A-Za-z0-9._/#-]`. In addition, no
 * `/`-delimited segment may be `.` or `..`, which prevents path traversal
 * even if the identifier were ever interpolated directly into a filesystem
 * path.
 *
 * @param {string} id
 * @returns {boolean}
 */
export function isValidTaskId(id) {
  if (typeof id !== 'string' || id.length === 0 || id.length > 128) return false;
  if (!TASK_ID_RE.test(id)) return false;
  // Reject `.` and `..` as path segments (directory traversal).
  return id.split('/').every((s) => s.length > 0 && s !== '.' && s !== '..');
}

/* ------------------------------------------------------------------ *
 * Path resolution                                                     *
 * ------------------------------------------------------------------ */

/**
 * Resolve the configured task-file path against the repository root.
 *
 * Rejects absolute paths, traversal outside the repository, and any path
 * that would resolve outside the repository root.
 *
 * @param {string} configured - value from agentloop.config.json's tasksFile
 * @param {string} repoRoot - absolute repository root
 * @returns {string} absolute path to the task file
 */
export function resolveTaskFilePath(configured, repoRoot) {
  const relative = (configured ?? 'agentloop.tasks.json').trim();
  if (relative.length === 0) {
    throw new Error('The configured task-file path must not be empty.');
  }

  // Reject absolute paths
  if (path.isAbsolute(relative)) {
    throw new Error(
      `The task-file path ${JSON.stringify(relative)} must be relative to the repository root, ` +
        'not an absolute path.',
    );
  }

  // Resolve and check for traversal
  const resolved = path.resolve(repoRoot, relative);
  const normalizedRoot = path.resolve(repoRoot);

  if (!resolved.startsWith(normalizedRoot + path.sep) && resolved !== normalizedRoot) {
    throw new Error(
      `The task-file path ${JSON.stringify(relative)} resolves outside the repository ` +
        `(${normalizedRoot}). Traversal outside the repository is not permitted.`,
    );
  }

  return resolved;
}

/* ------------------------------------------------------------------ *
 * Loading                                                             *
 * ------------------------------------------------------------------ */

/**
 * Read and parse the task file.
 *
 * @param {string} filePath - absolute path to the task file
 * @returns {object} parsed JSON
 */
export function loadTaskFile(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`Task file not found at ${filePath}.`);
    }
    throw new Error(`Could not read task file at ${filePath}: ${error.message}`);
  }

  // Strip a leading UTF-8 BOM (U+FEFF) before parsing. Windows editors
  // such as Notepad sometimes prepend one to UTF-8 files, and JSON.parse
  // rejects it as unexpected content before the opening brace.
  if (raw.length > 0 && raw.charCodeAt(0) === 0xfeff) {
    raw = raw.slice(1);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${filePath} is not valid JSON: ${error.message}`);
  }

  return parsed;
}

/* ------------------------------------------------------------------ *
 * Validation                                                          *
 * ------------------------------------------------------------------ */

/**
 * Validate the entire task file.
 *
 * Checks every constraint before returning validated data. All validation
 * errors are collected so the caller sees the complete set of problems.
 *
 * @param {object} data - parsed JSON from the task file
 * @param {string} filePath - path used in error messages
 * @returns {{ version: number, tasks: object[] }} validated data
 */
export function validateTaskFile(data, filePath) {
  const errors = [];

  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`${filePath} must contain a JSON object.`);
  }

  // Version
  if (typeof data.version !== 'number' || !Number.isInteger(data.version)) {
    throw new Error(
      `${filePath}: "version" must be an integer. Found: ${JSON.stringify(data.version)}.`,
    );
  }
  if (data.version !== SUPPORTED_VERSION) {
    throw new Error(
      `${filePath}: unsupported schema version ${data.version}. ` +
        `This version of AgentLoop supports version ${SUPPORTED_VERSION}.`,
    );
  }

  // Tasks array
  if (!Array.isArray(data.tasks)) {
    throw new Error(
      `${filePath}: "tasks" must be an array. Found: ${JSON.stringify(data.tasks)}.`,
    );
  }

  if (data.tasks.length === 0) {
    throw new Error(`${filePath}: "tasks" must not be empty.`);
  }

  // Per-task validation
  const ids = new Set();
  const taskMap = new Map();

  for (let i = 0; i < data.tasks.length; i += 1) {
    const task = data.tasks[i];
    const prefix = `${filePath}: tasks[${i}]`;

    if (task === null || typeof task !== 'object' || Array.isArray(task)) {
      errors.push(`${prefix} must be an object.`);
      continue;
    }

    // Required fields
    const errorsBeforeTask = errors.length;
    for (const field of REQUIRED_TASK_FIELDS) {
      if (!(field in task)) {
        errors.push(`${prefix} is missing required field "${field}".`);
      }
    }

    // Skip remaining per-field checks for *this* task only when *this*
    // task is missing required fields. An earlier task's errors must not
    // prevent complete field validation of later tasks.
    if (errors.length > errorsBeforeTask) continue;

    // id
    if (typeof task.id !== 'string' || task.id.trim().length === 0) {
      errors.push(`${prefix}: "id" must be a non-empty string.`);
    } else if (!isValidTaskId(task.id)) {
      errors.push(
        `${prefix}: "id" ${JSON.stringify(task.id)} is not a valid task identifier. ` +
          `Must match ${TASK_ID_RE} and contain no "." or ".." path segments.`,
      );
    } else if (ids.has(task.id)) {
      errors.push(`${prefix}: duplicate task ID ${JSON.stringify(task.id)}.`);
    } else {
      ids.add(task.id);
      taskMap.set(task.id, { task, index: i });
    }

    // title
    if (typeof task.title !== 'string' || task.title.trim().length === 0) {
      errors.push(`${prefix}: "title" must be a non-empty string.`);
    }

    // goal
    if (typeof task.goal !== 'string' || task.goal.trim().length === 0) {
      errors.push(`${prefix}: "goal" must be a non-empty string.`);
    }

    // status
    if (typeof task.status !== 'string' || !VALID_STATUSES.has(task.status)) {
      errors.push(
        `${prefix}: "status" must be one of: ${[...VALID_STATUSES].join(', ')}. ` +
          `Found: ${JSON.stringify(task.status)}.`,
      );
    }

    // dependsOn
    if (!Array.isArray(task.dependsOn)) {
      errors.push(`${prefix}: "dependsOn" must be an array.`);
    } else {
      for (let d = 0; d < task.dependsOn.length; d += 1) {
        const dep = task.dependsOn[d];
        if (typeof dep !== 'string' || dep.trim().length === 0) {
          errors.push(`${prefix}: dependsOn[${d}] must be a non-empty string.`);
        }
      }
    }

    // requirements
    if (!Array.isArray(task.requirements)) {
      errors.push(`${prefix}: "requirements" must be an array.`);
    } else {
      for (let r = 0; r < task.requirements.length; r += 1) {
        if (typeof task.requirements[r] !== 'string') {
          errors.push(`${prefix}: requirements[${r}] must be a string.`);
        }
      }
    }

    // exclusions
    if (!Array.isArray(task.exclusions)) {
      errors.push(`${prefix}: "exclusions" must be an array.`);
    } else {
      for (let e = 0; e < task.exclusions.length; e += 1) {
        if (typeof task.exclusions[e] !== 'string') {
          errors.push(`${prefix}: exclusions[${e}] must be a string.`);
        }
      }
    }
  }

  // Cross-task validation: dependencies must reference existing tasks
  for (const [taskId, { task, index }] of taskMap) {
    const prefix = `${filePath}: tasks[${index}] (${JSON.stringify(taskId)})`;
    for (let d = 0; d < task.dependsOn.length; d += 1) {
      const dep = task.dependsOn[d];
      if (typeof dep !== 'string' || dep.trim().length === 0) continue; // already reported
      if (!taskMap.has(dep)) {
        errors.push(`${prefix}: dependsOn ${JSON.stringify(dep)} references a task that does not exist.`);
      } else if (dep === taskId) {
        errors.push(`${prefix}: dependsOn references itself (${JSON.stringify(dep)}).`);
      }
    }
  }

  // Cross-task validation: no dependency cycles
  const cycleErrors = detectCycles(taskMap);
  errors.push(...cycleErrors.map((msg) => `${filePath}: ${msg}`));

  if (errors.length > 0) {
    throw new Error(errors.join('\n'));
  }

  return { version: data.version, tasks: data.tasks };
}

/**
 * Detect dependency cycles using depth-first search.
 *
 * @param {Map<string, { task: object, index: number }>} taskMap
 * @returns {string[]} error messages
 */
function detectCycles(taskMap) {
  const errors = [];
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map();

  for (const id of taskMap.keys()) {
    color.set(id, WHITE);
  }

  function visit(id, stack) {
    color.set(id, GRAY);
    const entry = taskMap.get(id);
    if (!entry) return;

    for (const dep of entry.task.dependsOn) {
      if (typeof dep !== 'string' || dep.trim().length === 0) continue;
      if (!taskMap.has(dep)) continue; // already reported as missing
      const depColor = color.get(dep);
      if (depColor === GRAY) {
        const cycleStart = stack.indexOf(dep);
        const cycle = [...stack.slice(cycleStart), dep];
        errors.push(
          `Dependency cycle detected: ${cycle.map((t) => JSON.stringify(t)).join(' → ')}.`,
        );
      } else if (depColor === WHITE) {
        visit(dep, [...stack, dep]);
      }
    }

    color.set(id, BLACK);
  }

  for (const id of taskMap.keys()) {
    if (color.get(id) === WHITE) {
      visit(id, [id]);
    }
  }

  return errors;
}

/* ------------------------------------------------------------------ *
 * Selection                                                           *
 * ------------------------------------------------------------------ */

/**
 * Select the next task deterministically.
 *
 * Rules (in order):
 * 1. Ignore completed tasks.
 * 2. Ignore blocked tasks.
 * 3. Every dependency must reference an existing task (validated earlier).
 * 4. Every dependency must have status `completed`.
 * 5. Determine all otherwise eligible tasks.
 * 6. Prefer one eligible task marked `next`.
 * 7. Fail when more than one eligible task is marked `next`.
 * 8. When no eligible `next` exists, choose the first eligible `planned`
 *    task in file order.
 * 9. Do not infer completion from ordering.
 * 10. Fail clearly when no eligible task exists.
 *
 * @param {object[]} tasks - validated task array
 * @returns {{ task: object, reason: string }} selected task and eligibility reason
 */
export function selectNextTask(tasks) {
  // Build a map for dependency lookup
  const taskMap = new Map();
  for (const task of tasks) {
    taskMap.set(task.id, task);
  }

  // Filter to eligible tasks
  const eligible = [];

  for (const task of tasks) {
    // Rule 1: skip completed
    if (task.status === 'completed') continue;

    // Rule 2: skip blocked
    if (task.status === 'blocked') continue;

    // Rule 4: all dependencies must be completed
    const incompleteDeps = [];
    for (const depId of task.dependsOn) {
      const dep = taskMap.get(depId);
      if (!dep) {
        // Rule 3: dependency must exist — should have been caught by validation
        incompleteDeps.push({ id: depId, status: 'missing' });
      } else if (dep.status !== 'completed') {
        incompleteDeps.push({ id: depId, status: dep.status });
      }
    }

    if (incompleteDeps.length > 0) {
      continue;
    }

    eligible.push(task);
  }

  // Rule 10: no eligible task
  if (eligible.length === 0) {
    // Build a helpful message listing why each non-completed task is ineligible
    const reasons = [];
    for (const task of tasks) {
      if (task.status === 'completed') continue;
      if (task.status === 'blocked') {
        reasons.push(`${task.id}: status is "blocked"`);
        continue;
      }
      const incompleteDeps = task.dependsOn
        .filter((depId) => {
          const dep = taskMap.get(depId);
          return !dep || dep.status !== 'completed';
        })
        .map((depId) => {
          const dep = taskMap.get(depId);
          return `${depId} (${dep ? dep.status : 'missing'})`;
        });
      if (incompleteDeps.length > 0) {
        reasons.push(`${task.id}: dependencies not completed — ${incompleteDeps.join(', ')}`);
      }
    }
    const detail = reasons.length > 0 ? `\n${reasons.join('\n')}` : '';
    throw new Error(`No eligible task found.${detail}`);
  }

  // Rule 6-7: prefer tasks marked "next"
  const nextTasks = eligible.filter((t) => t.status === 'next');

  if (nextTasks.length > 1) {
    const ids = nextTasks.map((t) => t.id).join(', ');
    throw new Error(
      `Multiple eligible tasks are marked "next": ${ids}. Exactly one eligible task may be marked "next" at a time.`,
    );
  }

  if (nextTasks.length === 1) {
    return {
      task: nextTasks[0],
      reason: `Task ${JSON.stringify(nextTasks[0].id)} is marked "next" and all dependencies are completed.`,
    };
  }

  // Rule 8: fall back to first eligible "planned" task in file order
  const planned = eligible.filter((t) => t.status === 'planned');
  if (planned.length > 0) {
    return {
      task: planned[0],
      reason: `No task is marked "next". Selected first eligible "planned" task ${JSON.stringify(planned[0].id)} in file order.`,
    };
  }

  // Only "in_progress" tasks are eligible but none are "next" or "planned"
  // This shouldn't happen in normal use but is technically possible
  return {
    task: eligible[0],
    reason: `No "next" or "planned" task is eligible. Selected first eligible task ${JSON.stringify(eligible[0].id)} (status: ${eligible[0].status}).`,
  };
}

/**
 * Find a task by ID in the validated task array.
 *
 * @param {object[]} tasks
 * @param {string} id
 * @returns {object|undefined}
 */
export function findTask(tasks, id) {
  return tasks.find((t) => t.id === id);
}

/**
 * Get the dependency statuses for a task.
 *
 * @param {object} task
 * @param {Map<string, object>} taskMap
 * @returns {{ id: string, status: string }[]}
 */
export function dependencyStatuses(task, taskMap) {
  return task.dependsOn.map((depId) => {
    const dep = taskMap.get(depId);
    return { id: depId, status: dep ? dep.status : 'missing' };
  });
}

/* ------------------------------------------------------------------ *
 * Brief generation                                                    *
 * ------------------------------------------------------------------ */

/**
 * Encode a task ID into a path-safe filesystem key.
 *
 * The committed task file's `id` field is validated against
 * {@link TASK_ID_RE} before this function is ever called, but a
 * defence-in-depth encoding here means even a validator bug or a
 * hand-edited state file cannot cause writes outside `.agent/`.
 *
 * Replaces every character that is not alphanumeric or a hyphen with
 * a single hyphen, collapses runs of hyphens, and strips leading and
 * trailing hyphens. The result is guaranteed to contain only
 * `[A-Za-z0-9]` and `-`, with no `..`, `/`, or empty segments.
 *
 * @param {string} taskId
 * @returns {string} path-safe cache key
 */
export function encodeCacheKey(taskId) {
  return String(taskId)
    .replace(/[^A-Za-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-/, '')
    .replace(/-$/, '');
}

/**
 * Generate a runtime implementation brief from a committed task.
 *
 * The generated brief may be cached under `.agent/`, but it must be
 * reproducible from the committed task file and configuration.
 * The cached brief is never the durable source of truth.
 *
 * @param {object} task - the selected task
 * @param {{ id: string, status: string }[]} deps - dependency statuses
 * @param {{ name: string, script: string }[]} checks - configured verification commands
 * @param {number} maxChangeRounds - maximum correction rounds
 * @returns {string} markdown brief
 */
export function generateTaskBrief(task, deps, checks, maxChangeRounds) {
  const lines = [
    `# Task ${task.id}: ${task.title}`,
    '',
    `**Status**: ${task.status}`,
    '',
    '## Goal',
    '',
    task.goal,
  ];

  if (task.requirements.length > 0) {
    lines.push('', '## Requirements', '');
    for (const req of task.requirements) {
      lines.push(`- ${req}`);
    }
  }

  if (task.exclusions.length > 0) {
    lines.push('', '## Explicit Exclusions', '');
    for (const excl of task.exclusions) {
      lines.push(`- ${excl}`);
    }
  }

  if (deps.length > 0) {
    lines.push('', '## Dependencies', '');
    for (const dep of deps) {
      lines.push(`- **${dep.id}**: ${dep.status}`);
    }
  } else {
    lines.push('', '## Dependencies', '', 'None.');
  }

  lines.push(
    '',
    '## Verification',
    '',
    'The controller runs these deterministic checks before every Codex audit:',
    '',
    ...checks.map((c) => `- \`npm run ${c.script}\` (${c.name})`),
    '',
    '## Constraints',
    '',
    `- Maximum correction rounds: ${maxChangeRounds}`,
    '- Every commit must pass deterministic checks before Codex audits it.',
    '- Codex audits the exact local HEAD. Only an approved commit that is still HEAD is ever pushed.',
    '- The controller publishes only what Codex has approved.',
    '',
    '---',
    '',
    `Generated from the committed task file for task ${task.id}. Do not edit this cached copy; ` +
      'the committed file is the durable source of truth.',
  );

  return lines.join('\n');
}
