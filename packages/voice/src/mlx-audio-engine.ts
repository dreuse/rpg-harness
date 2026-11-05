import { type ChildProcess, spawn as nodeSpawn, type SpawnOptions } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import {
  createKokoroProvider,
  type KokoroCapabilities,
  type KokoroEngine,
  type KokoroProvider,
  type KokoroProviderOptions,
  MLX_KOKORO_CAPABILITIES,
  MLX_KOKORO_PROVIDER_ID,
} from './kokoro-provider.ts';

export { MLX_KOKORO_CAPABILITIES, MLX_KOKORO_PROVIDER_ID };
export const MLX_AUDIO_DIR_ENV = 'RPG_MLX_AUDIO_DIR';
export const MLX_AUDIO_TOKEN_ENV = 'RPG_MLX_AUDIO_TOKEN';
export const MLX_AUDIO_MODEL_ID = 'mlx-community/Kokoro-82M-bf16';
export const MLX_AUDIO_MODEL_REVISION = 'a71e4d38b236d968966a2002c4c895dbd12b1c3c';
export const MLX_AUDIO_START_TIMEOUT_MS = 60_000;
export const MLX_AUDIO_SERVICE_SOURCE = join(import.meta.dirname, 'mlx-audio-service.py');

const APPLE_PLATFORM = 'darwin';
const APPLE_SILICON = 'arm64';
const SERVICE_FILE = 'mlx-audio-service.py';
const SERVE = 'serve';
const ISOLATED = '-I';
const LOOPBACK = '127.0.0.1';
const SYNTHESIZE_PATH = '/synthesize';
const JSON_TYPE = 'application/json';
const OFFLINE = '1';
const TOKEN_BYTES = 32;
const HEX = 'hex';
const READY_LINE = /^READY (\d+)$/;
const STDERR_TAIL_CHARS = 2000;
const STOP_SIGNAL = 'SIGTERM';
const INHERITED_ENV = ['PATH', 'HOME', 'TMPDIR', 'LANG'] as const;
const WEIGHTS_FILE = 'kokoro-v1_0.safetensors';

export const mlxAudioSupported = (platform: string = process.platform, arch: string = process.arch): boolean =>
  platform === APPLE_PLATFORM && arch === APPLE_SILICON;

export const mlxAudioPaths = (dir: string) => {
  const hfHome = join(dir, 'hf');
  return {
    python: join(dir, 'venv', 'bin', 'python'),
    service: join(dir, SERVICE_FILE),
    hfHome,
    weights: join(
      hfHome,
      'hub',
      `models--${MLX_AUDIO_MODEL_ID.replace('/', '--')}`,
      'snapshots',
      MLX_AUDIO_MODEL_REVISION,
      WEIGHTS_FILE,
    ),
  };
};

export const mlxAudioInstalled = (dir: string): boolean => {
  const { python, weights } = mlxAudioPaths(dir);
  return existsSync(python) && existsSync(weights);
};

export const inheritedEnv = (): Record<string, string> =>
  Object.fromEntries(
    INHERITED_ENV.flatMap((name) => (process.env[name] === undefined ? [] : [[name, process.env[name]]])),
  );

export type ServiceSpawn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

export interface MlxAudioEngineOptions {
  readonly dir: string;
  readonly spawn?: ServiceSpawn;
  readonly fetch?: typeof fetch;
  readonly platform?: string;
  readonly arch?: string;
  readonly startTimeoutMs?: number;
}

interface Service {
  readonly child: ChildProcess;
  readonly origin: string;
  readonly token: string;
}

const waitForPort = (child: ChildProcess, timeoutMs: number): Promise<number> =>
  new Promise((resolve, reject) => {
    if (!child.stdout) {
      child.kill(STOP_SIGNAL);
      reject(new Error('mlx-audio service has no stdout'));
      return;
    }
    let stderr = '';
    const lines = createInterface({ input: child.stdout });
    const onStderr = (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-STDERR_TAIL_CHARS);
    };
    const finish = () => {
      clearTimeout(timer);
      lines.off('line', onLine);
      lines.close();
      child.stderr?.off('data', onStderr);
      child.off('exit', onExit);
      child.off('error', onError);
      child.stdout?.resume();
      child.stderr?.resume();
    };
    const fail = (message: string) => {
      finish();
      child.kill(STOP_SIGNAL);
      reject(new Error(message));
    };
    const onLine = (line: string) => {
      const port = READY_LINE.exec(line)?.[1];
      if (port === undefined) return;
      finish();
      resolve(Number(port));
    };
    const onExit = (code: number | null) =>
      fail(`mlx-audio service exited with ${code} before it was ready: ${stderr}`);
    const onError = (error: Error) => fail(`mlx-audio service could not start: ${error.message}`);
    const timer = setTimeout(() => fail(`mlx-audio service did not start within ${timeoutMs} ms`), timeoutMs);
    lines.on('line', onLine);
    child.stderr?.on('data', onStderr);
    child.once('exit', onExit);
    child.once('error', onError);
  });

export const createMlxAudioEngine = ({
  dir,
  spawn = nodeSpawn,
  fetch: fetchAudio = fetch,
  platform,
  arch,
  startTimeoutMs = MLX_AUDIO_START_TIMEOUT_MS,
}: MlxAudioEngineOptions): KokoroEngine => {
  const paths = mlxAudioPaths(dir);
  let loaded = false;
  let service: Service | undefined;

  const start = async (): Promise<Service> => {
    await mkdir(dir, { recursive: true });
    await copyFile(MLX_AUDIO_SERVICE_SOURCE, paths.service);
    const token = randomBytes(TOKEN_BYTES).toString(HEX);
    const child = spawn(paths.python, [ISOLATED, paths.service, SERVE], {
      env: { ...inheritedEnv(), HF_HOME: paths.hfHome, HF_HUB_OFFLINE: OFFLINE, [MLX_AUDIO_TOKEN_ENV]: token },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const port = await waitForPort(child, startTimeoutMs);
    const started = { child, origin: `http://${LOOPBACK}:${port}`, token };
    child.once('exit', () => {
      if (service === started) service = undefined;
    });
    service = started;
    return started;
  };

  const stop = async (stopped: Service | undefined): Promise<void> => {
    if (!stopped) return;
    const exited = once(stopped.child, 'exit');
    stopped.child.stdin?.end();
    stopped.child.kill(STOP_SIGNAL);
    await exited;
  };

  return {
    ready: () => mlxAudioSupported(platform, arch) && mlxAudioInstalled(dir),
    load: async () => {
      await start();
      loaded = true;
    },
    synthesize: async (sentence, voiceId, signal, speed) => {
      if (!loaded) throw new Error('mlx-audio service not loaded');
      const { origin, token } = service ?? (await start());
      const response = await fetchAudio(`${origin}${SYNTHESIZE_PATH}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': JSON_TYPE },
        body: JSON.stringify({ text: sentence, voice: voiceId, speed }),
        signal,
      });
      if (!response.ok) throw new Error(`mlx-audio synthesis failed (HTTP ${response.status})`);
      return new Uint8Array(await response.arrayBuffer());
    },
    unload: async () => {
      loaded = false;
      const stopped = service;
      service = undefined;
      await stop(stopped);
    },
  };
};

export const createMlxAudioProvider = (
  options: MlxAudioEngineOptions & Pick<KokoroProviderOptions, 'idleTimeoutMs'>,
): KokoroProvider =>
  createKokoroProvider({
    engine: createMlxAudioEngine(options),
    id: MLX_KOKORO_PROVIDER_ID,
    capabilities: MLX_KOKORO_CAPABILITIES,
    ...(options.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: options.idleTimeoutMs }),
  });
