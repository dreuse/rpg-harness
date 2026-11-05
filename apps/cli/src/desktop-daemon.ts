import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import {
  type CampaignCommand,
  type ClientEvent,
  failure,
  PROTOCOL_VERSION,
  parseCommand,
  type SaveGmDefaults,
  type Unsubscribe,
} from '../../../packages/client-protocol/src/protocol.ts';
import {
  EVENT,
  type Pushed,
  READY,
  type Ready,
  type Reply,
  type Request,
  type RequestType,
} from '../../../packages/client-protocol/src/wire.ts';
import { toGmSettings } from '../../../packages/domain/src/gm.ts';
import type { Client } from '../../../packages/intent/src/intent.ts';
import { applyPlaybackCommand } from '../../../packages/voice/src/playback-controls.ts';
import {
  archiveCampaign,
  createCampaignFrom,
  deleteCampaign,
  disposeSpeech,
  type GameMaster,
  gameMasterFor,
  isSameCampaignFile,
  listArchivedSummaries,
  listCampaignSummaries,
  liveSpeech,
  openClientSession,
  playbackFor,
  summaryOf,
  unarchiveCampaign,
} from './engine-gateway.ts';
import { API_KEY_ENV, gmRouteOf } from './gm-api.ts';
import { writeGmDefaults } from './gm-defaults.ts';
import { failureOf, planResult } from './quickstart.ts';
import { dataDirFromEnv } from './setup-check.ts';

const UNSUPPORTED_STORY_MEMORY = 'this daemon does not serve story memory yet';
const PLAYBACK = 'Playback';
const UNKNOWN_PLAYBACK = 'Unknown playback command.';
const INVALID_GM_DEFAULTS = 'GM defaults name an invalid model or budget';

const saveGmDefaults = ({ model, summaryModel, sessionBudgetTokens }: SaveGmDefaults) => {
  const settings = toGmSettings({ model, summaryModel, sessionBudgetTokens });
  if (settings === undefined) return failure('Rejected', INVALID_GM_DEFAULTS);
  writeGmDefaults(dataDirFromEnv(), settings);
  return { ok: true, value: settings } as const;
};

export { API_KEY_ENV, gmRouteOf };
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
const DESKTOP_CLIENT: Client = 'desktop';
const KILL = 'SIGKILL';
const MEMORY_DATABASE = ':memory:';
const SQLITE_PROBE = 'SELECT 1 AS ok';
const NEWLINE = '\n';
const IGNORE = () => {};
const UNKNOWN_PID = 0;
const ENABLED = '1';
const ENGINE_STOPPED = 'The engine is not running.';

type Campaign = ReturnType<typeof openClientSession>;
type Served = { readonly name?: string; readonly campaign?: Campaign; readonly problem: string };
export type EngineMessage = Ready | Reply | Pushed;
export type EngineChannel = {
  readonly pid: () => number | undefined;
  readonly send: (message: Request) => void;
  readonly kill: () => void;
};
export type EngineEvents = {
  readonly message: (message: EngineMessage) => void;
  readonly exit: (code: number | null, signal: string | null) => void;
};
export type SpawnEngine = (env: NodeJS.ProcessEnv, on: EngineEvents) => EngineChannel;
export type DaemonOptions = {
  readonly env: NodeJS.ProcessEnv;
  readonly onCrash?: (pid: number) => void;
  readonly maxRestarts?: number;
  readonly spawnEngine?: SpawnEngine;
};
type ParentPort = {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (event: { readonly data: unknown }) => void): unknown;
};

type Lifecycle = Exclude<CampaignCommand, { readonly type: 'PlanCampaign' }>;
type Versions = Readonly<Record<string, string | undefined>>;

const isConsumerKey = (key: string) => {
  const upper = key.toUpperCase();
  return upper.startsWith(CONSUMER_CREDENTIAL_PREFIX) || CONSUMER_CREDENTIAL_KEYS.includes(upper);
};

const consumerKeys = (env: NodeJS.ProcessEnv) => Object.keys(env).filter(isConsumerKey);

export const engineEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(env).filter(([key]) => !isConsumerKey(key)));

export const daemonEnv = (env: NodeJS.ProcessEnv, versions: Versions = process.versions): NodeJS.ProcessEnv => ({
  ...engineEnv(env),
  ...(versions.electron === undefined ? {} : { [ELECTRON_RUN_AS_NODE_ENV]: ENABLED }),
});

const sqliteWorks = () => {
  const database = new DatabaseSync(MEMORY_DATABASE);
  try {
    return database.prepare(SQLITE_PROBE).get()?.ok === 1;
  } finally {
    database.close();
  }
};

const { parentPort } = process as { parentPort?: ParentPort };

const send = (message: object, done?: () => void) => {
  if (parentPort === undefined) return process.stdout.write(JSON.stringify(message) + NEWLINE, done);
  parentPort.postMessage(message);
  done?.();
  return true;
};

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

const reportNarrationFailure = (error: unknown) =>
  process.stderr.write(`The game master could not narrate this turn: ${messageOf(error)}${NEWLINE}`);

const serve = (env: NodeJS.ProcessEnv, gm: GameMaster): Served => {
  const name = env[CAMPAIGN_ENV];
  if (!name) return { problem: NO_CAMPAIGN };
  try {
    return {
      name,
      campaign: openClientSession(dataDirFromEnv(), name, gm, undefined, liveSpeech(dataDirFromEnv())),
      problem: NO_CAMPAIGN,
    };
  } catch (error) {
    return { name, problem: messageOf(error) };
  }
};

const replyCampaigns = (id: number) => {
  try {
    const dataDir = dataDirFromEnv();
    const value = {
      version: PROTOCOL_VERSION,
      campaigns: listCampaignSummaries(dataDir),
      archived: listArchivedSummaries(dataDir),
    };
    return send({ id, type: 'Result', result: { ok: true, value } });
  } catch (error) {
    return send({ id, type: 'Error', message: messageOf(error) });
  }
};

const changeCampaign = (command: Lifecycle, served: string | undefined, serveCampaign: (name: string) => void) => {
  const dataDir = dataDirFromEnv();
  if (command.type === 'CreateCampaign') {
    const created = createCampaignFrom(dataDir, command, DESKTOP_CLIENT);
    serveCampaign(command.name);
    return created;
  }
  if (command.type === 'OpenCampaign') {
    serveCampaign(command.name);
    return summaryOf(dataDir, command.name);
  }
  const archived = command.type === 'DeleteCampaign' && command.archived === true;
  if (!archived && served !== undefined && isSameCampaignFile(dataDir, command.name, served))
    throw new Error(`Campaign ${command.name} is open in this engine.`);
  if (command.type === 'ArchiveCampaign') archiveCampaign(dataDir, command.name);
  else if (command.type === 'UnarchiveCampaign') unarchiveCampaign(dataDir, command.name);
  else deleteCampaign(dataDir, command.name, command.confirm, archived);
  return { version: PROTOCOL_VERSION, name: command.name };
};

const replyChange = (
  id: number,
  command: Lifecycle,
  served: string | undefined,
  serveCampaign: (name: string) => void,
) => {
  try {
    return send({ id, type: 'Result', result: { ok: true, value: changeCampaign(command, served, serveCampaign) } });
  } catch (error) {
    return send({ id, type: 'Result', result: failureOf(error) });
  }
};

const replier = ({ name, campaign, problem }: Served, gm: GameMaster) => {
  const subscriptions = new Map<number, Unsubscribe>();
  let queue = Promise.resolve();

  const serveCampaign = (next: string) => {
    const opened = openClientSession(dataDirFromEnv(), next, gm, undefined, liveSpeech(dataDirFromEnv()));
    playbackFor(dataDirFromEnv()).stop();
    for (const unsubscribe of subscriptions.values()) unsubscribe();
    subscriptions.clear();
    campaign?.close();
    name = next;
    campaign = opened;
  };

  const execute = async (id: number, input: unknown) => {
    const parsed = parseCommand(input);
    if (!parsed.ok) return send({ id, type: 'Error', message: parsed.error.message });
    const command = parsed.value;
    if (command.type === 'ListCampaigns') return replyCampaigns(id);
    if (command.type === 'PlanCampaign')
      return send({ id, type: 'Result', result: planResult(command, DESKTOP_CLIENT) });
    if (!('campaignId' in command)) return replyChange(id, command, name, serveCampaign);
    if (campaign === undefined) return send({ id, type: 'Error', message: problem });
    const { session, campaignId, narrate } = campaign;
    if (command.campaignId !== campaignId)
      return send({ id, type: 'Error', message: `Campaign ${command.campaignId} is not served by this engine.` });
    if (command.type === 'GetCampaignSnapshot')
      return send({ id, type: 'Result', result: session.getSnapshot(command) });
    if (command.type === 'GetCampaignPanels') return send({ id, type: 'Result', result: session.getPanels(command) });
    if (command.type === 'SubmitPlayerAction') {
      const result = session.submitPlayerAction(command);
      if (result.ok) await narrate().catch(reportNarrationFailure);
      return send({ id, type: 'Result', result });
    }
    if (command.type === 'SelectCapability')
      return send({ id, type: 'Result', result: session.selectCapability(command) });
    if (command.type === 'RequestView') return send({ id, type: 'Result', result: session.requestView(command) });
    if (command.type === 'EditSheetField') return send({ id, type: 'Result', result: session.editSheetField(command) });
    if (command.type === 'SaveVoiceSettings')
      return send({ id, type: 'Result', result: session.saveVoiceSettings(command) });
    if (command.type === 'SaveGmSettings') return send({ id, type: 'Result', result: session.saveGmSettings(command) });
    if (command.type === 'SaveGmDefaults') return send({ id, type: 'Result', result: saveGmDefaults(command) });
    if (command.type === 'GetStoryMemory' || command.type === 'CorrectStoryFact')
      return send({ id, type: 'Result', result: failure('Rejected', UNSUPPORTED_STORY_MEMORY) });
    subscriptions.get(id)?.();
    subscriptions.set(
      id,
      session.subscribeEvents(command, (event) => send({ id, type: EVENT, event })),
    );
    return send({ id, type: 'Result', result: { ok: true, value: { subscription: id } } });
  };

  const reply = async (input: unknown) => {
    let id: number | undefined;
    try {
      const request = (typeof input === 'string' ? JSON.parse(input) : input) as Request;
      id = request.id;
      const { type, command, subscription } = request;
      if (type === 'Ping') return send({ id, type: 'Pong' });
      if (type === 'Command') return await execute(id, command);
      if (type === 'Unsubscribe') {
        if (subscription !== undefined) subscriptions.get(subscription)?.();
        subscriptions.delete(subscription ?? id);
        return send({ id, type: 'Unsubscribed' });
      }
      if (type === 'Shutdown') {
        campaign?.close();
        return send({ id, type: 'Stopped' }, () => {
          disposeSpeech(dataDirFromEnv());
          process.exit(EXIT_OK);
        });
      }
      return send({ id, type: 'Error', message: `Unknown request ${type}.` });
    } catch (error) {
      return send({ id, type: 'Error', message: messageOf(error) });
    }
  };

  const requestOf = (input: unknown): Request | undefined => {
    try {
      return (typeof input === 'string' ? JSON.parse(input) : input) as Request;
    } catch {
      return undefined;
    }
  };

  const playback = ({ id, command }: Request) =>
    applyPlaybackCommand(playbackFor(dataDirFromEnv()), command)
      ? send({ id, type: 'Played' })
      : send({ id, type: 'Error', message: UNKNOWN_PLAYBACK });

  return (input: unknown) => {
    const request = requestOf(input);
    if (request?.type === PLAYBACK) return playback(request);
    queue = queue.then(() => reply(input)).then(IGNORE, IGNORE);
  };
};

const runDaemon = async () => {
  const found = consumerKeys(process.env);
  if (found.length > 0) {
    process.stderr.write(
      `The desktop engine does not take Claude Code session variables (${found.join(', ')}). Start it from the desktop app, or unset them.${NEWLINE}`,
    );
    process.exit(EXIT_CONSUMER_CREDENTIALS);
  }
  const { gm, route } = await gameMasterFor(process.env);
  const ready: Ready = {
    type: READY,
    version: PROTOCOL_VERSION,
    pid: process.pid,
    node: process.version,
    sqlite: sqliteWorks(),
    gm: route,
  };
  const reply = replier(serve(process.env, gm), gm);
  send(ready);
  if (parentPort === undefined) createInterface({ input: process.stdin }).on('line', reply);
  else parentPort.on('message', ({ data }) => reply(data));
};

export const stdioEngine: SpawnEngine = (env, on) => {
  const engine = spawn(process.execPath, [DAEMON_ENTRY], { env: daemonEnv(env) });
  engine.stdin.on('error', IGNORE);
  engine.stderr.pipe(process.stderr);
  createInterface({ input: engine.stdout }).on('line', (line) => {
    let message: EngineMessage;
    try {
      message = JSON.parse(line) as EngineMessage;
    } catch {
      process.stderr.write(line + NEWLINE);
      return;
    }
    on.message(message);
  });
  engine.once('exit', on.exit);
  return {
    pid: () => engine.pid,
    send: (message) => engine.stdin.write(JSON.stringify(message) + NEWLINE),
    kill: () => engine.kill(KILL),
  };
};

export const startDaemon = ({ env, onCrash, maxRestarts = MAX_RESTARTS, spawnEngine = stdioEngine }: DaemonOptions) => {
  const pending = new Map<number, PromiseWithResolvers<Reply>>();
  const listeners = new Map<number, (event: ClientEvent) => void>();
  let child: EngineChannel;
  let running = false;
  let handshake: Promise<Ready>;
  let exited: Promise<number | null>;
  let restarts = 0;
  let nextId = 0;
  let stopping = false;

  const startEngine = () => {
    const ready = Promise.withResolvers<Ready>();
    const exit = Promise.withResolvers<number | null>();
    ready.promise.catch(IGNORE);
    handshake = ready.promise;
    exited = exit.promise;
    running = true;
    const engine = spawnEngine(env, {
      message: (message) => {
        if (message.type === READY) return ready.resolve(message);
        if (message.type === EVENT) return listeners.get(message.id)?.(message.event);
        pending.get(message.id)?.resolve(message);
        pending.delete(message.id);
      },
      exit: (code, signal) => {
        running = false;
        exit.resolve(code);
        const error = new Error(`Engine ${engine.pid()} exited (${code ?? signal}).`);
        ready.reject(error);
        for (const request of pending.values()) request.reject(error);
        pending.clear();
        listeners.clear();
        if (stopping || restarts >= maxRestarts) return;
        restarts += 1;
        startEngine();
        onCrash?.(engine.pid() ?? UNKNOWN_PID);
      },
    });
    child = engine;
  };

  const call = async (message: Omit<Request, 'id'>, id = nextId++): Promise<Reply> => {
    await handshake;
    if (!running) throw new Error(ENGINE_STOPPED);
    const answer = Promise.withResolvers<Reply>();
    pending.set(id, answer);
    child.send({ id, ...message } as Request);
    return answer.promise;
  };

  const request = (type: RequestType) => call({ type });

  const command = (input: unknown) => call({ type: 'Command', command: input });

  const playback = (input: unknown) => call({ type: PLAYBACK, command: input });

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
    if (!running) return exited;
    request('Shutdown').catch(IGNORE);
    const timer = setTimeout(engine.kill, SHUTDOWN_TIMEOUT_MS);
    const code = await exited;
    clearTimeout(timer);
    return code;
  };

  startEngine();
  return { ready: () => handshake, request, command, playback, subscribe, stop, restarts: () => restarts };
};

if (import.meta.main) await runDaemon();
