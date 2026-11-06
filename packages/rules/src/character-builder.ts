import { type CharacterProfile, type ProfileTraitValue, parseCharacterProfile } from '../../domain/src/character.ts';
import { computeDerivedStats, NUMERIC_WIDGETS, type StatConstraint } from './derived-stats.ts';
import { isBounded } from './dsl.ts';
import type { RulePackManifest } from './rulepack.ts';
import {
  SHEET_SCHEMA_VERSION,
  type SheetField,
  type SheetProvenance,
  type SheetSchema,
  type WidgetType,
} from './sheet-schema.ts';

export const BUILDER_ISSUE_CODES = [
  'out_of_range',
  'invalid_value',
  'unknown_field',
  'derived_field',
  'override_not_permitted',
  'unsupported_equipment',
  'duplicate',
  'not_list',
  'invalid',
] as const;
export const BLOCKING_WIDGETS: readonly WidgetType[] = [...NUMERIC_WIDGETS, 'toggle', 'choice'];
export const BACKSTORY_SOURCE = 'player';

export type BuilderIssueCode = (typeof BUILDER_ISSUE_CODES)[number];
export type BuilderIssue = {
  path: string;
  code: BuilderIssueCode;
  message: string;
  min?: number;
  max?: number;
  widget?: WidgetType;
};
export type CreationRules = {
  schema: SheetSchema;
  constraints: StatConstraint[];
  startingEquipment: string[];
  overridableFields: string[];
};
export type CharacterProposal = { name: string; values: Record<string, ProfileTraitValue>; equipment: string[] };
export type BuildInput = {
  rules: CreationRules;
  backstory: string;
  proposal: CharacterProposal;
  choices?: Record<string, ProfileTraitValue>;
  overrides?: Record<string, ProfileTraitValue>;
};
export type ChoiceQuestion = {
  fieldId: string;
  widget: WidgetType;
  label?: string;
  options?: string[];
  min?: number;
  max?: number;
};
export type FieldOverride = { fieldId: string; value: ProfileTraitValue };
export type BuiltCharacter = {
  profile: CharacterProfile;
  equipment: string[];
  overrides: FieldOverride[];
  provenance: { rulepack: SheetProvenance; backstory: typeof BACKSTORY_SOURCE };
};
export type BuildResult =
  | { status: 'created'; character: BuiltCharacter }
  | { status: 'pending'; questions: ChoiceQuestion[] }
  | { status: 'rejected'; issues: BuilderIssue[] };

type Bounds = { min?: number; max?: number };

export const creationRulesOf = (
  { id, edition, revision, sourceRefs }: RulePackManifest,
  fields: SheetField[] = [],
  constraints: StatConstraint[] = [],
  startingEquipment: string[] = [],
): CreationRules => ({
  schema: {
    schemaVersion: SHEET_SCHEMA_VERSION,
    rulepack: { id, edition, revision, sourceRefs: [...sourceRefs] },
    fields,
  },
  constraints,
  startingEquipment,
  overridableFields: [],
});

const fitsWidget = (field: SheetField, value: unknown) => {
  if (NUMERIC_WIDGETS.includes(field.widget)) return isBounded(value);
  if (field.widget === 'toggle') return typeof value === 'boolean';
  if (field.widget === 'choice') return typeof value === 'string' && (field.options ?? []).includes(value);
  return typeof value === 'string';
};

const boundsOf = (constraints: StatConstraint[], fieldId: string): Bounds => {
  const own = constraints.filter((constraint) => constraint.field === fieldId);
  const mins = own.flatMap((constraint) => (constraint.min === undefined ? [] : [constraint.min]));
  const maxes = own.flatMap((constraint) => (constraint.max === undefined ? [] : [constraint.max]));
  return {
    ...(mins.length > 0 ? { min: Math.max(...mins) } : {}),
    ...(maxes.length > 0 ? { max: Math.min(...maxes) } : {}),
  };
};

const inBounds = (value: number, { min, max }: Bounds) =>
  (min === undefined || value >= min) && (max === undefined || value <= max);

const rangeMessage = ({ min, max }: Bounds) => `must be between ${min ?? '-∞'} and ${max ?? '∞'}`;

export const rangeIssue = (rules: CreationRules, fieldId: string, value: unknown): string | undefined => {
  const bounds = boundsOf(rules.constraints, fieldId);
  return typeof value === 'number' && !inBounds(value, bounds) ? rangeMessage(bounds) : undefined;
};

const entriesOf = (values: unknown) =>
  typeof values === 'object' && values !== null && !Array.isArray(values) ? Object.entries(values) : [];

const checkValues = (
  rules: CreationRules,
  values: unknown,
  path: string,
  overriding: boolean,
  issues: BuilderIssue[],
) => {
  const byId = new Map(rules.schema.fields.map((field) => [field.id, field]));
  const accepted = new Map<string, ProfileTraitValue>();
  for (const [id, value] of entriesOf(values)) {
    const at = (code: BuilderIssueCode, message: string, extra: Partial<BuilderIssue> = {}) =>
      issues.push({ path: `${path}.${id}`, code, message, ...extra });
    const field = byId.get(id);
    if (field === undefined) at('unknown_field', 'is not declared by the sheet schema');
    else if (field.derived) at('derived_field', 'is computed by the rulepack');
    else if (overriding && !rules.overridableFields.includes(id))
      at('override_not_permitted', 'is not open to user override');
    else if (!fitsWidget(field, value))
      at('invalid_value', `must fit the ${field.widget} widget`, { widget: field.widget });
    else if (!overriding && typeof value === 'number' && !inBounds(value, boundsOf(rules.constraints, id)))
      at('out_of_range', rangeMessage(boundsOf(rules.constraints, id)), boundsOf(rules.constraints, id));
    else accepted.set(id, value as ProfileTraitValue);
  }
  return accepted;
};

const checkEquipment = (rules: CreationRules, equipment: unknown, issues: BuilderIssue[]) => {
  const items = Array.isArray(equipment) ? Array.from(equipment) : [];
  if (!Array.isArray(equipment))
    issues.push({ path: 'proposal.equipment', code: 'not_list', message: 'must be a list' });
  const seen = new Set<unknown>();
  items.forEach((item, index) => {
    const path = `proposal.equipment.${index}`;
    if (!rules.startingEquipment.includes(item))
      issues.push({ path, code: 'unsupported_equipment', message: 'is not allowed starting equipment' });
    else if (seen.has(item)) issues.push({ path, code: 'duplicate', message: 'must be unique' });
    seen.add(item);
  });
  return items as string[];
};

const computableFields = (schema: SheetSchema, values: Map<string, ProfileTraitValue>) => {
  const numeric = schema.fields.filter((field) => NUMERIC_WIDGETS.includes(field.widget));
  const known = new Set(numeric.filter((field) => !field.derived && values.has(field.id)).map((field) => field.id));
  let pending = numeric.filter((field) => field.derived && !known.has(field.id));
  let grew = true;
  while (grew) {
    const ready = pending.filter((field) => field.derived?.refs.every((ref) => known.has(ref)));
    for (const field of ready) known.add(field.id);
    pending = pending.filter((field) => !known.has(field.id));
    grew = ready.length > 0;
  }
  return schema.fields.filter((field) => known.has(field.id));
};

const budgetIssues = (rules: CreationRules, values: Map<string, ProfileTraitValue>): BuilderIssue[] => {
  const fields = computableFields(rules.schema, values);
  const derivedIds = new Set(fields.filter((field) => field.derived).map((field) => field.id));
  const stats = computeDerivedStats({
    schema: { ...rules.schema, fields },
    base: Object.fromEntries(
      fields.filter((field) => !field.derived).map((field) => [field.id, values.get(field.id) as number]),
    ),
    bonuses: [],
    constraints: rules.constraints.filter((constraint) => derivedIds.has(constraint.field)),
  });
  if (!stats.ok)
    return stats.issues.map(({ path, code, message }) => ({
      path,
      code: code === 'out_of_range' ? code : 'invalid',
      message,
    }));
  const exceeded = new Set(stats.constraints.filter(({ status }) => status !== 'ok').map(({ field }) => field));
  return [...exceeded].map((field) => ({
    path: `fields.${field}`,
    code: 'out_of_range',
    message: rangeMessage(boundsOf(rules.constraints, field)),
    ...boundsOf(rules.constraints, field),
  }));
};

const budgetInputs = (rules: CreationRules) => {
  const byId = new Map(rules.schema.fields.map((field) => [field.id, field]));
  const inputs = new Set<string>();
  const seen = new Set<string>();
  const pending = rules.constraints.map((constraint) => constraint.field).filter((id) => byId.get(id)?.derived);
  while (pending.length > 0) {
    const id = pending.pop() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    const field = byId.get(id);
    if (field?.derived) pending.push(...field.derived.refs);
    else inputs.add(id);
  }
  return inputs;
};

const questionOf = (field: SheetField, bounds: Bounds): ChoiceQuestion => ({
  fieldId: field.id,
  widget: field.widget,
  ...(field.label === undefined ? {} : { label: field.label }),
  ...(field.options ? { options: [...field.options] } : {}),
  ...bounds,
});

export const buildCharacter = (input: BuildInput): BuildResult => {
  const { rules, proposal } = input;
  const issues: BuilderIssue[] = [];
  const proposed = checkValues(rules, proposal?.values, 'proposal.values', false, issues);
  const chosen = checkValues(rules, input.choices, 'choices', false, issues);
  const overridden = checkValues(rules, input.overrides, 'overrides', true, issues);
  const equipment = checkEquipment(rules, proposal?.equipment, issues);
  if (issues.length > 0) return { status: 'rejected', issues };
  const values = new Map([...proposed, ...chosen, ...overridden]);
  const overBudget = budgetIssues(rules, values);
  if (overBudget.length > 0) return { status: 'rejected', issues: overBudget };
  const settable = rules.schema.fields.filter((field) => !field.derived);
  const blocking = budgetInputs(rules);
  const questions = settable
    .filter((field) => !field.custom || blocking.has(field.id))
    .filter((field) => BLOCKING_WIDGETS.includes(field.widget) && !values.has(field.id))
    .map((field) => questionOf(field, boundsOf(rules.constraints, field.id)));
  if (questions.length > 0) return { status: 'pending', questions };
  const { id, edition, revision } = rules.schema.rulepack;
  const parsed = parseCharacterProfile({
    identity: { name: proposal.name },
    motivations: [],
    background: input.backstory,
    traits: settable
      .filter((field) => values.has(field.id))
      .map((field) => ({ id: field.id, value: values.get(field.id) })),
    conditions: [],
    rulepack: { id, edition, revision },
  });
  if (!parsed.ok)
    return {
      status: 'rejected',
      issues: parsed.issues.map(({ path, message }) => ({ path, code: 'invalid', message })),
    };
  return {
    status: 'created',
    character: {
      profile: parsed.profile,
      equipment: [...equipment],
      overrides: [...overridden].map(([fieldId, value]) => ({ fieldId, value })),
      provenance: { rulepack: structuredClone(rules.schema.rulepack), backstory: BACKSTORY_SOURCE },
    },
  };
};
