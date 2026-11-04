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

const NAME_QUESTION = 'Name?';
const NAME_PATTERN = /\b(?:named|called)\s+([\p{L}\p{N}'-]+)/iu;
const NUMBER_AFTER = String.raw`(?:\s*(?:of|=|:))?\s*(-?\d+(?:\.\d+)?)\b`;
const REGEX_SPECIALS = /[.*+?^${}()|[\]\\]/g;
const TRUE_ANSWERS = ['yes', 'y', 'true'];
const FALSE_ANSWERS = ['no', 'n', 'false'];

const escaped = (text: string) => text.replace(REGEX_SPECIALS, '\\$&');
const wordPattern = (term: string, after = '') =>
  new RegExp(String.raw`(?<![\p{L}\p{N}])${escaped(term)}${after}`, 'giu');
const termsOf = (field: SheetField) => [field.id, ...(field.label === undefined ? [] : [field.label])];
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
