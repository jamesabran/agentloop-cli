// @vitest-environment node
/**
 * `publishBranch` is the only network write the loop makes, and it must land
 * on `REPO` and nowhere else.
 *
 * `checkAuth()` (in `github.mjs`) only confirms the `gh` CLI's own
 * credentials can see the right repository — a separate channel from git's
 * `origin` remote, which is what actually gets pushed to. Before
 * `assertRemoteMatchesRepo`, nothing checked that `origin` still pointed at
 * `REPO`: a repointed remote would let `git push origin <sha>:refs/heads/<b>`
 * succeed against whatever `origin` had become, silently breaking the
 * repository boundary.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { assertRemoteMatchesRepo, parseGithubOwnerRepo } from './git.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const tempDirs = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe('parseGithubOwnerRepo', () => {
  it('parses an https URL with the .git suffix', () => {
    expect(parseGithubOwnerRepo('https://github.com/example-org/example-repo.git')).toBe(
      'example-org/example-repo',
    );
  });

  it('parses an https URL without the .git suffix', () => {
    expect(parseGithubOwnerRepo('https://github.com/example-org/example-repo')).toBe(
      'example-org/example-repo',
    );
  });

  it('parses a scp-style ssh URL', () => {
    expect(parseGithubOwnerRepo('git@github.com:example-org/example-repo.git')).toBe(
      'example-org/example-repo',
    );
  });

  it('parses an ssh:// URL', () => {
    expect(parseGithubOwnerRepo('ssh://git@github.com/example-org/example-repo.git')).toBe(
      'example-org/example-repo',
    );
  });

  it('lower-cases the result, since GitHub owner/repo names are case-insensitive', () => {
    expect(parseGithubOwnerRepo('https://github.com/Example-Org/Example-Repo.git')).toBe(
      'example-org/example-repo',
    );
  });

  it('tolerates a trailing slash', () => {
    expect(parseGithubOwnerRepo('https://github.com/example-org/example-repo/')).toBe(
      'example-org/example-repo',
    );
  });

  it('does not match a different repository', () => {
    expect(parseGithubOwnerRepo('https://github.com/someone/else.git')).toBe('someone/else');
  });

  it('returns null for a non-GitHub remote', () => {
    expect(parseGithubOwnerRepo('https://gitlab.com/example-org/example-repo.git')).toBeNull();
  });

  it('returns null for a null or missing remote', () => {
    expect(parseGithubOwnerRepo(null)).toBeNull();
    expect(parseGithubOwnerRepo(undefined)).toBeNull();
  });
});

describe('assertRemoteMatchesRepo', () => {
  it('resolves without throwing when origin is the repository this checkout actually has', async () => {
    // REPO is resolved from this project's own `origin` remote (or
    // agentloop.config.json) at load time, so it is always the ground truth
    // `assertRemoteMatchesRepo` checks against — this proves the two stay in
    // agreement for whatever project the controller happens to be running in.
    await expect(assertRemoteMatchesRepo()).resolves.toBeUndefined();
  });
});

describe('publishBranch rejects a repointed remote before any push', () => {
  // A child process imports the real production publishBranch() so the
  // test covers the exact path automatic publication uses, with no mocks
  // or replacements between the import and the rejection.
  it('rejects when the push remote does not match the pinned repository', () => {
    var project = fs.mkdtempSync(path.join(os.tmpdir(), 'agentloop-git-pub-'));
    tempDirs.push(project);

    spawnSync('git', ['init', '--quiet'], { cwd: project });
    spawnSync('git', ['config', 'user.email', 'test@test.test'], { cwd: project });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: project });
    fs.writeFileSync(path.join(project, 'README.md'), 'test', 'utf8');
    spawnSync('git', ['add', 'README.md'], { cwd: project });
    spawnSync('git', ['commit', '-m', 'initial', '--quiet'], { cwd: project });

    var head = spawnSync('git', ['rev-parse', 'HEAD'], {
      cwd: project, encoding: 'utf8',
    }).stdout.trim();

    // A local bare repository is the push-receiving target.  If a push
    // were attempted it would create a ref here; the test asserts the
    // bare repository stays empty, proving publishBranch rejected
    // before any push was attempted.
    var bareDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentloop-bare-'));
    tempDirs.push(bareDir);
    spawnSync('git', ['init', '--bare', '--quiet', bareDir]);

    // Point origin at the bare repository — a target that CAN receive
    // pushes (observable) but whose URL does not parse as a GitHub
    // repository and will never match the pinned REPO.
    spawnSync('git', ['remote', 'add', 'origin', bareDir], { cwd: project });

    // The pinned repository boundary that publishBranch must honour.
    var pinnedRepo = 'expected-owner/expected-repo';

    var gitUrl = pathToFileURL(path.resolve(HERE, 'git.mjs')).href;

    var testScript = ''
      + 'import { publishBranch } from ' + JSON.stringify(gitUrl) + ';\n'
      + '\n'
      + 'var HEAD = ' + JSON.stringify(head) + ';\n'
      + 'var BRANCH = ' + JSON.stringify('feature/test') + ';\n'
      + '\n'
      + 'try {\n'
      + '  await publishBranch({ branch: BRANCH, head: HEAD });\n'
      + '  process.stdout.write(JSON.stringify({ ok: false, error: "publishBranch did not throw" }));\n'
      + '} catch (e) {\n'
      + '  process.stdout.write(JSON.stringify({\n'
      + '    ok: true,\n'
      + '    message: e.message,\n'
      + '    constructorName: e.constructor.name,\n'
      + '  }));\n'
      + '}\n';

    var scriptFile = path.join(os.tmpdir(), 'test-publish-branch.mjs');
    fs.writeFileSync(scriptFile, testScript, 'utf8');

    var result = spawnSync(
      process.execPath,
      [scriptFile],
      {
        cwd: project,
        env: { ...process.env, AGENTLOOP_REPO: pinnedRepo },
        encoding: 'utf8',
        timeout: 15000,
      },
    );

    expect(result.status).toBe(0);

    var jsonStart = result.stdout.indexOf('{"ok":');
    expect(jsonStart).not.toBe(-1);
    var data = JSON.parse(result.stdout.slice(jsonStart));
    expect(data.ok).toBe(true);

    // The error identifies a repository-target mismatch.
    expect(data.message).toMatch(/Refusing to publish/);
    expect(data.message).toMatch(/expected-owner\/expected-repo/);

    // Prove no push was attempted: the bare repository has zero refs.
    var lsRemote = spawnSync('git', ['ls-remote', bareDir], { encoding: 'utf8' });
    expect(lsRemote.stdout.trim()).toBe('');
  });
});
