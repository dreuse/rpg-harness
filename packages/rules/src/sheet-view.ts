import type { CharacterProfile, ProfileTraitValue, ProfileVisibility } from '../../domain/src/character.ts';
import type { AppliedBonus, ConstraintResult, DerivedStats, StatConstraint } from './derived-stats.ts';
import { isRecord } from './rulepack.ts';
import {
  type SheetField,
  type SheetIssue,
  type SheetProvenance,
  type SheetSchema,
  validateSheetSchema,
  type WidgetType,
} from './sheet-schema.ts';

export const SHEET_GROUPS = ['core', 'custom', 'computed'] as const;
const GM_ONLY_PROFILE: ProfileVisibility = 'gm';

export type SheetGroupId = (typeof SHEET_GROUPS)[number];
export type SheetViewer = { role: 'gm' } | { role: 'player'; owner: boolean };
export type FieldEdit = {
  editable: boolean;
  base?: ProfileTraitValue | null;
  options?: string[];
  min?: number;
  max?: number;
};
export type SheetFieldView = {
  id: string;
  widget: WidgetType;
  label?: string;
  value: ProfileTraitValue | null;
  edit: FieldEdit;
};
export type SheetGroupView = { id: SheetGroupId; fields: SheetFieldView[] };
export type ComputedDescriptor = {
  field: string;
  expression?: string;
  refs: string[];
  bonuses: AppliedBonus[];
  constraints: ConstraintResult[];
};
export type SheetView = { rulepack: SheetProvenance; groups: SheetGroupView[]; computed: ComputedDescriptor[] };
export type SheetViewInput = {
  schema: SheetSchema;
  profile: CharacterProfile;
  stats: DerivedStats;
  constraints?: StatConstraint[];
  visibility: ProfileVisibility;
  viewer: SheetViewer;
};

const isGm = (viewer: SheetViewer) => viewer.role === 'gm';
const isOwner = (viewer: SheetViewer) => viewer.role === 'gm' || viewer.owner;

const canSee = (viewer: SheetViewer, field: SheetField) => {
  if (field.visibility === 'hidden') return false;
  if (field.visibility === 'gm') return isGm(viewer);
  return field.visibility === 'public' || isOwner(viewer);
};

const groupOf = (field: SheetField): SheetGroupId => {
  if (field.derived) return 'computed';
  return field.custom ? 'custom' : 'core';
};

const bonusSumOf = (id: string, stats: DerivedStats) =>
  stats.appliedBonuses.filter((bonus) => bonus.target === id).reduce((sum, bonus) => sum + bonus.amount, 0);

const statBaseOf = (id: string, stats: DerivedStats, bonusSum: number) => {
  if (!Object.hasOwn(stats.values, id)) return null;
  const raw = stats.constraints.find((result) => result.field === id)?.raw ?? stats.values[id];
  return (raw as number) - bonusSum;
};

const editOf = (
  field: SheetField,
  viewer: SheetViewer,
  constraints: StatConstraint[],
  stats: DerivedStats,
  trait: ProfileTraitValue | undefined,
): FieldEdit => {
  if (field.derived || !isOwner(viewer)) return { editable: false };
  const bonusSum = bonusSumOf(field.id, stats);
  const own = constraints.filter((constraint) => constraint.field === field.id);
  const mins = own.flatMap((constraint) => (constraint.min === undefined ? [] : [constraint.min - bonusSum]));
  const maxes = own.flatMap((constraint) => (constraint.max === undefined ? [] : [constraint.max - bonusSum]));
  return {
    editable: true,
    base: trait ?? statBaseOf(field.id, stats, bonusSum),
    ...(field.options ? { options: [...field.options] } : {}),
    ...(mins.length > 0 ? { min: Math.max(...mins) } : {}),
    ...(maxes.length > 0 ? { max: Math.min(...maxes) } : {}),
  };
};

const computedOf = (field: SheetField, stats: DerivedStats, visible: Set<string>): ComputedDescriptor[] => {
  const bonuses = stats.appliedBonuses.filter((bonus) => bonus.target === field.id).map((bonus) => ({ ...bonus }));
  const constraints = stats.constraints.filter((result) => result.field === field.id).map((result) => ({ ...result }));
  if (!field.derived && bonuses.length === 0 && constraints.length === 0) return [];
  const refs = field.derived?.refs ?? [];
  const shown = refs.filter((ref) => visible.has(ref));
  const expression = field.derived && shown.length === refs.length ? { expression: field.derived.expression } : {};
  return [{ field: field.id, ...expression, refs: shown, bonuses, constraints }];
};

export const buildSheetView = (input: SheetViewInput): SheetView => {
  const { schema, profile, stats, viewer } = input;
  const rulepack = structuredClone(schema.rulepack);
  if (input.visibility === GM_ONLY_PROFILE && !isGm(viewer)) return { rulepack, groups: [], computed: [] };
  const fields = schema.fields.filter((field) => canSee(viewer, field));
  const visible = new Set(fields.map((field) => field.id));
  const traits = new Map(profile.traits.map((trait) => [trait.id, trait.value]));
  const currentValue = (id: string) => (Object.hasOwn(stats.values, id) ? stats.values[id] : traits.get(id)) ?? null;
  const viewOf = (field: SheetField): SheetFieldView => ({
    id: field.id,
    widget: field.widget,
    ...(field.label === undefined ? {} : { label: field.label }),
    value: currentValue(field.id) as ProfileTraitValue | null,
    edit: editOf(field, viewer, input.constraints ?? [], stats, traits.get(field.id)),
  });
  const groups = SHEET_GROUPS.map((id) => ({
    id,
    fields: fields.filter((field) => groupOf(field) === id).map(viewOf),
  })).filter((group) => group.fields.length > 0);
  return { rulepack, groups, computed: fields.flatMap((field) => computedOf(field, stats, visible)) };
};

export const SHEET_EXPORT_FORMAT = 'rpg-sheet/1';

export type SheetExportEntry = { id: string; value: ProfileTraitValue | null; source: SheetGroupId };
export type SheetExport = { format: typeof SHEET_EXPORT_FORMAT; schema: SheetSchema; entries: SheetExportEntry[] };
export type SheetImportResult = { ok: true; sheet: SheetExport } | { ok: false; issues: SheetIssue[] };

const withoutHiddenRefs = (field: SheetField, shown: Set<string>): SheetField => {
  const { derived, ...rest } = field;
  return derived?.refs.every((ref) => shown.has(ref)) ? field : rest;
};

export const exportSheet = (input: SheetViewInput): SheetExport => {
  const view = buildSheetView(input);
  const values = new Map(view.groups.flatMap((group) => group.fields.map((shown) => [shown.id, shown.value])));
  const shown = new Set(values.keys());
  const fields = input.schema.fields.filter((field) => shown.has(field.id));
  return {
    format: SHEET_EXPORT_FORMAT,
    schema: {
      schemaVersion: input.schema.schemaVersion,
      rulepack: view.rulepack,
      fields: structuredClone(fields.map((field) => withoutHiddenRefs(field, shown))),
    },
    entries: fields.map((field) => ({
      id: field.id,
      value: values.get(field.id) ?? null,
      source: groupOf(field),
    })),
  };
};

const isEntryValue = (value: unknown): value is ProfileTraitValue | null =>
  value === null ||
  typeof value === 'string' ||
  typeof value === 'boolean' ||
  (typeof value === 'number' && Number.isFinite(value));

const entryIssues = (entries: unknown, schema: SheetSchema): SheetIssue[] => {
  if (!Array.isArray(entries)) return [{ path: 'entries', code: 'invalid', message: 'must be an array' }];
  const declared = new Set(schema.fields.map((field) => field.id));
  const seen = new Set<string>();
  return Array.from(entries).flatMap((entry: unknown, index): SheetIssue[] => {
    const path = `entries.${index}`;
    if (!isRecord(entry)) return [{ path, code: 'invalid', message: 'must be an object' }];
    const { id, value, source } = entry;
    const issues: SheetIssue[] = [];
    if (typeof id !== 'string' || !declared.has(id))
      issues.push({ path: `${path}.id`, code: 'unknown_reference', message: 'must reference a declared field' });
    else if (seen.has(id)) issues.push({ path: `${path}.id`, code: 'duplicate', message: 'must be unique' });
    else seen.add(id);
    if (!isEntryValue(value)) issues.push({ path: `${path}.value`, code: 'invalid', message: 'must be a trait value' });
    if (!SHEET_GROUPS.includes(source as SheetGroupId))
      issues.push({
        path: `${path}.source`,
        code: 'unsupported',
        message: `must be one of ${SHEET_GROUPS.join(', ')}`,
      });
    return issues;
  });
};

export const importSheet = (input: unknown): SheetImportResult => {
  if (!isRecord(input)) return { ok: false, issues: [{ path: '', code: 'invalid', message: 'must be an object' }] };
  if (input.format !== SHEET_EXPORT_FORMAT)
    return { ok: false, issues: [{ path: 'format', code: 'unsupported', message: `must be ${SHEET_EXPORT_FORMAT}` }] };
  const parsed = validateSheetSchema(input.schema);
  if (!parsed.ok)
    return { ok: false, issues: parsed.issues.map((issue) => ({ ...issue, path: `schema.${issue.path}` })) };
  const issues = entryIssues(input.entries, parsed.schema);
  if (issues.length > 0) return { ok: false, issues };
  const entries = (input.entries as SheetExportEntry[]).map(({ id, value, source }) => ({ id, value, source }));
  return { ok: true, sheet: { format: SHEET_EXPORT_FORMAT, schema: parsed.schema, entries } };
};
