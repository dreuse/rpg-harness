import { contentAliases } from '../../../packages/client-protocol/src/content-names.ts';
import type { ProfileTraitValue } from '../../../packages/domain/src/character.ts';
import {
  type BuildInput,
  type BuildResult,
  buildCharacter,
  type ChoiceQuestion,
  type CreationRules,
} from '../../../packages/rules/src/character-builder.ts';
import { NUMERIC_WIDGETS } from '../../../packages/rules/src/derived-stats.ts';
import type { SheetField } from '../../../packages/rules/src/sheet-schema.ts';

export type Ask = (question: string) => Promise<string | undefined>;

const FALLBACK_STAT = 0;
const NO_EMPHASIS: readonly number[] = [];
const STAT_EMPHASIS: Record<string, readonly number[]> = {
  skeptic: [0, 0, 3, -1],
  survivor: [2, 1, 0, 1],
  detective: [-1, 0, 3, 1],
  journalist: [-1, 1, 2, 3],
  fixer: [-1, 1, 1, 3],
  reporter: [0, 2, 1, 2],
  pilot: [0, 3, 2, -1],
  'hedge-witch': [-1, 0, 3, 2],
  'exiled-knight': [3, 1, -1, 2],
  'river-smuggler': [0, 3, 1, 2],
  'station-engineer': [1, 0, 3, -1],
  'corporate-envoy': [-1, 0, 2, 3],
  'drift-salvager': [2, 2, 1, -1],
};
const NAME_QUESTION = 'Name?';
const NAME_PATTERN = /\b(?:named|called)\s+([\p{L}\p{N}'-]+)/iu;
const NAME_END = /[,.;]/;
const MAX_FALLBACK_NAME_WORDS = 4;
const WORD_BREAK = /\s+/;
const NUMBER_AFTER = String.raw`(?:\s*(?:of|=|:))?\s*(-?\d+(?:\.\d+)?)\b`;
const REGEX_SPECIALS = /[.*+?^${}()|[\]\\]/g;
const TRUE_ANSWERS = ['yes', 'y', 'true'];
const FALSE_ANSWERS = ['no', 'n', 'false'];

const escaped = (text: string) => text.replace(REGEX_SPECIALS, '\\$&');
const wordPattern = (term: string, after = '') =>
  new RegExp(String.raw`(?<![\p{L}\p{N}])${escaped(term)}${after}`, 'giu');
const termsOf = (field: SheetField) => [
  field.id,
  ...(field.label === undefined ? [] : [field.label]),
  ...contentAliases('stat', field.label ?? field.id),
];
const shortName = (description: string) =>
  (description.split(NAME_END, 1)[0] ?? '').trim().split(WORD_BREAK).slice(0, MAX_FALLBACK_NAME_WORDS).join(' ');
const only = <T>(found: Set<T>) => (found.size === 1 ? [...found][0] : undefined);

const numberIn = (description: string, field: SheetField) => {
  const found = new Set(
    termsOf(field).flatMap((term) =>
      [...description.matchAll(wordPattern(term, NUMBER_AFTER))].map((m) => Number(m[1])),
    ),
  );
  return only(found);
};

const mentioned = (description: string, words: readonly string[]) =>
  new Set(words.filter((word) => wordPattern(word, String.raw`(?![\p{L}\p{N}])`).test(description)));

const valueIn = (description: string, field: SheetField): ProfileTraitValue | undefined => {
  if (NUMERIC_WIDGETS.includes(field.widget)) return numberIn(description, field);
  if (field.widget === 'choice') return only(mentioned(description, field.options ?? []));
  return undefined;
};

const proposalFrom = (rules: CreationRules, description: string) => {
  const values: Record<string, ProfileTraitValue> = {};
  for (const field of rules.schema.fields.filter(({ derived }) => !derived)) {
    const value = valueIn(description, field);
    if (value !== undefined) values[field.id] = value;
  }
  return { values, equipment: [...mentioned(description, rules.startingEquipment)] };
};

const questionText = ({ fieldId, label, options, min, max }: ChoiceQuestion) => {
  const range = min === undefined && max === undefined ? [] : [`${min ?? ''} to ${max ?? ''}`.trim()];
  const hint = [...(options === undefined ? [] : [options.join(', ')]), ...range];
  return `${label ?? fieldId}?${hint.length === 0 ? '' : ` (${hint.join('; ')})`}`;
};

const answerFor = ({ widget, options }: ChoiceQuestion, answer: string): ProfileTraitValue | undefined => {
  const text = answer.trim();
  const lower = text.toLowerCase();
  if (NUMERIC_WIDGETS.includes(widget)) return text === '' || !Number.isFinite(Number(text)) ? undefined : Number(text);
  if (widget === 'choice') return options?.find((option) => option.toLowerCase() === lower);
  if (widget !== 'toggle') return undefined;
  if (TRUE_ANSWERS.includes(lower)) return true;
  return FALSE_ANSWERS.includes(lower) ? false : undefined;
};

export type Creation = { build: BuildInput; result: BuildResult };

export const describedBuild = (rules: CreationRules, description: string): BuildInput => ({
  rules,
  backstory: description,
  proposal: {
    name: description.match(NAME_PATTERN)?.[1] ?? shortName(description),
    ...proposalFrom(rules, description),
  },
});

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const emphasisFor = (name: string) =>
  Object.entries(STAT_EMPHASIS).find(
    ([id]) =>
      sameName(id.replaceAll('-', ' '), name) || contentAliases('archetype', id).some((alias) => sameName(alias, name)),
  )?.[1] ?? NO_EMPHASIS;

const defaultValue = (
  { id, widget, options }: SheetField,
  { constraints }: CreationRules,
  offset = 0,
): ProfileTraitValue | undefined => {
  if (NUMERIC_WIDGETS.includes(widget)) {
    const bounds = constraints.filter(({ field }) => field === id);
    const min = Math.max(...bounds.flatMap(({ min: low }) => low ?? []), Number.NEGATIVE_INFINITY);
    const max = Math.min(...bounds.flatMap(({ max: high }) => high ?? []), Number.POSITIVE_INFINITY);
    const middle = Math.ceil((min + max) / 2);
    const base = [middle, min, max].find(Number.isFinite) ?? FALLBACK_STAT;
    return Math.min(Math.max(base + offset, min), max);
  }
  if (widget === 'choice') return options?.[0];
  return widget === 'toggle' ? false : undefined;
};

export const premadeBuild = (rules: CreationRules, name: string): BuildInput => {
  const build = describedBuild(rules, name);
  const values: Record<string, ProfileTraitValue> = {};
  const emphasis = emphasisFor(name);
  const stats = rules.schema.fields.filter(({ derived, widget }) => !derived && NUMERIC_WIDGETS.includes(widget));
  for (const field of rules.schema.fields.filter(({ derived }) => !derived)) {
    const offset = emphasis[stats.indexOf(field)];
    const value = build.proposal.values[field.id] ?? defaultValue(field, rules, offset);
    if (value !== undefined) values[field.id] = value;
  }
  return { ...build, proposal: { ...build.proposal, values } };
};

export const createCharacter = async (rules: CreationRules, description: string, ask: Ask): Promise<Creation> => {
  const name = description.match(NAME_PATTERN)?.[1] ?? (await ask(NAME_QUESTION))?.trim() ?? '';
  const proposal = { name, ...proposalFrom(rules, description) };
  const input = { rules, backstory: description, proposal };
  const first = buildCharacter(input);
  if (first.status !== 'pending') return { build: input, result: first };
  const choices: Record<string, ProfileTraitValue> = {};
  for (const question of first.questions) {
    const answer = await ask(questionText(question));
    const value = answer === undefined ? undefined : answerFor(question, answer);
    if (value !== undefined) choices[question.fieldId] = value;
  }
  const build = { ...input, choices };
  return { build, result: buildCharacter(build) };
};
