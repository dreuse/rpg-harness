import { CHARS_PER_TOKEN, estimateTokens } from './retrieval.ts';

export const CONTEXT_BUDGETS = { compact: 2_000, standard: 6_000, rich: 16_000 } as const;
export type ContextBudgetPreset = keyof typeof CONTEXT_BUDGETS;
export const DEFAULT_CONTEXT_BUDGET: ContextBudgetPreset = 'standard';
export const RECENT_TURN_LIMIT = 6;
export const REQUIRED_SECTION_CAPS = {
  instructions: 4_000,
  ruleset: 1_200,
  setting: 800,
  style: 600,
  results: 2_000,
  playerInput: 1_500,
} as const;

export const STABLE_SECTIONS = [
  'instructions',
  'ruleset',
  'setting',
  'style',
  'campaignSummary',
  'chapterSummaries',
] as const;
export const VARIABLE_SECTIONS = [
  'sceneSummaries',
  'context',
  'ledger',
  'threads',
  'entities',
  'recentTurns',
  'recentClosings',
  'results',
  'playerInput',
] as const;
export type SectionName = (typeof STABLE_SECTIONS)[number] | (typeof VARIABLE_SECTIONS)[number];

export type PacketInput = { readonly [Name in SectionName]: readonly string[] };

export type PacketSection = { readonly name: SectionName; readonly stable: boolean; readonly items: readonly string[] };

export type ContextPacket = {
  readonly sections: readonly PacketSection[];
  readonly budget: number;
  readonly usedTokens: number;
  readonly requiredExceedsBudget: boolean;
  readonly truncated: number;
};

const DATA_OPEN = '<campaign-data>';
const DATA_CLOSE = '</campaign-data>';
const ANGLE_BRACKET = /</g;
const ESCAPED_ANGLE_BRACKET = '\\u003c';
const SECTION_SEPARATOR = '\n';
const INSTRUCTION_SEPARATOR = ' ';
const ITEM_SEPARATOR = ',';
const NO_TOKENS = 0;
const INSTRUCTIONS: SectionName = 'instructions';
const REQUIRED: readonly SectionName[] = ['instructions', 'ruleset', 'setting', 'style', 'results', 'playerInput'];
const LEDGER: SectionName = 'ledger';
const STABLE_FILL: readonly SectionName[] = ['campaignSummary', 'chapterSummaries'];
const VARIABLE_FILL: readonly SectionName[] = [
  'recentClosings',
  'recentTurns',
  'threads',
  'entities',
  'context',
  'sceneSummaries',
];
const BUDGET_CAP_SHARES = { results: 0.25, playerInput: 0.2 } as const;
const MIN_SHARED_CAP = 400;
const STABLE_SUMMARY_SHARE = 0.3;
const NEWEST_FIRST: readonly SectionName[] = ['campaignSummary', 'recentTurns', 'sceneSummaries', 'chapterSummaries'];
const STABLE: readonly SectionName[] = STABLE_SECTIONS;
const CAP_SHRINK = 0.9;
const SECTION_LIMITS: Partial<Record<SectionName, number>> = { campaignSummary: 1, recentTurns: RECENT_TURN_LIMIT };

export const encoded = (data: unknown) => JSON.stringify(data).replace(ANGLE_BRACKET, ESCAPED_ANGLE_BRACKET);

export const frameData = (data: unknown): string => `${DATA_OPEN}${encoded(data)}${DATA_CLOSE}`;

const dataOf = (sections: readonly PacketSection[]) =>
  Object.fromEntries(sections.filter(({ name }) => name !== INSTRUCTIONS).map(({ name, items }) => [name, items]));

export const packetParts = ({ sections }: Pick<ContextPacket, 'sections'>) => ({
  instructions: sections
    .filter(({ name }) => name === INSTRUCTIONS)
    .flatMap(({ items }) => items)
    .join(INSTRUCTION_SEPARATOR),
  stable: frameData(dataOf(sections.filter(({ stable }) => stable))),
  variable: frameData(dataOf(sections.filter(({ stable }) => !stable))),
});

export const packetText = (packet: Pick<ContextPacket, 'sections'>): string => {
  const { instructions, stable, variable } = packetParts(packet);
  return [instructions, stable, variable].join(SECTION_SEPARATOR);
};

const ORDER: readonly SectionName[] = [...STABLE_SECTIONS, ...VARIABLE_SECTIONS];

const emptySections = (): PacketSection[] => ORDER.map((name) => ({ name, stable: STABLE.includes(name), items: [] }));

const OVERHEAD = estimateTokens(packetText({ sections: emptySections() }));

const costOf = (name: SectionName, item: string) =>
  name === INSTRUCTIONS
    ? estimateTokens(`${item}${INSTRUCTION_SEPARATOR}`)
    : estimateTokens(`${encoded(item)}${ITEM_SEPARATOR}`);

const LAST_CHAR = -1;
const HIGH_SURROGATE = /[\uD800-\uDBFF]/;

export const sliced = (text: string, length: number) => {
  const head = text.slice(NO_TOKENS, length);
  return HIGH_SURROGATE.test(head.slice(LAST_CHAR)) ? head.slice(NO_TOKENS, LAST_CHAR) : head;
};

const shortened = (name: SectionName, item: string, cap: number) => {
  let text = sliced(item, cap * CHARS_PER_TOKEN);
  while (text !== '' && costOf(name, text) > cap) text = sliced(text, Math.floor(text.length * CAP_SHRINK));
  return text;
};

const capped = (name: SectionName, items: readonly string[], cap: number) => {
  const kept: string[] = [];
  let cost = NO_TOKENS;
  for (const item of items) {
    const itemCost = costOf(name, item);
    if (cost + itemCost <= cap) kept.push(item);
    else {
      if (kept.length === NO_TOKENS) kept.push(shortened(name, item, cap));
      break;
    }
    cost += itemCost;
  }
  return kept;
};

const select = (name: SectionName, items: readonly string[], allowance: number) => {
  const indexed = items.map((item, index) => ({ item, index }));
  const newestFirst = NEWEST_FIRST.includes(name);
  const limit = SECTION_LIMITS[name] ?? indexed.length;
  const kept = new Set<number>();
  let cost = NO_TOKENS;
  let full = false;
  for (const [position, { item, index }] of (newestFirst ? indexed.reverse() : indexed).entries()) {
    const itemCost = costOf(name, item);
    full ||= position >= limit || (newestFirst && cost + itemCost > allowance);
    if (!full && cost + itemCost <= allowance) {
      kept.add(index);
      cost += itemCost;
    }
  }
  return { kept, cost };
};

const sectionCost = (name: SectionName, items: readonly string[]) =>
  items.reduce((sum, item) => sum + costOf(name, item), NO_TOKENS);

const sharedCapOf = (name: keyof typeof BUDGET_CAP_SHARES, budget: number) =>
  Math.min(REQUIRED_SECTION_CAPS[name], Math.max(MIN_SHARED_CAP, Math.floor(budget * BUDGET_CAP_SHARES[name])));

export const buildContextPacket = (whole: PacketInput, budget: number): ContextPacket => {
  if (!Number.isInteger(budget) || budget < NO_TOKENS) throw new RangeError(`invalid token budget ${budget}`);
  const input: { -readonly [Name in SectionName]: readonly string[] } = { ...whole };
  let capTruncated = NO_TOKENS;
  const cappedNames = Object.keys(REQUIRED_SECTION_CAPS) as (keyof typeof REQUIRED_SECTION_CAPS)[];
  for (const name of cappedNames) input[name] = capped(name, whole[name], REQUIRED_SECTION_CAPS[name]);
  const requiredCost = () =>
    [...REQUIRED, LEDGER].reduce((sum, name) => sum + sectionCost(name, input[name]), OVERHEAD);
  if (requiredCost() > budget)
    for (const name of Object.keys(BUDGET_CAP_SHARES) as (keyof typeof BUDGET_CAP_SHARES)[])
      input[name] = capped(name, input[name], sharedCapOf(name, budget));
  for (const name of cappedNames)
    capTruncated += whole[name].length - input[name].length + Number(whole[name][0] !== input[name][0]);
  const kept = new Map<SectionName, Set<number>>(ORDER.map((name) => [name, new Set()]));
  let usedTokens = OVERHEAD;
  for (const name of REQUIRED) {
    input[name].forEach((item, index) => {
      kept.get(name)?.add(index);
      usedTokens += costOf(name, item);
    });
  }
  let ledgerStart = NO_TOKENS;
  let ledgerCost = sectionCost(LEDGER, input[LEDGER]);
  while (ledgerStart < input[LEDGER].length && usedTokens + ledgerCost > budget) {
    ledgerCost -= costOf(LEDGER, input[LEDGER][ledgerStart] ?? '');
    ledgerStart += 1;
  }
  input[LEDGER].forEach((_, index) => {
    if (index >= ledgerStart) kept.get(LEDGER)?.add(index);
  });
  usedTokens += ledgerCost;
  const requiredExceedsBudget = usedTokens > budget;
  const room = () => Math.max(budget - usedTokens, NO_TOKENS);
  let stableRoom = Math.min(Math.floor(budget * STABLE_SUMMARY_SHARE), room());
  let truncated = capTruncated + ledgerStart;
  const fill = (name: SectionName, allowance: number) => {
    const selected = select(name, input[name], allowance);
    kept.set(name, selected.kept);
    usedTokens += selected.cost;
    truncated += input[name].length - selected.kept.size;
    return selected.cost;
  };
  for (const name of STABLE_FILL) stableRoom -= fill(name, stableRoom);
  for (const name of VARIABLE_FILL) fill(name, room());
  return {
    sections: ORDER.map((name) => ({
      name,
      stable: STABLE.includes(name),
      items: input[name].filter((_, index) => kept.get(name)?.has(index)),
    })),
    budget,
    usedTokens,
    requiredExceedsBudget,
    truncated,
  };
};
