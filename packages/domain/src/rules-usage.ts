export const RESOLUTION_STYLES = ['dice', 'adjudicated', 'deterministic'] as const;
export const SHEET_USAGES = ['none', 'description', 'full'] as const;

export type ResolutionStyle = (typeof RESOLUTION_STYLES)[number];
export type SheetUsage = (typeof SHEET_USAGES)[number];
export type RulesUsage = { readonly resolution: ResolutionStyle; readonly sheet: SheetUsage };

export const DEFAULT_RULES_USAGE: RulesUsage = { resolution: 'dice', sheet: 'full' };

export const usesDice = ({ resolution }: RulesUsage) => resolution === 'dice';
export const usesSheet = ({ sheet }: RulesUsage) => sheet === 'full';
