#!/usr/bin/env node
import { on } from 'node:events';
import { createInterface, emitKeypressEvents, type Key } from 'node:readline';
import { dataDirFromEnv, firstRunProblem } from './setup-check.ts';
import { capabilitiesOf } from './tui.ts';

const KEYPRESS = 'keypress';
const EXIT_SETUP_FAILURE = 1;

const lines: AsyncIterable<string> = {
  [Symbol.asyncIterator]: () => {
    const isTerminal = process.stdin.isTTY === true;
    const readline = createInterface({
      input: process.stdin,
      output: isTerminal ? process.stdout : undefined,
      terminal: isTerminal,
    });
    return readline[Symbol.asyncIterator]();
  },
};

const keypresses = async function* (): AsyncGenerator<Key> {
  emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  try {
    for await (const [, key] of on(process.stdin, KEYPRESS)) yield key ?? {};
  } finally {
    process.stdin.setRawMode(false);
    process.stdin.pause();
  }
};

const stdout = (text: string) => process.stdout.write(text);

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
      stdout,
      stderr: (text) => process.stderr.write(text),
      lines,
      terminal: {
        capabilities: capabilitiesOf(process.env, process.stdin, process.stdout),
        keys: { [Symbol.asyncIterator]: keypresses },
        lines,
        write: stdout,
      },
    },
    createEngineGateway(dataDir),
  );
}
