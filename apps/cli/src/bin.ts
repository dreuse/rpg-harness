#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { on } from 'node:events';
import { createInterface, emitKeypressEvents, type Key } from 'node:readline';
import { dataDirFromEnv, firstRunProblem } from './setup-check.ts';
import { capabilitiesOf, motionOf } from './tui.ts';

const KEYPRESS = 'keypress';
const EXIT_SETUP_FAILURE = 1;
const UPDATE_COMMAND = 'update';

const lines: AsyncIterable<string> = {
  [Symbol.asyncIterator]: () => {
    const isTerminal = process.stdin.isTTY === true;
    const readline = createInterface({
      input: process.stdin,
      output: isTerminal ? process.stdout : undefined,
      terminal: isTerminal,
    });
    const iterator = readline[Symbol.asyncIterator]();
    return {
      next: () => iterator.next(),
      return: async () => {
        readline.close();
        return { done: true, value: undefined };
      },
    };
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
  const [
    { campaignDatabases, createEngineGateway },
    { main },
    { defaultUpdateContext, holdSession, startupUpdate },
    { printable },
  ] = await Promise.all([
    import('./engine-gateway.ts'),
    import('./main.ts'),
    import('./update.ts'),
    import('./views.ts'),
  ]);
  process.on('exit', holdSession(dataDir));
  const startup = await startupUpdate(
    defaultUpdateContext(dataDir, () => campaignDatabases(dataDir)),
    { check: process.argv[2] !== UPDATE_COMMAND },
  );
  for (const message of startup.messages) process.stderr.write(`${printable(message)}\n`);
  const capabilities = capabilitiesOf(process.env, process.stdin, process.stdout);
  process.exitCode = startup.restart
    ? (spawnSync(process.execPath, [...process.execArgv, ...process.argv.slice(1)], { stdio: 'inherit' }).status ??
      EXIT_SETUP_FAILURE)
    : await main(
        process.argv.slice(2),
        {
          stdout,
          stderr: (text) => process.stderr.write(text),
          lines,
          terminal: {
            capabilities,
            motion: motionOf(process.env, capabilities),
            keys: { [Symbol.asyncIterator]: keypresses },
            lines,
            write: stdout,
          },
        },
        createEngineGateway(dataDir),
      );
}
