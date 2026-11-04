#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { dataDirFromEnv, firstRunProblem } from './setup-check.ts';

const EXIT_SETUP_FAILURE = 1;
const dataDir = dataDirFromEnv();
const problem = firstRunProblem(dataDir);

if (problem !== undefined) {
  process.stderr.write(`${problem}\n`);
  process.exitCode = EXIT_SETUP_FAILURE;
} else {
  const [{ createEngineGateway }, { main }] = await Promise.all([import('./engine-gateway.ts'), import('./main.ts')]);
  process.exitCode = await main(
    process.argv.slice(2),
    {
      stdout: (text) => process.stdout.write(text),
      stderr: (text) => process.stderr.write(text),
      lines: {
        [Symbol.asyncIterator]: () => {
          const isTerminal = process.stdin.isTTY === true;
          const readline = createInterface({
            input: process.stdin,
            output: isTerminal ? process.stdout : undefined,
            terminal: isTerminal,
          });
          return readline[Symbol.asyncIterator]();
        },
      },
    },
    createEngineGateway(dataDir),
  );
}
