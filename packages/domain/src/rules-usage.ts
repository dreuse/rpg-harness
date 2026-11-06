export const RESOLUTION_STYLES = ['dice', 'adjudicated', 'deterministic'] as const;
export const SHEET_USAGES = ['none', 'description', 'full'] as const;

export type ResolutionStyle = (typeof RESOLUTION_STYLES)[number];
export type SheetUsage = (typeof SHEET_USAGES)[number];
export type RulesUsage = { readonly resolution: ResolutionStyle; readonly sheet: SheetUsage };

export const DEFAULT_RULES_USAGE: RulesUsage = { resolution: 'dice', sheet: 'full' };

export const usesDice = ({ resolution }: RulesUsage) => resolution === 'dice';
export const usesSheet = ({ sheet }: RulesUsage) => sheet === 'full';

export const RULES_STRICTNESSES = ['as-written', 'relaxed', 'off'] as const;
export type RulesStrictness = (typeof RULES_STRICTNESSES)[number];

export const DEFAULT_RULES_STRICTNESS: RulesStrictness = 'as-written';
const NO_RULEPACK_STRICTNESS: RulesStrictness = 'off';

export const isRulesStrictness = (value: unknown): value is RulesStrictness =>
  RULES_STRICTNESSES.some((known) => known === value);

export const rulesStrictnessOf = (chosen: RulesStrictness | undefined, hasRulePack: boolean): RulesStrictness =>
  chosen ?? (hasRulePack ? DEFAULT_RULES_STRICTNESS : NO_RULEPACK_STRICTNESS);

export const MAX_RULES_DOCUMENTS = 20;
export const MAX_RULES_NAME_LENGTH = 200;
