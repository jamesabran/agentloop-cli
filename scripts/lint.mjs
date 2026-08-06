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
import { fileURLToPath, pathToFileURL } from 'node:url';

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

/**
 * Strip JavaScript string literals and comments from a source line so
 * a subsequent `debugger` check only matches actual statements, not
 * mentions of the word in strings, template literals, or comments.
 *
 * The order matters: strings must be removed first so that `//` or `/*`
 * inside a string literal is not mistaken for a comment start.
 */
export function stripStringsAndComments(line) {
  return line
    // Template literals — handles basic `${}` interpolation
    .replace(/`(?:[^`\\$]|\$\{[^}]*\}|\\.)*`/g, '``')
    // Double-quoted strings
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    // Single-quoted strings
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    // // line comments (safe after strings are removed)
    .replace(/\/\/.*$/, '')
    // /* block comments */ (single-line only)
    .replace(/\/\*.*?\*\//g, '');
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
      const stripped = stripStringsAndComments(line);
      if (/\bdebugger\b/.test(stripped)) debuggerLines.push(index + 1);
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

const invokedDirectly =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
  process.exitCode = main();
}
