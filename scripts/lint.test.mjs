// @vitest-environment node
/**
 * Lint script regression tests.
 *
 * The lint script must identify actual `debugger` statements without
 * false-positive matches from its own regexes, strings, comments,
 * identifiers, or diagnostic messages.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { stripStringsAndComments } from './lint.mjs';

describe('stripStringsAndComments', () => {
  it('preserves an actual debugger statement', () => {
    expect(stripStringsAndComments('debugger;')).toMatch(/\bdebugger\b/);
    expect(stripStringsAndComments('  debugger;')).toMatch(/\bdebugger\b/);
    expect(stripStringsAndComments('if (x) { debugger; }')).toMatch(/\bdebugger\b/);
  });

  it('strips debugger inside a // comment', () => {
    const stripped = stripStringsAndComments('// debugger should not match');
    expect(stripped).not.toMatch(/\bdebugger\b/);
  });

  it('strips debugger inside a /* block comment */', () => {
    const stripped = stripStringsAndComments('/* debugger */');
    expect(stripped).not.toMatch(/\bdebugger\b/);
  });

  it('strips debugger inside a double-quoted string', () => {
    const stripped = stripStringsAndComments('const x = "debugger";');
    expect(stripped).not.toMatch(/\bdebugger\b/);
  });

  it('strips debugger inside a single-quoted string', () => {
    const stripped = stripStringsAndComments("const x = 'debugger';");
    expect(stripped).not.toMatch(/\bdebugger\b/);
  });

  it('strips debugger inside a template literal', () => {
    const stripped = stripStringsAndComments('const x = `debugger`;');
    expect(stripped).not.toMatch(/\bdebugger\b/);
  });

  it('strips debugger inside a template literal with interpolation', () => {
    const stripped = stripStringsAndComments(
      'fail(file, `debugger statement(s) on line(s): ${lines.join(", ")}`);',
    );
    expect(stripped).not.toMatch(/\bdebugger\b/);
  });

  it('strips debugger inside a string, even when followed by a comment', () => {
    const stripped = stripStringsAndComments('const x = "debugger"; // also debugger');
    expect(stripped).not.toMatch(/\bdebugger\b/);
  });

  it('does not mistake // inside a string for a comment', () => {
    // The "//" inside the string must not start a comment that hides debugger
    // from detection. The order is: strings first, then comments.
    const stripped = stripStringsAndComments('const x = "// not a comment"; debugger;');
    expect(stripped).toMatch(/\bdebugger\b/);
  });

  it('handles a line with the word debugger as a variable name', () => {
    // debugger is a reserved word, but this tests that our regex doesn't
    // accidentally strip it when used outside strings/comments.
    const stripped = stripStringsAndComments('debugger; // a breakpoint');
    expect(stripped).toMatch(/\bdebugger\b/);
  });

  it('produces the same result with just a regular code line', () => {
    const stripped = stripStringsAndComments('const x = 42;');
    expect(stripped).toBe('const x = 42;');
  });

  it('handles an empty line', () => {
    const stripped = stripStringsAndComments('');
    expect(stripped).toBe('');
  });
});

describe('lint script self-test', () => {
  it('does not report its own file for debugger references', () => {
    // The lint script contains the word "debugger" in comments and strings.
    // It must pass its own check.
    const lintSource = fs.readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'lint.mjs'),
      'utf8',
    );
    const lines = lintSource.split(/\r?\n/);
    const debuggerLines = [];

    lines.forEach((line, index) => {
      const stripped = stripStringsAndComments(line);
      if (/\bdebugger\b/.test(stripped)) {
        debuggerLines.push(index + 1);
      }
    });

    expect(debuggerLines).toEqual([]);
  });
});
