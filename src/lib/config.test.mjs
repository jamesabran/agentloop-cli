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

  it('loads a default that enumerates specific npm verification commands, not a wildcard', () => {
    // `Bash(npm *)` and `Bash(node *)` used to be granted here. Both are far
    // too wide: `npm *` also admits `npm run agent` — the controller itself,
    // which can push and call `gh` — and `node *` lets Claude run any script
    // that shells out to `git push` or `gh` through `child_process`, which no
    // `Bash(git push*)` or `Bash(gh *)` disallow entry can see because the
    // invocation is Node, not git or gh.
    const dir = makeProject();
    const result = importConfigField('CLAUDE_ALLOWED_TOOLS', { cwd: dir, env: baseEnv() });
    expect(result.status).toBe(0);
    const value = JSON.parse(result.stdout);
    expect(value).not.toMatch(/Bash\(npm \*\)/);
    expect(value).not.toMatch(/Bash\(node \*\)/);
    expect(value).toMatch(/Bash\(npm run typecheck\)/);
    expect(value).toMatch(/Bash\(npm run lint\)/);
    expect(value).toMatch(/Bash\(npm run build\)/);
  });

  it('refuses an unbounded Bash(npm *) override', () => {
    const dir = makeProject();
    const result = importConfigField('CLAUDE_ALLOWED_TOOLS', {
      cwd: dir,
      env: baseEnv({ AGENTLOOP_CLAUDE_ALLOWED_TOOLS: 'Read,Edit,Bash(npm *)' }),
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/not permitted/);
    expect(result.stderr).toMatch(/fixed verification commands/);
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
    expect(result.stderr).toMatch(/fixed verification commands/);
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

  it('refuses an npm script that is not on the fixed verification list', () => {
    const dir = makeProject();
    const result = importConfigField('CLAUDE_ALLOWED_TOOLS', {
      cwd: dir,
      env: baseEnv({ AGENTLOOP_CLAUDE_ALLOWED_TOOLS: 'Read,Bash(npm run agent*)' }),
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/not permitted/);
    expect(result.stderr).toMatch(/fixed verification commands/);
  });

  it('accepts the exact fixed verification commands', () => {
    const value = 'Read,Bash(npm run typecheck),Bash(npm run lint),Bash(npm test),Bash(npm run build)';
    const dir = makeProject();
    const result = importConfigField('CLAUDE_ALLOWED_TOOLS', {
      cwd: dir,
      env: baseEnv({ AGENTLOOP_CLAUDE_ALLOWED_TOOLS: value }),
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toBe(value);
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
