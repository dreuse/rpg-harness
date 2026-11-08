import {
  type CampaignEvent,
  type CampaignStore,
  type CharacterId,
  type CommittedTurn,
  GM_ROLLED,
  StaleRevisionError,
} from '../../../packages/domain/src/campaign.ts';
import {
  type CampaignEntity,
  ENTITY_KINDS,
  type EntityId,
  type EntityKind,
  type EntityStore,
  type FactStore,
} from '../../../packages/domain/src/entity.ts';
import { CLAIM_KINDS, type ClaimKind } from '../../../packages/domain/src/story-memory.ts';
import {
  toVoiceTraits,
  VOICE_AGES,
  VOICE_GENDERS,
  VOICE_MANNERS,
  VOICE_TRAITS_FIELD,
  type VoiceTraits,
} from '../../../packages/domain/src/voice.ts';
import { GM_PROPOSAL_INPUT, offerCheck, proposalEventsOf } from '../../../packages/engine/src/check-offer.ts';
import {
  applyCondition,
  type ConditionRequest,
  endCondition,
  type ModifierPolicy,
} from '../../../packages/engine/src/conditions.ts';
import { type Combatant, type CombatRules, NPC_SHEET_FIELD } from '../../../packages/engine/src/damage.ts';
import {
  GM_ROLL_VISIBILITIES,
  type GmRollVisibility,
  MAX_ROLL_EXPRESSION_LENGTH,
  MAX_ROLL_REASON_LENGTH,
  MAX_ROLL_SECTION_LENGTH,
  rollForGm,
} from '../../../packages/engine/src/gm-roll.ts';
import { recordGmRejections } from '../../../packages/engine/src/gm-settings.ts';
import { healCombatant } from '../../../packages/engine/src/healing.ts';
import { introduceEntity, openPending, setNpcSheet } from '../../../packages/engine/src/memory.ts';
import { type ClaimDraft, proposeClaims } from '../../../packages/engine/src/story-memory.ts';
import {
  ActionIdConflictError,
  InvalidActionError,
  loadState,
  type PlayerAction,
} from '../../../packages/engine/src/turn.ts';
import { setVoiceTraits } from '../../../packages/engine/src/voice-profile.ts';
import { PENDING_KINDS, type PendingKind } from '../../../packages/memory/src/graph.ts';
import {
  type NarrationClaim,
  OUTCOME_RESULTS,
  type OutcomeResult,
} from '../../../packages/narrative/src/consistency.ts';
import type { Rng } from '../../../packages/rules/src/dice.ts';
import {
  type ConditionDuration,
  DURATION_UNITS,
  MAX_CONDITION_DURATION,
  MAX_MODIFIER_TEXT_LENGTH,
  MAX_MODIFIER_VALUE,
  MAX_MODIFIERS,
  MIN_DURATION,
  type ModifierRequest,
} from '../../../packages/rules/src/modifiers.ts';
import { isRecord } from '../../../packages/rules/src/rulepack.ts';

export const MAX_PROPOSALS = 8;
export const MAX_ID_LENGTH = 64;
export const MAX_NAME_LENGTH = 80;
export const MAX_FACT_LENGTH = 300;
export const MAX_FACTS = 5;
export const MAX_SHEET_TRAITS = 12;
export const MAX_TAG_LENGTH = 40;
export const MAX_MOOD_TAGS = 5;
export const MAX_PENDING_TEXT_LENGTH = 300;
export const MAX_PENDING_ENTITIES = 5;
export const MAX_LABEL_LENGTH = 120;
export const MAX_OUTCOME_LENGTH = 200;
export const MAX_HEAL_AMOUNT = 999;
const MIN_HEAL_AMOUNT = 1;
export const PROPOSAL_ENTITY_KINDS = ENTITY_KINDS.filter((kind) => kind !== 'character');
export const PROPOSAL_VISIBILITIES = ['player', 'gm'] as const;
export const ENTITY_PROPOSAL = 'entity';
export const PENDING_PROPOSAL = 'pending';
export const CHECK_PROPOSAL = 'check';
export const OUTCOME_PROPOSAL = 'outcome';
export const GM_ROLL_PROPOSAL = 'gm-roll';
export const VOICE_TRAITS_PROPOSAL = 'voice-traits';
export const CONDITION_PROPOSAL = 'condition';
export const CONDITION_END_PROPOSAL = 'condition-end';
export const CLAIM_PROPOSAL = 'claim';
export const HEAL_PROPOSAL = 'heal';

const ID_PATTERN = '^[a-z0-9][a-z0-9-]*$';
const ID_REGEX = new RegExp(ID_PATTERN);
const RULE_ID_PATTERN = '^[a-z0-9][a-z0-9.-]*$';
const RULE_ID_REGEX = new RegExp(RULE_ID_PATTERN);
const NO_RULES: readonly string[] = [];
export const NEEDS_CHECK_FIELD = 'needsCheck';
const DEFAULT_VISIBILITY = 'player';
const FACT_LAYER = 'canon';
const PROPOSAL_KEYS = {
  [ENTITY_PROPOSAL]: [
    'kind',
    'id',
    'entityKind',
    'name',
    'facts',
    'visibility',
    'locationKind',
    'mood',
    VOICE_TRAITS_FIELD,
    NPC_SHEET_FIELD,
  ],
  [PENDING_PROPOSAL]: ['kind', 'id', 'pendingKind', 'text', 'entityIds', 'visibility'],
  [CHECK_PROPOSAL]: [
    'kind',
    'id',
    'ruleId',
    'target',
    'attacker',
    'label',
    'difficulty',
    'modifiers',
    NEEDS_CHECK_FIELD,
  ],
  [HEAL_PROPOSAL]: ['kind', 'id', 'target', 'amount'],
  [OUTCOME_PROPOSAL]: ['kind', 'id', 'text', 'declared'],
  [VOICE_TRAITS_PROPOSAL]: ['kind', 'id', 'entityId', VOICE_TRAITS_FIELD],
  [GM_ROLL_PROPOSAL]: ['kind', 'id', 'roller', 'reason', 'visibility', 'ruleId', 'expression', 'section', 'modifiers'],
  [CONDITION_PROPOSAL]: [
    'kind',
    'id',
    'conditionId',
    'reason',
    'label',
    'duration',
    'appliesTo',
    'modifiers',
    'targetId',
  ],
  [CONDITION_END_PROPOSAL]: ['kind', 'id', 'conditionId', 'targetId'],
  [CLAIM_PROPOSAL]: ['kind', 'id', 'entityId', 'claimKind', 'key', 'value', 'visibility'],
} as const;

type ProposalVisibility = (typeof PROPOSAL_VISIBILITIES)[number];

export type NpcSheetProposal = {
  readonly motivations: readonly string[];
  readonly background: string;
  readonly traits: readonly { readonly id: string; readonly value: number }[];
  readonly rulepack: { readonly id: string; readonly edition: string; readonly revision: string };
};

export type EntityProposal = {
  readonly kind: typeof ENTITY_PROPOSAL;
  readonly id: EntityId;
  readonly entityKind: EntityKind;
  readonly name: string;
  readonly facts?: readonly string[];
  readonly locationKind?: string;
  readonly mood?: readonly string[];
  readonly voiceTraits?: VoiceTraits;
  readonly sheet?: NpcSheetProposal;
  readonly visibility: ProposalVisibility;
};

export type PendingProposal = {
  readonly kind: typeof PENDING_PROPOSAL;
  readonly id: string;
  readonly pendingKind: PendingKind;
  readonly text: string;
  readonly entityIds: readonly EntityId[];
  readonly visibility: ProposalVisibility;
};

export type CheckProposal = {
  readonly kind: typeof CHECK_PROPOSAL;
  readonly id: string;
  readonly ruleId: string;
  readonly target: string;
  readonly attacker?: string;
  readonly label: string;
  readonly difficulty?: string;
  readonly modifiers?: readonly ModifierRequest[];
  readonly needsCheck?: boolean;
};

export type OutcomeProposal = {
  readonly kind: typeof OUTCOME_PROPOSAL;
  readonly id: string;
  readonly text: string;
  readonly declared: OutcomeResult;
};

export type GmRollProposal = {
  readonly kind: typeof GM_ROLL_PROPOSAL;
  readonly id: string;
  readonly roller: string;
  readonly reason: string;
  readonly visibility: GmRollVisibility;
  readonly ruleId?: string;
  readonly expression?: string;
  readonly section?: string;
  readonly modifiers?: readonly ModifierRequest[];
};

export type VoiceTraitsProposal = {
  readonly kind: typeof VOICE_TRAITS_PROPOSAL;
  readonly id: string;
  readonly entityId: EntityId;
  readonly voiceTraits: VoiceTraits;
};

export type ConditionProposal = {
  readonly kind: typeof CONDITION_PROPOSAL;
  readonly id: string;
  readonly conditionId: string;
  readonly reason: string;
  readonly label?: string;
  readonly duration?: ConditionDuration;
  readonly appliesTo?: readonly string[];
  readonly modifiers?: readonly ModifierRequest[];
  readonly targetId?: string;
};

export type ConditionEndProposal = {
  readonly kind: typeof CONDITION_END_PROPOSAL;
  readonly id: string;
  readonly conditionId: string;
  readonly targetId?: string;
};

export type ClaimProposal = {
  readonly kind: typeof CLAIM_PROPOSAL;
  readonly id: string;
  readonly entityId: EntityId;
  readonly claimKind: ClaimKind;
  readonly key?: string;
  readonly value: string;
  readonly visibility?: ProposalVisibility;
};

export type HealProposal = {
  readonly kind: typeof HEAL_PROPOSAL;
  readonly id: string;
  readonly target: string;
  readonly amount: number;
};

export type GmProposal =
  | HealProposal
  | EntityProposal
  | PendingProposal
  | CheckProposal
  | OutcomeProposal
  | GmRollProposal
  | VoiceTraitsProposal
  | ConditionProposal
  | ConditionEndProposal
  | ClaimProposal;

const idSchema = { type: 'string', maxLength: MAX_ID_LENGTH, pattern: ID_PATTERN } as const;
const visibilitySchema = { type: 'string', enum: PROPOSAL_VISIBILITIES } as const;
const modifiersSchema = {
  type: 'array',
  maxItems: MAX_MODIFIERS,
  items: {
    type: 'object',
    properties: {
      id: idSchema,
      reason: { type: 'string', maxLength: MAX_MODIFIER_TEXT_LENGTH },
      sourceRule: { type: 'string', maxLength: MAX_NAME_LENGTH },
      value: { type: 'integer', minimum: -MAX_MODIFIER_VALUE, maximum: MAX_MODIFIER_VALUE },
    },
    required: ['id', 'reason'],
    additionalProperties: false,
  },
} as const;
const durationSchema = {
  type: 'object',
  properties: {
    unit: { type: 'string', enum: DURATION_UNITS },
    count: { type: 'integer', minimum: MIN_DURATION, maximum: MAX_CONDITION_DURATION },
  },
  required: ['unit', 'count'],
  additionalProperties: false,
} as const;

const sheetRulepackSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', minLength: 1, maxLength: MAX_TAG_LENGTH },
    edition: { type: 'string', minLength: 1, maxLength: MAX_TAG_LENGTH },
    revision: { type: 'string', minLength: 1, maxLength: MAX_TAG_LENGTH },
  },
  required: ['id', 'edition', 'revision'],
  additionalProperties: false,
} as const;

const sheetSchema = {
  type: 'object',
  properties: {
    motivations: {
      type: 'array',
      maxItems: MAX_FACTS,
      items: { type: 'string', minLength: 1, maxLength: MAX_FACT_LENGTH },
    },
    background: { type: 'string', maxLength: MAX_FACT_LENGTH },
    traits: {
      type: 'array',
      maxItems: MAX_SHEET_TRAITS,
      items: {
        type: 'object',
        properties: { id: { type: 'string', minLength: 1, maxLength: MAX_TAG_LENGTH }, value: { type: 'integer' } },
        required: ['id', 'value'],
        additionalProperties: false,
      },
    },
    rulepack: sheetRulepackSchema,
  },
  required: ['traits', 'rulepack'],
  additionalProperties: false,
} as const;

const voiceTraitsSchema = {
  type: 'object',
  properties: {
    gender: { type: 'string', enum: VOICE_GENDERS },
    age: { type: 'string', enum: VOICE_AGES },
    manner: { type: 'string', enum: VOICE_MANNERS },
  },
  additionalProperties: false,
} as const;

export const PROPOSALS_SCHEMA = {
  type: 'array',
  maxItems: MAX_PROPOSALS,
  items: {
    anyOf: [
      {
        type: 'object',
        properties: {
          kind: { const: ENTITY_PROPOSAL },
          id: idSchema,
          entityKind: { type: 'string', enum: PROPOSAL_ENTITY_KINDS },
          name: { type: 'string', maxLength: MAX_NAME_LENGTH },
          facts: { type: 'array', maxItems: MAX_FACTS, items: { type: 'string', maxLength: MAX_FACT_LENGTH } },
          visibility: visibilitySchema,
          locationKind: { type: 'string', maxLength: MAX_TAG_LENGTH },
          mood: { type: 'array', maxItems: MAX_MOOD_TAGS, items: { type: 'string', maxLength: MAX_TAG_LENGTH } },
          voiceTraits: voiceTraitsSchema,
          sheet: sheetSchema,
        },
        required: ['kind', 'id', 'entityKind', 'name'],
        additionalProperties: false,
      },
      {
        type: 'object',
        properties: {
          kind: { const: PENDING_PROPOSAL },
          id: idSchema,
          pendingKind: { type: 'string', enum: PENDING_KINDS },
          text: { type: 'string', maxLength: MAX_PENDING_TEXT_LENGTH },
          entityIds: { type: 'array', minItems: 1, maxItems: MAX_PENDING_ENTITIES, items: idSchema },
          visibility: visibilitySchema,
        },
        required: ['kind', 'id', 'pendingKind', 'text', 'entityIds'],
        additionalProperties: false,
      },
      {
        type: 'object',
        properties: {
          kind: { const: CHECK_PROPOSAL },
          id: idSchema,
          ruleId: { type: 'string', maxLength: MAX_ID_LENGTH, pattern: RULE_ID_PATTERN },
          target: { type: 'string', maxLength: MAX_NAME_LENGTH },
          attacker: { type: 'string', maxLength: MAX_NAME_LENGTH },
          label: { type: 'string', maxLength: MAX_LABEL_LENGTH },
          difficulty: idSchema,
          modifiers: modifiersSchema,
          [NEEDS_CHECK_FIELD]: { type: 'boolean' },
        },
        required: ['kind', 'id', 'ruleId', 'target', 'label'],
        additionalProperties: false,
      },
      {
        type: 'object',
        properties: {
          kind: { const: HEAL_PROPOSAL },
          id: idSchema,
          target: { type: 'string', maxLength: MAX_NAME_LENGTH },
          amount: { type: 'integer', minimum: MIN_HEAL_AMOUNT, maximum: MAX_HEAL_AMOUNT },
        },
        required: ['kind', 'id', 'target', 'amount'],
        additionalProperties: false,
      },
      {
        type: 'object',
        properties: {
          kind: { const: OUTCOME_PROPOSAL },
          id: idSchema,
          text: { type: 'string', maxLength: MAX_OUTCOME_LENGTH },
          declared: { type: 'string', enum: OUTCOME_RESULTS },
        },
        required: ['kind', 'id', 'text', 'declared'],
        additionalProperties: false,
      },
      {
        type: 'object',
        properties: {
          kind: { const: GM_ROLL_PROPOSAL },
          id: idSchema,
          roller: idSchema,
          reason: { type: 'string', maxLength: MAX_ROLL_REASON_LENGTH },
          visibility: { type: 'string', enum: GM_ROLL_VISIBILITIES },
          ruleId: { type: 'string', maxLength: MAX_ID_LENGTH, pattern: RULE_ID_PATTERN },
          expression: { type: 'string', maxLength: MAX_ROLL_EXPRESSION_LENGTH },
          section: { type: 'string', maxLength: MAX_ROLL_SECTION_LENGTH },
          modifiers: modifiersSchema,
        },
        required: ['kind', 'id', 'roller', 'reason', 'visibility'],
        additionalProperties: false,
      },
      {
        type: 'object',
        properties: {
          kind: { const: VOICE_TRAITS_PROPOSAL },
          id: idSchema,
          entityId: idSchema,
          voiceTraits: voiceTraitsSchema,
        },
        required: ['kind', 'id', 'entityId', 'voiceTraits'],
        additionalProperties: false,
      },
      {
        type: 'object',
        properties: {
          kind: { const: CONDITION_PROPOSAL },
          id: idSchema,
          conditionId: idSchema,
          reason: { type: 'string', maxLength: MAX_MODIFIER_TEXT_LENGTH },
          label: { type: 'string', maxLength: MAX_NAME_LENGTH },
          duration: durationSchema,
          appliesTo: { type: 'array', maxItems: MAX_MODIFIERS, items: { type: 'string', maxLength: MAX_ID_LENGTH } },
          modifiers: modifiersSchema,
          targetId: idSchema,
        },
        required: ['kind', 'id', 'conditionId', 'reason'],
        additionalProperties: false,
      },
      {
        type: 'object',
        properties: {
          kind: { const: CONDITION_END_PROPOSAL },
          id: idSchema,
          conditionId: idSchema,
          targetId: idSchema,
        },
        required: ['kind', 'id', 'conditionId'],
        additionalProperties: false,
      },
      {
        type: 'object',
        properties: {
          kind: { const: CLAIM_PROPOSAL },
          id: idSchema,
          entityId: idSchema,
          claimKind: { type: 'string', enum: CLAIM_KINDS },
          key: { type: 'string', maxLength: MAX_NAME_LENGTH },
          value: { type: 'string', maxLength: MAX_FACT_LENGTH },
          visibility: visibilitySchema,
        },
        required: ['kind', 'id', 'entityId', 'claimKind', 'value'],
        additionalProperties: false,
      },
    ],
  },
} as const;

const idOf = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length <= MAX_ID_LENGTH && ID_REGEX.test(value) ? value : undefined;

const idOrRule = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length <= MAX_ID_LENGTH && RULE_ID_REGEX.test(value) ? value : undefined;

const textOf = (value: unknown, max: number): string | undefined => {
  const text = typeof value === 'string' ? value.trim() : '';
  return text === '' || text.length > max ? undefined : text;
};

const visibilityOf = (value: unknown): ProposalVisibility | undefined =>
  value === undefined ? DEFAULT_VISIBILITY : PROPOSAL_VISIBILITIES.find((visibility) => visibility === value);

const listOf = <T>(value: unknown, max: number, item: (entry: unknown) => T | undefined): T[] | undefined => {
  if (!Array.isArray(value) || value.length > max) return undefined;
  const items = value.map(item);
  return items.every((entry) => entry !== undefined) ? (items as T[]) : undefined;
};

const SHEET_KEYS = ['motivations', 'background', 'traits', 'rulepack'];
const TRAIT_KEYS = ['id', 'value'];
const RULEPACK_KEYS = ['id', 'edition', 'revision'];

const onlyKeys = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  isRecord(value) && Object.keys(value).every((key) => keys.includes(key));

const traitOf = (value: unknown) => {
  if (!onlyKeys(value, TRAIT_KEYS) || typeof value.value !== 'number' || !Number.isFinite(value.value))
    return undefined;
  const id = textOf(value.id, MAX_TAG_LENGTH);
  return id === undefined ? undefined : { id, value: value.value };
};

const sheetRulepackOf = (value: unknown) => {
  if (!onlyKeys(value, RULEPACK_KEYS)) return undefined;
  const [id, edition, revision] = RULEPACK_KEYS.map((key) => textOf(value[key], MAX_TAG_LENGTH));
  return id === undefined || edition === undefined || revision === undefined ? undefined : { id, edition, revision };
};

const sheetOf = (value: unknown): NpcSheetProposal | undefined => {
  if (!onlyKeys(value, SHEET_KEYS)) return undefined;
  const motivations =
    value.motivations === undefined
      ? []
      : listOf(value.motivations, MAX_FACTS, (goal) => textOf(goal, MAX_FACT_LENGTH));
  const traits = listOf(value.traits, MAX_SHEET_TRAITS, traitOf);
  const rulepack = sheetRulepackOf(value.rulepack);
  const background = typeof value.background === 'string' ? value.background.trim() : (value.background ?? '');
  const bounded = typeof background === 'string' && background.length <= MAX_FACT_LENGTH;
  if (motivations === undefined || traits === undefined || rulepack === undefined || !bounded) return undefined;
  return { motivations, background, traits, rulepack };
};

const entityOf = (value: Record<string, unknown>): EntityProposal | undefined => {
  const id = idOf(value.id);
  const name = textOf(value.name, MAX_NAME_LENGTH);
  const entityKind = PROPOSAL_ENTITY_KINDS.find((kind) => kind === value.entityKind);
  const visibility = visibilityOf(value.visibility);
  const facts =
    value.facts === undefined ? [] : listOf(value.facts, MAX_FACTS, (fact) => textOf(fact, MAX_FACT_LENGTH));
  if (id === undefined || name === undefined || entityKind === undefined || visibility === undefined) return undefined;
  if (facts === undefined) return undefined;
  const locationKind = value.locationKind === undefined ? undefined : textOf(value.locationKind, MAX_TAG_LENGTH);
  const mood =
    value.mood === undefined ? undefined : listOf(value.mood, MAX_MOOD_TAGS, (tag) => textOf(tag, MAX_TAG_LENGTH));
  const voiceTraits = toVoiceTraits(value.voiceTraits);
  const sheet = value.sheet === undefined ? undefined : sheetOf(value.sheet);
  if (value.sheet !== undefined && sheet === undefined) return undefined;
  if (
    (value.locationKind !== undefined && locationKind === undefined) ||
    (value.mood !== undefined && mood === undefined)
  )
    return undefined;
  return {
    kind: ENTITY_PROPOSAL,
    id,
    entityKind,
    name,
    ...(facts.length === 0 ? {} : { facts }),
    ...(locationKind === undefined ? {} : { locationKind }),
    ...(mood === undefined ? {} : { mood }),
    ...(voiceTraits === undefined ? {} : { voiceTraits }),
    ...(sheet === undefined ? {} : { sheet }),
    visibility,
  };
};

const pendingOf = (value: Record<string, unknown>): PendingProposal | undefined => {
  const id = idOf(value.id);
  const text = textOf(value.text, MAX_PENDING_TEXT_LENGTH);
  const pendingKind = PENDING_KINDS.find((kind) => kind === value.pendingKind);
  const visibility = visibilityOf(value.visibility);
  const entityIds = listOf(value.entityIds, MAX_PENDING_ENTITIES, idOf);
  if (id === undefined || text === undefined || pendingKind === undefined || visibility === undefined) return undefined;
  if (entityIds === undefined || entityIds.length === 0) return undefined;
  return { kind: PENDING_PROPOSAL, id, pendingKind, text, entityIds, visibility };
};

const MODIFIER_KEYS = ['id', 'reason', 'sourceRule', 'value'];

const modifierOf = (entry: unknown): ModifierRequest | undefined => {
  if (!isRecord(entry) || !Object.keys(entry).every((key) => MODIFIER_KEYS.includes(key))) return undefined;
  const id = idOf(entry.id);
  const reason = textOf(entry.reason, MAX_MODIFIER_TEXT_LENGTH);
  const sourceRule = entry.sourceRule === undefined ? undefined : textOf(entry.sourceRule, MAX_NAME_LENGTH);
  const { value } = entry;
  const validValue = value === undefined || (Number.isInteger(value) && Math.abs(Number(value)) <= MAX_MODIFIER_VALUE);
  if (id === undefined || reason === undefined || !validValue) return undefined;
  if (entry.sourceRule !== undefined && sourceRule === undefined) return undefined;
  return {
    id,
    reason,
    ...(sourceRule === undefined ? {} : { sourceRule }),
    ...(value === undefined ? {} : { value: Number(value) }),
  };
};

const modifiersOf = (value: unknown): readonly ModifierRequest[] | undefined | null =>
  value === undefined ? undefined : (listOf(value, MAX_MODIFIERS, modifierOf) ?? null);

const durationOf = (value: unknown): ConditionDuration | undefined | null => {
  if (value === undefined) return undefined;
  if (!isRecord(value) || !Number.isInteger(value.count)) return null;
  const unit = DURATION_UNITS.find((known) => known === value.unit);
  const count = Number(value.count);
  return unit === undefined || count < MIN_DURATION || count > MAX_CONDITION_DURATION ? null : { unit, count };
};

const checkOf = (value: Record<string, unknown>): CheckProposal | undefined => {
  const id = idOf(value.id);
  const ruleId = typeof value.ruleId === 'string' && RULE_ID_REGEX.test(value.ruleId) ? value.ruleId : undefined;
  const target = textOf(value.target, MAX_NAME_LENGTH);
  const attacker = value.attacker === undefined ? undefined : textOf(value.attacker, MAX_NAME_LENGTH);
  const label = textOf(value.label, MAX_LABEL_LENGTH);
  const difficulty = value.difficulty === undefined ? undefined : idOf(value.difficulty);
  const modifiers = modifiersOf(value.modifiers);
  if (id === undefined || ruleId === undefined || target === undefined || label === undefined) return undefined;
  if ((value.difficulty !== undefined && difficulty === undefined) || modifiers === null) return undefined;
  if (value.attacker !== undefined && attacker === undefined) return undefined;
  const needsCheck = value[NEEDS_CHECK_FIELD];
  if (needsCheck !== undefined && typeof needsCheck !== 'boolean') return undefined;
  return {
    kind: CHECK_PROPOSAL,
    id,
    ruleId,
    target,
    ...(attacker === undefined ? {} : { attacker }),
    label,
    ...(difficulty === undefined ? {} : { difficulty }),
    ...(modifiers === undefined ? {} : { modifiers }),
    ...(needsCheck === undefined ? {} : { needsCheck }),
  };
};

const outcomeOf = (value: Record<string, unknown>): OutcomeProposal | undefined => {
  const id = idOf(value.id);
  const text = textOf(value.text, MAX_OUTCOME_LENGTH);
  const declared = OUTCOME_RESULTS.find((known) => known === value.declared);
  return id === undefined || text === undefined || declared === undefined
    ? undefined
    : { kind: OUTCOME_PROPOSAL, id, text, declared };
};

const gmRollOf = (value: Record<string, unknown>): GmRollProposal | undefined => {
  const id = idOf(value.id);
  const roller = idOf(value.roller);
  const reason = textOf(value.reason, MAX_ROLL_REASON_LENGTH);
  const visibility = GM_ROLL_VISIBILITIES.find((known) => known === value.visibility);
  const ruleId = typeof value.ruleId === 'string' && RULE_ID_REGEX.test(value.ruleId) ? value.ruleId : undefined;
  const expression = textOf(value.expression, MAX_ROLL_EXPRESSION_LENGTH);
  const section = value.section === undefined ? undefined : textOf(value.section, MAX_ROLL_SECTION_LENGTH);
  if (value.section !== undefined && section === undefined) return undefined;
  if (id === undefined || roller === undefined || reason === undefined || visibility === undefined) return undefined;
  const modifiers = modifiersOf(value.modifiers);
  if ((ruleId === undefined) === (expression === undefined) || modifiers === null) return undefined;
  return {
    kind: GM_ROLL_PROPOSAL,
    id,
    roller,
    reason,
    visibility,
    ...(ruleId === undefined ? {} : { ruleId }),
    ...(expression === undefined ? {} : { expression }),
    ...(section === undefined ? {} : { section }),
    ...(modifiers === undefined ? {} : { modifiers }),
  };
};

const voiceTraitsOf = (value: Record<string, unknown>): VoiceTraitsProposal | undefined => {
  const id = idOf(value.id);
  const entityId = idOf(value.entityId);
  const voiceTraits = toVoiceTraits(value.voiceTraits);
  if (id === undefined || entityId === undefined || voiceTraits === undefined) return undefined;
  return { kind: VOICE_TRAITS_PROPOSAL, id, entityId, voiceTraits };
};

const conditionOf = (value: Record<string, unknown>): ConditionProposal | undefined => {
  const id = idOf(value.id);
  const conditionId = idOf(value.conditionId);
  const reason = textOf(value.reason, MAX_MODIFIER_TEXT_LENGTH);
  const label = value.label === undefined ? undefined : textOf(value.label, MAX_NAME_LENGTH);
  const duration = durationOf(value.duration);
  const modifiers = modifiersOf(value.modifiers);
  const appliesTo = value.appliesTo === undefined ? undefined : listOf(value.appliesTo, MAX_MODIFIERS, idOrRule);
  if (id === undefined || conditionId === undefined || reason === undefined) return undefined;
  if ((value.label !== undefined && label === undefined) || duration === null || modifiers === null) return undefined;
  if (value.appliesTo !== undefined && appliesTo === undefined) return undefined;
  const targetId = value.targetId === undefined ? undefined : idOf(value.targetId);
  if (value.targetId !== undefined && targetId === undefined) return undefined;
  return {
    kind: CONDITION_PROPOSAL,
    id,
    conditionId,
    reason,
    ...(label === undefined ? {} : { label }),
    ...(duration === undefined ? {} : { duration }),
    ...(appliesTo === undefined ? {} : { appliesTo }),
    ...(modifiers === undefined ? {} : { modifiers }),
    ...(targetId === undefined ? {} : { targetId }),
  };
};

const conditionEndOf = (value: Record<string, unknown>): ConditionEndProposal | undefined => {
  const id = idOf(value.id);
  const conditionId = idOf(value.conditionId);
  const targetId = value.targetId === undefined ? undefined : idOf(value.targetId);
  if (id === undefined || conditionId === undefined) return undefined;
  if (value.targetId !== undefined && targetId === undefined) return undefined;
  return { kind: CONDITION_END_PROPOSAL, id, conditionId, ...(targetId === undefined ? {} : { targetId }) };
};

const claimOf = (value: Record<string, unknown>): ClaimProposal | undefined => {
  const id = idOf(value.id);
  const entityId = idOf(value.entityId);
  const claimKind = CLAIM_KINDS.find((kind) => kind === value.claimKind);
  const claimValue = textOf(value.value, MAX_FACT_LENGTH);
  const key = value.key === undefined ? undefined : textOf(value.key, MAX_NAME_LENGTH);
  const visibility = value.visibility === undefined ? undefined : visibilityOf(value.visibility);
  if (id === undefined || entityId === undefined || claimKind === undefined || claimValue === undefined)
    return undefined;
  if ((value.key !== undefined && key === undefined) || (value.visibility !== undefined && visibility === undefined))
    return undefined;
  return {
    kind: CLAIM_PROPOSAL,
    id,
    entityId,
    claimKind,
    value: claimValue,
    ...(key === undefined ? {} : { key }),
    ...(visibility === undefined ? {} : { visibility }),
  };
};

const healOf = (value: Record<string, unknown>): HealProposal | undefined => {
  const id = idOf(value.id);
  const target = textOf(value.target, MAX_NAME_LENGTH);
  const { amount } = value;
  const valid = Number.isInteger(amount) && Number(amount) >= MIN_HEAL_AMOUNT && Number(amount) <= MAX_HEAL_AMOUNT;
  return id === undefined || target === undefined || !valid
    ? undefined
    : { kind: HEAL_PROPOSAL, id, target, amount: Number(amount) };
};

const PARSERS = {
  [ENTITY_PROPOSAL]: entityOf,
  [PENDING_PROPOSAL]: pendingOf,
  [CHECK_PROPOSAL]: checkOf,
  [OUTCOME_PROPOSAL]: outcomeOf,
  [GM_ROLL_PROPOSAL]: gmRollOf,
  [VOICE_TRAITS_PROPOSAL]: voiceTraitsOf,
  [CONDITION_PROPOSAL]: conditionOf,
  [CONDITION_END_PROPOSAL]: conditionEndOf,
  [CLAIM_PROPOSAL]: claimOf,
  [HEAL_PROPOSAL]: healOf,
} as const;

const proposalOf = (value: unknown): GmProposal | undefined => {
  if (!isRecord(value)) return undefined;
  const kind = Object.keys(PARSERS).find((known): known is keyof typeof PARSERS => known === value.kind);
  if (kind === undefined || !Object.keys(value).every((key) => PROPOSAL_KEYS[kind].some((known) => known === key)))
    return undefined;
  return PARSERS[kind](value);
};

export const proposalsOf = (value: unknown): readonly GmProposal[] | undefined => {
  const listed = isRecord(value) ? value.proposals : undefined;
  const proposals = listOf(listed, MAX_PROPOSALS, proposalOf);
  return proposals === undefined || proposals.length === 0 ? undefined : proposals;
};

export const outcomeClaimsOf = (proposals: readonly GmProposal[]): NarrationClaim[] =>
  proposals.flatMap((proposal) =>
    proposal.kind === OUTCOME_PROPOSAL
      ? [{ kind: 'outcome' as const, ref: proposal.id, declared: proposal.declared }]
      : [],
  );

export const claimDraftOf = ({ entityId, claimKind, key, value, visibility }: ClaimProposal): ClaimDraft => ({
  entityId,
  kind: claimKind,
  value,
  ...(key === undefined ? {} : { key }),
  ...(visibility === undefined ? {} : { visibility }),
});

const REFUSALS = [InvalidActionError, ActionIdConflictError, StaleRevisionError];

const actionFor = (committed: CommittedTurn, { kind, id }: GmProposal, revision: number): PlayerAction => ({
  campaignId: committed.turn.campaignId,
  actionId: `${committed.turn.actionId}:proposal:${kind}:${id}`,
  expectedRevision: revision,
  sceneId: committed.turn.sceneId,
  actorId: committed.turn.actorId,
  input: `${GM_PROPOSAL_INPUT}${kind} ${id}`,
  intent: `The GM records ${kind} ${id}.`,
});

export const gmRollLinesOf = (store: CampaignStore, committed: CommittedTurn): readonly string[] =>
  proposalEventsOf(loadState(store, committed.turn.campaignId), committed.turn.actionId)
    .filter(({ type }) => type === GM_ROLLED)
    .map(({ type, payload }) => `${type} ${JSON.stringify(payload)}`);

export const commitGmRolls = (
  store: CampaignStore,
  entities: EntityStore,
  committed: CommittedTurn,
  proposals: readonly GmProposal[],
  expressionOf: (spec: Pick<GmRollProposal, 'ruleId' | 'expression' | 'roller' | 'section'>) => string | undefined,
  rng: Rng,
  policy?: ModifierPolicy,
): readonly CommittedTurn[] => {
  const { campaignId } = committed.turn;
  const results: CommittedTurn[] = [];
  for (const proposal of proposals) {
    if (proposal.kind !== GM_ROLL_PROPOSAL) continue;
    const { roller, reason, visibility, section, modifiers } = proposal;
    const expression = expressionOf(proposal);
    if (expression === undefined) continue;
    const action = actionFor(committed, proposal, loadState(store, campaignId).revision);
    try {
      results.push(
        rollForGm(
          store,
          entities,
          {
            ...action,
            gmRoll: {
              roller,
              reason,
              visibility,
              expression,
              ...(section === undefined ? {} : { section }),
              ...(modifiers === undefined ? {} : { modifiers }),
            },
          },
          rng,
          policy,
        ),
      );
    } catch (error) {
      if (!REFUSALS.some((refusal) => error instanceof refusal)) throw error;
    }
  }
  return results;
};

const SPARSE_DETAIL = 'sparse';
const SHEET_ROLE = 'minor';
const SHEET_ACTION_SUFFIX = ':sheet';

const sparseSheetOf = ({ id, name, sheet }: EntityProposal) => ({
  detail: SPARSE_DETAIL,
  npcId: id,
  role: SHEET_ROLE,
  name,
  ...sheet,
});

export type HealTargetResolver = (
  events: readonly CampaignEvent[],
  entities: readonly CampaignEntity[],
  target: string,
  actorId: CharacterId,
  rules: CombatRules,
) => Combatant | undefined;

export const commitProposals = (
  store: CampaignStore,
  entities: EntityStore,
  facts: FactStore,
  committed: CommittedTurn,
  proposals: readonly GmProposal[],
  checkRules: readonly string[] = NO_RULES,
  policy?: ModifierPolicy,
  combat?: CombatRules,
  healTargetOf?: HealTargetResolver,
): readonly CommittedTurn[] => {
  const { campaignId } = committed.turn;
  const results: CommittedTurn[] = [];
  const rejections: string[] = [];
  for (const proposal of proposals) {
    if (proposal.kind === OUTCOME_PROPOSAL || proposal.kind === GM_ROLL_PROPOSAL) continue;
    const action = actionFor(committed, proposal, loadState(store, campaignId).revision);
    try {
      if (proposal.kind === VOICE_TRAITS_PROPOSAL) {
        results.push(
          setVoiceTraits(store, entities, { ...action, speakerId: proposal.entityId, traits: proposal.voiceTraits }),
        );
        continue;
      }
      if (proposal.kind === CHECK_PROPOSAL) {
        const { id: offerId, ruleId, target, attacker, label, difficulty, modifiers } = proposal;
        if (checkRules.includes(ruleId))
          results.push(
            offerCheck(store, {
              ...action,
              offer: {
                offerId,
                ruleId,
                target,
                label,
                ...(attacker === undefined ? {} : { attacker }),
                ...(difficulty === undefined ? {} : { difficulty }),
              },
              ...(modifiers === undefined ? {} : { requested: modifiers }),
              ...(policy === undefined ? {} : { policy }),
            }),
          );
        continue;
      }
      if (proposal.kind === HEAL_PROPOSAL) {
        const { events } = loadState(store, campaignId);
        const healed =
          combat === undefined || healTargetOf === undefined
            ? undefined
            : healTargetOf(events, entities.listEntities(campaignId), proposal.target, committed.turn.actorId, combat);
        if (healed !== undefined)
          results.push(healCombatant(store, { ...action, target: healed, amount: proposal.amount }));
        continue;
      }
      if (proposal.kind === CONDITION_PROPOSAL) {
        if (policy !== undefined) {
          const { id: _id, kind: _kind, ...condition } = proposal;
          results.push(
            applyCondition(store, { ...action, condition: condition as ConditionRequest, ...policy }, entities),
          );
        }
        continue;
      }
      if (proposal.kind === CONDITION_END_PROPOSAL) {
        results.push(
          endCondition(store, { ...action, conditionId: proposal.conditionId, targetId: proposal.targetId }, entities),
        );
        continue;
      }
      if (proposal.kind === CLAIM_PROPOSAL) {
        results.push(proposeClaims(store, entities, { ...action, claims: [claimDraftOf(proposal)] }));
        continue;
      }
      const scope = { visibility: proposal.visibility, actorId: null };
      const existing = proposal.kind === ENTITY_PROPOSAL ? entities.getEntity(campaignId, proposal.id) : undefined;
      if (proposal.kind === ENTITY_PROPOSAL && existing !== undefined) {
        if (proposal.sheet !== undefined)
          results.push(
            setNpcSheet(store, entities, {
              ...action,
              actionId: `${action.actionId}${SHEET_ACTION_SUFFIX}`,
              npcId: proposal.id,
              sheet: sparseSheetOf({ ...proposal, name: existing.name }),
              ...(combat === undefined ? {} : { combat }),
            }),
          );
        continue;
      }
      if (proposal.kind === ENTITY_PROPOSAL)
        results.push(
          introduceEntity(store, entities, facts, {
            ...action,
            entity: {
              id: proposal.id,
              kind: proposal.entityKind,
              name: proposal.name,
              data: {
                ...(proposal.voiceTraits === undefined ? {} : { [VOICE_TRAITS_FIELD]: proposal.voiceTraits }),
                ...(proposal.sheet === undefined ? {} : { [NPC_SHEET_FIELD]: sparseSheetOf(proposal) }),
              },
              ...scope,
            },
            facts: (proposal.facts ?? []).map((statement, index) => ({
              id: `${proposal.id}-fact-${index}`,
              statement,
              layer: FACT_LAYER,
              ...scope,
            })),
            relationships: [],
            ...(combat === undefined ? {} : { combat }),
          }),
        );
      else if (proposal.entityIds.every((id) => entities.getEntity(campaignId, id) !== undefined))
        results.push(
          openPending(store, {
            ...action,
            pending: {
              pendingId: proposal.id,
              kind: proposal.pendingKind,
              text: proposal.text,
              entityIds: proposal.entityIds,
              ...scope,
            },
          }),
        );
    } catch (error) {
      if (!(error instanceof Error) || !REFUSALS.some((refusal) => error instanceof refusal)) throw error;
      rejections.push(`${proposal.kind} ${proposal.id}: ${error.message}`);
    }
  }
  recordGmRejections(store, campaignId, committed.turn.id, rejections);
  return results;
};
