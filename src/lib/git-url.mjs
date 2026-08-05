/**
 * Parsing for git remote URLs.
 *
 * Split out from git.mjs so config.mjs can resolve the project's repository
 * boundary from its git remote without importing git.mjs itself (which in
 * turn imports config.mjs, for REPO_ROOT and the other resolved values).
 */

/**
 * Extract `owner/repo` from a GitHub remote URL, in any form `git remote
 * get-url` can return (`https://github.com/owner/repo.git`,
 * `git@github.com:owner/repo.git`, `ssh://git@github.com/owner/repo`, with or
 * without the `.git` suffix or a trailing slash). Returns `null` if the URL
 * does not point at github.com at all.
 */
export function parseGithubOwnerRepo(url) {
  const match = /github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(String(url ?? ''));
  return match ? `${match[1]}/${match[2]}`.toLowerCase() : null;
}
