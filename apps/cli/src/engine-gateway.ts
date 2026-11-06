import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, linkSync, mkdirSync, openSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { budgetWarning, gmSettingsLines, gmUsageLines } from '../../../packages/client-protocol/src/gm-usage.ts';
import {
  type CampaignHealth,
  type CampaignPlay,
  type CampaignSummary,
  type ClientSession,
  type CreateCampaign,
  MAX_INPUT_LENGTH,
  PROTOCOL_VERSION,
} from '../../../packages/client-protocol/src/protocol.ts';
import type { GmRoute } from '../../../packages/client-protocol/src/wire.ts';
import {
  type CampaignEvent,
  type CampaignId,
  type CampaignState,
  type CampaignStore,
  type CommittedTurn,
  GM_ROLLED,
  OPENING_ACTION_ID,
  type Turn,
} from '../../../packages/domain/src/campaign.ts';
import { EMPTY_GM_USAGE_TOTALS, type GmSettings, type GmUsage, toGmSettings } from '../../../packages/domain/src/gm.ts';
import { commitCharacter, editSheetField, playTurns } from '../../../packages/engine/src/character.ts';
import { pendingCheckOffer } from '../../../packages/engine/src/check-offer.ts';
import { campaignLanguageOf, createEngine, type Engine } from '../../../packages/engine/src/engine.ts';
import {
  type GameplayOutcome,
  type NarrationContext,
  type Narrator,
  narrateTurn,
  playGameplayTurn,
} from '../../../packages/engine/src/gameplay.ts';
import {
  contextRatioOf,
  gmSettingsOf,
  recordContextDiagnostics,
  recordGmUsage,
} from '../../../packages/engine/src/gm-settings.ts';
import { contextBudgetOf } from '../../../packages/engine/src/memory.ts';
import { oocStateOf, withoutRetconned } from '../../../packages/engine/src/ooc.ts';
import type { RulesDocument } from '../../../packages/engine/src/own-rules.ts';
import { GameMasterInterruptedError } from '../../../packages/engine/src/scripted-session.ts';
import {
  correctStoryFact,
  directoryOf,
  readStoryMemory,
  recordContinuityConflict,
} from '../../../packages/engine/src/story-memory.ts';
import {
  CHECK_RESOLVED,
  CHECK_SKIPPED,
  campaignConfigOf,
  loadState,
  openScene,
  performAction,
  storedTurn,
} from '../../../packages/engine/src/turn.ts';
import { voiceSettingsOf } from '../../../packages/engine/src/voice-settings.ts';
import { type CampaignConfig, parseCampaignConfig } from '../../../packages/intent/src/config.ts';
import { PLAYER_VIEWER } from '../../../packages/memory/src/knowledge.ts';
import { buildLedger } from '../../../packages/memory/src/ledger.ts';
import type { ContextPacket } from '../../../packages/memory/src/packet.ts';
import {
  type ContinuityLogRecord,
  enforceContinuity,
  type ModelContinuityCheck,
} from '../../../packages/narrative/src/continuity.ts';
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
  type StoryPort,
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
  requestText,
  storedApiKey,
  streamNarration,
  summaryRouteOf,
} from './gm-api.ts';
import {
  type ClaudeCodeRoute,
  claudeCodeRouteOf,
  launchClaude,
  requestClaudeNarration,
  requestClaudeSummary,
  requestClaudeText,
} from './gm-claude-code.ts';
import { MalformedStreamReply, requestClaudeStream } from './gm-claude-stream.ts';
import {
  contextPacketOf,
  fakeSummarizer,
  openingPacketOf,
  previousNarrationsOf,
  type Summarizer,
  summarizeCampaign,
} from './gm-context.ts';
import { modelContinuityCheckOf } from './gm-continuity.ts';
import { readGmDefaults, writeGmDefaults } from './gm-defaults.ts';
import { requestFitting, TOO_LONG_MESSAGE } from './gm-limits.ts';
import { modelOocReplyOf, type OocReplier } from './gm-ooc-model.ts';
import {
  CHECK_PROPOSAL,
  commitGmRolls,
  commitProposals,
  ENTITY_PROPOSAL,
  type EntityProposal,
  type GmProposal,
  gmRollLinesOf,
  outcomeClaimsOf,
} from './gm-proposals.ts';
import { repeatedLinesOf } from './gm-repetition.ts';
import { type GmSegment, narrationOf, narratorSegments, turnSegmentsOf } from './gm-segments.ts';

export { FAKE_GM_REPLY } from './gm-api.ts';

import { importRules } from './import-gateway.ts';
import { type InstalledRuleset, installedRulesetIn } from './installed-rulesets.ts';
import type { CampaignGateway } from './main.ts';
import { DEFAULT_LOCALE, LocalizedError, say } from './messages.ts';
import { loadOwnRules } from './own-rules-files.ts';
import {
  ClientUnsupported,
  commandConfig,
  creationRulesFor,
  describeConfig,
  isPitch,
  type Opening,
  openingFor,
  type Packs,
  packsIn,
  packsWith,
  pitchNotes,
  planCampaign,
  startingCharacter,
  titleOf,
  UnknownEdition,
} from './quickstart.ts';
import {
  checkForAction,
  checkRulesFor,
  combatRulesOf,
  enforcedStrictnessFor,
  gmRollExpressionFor,
  gmRollsAllowed,
  modifierPolicyOf,
  rulesStrictnessFor,
  whoRollsFor,
} from './roll-visualization.ts';
import type { SoundRequest } from './sound-command.ts';
import { SOUND_SETTINGS_FILE } from './sound-files.ts';
import type { SoundRuntime } from './sound-runtime.ts';
import type { SpeechRuntime } from './speech-runtime.ts';
import { runTui, type Terminal, type TuiPlayback } from './tui.ts';
import { runHome } from './tui-home.ts';
import { guidedStart } from './tui-start.ts';
import type { TurnSpeech } from './turn-speech.ts';
import { type CampaignFile, defaultUpdateContext, updateCommand } from './update.ts';
import { editableSheet, renderView, type ViewName } from './views.ts';
import type { VoiceModelRequest } from './voice-model-command.ts';

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
const OPENING_ENTITY_ID = 'opening-scene';
const SETTING_KIND = 'location';
export const GENERIC_OPENING_NOTICE =
  'This opening is generic: no AI game master is available to build one from your pitch.';
const ARCHIVE_DIR = 'archive';
const NONE = 'none';
const CHARACTER_PROMPT = `Describe your character, or press Enter to play as ${HERO_NAME}.`;
const CREATE_CHARACTER_INTENT = 'create character';
const SUMMARY_SETTLE_MS = 10_000;
export const NO_KEY_NOTICE = `No AI game master is set up, so the built-in narrator tells the story. Install Claude Code or set ${API_KEY_ENV} to play with one.`;
export const GM_NOTICES: Readonly<Record<GmRoute, string>> = {
  'claude-code': 'The game master is Claude Code on this computer.',
  api: `The game master is Claude through your ${API_KEY_ENV}.`,
  fake: NO_KEY_NOTICE,
};
const NO_FACTS: NarrationContext = {
  facts: [],
  equipment: {},
  viewer: PLAYER_VIEWER,
};
const PENDING_NARRATION = '';
const TOO_LONG_STEP = 0;
const NO_FAILED_TURNS: ReadonlySet<string> = new Set();
const NO_SEGMENTS: readonly GmSegment[] = [];
const NO_REPEATS = 0;
const NO_CONFLICTS: readonly string[] = [];
const NO_GM_ROLLS: readonly string[] = [];
const NO_LEDGER_ENTRIES = 0;

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

type PacketNarrator = (packet: ContextPacket) => GmTurnReply;

const narratingEngine = (
  store: CampaignStore,
  database: Session['database'],
  narrate: PacketNarrator,
  rng: Rng,
  dataDir: string,
): Engine => {
  const narrator: Narrator = {
    narrate: (committed) => ({
      narration: narrate(
        contextPacketOf(
          database,
          withoutRetconned(loadState(store, committed.turn.campaignId)),
          committed,
          undefined,
          undefined,
          undefined,
          { packs: packsWith(() => installedRulesetIn(dataDir, loadState(store, committed.turn.campaignId).events)) },
        ),
      ).narration,
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
  readonly onSegment?: (segment: GmSegment) => void;
};
type GmTurnReply = {
  readonly narration: string;
  readonly segments: readonly GmSegment[];
  readonly proposals?: readonly GmProposal[];
  readonly usage?: GmUsage;
};
type PacketRequest = (packet: ContextPacket, call: GmCall) => Promise<GmTurnReply>;
type ModelSummarizer = (
  ...[level, texts, language, model, onUsage]: [...Parameters<Summarizer>, string?, ((usage: GmUsage) => void)?]
) => ReturnType<Summarizer>;

export type GameMaster = ({ readonly narrator: PacketNarrator } | { readonly request: PacketRequest }) & {
  readonly summarizer: ModelSummarizer;
  readonly notice?: string;
  readonly calibratesContext?: boolean;
  readonly continuityCheck?: ModelContinuityCheck;
  readonly oocReply?: OocReplier;
};

const narratorReply = (narration: string): GmTurnReply => ({
  narration,
  segments: narratorSegments(narration),
});

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

const chosen = (model: string | undefined) => (model === PROVIDER_DEFAULT_MODEL ? undefined : model);

export const apiGameMaster = (route: ApiRoute, summaryRoute: ApiRoute = route): GameMaster => ({
  request: (packet, { model, onSegment }) => {
    const routed = { ...route, model: chosen(model) ?? route.model };
    return onSegment === undefined ? requestNarration(routed, packet) : streamNarration(routed, packet, onSegment);
  },
  summarizer: (level, texts, language, model, onUsage) =>
    requestSummary({ ...summaryRoute, model: chosen(model) ?? summaryRoute.model }, level, texts, language, onUsage),
  calibratesContext: true,
  continuityCheck: modelContinuityCheckOf((system, content) => requestText(summaryRoute, system, content)),
  oocReply: modelOocReplyOf((system, content) => requestText(summaryRoute, system, content)),
});

export const claudeCodeGameMaster = (route: ClaudeCodeRoute): GameMaster => ({
  request: (packet, { databasePath, model, onSegment }) => {
    const routed = { ...route, model: chosen(model) ?? route.model };
    return onSegment === undefined
      ? requestClaudeNarration(routed, packet, databasePath)
      : requestClaudeStream(routed, packet, onSegment).catch((error: unknown) =>
          error instanceof MalformedStreamReply
            ? requestClaudeNarration(routed, packet, databasePath)
            : Promise.reject(error),
        );
  },
  summarizer: (level, texts, language, model, onUsage) =>
    requestClaudeSummary(
      { ...route, summaryModel: chosen(model) ?? route.summaryModel },
      level,
      texts,
      language,
      onUsage,
    ),
  continuityCheck: modelContinuityCheckOf((system, content) => requestClaudeText(route, system, content)),
  oocReply: modelOocReplyOf((system, content) => requestClaudeText(route, system, content)),
});

const chosenGameMaster = async (env: NodeJS.ProcessEnv): Promise<{ gm: GameMaster; route: GmRoute }> => {
  const chosen = env[GM_ROUTE_ENV];
  if (chosen === FAKE_ROUTE) return { gm: FAKE_GAME_MASTER, route: FAKE_ROUTE };
  const bin = chosen === API_ROUTE ? undefined : claudeBinOf(env);
  if (bin !== undefined)
    return {
      gm: claudeCodeGameMaster(claudeCodeRouteOf(bin, env)),
      route: CLAUDE_CODE_ROUTE,
    };
  if (chosen === CLAUDE_CODE_ROUTE) return { gm: noKeyGameMaster(), route: FAKE_ROUTE };
  const key = apiKeyOf(env, await storedApiKey(gmSecrets(env)));
  if (key === undefined) return { gm: noKeyGameMaster(), route: FAKE_ROUTE };
  const route = apiRouteOf(key, env);
  return {
    gm: apiGameMaster(route, summaryRouteOf(route, env)),
    route: API_ROUTE,
  };
};

export const gameMasterFor = async (env: NodeJS.ProcessEnv) => {
  const { gm, route } = await chosenGameMaster(env);
  return { gm: { ...gm, notice: GM_NOTICES[route] }, route };
};

type Session = {
  engine: Engine;
  rng: Rng;
  store: ReturnType<typeof createCampaignStore>;
  campaignId: string;
  database: ReturnType<typeof openDatabase>['database'];
  installedRuleset: (events: readonly CampaignEvent[]) => InstalledRuleset | undefined;
};

type SpokenTurn = { readonly voice?: TurnSpeech; readonly notice?: string };
type SpeakTurn = (turnId: string) => Promise<SpokenTurn>;

const streamOf = (voice: TurnSpeech | undefined, listener: StreamedSegment | undefined, turnId: string) => {
  const heard = voice?.streams ? voice.heard : undefined;
  const shown = voice?.streams ? listener : undefined;
  if (heard === undefined && shown === undefined) return undefined;
  return (segment: GmSegment) => {
    heard?.(segment);
    shown?.(turnId, segment.text);
  };
};

const acceptMarkedCheck = (
  { engine, campaignId, database, installedRuleset }: Session,
  committed: CommittedTurn,
  proposals: readonly GmProposal[],
  offeredNow: readonly CommittedTurn[],
  defaults: GmSettings,
): boolean => {
  const state = engine.getState(campaignId);
  const offer = pendingCheckOffer(state.events);
  const marked =
    offeredNow.some(({ events }) => pendingCheckOffer(events)?.offerId === offer?.offerId) &&
    proposals.some(
      (proposal) => proposal.kind === CHECK_PROPOSAL && proposal.needsCheck === true && proposal.id === offer?.offerId,
    );
  const whoRolls = whoRollsFor(state, defaults);
  if (!marked || offer === undefined || whoRolls === 'me') return false;
  if (committed.events.some(({ type }) => type === CHECK_RESOLVED)) return false;
  const { sceneId, actorId } = committed.turn;
  engine.submitAction(
    {
      campaignId,
      actionId: randomUUID(),
      expectedRevision: state.revision,
      sceneId,
      actorId,
      input: offer.label,
      intent: offer.label,
    },
    checkForAction(
      state.events,
      {
        input: offer.label,
        rollOfferId: offer.offerId,
        whoRolls,
        houseRules: oocStateOf(state.changes).houseRules,
        installed: installedRuleset(state.events),
      },
      actorId,
      worldOf(database)(campaignId, actorId).entities,
      rulesStrictnessFor(state, defaults),
    ),
  );
  return true;
};

const oldestPendingTurn = (state: CampaignState, failed: ReadonlySet<string> = NO_FAILED_TURNS) =>
  playTurns(state)
    .map(({ actionId }) => storedTurn(state, actionId))
    .find((turn) => turn?.turn.narration === PENDING_NARRATION && !failed.has(turn.turn.id));

type RoutedModel = {
  readonly calibrates: boolean;
  readonly model: string | undefined;
};

const narrateLatest = async (
  session: Session,
  request: (packet: ContextPacket, onSegment?: (segment: GmSegment) => void) => Promise<GmTurnReply>,
  sessionId: string,
  speak: SpeakTurn,
  routed: RoutedModel,
  defaults: GmSettings,
  modelCheck: ModelContinuityCheck | undefined,
  listener?: StreamedSegment,
  failed: ReadonlySet<string> = NO_FAILED_TURNS,
): Promise<readonly GmSegment[]> => {
  const { engine, store, campaignId, database, rng } = session;
  const state = engine.getState(campaignId);
  const committed = oldestPendingTurn(state, failed);
  if (committed === undefined) return NO_SEGMENTS;
  const preset = contextBudgetOf(state.changes);
  const language = campaignLanguageOf(state.changes);
  const ratio = contextRatioOf(state.changes, language);
  let sent: ContextPacket | undefined;
  let usage: GmUsage | undefined;
  let segments: readonly GmSegment[] = NO_SEGMENTS;
  let proposals: readonly GmProposal[] = [];
  const { voice, notice: voiceNotice } = await speak(committed.turn.id);
  const enforced = enforcedStrictnessFor(state, defaults);
  const checkPending =
    enforced !== undefined && !committed.events.some(({ type }) => type === CHECK_RESOLVED || type === CHECK_SKIPPED);
  let reply: GmTurnReply | undefined;
  const previous = previousNarrationsOf(state, committed);
  const forward = streamOf(checkPending ? undefined : voice, listener, committed.turn.id);
  const strictness = rulesStrictnessFor(state, defaults);
  const rolling = gmRollsAllowed(state.events, strictness);
  const ledger = buildLedger(state.events);
  const guarded = ledger.length > NO_LEDGER_ENTRIES;
  const withVoiceNotice = (shown: readonly GmSegment[]) =>
    voiceNotice === undefined ? shown : [{ text: voiceNotice }, ...shown];
  const generate = async (
    retried: readonly unknown[] | undefined,
    repeated: readonly string[],
    gmRolls: readonly string[] = NO_GM_ROLLS,
    streamed = true,
    contradicted: readonly string[] = NO_CONFLICTS,
  ) => {
    const live = streamed && !guarded;
    const fitted = await requestFitting({
      first: preset,
      packetOf: (chosenPreset) =>
        contextPacketOf(database, state, committed, PLAYER_VIEWER, chosenPreset, ratio, {
          defaults,
          retry: retried !== undefined,
          repeated,
          contradicted,
          gmRolls,
          packs: packsWith(() => session.installedRuleset(state.events)),
        }),
      send: (packet) => {
        if (live) voice?.restart();
        return request(packet, live ? forward : undefined);
      },
      ratio,
      model: routed.model,
    }).catch((error: unknown) => {
      if (!(error instanceof ProviderError && error.message === TOO_LONG_MESSAGE)) {
        voice?.abandon();
        throw error;
      }
      segments = withVoiceNotice(narratorSegments(withNotice(error.message)));
      throw new GameMasterInterruptedError(TOO_LONG_STEP);
    });
    reply = fitted.reply;
    sent = fitted.packet;
    usage = reply.usage;
    if (usage !== undefined) recordGmUsage(store, { campaignId, turnId: committed.turn.id, sessionId, usage });
    return fitted.reply;
  };
  const narrator = {
    narrate: async (_turn: CommittedTurn, retried?: readonly unknown[]) => {
      const earlier = gmRollLinesOf(store, committed);
      const alreadyRolled = earlier.length > NO_GM_ROLLS.length;
      const drafted = await generate(retried, [], earlier, !rolling && !alreadyRolled);
      const rolled = alreadyRolled
        ? earlier
        : commitGmRolls(
            store,
            createEntityStore(database),
            committed,
            drafted.proposals ?? [],
            (spec) => gmRollExpressionFor(state.events, strictness, spec),
            rng,
            modifierPolicyOf(state.events, strictness),
          ).flatMap(({ events }) =>
            events
              .filter(({ type }) => type === GM_ROLLED)
              .map(({ type, payload }) => `${type} ${JSON.stringify(payload)}`),
          );
      const first =
        alreadyRolled || rolled.length === NO_GM_ROLLS.length ? drafted : await generate(retried, [], rolled);
      const repeated = retried === undefined ? repeatedLinesOf(first.narration, previous) : [];
      let final = first;
      if (repeated.length > NO_REPEATS) {
        final = await generate(retried, repeated, rolled);
      }
      if (guarded) {
        const logs: ContinuityLogRecord[] = [];
        const continuity = await enforceContinuity({
          ledger,
          directory: directoryOf(state, createEntityStore(database)),
          ...(modelCheck === undefined ? {} : { modelCheck }),
          generate: async (conflicts) => {
            if (conflicts.length === NO_CONFLICTS.length) return final.narration;
            const facts = conflicts.filter(({ hidden }) => hidden !== true).map(({ fact }) => fact);
            final = await generate(retried, repeated, rolled, false, facts);
            return final.narration;
          },
          log: (record) => logs.push(record),
        });
        if (continuity.narration !== final.narration) {
          final = { ...final, narration: continuity.narration, segments: narratorSegments(continuity.narration) };
          reply = final;
        }
        for (const record of logs)
          recordContinuityConflict(store, {
            campaignId,
            actionId: randomUUID(),
            expectedRevision: loadState(store, campaignId).revision,
            record,
          });
      }
      segments = withVoiceNotice(final.segments);
      proposals = final.proposals ?? [];
      const narration = voiceNotice === undefined ? final.narration : `${voiceNotice} ${final.narration}`;
      return { narration, claims: outcomeClaimsOf(proposals), segments: turnSegmentsOf(segments) };
    },
  };
  const facts = createFactStore(database).listFacts(campaignId);
  const context = {
    facts,
    equipment: {},
    viewer: PLAYER_VIEWER,
    ...(enforced === undefined ? {} : { rulesStrictness: enforced }),
  };
  const outcome = await narrateTurn(store, narrator, committed, context).catch((error: unknown) => {
    voice?.abandon();
    throw error;
  });
  let offeredNow: readonly CommittedTurn[] = [];
  const unnarrated = 'inconsistent' in outcome || 'interrupted' in outcome;
  const failedTurns = new Set([...failed, committed.turn.id]);
  if (unnarrated) {
    voice?.abandon();
  } else {
    if ('narration' in outcome && reply !== undefined) voice?.settle(reply);
    offeredNow = commitProposals(
      store,
      createEntityStore(database),
      createFactStore(database),
      committed,
      proposals,
      checkRulesFor(state.events, rulesStrictnessFor(state, defaults)),
      modifierPolicyOf(state.events, rulesStrictnessFor(state, defaults)),
      combatRulesOf(state.events),
    );
  }
  if (sent !== undefined)
    recordContextDiagnostics(store, {
      campaignId,
      turnId: committed.turn.id,
      events: state.changes,
      language,
      packet: sent,
      reportedTokens: usage === undefined || !routed.calibrates ? 0 : reportedInputOf(usage),
    });
  const morePending = oldestPendingTurn(engine.getState(campaignId), failedTurns);
  if (acceptMarkedCheck(session, committed, proposals, offeredNow, defaults) || morePending !== undefined)
    return narrateLatest(session, request, sessionId, speak, routed, defaults, modelCheck, listener, failedTurns);
  return 'inconsistent' in outcome ? withVoiceNotice(narratorSegments(FAKE_GM_REPLY)) : segments;
};

const recordSummaryUsage = ({ store, engine, campaignId }: Session, sessionId: string, usage: GmUsage) => {
  try {
    const turnId = engine.getState(campaignId).turns.at(-1)?.id;
    if (turnId !== undefined)
      recordGmUsage(store, { campaignId, turnId, sessionId, usage: { ...usage, summary: true } });
  } catch {}
};

const settled = () => delay(SUMMARY_SETTLE_MS, undefined, { ref: false });
let summarizing: Promise<void> = Promise.resolve();

const summarizeInBackground = ({ store, campaignId, database }: Session, summarizer: Summarizer) => {
  const job = () => summarizeCampaign(database, store, campaignId, summarizer);
  summarizing = summarizing.then(() => Promise.race([job(), settled()])).catch(() => {});
  return summarizing;
};

export type StreamedSegment = (turnId: string, segment: string) => void;

type OpenSession = Session & {
  sessionId: string;
  gmDefaults: () => GmSettings;
  narrate: (onSegment?: StreamedSegment) => Promise<readonly GmSegment[]>;
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
  uiLocale = DEFAULT_LOCALE,
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
    const engine =
      'narrator' in gm ? narratingEngine(store, database, gm.narrator, rng, dataDir) : createEngine(store, rng);
    const session = {
      engine,
      rng,
      store,
      campaignId: String(row.id),
      database,
      installedRuleset: (events: readonly CampaignEvent[]) => installedRulesetIn(dataDir, events),
    };
    const gmDefaults = () => readGmDefaults(dataDir);
    let summarized: Promise<void> = Promise.resolve();
    const speakTurn: SpeakTurn = async (turnId) => {
      const { changes } = engine.getState(session.campaignId);
      const settings = voiceSettingsOf(changes);
      if (speech === undefined || settings === undefined || settings.spokenOutput === SPOKEN_OFF) return {};
      const { campaignId } = session;
      try {
        const [
          { createTurnSpeech, narratorProfileOf },
          { assignedNpcVoices, utterancesFor },
          { voiceLocaleFor },
          { optedInNarrator, prepareVoice, takePreloadFailureNotice, withOptedInNarrator },
          { installedVoices },
        ] = await Promise.all([
          import('./turn-speech.ts'),
          import('./turn-utterances.ts'),
          import('../../../packages/voice/src/language-voices.ts'),
          import('./speech-runtime.ts'),
          import('../../../packages/voice/src/npc-voice.ts'),
        ]);
        const campaignLanguage = campaignLanguageOf(changes);
        const runtime = await speech();
        const { route } = runtime;
        const narrator = narratorProfileOf(
          campaignLanguage === undefined ? settings.locale : voiceLocaleFor(campaignLanguage, settings.locale),
          route,
          settings.speed,
        );
        const chosenNarrator = withOptedInNarrator(narrator, optedInNarrator(dataDir, narrator.language));
        const entities = createEntityStore(database);
        const npcVoices = assignedNpcVoices({ entities, campaignId, narrator, assigned: settings.npcVoices ?? {} });
        prepareVoice(runtime.providers, narrator.language, route, uiLocale);
        const notice =
          takePreloadFailureNotice(runtime.providers, narrator.language, route, uiLocale) ??
          runtime.takeFailureNotice();
        const voice = createTurnSpeech({
          speech: runtime.speech,
          turnId,
          mode: settings.spokenOutput,
          narrator: chosenNarrator,
          narratorFallback: narrator,
          utterancesOf: (segments) =>
            utterancesFor({
              store,
              entities,
              campaignId,
              turnId,
              segments,
              narrator,
              route,
              npcVoices,
              installed: () => installedVoices(runtime.providers, narrator.language),
            }),
        });
        return { voice, ...(notice === undefined ? {} : { notice }) };
      } catch {
        return {};
      }
    };
    const narrate = async (onSegment?: StreamedSegment) => {
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
              { calibrates: gm.calibratesContext === true, model },
              gmDefaults(),
              gm.continuityCheck,
              onSegment,
            )
          : NO_SEGMENTS;
      summarized = summarizeInBackground(session, (level, texts, language) =>
        gm.summarizer(level, texts, language, summaryModel, (usage) => recordSummaryUsage(session, sessionId, usage)),
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
    editableSheet(
      {
        state: engine.getState(campaignId),
        eventScopes: [],
        ...readWorld(campaignId, actorId),
      },
      actorId,
    ),
  commit: (edit) => {
    editSheetField(store, edit);
  },
});

const storyOf = ({ store }: Session, database: DatabaseSync): StoryPort => {
  const entities = createEntityStore(database);
  return {
    read: (campaignId) => readStoryMemory(store, entities, campaignId),
    correct: (correction) => {
      correctStoryFact(store, entities, correction);
    },
  };
};

export const openClientSession = (
  dataDir: string,
  name: string,
  gm: GameMaster = FAKE_GAME_MASTER,
  rng: Rng = Math.random,
  speech?: SpeechSource,
  uiLocale = DEFAULT_LOCALE,
) => {
  const opened = openSession(dataDir, name, false, gm, rng, speech, undefined, uiLocale);
  const { engine, campaignId, database, narrate, settle, close, sessionId, gmDefaults } = opened;
  try {
    const readWorld = worldOf(database);
    const sessions = createClientSessions(
      engine,
      campaignId,
      scopedEventsOf(database),
      readWorld,
      sheetsOf(opened, readWorld),
      {
        sessionId,
        defaults: gmDefaults,
        story: storyOf(opened, database),
        oocReply: gm.oocReply,
        installedRuleset: opened.installedRuleset,
      },
    );
    const voiceLocale = () => {
      const settings = voiceSettingsOf(engine.getState(campaignId).changes);
      return settings === undefined || settings.spokenOutput === SPOKEN_OFF ? undefined : settings.locale;
    };
    return { session: sessions(PLAYER_VIEWER), campaignId, narrate, settle, close, voiceLocale };
  } catch (error) {
    close();
    throw error;
  }
};

const liveRuntimes = new Map<string, SpeechRuntime>();
const liveSounds = new Map<string, SoundRuntime>();

export const startSound = async (
  dataDir: string,
  session: Pick<ClientSession, 'getSnapshot' | 'subscribeEvents'>,
  campaignId: CampaignId,
  locale: string,
): Promise<string | undefined> => {
  if (!existsSync(join(dataDir, SOUND_SETTINGS_FILE))) return undefined;
  try {
    const { sceneSoundOf } = await import('../../../packages/voice/src/sound-selection.ts');
    const { createSoundRuntime, followScenes } = await import('./sound-runtime.ts');
    const snapshot = session.getSnapshot({ version: PROTOCOL_VERSION, type: 'GetCampaignSnapshot', campaignId });
    if (!snapshot.ok) throw new Error(snapshot.error.message);
    const { currentScene } = snapshot.value;
    const sound = createSoundRuntime(dataDir, { scene: sceneSoundOf(currentScene?.title, currentScene) });
    if (sound !== undefined) {
      const unfollow = followScenes(sound.controller, session, campaignId, snapshot.value);
      liveSounds.set(dataDir, {
        controller: sound.controller,
        dispose: () => {
          unfollow();
          sound.dispose();
        },
      });
    }
    return undefined;
  } catch (error) {
    return say(locale, 'sound.unavailable', { reason: error instanceof Error ? error.message : String(error) });
  }
};

const stopSound = (dataDir: string) => {
  liveSounds.get(dataDir)?.dispose();
  liveSounds.delete(dataDir);
};

export type MakeSpeech = (dataDir: string) => SpeechRuntime | Promise<SpeechRuntime>;

export const announcingSpeech =
  (onSpeaking: (active: boolean) => void): MakeSpeech =>
  async (dataDir) =>
    (await import('./speech-runtime.ts')).createLiveSpeechRuntime(dataDir, process.env, onSpeaking);

const makeLiveSpeech: MakeSpeech = (dataDir) =>
  announcingSpeech((active) => liveSounds.get(dataDir)?.controller.speaking(active))(dataDir);

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

const NOTICE_JOIN = ' ';

const speechNotice = async (speech: SpeechSource, locale: string, uiLocale: string) => {
  const [{ prepareVoice }, runtime] = await Promise.all([import('./speech-runtime.ts'), speech()]);
  return prepareVoice(runtime.providers, locale, runtime.route, uiLocale);
};

const playTui = async (
  dataDir: string,
  name: string,
  terminal: Terminal,
  gm: GameMaster,
  rng: Rng,
  makeSpeech: MakeSpeech,
) => {
  const speech = liveSpeech(dataDir, makeSpeech);
  const { session, campaignId, narrate, settle, close, voiceLocale } = openClientSession(
    dataDir,
    name,
    gm,
    rng,
    speech,
    terminal.locale ?? DEFAULT_LOCALE,
  );
  try {
    const locale = voiceLocale();
    const voiceNotice =
      locale === undefined
        ? undefined
        : await speechNotice(speech, locale, terminal.locale ?? DEFAULT_LOCALE).catch(() => undefined);
    const soundNotice = await startSound(dataDir, session, campaignId, terminal.locale ?? DEFAULT_LOCALE);
    const notice = [gm.notice, voiceNotice, soundNotice].filter((line) => line !== undefined).join(NOTICE_JOIN);
    await runTui(session, campaignId, terminal, narrate, notice || undefined, playbackFor(dataDir));
  } finally {
    stopSound(dataDir);
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

type Started = {
  readonly opening: Opening;
  readonly proposals: readonly GmProposal[];
  readonly generic: boolean;
  readonly pitch?: string;
  readonly usage?: GmUsage;
};

type Starter = (databasePath: string) => Promise<Started>;

const MICROPHONE_OFF = 'off';
const NORMAL_VOICE_SPEED = 1;

const savePlay = (
  engine: Engine,
  campaignId: string,
  { spokenOutput, ...gm }: CampaignPlay,
  language = DEFAULT_LOCALE,
) => {
  const revision = () => engine.getState(campaignId).revision;
  if (spokenOutput !== undefined)
    engine.saveVoiceSettings({
      campaignId,
      actionId: randomUUID(),
      expectedRevision: revision(),
      settings: { microphone: MICROPHONE_OFF, spokenOutput, locale: language, speed: NORMAL_VOICE_SPEED },
    });
  if (Object.keys(gm).length > 0)
    engine.saveGmSettings({ campaignId, actionId: randomUUID(), expectedRevision: revision(), settings: gm });
};

const createCampaign = async (
  dataDir: string,
  name: string,
  config: CampaignConfig,
  start: Starter,
  language?: string,
  play: CampaignPlay = {},
  rulesDocuments: readonly RulesDocument[] = [],
): Promise<string> => {
  mkdirSync(dataDir, { recursive: true });
  const path = databasePath(dataDir, name);
  claimFile(path, name);
  let connection: ReturnType<typeof openDatabase> | undefined;
  try {
    connection = openDatabase(path);
    const { database } = connection;
    const store = createCampaignStore(database);
    const engine = createEngine(store);
    const campaign = engine.createCampaign(name, language);
    savePlay(engine, campaign.id, play, language);
    const { opening, proposals, generic, pitch, usage } = await start(path);
    const committed = openScene(store, {
      campaignId: campaign.id,
      actorName: HERO_NAME,
      sceneTitle: opening.title,
      ...(opening.locationKind === undefined ? {} : { locationKind: opening.locationKind }),
      ...(opening.moodTags === undefined ? {} : { moodTags: opening.moodTags }),
      narration: opening.narration,
      config,
      rulesDocuments,
      ...(pitch === undefined ? {} : { pitch }),
    });
    if (usage !== undefined)
      recordGmUsage(store, { campaignId: campaign.id, turnId: committed.turn.id, sessionId: randomUUID(), usage });
    const state = engine.getState(campaign.id);
    const strictness = rulesStrictnessFor(state, readGmDefaults(dataDir));
    commitProposals(
      store,
      createEntityStore(database),
      createFactStore(database),
      committed,
      proposals,
      checkRulesFor(state.events, strictness),
      modifierPolicyOf(state.events, strictness),
      combatRulesOf(state.events),
    );
    connection.close();
    return generic
      ? `${sceneText(opening.title, opening.narration)}\n${GENERIC_OPENING_NOTICE}`
      : sceneText(opening.title, opening.narration);
  } catch (error) {
    connection?.close();
    rmSync(path, { force: true });
    throw error;
  }
};

const openingPlace = (opening: Opening): EntityProposal => ({
  kind: ENTITY_PROPOSAL,
  id: OPENING_ENTITY_ID,
  entityKind: SETTING_KIND,
  name: opening.title,
  visibility: 'player',
});

const isPlace = (proposal: GmProposal): proposal is EntityProposal =>
  proposal.kind === ENTITY_PROPOSAL && proposal.entityKind === SETTING_KIND;

const starterFor =
  (gm: GameMaster, { name, pitch, config, language, model }: StartRequest): Starter =>
  async (databasePath) => {
    const opening = openingFor(config, DEFAULT_OPENING, language);
    const generic = {
      opening,
      proposals: pitch === undefined ? [] : [openingPlace(opening)],
      generic: true,
      ...(pitch === undefined ? {} : { pitch }),
    };
    if (!('request' in gm)) return generic;
    let reply: GmTurnReply;
    try {
      reply = await gm.request(openingPacketOf(pitch ?? name, describeConfig(config), language), {
        databasePath,
        model,
      });
    } catch (error) {
      if (error instanceof ProviderError) return generic;
      throw error;
    }
    if (reply.narration.trim() === '' || reply.narration.endsWith(FAKE_GM_REPLY)) return generic;
    const proposals = reply.proposals ?? [];
    const place = proposals.find(isPlace);
    const gmOpening = {
      title: place?.name ?? name,
      narration: reply.narration,
      ...(place?.locationKind === undefined ? {} : { locationKind: place.locationKind }),
      ...(place?.mood === undefined ? {} : { moodTags: place.mood }),
    };
    return {
      opening: gmOpening,
      proposals: place === undefined ? [openingPlace(gmOpening), ...proposals] : proposals,
      generic: false,
      ...(pitch === undefined ? {} : { pitch }),
      ...(reply.usage === undefined ? {} : { usage: reply.usage }),
    };
  };

type StartRequest = {
  readonly name: string;
  readonly pitch: string | undefined;
  readonly config: CampaignConfig;
  readonly language?: string | undefined;
  readonly model?: string | undefined;
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

type Acted = {
  readonly narration: string;
  readonly warning: string | undefined;
};

const act = async (
  dataDir: string,
  name: string,
  input: string,
  gm: GameMaster,
  rng: Rng,
  sessionId: string,
  locale: string,
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
      checkForAction(
        state.events,
        {
          input,
          whoRolls: whoRollsFor(state, session.gmDefaults()),
          houseRules: oocStateOf(state.changes).houseRules,
          installed: session.installedRuleset(state.events),
        },
        actor.id,
        worldOf(database)(campaignId, actor.id).entities,
        rulesStrictnessFor(state, session.gmDefaults()),
      ),
    );
    const shown = await session.narrate();
    const stored = engine.getState(campaignId).turns.find(({ id }) => id === committed.turn.id) ?? committed.turn;
    const narrated =
      stored.narration === PENDING_NARRATION && shown.length > NO_SEGMENTS.length
        ? { ...stored, narration: narrationOf(shown) }
        : stored;
    const warning = budgetWarning(gmSnapshotFor(session, session.gmDefaults(), sessionId), locale);
    return {
      narration: narrate(actor.name, narrated),
      warning,
    };
  } finally {
    void session.settle().finally(session.close);
  }
};

const recap = (characters: CampaignState['characters'], last: Turn | undefined) => {
  const actor = characters.find(({ id }) => id === last?.actorId);
  if (last === undefined || actor === undefined) return DEFAULT_OPENING.narration;
  return last.actionId === OPENING_ACTION_ID ? last.narration : narrate(actor.name, last);
};

const savedSettings = (events: CampaignState['events'], locale: string) => {
  const saved = parseCampaignConfig(campaignConfigOf(events));
  return saved.ok ? [describeConfig(saved.config, locale)] : [];
};

const recapText = (name: string, state: CampaignState, locale: string) =>
  [
    ...savedSettings(state.events, locale),
    sceneText(state.currentScene?.title ?? name, recap(state.characters, playTurns(state).at(-1))),
  ].join('\n');

const viewSourceOf = (database: Session['database'], campaignId: CampaignId, state: CampaignState, packs?: Packs) => ({
  state,
  ...(packs === undefined ? {} : { packs }),
  eventScopes: [...scopeLookupOf(database, campaignId)(state.events.map(({ id }) => id))].map(([id, scope]) => ({
    id,
    ...scope,
  })),
  ...worldOf(database)(campaignId, state.characters[0]?.id),
});

const readView = (dataDir: string, name: string, view: ViewName, locale: string) =>
  withSession(
    dataDir,
    name,
    ({ engine, campaignId, database, installedRuleset }) => {
      const state = engine.getState(campaignId);
      if (view === RECAP_VIEW) return recapText(name, state, locale);
      return renderView(
        view,
        viewSourceOf(
          database,
          campaignId,
          state,
          packsWith(() => installedRuleset(state.events)),
        ),
        undefined,
        locale,
      );
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

export const renameCampaign = (dataDir: string, name: string, newName: string) => {
  const title = newName.trim();
  if (title === '') throw new LocalizedError('campaign.blankName');
  const from = databasePath(dataDir, name);
  if (!existsSync(from)) throw missingCampaign(dataDir, name);
  if (existsSync(databasePath(dataDir, title)) || existsSync(archivePath(dataDir, title)))
    throw new LocalizedError('campaign.exists', { name: title });
  const connection = openDatabase(from);
  try {
    const row = connection.database.prepare(SELECT_CAMPAIGN_ID).get();
    if (row === undefined) throw new LocalizedError('campaign.noState', { name });
    createEngine(createCampaignStore(connection.database)).renameCampaign(String(row.id), title);
  } finally {
    connection.close();
  }
  try {
    linkSync(from, databasePath(dataDir, title));
  } catch (error) {
    if (isFileExists(error)) throw new LocalizedError('campaign.exists', { name: title });
    throw error;
  }
  rmSync(from);
  return title;
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
  const stats = statSync(databasePath(dataDir, name), {
    throwIfNoEntry: false,
  });
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

export const createCampaignFrom = async (
  dataDir: string,
  command: CreateCampaign,
  client?: string,
  gm: GameMaster = FAKE_GAME_MASTER,
): Promise<CampaignSummary> => {
  const { name, language, intent, play, rulesDocuments = [] } = command;
  const config = commandConfig(command, client, packsIn(dataDir));
  const documents = loadOwnRules(dataDir, rulesDocuments);
  const character = startingCharacter(config);
  await createCampaign(
    dataDir,
    name,
    config,
    starterFor(gm, { name, pitch: intent, config, language, model: readGmDefaults(dataDir).model }),
    language,
    play,
    documents,
  );
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

const exportCampaign = (dataDir: string, name: string, file: string, locale: string) => {
  const path = databasePath(dataDir, name);
  if (!existsSync(path)) throw missingCampaign(dataDir, name);
  const { rulesets } = exportArchive(path, file);
  return say(locale, 'campaign.exported', { name, count: rulesets.length, file });
};

const backup = (dataDir: string, name: string, locale: string) => {
  const path = databasePath(dataDir, name);
  if (!existsSync(path)) throw missingCampaign(dataDir, name);
  return say(locale, 'campaign.backedUp', { name, file: backupArchive(dataDir, name, path) });
};

export const campaignDatabases = (dataDir: string): CampaignFile[] => [
  ...savedCampaigns(dataDir).map((name) => ({
    name,
    database: databasePath(dataDir, name),
  })),
  ...savedCampaigns(join(dataDir, ARCHIVE_DIR)).map((name) => ({
    name,
    database: archivePath(dataDir, name),
  })),
];

const ADD_CLIENT_KEY = 'campaign.addClient';

const newCampaignConfig = (intent: string | undefined, client: string | undefined, packs: Packs) => {
  try {
    return planCampaign(intent, client === undefined ? {} : { client }, packs);
  } catch (error) {
    if (!(error instanceof ClientUnsupported)) throw error;
    throw new LocalizedError(ADD_CLIENT_KEY, {
      message: error,
      client: error.client,
    });
  }
};

const isAddClient = (error: unknown) => error instanceof LocalizedError && error.key === ADD_CLIENT_KEY;

const pitchConfig = (pitch: string | undefined, derived: boolean, client: string | undefined, packs: Packs) => {
  try {
    return newCampaignConfig(pitch, client, packs);
  } catch (error) {
    if (!derived || error instanceof UnknownEdition || isAddClient(error)) throw error;
    return newCampaignConfig(undefined, client, packs);
  }
};

const uniqueName = (dataDir: string, title: string) => {
  for (let suffix = 1; ; suffix += 1) {
    const candidate = suffix === 1 ? title : `${title} ${suffix}`;
    if (!existsSync(databasePath(dataDir, candidate)) && !existsSync(archivePath(dataDir, candidate))) return candidate;
  }
};

const restore = (dataDir: string, file: string, locale: string) => {
  mkdirSync(dataDir, { recursive: true });
  const { campaign } = restoreArchive(file, dataDir, (name) => databasePath(dataDir, name));
  return say(locale, 'campaign.restored', { name: campaign });
};

export type GmSettingsChanges = Partial<Record<keyof GmSettings, string>>;

const UNSET = 'unset';
const BUDGET_KEY = 'sessionBudgetTokens';

const changedSettings = (current: GmSettings, changes: GmSettingsChanges): GmSettings => {
  const next: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) continue;
    if (value === UNSET) delete next[key];
    else next[key] = key === BUDGET_KEY ? Number(value) : value;
  }
  const valid = toGmSettings(next);
  if (valid === undefined) throw new LocalizedError('settings.invalid');
  return valid;
};

const gmSettingsCommand = (
  dataDir: string,
  name: string | undefined,
  changes: GmSettingsChanges,
  locale: string,
): string => {
  if (name === undefined) {
    const defaults = changedSettings(readGmDefaults(dataDir), changes);
    writeGmDefaults(dataDir, defaults);
    return [say(locale, 'settings.appDefaults'), ...gmSettingsLines(defaults, locale)].join('\n');
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
    return gmUsageLines(gm, locale, false).join('\n');
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
        rename: (name, newName) => void renameCampaign(dataDir, name, newName),
        unarchive: (name) => unarchiveCampaign(dataDir, name),
        remove: (name, confirm, archived) => deleteCampaign(dataDir, name, confirm, archived),
        play: (name, playing) => playTui(dataDir, name, playing, gm, rng, makeSpeech),
        start: (lines, locale) =>
          guidedStart(
            dataDir,
            lines,
            (target, command, client) => createCampaignFrom(target, command, client, gm),
            locale,
          ),
      },
      terminal,
    ),
  list: () => list(dataDir),
  archive: (name) => archiveCampaign(dataDir, name),
  rename: (name, newName, locale = DEFAULT_LOCALE) =>
    say(locale, 'campaign.renamed', { name, newName: renameCampaign(dataDir, name, newName) }),
  remove: (name, lines) => remove(dataDir, name, lines),
  exportCampaign: (name, file, locale = DEFAULT_LOCALE) => exportCampaign(dataDir, name, file, locale),
  backup: (name, locale = DEFAULT_LOCALE) => backup(dataDir, name, locale),
  restore: (file, locale = DEFAULT_LOCALE) => restore(dataDir, file, locale),
  update: (request, locale = DEFAULT_LOCALE) =>
    updateCommand(
      defaultUpdateContext(dataDir, () => campaignDatabases(dataDir), locale),
      request,
    ),
  create: async function* (name, intent, ask, client, language) {
    const shown = language ?? DEFAULT_LOCALE;
    const derived = intent === undefined && isPitch(name);
    const pitch = derived ? name : intent;
    const title = derived ? uniqueName(dataDir, titleOf(name)) : name;
    const config = pitchConfig(pitch, derived, client, packsIn(dataDir));
    const scene = await createCampaign(
      dataDir,
      title,
      config,
      starterFor(gm, { name: title, pitch, config, language, model: readGmDefaults(dataDir).model }),
      language,
    );
    const notes = pitchNotes(pitch, shown, packsIn(dataDir))
      .map((note) => `${note}\n`)
      .join('');
    yield `${derived ? `${say(shown, 'campaign.created', { title })}\n${say(shown, 'campaign.keepName')}\n` : ''}${notes}${say(shown, 'campaign.savedSettings')}\n${describeConfig(config, shown)}\n${scene}`;
    const character = await characterFor(dataDir, title, config, ask);
    if (character !== undefined) yield character;
  },
  view: (name, view, locale = DEFAULT_LOCALE) => readView(dataDir, name, view, locale),
  tui: (name, terminal) => playTui(dataDir, name, terminal, gm, rng, makeSpeech),
  start: (lines, locale) =>
    guidedStart(dataDir, lines, (target, command, client) => createCampaignFrom(target, command, client, gm), locale),
  importRules: (files, lines, locale) => importRules(process.cwd(), files, lines, dataDir, locale),
  claude: (name) => {
    if (name === undefined) return launchClaude(process.env, dataDir);
    const path = databasePath(dataDir, name);
    if (!existsSync(path)) throw missingCampaign(dataDir, name);
    return launchClaude(process.env, dataDir, path);
  },
  open: async function* (name, _mode, lines, onTurnError, locale = DEFAULT_LOCALE) {
    yield readView(dataDir, name, RECAP_VIEW, locale);
    const sessionId = randomUUID();
    let warned = false;
    for await (const line of lines) {
      if (line.trim() === '') continue;
      let acted: Acted;
      try {
        acted = await act(dataDir, name, line.trim(), gm, rng, sessionId, locale);
      } catch (error) {
        onTurnError(error);
        continue;
      }
      yield acted.narration;
      if (acted.warning !== undefined && !warned) yield acted.warning;
      warned ||= acted.warning !== undefined;
    }
  },
  settings: (name, changes, locale = DEFAULT_LOCALE) => gmSettingsCommand(dataDir, name, changes, locale),
  sound: async function* (request: SoundRequest, locale?: string) {
    yield* (await import('./sound-command.ts')).soundCommand(dataDir, request, locale === undefined ? {} : { locale });
  },
  voiceModel: async function* (request: VoiceModelRequest, locale?: string) {
    yield* (await import('./voice-model-command.ts')).voiceModelCommand(
      dataDir,
      request,
      locale === undefined ? {} : { locale },
    );
  },
});

const reportedInputOf = ({ inputTokens, cacheReadTokens, cacheWriteTokens }: GmUsage) =>
  inputTokens + cacheReadTokens + cacheWriteTokens;
