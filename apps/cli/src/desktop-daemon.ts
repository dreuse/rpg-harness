import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import {
  type ClientEvent,
  PROTOCOL_VERSION,
  parseCommand,
  type Unsubscribe,
} from '../../../packages/client-protocol/src/protocol.ts';
import {
  EVENT,
  type GmRoute,
  type Pushed,
  READY,
  type Ready,
  type Reply,
  type Request,
  type RequestType,
} from '../../../packages/client-protocol/src/wire.ts';
import { listCampaignRecords, openClientSession } from './engine-gateway.ts';
import { dataDirFromEnv } from './setup-check.ts';

export const API_KEY_ENV = 'ANTHROPIC_API_KEY';
export const CAMPAIGN_ENV = 'RPG_CAMPAIGN';
export const NO_CAMPAIGN = 'no campaign';
export const ELECTRON_RUN_AS_NODE_ENV = 'ELECTRON_RUN_AS_NODE';
export const CONSUMER_CREDENTIAL_PREFIX = 'CLAUDE_';
export const CONSUMER_CREDENTIAL_KEYS = ['ANTHROPIC_AUTH_TOKEN', 'CLAUDECODE', 'ENABLE_CLAUDEAI_MCP_SERVERS'];
export const DAEMON_ENTRY = fileURLToPath(import.meta.url);
export const EXIT_CONSUMER_CREDENTIALS = 3;
export const MAX_RESTARTS = 3;
export const SHUTDOWN_TIMEOUT_MS = 2000;

const EXIT_OK = 0;
const KILL = 'SIGKILL';
const MEMORY_DATABASE = ':memory:';
const SQLITE_PROBE = 'SELECT 1 AS ok';
const NEWLINE = '\n';
const IGNORE = () => {};
const UNKNOWN_PID = 0;
const ENABLED = '1';
const ENGINE_STOPPED = 'The engine is not running.';

type Campaign = ReturnType<typeof openClientSession>;
type Served = { readonly campaign?: Campaign; readonly problem: string };
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

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

const serve = (env: NodeJS.ProcessEnv): Served => {
  const name = env[CAMPAIGN_ENV];
  if (!name) return { problem: NO_CAMPAIGN };
  try {
    return { campaign: openClientSession(dataDirFromEnv(), name), problem: NO_CAMPAIGN };
  } catch (error) {
    return { problem: messageOf(error) };
  }
};

const replyCampaigns = (id: number) => {
  try {
    const campaigns = listCampaignRecords(dataDirFromEnv());
    return send({ id, type: 'Result', result: { ok: true, value: { version: PROTOCOL_VERSION, campaigns } } });
  } catch (error) {
    return send({ id, type: 'Error', message: messageOf(error) });
  }
};

const replier = ({ campaign, problem }: Served) => {
  const subscriptions = new Map<number, Unsubscribe>();

  const execute = (id: number, input: unknown) => {
    const parsed = parseCommand(input);
    if (!parsed.ok) return send({ id, type: 'Error', message: parsed.error.message });
    const command = parsed.value;
    if (command.type === 'ListCampaigns') return replyCampaigns(id);
    if (campaign === undefined) return send({ id, type: 'Error', message: problem });
    const { session, campaignId } = campaign;
    if (command.campaignId !== campaignId)
      return send({ id, type: 'Error', message: `Campaign ${command.campaignId} is not served by this engine.` });
    if (command.type === 'GetCampaignSnapshot')
      return send({ id, type: 'Result', result: session.getSnapshot(command) });
    if (command.type === 'GetCampaignPanels') return send({ id, type: 'Result', result: session.getPanels(command) });
    if (command.type === 'SubmitPlayerAction')
      return send({ id, type: 'Result', result: session.submitPlayerAction(command) });
    if (command.type === 'SelectCapability')
      return send({ id, type: 'Result', result: session.selectCapability(command) });
    if (command.type === 'RequestView') return send({ id, type: 'Result', result: session.requestView(command) });
    if (command.type === 'EditSheetField') return send({ id, type: 'Result', result: session.editSheetField(command) });
    if (command.type === 'SaveVoiceSettings')
      return send({ id, type: 'Result', result: session.saveVoiceSettings(command) });
    subscriptions.get(id)?.();
    subscriptions.set(
      id,
      session.subscribeEvents(command, (event) => send({ id, type: EVENT, event })),
    );
    return send({ id, type: 'Result', result: { ok: true, value: { subscription: id } } });
  };

  return (line: string) => {
    try {
      const { id, type, command, subscription } = JSON.parse(line) as Request;
      if (type === 'Ping') return send({ id, type: 'Pong' });
      if (type === 'Command') return execute(id, command);
      if (type === 'Unsubscribe') {
        if (subscription !== undefined) subscriptions.get(subscription)?.();
        subscriptions.delete(subscription ?? id);
        return send({ id, type: 'Unsubscribed' });
      }
      if (type === 'Shutdown') {
        campaign?.close();
        return send({ id, type: 'Stopped' }, () => process.exit(EXIT_OK));
      }
      return send({ id, type: 'Error', message: `Unknown request ${type}.` });
    } catch (error) {
      return send({ type: 'Error', message: messageOf(error) });
    }
  };
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
  const reply = replier(serve(process.env));
  send(ready);
  createInterface({ input: process.stdin }).on('line', reply);
};

export const startDaemon = ({ env, onCrash, maxRestarts = MAX_RESTARTS }: DaemonOptions) => {
  const pending = new Map<number, PromiseWithResolvers<Reply>>();
  const listeners = new Map<number, (event: ClientEvent) => void>();
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
      let message: Ready | Reply | Pushed;
      try {
        message = JSON.parse(line) as Ready | Reply | Pushed;
      } catch {
        process.stderr.write(line + NEWLINE);
        return;
      }
      if (message.type === READY) return ready.resolve(message);
      if (message.type === EVENT) return listeners.get(message.id)?.(message.event);
      pending.get(message.id)?.resolve(message);
      pending.delete(message.id);
    });
    engine.once('exit', (code, signal) => {
      const error = new Error(`Engine ${engine.pid} exited (${code ?? signal}).`);
      ready.reject(error);
      for (const request of pending.values()) request.reject(error);
      pending.clear();
      listeners.clear();
      if (stopping || restarts >= maxRestarts) return;
      restarts += 1;
      spawnEngine();
      onCrash?.(engine.pid ?? UNKNOWN_PID);
    });
  };

  const call = async (message: Omit<Request, 'id'>, id = nextId++): Promise<Reply> => {
    await handshake;
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(ENGINE_STOPPED);
    const answer = Promise.withResolvers<Reply>();
    pending.set(id, answer);
    child.stdin.write(JSON.stringify({ id, ...message }) + NEWLINE);
    return answer.promise;
  };

  const request = (type: RequestType) => call({ type });

  const command = (input: unknown) => call({ type: 'Command', command: input });

  const subscribe = async (input: unknown, listener: (event: ClientEvent) => void) => {
    const id = nextId++;
    listeners.set(id, listener);
    const reply = await call({ type: 'Command', command: input }, id).catch((error: unknown) => {
      listeners.delete(id);
      throw error;
    });
    if (reply.type !== 'Result') listeners.delete(id);
    const unsubscribe = () => {
      listeners.delete(id);
      return call({ type: 'Unsubscribe', subscription: id });
    };
    return { reply, unsubscribe };
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
  return { ready: () => handshake, request, command, subscribe, stop, restarts: () => restarts };
};

if (import.meta.main) runDaemon();
