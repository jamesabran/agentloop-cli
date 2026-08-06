#!/usr/bin/env node
/**
 * `npm run lint` -- minimal static analysis for a plain ESM JavaScript
 * project. TypeScript-level checks live in the `typecheck` script; this
 * script covers the things `node --check` cannot see: leftover debugger
 * statements, and files that fail to parse (caught here a second time so
 * a human running just `npm run lint` gets a clear signal).
 *
 * Plain Node, no shell-specific syntax -- behaves identically on Windows
 * PowerShell and POSIX shells.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { findMjsFiles } from './lib/find-mjs-files.mjs';

var ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

var problems = [];

function fail(file, message) {
  problems.push(relative(file) + ': ' + message);
}

function relative(file) {
  return path.relative(ROOT, file).split(path.sep).join('/');
}

function checkSyntax(file) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe', encoding: 'utf8' });
    return true;
  } catch (error) {
    fail(file, 'does not parse -- ' + (error.stderr || error.message || '').trim().split('\n')[0]);
    return false;
  }
}

/**
 * Strip JavaScript string literals, template literals, and comments from a
 * single source line so a subsequent `debugger` check only matches actual
 * statements, not mentions of the word in strings or comments.
 *
 * Uses a character-by-character scanner instead of chained regex
 * replacements. Only handles single-line constructs; multi-line block
 * comments are tracked separately by findDebuggerStatements.
 *
 * @param {string} line
 * @returns {string}
 */
export function stripStringsAndComments(line) {
  var out = '';
  var i = 0;

  while (i < line.length) {
    var ch = line[i];

    // Double-quoted string
    if (ch === '"') {
      out += '""';
      i++;
      while (i < line.length) {
        if (line[i] === '\\') { i += 2; continue; }
        if (line[i] === '"') break;
        i++;
      }
      i++; // skip closing quote
      continue;
    }

    // Single-quoted string
    if (ch === "'") {
      out += "''";
      i++;
      while (i < line.length) {
        if (line[i] === '\\') { i += 2; continue; }
        if (line[i] === "'") break;
        i++;
      }
      i++;
      continue;
    }

    // Template literal -- use hex 0x60 for backtick to avoid
    // accidentally introducing template-literal characters in this file.
    if (ch === String.fromCharCode(0x60)) {
      out += String.fromCharCode(0x60) + String.fromCharCode(0x60);
      i++;
      while (i < line.length) {
        if (line[i] === '\\') { i += 2; continue; }
        // Dollar-brace opens an expression inside the template
        if (line[i] === '$' && i + 1 < line.length && line[i + 1] === '{') {
          var depth = 1;
          i += 2;
          while (i < line.length && depth > 0) {
            if (line[i] === '{') depth++;
            else if (line[i] === '}') depth--;
            i++;
          }
          continue;
        }
        if (line[i] === String.fromCharCode(0x60)) break;
        i++;
      }
      i++;
      continue;
    }

    // Line comment -- rest of line is comment, stop here
    if (ch === '/' && i + 1 < line.length && line[i + 1] === '/') {
      break;
    }

    // Single-line block comment
    if (ch === '/' && i + 1 < line.length && line[i + 1] === '*') {
      i += 2;
      while (i < line.length) {
        if (line[i] === '*' && i + 1 < line.length && line[i + 1] === '/') {
          i += 2;
          break;
        }
        i++;
      }
      continue;
    }

    out += ch;
    i++;
  }

  return out;
}

/**
 * Check whether the character at `idx` in `source` is the start of a
 * genuine `debugger` statement. A genuine statement is the `debugger`
 * keyword standing alone, not followed by a colon (property name or
 * label) and not part of a longer identifier.
 *
 * @param {string} source
 * @param {number} idx -- where 'd' was found
 * @returns {boolean}
 */
function isDebuggerStatement(source, idx) {
  // Check for the exact keyword
  if (source.slice(idx, idx + 8) !== 'debugger') return false;

  // Must be at a word boundary on the left
  if (idx > 0) {
    var before = source[idx - 1];
    if (/[A-Za-z0-9_$]/.test(before)) return false;
  }

  // After 'debugger', skip whitespace (spaces and tabs only, not newlines)
  var j = idx + 8;
  while (j < source.length && (source[j] === ' ' || source[j] === '\t')) j++;

  // If followed by ':' (property name / label) or a word character (longer
  // identifier like `debuggerLines`), it is not a statement.
  if (j < source.length) {
    var after = source[j];
    if (after === ':' || after === '$' || after === '_') return false;
    if (/[A-Za-z0-9]/.test(after)) return false;
  }

  return true;
}

/**
 * Find every line that contains a genuine `debugger` statement in
 * `source`.
 *
 * Uses a character-by-character state-machine scanner that distinguishes
 * code, string literals (double-quoted, single-quoted, template), line
 * comments, and block comments. Multi-line block comments are tracked
 * across lines so that mentions of the word inside a JSDoc or other block
 * comment are never flagged.
 *
 * The scanner also skips `debugger` when it appears as an object property
 * (`{ debugger: false }`) or as part of a longer identifier
 * (`debuggerLines`).
 *
 * @param {string} source - complete file contents
 * @returns {number[]} 1-based line numbers
 */
export function findDebuggerStatements(source) {
  var debuggerLines = [];
  var line = 1;
  var i = 0;
  // State: code, dq (double-quoted string), sq (single-quoted string),
  //        tl (template literal), lc (line comment), bc (block comment)
  var state = 'code';
  var BT = String.fromCharCode(0x60); // backtick

  while (i < source.length) {
    var ch = source[i];

    // ---- newlines ----
    if (ch === '\n') {
      line++;
      i++;
      if (state === 'lc') state = 'code';
      continue;
    }
    if (ch === '\r') {
      line++;
      i++;
      if (i < source.length && source[i] === '\n') i++;
      if (state === 'lc') state = 'code';
      continue;
    }

    // ---- code state ----
    if (state === 'code') {
      // Line comment start
      if (ch === '/' && i + 1 < source.length && source[i + 1] === '/') {
        state = 'lc';
        i += 2;
        continue;
      }
      // Block comment start
      if (ch === '/' && i + 1 < source.length && source[i + 1] === '*') {
        state = 'bc';
        i += 2;
        continue;
      }
      // Double-quoted string
      if (ch === '"') { state = 'dq'; i++; continue; }
      // Single-quoted string
      if (ch === "'") { state = 'sq'; i++; continue; }
      // Template literal
      if (ch === BT) { state = 'tl'; i++; continue; }

      // debugger keyword
      if (ch === 'd' && isDebuggerStatement(source, i)) {
        debuggerLines.push(line);
        i += 8;
        continue;
      }

      i++;
      continue;
    }

    // ---- double-quoted string ----
    if (state === 'dq') {
      if (ch === '\\') { i += 2; continue; }
      if (ch === '"') state = 'code';
      i++;
      continue;
    }

    // ---- single-quoted string ----
    if (state === 'sq') {
      if (ch === '\\') { i += 2; continue; }
      if (ch === "'") state = 'code';
      i++;
      continue;
    }

    // ---- template literal ----
    if (state === 'tl') {
      if (ch === '\\') { i += 2; continue; }
      // Template interpolation ${...}
      if (ch === '$' && i + 1 < source.length && source[i + 1] === '{') {
        var depth = 1;
        i += 2;
        while (i < source.length && depth > 0) {
          var ec = source[i];
          if (ec === '\n') line++;
          else if (ec === '\r') {
            line++;
            if (i + 1 < source.length && source[i + 1] === '\n') i++;
          } else if (ec === '{') depth++;
          else if (ec === '}') depth--;
          else if (ec === BT) {
            // Nested template literal -- skip to closing backtick
            i++;
            while (i < source.length && source[i] !== BT) {
              if (source[i] === '\\') i++;
              else if (source[i] === '\n') line++;
              i++;
            }
          }
          i++;
        }
        continue;
      }
      if (ch === BT) state = 'code';
      i++;
      continue;
    }

    // ---- line comment ----
    if (state === 'lc') {
      i++;
      continue;
    }

    // ---- block comment ----
    if (state === 'bc') {
      if (ch === '*' && i + 1 < source.length && source[i + 1] === '/') {
        state = 'code';
        i += 2;
        continue;
      }
      i++;
      continue;
    }
  }

  return debuggerLines;
}

export function main() {
  var files = [];
  files = files.concat(findMjsFiles(path.join(ROOT, 'src')));
  files = files.concat(findMjsFiles(path.join(ROOT, 'bin')));
  files = files.concat(findMjsFiles(path.join(ROOT, 'scripts')));

  if (files.length === 0) {
    process.stderr.write('lint: found no .mjs files under src/, bin/, or scripts/.\n');
    return 1;
  }

  var ok = 0;
  for (var fi = 0; fi < files.length; fi++) {
    var file = files[fi];
    var rel = relative(file);
    if (!checkSyntax(file)) continue;

    var source = fs.readFileSync(file, 'utf8');
    // debugger statements should never land in committed code.
    var debuggerLines = findDebuggerStatements(source);
    if (debuggerLines.length > 0) {
      fail(file, 'debugger statement(s) on line(s): ' + debuggerLines.join(', '));
      continue;
    }

    process.stdout.write('ok   ' + rel + '\n');
    ok += 1;
  }

  if (problems.length > 0) {
    process.stderr.write('\nlint: ' + problems.length + ' problem(s) found:\n');
    for (var pi = 0; pi < problems.length; pi++) {
      process.stderr.write('  - ' + problems[pi] + '\n');
    }
    return 1;
  }

  process.stdout.write('\nlint: ' + ok + ' file(s) passed.\n');
  return 0;
}

var invokedDirectly =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
  process.exitCode = main();
}
