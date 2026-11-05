import type { CampaignEvent, CampaignId, CampaignStore, CommittedTurn } from '../../domain/src/campaign.ts';
import {
  type CampaignEntity,
  DanglingReferenceError,
  type EntityId,
  type EntityKind,
  type EntityStore,
} from '../../domain/src/entity.ts';
import { NPC_STATE_RELATIONSHIP } from '../../memory/src/graph.ts';
import type { Fact } from '../../memory/src/knowledge.ts';
import {
  INFORMATION_CHANNELS,
  type LearnedFact,
  type Learning,
  learnFact,
  type NpcState,
  STANCES,
  type Stance,
} from '../../narrative/src/npc.ts';
import { commit, loadState, type PlayerAction, recorded, replayOf, requireValid, validate } from './turn.ts';

export const NPC_LEARNED_FACT = 'NpcLearnedFact';
export const STANCE_RELATIONSHIP = 'stance';
export { NPC_STATE_RELATIONSHIP };

export type NpcLearning = PlayerAction & {
  readonly npcId: EntityId;
  readonly fact: Fact;
  readonly learning: Learning;
};

const NPC_KIND: EntityKind = 'npc';
const EMPTY_DISPOSITION = '';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isNullableString = (value: unknown) => value === null || typeof value === 'string';
const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');
const isLearnedFact = (value: unknown): value is LearnedFact =>
  isRecord(value) &&
  typeof value.factId === 'string' &&
  INFORMATION_CHANNELS.includes(value.channel as LearnedFact['channel']) &&
  isNullableString(value.sourceId) &&
  isNullableString(value.eventId);
const isStance = (value: unknown): value is Stance => STANCES.includes(value as Stance);

const relationshipId = (npcId: EntityId, otherId: EntityId) => `${npcId}/${STANCE_RELATIONSHIP}/${otherId}`;
const stateRecordId = (npcId: EntityId) => `${npcId}/${NPC_STATE_RELATIONSHIP}`;

const requireNpcEntity = (entities: EntityStore, campaignId: CampaignId, id: EntityId): CampaignEntity => {
  const entity = entities.getEntity(campaignId, id);
  if (entity?.kind !== NPC_KIND) throw new DanglingReferenceError(`npc ${id}`);
  return entity;
};

export const saveNpc = (entities: EntityStore, campaignId: CampaignId, npc: NpcState) => {
  requireNpcEntity(entities, campaignId, npc.id);
  const { goals, disposition, learned } = npc;
  entities.saveRelationship({
    id: stateRecordId(npc.id),
    campaignId,
    kind: NPC_STATE_RELATIONSHIP,
    sourceId: npc.id,
    targetId: npc.id,
    data: { goals, disposition, learned },
  });
  for (const [targetId, stance] of Object.entries(npc.relationships))
    entities.saveRelationship({
      id: relationshipId(npc.id, targetId),
      campaignId,
      kind: STANCE_RELATIONSHIP,
      sourceId: npc.id,
      targetId,
      data: { stance },
    });
};

const relationshipsOf = (entities: EntityStore, campaignId: CampaignId, id: EntityId) =>
  Object.fromEntries(
    entities
      .listRelationships(campaignId, id)
      .filter(({ kind, sourceId, data }) => kind === STANCE_RELATIONSHIP && sourceId === id && isStance(data.stance))
      .map(({ targetId, data }) => [targetId, data.stance as Stance]),
  );

export const loadNpc = (entities: EntityStore, campaignId: CampaignId, id: EntityId): NpcState | undefined => {
  const entity = entities.getEntity(campaignId, id);
  if (entity?.kind !== NPC_KIND) return undefined;
  const record = entities
    .listRelationships(campaignId, id)
    .find(({ kind, sourceId, targetId }) => kind === NPC_STATE_RELATIONSHIP && sourceId === id && targetId === id);
  const { goals, disposition, learned } = record?.data ?? { goals: [], disposition: EMPTY_DISPOSITION, learned: [] };
  if (!isStringArray(goals) || typeof disposition !== 'string') return undefined;
  if (!Array.isArray(learned) || !learned.every(isLearnedFact)) return undefined;
  return { id, goals, disposition, relationships: relationshipsOf(entities, campaignId, id), learned };
};

const isLearningOf = (event: CampaignEvent, npcId: EntityId, fact: Fact) =>
  event.type === NPC_LEARNED_FACT && event.payload.npcId === npcId && event.payload.factId === fact.id;

const persistLearning = (
  entities: EntityStore,
  campaignId: CampaignId,
  npcId: EntityId,
  fact: Fact,
  turn: CommittedTurn,
) => {
  const event = turn.events.find((candidate) => isLearningOf(candidate, npcId, fact));
  const npc = loadNpc(entities, campaignId, npcId);
  if (event === undefined || npc === undefined) return;
  const { channel, sourceId, eventId } = event.payload as Learning;
  const learned = learnFact(npc, fact, { channel, sourceId, eventId: eventId ?? event.id });
  if (learned !== npc) saveNpc(entities, campaignId, learned);
};

export const recordNpcLearning = (store: CampaignStore, entities: EntityStore, input: NpcLearning): CommittedTurn => {
  const { actionId, campaignId, npcId, fact, learning } = input;
  const state = loadState(store, campaignId);
  const learned = { npcId, factId: fact.id, ...learning };
  const stored = replayOf(store, state, input, recorded(NPC_LEARNED_FACT, learned));
  if (stored !== undefined) {
    persistLearning(entities, campaignId, npcId, fact, stored);
    return stored;
  }
  validate(state, input);
  const npc = loadNpc(entities, campaignId, npcId);
  requireValid(actionId, npc !== undefined, `npc ${npcId} is not in the campaign`);
  requireValid(actionId, fact.campaignId === campaignId, `fact ${fact.id} is outside campaign ${campaignId}`);
  requireValid(
    actionId,
    learnFact(npc as NpcState, fact, learning) !== npc,
    `npc ${npcId} cannot learn fact ${fact.id}`,
  );
  const committed = commit(store, input, [[NPC_LEARNED_FACT, learned]]);
  persistLearning(entities, campaignId, npcId, fact, committed);
  return committed;
};
