/**
 * Logging for an unattended controller.
 *
 * Two audiences: the owner watching the console, who needs to see the current
 * workflow state at a glance, and the owner reading the log afterwards to
 * understand what happened while they were away. Logs land in the project's
 * `.agent/logs/` (see `LOG_DIR` in config.mjs, under the project root's
 * `.agent/`), which is gitignored — they contain execution detail, not
 * repository content.
 */

import fs from 'node:fs';
import path from 'node:path';

import { LOG_DIR } from './config.mjs';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

const ICONS = {
  debug: '  ',
  info: '· ',
  warn: '! ',
  error: 'x ',
};

let logFile = null;
let minLevel = LEVELS.info;
let fileLoggingEnabled = true;

/**
 * @param {{ verbose?: boolean, toFile?: boolean, dir?: string }} [options]
 */
export function configureLogger({ verbose = false, toFile = true, dir = LOG_DIR } = {}) {
  minLevel = verbose ? LEVELS.debug : LEVELS.info;
  fileLoggingEnabled = toFile;
  if (!toFile) {
    logFile = null;
    return null;
  }
  const day = new Date().toISOString().slice(0, 10);
  fs.mkdirSync(dir, { recursive: true });
  logFile = path.join(dir, `controller-${day}.log`);
  return logFile;
}

function write(level, message) {
  if (LEVELS[level] < minLevel) return;

  const timestamp = new Date().toISOString();
  const line = `${timestamp} ${level.toUpperCase().padEnd(5)} ${message}`;

  const stream = LEVELS[level] >= LEVELS.warn ? process.stderr : process.stdout;
  stream.write(`${ICONS[level]}${message}\n`);

  if (fileLoggingEnabled && logFile) {
    try {
      fs.appendFileSync(logFile, `${line}\n`, 'utf8');
    } catch {
      // Never let logging failure stop the workflow.
    }
  }
}

export const log = {
  debug: (message) => write('debug', message),
  info: (message) => write('info', message),
  warn: (message) => write('warn', message),
  error: (message) => write('error', message),

  /** A titled section, so a long run stays readable. */
  section(title) {
    const rule = '─'.repeat(Math.max(0, 66 - title.length));
    write('info', `\n── ${title} ${rule}`);
  },

  /** Key/value block for the current workflow state. */
  state(pairs) {
    const width = Math.max(...Object.keys(pairs).map((key) => key.length));
    for (const [key, value] of Object.entries(pairs)) {
      write('info', `   ${key.padEnd(width)}  ${value ?? '—'}`);
    }
  },

  file: () => logFile,
};
