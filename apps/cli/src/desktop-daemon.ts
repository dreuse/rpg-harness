import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { PROTOCOL_VERSION, type ProtocolVersion } from '../../../packages/client-protocol/src/protocol.ts';

export const API_KEY_ENV = 'ANTHROPIC_API_KEY';
export const ELECTRON_RUN_AS_NODE_ENV = 'ELECTRON_RUN_AS_NODE';
export const CONSUMER_CREDENTIAL_PREFIX = 'CLAUDE_';
export const CONSUMER_CREDENTIAL_KEYS = ['ANTHROPIC_AUTH_TOKEN', 'CLAUDECODE', 'ENABLE_CLAUDEAI_MCP_SERVERS'];
export const DAEMON_ENTRY = fileURLToPath(import.meta.url);
export const EXIT_CONSUMER_CREDENTIALS = 3;
export const MAX_RESTARTS = 3;
export const SHUTDOWN_TIMEOUT_MS = 2000;

const EXIT_OK = 0;
const READY = 'Ready';
const KILL = 'SIGKILL';
const MEMORY_DATABASE = ':memory:';
const SQLITE_PROBE = 'SELECT 1 AS ok';
const NEWLINE = '\n';
const IGNORE = () => {};
const UNKNOWN_PID = 0;
const ENABLED = '1';

export type GmRoute = 'api' | 'fake';
export type Ready = {
  readonly type: typeof READY;
  readonly version: ProtocolVersion;
  readonly pid: number;
  readonly node: string;
  readonly sqlite: boolean;
  readonly gm: GmRoute;
};
export type RequestType = 'Ping' | 'Shutdown';
export type Reply = { readonly id: number; readonly type: 'Pong' | 'Stopped' | 'Error'; readonly message?: string };
export type DaemonOptions = {
  readonly env: NodeJS.ProcessEnv;
  readonly onCrash?: (pid: number) => void;
  readonly maxRestarts?: number;
};

type Versions = Readonly<Record<string, string | undefined>>;

const isConsumerKey = (key: string) => {
  const upper = key.toUpperCase();
  return upper.startsWith(CONSUMER_CREDENTIAL_PREFIX) || CONSUMER_CREDENTIAL_KEYS.includes(upper);
};

const consumerKeys = (env: NodeJS.ProcessEnv) => Object.keys(env).filter(isConsumerKey);

export const daemonEnv = (env: NodeJS.ProcessEnv, versions: Versions = process.versions): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(Object.entries(env).filter(([key]) => !isConsumerKey(key))),
  ...(versions.electron === undefined ? {} : { [ELECTRON_RUN_AS_NODE_ENV]: ENABLED }),
});

export const gmRouteOf = (env: NodeJS.ProcessEnv): GmRoute => (env[API_KEY_ENV] ? 'api' : 'fake');

const sqliteWorks = () => {
  const database = new DatabaseSync(MEMORY_DATABASE);
  try {
    return database.prepare(SQLITE_PROBE).get()?.ok === 1;
  } finally {
    database.close();
  }
};

const send = (message: object, done?: () => void) => process.stdout.write(JSON.stringify(message) + NEWLINE, done);

const reply = (line: string) => {
  try {
    const { id, type } = JSON.parse(line) as { id: number; type: RequestType };
    if (type === 'Ping') return send({ id, type: 'Pong' });
    if (type === 'Shutdown') return send({ id, type: 'Stopped' }, () => process.exit(EXIT_OK));
    return send({ id, type: 'Error', message: `Unknown request ${type}.` });
  } catch (error) {
    return send({ type: 'Error', message: error instanceof Error ? error.message : String(error) });
  }
};

const runDaemon = () => {
  const found = consumerKeys(process.env);
  if (found.length > 0) {
    process.stderr.write(
      `The desktop engine does not use a Claude login (${found.join(', ')}). Set ${API_KEY_ENV} or play with the fake GM.${NEWLINE}`,
    );
    process.exit(EXIT_CONSUMER_CREDENTIALS);
  }
  const ready: Ready = {
    type: READY,
    version: PROTOCOL_VERSION,
    pid: process.pid,
    node: process.version,
    sqlite: sqliteWorks(),
    gm: gmRouteOf(process.env),
  };
  send(ready);
  createInterface({ input: process.stdin }).on('line', reply);
};

export const startDaemon = ({ env, onCrash, maxRestarts = MAX_RESTARTS }: DaemonOptions) => {
  const pending = new Map<number, PromiseWithResolvers<Reply>>();
  let child: ChildProcessWithoutNullStreams;
  let handshake: Promise<Ready>;
  let exited: Promise<[number | null, NodeJS.Signals | null]>;
  let restarts = 0;
  let nextId = 0;
  let stopping = false;

  const spawnEngine = () => {
    const engine = spawn(process.execPath, [DAEMON_ENTRY], { env: daemonEnv(env) });
    const ready = Promise.withResolvers<Ready>();
    ready.promise.catch(IGNORE);
    child = engine;
    handshake = ready.promise;
    exited = once(engine, 'exit') as Promise<[number | null, NodeJS.Signals | null]>;
    engine.stdin.on('error', IGNORE);
    engine.stderr.pipe(process.stderr);
    createInterface({ input: engine.stdout }).on('line', (line) => {
      let message: Ready | Reply;
      try {
        message = JSON.parse(line) as Ready | Reply;
      } catch {
        process.stderr.write(line + NEWLINE);
        return;
      }
      if (message.type === READY) return ready.resolve(message);
      pending.get(message.id)?.resolve(message);
      pending.delete(message.id);
    });
    engine.once('exit', (code, signal) => {
      const error = new Error(`Engine ${engine.pid} exited (${code ?? signal}).`);
      ready.reject(error);
      for (const request of pending.values()) request.reject(error);
      pending.clear();
      if (stopping || restarts >= maxRestarts) return;
      restarts += 1;
      spawnEngine();
      onCrash?.(engine.pid ?? UNKNOWN_PID);
    });
  };

  const request = async (type: RequestType): Promise<Reply> => {
    await handshake;
    const id = nextId++;
    const answer = Promise.withResolvers<Reply>();
    pending.set(id, answer);
    child.stdin.write(JSON.stringify({ id, type }) + NEWLINE);
    return answer.promise;
  };

  const stop = async (): Promise<number | null> => {
    stopping = true;
    const engine = child;
    if (engine.exitCode !== null || engine.signalCode !== null) return engine.exitCode;
    request('Shutdown').catch(IGNORE);
    const timer = setTimeout(() => engine.kill(KILL), SHUTDOWN_TIMEOUT_MS);
    const [code] = await exited;
    clearTimeout(timer);
    return code;
  };

  spawnEngine();
  return { ready: () => handshake, request, stop, restarts: () => restarts };
};

if (import.meta.main) runDaemon();
