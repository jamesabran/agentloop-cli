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

import { findDebuggerStatements, stripStringsAndComments } from './lint.mjs';

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

describe('findDebuggerStatements', () => {
  it('finds a genuine debugger statement', () => {
    const result = findDebuggerStatements('debugger;');
    expect(result).toEqual([1]);
  });

  it('ignores debugger inside a // comment', () => {
    const result = findDebuggerStatements('// debugger should not match');
    expect(result).toEqual([]);
  });

  it('ignores debugger inside a /* block comment */', () => {
    const result = findDebuggerStatements('/* debugger */');
    expect(result).toEqual([]);
  });

  it('ignores debugger inside a multi-line block comment', () => {
    const result = findDebuggerStatements(
      '/**\n * leftover debugger\n */\ndebugger;\n',
    );
    // Line 3 (" * leftover debugger") is inside the block comment; only
    // line 4 has a genuine debugger statement.
    expect(result).toEqual([4]);
  });

  it('ignores debugger inside a JSDoc block', () => {
    const source = [
      '/**',
      ' * script covers the things `node --check` cannot see: leftover debugger',
      ' * statements, and files that fail to parse.',
      ' */',
      'const x = 1;',
    ].join('\n');
    const result = findDebuggerStatements(source);
    expect(result).toEqual([]);
  });

  it('finds debugger after a block comment closes', () => {
    const result = findDebuggerStatements('/* comment */ debugger;');
    expect(result).toEqual([1]);
  });

  it('finds debugger before a multi-line block comment opens', () => {
    const result = findDebuggerStatements('debugger; /* start of multi-line');
    expect(result).toEqual([1]);
  });

  it('finds debugger after a multi-line block comment closes', () => {
    const result = findDebuggerStatements(
      'ending multi-line */ debugger;',
    );
    expect(result).toEqual([1]);
  });

  it('handles a mixed file correctly', () => {
    const source = [
      '/**',
      ' * JSDoc mentioning debugger in prose.',
      ' */',
      'const debuggerLines = [];',
      '// debugger in a line comment',
      'const s = "debugger";',
      "const t = 'debugger';",
      'const u = `debugger`;',
      'debugger; // real one',
    ].join('\n');
    // Only line 9 has a genuine debugger statement.
    const result = findDebuggerStatements(source);
    expect(result).toEqual([9]);
  });
});

describe('lint script self-test', () => {
  it('does not report its own file for debugger references', () => {
    // The lint script contains the word "debugger" in comments and strings,
    // including inside the multi-line JSDoc at the top of the file. It must
    // pass its own check when the full multi-line-aware scanner is used.
    const lintSource = fs.readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'lint.mjs'),
      'utf8',
    );
    const debuggerLines = findDebuggerStatements(lintSource);
    expect(debuggerLines).toEqual([]);
  });
});
