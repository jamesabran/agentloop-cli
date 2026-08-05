#!/usr/bin/env node
/**
 * `npm run build` — release preparation for a package that ships its
 * JavaScript source directly, with no compiler and no bundler. There is
 * nothing to compile, so "build" here means what actually matters for a
 * source-distributed CLI: prove the package `npm publish` would produce is
 * complete, internally consistent, and free of packaging mistakes. Every
 * check below is real validation against the filesystem and against `npm
 * pack` itself — none of it is a placeholder that only prints success.
 *
 * Plain Node, no shell-specific syntax, so it behaves identically on
 * Windows PowerShell and POSIX shells.
 *
 * Checks, in order:
 *  1. package.json / package-lock.json have a matching version, and
 *     package.json declares a `bin` and a `files` allowlist.
 *  2. Every declared `bin` target exists, parses as valid JavaScript, and
 *     starts with a `#!/usr/bin/env node` shebang (required for the
 *     installed command to run directly on POSIX; harmless, and checked
 *     the same way, on Windows).
 *  3. Every runtime `.mjs` file under src/ and bin/ (tests excluded) parses
 *     cleanly, and every relative import it makes resolves to a real file
 *     — a missing or mistyped import would otherwise only surface once a
 *     consumer actually hit that code path at runtime.
 *  4. `npm pack --dry-run --json` — the actual packing logic, not a
 *     reimplementation of it — is asked what it would publish. The result
 *     must include every runtime file and the bin entry point, and must
 *     not include any `*.test.mjs` file or anything outside bin/, src/, or
 *     the declared docs.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { findMjsFiles } from './lib/find-mjs-files.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const problems = [];
function fail(message) {
  problems.push(message);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Relative imports/re-exports this file makes: `from '<spec>'` where <spec> starts with `.`. */
function relativeImportSpecifiers(source) {
  const specifiers = [];
  const pattern = /\bfrom\s+['"](\.[^'"]+)['"]/g;
  let match;
  // eslint-disable-next-line no-cond-assign
  while ((match = pattern.exec(source))) specifiers.push(match[1]);
  return specifiers;
}

function checkSyntax(file) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe', encoding: 'utf8' });
    return true;
  } catch (error) {
    fail(`${relative(file)}: does not parse — ${(error.stderr || error.message || '').trim().split('\n')[0]}`);
    return false;
  }
}

function relative(file) {
  return path.relative(ROOT, file).split(path.sep).join('/');
}

function main() {
  process.stdout.write('AgentLoop CLI — release/package validation\n\n');

  // 1. Metadata consistency.
  const pkg = readJson(path.join(ROOT, 'package.json'));
  const lockFile = path.join(ROOT, 'package-lock.json');
  if (!pkg.name) fail('package.json: missing "name".');
  if (!pkg.version) fail('package.json: missing "version".');
  if (!/^\d+\.\d+\.\d+/.test(pkg.version ?? '')) {
    fail(`package.json: "version" ${JSON.stringify(pkg.version)} is not a valid semver version.`);
  }
  if (!pkg.bin || Object.keys(pkg.bin).length === 0) fail('package.json: missing a "bin" entry.');
  if (!Array.isArray(pkg.files) || pkg.files.length === 0) {
    fail('package.json: missing a non-empty "files" allowlist.');
  }
  if (fs.existsSync(lockFile)) {
    const lock = readJson(lockFile);
    if (lock.version !== pkg.version) {
      fail(`package-lock.json: version ${JSON.stringify(lock.version)} does not match package.json's ${JSON.stringify(pkg.version)}.`);
    }
    const rootEntry = lock.packages?.[''];
    if (rootEntry && rootEntry.version !== pkg.version) {
      fail(`package-lock.json: packages[""].version ${JSON.stringify(rootEntry.version)} does not match package.json's ${JSON.stringify(pkg.version)}.`);
    }
  } else {
    fail('package-lock.json is missing.');
  }
  process.stdout.write(`1. Metadata: name=${pkg.name} version=${pkg.version}\n`);

  // 2. bin targets.
  const binEntries = Object.entries(pkg.bin ?? {});
  for (const [command, target] of binEntries) {
    const absolute = path.join(ROOT, target);
    if (!fs.existsSync(absolute)) {
      fail(`bin "${command}" points at ${target}, which does not exist.`);
      continue;
    }
    checkSyntax(absolute);
    const firstLine = fs.readFileSync(absolute, 'utf8').split(/\r?\n/, 1)[0];
    if (!firstLine.startsWith('#!/usr/bin/env node')) {
      fail(`bin "${command}" (${target}) is missing a "#!/usr/bin/env node" shebang.`);
    }
  }
  process.stdout.write(`2. bin targets: ${binEntries.map(([, target]) => target).join(', ')}\n`);

  // 3. Runtime files parse, and every relative import resolves.
  const runtimeFiles = [
    ...findMjsFiles(path.join(ROOT, 'src'), { excludeTests: true }),
    ...findMjsFiles(path.join(ROOT, 'bin'), { excludeTests: true }),
  ];
  for (const file of runtimeFiles) {
    checkSyntax(file);
    const source = fs.readFileSync(file, 'utf8');
    for (const specifier of relativeImportSpecifiers(source)) {
      const resolved = path.resolve(path.dirname(file), specifier);
      if (!fs.existsSync(resolved)) {
        fail(`${relative(file)}: imports ${JSON.stringify(specifier)}, which does not resolve to ${relative(resolved)}.`);
      }
    }
  }
  process.stdout.write(`3. Runtime files: ${runtimeFiles.length} file(s) under src/ and bin/\n`);

  // 4. What npm would actually publish.
  let packed;
  try {
    // `shell: true`, not a resolved executable path: npm is installed as a
    // `.cmd` shim on Windows, which Node cannot spawn directly without a
    // shell. Every argument here is a fixed literal, never interpolated
    // user input, so this carries none of the injection risk `shell: true`
    // would with untrusted arguments.
    const stdout = execFileSync('npm', ['pack', '--dry-run', '--json'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: true,
    });
    packed = JSON.parse(stdout)[0];
  } catch (error) {
    fail(`npm pack --dry-run --json failed: ${(error.stderr || error.message || '').trim()}`);
  }

  if (packed) {
    const packedPaths = new Set(packed.files.map((entry) => entry.path));

    for (const [command, target] of binEntries) {
      if (!packedPaths.has(target)) fail(`npm pack would not include the bin target ${target}.`);
    }
    for (const file of runtimeFiles) {
      const relPath = relative(file);
      if (!packedPaths.has(relPath)) fail(`npm pack would not include the runtime file ${relPath}.`);
    }
    const testFiles = [...packedPaths].filter((p) => p.endsWith('.test.mjs'));
    if (testFiles.length > 0) {
      fail(`npm pack would include ${testFiles.length} test file(s), which must not ship: ${testFiles.join(', ')}`);
    }
    const unexpectedTop = [...packedPaths].filter(
      (p) => !p.startsWith('bin/') && !p.startsWith('src/') && p !== 'package.json' && !/^[A-Z].*\.md$/.test(p),
    );
    if (unexpectedTop.length > 0) {
      fail(`npm pack would include unexpected path(s) outside bin/, src/, and top-level docs: ${unexpectedTop.join(', ')}`);
    }
    process.stdout.write(
      `4. npm pack --dry-run: ${packed.entryCount} file(s), ${packed.unpackedSize} bytes unpacked\n`,
    );
  }

  process.stdout.write('\n');
  if (problems.length > 0) {
    process.stderr.write(`build: ${problems.length} problem(s) found:\n`);
    for (const problem of problems) process.stderr.write(`  - ${problem}\n`);
    return 1;
  }

  process.stdout.write('build: package is complete and consistent — ready to publish.\n');
  return 0;
}

process.exitCode = main();
