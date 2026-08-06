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

import { findDebuggerStatements, stripStrings, stripStringsAndComments } from './lint.mjs';

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

  it('does not flag a property named debugger', () => {
    // { debugger: false } is valid ES — debugger is a reserved word but
    // can appear as an unquoted property name in object literals.
    const result = findDebuggerStatements(
      'const config = { debugger: false };',
    );
    expect(result).toEqual([]);
  });

  it('finds debugger even when a // line appears inside a block comment', () => {
    // The `// */` inside the block comment must not hide the close marker
    // from the scanner — if `//` is stripped before block-comment tracking,
    // the `*/` is lost and the genuine `debugger;` on line 3 is missed.
    const result = findDebuggerStatements('/* open\n// */\ndebugger;');
    expect(result).toEqual([3]);
  });

  it('does not flag debugger used as a label in code', () => {
    // `debugger:` is a labelled statement (though debugger is reserved, so
    // this is hypothetical). The scanner should still treat it as a
    // property/label pattern.
    const result = findDebuggerStatements('debugger:\n  for (;;) {}');
    expect(result).toEqual([]);
  });

  it('finds debugger with leading whitespace and no trailing semicolon', () => {
    // Bare `debugger` with nothing after it on the line is a real statement.
    const result = findDebuggerStatements('  debugger');
    expect(result).toEqual([1]);
  });
});

describe('lint script self-test', () => {
  const allFiles = [];
  const baseDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

  // Collect all .mjs files the lint scanner would check — src/, bin/, scripts/
  function collect(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && entry.name !== 'node_modules') {
        collect(full);
      } else if (entry.isFile() && entry.name.endsWith('.mjs')) {
        allFiles.push(full);
      }
    }
  }
  collect(path.join(baseDir, 'src'));
  collect(path.join(baseDir, 'bin'));
  collect(path.join(baseDir, 'scripts'));

  it('does not report its own file for debugger references', () => {
    const lintSource = fs.readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'lint.mjs'),
      'utf8',
    );
    const debuggerLines = findDebuggerStatements(lintSource);
    expect(debuggerLines).toEqual([]);
  });

  it('finds no false positives across the complete repository', () => {
    // Every .mjs file under src/, bin/, and scripts/ must produce zero
    // false-positive debugger-statement reports. The word "debugger"
    // appears in comments, strings, regexes, and variable names
    // throughout this project — none of those are genuine statements.
    const falsePositives = [];
    for (const file of allFiles) {
      const source = fs.readFileSync(file, 'utf8');
      const lines = findDebuggerStatements(source);
      if (lines.length > 0) {
        falsePositives.push(
          `${path.relative(baseDir, file)}: ${lines.join(', ')}`,
        );
      }
    }
    expect(falsePositives).toEqual([]);
  });
});
