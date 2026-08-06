#!/usr/bin/env node
/**
 * `npm run lint` — minimal static analysis for a plain ESM JavaScript
 * project. TypeScript-level checks live in the `typecheck` script; this
 * script covers the things `node --check` cannot see: leftover debugger
 * statements, and files that fail to parse (caught here a second time so
 * a human running just `npm run lint` gets a clear signal).
 *
 * Plain Node, no shell-specific syntax — behaves identically on Windows
 * PowerShell and POSIX shells.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { findMjsFiles } from './lib/find-mjs-files.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const problems = [];

function fail(file, message) {
  problems.push(`${relative(file)}: ${message}`);
}

function relative(file) {
  return path.relative(ROOT, file).split(path.sep).join('/');
}

function checkSyntax(file) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe', encoding: 'utf8' });
    return true;
  } catch (error) {
    fail(file, `does not parse — ${(error.stderr || error.message || '').trim().split('\n')[0]}`);
    return false;
  }
}

function main() {
  const files = [
    ...findMjsFiles(path.join(ROOT, 'src')),
    ...findMjsFiles(path.join(ROOT, 'bin')),
    ...findMjsFiles(path.join(ROOT, 'scripts')),
  ];

  if (files.length === 0) {
    process.stderr.write('lint: found no .mjs files under src/, bin/, or scripts/.\n');
    return 1;
  }

  let ok = 0;
  for (const file of files) {
    const rel = relative(file);
    if (!checkSyntax(file)) continue;

    const source = fs.readFileSync(file, 'utf8');
    // `debugger` statements should never land in committed code.
    const debuggerLines = [];
    source.split(/\r?\n/).forEach((line, index) => {
      if (/\bdebugger\b/.test(line)) debuggerLines.push(index + 1);
    });
    if (debuggerLines.length > 0) {
      fail(file, `debugger statement(s) on line(s): ${debuggerLines.join(', ')}`);
      continue;
    }

    process.stdout.write(`ok   ${rel}\n`);
    ok += 1;
  }

  if (problems.length > 0) {
    process.stderr.write(`\nlint: ${problems.length} problem(s) found:\n`);
    for (const problem of problems) process.stderr.write(`  - ${problem}\n`);
    return 1;
  }

  process.stdout.write(`\nlint: ${ok} file(s) passed.\n`);
  return 0;
}

process.exitCode = main();
