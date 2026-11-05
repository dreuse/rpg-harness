import type { EntityId } from '../../domain/src/entity.ts';
import type { ClaimKind } from '../../domain/src/story-memory.ts';
import { PLAYER_VIEWER, visibleTo } from '../../memory/src/knowledge.ts';
import {
  currentEntries,
  type Directory,
  factLine,
  type Ledger,
  type LedgerEntry,
  nameOf,
  visibleLedger,
} from '../../memory/src/ledger.ts';
import { normalize } from './consistency.ts';

export const MAX_CONTINUITY_RETRIES = 1;
export const CONTINUITY_CONFLICT_KINDS = [
  'dead-acts',
  'stale-name',
  'item-not-held',
  'wrong-place',
  'secret-leak',
  'model',
] as const;
export type ContinuityConflictKind = (typeof CONTINUITY_CONFLICT_KINDS)[number];

export type ContinuityConflict = {
  readonly kind: ContinuityConflictKind;
  readonly entityId: EntityId | null;
  readonly fact: string;
  readonly excerpt: string;
  readonly hidden?: boolean;
};

export type ModelContinuityInput = { readonly narration: string; readonly facts: readonly string[] };
export type ModelContinuityCheck = (
  input: ModelContinuityInput,
) => Promise<readonly ContinuityConflict[]> | readonly ContinuityConflict[];

export type ContinuityLogRecord = {
  readonly conflicts: readonly ContinuityConflict[];
  readonly regenerations: number;
  readonly resolved: boolean;
};

export type ContinuityOutcome = ContinuityLogRecord & { readonly narration: string };

export type ContinuityCheckInput = {
  readonly narration: string;
  readonly ledger: Ledger;
  readonly directory: Directory;
};

export type ContinuityRun = Omit<ContinuityCheckInput, 'narration'> & {
  readonly generate: (conflicts: readonly ContinuityConflict[]) => Promise<string> | string;
  readonly modelCheck?: ModelContinuityCheck;
  readonly log?: (record: ContinuityLogRecord) => void;
};

const LEAKABLE_KINDS: readonly ClaimKind[] = ['name', 'place', 'secret', 'description', 'relationship'];
const SENTENCE_BREAK = /(?<=[.!?])\s+|\n+/;
const REGEX_SPECIALS = /[.*+?^${}()|[\]\\]/g;
const ESCAPED_MATCH = '\\$&';
const NO_LENGTH = 0;
const SPACE_RUN = / {2,}/g;
const NON_WORD = /\W+/;
const MIN_SHARED_WORD_LENGTH = 4;
const SEPARATOR = ' ';
const NOTE_SEPARATOR = '\n';
const ACTING_VERBS =
  'says?|said|speaks?|spoke|replies|replied|asks?|asked|whispers?|whispered|shouts?|shouted|laughs?|laughed|smiles?|smiled|nods?|nodded|walks?|walked|enters?|entered|grabs?|grabbed|draws?|drew|turns?|turned|steps?|stepped|opens?|opened|waves?|waved';
const USE_VERBS =
  'draws?|drew|wields?|wielded|swings?|swung|brandish(?:es|ed)?|uses?|used|raises?|raised|pulls?|pulled|unsheathes?|unsheathed|holds?|held|hands?|handed|fires?|fired|throws?|threw|lifts?|lifted|grips?|gripped';
const DEATH_CONTEXT =
  /\b(?:dead|died|death|corpse|body|grave|buried|funeral|late|remains|killed|slain|ghost|memory)\b/i;
const ACTS_AFTER = (name: string) => new RegExp(`\\b${escaped(name)}\\b[^.!?]*\\b(?:${ACTING_VERBS})\\b`, 'i');
const USES_ITEM = new RegExp(`\\b(?:${USE_VERBS})\\b`, 'i');

function escaped(text: string): string {
  return text.replace(REGEX_SPECIALS, ESCAPED_MATCH);
}

const mentions = (sentence: string, name: string): boolean =>
  name.trim() !== '' && new RegExp(`\\b${escaped(name)}\\b`, 'i').test(sentence);

const conflict = (
  kind: ContinuityConflictKind,
  entry: LedgerEntry,
  fact: string,
  excerpt: string,
  hidden: boolean,
): ContinuityConflict => ({ kind, entityId: entry.entityId, fact, excerpt, hidden });

const sentencesOf = (narration: string) => narration.split(SENTENCE_BREAK).filter((s) => s.length > NO_LENGTH);

export const checkContinuity = ({ narration, ledger, directory }: ContinuityCheckInput): ContinuityConflict[] => {
  const current = currentEntries(ledger);
  const seen = visibleLedger(ledger, PLAYER_VIEWER);
  const nameFor = (entry: LedgerEntry) => nameOf(ledger, directory, entry.entityId);
  const found: ContinuityConflict[] = [];
  const staleOf = (entry: LedgerEntry, source: Ledger) =>
    source.filter(
      (old) =>
        old.supersededBy !== null &&
        old.entityId === entry.entityId &&
        old.kind === entry.kind &&
        old.key === entry.key &&
        normalize(old.value) !== normalize(entry.value),
    );
  const hidden = new Set(
    ledger.filter((entry) => !visibleTo([entry], PLAYER_VIEWER).length).map(({ eventId }) => eventId),
  );
  const seenCurrent = currentEntries(seen);
  const sameSlot = (a: LedgerEntry, b: LedgerEntry) =>
    a.entityId === b.entityId && a.kind === b.kind && a.key === b.key;
  const playerValues = new Set(seenCurrent.map(({ value }) => normalize(value)));
  const checkEntry = (sentence: string, entry: LedgerEntry, source: Ledger, isHidden: boolean) => {
    const name = nameOf(isHidden ? ledger : seen, directory, entry.entityId);
    const fact = factLine(entry, name);
    if (entry.kind === 'alive' && entry.value === 'dead') {
      if (ACTS_AFTER(name).test(sentence) && !DEATH_CONTEXT.test(sentence))
        found.push(conflict('dead-acts', entry, fact, sentence, isHidden));
    } else if (entry.kind === 'item' && entry.value === 'not-held') {
      if (mentions(sentence, name) && mentions(sentence, entry.key) && USES_ITEM.test(sentence))
        found.push(conflict('item-not-held', entry, fact, sentence, isHidden));
    } else if (entry.kind === 'name' || entry.kind === 'place') {
      const stale = staleOf(entry, source).some(({ value }) => mentions(sentence, value));
      const about = entry.kind === 'name' || mentions(sentence, name);
      if (stale && about && !mentions(sentence, entry.value))
        found.push(conflict(entry.kind === 'name' ? 'stale-name' : 'wrong-place', entry, fact, sentence, isHidden));
    }
  };
  for (const sentence of sentencesOf(narration)) {
    for (const entry of current) {
      const isHidden = hidden.has(entry.eventId);
      if (isHidden && LEAKABLE_KINDS.includes(entry.kind) && !playerValues.has(normalize(entry.value))) {
        if (mentions(normalize(sentence), normalize(entry.value)))
          found.push(conflict('secret-leak', entry, factLine(entry, nameFor(entry)), sentence, true));
      }
      const shown = isHidden ? seenCurrent.find((other) => sameSlot(other, entry)) : undefined;
      if (shown !== undefined) checkEntry(sentence, shown, seen, false);
      else if (!isHidden) checkEntry(sentence, entry, ledger, false);
      else checkEntry(sentence, entry, ledger, true);
    }
  }
  return found;
};

const detect = async (input: ContinuityCheckInput, modelCheck: ModelContinuityCheck | undefined) => {
  const deterministic = checkContinuity(input);
  if (modelCheck === undefined) return deterministic;
  const seen = visibleLedger(input.ledger, PLAYER_VIEWER);
  const shown = new Set(seen.map(({ eventId }) => eventId));
  const lineOf = (entry: LedgerEntry) =>
    factLine(entry, nameOf(shown.has(entry.eventId) ? seen : input.ledger, input.directory, entry.entityId));
  const playerCurrent = currentEntries(seen);
  const facts = currentEntries(input.ledger).map((entry) =>
    lineOf(
      shown.has(entry.eventId)
        ? entry
        : (playerCurrent.find(
            (other) => other.entityId === entry.entityId && other.kind === entry.kind && other.key === entry.key,
          ) ?? entry),
    ),
  );
  const playerFacts = new Set(
    currentEntries(seen).map((entry) => factLine(entry, nameOf(seen, input.directory, entry.entityId))),
  );
  try {
    const modelFound = await modelCheck({ narration: input.narration, facts });
    return [...deterministic, ...modelFound.map((found) => ({ ...found, hidden: !playerFacts.has(found.fact) }))];
  } catch {
    return deterministic;
  }
};

const sentencesAround = (text: string, excerpt: string, cut: boolean): string[] => {
  if (excerpt === '') return [];
  const sentences = sentencesOf(text);
  const exact = sentences.filter((sentence) => sentence.includes(excerpt));
  if (exact.length > NO_LENGTH || !cut) return exact;
  const words = excerpt
    .toLowerCase()
    .split(NON_WORD)
    .filter((word) => word.length >= MIN_SHARED_WORD_LENGTH);
  return sentences.filter((sentence) => words.some((word) => sentence.toLowerCase().includes(word)));
};

const canonical = (narration: string, conflicts: readonly ContinuityConflict[]): string => {
  let text = narration;
  for (const { kind, fact, excerpt, hidden } of conflicts) {
    const cut = hidden === true || kind === 'secret-leak';
    const replacement = cut ? '' : `(${fact})`;
    const around = sentencesAround(text, excerpt, cut);
    for (const sentence of around) text = text.replace(sentence, replacement);
    if (around.length === NO_LENGTH && !cut) text = `${text}${NOTE_SEPARATOR}${replacement}`;
  }
  return text
    .split(NOTE_SEPARATOR)
    .map((line) => line.replace(SPACE_RUN, SEPARATOR).trim())
    .join(NOTE_SEPARATOR)
    .trim();
};

export const enforceContinuity = async (run: ContinuityRun): Promise<ContinuityOutcome> => {
  const { ledger, directory, modelCheck } = run;
  let narration = await run.generate([]);
  let conflicts = await detect({ narration, ledger, directory }, modelCheck);
  const first = conflicts;
  let regenerations = 0;
  while (conflicts.length > NO_LENGTH && regenerations < MAX_CONTINUITY_RETRIES) {
    regenerations += 1;
    narration = await run.generate(conflicts);
    conflicts = await detect({ narration, ledger, directory }, modelCheck);
  }
  const resolved = conflicts.length === NO_LENGTH;
  if (first.length > NO_LENGTH) run.log?.({ conflicts: first, regenerations, resolved });
  return {
    narration: resolved ? narration : canonical(narration, conflicts),
    conflicts,
    regenerations,
    resolved,
  };
};
