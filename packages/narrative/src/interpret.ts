import type { CharacterId, SceneId } from '../../domain/src/campaign.ts';
import type { RuleCitation } from '../../domain/src/character.ts';
import type { GmContext, GmContextEntry } from './context.ts';

export type IntentVerb = { readonly intent: string; readonly verbs: readonly string[]; readonly irreversible: boolean };

export type ActionProposal = {
  readonly actionId: string;
  readonly sceneId: SceneId;
  readonly actorId: CharacterId;
  readonly input: string;
  readonly intent: string;
  readonly citation?: RuleCitation;
};

export type Utterance = Omit<ActionProposal, 'intent' | 'citation'>;

export type Interpretation =
  | { readonly kind: 'proposal'; readonly proposal: ActionProposal; readonly targetId: string | null }
  | { readonly kind: 'clarification'; readonly question: string; readonly candidateIds: readonly string[] };

export const FREEFORM_INTENT = 'freeform';

const FREEFORM: IntentVerb = { intent: FREEFORM_INTENT, verbs: [], irreversible: false };
const ENTITY_KIND = 'entity';
const NAME_END = ' {';
const WORD_SEPARATOR = /[^\p{L}\p{N}]+/u;

type Target = { readonly id: string; readonly words: readonly string[]; readonly mechanics: string };

const wordsOf = (text: string): string[] => text.toLowerCase().split(WORD_SEPARATOR).filter(Boolean);

const toTarget = ({ id, text }: GmContextEntry): Target => {
  const end = text.indexOf(NAME_END);
  const name = end === -1 ? text : text.slice(0, end);
  return { id, words: wordsOf(name), mechanics: text.slice(name.length) };
};

const GM_SCOPE = 'gm';

type Group = { readonly word: string; readonly candidates: readonly Target[]; readonly ambiguous: boolean };

const fullName = (target: Target): string => target.words.join(' ');

const isStrictSubset = (target: Target, other: Target): boolean =>
  other.words.length > target.words.length && target.words.every((word) => other.words.includes(word));

const groupTargets = (words: ReadonlySet<string>, context: GmContext): Group[] => {
  if (context.viewer.scope === GM_SCOPE) return [];
  const byWord = Map.groupBy(
    context.entries
      .filter(({ kind }) => kind === ENTITY_KIND)
      .map(toTarget)
      .filter((target) => words.has(target.words.at(-1) ?? '')),
    (target) => target.words.at(-1) ?? '',
  );
  return [...byWord].map(([word, named]) => {
    const matched = named.filter((target) => target.words.every((name) => words.has(name)));
    const exact = matched.filter((target) => !matched.some((other) => isStrictSubset(target, other)));
    const candidates = exact.length > 0 ? exact : named;
    const ambiguous = exact.length > 0 ? new Set(exact.map(fullName)).size < exact.length : named.length > 1;
    return { word, candidates, ambiguous };
  });
};

export const interpretAction = (
  utterance: Utterance,
  context: GmContext,
  vocabulary: readonly IntentVerb[],
): Interpretation => {
  const inputWords = wordsOf(utterance.input);
  const verb = inputWords.map((word) => vocabulary.find(({ verbs }) => verbs.includes(word))).find(Boolean) ?? FREEFORM;
  const groups = groupTargets(new Set(inputWords), context);
  const unclear = groups.find(
    ({ candidates, ambiguous }) =>
      ambiguous && (verb.irreversible || new Set(candidates.map(({ mechanics }) => mechanics)).size > 1),
  );
  if (unclear) {
    return {
      kind: 'clarification',
      question: `Which ${unclear.word} do you mean?`,
      candidateIds: unclear.candidates.map(({ id }) => id),
    };
  }
  const { actionId, sceneId, actorId, input } = utterance;
  return {
    kind: 'proposal',
    proposal: { actionId, sceneId, actorId, input, intent: verb.intent },
    targetId: groups[0]?.candidates[0]?.id ?? null,
  };
};
