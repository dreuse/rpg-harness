import type { EventId } from '../../domain/src/campaign.ts';
import type { RuleCitation, RulePackLink } from '../../domain/src/character.ts';
import type { EntityId } from '../../domain/src/entity.ts';
import { type Scoped, type Viewer, visibleTo } from '../../memory/src/knowledge.ts';
import {
  type ContextItem,
  type ContextKind,
  type ContextSnapshot,
  retrieveContext,
} from '../../memory/src/retrieval.ts';
import { type DialogueContext, dialogueContext, type NpcState } from './npc.ts';

export type RuleEntry = Scoped & { readonly id: string; readonly summary: string; readonly section: string };

export type SourceReference =
  | { readonly type: 'event'; readonly id: EventId }
  | { readonly type: 'rule'; readonly rulepack: RulePackLink; readonly section: string };

export type GmContextEntry = {
  readonly kind: ContextKind;
  readonly id: string;
  readonly text: string;
  readonly sources: readonly SourceReference[];
};

export type GmRule = { readonly id: string; readonly summary: string; readonly sources: readonly SourceReference[] };

export type GmContextInput = {
  readonly snapshot: ContextSnapshot;
  readonly rulepack: RulePackLink;
  readonly rules: readonly RuleEntry[];
  readonly budget: number;
  readonly dialogue?: { readonly npc: NpcState; readonly speakerId: EntityId };
};

export type GmContext = {
  readonly viewer: Viewer;
  readonly rulepack: RulePackLink;
  readonly rules: readonly GmRule[];
  readonly entries: readonly GmContextEntry[];
  readonly budget: number;
  readonly usedTokens: number;
  readonly requiredExceedsBudget: boolean;
  readonly truncated: readonly { readonly kind: ContextKind; readonly id: string }[];
  readonly dialogue: DialogueContext | undefined;
};

const toEntry =
  (kind: ContextKind) =>
  ({ id, text, sourceEventIds }: ContextItem): GmContextEntry => ({
    kind,
    id,
    text,
    sources: sourceEventIds.map((eventId) => ({ type: 'event', id: eventId })),
  });

const voices = (viewer: Viewer, npc: NpcState) =>
  viewer.scope === 'gm' || (viewer.scope === 'actor' && viewer.actorId === npc.id);

export const citeRule = (context: GmContext, ruleId: string): RuleCitation | undefined => {
  const source = context.rules.find(({ id }) => id === ruleId)?.sources.find(({ type }) => type === 'rule');
  return source?.type === 'rule' ? { ruleId, rulepack: source.rulepack, section: source.section } : undefined;
};

export const assembleGmContext = (input: GmContextInput, viewer: Viewer): GmContext => {
  const retrieved = retrieveContext(input.snapshot, viewer, input.budget);
  return {
    viewer,
    rulepack: input.rulepack,
    rules: visibleTo(input.rules, viewer).map(({ id, summary, section }) => ({
      id,
      summary,
      sources: [{ type: 'rule', rulepack: input.rulepack, section }],
    })),
    entries: [
      toEntry('scene')(retrieved.scene),
      ...retrieved.threads.map(toEntry('thread')),
      ...retrieved.facts.map(toEntry('fact')),
      ...retrieved.entities.map(toEntry('entity')),
      ...retrieved.history.map(toEntry('history')),
    ],
    budget: retrieved.budget,
    usedTokens: retrieved.usedTokens,
    requiredExceedsBudget: retrieved.requiredExceedsBudget,
    truncated: retrieved.truncated,
    dialogue:
      input.dialogue && voices(viewer, input.dialogue.npc)
        ? dialogueContext(input.dialogue.npc, input.snapshot.facts, input.dialogue.speakerId)
        : undefined,
  };
};
