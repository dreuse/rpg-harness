import { repeatedLinesOf, sentencesOf } from '../apps/cli/src/gm-repetition.ts';

export const REVEAL_BY_TURN = 2;
export const CHOICE_BY_TURN = 3;
const NONE = 0;
const NOT_FOUND = -1;
const ALTERNATIVE = /\bor\b.*\?|\b(choose|decide)\b/iu;
const LEADING_ARTICLE = /^the\s+/u;
const WHITESPACE = /\s+/u;

export type EvalTurn = {
  readonly narration: string;
  readonly introduced: readonly string[];
  readonly rolled: boolean;
};
export type Verdict = { readonly pass: boolean; readonly failures: readonly string[] };

const verdictOf = (failures: readonly string[]): Verdict => ({ pass: failures.length === NONE, failures });

const lastSentenceOf = (narration: string) => sentencesOf(narration).at(-1) ?? '';

export const revealedBy = (turns: readonly EvalTurn[], by: number): boolean =>
  turns.slice(NONE, by).some(({ introduced }) => introduced.length > NONE);

export const endsOnChoice = (narration: string): boolean => ALTERNATIVE.test(lastSentenceOf(narration));

export const endingsDiffer = (narrations: readonly string[]): boolean =>
  narrations.every(
    (narration, index) =>
      index === NONE || !repeatedLinesOf(narration, [narrations[index - 1] ?? '']).includes(lastSentenceOf(narration)),
  );

export const chapelVerdict = (turns: readonly EvalTurn[]): Verdict =>
  verdictOf([
    ...(revealedBy(turns, REVEAL_BY_TURN) ? [] : [`no reveal or named NPC by turn ${REVEAL_BY_TURN}`]),
    ...(turns.slice(NONE, CHOICE_BY_TURN).some(({ narration }) => endsOnChoice(narration))
      ? []
      : [`no player choice by turn ${CHOICE_BY_TURN}`]),
  ]);

const nameKeyOf = (name: string): string =>
  name.toLowerCase().trim().replace(LEADING_ARTICLE, '').split(WHITESPACE).at(-1) ?? '';

const introducesNewEntity = (turns: readonly EvalTurn[], rollIndex: number): boolean => {
  const known = new Set(turns.slice(NONE, rollIndex + 1).flatMap(({ introduced }) => introduced.map(nameKeyOf)));
  return turns
    .slice(rollIndex + 1)
    .some(({ introduced }) => introduced.map(nameKeyOf).filter((key) => !known.has(key)).length > NONE);
};

export const attackVerdict = (turns: readonly EvalTurn[]): Verdict => {
  const narrations = turns.map(({ narration }) => narration);
  const rollIndex = turns.findIndex(({ rolled }) => rolled);
  const last = narrations.at(-1) ?? '';
  const sceneChanged =
    rollIndex !== NOT_FOUND &&
    repeatedLinesOf(last, narrations.slice(NONE, -1)).length === NONE &&
    introducesNewEntity(turns, rollIndex);
  return verdictOf([
    ...(rollIndex === NOT_FOUND ? ['the attack never resolved with an engine roll'] : []),
    ...(endingsDiffer(narrations) ? [] : ['two turns ended the same way']),
    ...(sceneChanged || rollIndex === NOT_FOUND ? [] : ['the scene did not change after the roll']),
  ]);
};
