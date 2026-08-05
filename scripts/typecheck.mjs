#!/usr/bin/env node
/**
 * `npm run typecheck` — static validation appropriate for a plain ESM
 * JavaScript project with no TypeScript and no build step: every `.mjs`
 * file under `src/` and `bin/` (source and tests alike) must parse cleanly.
 *
 * This is real validation, not a placeholder: `node --check` actually
 * parses each file and reports a real syntax error with a file name and
 * line number, and this script fails (non-zero exit) the moment one does.
 * It works identically on Windows PowerShell and POSIX shells because it is
 * plain Node with no shell-specific syntax and no shell glob expansion —
 * `findMjsFiles` walks the filesystem itself.
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { findMjsFiles } from './lib/find-mjs-files.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function checkFile(file) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe', encoding: 'utf8' });
    return { file, ok: true };
  } catch (error) {
    return { file, ok: false, message: (error.stderr || error.message || '').trim() };
  }
}

function main() {
  const files = [
    ...findMjsFiles(path.join(ROOT, 'src')),
    ...findMjsFiles(path.join(ROOT, 'bin')),
    ...findMjsFiles(path.join(ROOT, 'scripts')),
  ];

  if (files.length === 0) {
    process.stderr.write('typecheck: found no .mjs files under src/, bin/, or scripts/ — that is itself a problem.\n');
    return 1;
  }

  const results = files.map(checkFile);
  const failed = results.filter((result) => !result.ok);

  for (const result of results) {
    const relative = path.relative(ROOT, result.file).split(path.sep).join('/');
    process.stdout.write(`${result.ok ? 'ok  ' : 'FAIL'}  ${relative}\n`);
    if (!result.ok) process.stdout.write(`      ${result.message.split('\n').join('\n      ')}\n`);
  }

  if (failed.length > 0) {
    process.stderr.write(`\ntypecheck: ${failed.length} of ${results.length} file(s) failed to parse.\n`);
    return 1;
  }

  process.stdout.write(`\ntypecheck: ${results.length} file(s) parsed cleanly.\n`);
  return 0;
}

process.exitCode = main();
