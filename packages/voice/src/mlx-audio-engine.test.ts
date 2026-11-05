import assert from 'node:assert/strict';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import {
  createMlxAudioEngine,
  createMlxAudioProvider,
  MLX_AUDIO_MODEL_REVISION,
  MLX_AUDIO_SERVICE_SOURCE,
  MLX_KOKORO_CAPABILITIES,
  MLX_KOKORO_PROVIDER_ID,
  mlxAudioPaths,
  mlxAudioSupported,
} from './mlx-audio-engine.ts';

const PORT = 41234;
const SENTENCE = 'Fala baixo.';
const VOICE = 'pf_dora';
const SPEED = 1;
const WAV_BYTES = new Uint8Array([82, 73, 70, 70]);
const START_TIMEOUT_MS = 50;
const SECRET_ENV = 'RPG_VOICE_CLOUD_API_KEY';

interface FakeChild extends EventEmitter {
  readonly stdin: PassThrough;
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
  killed: boolean;
  kill(): boolean;
}

interface Spawned {
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
  setImmediate(() => child.stdout.write(`Creating pipeline\nREADY ${PORT}\n`));
};

const fakeSpawn = (behaviour: Behaviour = announceReady) => {
  const spawned: Spawned[] = [];
  const spawn = (command: string, args: readonly string[], options: SpawnOptions): ChildProcess => {
    const child = fakeChild();
    spawned.push({ command, args, options, child });
    behaviour(child);
    return child as unknown as ChildProcess;
  };
  return { spawned, spawn };
};

interface FetchCall {
  readonly url: string;
  readonly init: RequestInit;
}

const fakeFetch = (status = 200) => {
  const calls: FetchCall[] = [];
  const fetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(status === 200 ? WAV_BYTES : null, { status });
  };
  return { calls, fetch: fetch as typeof globalThis.fetch };
};

const withDir = async (run: (dir: string) => Promise<void>): Promise<void> => {
  const dir = mkdtempSync(join(tmpdir(), 'rpg-mlx-audio-'));
  try {
    await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const install = (dir: string): void => {
  const paths = mlxAudioPaths(dir);
  for (const file of [paths.python, paths.weights]) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '');
  }
};

const signal = () => new AbortController().signal;

test('runs only on Apple Silicon Macs', () => {
  assert.equal(mlxAudioSupported('darwin', 'arm64'), true);
  assert.equal(mlxAudioSupported('darwin', 'x64'), false);
  assert.equal(mlxAudioSupported('linux', 'arm64'), false);
  assert.equal(mlxAudioSupported('win32', 'x64'), false);
});

test('is ready only on Apple Silicon with the venv and the pinned model installed', async () => {
  await withDir(async (dir) => {
    const engine = createMlxAudioEngine({ dir, platform: 'darwin', arch: 'arm64' });
    assert.equal(engine.ready(), false);
    install(dir);
    assert.equal(engine.ready(), true);
    assert.equal(createMlxAudioEngine({ dir, platform: 'linux', arch: 'x64' }).ready(), false);
  });
});

test('the provider speaks Brazilian Portuguese with the Kokoro pt-BR voices', () => {
  assert.equal(MLX_KOKORO_PROVIDER_ID, 'kokoro-mlx');
  assert.deepEqual(MLX_KOKORO_CAPABILITIES.languages, ['pt-BR']);
  assert.deepEqual(MLX_KOKORO_CAPABILITIES.voices, ['pf_dora', 'pm_alex', 'pm_santa']);
  const provider = createMlxAudioProvider({ dir: tmpdir(), platform: 'linux', arch: 'x64' });
  assert.equal(provider.id, MLX_KOKORO_PROVIDER_ID);
  assert.equal(provider.locality, 'local');
  assert.equal(provider.retention, 'none');
  assert.equal(provider.healthy(), false);
});

test('starts the service with fixed arguments, a token and no inherited secrets', async () => {
  await withDir(async (dir) => {
    process.env[SECRET_ENV] = 'secret';
    try {
      const { spawned, spawn } = fakeSpawn();
      const engine = createMlxAudioEngine({ dir, spawn, fetch: fakeFetch().fetch });
      await engine.load();
      const [{ command, args, options } = assert.fail('not spawned')] = spawned;
      const paths = mlxAudioPaths(dir);
      assert.equal(command, paths.python);
      assert.deepEqual(args, ['-I', paths.service, 'serve']);
      assert.equal(readFileSync(paths.service, 'utf8'), readFileSync(MLX_AUDIO_SERVICE_SOURCE, 'utf8'));
      const env = options.env ?? {};
      assert.equal(env.HF_HOME, paths.hfHome);
      assert.equal(env.HF_HUB_OFFLINE, '1');
      assert.match(env.RPG_MLX_AUDIO_TOKEN ?? '', /^[0-9a-f]{64}$/);
      assert.equal(env[SECRET_ENV], undefined);
      await engine.unload();
    } finally {
      delete process.env[SECRET_ENV];
    }
  });
});

test('sends each sentence to the loopback service with the token and returns the WAV bytes', async () => {
  await withDir(async (dir) => {
    const { spawned, spawn } = fakeSpawn();
    const { calls, fetch } = fakeFetch();
    const engine = createMlxAudioEngine({ dir, spawn, fetch });
    await engine.load();
    const abort = signal();
    assert.deepEqual(await engine.synthesize(SENTENCE, VOICE, abort, SPEED), WAV_BYTES);
    const [call = assert.fail('no request')] = calls;
    assert.equal(call.url, `http://127.0.0.1:${PORT}/synthesize`);
    assert.equal(call.init.method, 'POST');
    assert.equal(call.init.signal, abort);
    const token = spawned[0]?.options.env?.RPG_MLX_AUDIO_TOKEN;
    assert.equal(new Headers(call.init.headers).get('authorization'), `Bearer ${token}`);
    assert.deepEqual(JSON.parse(String(call.init.body)), { text: SENTENCE, voice: VOICE, speed: SPEED });
    assert.equal(spawned[0]?.args.includes(SENTENCE), false);
    await engine.unload();
  });
});

test('a failed synthesis response throws', async () => {
  await withDir(async (dir) => {
    const engine = createMlxAudioEngine({ dir, spawn: fakeSpawn().spawn, fetch: fakeFetch(500).fetch });
    await engine.load();
    await assert.rejects(engine.synthesize(SENTENCE, VOICE, signal(), SPEED), /HTTP 500/);
    await engine.unload();
  });
});

test('load fails with the service error when the service exits before it is ready', async () => {
  await withDir(async (dir) => {
    const { spawn } = fakeSpawn((child) => {
      setImmediate(() => {
        child.stderr.write('ModuleNotFoundError: mlx_audio\n');
        setImmediate(() => child.emit('exit', 1, null));
      });
    });
    const engine = createMlxAudioEngine({ dir, spawn });
    await assert.rejects(engine.load(), /exited with 1.*ModuleNotFoundError: mlx_audio/s);
  });
});

test('load gives up and stops the service after the start timeout', async () => {
  await withDir(async (dir) => {
    const { spawned, spawn } = fakeSpawn(() => {});
    const engine = createMlxAudioEngine({ dir, spawn, startTimeoutMs: START_TIMEOUT_MS });
    await assert.rejects(engine.load(), /did not start/);
    assert.equal(spawned[0]?.child.killed, true);
  });
});

test('unload stops the service and a crashed service restarts on the next sentence', async () => {
  await withDir(async (dir) => {
    const { spawned, spawn } = fakeSpawn();
    const engine = createMlxAudioEngine({ dir, spawn, fetch: fakeFetch().fetch });
    await engine.load();
    spawned[0]?.child.emit('exit', 1, null);
    await engine.synthesize(SENTENCE, VOICE, signal(), SPEED);
    assert.equal(spawned.length, 2);
    await engine.unload();
    assert.equal(spawned[1]?.child.killed, true);
    assert.equal(spawned[1]?.child.stdin.writableEnded, true);
    await assert.rejects(engine.synthesize(SENTENCE, VOICE, signal(), SPEED), /not loaded/);
  });
});

test('the service script binds loopback, pins the model and allows only the provider voices', () => {
  const source = readFileSync(MLX_AUDIO_SERVICE_SOURCE, 'utf8');
  const voices = MLX_KOKORO_CAPABILITIES.voices.map((voice) => `"${voice}"`).join(', ');
  assert.ok(source.includes(`VOICES = {${voices}}`));
  assert.ok(source.includes('HOST = "127.0.0.1"'));
  assert.ok(source.includes(`REVISION = "${MLX_AUDIO_MODEL_REVISION}"`));
});
