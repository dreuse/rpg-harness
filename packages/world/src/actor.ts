import type { CampaignId, EventId } from '../../domain/src/campaign.ts';
import type { CampaignEntity, EntityId, EntityStore, Visibility } from '../../domain/src/entity.ts';

export const ACTOR_KINDS = ['npc', 'faction'] as const;
export const INFORMATION_CHANNELS = ['witnessed', 'told', 'rumor'] as const;
export const MAX_ACTOR_ENTRIES = 64;
const STATE_VISIBILITY: Visibility = 'gm';
const PUBLIC: Visibility = 'public';
const ACTOR_SCOPED: Visibility = 'actor-scoped';

export type ActorKind = (typeof ACTOR_KINDS)[number];
export type InformationChannel = (typeof INFORMATION_CHANNELS)[number];
export type ActorPlan = { readonly id: string; readonly goal: string; readonly steps: readonly string[] };
export type ActorMemory = { readonly id: string; readonly summary: string; readonly tick: number };
export type InformationPath = {
  readonly channel: InformationChannel;
  readonly sourceId: EntityId | null;
  readonly eventId: EventId | null;
  readonly tick: number;
};
export type ActorKnowledge = InformationPath & { readonly factId: string };
export type ActorFact = { readonly id: string; readonly visibility: Visibility; readonly actorId: EntityId | null };
export type WorldActor = {
  readonly id: EntityId;
  readonly kind: ActorKind;
  readonly name: string;
  readonly goals: readonly string[];
  readonly resources: Readonly<Record<string, number>>;
  readonly plans: readonly ActorPlan[];
  readonly memories: readonly ActorMemory[];
  readonly knowledge: readonly ActorKnowledge[];
  readonly cooldowns: Readonly<Record<string, number>>;
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNonEmpty = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isTick = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const isNullableId = (v: unknown) => v === null || isNonEmpty(v);
const isBoundedList = <T>(v: unknown, item: (x: unknown) => x is T): v is T[] =>
  Array.isArray(v) && v.length <= MAX_ACTOR_ENTRIES && v.every(item);
const isBoundedMap = (v: unknown, value: (x: unknown) => boolean): v is Record<string, number> =>
  isRecord(v) && Object.keys(v).length <= MAX_ACTOR_ENTRIES && Object.values(v).every(value);
const bounded = <T>(list: readonly T[]) => list.slice(-MAX_ACTOR_ENTRIES);

const hasOrigin = ({ channel, sourceId, eventId }: InformationPath) =>
  channel === 'witnessed' ? eventId !== null : channel === 'told' ? sourceId !== null : true;
const isPath = (v: unknown, actorId: EntityId): v is InformationPath =>
  isRecord(v) &&
  INFORMATION_CHANNELS.includes(v.channel as InformationChannel) &&
  isNullableId(v.sourceId) &&
  v.sourceId !== actorId &&
  isNullableId(v.eventId) &&
  isTick(v.tick) &&
  hasOrigin(v as InformationPath);
const isKnowledgeOf =
  (actorId: EntityId) =>
  (v: unknown): v is ActorKnowledge =>
    isPath(v, actorId) && isNonEmpty((v as Record<string, unknown>).factId);
const isPlan = (v: unknown): v is ActorPlan =>
  isRecord(v) && isNonEmpty(v.id) && isNonEmpty(v.goal) && isBoundedList(v.steps, isNonEmpty);
const isMemory = (v: unknown): v is ActorMemory =>
  isRecord(v) && isNonEmpty(v.id) && typeof v.summary === 'string' && isTick(v.tick);

const isWorldActor = (v: unknown): v is WorldActor =>
  isRecord(v) &&
  isNonEmpty(v.id) &&
  ACTOR_KINDS.includes(v.kind as ActorKind) &&
  typeof v.name === 'string' &&
  isBoundedList(v.goals, isNonEmpty) &&
  isBoundedMap(v.resources, Number.isFinite) &&
  isBoundedList(v.plans, isPlan) &&
  isBoundedList(v.memories, isMemory) &&
  isBoundedList(v.knowledge, isKnowledgeOf(v.id)) &&
  isBoundedMap(v.cooldowns, isTick);

const checked = (actor: WorldActor): WorldActor => {
  const { id } = actor;
  if (!isWorldActor(actor)) throw new RangeError(`world actor ${String(id)} is malformed or over bounds`);
  return actor;
};

export const createWorldActor = (
  init: Pick<WorldActor, 'id' | 'kind' | 'name'> & Partial<Omit<WorldActor, 'id' | 'kind' | 'name'>>,
): WorldActor => checked({ goals: [], resources: {}, plans: [], memories: [], knowledge: [], cooldowns: {}, ...init });

export const remember = (actor: WorldActor, memory: ActorMemory): WorldActor =>
  isMemory(memory) ? { ...actor, memories: bounded([...actor.memories, memory]) } : actor;

const openTo = (actor: WorldActor, fact: ActorFact) =>
  fact.visibility === PUBLIC || (fact.visibility === ACTOR_SCOPED && fact.actorId === actor.id);
const reaches = (actor: WorldActor, fact: ActorFact, path: InformationPath) =>
  isNonEmpty(fact.id) &&
  isPath(path, actor.id) &&
  (openTo(actor, fact) || path.eventId !== null || path.sourceId !== null);

export const learn = (actor: WorldActor, fact: ActorFact, path: InformationPath): WorldActor =>
  !reaches(actor, fact, path) || knows(actor, fact.id)
    ? actor
    : { ...actor, knowledge: bounded([...actor.knowledge, { factId: fact.id, ...path }]) };

export const knows = (actor: WorldActor, factId: string) => actor.knowledge.some((k) => k.factId === factId);

export const unknownRefs = (actor: WorldActor, refs: readonly string[]) => refs.filter((ref) => !knows(actor, ref));

export const startCooldown = (actor: WorldActor, decision: string, tick: number, duration: number): WorldActor => {
  if (!isNonEmpty(decision) || !isTick(tick) || !isTick(duration) || !isTick(tick + duration))
    throw new RangeError(`cooldown ${decision} needs logical ticks within safe integer range`);
  const active = Object.entries(actor.cooldowns).filter(([key, readyAt]) => key !== decision && readyAt > tick);
  return checked({ ...actor, cooldowns: Object.fromEntries([...active, [decision, tick + duration]]) });
};

export const canDecide = (actor: WorldActor, decision: string, tick: number) =>
  !Object.hasOwn(actor.cooldowns, decision) || tick >= (actor.cooldowns[decision] as number);

export const saveWorldActor = (store: EntityStore, campaignId: CampaignId, actor: WorldActor) => {
  const { id, kind, name, ...data } = checked(actor);
  store.saveEntity({ id, campaignId, kind, name, data, visibility: STATE_VISIBILITY, actorId: null });
};

const fromEntity = ({ id, kind, name, data }: CampaignEntity): WorldActor | undefined => {
  if (!isRecord(data)) return undefined;
  const { goals, resources, plans, memories, knowledge, cooldowns } = data;
  const actor = { id, kind, name, goals, resources, plans, memories, knowledge, cooldowns };
  return isWorldActor(actor) ? actor : undefined;
};

export const loadWorldActor = (store: EntityStore, campaignId: CampaignId, id: EntityId): WorldActor | undefined => {
  const entity = store.getEntity(campaignId, id);
  return entity === undefined ? undefined : fromEntity(entity);
};
