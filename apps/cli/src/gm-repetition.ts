const SENTENCE_BOUNDARY = /(?<=[.!?…]["'”’)\]]*)\s+/u;
const NON_WORD = /[^\p{L}\p{N}\s]/gu;
const WHITESPACE = /\s+/u;
export const OVERLAP_THRESHOLD = 0.6;
export const MIN_OVERLAP_TOKENS = 4;
export const COMPARED_NARRATIONS = 2;
const NONE = 0;

export const sentencesOf = (text: string) =>
  text
    .split(SENTENCE_BOUNDARY)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence !== '');

const tokensOf = (sentence: string) =>
  sentence.normalize('NFC').toLowerCase().replace(NON_WORD, '').split(WHITESPACE).filter(Boolean);

const normalized = (sentence: string) => tokensOf(sentence).join(' ');

const overlapOf = (sentence: string, other: string) => {
  const tokens = new Set(tokensOf(sentence));
  const known = new Set(tokensOf(other));
  if (tokens.size < MIN_OVERLAP_TOKENS) return NONE;
  return [...tokens].filter((token) => known.has(token)).length / Math.max(tokens.size, known.size);
};

export const closingSentencesOf = (narrations: readonly string[]): string[] =>
  narrations.flatMap((narration) => sentencesOf(narration).slice(-1));

export const repeatedLinesOf = (narration: string, previous: readonly string[]): string[] => {
  const recent = previous.slice(-COMPARED_NARRATIONS);
  const earlier = recent.flatMap(sentencesOf);
  const closings = new Set(closingSentencesOf(recent).map(normalized));
  const sentences = sentencesOf(narration);
  const last = sentences.at(-1);
  return sentences.filter(
    (sentence) =>
      (sentence === last && closings.has(normalized(sentence))) ||
      earlier.some((old) => overlapOf(sentence, old) > OVERLAP_THRESHOLD),
  );
};
