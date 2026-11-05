import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

export const FAKE_PORT = 41234;

export interface FakeChild extends EventEmitter {
  readonly stdin: PassThrough;
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
  killed: boolean;
  kill(): boolean;
}

export interface Spawned {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: SpawnOptions;
  readonly child: FakeChild;
}

const fakeChild = (): FakeChild => {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    killed: false,
    kill: () => {
      child.killed = true;
      queueMicrotask(() => child.emit('exit', null, 'SIGTERM'));
      return true;
    },
  });
  return child;
};

type Behaviour = (child: FakeChild) => void;

const announceReady: Behaviour = (child) => {
  setImmediate(() => child.stdout.write(`Loading\nREADY ${FAKE_PORT}\n`));
};

export const fakeSpawn = (behaviour: Behaviour = announceReady) => {
  const spawned: Spawned[] = [];
  const spawn = (command: string, args: readonly string[], options: SpawnOptions): ChildProcess => {
    const child = fakeChild();
    spawned.push({ command, args, options, child });
    behaviour(child);
    return child as unknown as ChildProcess;
  };
  return { spawned, spawn };
};

export interface FetchCall {
  readonly url: string;
  readonly init: RequestInit;
}

export const FAKE_WAV = new Uint8Array([82, 73, 70, 70]);

export const fakeFetch = (status = 200) => {
  const calls: FetchCall[] = [];
  const fetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(status === 200 ? FAKE_WAV : null, { status });
  };
  return { calls, fetch: fetch as typeof globalThis.fetch };
};
