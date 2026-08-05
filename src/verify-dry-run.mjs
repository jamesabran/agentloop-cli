#!/usr/bin/env node
/**
 * Prove that a dry run mutates nothing.
 *
 * Snapshots the repository — tracked files, gitignored ones, and git's own
 * porcelain status — runs `controller.mjs --dry-run` as a real child process,
 * then snapshots again and diffs. Any created, deleted, resized, or re-written
 * file fails the check.
 *
 * `node src/verify-dry-run.mjs` (or `npm run agent:verify-dry-run`).
 * The dry run is local: it reports the next step it would take and starts no
 * agent, runs no check, writes no state, and pushes nothing.
 */

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');

/** Skipped because they are large and provably untouched by the controller. */
const SKIP = new Set(['node_modules', '.git', 'dist', 'coverage']);

/**
 * Hash every file under a directory, including gitignored ones — the log and
 * state directories the controller owns are exactly what must not change.
 */
function snapshot(dir, base = dir, into = new Map()) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return into;
  }

  for (const entry of entries) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    const relative = path.relative(base, full).split(path.sep).join('/');

    if (entry.isDirectory()) {
      into.set(`${relative}/`, 'dir');
      snapshot(full, base, into);
    } else if (entry.isFile()) {
      try {
        const content = fs.readFileSync(full);
        into.set(relative, crypto.createHash('sha256').update(content).digest('hex'));
      } catch {
        into.set(relative, 'unreadable');
      }
    }
  }

  return into;
}

function gitStatus() {
  const result = spawnSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return result.status === 0 ? result.stdout : `git status failed: ${result.stderr}`;
}

function diff(before, after) {
  const problems = [];

  for (const [file, hash] of after) {
    if (!before.has(file)) problems.push(`created: ${file}`);
    else if (before.get(file) !== hash) problems.push(`modified: ${file}`);
  }

  for (const file of before.keys()) {
    if (!after.has(file)) problems.push(`deleted: ${file}`);
  }

  return problems;
}

const args = process.argv.slice(2);
const selfCheck = args.includes('--self-check');

/**
 * A dry run with no task decides nothing, so it would prove nothing. The probe
 * below drives the real path — select a task, resolve its brief, work out the
 * next step — from a brief written outside the repository, so the only thing
 * that could change inside it is something the dry run wrote.
 */
const briefDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentloop-dry-run-'));
const briefFile = path.join(briefDir, 'brief.md');
fs.writeFileSync(briefFile, 'Probe task for the dry-run non-mutation check.\n', 'utf8');

const controllerArgs = selfCheck
  ? ['--self-check']
  : ['--dry-run', '--task', 'dry-run-probe', '--brief', briefFile, '--verbose'];

process.stdout.write(
  `Verifying that "controller.mjs ${controllerArgs.join(' ')}" mutates nothing.\n\n`,
);

const before = snapshot(REPO_ROOT);
const statusBefore = gitStatus();

const run = spawnSync(process.execPath, [path.join(HERE, 'controller.mjs'), ...controllerArgs], {
  cwd: REPO_ROOT,
  encoding: 'utf8',
});

process.stdout.write('--- controller output ---\n');
process.stdout.write(run.stdout ?? '');
if (run.stderr) process.stdout.write(run.stderr);
process.stdout.write('--- end controller output ---\n\n');

fs.rmSync(briefDir, { recursive: true, force: true });

const after = snapshot(REPO_ROOT);
const statusAfter = gitStatus();

const problems = diff(before, after);
if (statusBefore !== statusAfter) {
  problems.push('git status changed');
}

process.stdout.write(`Files compared: ${before.size}\n`);
process.stdout.write(`Controller exit code: ${run.status}\n\n`);

if (problems.length === 0) {
  process.stdout.write('PASS — no file was created, modified, or deleted, and git status is unchanged.\n');
  process.exitCode = run.status === 0 ? 0 : 1;
} else {
  process.stdout.write(`FAIL — ${problems.length} filesystem change(s):\n`);
  for (const problem of problems) process.stdout.write(`  ${problem}\n`);
  process.exitCode = 1;
}
