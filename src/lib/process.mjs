/**
 * Child-process helpers, written for Windows first.
 *
 * Two Windows problems are solved here:
 *
 *  1. npm installs `claude` and `codex` as `.cmd` shims. Node refuses to
 *     `spawn` a `.cmd` without a shell (CVE-2024-27980), and the shims are
 *     not always on the PATH the controller inherits, so both are resolved
 *     explicitly and launched through `cmd.exe`.
 *  2. Going through `cmd.exe` makes argument quoting security-relevant.
 *     Every argument is validated against a conservative character set, and
 *     all free-form text — prompts, audit findings — is passed on stdin
 *     instead of the command line.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** Characters `cmd.exe` would interpret. Refused in arguments outright. */
const UNSAFE_ARG = /[\r\n"%&|<>^]/;

export class CommandError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'CommandError';
    Object.assign(this, details);
  }
}

/**
 * Terminate a command and everything it started.
 *
 * Claude is launched through cmd.exe on Windows because the installed npm CLI
 * is a .cmd shim. `child.kill()` only reaches that shell, which can leave the
 * actual Claude process running. taskkill's /T switch kills the complete tree.
 */
export function terminateProcessTree(child) {
  if (!child?.pid) return;

  if (process.platform !== 'win32') {
    child.kill('SIGTERM');
    return;
  }

  let taskkill;
  try {
    taskkill = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true,
    });
  } catch {
    child.kill();
    return;
  }

  // If taskkill itself cannot start, retain the old best-effort behaviour.
  taskkill.once('error', () => child.kill());
}

/**
 * Reject any argument `cmd.exe` could reinterpret.
 * @param {string} arg
 * @returns {string} the argument, unchanged
 */
export function assertSafeArg(arg) {
  if (typeof arg !== 'string') {
    throw new CommandError(`Command arguments must be strings (got ${typeof arg}).`);
  }
  if (UNSAFE_ARG.test(arg)) {
    throw new CommandError(
      `Refusing to pass an argument containing shell metacharacters: ${JSON.stringify(arg)}. ` +
        'Free-form text must be sent on stdin.',
    );
  }
  return arg;
}

function quoteForCmd(arg) {
  assertSafeArg(arg);
  return /\s/.test(arg) ? `"${arg}"` : arg;
}

/**
 * Locate an executable without relying on the inherited PATH alone.
 *
 * @param {string} name bare command name, e.g. `codex`
 * @param {{ override?: string, extraDirs?: string[] }} [options]
 * @returns {string} absolute path, or `name` when only the PATH can resolve it
 */
export function resolveExecutable(name, { override, extraDirs = [] } = {}) {
  if (override) {
    if (!fs.existsSync(override)) {
      throw new CommandError(`Configured path for "${name}" does not exist: ${override}`);
    }
    return override;
  }

  const isWindows = process.platform === 'win32';
  const extensions = isWindows ? ['.cmd', '.exe', '.bat', ''] : [''];
  const searchDirs = [
    ...(process.env.PATH ?? '').split(path.delimiter).filter(Boolean),
    ...extraDirs,
  ];

  for (const dir of searchDirs) {
    for (const extension of extensions) {
      const candidate = path.join(dir, name + extension);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // Not here; keep looking.
      }
    }
  }

  return name;
}

/** Default extra locations for npm-installed CLIs on Windows. */
export function npmGlobalDirs() {
  const dirs = [];
  if (process.env.APPDATA) dirs.push(path.join(process.env.APPDATA, 'npm'));
  if (process.env.HOME) dirs.push(path.join(process.env.HOME, '.local', 'bin'));
  return dirs;
}

/**
 * Run a command to completion, capturing output.
 *
 * @param {string} command executable path or name
 * @param {string[]} args
 * @param {{
 *   cwd?: string, timeoutMs?: number, input?: string,
 *   env?: Record<string,string>, onStdout?: (chunk: string) => void,
 * }} [options]
 * @returns {Promise<{ code: number|null, signal: string|null, stdout: string, stderr: string, timedOut: boolean, command: string }>}
 */
export function run(command, args = [], options = {}) {
  const { cwd, timeoutMs = 0, input, env, onStdout } = options;

  args.forEach(assertSafeArg);

  const isWindowsShim = process.platform === 'win32' && /\.(cmd|bat)$/i.test(command);
  let file = command;
  let spawnArgs = args;
  const spawnOptions = {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  };

  if (isWindowsShim) {
    const line = [command, ...args].map(quoteForCmd).join(' ');
    file = process.env.ComSpec || 'cmd.exe';
    spawnArgs = ['/d', '/s', '/c', `"${line}"`];
    spawnOptions.windowsVerbatimArguments = true;
  }

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(file, spawnArgs, spawnOptions);
    } catch (error) {
      reject(new CommandError(`Failed to start ${command}: ${error.message}`, { command }));
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let timer = null;

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        terminateProcessTree(child);
      }, timeoutMs);
    }

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      onStdout?.(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    child.on('error', (error) => {
      if (timer) clearTimeout(timer);
      reject(new CommandError(`Failed to run ${command}: ${error.message}`, { command }));
    });

    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut, command });
    });

    if (input !== undefined) child.stdin.end(input, 'utf8');
    else child.stdin.end();
  });
}

/**
 * Run a command interactively with bidirectional stdin/stdout.
 *
 * Like `run()`, but stdin stays open after the initial input so the caller
 * can send additional data mid-flight (permission responses, for instance).
 * Stdout is parsed as newline-delimited JSON and delivered to `onEvent`.
 *
 * The returned handle provides `writeStdin()`, `closeStdin()`, and a
 * `completion` promise that resolves when the process exits.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {{
 *   cwd?: string, timeoutMs?: number, input?: string,
 *   env?: Record<string,string>,
 *   onEvent?: (event: object, line: string) => void,
 * }} options
 * @returns {{
 *   writeStdin: (data: string) => void,
 *   closeStdin: () => void,
 *   completion: Promise<{ code: number|null, signal: string|null, stdout: string, stderr: string, timedOut: boolean, command: string }>,
 *   child: import('child_process').ChildProcess,
 * }}
 */
export function runInteractive(command, args = [], options = {}) {
  const { cwd, timeoutMs = 0, input, env, onEvent } = options;

  args.forEach(assertSafeArg);

  const isWindowsShim = process.platform === 'win32' && /\.(cmd|bat)$/i.test(command);
  let file = command;
  let spawnArgs = args;
  const spawnOptions = {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  };

  if (isWindowsShim) {
    const line = [command, ...args].map(quoteForCmd).join(' ');
    file = process.env.ComSpec || 'cmd.exe';
    spawnArgs = ['/d', '/s', '/c', `"${line}"`];
    spawnOptions.windowsVerbatimArguments = true;
  }

  let child;
  try {
    child = spawn(file, spawnArgs, spawnOptions);
  } catch (error) {
    throw new CommandError(`Failed to start ${command}: ${error.message}`, { command });
  }

  let stdout = '';
  let stderr = '';
  let timedOut = false;
  let timer = null;
  let stdinClosed = false;

  if (timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(child);
    }, timeoutMs);
  }

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');

  let lineBuffer = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    lineBuffer += String(chunk ?? '');
    const lines = lineBuffer.split(/\r?\n/);
    lineBuffer = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim() === '') continue;
      try {
        const event = JSON.parse(line);
        onEvent?.(event, line);
      } catch {
        // Non-JSON lines are ignored in stream-json mode — untrusted output.
      }
    }
  });

  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  const completion = new Promise((resolve, reject) => {
    child.on('error', (error) => {
      if (timer) clearTimeout(timer);
      reject(new CommandError(`Failed to run ${command}: ${error.message}`, { command }));
    });

    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut, command });
    });
  });

  if (input !== undefined) {
    child.stdin.write(input, 'utf8');
    // Do NOT end — the caller may write more.
  }

  return {
    writeStdin(data) {
      if (!stdinClosed && child.stdin.writable) {
        child.stdin.write(data, 'utf8');
      }
    },
    closeStdin() {
      if (!stdinClosed) {
        stdinClosed = true;
        if (child.stdin.writable) child.stdin.end();
      }
    },
    completion,
    child,
  };
}

/**
 * Run a command and throw unless it exits 0.
 * @returns {Promise<string>} trimmed stdout
 */
export async function runOrThrow(command, args = [], options = {}) {
  const outcome = await run(command, args, options);
  if (outcome.timedOut) {
    throw new CommandError(`${command} timed out after ${options.timeoutMs}ms`, { outcome });
  }
  if (outcome.code !== 0) {
    const detail = (outcome.stderr || outcome.stdout || '').trim().split('\n').slice(-5).join('\n');
    throw new CommandError(`${command} ${args.join(' ')} exited ${outcome.code}: ${detail}`, {
      outcome,
    });
  }
  return outcome.stdout.trim();
}
