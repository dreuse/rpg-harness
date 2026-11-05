import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, linkSync, mkdirSync, openSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { budgetWarning, gmSettingsLines, gmUsageLines } from '../../../packages/client-protocol/src/gm-usage.ts';
import {
  type CampaignHealth,
  type CampaignSummary,
  type CreateCampaign,
  MAX_INPUT_LENGTH,
} from '../../../packages/client-protocol/src/protocol.ts';
import type { GmRoute } from '../../../packages/client-protocol/src/wire.ts';
import {
  type CampaignId,
  type CampaignState,
  type CampaignStore,
  type CommittedTurn,
  OPENING_ACTION_ID,
  type Turn,
} from '../../../packages/domain/src/campaign.ts';
import { EMPTY_GM_USAGE_TOTALS, type GmSettings, type GmUsage, toGmSettings } from '../../../packages/domain/src/gm.ts';
import { commitCharacter, editSheetField, playTurns } from '../../../packages/engine/src/character.ts';
import { createEngine, type Engine } from '../../../packages/engine/src/engine.ts';
import {
  type GameplayOutcome,
  type NarrationContext,
  type Narrator,
  narrateTurn,
  playGameplayTurn,
} from '../../../packages/engine/src/gameplay.ts';
import { gmSettingsOf, recordGmUsage } from '../../../packages/engine/src/gm-settings.ts';
import {
  campaignConfigOf,
  loadState,
  openScene,
  performAction,
  storedTurn,
} from '../../../packages/engine/src/turn.ts';
import { voiceSettingsOf } from '../../../packages/engine/src/voice-settings.ts';
import { type CampaignConfig, parseCampaignConfig } from '../../../packages/intent/src/config.ts';
import { PLAYER_VIEWER } from '../../../packages/memory/src/knowledge.ts';
import type { ContextPacket } from '../../../packages/memory/src/packet.ts';
import { createCampaignStore } from '../../../packages/persistence/src/campaign-store.ts';
import { MIGRATIONS, openDatabase } from '../../../packages/persistence/src/database.ts';
import { createEntityStore, createFactStore } from '../../../packages/persistence/src/entity-store.ts';
import type { BuildInput, BuildResult } from '../../../packages/rules/src/character-builder.ts';
import type { Rng } from '../../../packages/rules/src/dice.ts';
import { backupArchive, exportArchive, restoreArchive } from './campaign-archive.ts';
import { type Ask, createCharacter } from './character-creation.ts';
import {
  campaignSummaryOf,
  createClientSessions,
  gmSnapshotOf,
  type SheetPort,
  scopedEventsOf,
  scopeLookupOf,
  type WorldSource,
  worldOf,
} from './client-session.ts';
import {
  API_KEY_ENV,
  API_ROUTE,
  type ApiRoute,
  apiKeyOf,
  apiRouteOf,
  CLAUDE_CODE_ROUTE,
  claudeBinOf,
  FAKE_GM_REPLY,
  FAKE_ROUTE,
  GM_ROUTE_ENV,
  gmSecrets,
  PROVIDER_DEFAULT_MODEL,
  ProviderError,
  requestNarration,
  requestSummary,
  storedApiKey,
  streamNarration,
  summaryRouteOf,
} from './gm-api.ts';
import {
  type ClaudeCodeRoute,
  claudeCodeRouteOf,
  requestClaudeNarration,
  requestClaudeSummary,
} from './gm-claude-code.ts';
import { requestClaudeStream } from './gm-claude-stream.ts';
import { contextPacketOf, fakeSummarizer, type Summarizer, summarizeCampaign } from './gm-context.ts';
import { readGmDefaults, writeGmDefaults } from './gm-defaults.ts';
import { commitProposals, type GmProposal } from './gm-proposals.ts';
import { type GmSegment, narratorSegments } from './gm-segments.ts';

export { FAKE_GM_REPLY } from './gm-api.ts';

import { importRules } from './import-gateway.ts';
import type { CampaignGateway } from './main.ts';
import { LocalizedError } from './messages.ts';
import {
  ClientUnsupported,
  commandConfig,
  creationRulesFor,
  describeConfig,
  type Opening,
  openingFor,
  planCampaign,
  startingCharacter,
} from './quickstart.ts';
import { checkFor } from './roll-visualization.ts';
import type { SpeechRuntime } from './speech-runtime.ts';
import { runTui, type Terminal, type TuiPlayback } from './tui.ts';
import { runHome } from './tui-home.ts';
import { guidedStart } from './tui-start.ts';
import type { TurnSpeech } from './turn-speech.ts';
import { type CampaignFile, defaultUpdateContext, updateCommand } from './update.ts';
import { editableSheet, renderView, type ViewName } from './views.ts';

const DATABASE_EXTENSION = '.sqlite';
const SELECT_CAMPAIGN_ID = 'SELECT id FROM campaign LIMIT 1';
const SELECT_SCHEMA_VERSION = 'SELECT MAX(version) AS version FROM schema_migrations';
const KNOWN_SCHEMA_VERSION = Math.max(...MIGRATIONS.map(({ version }) => version));
const UNREADABLE: CampaignHealth = 'unreadable';
const NEEDS_MIGRATION: CampaignHealth = 'needs-migration';
const UNREAD_SUMMARY = {
  id: null,
  sceneTitle: null,
  characters: [],
  ruleset: null,
  genre: null,
  lastNarration: null,
  turnCount: 0,
} as const;
const RECAP_VIEW = 'recap';
const CREATE_EXCLUSIVE = 'wx';
const FILE_EXISTS = 'EEXIST';
const HERO_NAME = 'The Wanderer';
const DEFAULT_OPENING: Opening = {
  title: 'The Crossroads Inn',
  narration: 'Rain drums on the roof of the Crossroads Inn. A stranger by the fire looks up as you enter.',
};
const ARCHIVE_DIR = 'archive';
const NONE = 'none';
const SAVED_SETTINGS = 'Saved settings:';
const CHARACTER_PROMPT = `Describe your character, or press Enter to play as ${HERO_NAME}.`;
const CREATE_CHARACTER_INTENT = 'create character';
const SUMMARY_SETTLE_MS = 10_000;
export const NO_KEY_NOTICE = `No AI game master is set up, so the built-in narrator tells the story. Install Claude Code or set ${API_KEY_ENV} to play with one.`;
export const GM_NOTICES: Readonly<Record<GmRoute, string>> = {
  'claude-code': 'The game master is Claude Code on this computer.',
  api: `The game master is Claude through your ${API_KEY_ENV}.`,
  fake: NO_KEY_NOTICE,
};
const NO_FACTS: NarrationContext = { facts: [], equipment: {}, viewer: PLAYER_VIEWER };
const PENDING_NARRATION = '';
const NO_SEGMENTS: readonly GmSegment[] = [];

const databasePath = (dataDir: string, name: string) =>
  join(dataDir, `${encodeURIComponent(name)}${DATABASE_EXTENSION}`);

const archivePath = (dataDir: string, name: string) => databasePath(join(dataDir, ARCHIVE_DIR), name);

const missingCampaign = (dataDir: string, name: string) =>
  existsSync(archivePath(dataDir, name))
    ? new LocalizedError('campaign.archived', { name })
    : new LocalizedError('campaign.missing', { name });

const withNarration = ({ turn, ...rest }: CommittedTurn, narration: string): CommittedTurn => ({
  ...rest,
  turn: { ...turn, narration },
});

export const narratedTurn = (store: CampaignStore, outcome: GameplayOutcome): CommittedTurn => {
  const { committed } = outcome;
  if ('narration' in outcome) return withNarration(committed, outcome.narration);
  if ('inconsistent' in outcome) {
    store.recordNarration(committed.turn.campaignId, committed.turn.id, FAKE_GM_REPLY);
    return withNarration(committed, FAKE_GM_REPLY);
  }
  return committed;
};

type SpeechSource = () => SpeechRuntime | Promise<SpeechRuntime>;
const SPOKEN_OFF = 'off';
const NO_NPC_VOICES = { profileOf: () => undefined };

type PacketNarrator = (packet: ContextPacket) => GmTurnReply;

const narratingEngine = (
  store: CampaignStore,
  database: Session['database'],
  narrate: PacketNarrator,
  rng: Rng,
): Engine => {
  const narrator: Narrator = {
    narrate: (committed) => ({
      narration: narrate(contextPacketOf(database, loadState(store, committed.turn.campaignId), committed)).narration,
      claims: [],
    }),
  };
  return {
    ...createEngine(store, rng),
    submitAction: (action, check) =>
      narratedTurn(
        store,
        playGameplayTurn(
          store,
          narrator,
          (target, played) => performAction(target, played, check, rng),
          action,
          NO_FACTS,
        ),
      ),
  };
};

type GmCall = {
  readonly databasePath: string;
  readonly model: string | undefined;
  readonly onSegment?: (segment: string) => void;
};
type GmTurnReply = {
  readonly narration: string;
  readonly segments: readonly GmSegment[];
  readonly proposals?: readonly GmProposal[];
  readonly usage?: GmUsage;
};
type PacketRequest = (packet: ContextPacket, call: GmCall) => Promise<GmTurnReply>;
type ModelSummarizer = (
  ...[level, texts, language, model]: [...Parameters<Summarizer>, string?]
) => ReturnType<Summarizer>;

export type GameMaster = ({ readonly narrator: PacketNarrator } | { readonly request: PacketRequest }) & {
  readonly summarizer: ModelSummarizer;
  readonly notice?: string;
};

const narratorReply = (narration: string): GmTurnReply => ({ narration, segments: narratorSegments(narration) });

export const FAKE_GAME_MASTER: GameMaster = {
  narrator: () => narratorReply(FAKE_GM_REPLY),
  summarizer: fakeSummarizer,
};

const withNotice = (notice: string) => `${notice} ${FAKE_GM_REPLY}`;

export const noKeyGameMaster = (): GameMaster => {
  let told = false;
  return {
    narrator: () => {
      const narration = told ? FAKE_GM_REPLY : withNotice(NO_KEY_NOTICE);
      told = true;
      return narratorReply(narration);
    },
    summarizer: fakeSummarizer,
  };
};

const providerGameMaster = (narrate: PacketRequest, summarize: ModelSummarizer): GameMaster => {
  let failed = false;
  return {
    request: async (packet, call) => {
      if (failed) return narratorReply(FAKE_GM_REPLY);
      try {
        return await narrate(packet, call);
      } catch (error) {
        if (!(error instanceof ProviderError)) throw error;
        failed = true;
        return narratorReply(
          withNotice(`The AI game master is unavailable: ${error.message} The built-in narrator takes over.`),
        );
      }
    },
    summarizer: (level, texts, language, model) =>
      failed ? fakeSummarizer(level, texts, language) : summarize(level, texts, language, model),
  };
};

const chosen = (model: string | undefined) => (model === PROVIDER_DEFAULT_MODEL ? undefined : model);

export const apiGameMaster = (route: ApiRoute, summaryRoute: ApiRoute = route): GameMaster =>
  providerGameMaster(
    (packet, { model, onSegment }) => {
      const routed = { ...route, model: chosen(model) ?? route.model };
      return onSegment === undefined ? requestNarration(routed, packet) : streamNarration(routed, packet, onSegment);
    },
    (level, texts, language, model) =>
      requestSummary({ ...summaryRoute, model: chosen(model) ?? summaryRoute.model }, level, texts, language),
  );

export const claudeCodeGameMaster = (route: ClaudeCodeRoute): GameMaster =>
  providerGameMaster(
    (packet, { databasePath, model, onSegment }) => {
      const routed = { ...route, model: chosen(model) ?? route.model };
      return onSegment === undefined
        ? requestClaudeNarration(routed, packet, databasePath)
        : requestClaudeStream(routed, packet, onSegment);
    },
    (level, texts, language, model) =>
      requestClaudeSummary({ ...route, summaryModel: chosen(model) ?? route.summaryModel }, level, texts, language),
  );

const chosenGameMaster = async (env: NodeJS.ProcessEnv): Promise<{ gm: GameMaster; route: GmRoute }> => {
  const chosen = env[GM_ROUTE_ENV];
  if (chosen === FAKE_ROUTE) return { gm: FAKE_GAME_MASTER, route: FAKE_ROUTE };
  const bin = chosen === API_ROUTE ? undefined : claudeBinOf(env);
  if (bin !== undefined) return { gm: claudeCodeGameMaster(claudeCodeRouteOf(bin, env)), route: CLAUDE_CODE_ROUTE };
  if (chosen === CLAUDE_CODE_ROUTE) return { gm: noKeyGameMaster(), route: FAKE_ROUTE };
  const key = apiKeyOf(env, await storedApiKey(gmSecrets(env)));
  if (key === undefined) return { gm: noKeyGameMaster(), route: FAKE_ROUTE };
  const route = apiRouteOf(key, env);
  return { gm: apiGameMaster(route, summaryRouteOf(route, env)), route: API_ROUTE };
};

export const gameMasterFor = async (env: NodeJS.ProcessEnv) => {
  const { gm, route } = await chosenGameMaster(env);
  return { gm: { ...gm, notice: GM_NOTICES[route] }, route };
};

type Session = {
  engine: Engine;
  store: ReturnType<typeof createCampaignStore>;
  campaignId: string;
  database: ReturnType<typeof openDatabase>['database'];
};

type SpeakTurn = (turnId: string) => Promise<TurnSpeech | undefined>;

const narrateLatest = async (
  { engine, store, campaignId, database }: Session,
  request: (packet: ContextPacket, onSegment?: (segment: string) => void) => Promise<GmTurnReply>,
  sessionId: string,
  speak: SpeakTurn,
): Promise<readonly GmSegment[]> => {
  const state = engine.getState(campaignId);
  const latest = playTurns(state).at(-1);
  const committed = latest === undefined ? undefined : storedTurn(state, latest.actionId);
  if (committed === undefined || committed.turn.narration !== PENDING_NARRATION) return NO_SEGMENTS;
  const packet = contextPacketOf(database, state, committed);
  let usage: GmUsage | undefined;
  let segments: readonly GmSegment[] = NO_SEGMENTS;
  let proposals: readonly GmProposal[] = [];
  const voice = await speak(committed.turn.id);
  const narrator = {
    narrate: async () => {
      const reply = await request(packet, voice?.streams ? voice.heard : undefined).catch((error: unknown) => {
        voice?.abandon();
        throw error;
      });
      usage = reply.usage;
      segments = reply.segments;
      proposals = reply.proposals ?? [];
      voice?.settle(reply);
      return { narration: reply.narration, claims: [] };
    },
  };
  const facts = createFactStore(database).listFacts(campaignId);
  const outcome = await narrateTurn(store, narrator, committed, { facts, equipment: {}, viewer: PLAYER_VIEWER }).catch(
    (error: unknown) => {
      voice?.abandon();
      throw error;
    },
  );
  if ('inconsistent' in outcome) {
    voice?.abandon();
    store.recordNarration(campaignId, committed.turn.id, FAKE_GM_REPLY);
  } else commitProposals(store, createEntityStore(database), createFactStore(database), committed, proposals);
  if (usage !== undefined) recordGmUsage(store, { campaignId, turnId: committed.turn.id, sessionId, usage });
  return 'inconsistent' in outcome ? narratorSegments(FAKE_GM_REPLY) : segments;
};

const settled = () => delay(SUMMARY_SETTLE_MS, undefined, { ref: false });
let summarizing: Promise<void> = Promise.resolve();

const summarizeInBackground = ({ store, campaignId, database }: Session, summarizer: Summarizer) => {
  const job = () => summarizeCampaign(database, store, campaignId, summarizer);
  summarizing = summarizing.then(() => Promise.race([job(), settled()])).catch(() => {});
  return summarizing;
};

type OpenSession = Session & {
  sessionId: string;
  gmDefaults: () => GmSettings;
  narrate: () => Promise<readonly GmSegment[]>;
  settle: () => Promise<unknown>;
  close: () => void;
};

const gmSnapshotFor = ({ engine, campaignId }: Session, defaults: GmSettings, sessionId?: string) =>
  gmSnapshotOf(engine.getState(campaignId), defaults, sessionId);

const openSession = (
  dataDir: string,
  name: string,
  readOnly = false,
  gm: GameMaster = FAKE_GAME_MASTER,
  rng: Rng = Math.random,
  speech?: SpeechSource,
  sessionId: string = randomUUID(),
): OpenSession => {
  const path = databasePath(dataDir, name);
  if (!existsSync(path)) throw missingCampaign(dataDir, name);
  if (readOnly) openDatabase(path).close();
  const connection = openDatabase(path, { readOnly });
  try {
    const { database } = connection;
    const store = createCampaignStore(database);
    const row = database.prepare(SELECT_CAMPAIGN_ID).get();
    if (row === undefined) throw new LocalizedError('campaign.noState', { name });
    const close = () => connection.close();
    const engine = 'narrator' in gm ? narratingEngine(store, database, gm.narrator, rng) : createEngine(store, rng);
    const session = { engine, store, campaignId: String(row.id), database };
    const gmDefaults = () => readGmDefaults(dataDir);
    let summarized: Promise<void> = Promise.resolve();
    const speakTurn: SpeakTurn = async (turnId) => {
      const settings = voiceSettingsOf(engine.getState(session.campaignId).changes);
      if (speech === undefined || settings === undefined || settings.spokenOutput === SPOKEN_OFF) return undefined;
      const { campaignId } = session;
      try {
        const [{ createTurnSpeech, narratorProfileOf }, { utterancesFor }] = await Promise.all([
          import('./turn-speech.ts'),
          import('./turn-utterances.ts'),
        ]);
        const narrator = narratorProfileOf(settings.locale);
        const entities = createEntityStore(database);
        return createTurnSpeech({
          speech: (await speech()).speech,
          turnId,
          mode: settings.spokenOutput,
          utterancesOf: (segments) =>
            utterancesFor({ store, entities, campaignId, turnId, segments, narrator, npcVoices: NO_NPC_VOICES }),
        });
      } catch {
        return undefined;
      }
    };
    const narrate = async () => {
      const { model, summaryModel } = {
        ...gmDefaults(),
        ...gmSettingsOf(engine.getState(session.campaignId).changes),
      };
      const segments =
        'request' in gm
          ? await narrateLatest(
              session,
              (packet, onSegment) =>
                gm.request(packet, { databasePath: path, model, ...(onSegment === undefined ? {} : { onSegment }) }),
              sessionId,
              speakTurn,
            )
          : NO_SEGMENTS;
      summarized = summarizeInBackground(session, (level, texts, language) =>
        gm.summarizer(level, texts, language, summaryModel),
      );
      return segments;
    };
    const settle = () => Promise.race([summarized, settled()]);
    return { ...session, sessionId, gmDefaults, narrate, settle, close };
  } catch (error) {
    connection.close();
    throw error;
  }
};

const withSession = <T>(dataDir: string, name: string, run: (session: Session) => T, readOnly = false): T => {
  const session = openSession(dataDir, name, readOnly);
  try {
    return run(session);
  } finally {
    session.close();
  }
};

const sheetsOf = ({ engine, store }: Session, readWorld: WorldSource): SheetPort => ({
  read: (campaignId, actorId) =>
    editableSheet({ state: engine.getState(campaignId), eventScopes: [], ...readWorld(campaignId, actorId) }, actorId),
  commit: (edit) => {
    editSheetField(store, edit);
  },
});

export const openClientSession = (
  dataDir: string,
  name: string,
  gm: GameMaster = FAKE_GAME_MASTER,
  rng: Rng = Math.random,
  speech?: SpeechSource,
) => {
  const opened = openSession(dataDir, name, false, gm, rng, speech);
  const { engine, campaignId, database, narrate, settle, close, sessionId, gmDefaults } = opened;
  try {
    const readWorld = worldOf(database);
    const sessions = createClientSessions(
      engine,
      campaignId,
      scopedEventsOf(database),
      readWorld,
      sheetsOf(opened, readWorld),
      { sessionId, defaults: gmDefaults },
    );
    return { session: sessions(PLAYER_VIEWER), campaignId, narrate, settle, close };
  } catch (error) {
    close();
    throw error;
  }
};

const liveRuntimes = new Map<string, SpeechRuntime>();

export type MakeSpeech = (dataDir: string) => SpeechRuntime | Promise<SpeechRuntime>;

const makeLiveSpeech: MakeSpeech = async (dataDir) =>
  (await import('./speech-runtime.ts')).createLiveSpeechRuntime(dataDir);

export const liveSpeech =
  (dataDir: string, make: MakeSpeech = makeLiveSpeech): SpeechSource =>
  async () => {
    const existing = liveRuntimes.get(dataDir);
    if (existing !== undefined) return existing;
    const runtime = await make(dataDir);
    liveRuntimes.set(dataDir, runtime);
    return runtime;
  };

export const disposeSpeech = (dataDir: string) => {
  liveRuntimes.get(dataDir)?.dispose();
  liveRuntimes.delete(dataDir);
};

export const playbackFor = (dataDir: string): TuiPlayback => ({
  pause: () => liveRuntimes.get(dataDir)?.speech.pause(),
  resume: () => liveRuntimes.get(dataDir)?.speech.resume(),
  skip: () => liveRuntimes.get(dataDir)?.speech.skip(),
  stop: () => liveRuntimes.get(dataDir)?.speech.stop(),
  diagnostics: () => liveRuntimes.get(dataDir)?.diagnostics.summary(),
});

const playTui = async (
  dataDir: string,
  name: string,
  terminal: Terminal,
  gm: GameMaster,
  rng: Rng,
  makeSpeech: MakeSpeech,
) => {
  const { session, campaignId, narrate, settle, close } = openClientSession(
    dataDir,
    name,
    gm,
    rng,
    liveSpeech(dataDir, makeSpeech),
  );
  try {
    await runTui(session, campaignId, terminal, narrate, gm.notice, playbackFor(dataDir));
  } finally {
    disposeSpeech(dataDir);
    await settle();
    close();
  }
};

export const readCampaignState = (dataDir: string, name: string): CampaignState =>
  withSession(dataDir, name, ({ engine, campaignId }) => engine.getState(campaignId));

const sceneText = (title: string, narration: string) => `${title}\n${narration}`;

const narrate = (actor: string, turn: Turn) =>
  `${actor}: ${turn.input}\n${turn.narration.trim() === '' ? FAKE_GM_REPLY : turn.narration}`;

const isFileExists = (error: unknown) => error instanceof Error && 'code' in error && error.code === FILE_EXISTS;

const claimFile = (path: string, name: string) => {
  try {
    closeSync(openSync(path, CREATE_EXCLUSIVE));
  } catch (error) {
    if (isFileExists(error)) throw new LocalizedError('campaign.exists', { name });
    throw error;
  }
};

const createCampaign = (
  dataDir: string,
  name: string,
  opening: Opening,
  config: CampaignConfig,
  language?: string,
): string => {
  mkdirSync(dataDir, { recursive: true });
  const path = databasePath(dataDir, name);
  claimFile(path, name);
  let connection: ReturnType<typeof openDatabase> | undefined;
  try {
    connection = openDatabase(path);
    const store = createCampaignStore(connection.database);
    const campaign = createEngine(store).createCampaign(name, language);
    openScene(store, {
      campaignId: campaign.id,
      actorName: HERO_NAME,
      sceneTitle: opening.title,
      narration: opening.narration,
      config,
    });
    connection.close();
  } catch (error) {
    connection?.close();
    rmSync(path, { force: true });
    throw error;
  }
  return sceneText(opening.title, opening.narration);
};

const unfinishedText = (result: Exclude<BuildResult, { status: 'created' }>) =>
  `Character not created, you play as ${HERO_NAME}: ${
    result.status === 'pending'
      ? `no answer for ${result.questions.map(({ label, fieldId }) => label ?? fieldId).join(', ')}`
      : result.issues.map(({ path, message }) => `${path} ${message}`).join('; ')
  }.`;

const addCharacter = (dataDir: string, name: string, build: BuildInput): string =>
  withSession(dataDir, name, ({ engine, store, campaignId }) => {
    const state = engine.getState(campaignId);
    const [actor] = state.characters;
    const scene = state.currentScene;
    if (actor === undefined || scene === undefined) throw new LocalizedError('campaign.noScene', { name });
    commitCharacter(store, {
      campaignId,
      actionId: randomUUID(),
      expectedRevision: state.revision,
      sceneId: scene.id,
      actorId: actor.id,
      input: build.backstory,
      intent: CREATE_CHARACTER_INTENT,
      build,
    });
    return `Created ${build.proposal.name}.`;
  });

const characterFor = async (dataDir: string, name: string, config: CampaignConfig, ask: Ask) => {
  const rules = creationRulesFor(config.rulepack);
  const description =
    rules === undefined ? undefined : (await ask(CHARACTER_PROMPT))?.trim().slice(0, MAX_INPUT_LENGTH);
  if (rules === undefined || !description) return undefined;
  const { build, result } = await createCharacter(rules, description, ask);
  return result.status === 'created' ? addCharacter(dataDir, name, build) : unfinishedText(result);
};

type Acted = { readonly narration: string; readonly warning: string | undefined };

const act = async (
  dataDir: string,
  name: string,
  input: string,
  gm: GameMaster,
  rng: Rng,
  sessionId: string,
): Promise<Acted> => {
  const session = openSession(dataDir, name, false, gm, rng, undefined, sessionId);
  try {
    const { engine, campaignId, database } = session;
    const state = engine.getState(campaignId);
    const [actor] = state.characters;
    const scene = state.currentScene;
    if (actor === undefined || scene === undefined) throw new LocalizedError('campaign.noScene', { name });
    const committed = engine.submitAction(
      {
        campaignId,
        actionId: randomUUID(),
        expectedRevision: state.revision,
        sceneId: scene.id,
        actorId: actor.id,
        input,
        intent: input,
      },
      checkFor(state.events, input, actor.id, worldOf(database)(campaignId, actor.id).entities),
    );
    await session.narrate();
    const narrated = engine.getState(campaignId).turns.find(({ id }) => id === committed.turn.id);
    const warning = budgetWarning(gmSnapshotFor(session, session.gmDefaults(), sessionId));
    return { narration: narrate(actor.name, narrated ?? committed.turn), warning };
  } finally {
    void session.settle().finally(session.close);
  }
};

const recap = (characters: CampaignState['characters'], last: Turn | undefined) => {
  const actor = characters.find(({ id }) => id === last?.actorId);
  if (last === undefined || actor === undefined) return DEFAULT_OPENING.narration;
  return last.actionId === OPENING_ACTION_ID ? last.narration : narrate(actor.name, last);
};

const savedSettings = (events: CampaignState['events']) => {
  const saved = parseCampaignConfig(campaignConfigOf(events));
  return saved.ok ? [describeConfig(saved.config)] : [];
};

const recapText = (name: string, state: CampaignState) =>
  [
    ...savedSettings(state.events),
    sceneText(state.currentScene?.title ?? name, recap(state.characters, playTurns(state).at(-1))),
  ].join('\n');

const viewSourceOf = (database: Session['database'], campaignId: CampaignId, state: CampaignState) => ({
  state,
  eventScopes: [...scopeLookupOf(database, campaignId)(state.events.map(({ id }) => id))].map(([id, scope]) => ({
    id,
    ...scope,
  })),
  ...worldOf(database)(campaignId, state.characters[0]?.id),
});

const readView = (dataDir: string, name: string, view: ViewName) =>
  withSession(
    dataDir,
    name,
    ({ engine, campaignId, database }) => {
      const state = engine.getState(campaignId);
      if (view === RECAP_VIEW) return recapText(name, state);
      return renderView(view, viewSourceOf(database, campaignId, state));
    },
    true,
  );

const decodedName = (encoded: string): string[] => {
  try {
    return [decodeURIComponent(encoded)];
  } catch {
    return [];
  }
};

const savedCampaigns = (dataDir: string) =>
  existsSync(dataDir)
    ? readdirSync(dataDir)
        .filter((file) => file.endsWith(DATABASE_EXTENSION))
        .flatMap((file) => decodedName(file.slice(0, -DATABASE_EXTENSION.length)))
        .sort()
    : [];

const readSummary = (path: string, lastPlayedAt: string): CampaignSummary | CampaignHealth => {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const version = database.prepare(SELECT_SCHEMA_VERSION).get()?.version;
    if (version !== KNOWN_SCHEMA_VERSION) return Number(version) < KNOWN_SCHEMA_VERSION ? NEEDS_MIGRATION : UNREADABLE;
    const row = database.prepare(SELECT_CAMPAIGN_ID).get();
    if (row === undefined) return UNREADABLE;
    const campaignId = String(row.id);
    const state = createEngine(createCampaignStore(database)).getState(campaignId);
    return campaignSummaryOf(viewSourceOf(database, campaignId, state), PLAYER_VIEWER, lastPlayedAt);
  } finally {
    database.close();
  }
};

export const summaryOf = (dataDir: string, name: string): CampaignSummary => {
  let lastPlayedAt: string | null = null;
  try {
    const path = databasePath(dataDir, name);
    lastPlayedAt = statSync(path).mtime.toISOString();
    const read = readSummary(path, lastPlayedAt);
    return typeof read === 'string' ? { ...UNREAD_SUMMARY, name, health: read, lastPlayedAt } : { ...read, name };
  } catch {
    return { ...UNREAD_SUMMARY, name, health: UNREADABLE, lastPlayedAt };
  }
};

export const listCampaignSummaries = (dataDir: string): CampaignSummary[] =>
  savedCampaigns(dataDir).map((name) => summaryOf(dataDir, name));

export const listArchivedSummaries = (dataDir: string): CampaignSummary[] =>
  listCampaignSummaries(join(dataDir, ARCHIVE_DIR));

const listed = (names: readonly string[]) => (names.length === 0 ? NONE : names.join(', '));

const list = (dataDir: string) =>
  `Campaigns: ${listed(savedCampaigns(dataDir))}\nArchived: ${listed(savedCampaigns(join(dataDir, ARCHIVE_DIR)))}`;

export const archiveCampaign = (dataDir: string, name: string) => {
  const from = databasePath(dataDir, name);
  const to = archivePath(dataDir, name);
  if (!existsSync(from)) throw missingCampaign(dataDir, name);
  mkdirSync(join(dataDir, ARCHIVE_DIR), { recursive: true });
  try {
    linkSync(from, to);
  } catch (error) {
    if (isFileExists(error)) throw new LocalizedError('campaign.archivedExists', { name });
    throw error;
  }
  rmSync(from);
  return `Archived campaign ${name}. Its saved state is kept in ${to}.`;
};

export const unarchiveCampaign = (dataDir: string, name: string) => {
  const from = archivePath(dataDir, name);
  if (!existsSync(from)) throw new LocalizedError('campaign.noArchived', { name });
  try {
    linkSync(from, databasePath(dataDir, name));
  } catch (error) {
    if (isFileExists(error)) throw new LocalizedError('campaign.exists', { name });
    throw error;
  }
  rmSync(from);
};

const deletionGuidance = (name: string, path: string, archived: boolean) =>
  [
    `Deleting campaign ${name} removes its saved state for good.`,
    `To back up first, copy ${path} somewhere safe.`,
    ...(archived ? [] : [`Run rpg archive ${name} to hide it and keep its state instead.`]),
    `Type ${name} to delete it, or anything else to keep it.`,
  ].join('\n');

const savedFile = (dataDir: string, name: string) => {
  const active = databasePath(dataDir, name);
  const archived = !existsSync(active);
  const path = archived ? archivePath(dataDir, name) : active;
  if (!existsSync(path)) throw missingCampaign(dataDir, name);
  return { path, archived };
};

const fileIdentity = (dataDir: string, name: string) => {
  const stats = statSync(databasePath(dataDir, name), { throwIfNoEntry: false });
  return stats === undefined ? undefined : `${stats.dev}:${stats.ino}`;
};

export const isSameCampaignFile = (dataDir: string, name: string, other: string) => {
  const identity = fileIdentity(dataDir, name);
  return identity !== undefined && identity === fileIdentity(dataDir, other);
};

export const deleteCampaign = (dataDir: string, name: string, confirm: string, archived = false) => {
  const path = archived ? archivePath(dataDir, name) : savedFile(dataDir, name).path;
  if (!existsSync(path)) throw missingCampaign(dataDir, name);
  if (confirm !== name) throw new LocalizedError('campaign.keptToken', { name });
  rmSync(path);
};

export const createCampaignFrom = (dataDir: string, command: CreateCampaign, client?: string): CampaignSummary => {
  const { name, language } = command;
  const config = commandConfig(command, client);
  const character = startingCharacter(config);
  createCampaign(dataDir, name, openingFor(config, DEFAULT_OPENING), config, language);
  try {
    if (character !== undefined) addCharacter(dataDir, name, character);
  } catch (error) {
    rmSync(databasePath(dataDir, name), { force: true });
    throw error;
  }
  return summaryOf(dataDir, name);
};

const remove = async function* (dataDir: string, name: string, lines: AsyncIterable<string>) {
  const { path, archived } = savedFile(dataDir, name);
  yield deletionGuidance(name, path, archived);
  let answer: string | undefined;
  for await (const line of lines) {
    answer = line.trim();
    break;
  }
  if (answer !== name) {
    yield `Kept campaign ${name}.`;
    return;
  }
  rmSync(path);
  yield `Deleted campaign ${name}.`;
};

const exportCampaign = (dataDir: string, name: string, file: string) => {
  const path = databasePath(dataDir, name);
  if (!existsSync(path)) throw missingCampaign(dataDir, name);
  const { rulesets } = exportArchive(path, file);
  return `Exported campaign ${name} with ${rulesets.length} rulepack pin(s) to ${file}.`;
};

const backup = (dataDir: string, name: string) => {
  const path = databasePath(dataDir, name);
  if (!existsSync(path)) throw missingCampaign(dataDir, name);
  return `Backed up campaign ${name} to ${backupArchive(dataDir, name, path)}.`;
};

export const campaignDatabases = (dataDir: string): CampaignFile[] => [
  ...savedCampaigns(dataDir).map((name) => ({ name, database: databasePath(dataDir, name) })),
  ...savedCampaigns(join(dataDir, ARCHIVE_DIR)).map((name) => ({ name, database: archivePath(dataDir, name) })),
];

const newCampaignConfig = (intent: string | undefined, client: string | undefined) => {
  try {
    return planCampaign(intent, client === undefined ? {} : { client });
  } catch (error) {
    if (!(error instanceof ClientUnsupported)) throw error;
    throw new LocalizedError('campaign.addClient', { message: error.message, client: error.client });
  }
};

const restore = (dataDir: string, file: string) => {
  mkdirSync(dataDir, { recursive: true });
  const { campaign } = restoreArchive(file, dataDir, (name) => databasePath(dataDir, name));
  return `Restored campaign ${campaign}. Run rpg resume ${campaign} to continue.`;
};

export type GmSettingsChanges = Partial<Record<keyof GmSettings, string>>;

const UNSET = 'unset';
const BUDGET_KEY = 'sessionBudgetTokens';
const INVALID_GM_SETTINGS =
  'Choose a model name without spaces or a leading dash, and a session budget that is a whole number of tokens.';
const APP_DEFAULTS_TITLE = 'App defaults for every campaign:';

const changedSettings = (current: GmSettings, changes: GmSettingsChanges): GmSettings => {
  const next: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) continue;
    if (value === UNSET) delete next[key];
    else next[key] = key === BUDGET_KEY ? Number(value) : value;
  }
  const valid = toGmSettings(next);
  if (valid === undefined) throw new Error(INVALID_GM_SETTINGS);
  return valid;
};

const gmSettingsCommand = (dataDir: string, name: string | undefined, changes: GmSettingsChanges): string => {
  if (name === undefined) {
    const defaults = changedSettings(readGmDefaults(dataDir), changes);
    writeGmDefaults(dataDir, defaults);
    return [APP_DEFAULTS_TITLE, ...gmSettingsLines(defaults)].join('\n');
  }
  const defaults = readGmDefaults(dataDir);
  return withSession(dataDir, name, (session) => {
    const { engine, campaignId } = session;
    const settings = changedSettings(gmSettingsOf(engine.getState(campaignId).changes), changes);
    if (Object.values(changes).some((value) => value !== undefined))
      engine.saveGmSettings({
        campaignId,
        actionId: randomUUID(),
        expectedRevision: engine.getState(campaignId).revision,
        settings,
      });
    const gm = gmSnapshotFor(session, defaults) ?? {
      settings: defaults,
      session: EMPTY_GM_USAGE_TOTALS,
      campaign: EMPTY_GM_USAGE_TOTALS,
    };
    return gmUsageLines(gm)
      .filter((line) => !line.startsWith('This session'))
      .join('\n');
  });
};

export const createEngineGateway = (
  dataDir: string,
  gm: GameMaster = FAKE_GAME_MASTER,
  rng: Rng = Math.random,
  makeSpeech: MakeSpeech = makeLiveSpeech,
): CampaignGateway => ({
  home: (terminal) =>
    runHome(
      {
        list: () => listCampaignSummaries(dataDir),
        archived: () => listArchivedSummaries(dataDir),
        archive: (name) => void archiveCampaign(dataDir, name),
        unarchive: (name) => unarchiveCampaign(dataDir, name),
        remove: (name, confirm, archived) => deleteCampaign(dataDir, name, confirm, archived),
        play: (name, playing) => playTui(dataDir, name, playing, gm, rng, makeSpeech),
        start: (lines, locale) => guidedStart(dataDir, lines, createCampaignFrom, locale),
      },
      terminal,
    ),
  list: () => list(dataDir),
  archive: (name) => archiveCampaign(dataDir, name),
  remove: (name, lines) => remove(dataDir, name, lines),
  exportCampaign: (name, file) => exportCampaign(dataDir, name, file),
  backup: (name) => backup(dataDir, name),
  restore: (file) => restore(dataDir, file),
  update: (request) =>
    updateCommand(
      defaultUpdateContext(dataDir, () => campaignDatabases(dataDir)),
      request,
    ),
  create: async function* (name, intent, ask, client, language) {
    const config = newCampaignConfig(intent, client);
    const scene = createCampaign(dataDir, name, openingFor(config, DEFAULT_OPENING), config, language);
    yield `${SAVED_SETTINGS}\n${describeConfig(config)}\n${scene}`;
    const character = await characterFor(dataDir, name, config, ask);
    if (character !== undefined) yield character;
  },
  view: (name, view) => readView(dataDir, name, view),
  tui: (name, terminal) => playTui(dataDir, name, terminal, gm, rng, makeSpeech),
  start: (lines, locale) => guidedStart(dataDir, lines, createCampaignFrom, locale),
  importRules: (files, lines) => importRules(process.cwd(), files, lines),
  open: async function* (name, _mode, lines, onTurnError) {
    yield readView(dataDir, name, RECAP_VIEW);
    const sessionId = randomUUID();
    let warned = false;
    for await (const line of lines) {
      if (line.trim() === '') continue;
      let acted: Acted;
      try {
        acted = await act(dataDir, name, line.trim(), gm, rng, sessionId);
      } catch (error) {
        onTurnError(error);
        continue;
      }
      yield acted.narration;
      if (acted.warning !== undefined && !warned) yield acted.warning;
      warned ||= acted.warning !== undefined;
    }
  },
  settings: (name, changes) => gmSettingsCommand(dataDir, name, changes),
});
