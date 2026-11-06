import { type CampaignEvent, RULES_DOCUMENT_ADDED } from '../../domain/src/campaign.ts';
import { MAX_RULES_DOCUMENTS, MAX_RULES_NAME_LENGTH } from '../../domain/src/rules-usage.ts';

export { MAX_RULES_DOCUMENTS };
export const MAX_RULES_DOCUMENT_CHARS = 200_000;
const SHA256_HEX = /^[0-9a-f]{64}$/;

export type RulesDocument = {
  readonly name: string;
  readonly format: string;
  readonly sourceHash: string;
  readonly text: string;
};

export const isRulesDocument = (value: unknown): value is RulesDocument => {
  if (typeof value !== 'object' || value === null) return false;
  const { name, format, sourceHash, text } = value as Record<string, unknown>;
  return (
    typeof name === 'string' &&
    name.trim() !== '' &&
    name.length <= MAX_RULES_NAME_LENGTH &&
    typeof format === 'string' &&
    typeof sourceHash === 'string' &&
    SHA256_HEX.test(sourceHash) &&
    typeof text === 'string' &&
    text.trim() !== '' &&
    text.length <= MAX_RULES_DOCUMENT_CHARS
  );
};

export const rulesDocumentsOf = (
  events: readonly Pick<CampaignEvent, 'type' | 'payload'>[],
): readonly RulesDocument[] =>
  events
    .filter(({ type }) => type === RULES_DOCUMENT_ADDED)
    .flatMap(({ payload }) => (isRulesDocument(payload.document) ? [payload.document] : []));

export const usesOwnRules = (events: readonly Pick<CampaignEvent, 'type' | 'payload'>[]): boolean =>
  rulesDocumentsOf(events).length > 0;
