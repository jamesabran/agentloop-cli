/**
 * Recover every AgentLoop CLI option from npm's Windows PowerShell argument
 * loss — the single place this normalization happens, for every entry point
 * (`bin/agentloop.mjs`, `controller.mjs`'s direct invocation, `dry-run.mjs`).
 *
 * `npm run <script> -- --task 4 --branch <name> --recover`, typed at a
 * Windows PowerShell prompt, can lose those flag *names* entirely.
 * PowerShell's native argument passing drops a bare `--` when it is
 * immediately followed by another `--`-prefixed token — eating npm's own
 * script/args separator along with the first flag. Once that separator is
 * gone, npm parses everything after it as its own (unrecognized) CLI config
 * flags instead of forwarding them to the script verbatim: an unknown
 * `--task 4` becomes the boolean config `npm_config_task=true` plus a stray
 * bare `4` in argv (npm does not know `--task` takes a value), and
 * `--task=4` becomes `npm_config_task=4` directly with no bare value at all.
 * A no-value flag like `--recover` always degrades to the boolean config
 * `npm_config_recover=true`, with no bare value left behind.
 *
 * Crucially, this loss can be *partial*: only the flag immediately after the
 * separator is eaten, so a command with several flags after `--` can come
 * through as a mix of real survivors and orphaned bare values —
 * `--task 4 --verbose` can arrive as `['4', '--verbose']`, not as an
 * all-or-nothing loss of everything. `npm_config_task=true` is what proves
 * `4` is `--task`'s orphaned value rather than an ordinary (invalid) bare
 * argument; nothing here ever reinterprets a bare token as a recovered
 * value without that proof.
 *
 * This reconstructs every option `controller.mjs`'s `parseArgs` accepts —
 * `--task`, `--brief`, `--branch` (value options), and `--dry-run`,
 * `--next`, `--recover`, `--self-check`, `--verbose`, `--help` (boolean options).
 * Explicit argv always wins: a flag already present — whether or not
 * anything else nearby was swallowed — is never re-added, overwritten, or
 * treated as available for recovery. A boolean option is only ever
 * reconstructed from an *exact* `npm_config_<option>=true`, never inferred
 * from another option's recovery or from any other truthy-looking value
 * (`'1'`, `'yes'`, and so on do not count, and neither do falsy-looking
 * strings like `'false'` or `'0'` — npm always represents "flag was seen"
 * as the literal string `'true'`, so nothing else means "enabled").
 */

/**
 * Options that take a value, recovered as `--flag <value>`.
 *
 * Declaration order matters only when npm boolean-izes more than one of
 * these in the same invocation: the orphaned bare values are claimed in
 * this array's order, matching the documented invocation (`--task <id>
 * --brief <file> --branch <name>`, per controller.mjs's USAGE text), since
 * npm's fallout preserves each orphan's position in argv but carries no
 * link back to which flag it belonged to.
 */
const VALUE_OPTIONS = [
  { flag: '--task', configKey: 'npm_config_task' },
  { flag: '--brief', configKey: 'npm_config_brief' },
  { flag: '--branch', configKey: 'npm_config_branch' },
  { flag: '--push-mode', configKey: 'npm_config_push_mode' },
];

/** Options that take no value — bare flags, recovered only from an exact `'true'`. */
const BOOLEAN_OPTIONS = [
  { flag: '--dry-run', configKey: 'npm_config_dry_run' },
  { flag: '--next', configKey: 'npm_config_next' },
  { flag: '--recover', configKey: 'npm_config_recover' },
  { flag: '--self-check', configKey: 'npm_config_self_check' },
  { flag: '--verbose', configKey: 'npm_config_verbose' },
  { flag: '--help', configKey: 'npm_config_help' },
];

const VALUE_FLAG_NAMES = new Set(VALUE_OPTIONS.map((option) => option.flag));

/** Is `token` present, either bare or as `token=value`? */
function hasOption(args, option) {
  return args.includes(option) || args.some((arg) => arg.startsWith(`${option}=`));
}

/**
 * The rawArgs indices that are "orphan" bare values: not a `--`-prefixed
 * token, and not the value already attached to a literal `--task`/`--brief`/
 * `--branch` token present earlier in the same array (mirroring
 * `parseArgs`'s own `argv[i + 1]` indexing — that token belongs to the flag
 * right before it, whatever it looks like, and is never available for
 * recovery). Everything else that is not a flag is a candidate: it either
 * gets claimed below by a specific swallowed option's `npm_config_*=true`
 * marker, or — with no marker to justify reinterpreting it — is left
 * exactly where it was, still invalid.
 */
function orphanBareIndices(rawArgs) {
  const indices = [];
  for (let i = 0; i < rawArgs.length; i += 1) {
    const token = rawArgs[i];
    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      const name = eq === -1 ? token : token.slice(0, eq);
      if (eq === -1 && VALUE_FLAG_NAMES.has(name)) i += 1; // skip its attached value
      continue;
    }
    indices.push(i);
  }
  return indices;
}

/**
 * Recover every supported CLI option from npm's Windows argument loss.
 *
 * @param {string[]} rawArgs the process's own argv, as received
 * @param {Record<string, string|undefined>} [env] defaults to `process.env`
 * @returns {string[]}
 */
export function recoverCliArgs(rawArgs, env = process.env) {
  const orphanIndices = orphanBareIndices(rawArgs);
  const claimedFlagByIndex = new Map();
  const directAppends = [];
  let orphanPointer = 0;

  for (const { flag, configKey } of VALUE_OPTIONS) {
    if (hasOption(rawArgs, flag)) continue;

    const raw = env[configKey];
    if (raw === 'true') {
      // Only a token npm itself marked as this option's fallout — never an
      // ordinary bare positional — is ever claimed.
      if (orphanPointer < orphanIndices.length) {
        claimedFlagByIndex.set(orphanIndices[orphanPointer], flag);
        orphanPointer += 1;
      }
    } else if (raw) {
      // The `--flag=value` fallout spelling: a direct value with no orphan
      // token to replace, so it is appended rather than spliced in place.
      directAppends.push(flag, raw);
    }
  }

  // Rebuild argv positionally: a claimed orphan becomes `--flag <value>` in
  // its original place; every other token — flags, their attached values,
  // and unclaimed (unproven, still invalid) bare values — passes through
  // unchanged.
  const args = [];
  for (let i = 0; i < rawArgs.length; i += 1) {
    const claimedFlag = claimedFlagByIndex.get(i);
    if (claimedFlag) args.push(claimedFlag, rawArgs[i]);
    else args.push(rawArgs[i]);
  }
  args.push(...directAppends);

  for (const { flag, configKey } of BOOLEAN_OPTIONS) {
    if (!hasOption(args, flag) && env[configKey] === 'true') args.push(flag);
  }

  return args;
}
