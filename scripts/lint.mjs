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

import { parse as acornParse } from 'acorn';

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
 * Find every line that contains a genuine `debugger` statement in
 * `source`.
 *
 * Uses the acorn JavaScript parser to produce a full AST, then walks the
 * tree to collect line numbers of every `DebuggerStatement` node. The
 * parser correctly distinguishes regex literals from division operators,
 * template-literal text from interpolation code, comments, strings, and
 * all other syntactic constructs — so there is no risk of false positives
 * from `/debugger/` regexes or false negatives from `debugger;` inside
 * `${...}` interpolation bodies.
 *
 * @param {string} source - complete file contents
 * @returns {number[]} 1-based line numbers
 */
export function findDebuggerStatements(source) {
  var debuggerLines = [];
  try {
    var ast = acornParse(source, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      locations: true,
      allowHashBang: true,
      allowReturnOutsideFunction: true,
    });
    walk(ast);
  } catch (_) {
    // Parse error — the file would not pass `node --check` either.  The
    // syntax check in main() already catches parse errors before calling
    // this function, so an empty result here is the safe fallback.
  }
  return debuggerLines;

  function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'DebuggerStatement') {
      debuggerLines.push(node.loc.start.line);
      return;
    }
    var keys = Object.keys(node);
    for (var ki = 0; ki < keys.length; ki++) {
      var val = node[keys[ki]];
      if (Array.isArray(val)) {
        for (var i = 0; i < val.length; i++) walk(val[i]);
      } else if (val && typeof val === 'object' && val.type) {
        walk(val);
      }
    }
  }
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
