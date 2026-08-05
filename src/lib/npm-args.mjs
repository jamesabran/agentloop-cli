/**
 * Recover `--task`/`--branch`/`--recover` from npm's Windows PowerShell
 * argument loss.
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
 * `--recover` takes no value, so it always degrades to the boolean config
 * `npm_config_recover=true` with no bare value left behind.
 *
 * This reconstructs `--task <value>`, `--branch <value>`, and the bare
 * `--recover` flag from whichever shape survived — real flags, or the npm
 * config fallout above — so the documented invocation works either way.
 * `--recover` is only ever reconstructed from an explicit
 * `npm_config_recover=true`; it is never inferred from task/branch recovery
 * or from any other state.
 */
export function recoverTaskAndBranch(rawArgs, env = process.env) {
  const hasOption = (args, option) =>
    args.includes(option) || args.some((arg) => arg.startsWith(`${option}=`));

  // Any surviving `--flag` means npm's separator was intact and nothing was
  // lost; treating already-correct argv as leftover bare values would corrupt it.
  const args = rawArgs.some((arg) => arg.startsWith('--')) ? [...rawArgs] : [];
  const bareValues = args.length === 0 ? [...rawArgs] : [];

  const npmTask = env.npm_config_task === 'true' ? bareValues.shift() : env.npm_config_task;
  const npmBranch = env.npm_config_branch === 'true' ? bareValues.shift() : env.npm_config_branch;

  if (!hasOption(args, '--task') && npmTask) args.push('--task', npmTask);
  if (!hasOption(args, '--branch') && npmBranch) args.push('--branch', npmBranch);
  if (!hasOption(args, '--recover') && env.npm_config_recover === 'true') args.push('--recover');

  return args;
}
