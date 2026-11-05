import { isDeepStrictEqual } from 'node:util';
import {
  type CampaignId,
  type CampaignState,
  type CampaignStore,
  type CommittedTurn,
  TURN_VISIBILITIES,
  type TurnVisibility,
} from '../../domain/src/campaign.ts';
import { type EntityId, type EntityStore, VISIBILITY_LEVELS, type Visibility } from '../../domain/src/entity.ts';
import {
  ALIVE_VALUES,
  CLAIM_KINDS,
  type ClaimKind,
  ITEM_VALUES,
  PROMISE_VALUES,
  type StoryMemory,
} from '../../domain/src/story-memory.ts';
import { PLAYER_VIEWER } from '../../memory/src/knowledge.ts';
import {
  buildLedger,
  CLAIM_CORRECTED,
  CLAIM_RECORDED,
  claimKey,
  currentEntries,
  type Directory,
  type Ledger,
  type LedgerEntry,
  type LedgerEvent,
  storyMemoryOf,
  visibleLedger,
} from '../../memory/src/ledger.ts';
import type { ContinuityLogRecord } from '../../narrative/src/continuity.ts';
import { type CampaignChange, recordChange } from './memory.ts';
import {
  commit,
  loadState,
  type PlayerAction,
  recorded,
  replayOf,
  requireValid,
  storedTurnOf,
  validate,
} from './turn.ts';

export const CONTINUITY_CONFLICT_LOGGED = 'ContinuityConflictLogged';

export type ClaimDraft = {
  readonly entityId: EntityId;
  readonly kind: ClaimKind;
  readonly key?: string;
  readonly value: string;
  readonly visibility?: Visibility;
  readonly actorId?: EntityId | null;
};

export type ClaimProposal = PlayerAction & { readonly claims: readonly ClaimDraft[] };

export type StoryCorrection = Pick<PlayerAction, 'campaignId' | 'actionId' | 'expectedRevision' | 'actorId'> & {
  readonly entityId: EntityId;
  readonly kind: ClaimKind;
  readonly key?: string;
  readonly value: string;
};

export type ContinuityLogInput = CampaignChange & { readonly record: ContinuityLogRecord };

const GM: Visibility = 'gm';
const PUBLIC: Visibility = 'public';
const PLAYER_READABLE: readonly Visibility[] = [PUBLIC, 'player'];
const CORRECTION_INTENT = 'correct story fact';
const CORRECTION_VISIBILITY: TurnVisibility = 'player';
const NO_SCENE = '';
const NONE = 0;
const VALUE_SETS: Partial<Record<ClaimKind, readonly string[]>> = {
  alive: ALIVE_VALUES,
  item: ITEM_VALUES,
  promise: PROMISE_VALUES,
};

type ClaimPayload = {
  readonly entityId: EntityId;
  readonly kind: ClaimKind;
  readonly key: string;
  readonly value: string;
  readonly visibility: Visibility;
  readonly actorId: EntityId | null;
};

const turnVisibility = (visibility: Visibility): TurnVisibility =>
  (TURN_VISIBILITIES as readonly Visibility[]).includes(visibility) ? (visibility as TurnVisibility) : GM;

const payloadOf = (draft: ClaimDraft): ClaimPayload => ({
  entityId: draft.entityId,
  kind: draft.kind,
  key: claimKey(draft.kind, draft.key),
  value: draft.value.trim(),
  visibility: draft.visibility ?? (draft.kind === 'secret' ? GM : PUBLIC),
  actorId: draft.actorId ?? null,
});

export const ledgerOf = (events: readonly LedgerEvent[]): Ledger => buildLedger(events);

export const directoryOf = (state: Pick<CampaignState, 'campaign' | 'characters'>, entities: EntityStore): Directory =>
  new Map([
    ...entities.listEntities(state.campaign.id).map(({ id, name, kind }) => [id, { name, kind }] as const),
    ...state.characters.map(({ id, name }) => [id, { name, kind: 'character' as const }] as const),
  ]);

const visibilityIn =
  (state: CampaignState, entities: EntityStore) =>
  (id: EntityId): Visibility | undefined =>
    state.characters.some((character) => character.id === id)
      ? PUBLIC
      : entities.getEntity(state.campaign.id, id)?.visibility;

const checkClaim = (actionId: string, claim: ClaimPayload, visibilityOf: (id: EntityId) => Visibility | undefined) => {
  const known = (id: EntityId) => visibilityOf(id) !== undefined;
  const label = `claim ${claim.kind} about ${claim.entityId}`;
  requireValid(actionId, CLAIM_KINDS.includes(claim.kind), `${label} has an unknown kind`);
  requireValid(actionId, known(claim.entityId), `${label} names an unknown entity`);
  const entityVisibility = visibilityOf(claim.entityId);
  requireValid(
    actionId,
    !PLAYER_READABLE.includes(claim.visibility) ||
      (entityVisibility !== undefined && PLAYER_READABLE.includes(entityVisibility)),
    `${label} cannot be shown to the player because the entity is hidden`,
  );
  requireValid(actionId, claim.key !== '', `${label} needs a key`);
  requireValid(actionId, claim.value !== '', `${label} has a blank value`);
  requireValid(
    actionId,
    VALUE_SETS[claim.kind]?.includes(claim.value) ?? true,
    `${label} value ${claim.value} is not one of ${VALUE_SETS[claim.kind]?.join(', ')}`,
  );
  requireValid(actionId, claim.kind !== 'relationship' || known(claim.key), `${label} links an unknown entity`);
  const targetVisibility = visibilityOf(claim.key);
  requireValid(
    actionId,
    claim.kind !== 'relationship' ||
      !PLAYER_READABLE.includes(claim.visibility) ||
      (targetVisibility !== undefined && PLAYER_READABLE.includes(targetVisibility)),
    `${label} cannot be shown to the player because the target is hidden`,
  );
  requireValid(actionId, VISIBILITY_LEVELS.includes(claim.visibility), `${label} has an unknown visibility`);
  requireValid(
    actionId,
    claim.kind !== 'secret' || !PLAYER_READABLE.includes(claim.visibility),
    `${label} is a secret and cannot be shown to the player`,
  );
  requireValid(actionId, claim.actorId === null || known(claim.actorId), `${label} actor is unknown`);
};

export const proposeClaims = (store: CampaignStore, entities: EntityStore, input: ClaimProposal): CommittedTurn => {
  const { actionId, campaignId } = input;
  const claims = input.claims.map(payloadOf);
  const state = loadState(store, campaignId);
  const stored = replayOf(store, state, input, ({ events }) =>
    isDeepStrictEqual(
      events.filter(({ type }) => type === CLAIM_RECORDED).map(({ payload }) => payload),
      claims,
    ),
  );
  if (stored !== undefined) return stored;
  validate(state, input);
  requireValid(actionId, claims.length > NONE, 'no claims proposed');
  const visibilityOf = visibilityIn(state, entities);
  for (const claim of claims) checkClaim(actionId, claim, visibilityOf);
  return commit(
    store,
    input,
    claims.map((claim) => [CLAIM_RECORDED, { ...claim }, turnVisibility(claim.visibility)]),
  );
};

export const correctStoryFact = (
  store: CampaignStore,
  entities: EntityStore,
  correction: StoryCorrection,
): CommittedTurn => {
  const { campaignId, actionId, expectedRevision, actorId, entityId, kind, value } = correction;
  const key = claimKey(kind, correction.key);
  const state = loadState(store, campaignId);
  const sceneId = storedTurnOf(store, state, actionId)?.turn.sceneId ?? state.currentScene?.id ?? NO_SCENE;
  const action = {
    campaignId,
    actionId,
    expectedRevision,
    sceneId,
    actorId,
    input: `${CORRECTION_INTENT} ${kind} ${entityId}`,
    intent: CORRECTION_INTENT,
  };
  const full = buildLedger(state.events);
  const inSlot = (entry: LedgerEntry) => entry.entityId === entityId && entry.kind === kind && entry.key === key;
  const existing = currentEntries(visibleLedger(full, PLAYER_VIEWER)).find(inSlot);
  const newest = currentEntries(full).find(inSlot);
  const payload = payloadOf({ entityId, kind, key, value, visibility: existing?.visibility ?? PUBLIC });
  const stored = replayOf(store, state, action, recorded(CLAIM_CORRECTED, payload));
  if (stored !== undefined) return stored;
  validate(state, action);
  requireValid(actionId, kind !== 'secret', 'a secret cannot be corrected by the player');
  requireValid(
    actionId,
    existing !== undefined && existing.eventId === newest?.eventId,
    `no ${kind} fact about ${entityId} can be corrected`,
  );
  checkClaim(actionId, payload, visibilityIn(state, entities));
  return commit(store, action, [[CLAIM_CORRECTED, { ...payload }, CORRECTION_VISIBILITY]]);
};

export const readStoryMemory = (store: CampaignStore, entities: EntityStore, campaignId: CampaignId): StoryMemory => {
  const state = loadState(store, campaignId);
  return storyMemoryOf(buildLedger(state.events), directoryOf(state, entities), PLAYER_VIEWER);
};

const SECRET_LEAK = 'secret-leak';

export const recordContinuityConflict = (store: CampaignStore, input: ContinuityLogInput): void => {
  const { regenerations, resolved, conflicts } = input.record;
  const leaked = new Set(conflicts.filter(({ kind }) => kind === SECRET_LEAK).map(({ excerpt }) => excerpt));
  recordChange(store, input, CONTINUITY_CONFLICT_LOGGED, {
    regenerations,
    resolved,
    conflicts: conflicts.map(({ kind, entityId, fact, excerpt }) =>
      kind === SECRET_LEAK
        ? { kind, entityId, fact: '', excerpt: '' }
        : { kind, entityId, fact, excerpt: leaked.has(excerpt) ? '' : excerpt },
    ),
  });
};
