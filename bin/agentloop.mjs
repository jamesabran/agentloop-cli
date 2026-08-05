#!/usr/bin/env node
/**
 * `agentloop` CLI entry point.
 *
 * A thin wrapper around the controller: recovers every supported CLI option
 * from npm's Windows argument loss (see lib/npm-args.mjs), then hands off to
 * controller.mjs's `main`.
 */

import process from 'node:process';

import { main } from '../src/controller.mjs';
import { recoverCliArgs } from '../src/lib/npm-args.mjs';

main(recoverCliArgs(process.argv.slice(2))).then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  },
);
