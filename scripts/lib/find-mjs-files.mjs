/**
 * Recursively find `.mjs` files under a directory, without relying on shell
 * glob syntax — so `npm run typecheck`/`npm run build` behave identically on
 * Windows PowerShell and POSIX shells. Pure `node:fs`, no dependencies.
 */

import fs from 'node:fs';
import path from 'node:path';

const SKIP_DIRS = new Set(['node_modules', '.git']);

/**
 * @param {string} dir absolute directory to walk
 * @param {{ excludeTests?: boolean }} [options]
 * @returns {string[]} absolute paths, sorted
 */
export function findMjsFiles(dir, { excludeTests = false } = {}) {
  const found = [];

  const walk = (current) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.mjs')) {
        if (excludeTests && entry.name.endsWith('.test.mjs')) continue;
        found.push(full);
      }
    }
  };

  walk(dir);
  return found.sort();
}
