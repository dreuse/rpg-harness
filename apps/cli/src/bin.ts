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
  createEngineGateway(dataDirFromEnv()),
);
