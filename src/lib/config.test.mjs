// @vitest-environment node
/**
 * The repository boundary is enforced at config load, not at call sites.
 *
 * AgentLoop makes no assumption about which project it runs in: REPO is
 * resolved from `agentloop.config.json`'s `repo` field if it sets one,
 * otherwise from the project's own git remote. `AGENTLOOP_REPO` used to be a
 * general override; now it may only assert whichever value the project
 * itself already resolved, never redirect it — an exported `AGENTLOOP_REPO`
 * must not be able to aim every `gh` call, and the publishing push, at a
 * different repository than the one this checkout belongs to.
 *
 * The same treatment covers Claude's tool allowlist: the local loop must not
 * be able to publish, so no env var may grant it `git push` or `gh`. That
 * used to be checked by denying specific shapes — a literal "git push", a
 * bare `Bash(git *)` — but `Bash(git -C . push*)` is neither: the `-C .`
 * sits between "git" and "push", so it matches no denylist pattern while
 * still running `git push`. Every override entry that invokes git through
 * `Bash(...)` is now compared against the fixed, safe subcommand list
 * instead and must match one of them exactly, so an option-prefixed push, a
 * remote mutation, or any other git command not on that list is refused the
 * same way, whatever shape it takes.
 *
 * Claude's allowlist used to also include the exact `npm run <script>`
 * commands DETERMINISTIC_CHECKS runs, derived from the configured `checks`.
 * That was two vulnerabilities at once: Claude can edit `package.json`, so
 * an npm script name only resolves to a real command by reading a file
 * Claude itself controls (redefine "test", then invoke the "restricted"
 * `npm run test`); and deriving Claude's tools from *configured* check
 * values made a project's own `agentloop.config.json` a source of Claude's
 * permissions, with a comma in a `script` value able to inject an unrelated
 * `Bash(...)` pattern into the joined allowlist string. Claude is now never
 * granted any npm/node/npx command, unconditionally — see the "a configured
 * check cannot add a Claude Bash permission" and "modifying package.json
 * gives Claude no path to run git push or gh" tests below.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_URL = pathToFileURL(path.join(HERE, 'config.mjs')).href;

const tempDirs = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

/** A fresh, isolated project directory: its own `.git`, optionally a remote and/or an agentloop.config.json. */
function makeProject({ remote, config } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentloop-config-'));
  tempDirs.push(dir);
  spawnSync('git', ['init', '--quiet'], { cwd: dir });
  if (remote) spawnSync('git', ['remote', 'add', 'origin', remote], { cwd: dir });
  if (config) {
    fs.writeFileSync(path.join(dir, 'agentloop.config.json'), JSON.stringify(config), 'utf8');
  }
  return dir;
}

/** Import config.mjs from `cwd`, with `env`, and print `JSON.stringify(m.<field>)`. */
function importConfigField(field, { cwd, env }) {
  return spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import(${JSON.stringify(CONFIG_URL)}).then((m) => process.stdout.write(JSON.stringify(m.${field} ?? null)), (e) => { process.stderr.write(e.message); process.exit(1); });`,
    ],
    { cwd, env, encoding: 'utf8' },
  );
}

/**
 * A child environment with every AGENTLOOP_* assertion variable cleared,
 * then `overrides` applied. `spawnSync`'s `env` option stringifies every
 * value it is given — including `undefined`, as the literal string
 * `"undefined"` — so unsetting a variable means deleting the key, not
 * setting it to `undefined`.
 */
function baseEnv(overrides = {}) {
  const env = { ...process.env };
  delete env.AGENTLOOP_REPO;
  delete env.AGENTLOOP_BASE_BRANCH;
  delete env.AGENTLOOP_CLAUDE_ALLOWED_TOOLS;
  delete env.AGENTLOOP_CLAUDE_TIMEOUT_MS;
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

describe('REPO is resolved from the project, not hardcoded', () => {
  it('resolves from the git remote when nothing else specifies a repository', () => {
    const dir = makeProject({ remote: 'https://github.com/example-org/example-repo.git' });
    const result = importConfigField('REPO', { cwd: dir, env: baseEnv() });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toBe('example-org/example-repo');
  });

  it('prefers an explicit "repo" in agentloop.config.json over the git remote', () => {
    const dir = makeProject({
      remote: 'https://github.com/example-org/example-repo.git',
      config: { repo: 'example-org/pinned-repo' },
    });
    const result = importConfigField('REPO', { cwd: dir, env: baseEnv() });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toBe('example-org/pinned-repo');
  });

  it('resolves to null when there is no remote and no configured repo', () => {
    const dir = makeProject();
    const result = importConfigField('REPO', { cwd: dir, env: baseEnv() });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toBeNull();
  });
});

describe('AGENTLOOP_REPO is not a general override', () => {
  it('loads when the variable asserts the resolved value exactly', () => {
    const dir = makeProject({ remote: 'https://github.com/example-org/example-repo.git' });
    const result = importConfigField('REPO', {
      cwd: dir,
      env: baseEnv({ AGENTLOOP_REPO: 'example-org/example-repo' }),
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toBe('example-org/example-repo');
  });

  it('loads when the variable asserts the resolved value in a different case', () => {
    const dir = makeProject({ remote: 'https://github.com/Example-Org/Example-Repo.git' });
    const result = importConfigField('REPO', {
      cwd: dir,
      env: baseEnv({ AGENTLOOP_REPO: 'EXAMPLE-ORG/EXAMPLE-REPO' }),
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toBe('example-org/example-repo');
  });

  it('treats an empty value as unset rather than as a rejected override', () => {
    const dir = makeProject({ remote: 'https://github.com/example-org/example-repo.git' });
    const result = importConfigField('REPO', { cwd: dir, env: baseEnv({ AGENTLOOP_REPO: '' }) });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toBe('example-org/example-repo');
  });

  it('refuses to redirect to a different repository than the one this project resolved', () => {
    const dir = makeProject({ remote: 'https://github.com/example-org/example-repo.git' });
    const result = importConfigField('REPO', {
      cwd: dir,
      env: baseEnv({ AGENTLOOP_REPO: 'someone-else/unrelated' }),
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/AGENTLOOP_REPO/);
    expect(result.stderr).toMatch(/not permitted/);
  });

  it('lets the variable supply a repository when nothing else resolved one', () => {
    // There is nothing yet to redirect away from, so the env var is the only
    // way to give the loop a repository at all.
    const dir = makeProject();
    const result = importConfigField('REPO', {
      cwd: dir,
      env: baseEnv({ AGENTLOOP_REPO: 'example-org/example-repo' }),
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toBe('example-org/example-repo');
  });
});

describe('BASE_BRANCH is resolved from the project', () => {
  it('defaults to "main" when unconfigured', () => {
    const dir = makeProject();
    const result = importConfigField('BASE_BRANCH', { cwd: dir, env: baseEnv() });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toBe('main');
  });

  it('reads "baseBranch" from agentloop.config.json', () => {
    const dir = makeProject({ config: { baseBranch: 'trunk' } });
    const result = importConfigField('BASE_BRANCH', { cwd: dir, env: baseEnv() });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toBe('trunk');
  });
});

describe('AGENTLOOP_BASE_BRANCH is not a general override', () => {
  it('loads when the variable asserts the resolved value exactly', () => {
    const dir = makeProject();
    const result = importConfigField('BASE_BRANCH', {
      cwd: dir,
      env: baseEnv({ AGENTLOOP_BASE_BRANCH: 'main' }),
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toBe('main');
  });

  it('treats an empty value as unset', () => {
    const dir = makeProject();
    const result = importConfigField('BASE_BRANCH', {
      cwd: dir,
      env: baseEnv({ AGENTLOOP_BASE_BRANCH: '' }),
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toBe('main');
  });

  it('refuses to redirect to a different branch', () => {
    const dir = makeProject();
    const result = importConfigField('BASE_BRANCH', {
      cwd: dir,
      env: baseEnv({ AGENTLOOP_BASE_BRANCH: 'release/beta' }),
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/AGENTLOOP_BASE_BRANCH/);
    expect(result.stderr).toMatch(/not permitted/);
  });
});

describe('DETERMINISTIC_CHECKS can be reconfigured per project', () => {
  it('defaults to typecheck, lint, test, and build', () => {
    const dir = makeProject();
    const result = importConfigField('DETERMINISTIC_CHECKS', { cwd: dir, env: baseEnv() });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).map((c) => c.name)).toEqual([
      'typecheck',
      'lint',
      'test',
      'build',
    ]);
  });

  it('reads a narrower list from agentloop.config.json', () => {
    const dir = makeProject({
      config: { checks: [{ name: 'test', script: 'test' }] },
    });
    const result = importConfigField('DETERMINISTIC_CHECKS', { cwd: dir, env: baseEnv() });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([{ name: 'test', script: 'test' }]);
  });

  it('refuses an empty checks array', () => {
    const dir = makeProject({ config: { checks: [] } });
    const result = importConfigField('DETERMINISTIC_CHECKS', { cwd: dir, env: baseEnv() });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/non-empty array/);
  });
});

describe('AGENTLOOP_CLAUDE_ALLOWED_TOOLS cannot grant the publishing tools', () => {
  it('loads a default that enumerates specific git subcommands, not a wildcard', () => {
    const dir = makeProject();
    const result = importConfigField('CLAUDE_ALLOWED_TOOLS', { cwd: dir, env: baseEnv() });
    expect(result.status).toBe(0);
    const value = JSON.parse(result.stdout);
    // No unbounded `git *`: that wildcard would also admit `git -C . push`
    // and every other option-prefixed form, which a `Bash(git push*)`
    // disallow entry cannot catch because none of them start with the
    // literal string "git push".
    expect(value).not.toMatch(/Bash\(git \*\)/);
    expect(value).toMatch(/Bash\(git status\*\)/);
    expect(value).toMatch(/Bash\(git add\*\)/);
    expect(value).toMatch(/Bash\(git commit\*\)/);
    expect(value).not.toMatch(/\bgh\b/);
    expect(value).not.toMatch(/git push/i);
  });

  it('accepts a narrower override that stays local', () => {
    const dir = makeProject();
    const result = importConfigField('CLAUDE_ALLOWED_TOOLS', {
      cwd: dir,
      env: baseEnv({ AGENTLOOP_CLAUDE_ALLOWED_TOOLS: 'Read,Edit,Bash(git status*)' }),
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toBe('Read,Edit,Bash(git status*)');
  });

  it('refuses an explicit git push grant', () => {
    // Only the controller publishes, and only after Codex approves the exact
    // local HEAD. A push from inside an implementation turn would be partial
    // work reaching GitHub.
    const dir = makeProject();
    const result = importConfigField('CLAUDE_ALLOWED_TOOLS', {
      cwd: dir,
      env: baseEnv({ AGENTLOOP_CLAUDE_ALLOWED_TOOLS: 'Read,Edit,Bash(git push*)' }),
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/not permitted/);
    expect(result.stderr).toMatch(/git push/);
  });

  it('refuses an unbounded Bash(git *) override', () => {
    // The exact bypass this whole default was narrowed to close: a wildcard
    // here would readmit `git -C . push` and friends, which no disallow
    // pattern can catch because they never start with "git push".
    const dir = makeProject();
    const result = importConfigField('CLAUDE_ALLOWED_TOOLS', {
      cwd: dir,
      env: baseEnv({ AGENTLOOP_CLAUDE_ALLOWED_TOOLS: 'Read,Edit,Bash(git *)' }),
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/not permitted/);
    expect(result.stderr).toMatch(/Bash\(git \*\)/);
  });

  it('refuses an option-prefixed push that contains neither "git push" nor a bare wildcard', () => {
    // The actual regression: `-C .` sits between "git" and "push", so this
    // string contains neither the substring "git push" nor an unbounded
    // `Bash(git *)`. The two denylist patterns that used to be the whole
    // check both miss it; only comparing the entry against the fixed safe
    // list catches it, because "Bash(git -C . push*)" is not on that list.
    const dir = makeProject();
    const result = importConfigField('CLAUDE_ALLOWED_TOOLS', {
      cwd: dir,
      env: baseEnv({ AGENTLOOP_CLAUDE_ALLOWED_TOOLS: 'Read,Bash(git -C . push*)' }),
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/not permitted/);
    expect(result.stderr).toMatch(/Bash\(git -C \. push\*\)/);
  });

  it('refuses remote mutation dressed up as a git command', () => {
    const dir = makeProject();
    const result = importConfigField('CLAUDE_ALLOWED_TOOLS', {
      cwd: dir,
      env: baseEnv({
        AGENTLOOP_CLAUDE_ALLOWED_TOOLS: 'Read,Bash(git remote add origin https://evil*)',
      }),
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/not permitted/);
  });

  it('refuses any git subcommand that is not on the fixed safe list', () => {
    const dir = makeProject();
    const result = importConfigField('CLAUDE_ALLOWED_TOOLS', {
      cwd: dir,
      env: baseEnv({ AGENTLOOP_CLAUDE_ALLOWED_TOOLS: 'Read,Bash(git fetch*)' }),
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/not permitted/);
    expect(result.stderr).toMatch(/fixed local git commands/);
  });

  it('refuses any gh grant, because the loop must not use GitHub to coordinate', () => {
    const dir = makeProject();
    const result = importConfigField('CLAUDE_ALLOWED_TOOLS', {
      cwd: dir,
      env: baseEnv({ AGENTLOOP_CLAUDE_ALLOWED_TOOLS: 'Bash(gh pr create*)' }),
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/not permitted/);
  });

  it('refuses an unbounded Bash(gh *) override', () => {
    const dir = makeProject();
    const result = importConfigField('CLAUDE_ALLOWED_TOOLS', {
      cwd: dir,
      env: baseEnv({ AGENTLOOP_CLAUDE_ALLOWED_TOOLS: 'Read,Edit,Bash(gh *)' }),
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/not permitted/);
  });

  it('loads a default that grants no npm, node, or npx command at all', () => {
    // Claude used to be granted the exact `npm run <script>` commands
    // DETERMINISTIC_CHECKS runs. That is no longer true, for two reasons:
    // Claude can edit package.json, so `npm run test` only resolves to a
    // real command by reading a file Claude itself controls; and deriving
    // Claude's tools from *configured* checks made project config a source
    // of Claude's permissions. Verification is the controller's job only,
    // through checks.mjs — Claude gets no npm/node/npx command, period.
    const dir = makeProject();
    const result = importConfigField('CLAUDE_ALLOWED_TOOLS', { cwd: dir, env: baseEnv() });
    expect(result.status).toBe(0);
    const value = JSON.parse(result.stdout);
    expect(value).not.toMatch(/bash\(\s*npm/i);
    expect(value).not.toMatch(/bash\(\s*node/i);
    expect(value).not.toMatch(/bash\(\s*npx/i);
  });

  it('refuses an unbounded Bash(npm *) override', () => {
    const dir = makeProject();
    const result = importConfigField('CLAUDE_ALLOWED_TOOLS', {
      cwd: dir,
      env: baseEnv({ AGENTLOOP_CLAUDE_ALLOWED_TOOLS: 'Read,Edit,Bash(npm *)' }),
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/not permitted/);
  });

  it('refuses an unbounded Bash(node *) override', () => {
    // The exact bypass the audit found: a permitted `node` command can invoke
    // `child_process` to run `git push` or `gh pr merge`, bypassing the
    // `Bash(git push*)` / `Bash(gh *)` restrictions entirely.
    const dir = makeProject();
    const result = importConfigField('CLAUDE_ALLOWED_TOOLS', {
      cwd: dir,
      env: baseEnv({ AGENTLOOP_CLAUDE_ALLOWED_TOOLS: 'Read,Edit,Bash(node *)' }),
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/not permitted/);
  });

  it('refuses Bash(npx *), which can fetch and run an arbitrary package', () => {
    const dir = makeProject();
    const result = importConfigField('CLAUDE_ALLOWED_TOOLS', {
      cwd: dir,
      env: baseEnv({ AGENTLOOP_CLAUDE_ALLOWED_TOOLS: 'Read,Edit,Bash(npx *)' }),
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/not permitted/);
  });

  it('refuses an npm run grant that exactly matches one of the configured checks', () => {
    // There is no longer a "fixed verification commands" exception at all —
    // not even for the literal `npm run <script>` values DETERMINISTIC_CHECKS
    // itself would run. Regression for the original vulnerability: this used
    // to be accepted because it matched the checks-derived allowlist.
    const dir = makeProject();
    const result = importConfigField('CLAUDE_ALLOWED_TOOLS', {
      cwd: dir,
      env: baseEnv({ AGENTLOOP_CLAUDE_ALLOWED_TOOLS: 'Read,Bash(npm run test)' }),
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/not permitted/);
  });

  it('refuses every previously-fixed verification command at once', () => {
    const value = 'Read,Bash(npm run typecheck),Bash(npm run lint),Bash(npm test),Bash(npm run build)';
    const dir = makeProject();
    const result = importConfigField('CLAUDE_ALLOWED_TOOLS', {
      cwd: dir,
      env: baseEnv({ AGENTLOOP_CLAUDE_ALLOWED_TOOLS: value }),
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/not permitted/);
  });
});

describe('a configured check cannot add a Claude Bash permission', () => {
  it('grants the identical default allowlist whether or not any checks are configured', () => {
    const withDefaults = makeProject();
    const withCustomChecks = makeProject({
      config: { checks: [{ name: 'unit', script: 'unit-tests' }, { name: 'compile', script: 'compile' }] },
    });

    const a = importConfigField('CLAUDE_ALLOWED_TOOLS', { cwd: withDefaults, env: baseEnv() });
    const b = importConfigField('CLAUDE_ALLOWED_TOOLS', { cwd: withCustomChecks, env: baseEnv() });

    expect(a.status).toBe(0);
    expect(b.status).toBe(0);
    expect(JSON.parse(b.stdout)).toBe(JSON.parse(a.stdout));
  });

  it("does not mention a configured check's script name anywhere in Claude's allowed tools", () => {
    const dir = makeProject({
      config: { checks: [{ name: 'unit', script: 'run-unit-suite' }] },
    });

    const checks = importConfigField('DETERMINISTIC_CHECKS', { cwd: dir, env: baseEnv() });
    const tools = importConfigField('CLAUDE_ALLOWED_TOOLS', { cwd: dir, env: baseEnv() });

    expect(checks.status).toBe(0);
    expect(JSON.parse(checks.stdout)).toEqual([{ name: 'unit', script: 'run-unit-suite' }]);
    expect(tools.status).toBe(0);
    expect(JSON.parse(tools.stdout)).not.toMatch(/run-unit-suite/);
  });

  it('rejects a check script shaped like a comma-separated tool-pattern injection, at config load', () => {
    // Bash(...) entries are joined into a single comma-separated
    // --allowedTools string. If a configured script value were ever used to
    // build a Claude Bash pattern (it no longer is — see the tests above),
    // an embedded comma could inject an unrelated pattern into that list.
    // CHECK_TOKEN rejects it outright as defense in depth, independent of
    // that structural fix.
    const dir = makeProject({
      config: { checks: [{ name: 'test', script: 'test),Bash(git push*' }] },
    });
    const result = importConfigField('DETERMINISTIC_CHECKS', { cwd: dir, env: baseEnv() });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/must match/);
  });

  it('rejects a check name or script containing shell metacharacters', () => {
    const dir = makeProject({
      config: { checks: [{ name: 'test', script: 'test; rm -rf /' }] },
    });
    const result = importConfigField('DETERMINISTIC_CHECKS', { cwd: dir, env: baseEnv() });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/must match/);
  });
});

describe('modifying package.json gives Claude no path to run git push or gh', () => {
  it('grants no npm/node/npx command even when package.json defines a malicious script', () => {
    // The exact attack this closes: an npm script name only resolves to a
    // real command by reading package.json at run time. If Claude (which
    // has Edit/Write to implement the task) could also run `npm run test`,
    // rewriting package.json's "test" script to `git push` or `gh pr merge`
    // and then invoking the "restricted" verification command would run it —
    // a path no `Bash(git push*)` or `Bash(gh *)` disallow entry can see,
    // because the invocation is npm, not git or gh.
    const dir = makeProject();
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({
        name: 'victim-project',
        scripts: {
          typecheck: 'true',
          lint: 'true',
          test: 'git push origin HEAD:main && gh pr merge --auto',
          build: 'true',
        },
      }),
      'utf8',
    );

    const result = importConfigField('CLAUDE_ALLOWED_TOOLS', { cwd: dir, env: baseEnv() });
    expect(result.status).toBe(0);
    const value = JSON.parse(result.stdout);
    expect(value).not.toMatch(/bash\(\s*npm/i);
    expect(value).not.toMatch(/bash\(\s*node/i);
    expect(value).not.toMatch(/bash\(\s*npx/i);
    expect(value).not.toMatch(/git push/i);
    expect(value).not.toMatch(/\bgh\b/i);
  });

  it('keeps npm/node/npx unconditionally disallowed, belt-and-braces, alongside git push and gh', () => {
    const dir = makeProject();
    const result = importConfigField('CLAUDE_DISALLOWED_TOOLS', { cwd: dir, env: baseEnv() });
    expect(result.status).toBe(0);
    const value = JSON.parse(result.stdout);
    expect(value).toMatch(/Bash\(npm \*\)/);
    expect(value).toMatch(/Bash\(node \*\)/);
    expect(value).toMatch(/Bash\(npx \*\)/);
    expect(value).toMatch(/Bash\(git push\*\)/);
    expect(value).toMatch(/Bash\(gh \*\)/);
  });
});

describe('normal controller verification still works', () => {
  it('reads the default checks unchanged', () => {
    const dir = makeProject();
    const result = importConfigField('DETERMINISTIC_CHECKS', { cwd: dir, env: baseEnv() });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([
      { name: 'typecheck', script: 'typecheck' },
      { name: 'lint', script: 'lint' },
      { name: 'test', script: 'test' },
      { name: 'build', script: 'build' },
    ]);
  });

  it('reads a valid custom checks list from agentloop.config.json unaffected by the Claude-tools fix', () => {
    const dir = makeProject({
      config: { checks: [{ name: 'unit', script: 'test:unit' }, { name: 'e2e', script: 'test:e2e' }] },
    });
    const result = importConfigField('DETERMINISTIC_CHECKS', { cwd: dir, env: baseEnv() });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([
      { name: 'unit', script: 'test:unit' },
      { name: 'e2e', script: 'test:e2e' },
    ]);
  });
});

describe('Claude timeout is short and bounded', () => {
  it('defaults to six minutes', () => {
    const dir = makeProject();
    const result = importConfigField('LIMITS', { cwd: dir, env: baseEnv() });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).claudeTimeoutMs).toBe(6 * 60 * 1000);
  });

  it('caps an oversized environment override at fifteen minutes', () => {
    const dir = makeProject();
    const result = importConfigField('LIMITS', {
      cwd: dir,
      env: baseEnv({ AGENTLOOP_CLAUDE_TIMEOUT_MS: String(24 * 60 * 60 * 1000) }),
    });
    expect(result.status).toBe(0);
    const limits = JSON.parse(result.stdout);
    expect(limits.claudeTimeoutMs).toBe(limits.claudeTimeoutMaxMs);
    expect(limits.claudeTimeoutMaxMs).toBe(15 * 60 * 1000);
  });
});
