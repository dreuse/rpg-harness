import { deepFreeze, PROTOCOL_VERSION, type ProtocolVersion, type Result } from './protocol.ts';
import { failure, readList, readPlain } from './view-registry.ts';

export const SHEET_VALUE_TYPES = ['text', 'number', 'flag'] as const;
export type SheetValueType = (typeof SHEET_VALUE_TYPES)[number];
export const COMPUTED_FIELD_TYPE = 'computed';
export const RAW_WIDGET_KIND = 'raw';
export const EDIT_SHEET_FIELD = 'EditSheetField';
export const UNRENDERABLE_VALUE = '[unrenderable value]';

type Primitive = string | number | boolean;
export type SheetCondition = { readonly field: string; readonly equals: Primitive };

export type SheetFieldSpec = {
  readonly id: string;
  readonly label: string;
  readonly type: string;
  readonly editable: boolean;
  readonly template?: string;
  readonly when?: SheetCondition;
};

export type SheetSchema = { readonly fields: readonly SheetFieldSpec[] };

export type SheetWidgetKind = SheetValueType | typeof COMPUTED_FIELD_TYPE | typeof RAW_WIDGET_KIND;

export type SheetWidget = {
  readonly id: string;
  readonly label: string;
  readonly kind: SheetWidgetKind;
  readonly value: unknown;
  readonly editable: boolean;
};

export type SheetEditContext = {
  readonly campaignId: string;
  readonly actionId: string;
  readonly actorId: string;
  readonly expectedRevision: number;
};

export type SheetEdit = SheetEditContext & { readonly fieldId: string; readonly value: unknown };

export type SheetEditRequest = SheetEdit & {
  readonly version: ProtocolVersion;
  readonly type: typeof EDIT_SHEET_FIELD;
};

type SheetValues = Readonly<Record<string, unknown>>;

const SCHEMA_KEYS = ['fields'];
const FIELD_KEYS = ['id', 'label', 'type', 'editable', 'template', 'when'];
const CONDITION_KEYS = ['field', 'equals'];
const TEMPLATE_REF = /\{([^{}]+)\}/g;
const EMPTY_TEXT = '';

const VALUE_CHECKS: Record<SheetValueType, (value: unknown) => boolean> = {
  text: (value) => typeof value === 'string',
  number: (value) => typeof value === 'number' && Number.isFinite(value),
  flag: (value) => typeof value === 'boolean',
};

const isValueType = (type: string): type is SheetValueType => SHEET_VALUE_TYPES.some((known) => known === type);
const isPrimitive = (value: unknown): value is Primitive =>
  typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));
const isId = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const isRevision = (value: unknown): boolean => Number.isSafeInteger(value) && (value as number) >= 0;

const parseCondition = (input: unknown): Result<SheetCondition> => {
  const plain = readPlain(input, CONDITION_KEYS, 'condition');
  if (!plain.ok) return plain;
  const { field, equals } = plain.value.values;
  if (!isId(field) || !isPrimitive(equals)) return failure('MalformedCommand', 'condition needs field and equals');
  return { ok: true, value: { field, equals } };
};

const parseField = (input: unknown): Result<SheetFieldSpec> => {
  const plain = readPlain(input, FIELD_KEYS, 'sheet field');
  if (!plain.ok) return plain;
  const { id, label, type, editable = false, template, when } = plain.value.values;
  if (!isId(id) || typeof label !== 'string' || !isId(type) || typeof editable !== 'boolean') {
    return failure('MalformedCommand', 'sheet field needs id, label, type and boolean editable');
  }
  const computed = type === COMPUTED_FIELD_TYPE;
  if (computed !== (typeof template === 'string') || (computed && editable)) {
    return failure('Rejected', `${id} template is only allowed on read-only computed fields`);
  }
  const field: SheetFieldSpec = { id, label, type, editable, ...(computed ? { template: template as string } : {}) };
  if (when === undefined) return { ok: true, value: field };
  const condition = parseCondition(when);
  return condition.ok ? { ok: true, value: { ...field, when: condition.value } } : condition;
};

export const parseSheetSchema = (input: unknown): Result<SheetSchema> => {
  const plain = readPlain(input, SCHEMA_KEYS, 'sheet schema');
  if (!plain.ok) return plain;
  const items = readList(plain.value.values.fields);
  if (items === undefined) return failure('MalformedCommand', 'fields must be a plain array');
  const fields: SheetFieldSpec[] = [];
  for (const item of items) {
    const field = parseField(item);
    if (!field.ok) return field;
    if (fields.some((seen) => seen.id === field.value.id))
      return failure('Rejected', `duplicate field ${field.value.id}`);
    fields.push(field.value);
  }
  return { ok: true, value: deepFreeze({ fields }) };
};

const isVisible = (field: SheetFieldSpec, values: SheetValues): boolean =>
  field.when === undefined || values[field.when.field] === field.when.equals;

const fillTemplate = (template: string, values: SheetValues): string =>
  template.replace(TEMPLATE_REF, (_, ref: string) => {
    const value = Object.hasOwn(values, ref) ? values[ref] : undefined;
    return isPrimitive(value) ? String(value) : EMPTY_TEXT;
  });

const kindOf = (field: SheetFieldSpec, value: unknown): SheetWidgetKind => {
  if (field.type === COMPUTED_FIELD_TYPE) return COMPUTED_FIELD_TYPE;
  if (isValueType(field.type) && (value === undefined || VALUE_CHECKS[field.type](value))) return field.type;
  return RAW_WIDGET_KIND;
};

const safeClone = (value: unknown): unknown => {
  try {
    return structuredClone(value);
  } catch {
    return UNRENDERABLE_VALUE;
  }
};

const toWidget = (field: SheetFieldSpec, values: SheetValues): SheetWidget => {
  const stored = Object.hasOwn(values, field.id) ? values[field.id] : undefined;
  const kind = kindOf(field, stored);
  const value = field.template === undefined ? safeClone(stored) : fillTemplate(field.template, values);
  const editable = field.editable && isValueType(kind);
  return { id: field.id, label: field.label, kind, value, editable };
};

const rawWidget = (id: string, value: unknown): SheetWidget => ({
  id,
  label: id,
  kind: RAW_WIDGET_KIND,
  value: safeClone(value),
  editable: false,
});

export const renderSheet = (schema: SheetSchema, values: SheetValues): readonly SheetWidget[] => {
  const known = new Set(schema.fields.filter((field) => field.template === undefined).map((field) => field.id));
  const widgets = schema.fields.filter((field) => isVisible(field, values)).map((field) => toWidget(field, values));
  const extras = Object.keys(values)
    .filter((id) => !known.has(id))
    .map((id) => rawWidget(id, values[id]));
  return deepFreeze([...widgets, ...extras]);
};

export const requestSheetEdit = (
  schema: SheetSchema,
  values: SheetValues,
  edit: SheetEdit,
): Result<SheetEditRequest> => {
  const { campaignId, actionId, actorId, expectedRevision, fieldId, value } = edit;
  if (![campaignId, actionId, actorId, fieldId].every(isId) || !isRevision(expectedRevision)) {
    return failure('MalformedCommand', 'sheet edit needs ids and a non-negative integer revision');
  }
  const field = schema.fields.find((candidate) => candidate.id === edit.fieldId);
  if (field === undefined || !isVisible(field, values))
    return failure('Rejected', `${edit.fieldId} is not on the sheet`);
  const widget = toWidget(field, values);
  if (!widget.editable || !isValueType(widget.kind)) return failure('Rejected', `${edit.fieldId} is not editable`);
  if (!VALUE_CHECKS[widget.kind](edit.value))
    return failure('MalformedCommand', `${edit.fieldId} expects ${widget.kind}`);
  const request = { campaignId, actionId, actorId, expectedRevision, fieldId, value };
  return { ok: true, value: Object.freeze({ version: PROTOCOL_VERSION, type: EDIT_SHEET_FIELD, ...request }) };
};
