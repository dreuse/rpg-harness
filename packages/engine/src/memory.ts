import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  type CampaignEvent,
  type CampaignStore,
  type CommittedTurn,
  MAIN_BRANCH,
  TURN_VISIBILITIES,
  type TurnVisibility,
} from '../../domain/src/campaign.ts';
import type {
  CampaignEntity,
  EntityId,
  EntityKind,
  EntityStore,
  Fact,
  FactStore,
  Relationship,
  Visibility,
} from '../../domain/src/entity.ts';
import { toVoiceTraits, VOICE_TRAITS_FIELD } from '../../domain/src/voice.ts';
import {
  PENDING_KINDS,
  PENDING_OPENED,
  PENDING_RESOLVED,
  type PendingKind,
  pendingOf,
} from '../../memory/src/graph.ts';
import {
  SUMMARY_LEVELS,
  SUMMARY_WRITTEN,
  type Summary,
  type SummaryLevel,
  summarize,
} from '../../memory/src/history.ts';
import { CONTEXT_BUDGETS, type ContextBudgetPreset, DEFAULT_CONTEXT_BUDGET } from '../../memory/src/packet.ts';
import { normalize } from '../../narrative/src/consistency.ts';
import { type CombatRules, combatantOf, NPC_SHEET_FIELD } from './damage.ts';
import {
  commitSystem,
  loadState,
  type PlayerAction,
  recorded,
  replayOf,
  requireValid,
  type Step,
  validate,
} from './turn.ts';

export const ENTITY_INTRODUCED = 'EntityIntroduced';
export const FACT_RECORDED = 'FactRecorded';
export const CONTEXT_BUDGET_SET = 'ContextBudgetSet';

type Scope = {
  readonly visibility: Visibility;
  readonly actorId: EntityId | null;
};

export type EntityIntroduction = PlayerAction & {
  readonly entity: Omit<CampaignEntity, 'campaignId'>;
  readonly facts: readonly (Omit<Fact, 'campaignId' | 'subjectId' | 'sourceEventId'> & Scope)[];
  readonly relationships: readonly Omit<Relationship, 'campaignId'>[];
  readonly combat?: CombatRules;
};

export type PendingOpening = PlayerAction & {
  readonly pending: Scope & {
    readonly pendingId: string;
    readonly kind: PendingKind;
    readonly text: string;
    readonly entityIds: readonly EntityId[];
  };
};

export type PendingResolution = PlayerAction & { readonly pendingId: string };

export type CampaignChange = {
  readonly campaignId: string;
  readonly actionId: string;
  readonly expectedRevision: number;
};

export type SummaryRecord = CampaignChange & {
  readonly level: SummaryLevel;
  readonly scopeId: string;
  readonly summary: Summary;
};

export type ContextBudgetSave = CampaignChange & { readonly preset: string };

const GM_ONLY: TurnVisibility = 'gm';
const NONE = 0;
const START = 0;
const SINGLE_TOKEN = 1;
const NPC_KIND: EntityKind = 'npc';
const CANON_LAYER = 'canon';
const NAME_ARTICLES: ReadonlySet<string> = new Set(['the', 'a', 'an', 'of']);
const NAME_SEPARATOR = /[^a-z0-9]+/;
const DIACRITICS = /\p{Diacritic}/gu;
const DOUBLED_LETTER = /(.)\1/g;
const APOSTROPHES = /['\u2019]/g;
const FUZZY_MIN_LENGTH = 4;
const MAX_TOKEN_EDITS = 1;

const nameTokens = (name: string): string[] =>
  name
    .normalize('NFD')
    .replace(DIACRITICS, '')
    .toLowerCase()
    .replace(APOSTROPHES, '')
    .split(NAME_SEPARATOR)
    .filter((token) => token !== '' && !NAME_ARTICLES.has(token))
    .map((token) => token.replace(DOUBLED_LETTER, '$1'));

const withinOneEdit = (a: string, b: string): boolean => {
  if (a === b) return true;
  if (a[START] !== b[START]) return false;
  if (Math.max(a.length, b.length) < FUZZY_MIN_LENGTH || Math.abs(a.length - b.length) > MAX_TOKEN_EDITS) return false;
  let at = START;
  while (at < Math.min(a.length, b.length) && a[at] === b[at]) at += 1;
  const rest = (text: string, skip: number) => text.slice(at + skip);
  return rest(a, 1) === rest(b, 1) || rest(a, 1) === rest(b, 0) || rest(a, 0) === rest(b, 1);
};

const similarNames = (first: string, second: string): boolean => {
  const [shorter, longer] = [nameTokens(first), nameTokens(second)].sort((a, b) => a.length - b.length);
  if (shorter === undefined || longer === undefined || shorter.length === NONE) return false;
  if (shorter.length === SINGLE_TOKEN) return shorter[START] === longer[longer.length - SINGLE_TOKEN];
  const sameLastToken = withinOneEdit(
    shorter[shorter.length - SINGLE_TOKEN] ?? '',
    longer[longer.length - SINGLE_TOKEN] ?? '',
  );
  return sameLastToken && shorter.every((token) => longer.some((other) => withinOneEdit(token, other)));
};

const turnVisibility = (visibility: Visibility): TurnVisibility =>
  (TURN_VISIBILITIES as readonly Visibility[]).includes(visibility) ? (visibility as TurnVisibility) : GM_ONLY;

const isPreset = (preset: unknown): preset is ContextBudgetPreset =>
  typeof preset === 'string' && Object.hasOwn(CONTEXT_BUDGETS, preset);

const withValidTraits = (entity: EntityIntroduction['entity']): EntityIntroduction['entity'] => {
  const { [VOICE_TRAITS_FIELD]: given, ...rest } = entity.data;
  if (given === undefined) return entity;
  const traits = toVoiceTraits(given);
  return {
    ...entity,
    data: traits === undefined ? rest : { ...rest, [VOICE_TRAITS_FIELD]: traits },
  };
};

export const introduceEntity = (
  store: CampaignStore,
  entities: EntityStore,
  facts: FactStore,
  input: EntityIntroduction,
): CommittedTurn => {
  const { campaignId, actionId, relationships } = input;
  const entity = withValidTraits(input.entity);
  const state = loadState(store, campaignId);
  const factEvents = (committed: CommittedTurn) => committed.events.filter(({ type }) => type === FACT_RECORDED);
  const recordedFacts = input.facts.map((fact) => ({
    ...fact,
    subjectId: entity.id,
  }));
  const project = (committed: CommittedTurn) => {
    const savedFacts = new Set(facts.listFacts(campaignId).map(({ id }) => id));
    const savedEdges = new Set(entities.listRelationships(campaignId).map(({ id }) => id));
    if (entities.getEntity(campaignId, entity.id) === undefined) entities.saveEntity({ ...entity, campaignId });
    for (const { id: sourceEventId, payload } of factEvents(committed)) {
      const fact = payload.fact as Omit<Fact, 'campaignId' | 'sourceEventId'>;
      if (!savedFacts.has(fact.id)) facts.saveFact({ ...fact, campaignId, sourceEventId });
    }
    for (const relationship of relationships)
      if (!savedEdges.has(relationship.id)) entities.saveRelationship({ ...relationship, campaignId });
    return committed;
  };
  const sameFacts = (committed: CommittedTurn) =>
    isDeepStrictEqual(
      factEvents(committed).map(({ payload }) => payload.fact),
      recordedFacts,
    );
  const introduced = recorded(ENTITY_INTRODUCED, { entity, relationships });
  const stored = replayOf(store, state, input, (committed) => introduced(committed) && sameFacts(committed));
  if (stored !== undefined) return project(stored);
  validate(state, input);
  requireValid(actionId, entity.name.trim() !== '', 'entity name is blank');
  if (entity.data[NPC_SHEET_FIELD] !== undefined) {
    const usable =
      entity.kind === NPC_KIND &&
      input.combat !== undefined &&
      combatantOf({ ...entity, campaignId }, [], input.combat) !== undefined;
    requireValid(actionId, usable, `npc sheet for ${entity.id} is not valid for the campaign rulepack`);
  }
  const taken =
    entities.getEntity(campaignId, entity.id) !== undefined || state.characters.some(({ id }) => id === entity.id);
  requireValid(actionId, !taken, `entity ${entity.id} already exists`);
  if (entity.kind === NPC_KIND) {
    const npcs = entities.listEntities(campaignId, NPC_KIND);
    const npcIds = new Set(npcs.map(({ id }) => id));
    const roles = facts
      .listFacts(campaignId)
      .filter(({ layer, subjectId }) => layer === CANON_LAYER && subjectId !== null && npcIds.has(subjectId));
    const lookalike = npcs.find(({ name }) => similarNames(name, entity.name));
    requireValid(
      actionId,
      lookalike === undefined,
      `npc ${entity.name} looks like existing npc ${lookalike?.id}; reuse that id`,
    );
    for (const { id, statement, layer } of input.facts) {
      const holder =
        layer === CANON_LAYER ? roles.find((role) => normalize(role.statement) === normalize(statement)) : undefined;
      requireValid(actionId, holder === undefined, `fact ${id} repeats the role of existing npc ${holder?.subjectId}`);
    }
  }
  const known = (id: EntityId) => id === entity.id || entities.getEntity(campaignId, id) !== undefined;
  const factIds = new Set(facts.listFacts(campaignId).map(({ id }) => id));
  for (const { id, actorId } of input.facts) {
    requireValid(actionId, !factIds.has(id), `fact ${id} already exists`);
    requireValid(actionId, actorId === null || known(actorId), `fact ${id} actor ${actorId} is unknown`);
  }
  const edgeIds = new Set(entities.listRelationships(campaignId).map(({ id }) => id));
  for (const { id, sourceId, targetId } of relationships) {
    requireValid(actionId, !edgeIds.has(id), `relationship ${id} already exists`);
    requireValid(actionId, known(sourceId) && known(targetId), `relationship ${sourceId} -> ${targetId} is dangling`);
  }
  return project(
    commitSystem(store, input, [
      [ENTITY_INTRODUCED, { entity, relationships }, turnVisibility(entity.visibility)],
      ...recordedFacts.map((fact): Step => [FACT_RECORDED, { fact }, turnVisibility(fact.visibility)]),
    ]),
  );
};

const openIds = (events: readonly CampaignEvent[]) => new Set(pendingOf(events).map(({ id }) => id));

export const openPending = (store: CampaignStore, input: PendingOpening): CommittedTurn => {
  const { campaignId, actionId, pending } = input;
  const { pendingId, kind, text, entityIds, visibility, actorId } = pending;
  const payload = { pendingId, kind, text, entityIds, visibility, actorId };
  const state = loadState(store, campaignId);
  const stored = replayOf(store, state, input, recorded(PENDING_OPENED, payload));
  if (stored !== undefined) return stored;
  validate(state, input);
  requireValid(actionId, PENDING_KINDS.includes(kind), `pending kind ${kind} is unknown`);
  requireValid(actionId, text.trim() !== '', 'pending text is blank');
  requireValid(actionId, entityIds.length > NONE, 'pending item links no entity');
  requireValid(actionId, !openIds(state.events).has(pendingId), `pending ${pendingId} is already open`);
  return commitSystem(store, input, [[PENDING_OPENED, payload, turnVisibility(visibility)]]);
};

export const resolvePending = (store: CampaignStore, input: PendingResolution): CommittedTurn => {
  const { campaignId, actionId, pendingId } = input;
  const state = loadState(store, campaignId);
  const stored = replayOf(store, state, input, recorded(PENDING_RESOLVED, { pendingId }));
  if (stored !== undefined) return stored;
  validate(state, input);
  const open = pendingOf(state.events).find(({ id }) => id === pendingId);
  requireValid(actionId, open !== undefined, `pending ${pendingId} is not open`);
  return commitSystem(store, input, [[PENDING_RESOLVED, { pendingId }, turnVisibility(open?.visibility ?? GM_ONLY)]]);
};

export const recordChange = (
  store: CampaignStore,
  change: CampaignChange,
  type: string,
  payload: Record<string, unknown>,
) =>
  store.recordChange({
    expectedRevision: change.expectedRevision,
    event: {
      id: randomUUID(),
      campaignId: change.campaignId,
      branchId: MAIN_BRANCH,
      actionId: change.actionId,
      type,
      payload,
    },
  });

export const recordSummary = (store: CampaignStore, input: SummaryRecord): Summary => {
  const { actionId, level, scopeId } = input;
  requireValid(actionId, SUMMARY_LEVELS.includes(level), `summary level ${level} is unknown`);
  const summary = summarize(loadState(store, input.campaignId).events, input.summary);
  recordChange(store, input, SUMMARY_WRITTEN, { level, scopeId, summary });
  return summary;
};

export const saveContextBudget = (store: CampaignStore, input: ContextBudgetSave): ContextBudgetPreset => {
  const { actionId, preset } = input;
  requireValid(actionId, isPreset(preset), `context budget ${preset} is not a preset`);
  recordChange(store, input, CONTEXT_BUDGET_SET, { preset });
  return preset as ContextBudgetPreset;
};

export const contextBudgetOf = (events: readonly Pick<CampaignEvent, 'type' | 'payload'>[]): ContextBudgetPreset => {
  const preset = events.findLast(({ type }) => type === CONTEXT_BUDGET_SET)?.payload.preset;
  return isPreset(preset) ? preset : DEFAULT_CONTEXT_BUDGET;
};
