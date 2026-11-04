#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { createEngineGateway, dataDirFromEnv } from './engine-gateway.ts';
import { main } from './main.ts';

process.exitCode = await main(
  process.argv.slice(2),
  {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    lines: {
      [Symbol.asyncIterator]: () => createInterface({ input: process.stdin, terminal: false })[Symbol.asyncIterator](),
    },
  },
  createEngineGateway(dataDirFromEnv()),
);
