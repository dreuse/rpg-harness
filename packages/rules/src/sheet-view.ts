import type { CharacterProfile, ProfileTraitValue, ProfileVisibility } from '../../domain/src/character.ts';
import type { AppliedBonus, ConstraintResult, DerivedStats, StatConstraint } from './derived-stats.ts';
import type { SheetField, SheetProvenance, SheetSchema, WidgetType } from './sheet-schema.ts';

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
