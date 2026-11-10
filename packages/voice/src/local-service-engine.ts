import { type ChildProcess, spawn as nodeSpawn, type SpawnOptions } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { copyFile, mkdir } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import type { KokoroEngine, VoiceBlend } from './kokoro-provider.ts';
import type { Delivery } from './voice.ts';

export const SERVICE_START_TIMEOUT_MS = 60_000;

const ISOLATED = '-I';
const SERVE = 'serve';
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

const PATH_NAME = 'PATH';
const PATH_SEPARATOR = ':';
const HOME_TOOL_DIRS = ['.local/bin', '.cargo/bin'];
const MACOS_TOOL_DIRS = ['/opt/homebrew/bin', '/usr/local/bin'];

const withToolDirs = (path: string | undefined, home: string | undefined, platform: string): string => {
  const extra = [
    ...(home === undefined ? [] : HOME_TOOL_DIRS.map((dir) => `${home}/${dir}`)),
    ...(platform === 'darwin' ? MACOS_TOOL_DIRS : []),
  ];
  const kept = path === undefined || path === '' ? [] : path.split(PATH_SEPARATOR);
  return [...new Set([...kept, ...extra])].join(PATH_SEPARATOR);
};

export const inheritedEnv = (
  source: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
): Record<string, string> => {
  const env = Object.fromEntries(
    INHERITED_ENV.flatMap((name) => (source[name] === undefined ? [] : [[name, source[name]]])),
  );
  return { ...env, [PATH_NAME]: withToolDirs(source[PATH_NAME], source.HOME, platform) };
};

export type ServiceSpawn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

export interface SynthesisRequest {
  readonly text: string;
  readonly voiceId: string;
  readonly speed: number;
  readonly blend: VoiceBlend | undefined;
  readonly delivery: Delivery | undefined;
}

export interface ServiceEngineOptions {
  readonly name: string;
  readonly dir: string;
  readonly python: string;
  readonly service: string;
  readonly serviceSource: string;
  readonly hfHome: string;
  readonly tokenEnv: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly prepare?: () => Promise<void>;
  readonly ready: () => boolean;
  readonly body: (request: SynthesisRequest) => unknown;
  readonly blends?: boolean;
  readonly spawn?: ServiceSpawn;
  readonly fetch?: typeof fetch;
  readonly startTimeoutMs?: number;
}

interface Service {
  readonly child: ChildProcess;
  readonly origin: string;
  readonly token: string;
}

const waitForPort = (name: string, child: ChildProcess, timeoutMs: number): Promise<number> =>
  new Promise((resolve, reject) => {
    if (!child.stdout) {
      child.kill(STOP_SIGNAL);
      reject(new Error(`${name} service has no stdout`));
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
    const onExit = (code: number | null) => fail(`${name} service exited with ${code} before it was ready: ${stderr}`);
    const onError = (error: Error) => fail(`${name} service could not start: ${error.message}`);
    const timer = setTimeout(() => fail(`${name} service did not start within ${timeoutMs} ms`), timeoutMs);
    lines.on('line', onLine);
    child.stderr?.on('data', onStderr);
    child.once('exit', onExit);
    child.once('error', onError);
  });

export const createServiceEngine = ({
  name,
  dir,
  python,
  service: servicePath,
  serviceSource,
  hfHome,
  tokenEnv,
  env = {},
  prepare,
  ready,
  body,
  blends,
  spawn = nodeSpawn,
  fetch: fetchAudio = fetch,
  startTimeoutMs = SERVICE_START_TIMEOUT_MS,
}: ServiceEngineOptions): KokoroEngine => {
  let loaded = false;
  let service: Service | undefined;

  const start = async (): Promise<Service> => {
    await mkdir(dir, { recursive: true });
    await copyFile(serviceSource, servicePath);
    await prepare?.();
    const token = randomBytes(TOKEN_BYTES).toString(HEX);
    const child = spawn(python, [ISOLATED, servicePath, SERVE], {
      env: { ...inheritedEnv(), ...env, HF_HOME: hfHome, HF_HUB_OFFLINE: OFFLINE, [tokenEnv]: token },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const port = await waitForPort(name, child, startTimeoutMs);
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
    ...(blends === undefined ? {} : { blends }),
    ready,
    load: async () => {
      await start();
      loaded = true;
    },
    synthesize: async (text, voiceId, signal, speed, blend, delivery) => {
      if (!loaded) throw new Error(`${name} service not loaded`);
      const { origin, token } = service ?? (await start());
      const response = await fetchAudio(`${origin}${SYNTHESIZE_PATH}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': JSON_TYPE },
        body: JSON.stringify(body({ text, voiceId, speed, blend, delivery })),
        signal,
      });
      if (!response.ok) throw new Error(`${name} synthesis failed (HTTP ${response.status})`);
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
