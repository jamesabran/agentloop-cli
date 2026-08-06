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
 * Strip JavaScript string literals from a source line.
 *
 * Only removes template literals, double-quoted strings, and
 * single-quoted strings. Comments are left intact — they are handled
 * separately by {@link findDebuggerStatements} so that multi-line
 * block-comment tracking works correctly even when `//` or `*/`
 * appears inside comment text.
 *
 * @param {string} line
 * @returns {string}
 */
export function stripStrings(line) {
  return line
    // Template literals — handles basic `${}` interpolation
    .replace(/`(?:[^`\\$]|\$\{[^}]*\}|\\.)*`/g, '``')
    // Double-quoted strings
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    // Single-quoted strings
    .replace(/'(?:[^'\\]|\\.)*'/g, "''");
}

/**
 * Strip JavaScript string literals and comments from a source line so
 * a subsequent `debugger` check only matches actual statements, not
 * mentions of the word in strings, template literals, or comments.
 *
 * The order matters: strings must be removed first so that `//` or `/*`
 * inside a string literal is not mistaken for a comment start.
 *
 * This function handles only single-line constructs. Multi-line block
 * comments are tracked by {@link findDebuggerStatements}.
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

/**
 * Find every line that contains a genuine `debugger` statement in
 * `source`.
 *
 * Strips string literals first so their contents never influence comment
 * detection. Tracks block-comment (`/* … */`) state across lines BEFORE
 * removing `//` line comments — this is the critical order that keeps a
 * `// */` line inside a block comment from hiding the real close marker.
 *
 * After comment removal, the remaining code text is checked for
 * `debugger` with a negative lookahead that excludes property names
 * (`{ debugger: false }`).
 *
 * @param {string} source - complete file contents
 * @returns {number[]} 1-based line numbers
 */
export function findDebuggerStatements(source) {
  const debuggerLines = [];
  let inBlockComment = false;

  source.split(/\r?\n/).forEach((line, index) => {
    // Step 1: Strip string literals. This prevents `/*`, `*/`, `//`, and
    // `debugger` inside strings from influencing the scan.
    const noStrings = stripStrings(line);

    // Step 2: Resolve block-comment state. We look for `/*` and `*/` in
    // the string-free text BEFORE stripping `//` line comments, so that a
    // `// */` line inside a block comment cannot hide the close marker.
    let pos = 0;
    let codeBeforeLineComment = '';

    while (pos < noStrings.length) {
      if (inBlockComment) {
        const endIdx = noStrings.indexOf('*/', pos);
        if (endIdx === -1) return; // entire remainder of line is inside comment
        pos = endIdx + 2;
        inBlockComment = false;
        continue;
      }

      // Look for a block-comment start at the current position
      const startIdx = noStrings.indexOf('/*', pos);
      if (startIdx !== -1) {
        // Copy code before the comment start
        codeBeforeLineComment += noStrings.slice(pos, startIdx);
        const endIdx = noStrings.indexOf('*/', startIdx + 2);
        if (endIdx !== -1) {
          // Single-line block comment — skip it
          pos = endIdx + 2;
        } else {
          // Multi-line block comment starts here
          inBlockComment = true;
          pos = noStrings.length; // nothing after `/*` on this line to process
        }
      } else {
        // No more block-comment starts — the rest is code or a line comment
        codeBeforeLineComment += noStrings.slice(pos);
        break;
      }
    }

    // Step 3: Strip `//` line comments from the block-comment-free text.
    const lineCommentIdx = codeBeforeLineComment.indexOf('//');
    const codeOnly =
      lineCommentIdx === -1
        ? codeBeforeLineComment
        : codeBeforeLineComment.slice(0, lineCommentIdx);

    // Step 4: Check for `debugger` as a statement — not a property name.
    // Property:  { debugger: false }  — `debugger` is followed by `:`
    // Statement: debugger;            — `debugger` is followed by `;`
    // The negative lookahead `(?!\s*:)` rejects the property-name case.
    if (/\bdebugger\b(?!\s*:)/.test(codeOnly)) {
      debuggerLines.push(index + 1);
    }
  });

  return debuggerLines;
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
    const debuggerLines = findDebuggerStatements(source);
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
