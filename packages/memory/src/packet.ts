import { estimateTokens } from './retrieval.ts';

export const CONTEXT_BUDGETS = { compact: 2_000, standard: 6_000, rich: 16_000 } as const;
export type ContextBudgetPreset = keyof typeof CONTEXT_BUDGETS;
export const DEFAULT_CONTEXT_BUDGET: ContextBudgetPreset = 'standard';
export const RECENT_TURN_LIMIT = 6;

export const STABLE_SECTIONS = ['instructions', 'ruleset', 'setting', 'campaignSummary', 'chapterSummaries'] as const;
export const VARIABLE_SECTIONS = [
  'sceneSummaries',
  'context',
  'threads',
  'entities',
  'recentTurns',
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
const REQUIRED: readonly SectionName[] = ['instructions', 'ruleset', 'setting', 'results', 'playerInput'];
const STABLE_FILL: readonly SectionName[] = ['campaignSummary', 'chapterSummaries'];
const VARIABLE_FILL: readonly SectionName[] = ['recentTurns', 'threads', 'entities', 'context', 'sceneSummaries'];
const STABLE_SUMMARY_SHARE = 0.3;
const NEWEST_FIRST: readonly SectionName[] = ['campaignSummary', 'recentTurns', 'sceneSummaries', 'chapterSummaries'];
const STABLE: readonly SectionName[] = STABLE_SECTIONS;
const SECTION_LIMITS: Partial<Record<SectionName, number>> = { campaignSummary: 1, recentTurns: RECENT_TURN_LIMIT };

const encoded = (data: unknown) => JSON.stringify(data).replace(ANGLE_BRACKET, ESCAPED_ANGLE_BRACKET);

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

export const buildContextPacket = (input: PacketInput, budget: number): ContextPacket => {
  if (!Number.isInteger(budget) || budget < NO_TOKENS) throw new RangeError(`invalid token budget ${budget}`);
  const kept = new Map<SectionName, Set<number>>(ORDER.map((name) => [name, new Set()]));
  let usedTokens = OVERHEAD;
  for (const name of REQUIRED) {
    input[name].forEach((item, index) => {
      kept.get(name)?.add(index);
      usedTokens += costOf(name, item);
    });
  }
  const requiredExceedsBudget = usedTokens > budget;
  const room = () => Math.max(budget - usedTokens, NO_TOKENS);
  let stableRoom = Math.min(Math.floor(budget * STABLE_SUMMARY_SHARE), room());
  let truncated = NO_TOKENS;
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
