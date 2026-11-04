import type { ProfileTrait, ProfileTraitValue, RulePackLink } from '../../domain/src/character.ts';
import type { SheetField, SheetProvenance, SheetSchema, WidgetType } from '../../rules/src/sheet-schema.ts';
import type { ExtractedBlock, Extraction } from './extraction.ts';
import type { ExtractionQuality, Provenance } from './provenance.ts';
import { type ImportedData, interpretImported, type UntrustedContent, wrapUntrusted } from './untrusted.ts';

export const MECHANICAL_WIDGETS: readonly WidgetType[] = ['number', 'resource', 'toggle', 'choice'];
export const AMBIGUOUS_QUALITIES: readonly ExtractionQuality[] = ['low', 'unknown'];
export const FICHA_REASONS = ['missing', 'low_confidence', 'invalid_value', 'conflicting_values'] as const;
export const FICHA_ISSUE_CODES = ['unresolved', 'invalid_resolution', 'unknown_field', 'duplicate_resolution'] as const;

const TRUE_WORDS = ['true', 'yes', 'x', 'on'];
const FALSE_WORDS = ['false', 'no', 'off'];
const NUMBER = /^[+-]?\d+(\.\d+)?$/;
const KEY_VALUE_LINE = /^\s*([^:=]+?)\s*[:=]\s*(.*?)\s*$/;
const LINE_BREAK = /\r?\n/;
const WHITESPACE = /\s+/g;
const KEY_CELL = 0;
const VALUE_CELL = 1;
const EXTRA_CELLS = 2;
const RESOLUTION_KINDS: readonly string[] = ['set', 'leave_empty'];

export type FichaReason = (typeof FICHA_REASONS)[number];
export type FichaIssueCode = (typeof FICHA_ISSUE_CODES)[number];
export type FichaCandidate = { readonly source: ImportedData; readonly value: ProfileTraitValue | null };
export type FichaEntry = {
  readonly field: SheetField;
  readonly status: 'mapped' | 'empty' | 'needs_resolution';
  readonly value: ProfileTraitValue | null;
  readonly reasons: readonly FichaReason[];
  readonly candidates: readonly FichaCandidate[];
};
export type FichaDraft = {
  readonly status: 'draft';
  readonly sourceId: string;
  readonly complete: boolean;
  readonly rulepack: SheetProvenance;
  readonly needsResolution: boolean;
  readonly entries: readonly FichaEntry[];
  readonly unrecognized: readonly ImportedData[];
};

export type FichaResolution =
  | { readonly fieldId: string; readonly kind: 'set'; readonly value: ProfileTraitValue }
  | { readonly fieldId: string; readonly kind: 'leave_empty' };
export type FichaOrigin = 'extracted' | 'empty' | 'user_set' | 'user_left_empty';
export type FichaProposal = {
  readonly kind: 'ficha_import';
  readonly sourceId: string;
  readonly rulepack: RulePackLink;
  readonly traits: readonly ProfileTrait[];
  readonly origins: readonly { fieldId: string; origin: FichaOrigin; sources: readonly Provenance[] }[];
  readonly unrecognized: readonly ImportedData[];
};
export type FichaIssue = { readonly fieldId: string; readonly code: FichaIssueCode };
export type FichaAcceptance = { ok: true; proposal: FichaProposal } | { ok: false; issues: FichaIssue[] };

type Pair = { key: string; value: UntrustedContent };

const normalize = (text: string) => text.trim().replace(WHITESPACE, ' ').toLowerCase();

const parseText = (field: SheetField, raw: string): ProfileTraitValue | null => {
  const text = raw.trim();
  const word = normalize(text);
  if (field.widget === 'number' || field.widget === 'resource') {
    const number = Number(text);
    return NUMBER.test(text) && Number.isFinite(number) ? number : null;
  }
  if (field.widget === 'toggle') {
    if (TRUE_WORDS.includes(word)) return true;
    return FALSE_WORDS.includes(word) ? false : null;
  }
  if (field.widget === 'choice') return field.options?.find((option) => normalize(option) === word) ?? null;
  return text;
};

const isValidValue = (field: SheetField, value: ProfileTraitValue) => {
  if (field.widget === 'number' || field.widget === 'resource')
    return typeof value === 'number' && Number.isFinite(value);
  if (field.widget === 'toggle') return typeof value === 'boolean';
  if (field.widget === 'choice') return typeof value === 'string' && (field.options ?? []).includes(value);
  return typeof value === 'string';
};

const blockPairs = (block: ExtractedBlock, unrecognized: UntrustedContent[]): Pair[] => {
  if (block.type === 'table')
    return block.rows.flatMap((row) => {
      const [key, value] = [row[KEY_CELL], row[VALUE_CELL]];
      if (key && value) {
        unrecognized.push(...row.slice(EXTRA_CELLS).filter((cell) => cell.text.trim()));
        return [{ key: key.text, value }];
      }
      unrecognized.push(...row.filter((cell) => cell.text.trim()));
      return [];
    });
  const { provenance } = block.content;
  return block.content.text.split(LINE_BREAK).flatMap((line) => {
    const match = KEY_VALUE_LINE.exec(line);
    if (match?.[1] && match[2] !== undefined) return [{ key: match[1], value: wrapUntrusted(match[2], provenance) }];
    if (line.trim()) unrecognized.push(wrapUntrusted(line, provenance));
    return [];
  });
};

const reasonsFor = (field: SheetField, candidates: readonly FichaCandidate[]): FichaReason[] => {
  if (candidates.length === 0) return MECHANICAL_WIDGETS.includes(field.widget) ? ['missing'] : [];
  const distinct = new Set(candidates.map(({ value }) => value));
  return [
    ...(candidates.some(({ source }) => AMBIGUOUS_QUALITIES.includes(source.provenance.quality))
      ? ['low_confidence' as const]
      : []),
    ...(distinct.has(null) ? ['invalid_value' as const] : []),
    ...(distinct.size > 1 ? ['conflicting_values' as const] : []),
  ];
};

const entryFor = (field: SheetField, candidates: FichaCandidate[]): FichaEntry => {
  const reasons = reasonsFor(field, candidates);
  const status = reasons.length > 0 ? 'needs_resolution' : candidates.length > 0 ? 'mapped' : 'empty';
  const value = status === 'mapped' ? (candidates[0]?.value ?? null) : null;
  return { field, status, value, reasons, candidates };
};

export const draftFicha = (schema: SheetSchema, extraction: Extraction): FichaDraft => {
  const leftover: UntrustedContent[] = [];
  const pairs = extraction.pages.flatMap((page) => page.blocks.flatMap((block) => blockPairs(block, leftover)));
  const fields = schema.fields.filter((field) => !field.derived);
  const fieldFor = (key: string) =>
    fields.find((field) => [field.id, field.label].some((name) => name !== undefined && normalize(name) === key));
  const candidates = new Map<SheetField, FichaCandidate[]>(fields.map((field) => [field, []]));
  for (const { key, value } of pairs) {
    const field = fieldFor(normalize(key));
    if (!field) leftover.push(wrapUntrusted(`${key}: ${value.text}`, value.provenance));
    else if (value.text.trim())
      candidates.get(field)?.push({ source: interpretImported(value), value: parseText(field, value.text) });
  }
  const entries = fields.map((field) => entryFor(field, candidates.get(field) ?? []));
  return {
    status: 'draft',
    sourceId: extraction.sourceId,
    complete: extraction.complete,
    rulepack: structuredClone(schema.rulepack),
    needsResolution: entries.some((entry) => entry.status === 'needs_resolution'),
    entries,
    unrecognized: leftover.map(interpretImported),
  };
};

const resolutionIssues = (draft: FichaDraft, resolutions: readonly FichaResolution[]): FichaIssue[] => {
  const seen = new Set<string>();
  const issues = resolutions.flatMap((resolution): FichaIssue[] => {
    const { fieldId } = resolution;
    const field = draft.entries.find((entry) => entry.field.id === fieldId)?.field;
    const duplicate = seen.has(fieldId);
    seen.add(fieldId);
    if (!field) return [{ fieldId, code: 'unknown_field' }];
    if (duplicate) return [{ fieldId, code: 'duplicate_resolution' }];
    if (!RESOLUTION_KINDS.includes(resolution.kind)) return [{ fieldId, code: 'invalid_resolution' }];
    if (resolution.kind === 'set' && !isValidValue(field, resolution.value))
      return [{ fieldId, code: 'invalid_resolution' }];
    return [];
  });
  const unresolved = draft.entries
    .filter((entry) => entry.status === 'needs_resolution' && !seen.has(entry.field.id))
    .map((entry): FichaIssue => ({ fieldId: entry.field.id, code: 'unresolved' }));
  const invalidMapped = draft.entries
    .filter(({ field, value }) => !seen.has(field.id) && value !== null && !isValidValue(field, value))
    .map((entry): FichaIssue => ({ fieldId: entry.field.id, code: 'invalid_resolution' }));
  return [...issues, ...unresolved, ...invalidMapped];
};

export const acceptFicha = (draft: FichaDraft, resolutions: readonly FichaResolution[]): FichaAcceptance => {
  const issues = resolutionIssues(draft, resolutions);
  if (issues.length > 0) return { ok: false, issues };
  const resolved = new Map(resolutions.map((resolution) => [resolution.fieldId, resolution]));
  const decided = draft.entries.map((entry) => {
    const resolution = resolved.get(entry.field.id);
    const sources = entry.candidates.map(({ source }) => source.provenance);
    if (resolution?.kind === 'set') return { entry, value: resolution.value, origin: 'user_set' as const, sources };
    if (resolution) return { entry, value: null, origin: 'user_left_empty' as const, sources };
    return { entry, value: entry.value, origin: entry.value === null ? 'empty' : 'extracted', sources } as const;
  });
  const { id, edition, revision } = draft.rulepack;
  return {
    ok: true,
    proposal: {
      kind: 'ficha_import',
      sourceId: draft.sourceId,
      rulepack: { id, edition, revision },
      traits: decided.flatMap(({ entry, value }) => (value === null ? [] : [{ id: entry.field.id, value }])),
      origins: decided.map(({ entry, origin, sources }) => ({ fieldId: entry.field.id, origin, sources })),
      unrecognized: draft.unrecognized,
    },
  };
};
