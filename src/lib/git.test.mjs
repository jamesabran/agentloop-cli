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
import { describe, expect, it } from 'vitest';

import { assertRemoteMatchesRepo, parseGithubOwnerRepo } from './git.mjs';

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
