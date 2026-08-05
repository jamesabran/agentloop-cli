#!/usr/bin/env node
/**
 * `agentloop` CLI entry point.
 *
 * A thin wrapper around the controller: recovers `--task`/`--branch` from
 * npm's Windows argument loss (see lib/npm-args.mjs), then hands off to
 * controller.mjs's `main`.
 */

import process from 'node:process';

import { main } from '../src/controller.mjs';
import { recoverTaskAndBranch } from '../src/lib/npm-args.mjs';

main(recoverTaskAndBranch(process.argv.slice(2))).then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  },
);
