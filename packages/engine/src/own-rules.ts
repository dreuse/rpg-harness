import { type CampaignEvent, RULES_DOCUMENT_ADDED } from '../../domain/src/campaign.ts';
import { MAX_RULES_DOCUMENTS, MAX_RULES_NAME_LENGTH } from '../../domain/src/rules-usage.ts';
import { type Style, toStyle } from '../../domain/src/style.ts';
import type { CondensedRules } from '../../memory/src/rules.ts';

export { MAX_RULES_DOCUMENTS };
export const MAX_RULES_DOCUMENT_CHARS = 200_000;
export const MAX_CONDENSED_SECTIONS = 500;
const CONDENSED_CHARS_FACTOR = 2;
const SHA256_HEX = /^[0-9a-f]{64}$/;
export const SETTING_DOCUMENT_KIND = 'setting';
const DOCUMENT_KINDS = ['rules', SETTING_DOCUMENT_KIND] as const;

export type RulesDocument = {
  readonly name: string;
  readonly format: string;
  readonly sourceHash: string;
  readonly text: string;
  readonly style?: Style;
  readonly kind?: (typeof DOCUMENT_KINDS)[number];
  readonly condensed?: CondensedRules;
};

export const isCondensed = (value: unknown): value is CondensedRules => {
  if (typeof value !== 'object' || value === null) return false;
  const { summary, sections } = value as Record<string, unknown>;
  if (typeof summary !== 'string' || !Array.isArray(sections) || sections.length > MAX_CONDENSED_SECTIONS) return false;
  let chars = summary.length;
  for (const section of sections) {
    const { title, text } = (section ?? {}) as Record<string, unknown>;
    if (typeof title !== 'string' || typeof text !== 'string') return false;
    chars += title.length + text.length;
  }
  return chars <= MAX_RULES_DOCUMENT_CHARS * CONDENSED_CHARS_FACTOR;
};

export const isRulesDocument = (value: unknown): value is RulesDocument => {
  if (typeof value !== 'object' || value === null) return false;
  const { name, format, sourceHash, text, style, kind } = value as Record<string, unknown>;
  return (
    typeof name === 'string' &&
    name.trim() !== '' &&
    name.length <= MAX_RULES_NAME_LENGTH &&
    typeof format === 'string' &&
    typeof sourceHash === 'string' &&
    SHA256_HEX.test(sourceHash) &&
    typeof text === 'string' &&
    text.trim() !== '' &&
    text.length <= MAX_RULES_DOCUMENT_CHARS &&
    (style === undefined || toStyle(style) !== undefined) &&
    (kind === undefined || DOCUMENT_KINDS.includes(kind as (typeof DOCUMENT_KINDS)[number]))
  );
};

const withValidCondensed = ({ condensed, ...document }: RulesDocument): RulesDocument =>
  isCondensed(condensed) ? { ...document, condensed } : document;

const importedDocumentsOf = (events: readonly Pick<CampaignEvent, 'type' | 'payload'>[]): readonly RulesDocument[] =>
  events
    .filter(({ type }) => type === RULES_DOCUMENT_ADDED)
    .flatMap(({ payload }) => (isRulesDocument(payload.document) ? [withValidCondensed(payload.document)] : []));

export const rulesDocumentsOf = (
  events: readonly Pick<CampaignEvent, 'type' | 'payload'>[],
): readonly RulesDocument[] => importedDocumentsOf(events).filter(({ kind }) => kind !== SETTING_DOCUMENT_KIND);

export const settingDocumentsOf = (
  events: readonly Pick<CampaignEvent, 'type' | 'payload'>[],
): readonly RulesDocument[] => importedDocumentsOf(events).filter(({ kind }) => kind === SETTING_DOCUMENT_KIND);

export const usesOwnRules = (events: readonly Pick<CampaignEvent, 'type' | 'payload'>[]): boolean =>
  rulesDocumentsOf(events).length > 0;
