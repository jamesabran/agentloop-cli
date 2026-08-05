// @vitest-environment node
/**
 * The controller's non-mutating modes must leave the filesystem untouched.
 *
 * `--self-check` is used as the subject here because it is fully offline, so
 * this test is hermetic and runs in CI-less `npm test`. It exercises the same
 * `configureLogger({ toFile: false })` path that `--dry-run` takes, which is
 * where the mutation came from. `npm run agent:verify-dry-run` performs the
 * identical comparison around a real `--dry-run`, which additionally reads
 * GitHub and so cannot live in the test suite.
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { AGENT_DIR, LOG_DIR } from './config.mjs';
import { configureLogger, log } from './logger.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.resolve(HERE, '..');
const REPO_ROOT = path.resolve(SRC_DIR, '..');

const SKIP = new Set(['node_modules', '.git', 'dist', 'coverage']);

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
      into.set(relative, crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex'));
    }
  }
  return into;
}

function diff(before, after) {
  const changes = [];
  for (const [file, hash] of after) {
    if (!before.has(file)) changes.push(`created: ${file}`);
    else if (before.get(file) !== hash) changes.push(`modified: ${file}`);
  }
  for (const file of before.keys()) {
    if (!after.has(file)) changes.push(`deleted: ${file}`);
  }
  return changes;
}

describe('the non-mutating modes write nothing', () => {
  it('--self-check leaves every file in the project identical', () => {
    const before = snapshot(REPO_ROOT);

    const run = spawnSync(
      process.execPath,
      [path.join(SRC_DIR, 'controller.mjs'), '--self-check'],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    );

    expect(run.status).toBe(0);
    expect(diff(before, snapshot(REPO_ROOT))).toEqual([]);
  }, 60_000);

  it('--self-check does not create the log directory', () => {
    // The mutation the audit found: file logging was enabled for --dry-run
    // because only --self-check disabled it.
    const existedBefore = fs.existsSync(LOG_DIR);
    const filesBefore = existedBefore ? fs.readdirSync(LOG_DIR).length : 0;

    spawnSync(process.execPath, [path.join(SRC_DIR, 'controller.mjs'), '--self-check'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });

    expect(fs.existsSync(LOG_DIR)).toBe(existedBefore);
    if (existedBefore) expect(fs.readdirSync(LOG_DIR).length).toBe(filesBefore);
  }, 60_000);

  it('--dry-run and --help never reach the file logger', () => {
    // Guards the wiring directly: whatever the caller passes, `toFile: false`
    // must not create or touch a log file.
    const file = configureLogger({ toFile: false });
    expect(file).toBeNull();
    log.info('this must not be written anywhere');
    expect(log.file()).toBeNull();
  });

  it('the state file is not created by a mode that does not save', () => {
    const existedBefore = fs.existsSync(AGENT_DIR);

    spawnSync(process.execPath, [path.join(SRC_DIR, 'controller.mjs'), '--self-check'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });

    expect(fs.existsSync(AGENT_DIR)).toBe(existedBefore);
  }, 60_000);
});
