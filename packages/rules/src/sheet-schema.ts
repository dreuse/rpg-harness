import { isNonEmptyString, isRecord, NON_EMPTY_STRING } from './rulepack.ts';

export const SHEET_SCHEMA_VERSION = 1;
export const WIDGET_TYPES = ['text', 'number', 'toggle', 'tag', 'choice', 'resource'] as const;
export const VISIBILITIES = ['public', 'owner', 'gm', 'hidden'] as const;
export const ISSUE_CODES = ['missing', 'invalid', 'duplicate', 'unknown_reference', 'unsupported', 'cycle'] as const;
const FIELD_KEYS = ['id', 'widget', 'label', 'custom', 'visibility', 'options', 'derived'];

const DEFAULT_VISIBILITY = 'public';
const CHOICE_WIDGET = 'choice';

export type WidgetType = (typeof WIDGET_TYPES)[number];
export type Visibility = (typeof VISIBILITIES)[number];
export type SheetIssueCode = (typeof ISSUE_CODES)[number];
export type SheetIssue = { path: string; code: SheetIssueCode; message: string };

export type SheetProvenance = { id: string; edition: string; revision: string; sourceRefs: string[] };
export type DerivedExpression = { expression: string; refs: string[] };
export type SheetField = {
  id: string;
  widget: WidgetType;
  label?: string;
  custom: boolean;
  visibility: Visibility;
  options?: string[];
  derived?: DerivedExpression;
};
export type SheetSchema = {
  schemaVersion: typeof SHEET_SCHEMA_VERSION;
  rulepack: SheetProvenance;
  fields: SheetField[];
};
export type SheetSchemaResult = { ok: true; schema: SheetSchema } | { ok: false; issues: SheetIssue[] };

const isOneOf = <T extends string>(list: readonly T[], value: unknown): value is T => list.includes(value as T);
const isStringList = (value: unknown): value is string[] =>
  Array.isArray(value) && Array.from(value).every(isNonEmptyString);

const parseProvenance = (input: unknown, issues: SheetIssue[]): SheetProvenance => {
  const path = 'rulepack';
  if (!isRecord(input)) {
    issues.push({ path, code: 'missing', message: 'must be an object' });
    return { id: '', edition: '', revision: '', sourceRefs: [] };
  }
  const { id, edition, revision, sourceRefs } = input;
  const strings = { id, edition, revision };
  for (const key of ['id', 'edition', 'revision'] as const) {
    if (!isNonEmptyString(strings[key]))
      issues.push({ path: `${path}.${key}`, code: 'invalid', message: NON_EMPTY_STRING });
  }
  if (!isStringList(sourceRefs))
    issues.push({ path: `${path}.sourceRefs`, code: 'invalid', message: 'must be an array of strings' });
  return {
    id: id as string,
    edition: edition as string,
    revision: revision as string,
    sourceRefs: isStringList(sourceRefs) ? [...sourceRefs] : [],
  };
};

const parseDerived = (input: unknown, path: string, issues: SheetIssue[]): DerivedExpression => {
  if (!isRecord(input)) {
    issues.push({ path, code: 'invalid', message: 'must be an object' });
    return { expression: '', refs: [] };
  }
  const { expression, refs } = input;
  if (!isNonEmptyString(expression))
    issues.push({ path: `${path}.expression`, code: 'invalid', message: NON_EMPTY_STRING });
  if (!isStringList(refs))
    issues.push({ path: `${path}.refs`, code: 'invalid', message: 'must be an array of field ids' });
  return { expression: expression as string, refs: isStringList(refs) ? [...refs] : [] };
};

const parseField = (input: Record<string, unknown>, path: string, issues: SheetIssue[]): SheetField => {
  const at = (key: string, code: SheetIssueCode, message: string) =>
    issues.push({ path: `${path}.${key}`, code, message });
  const { id, widget, label, custom, visibility, options, derived } = input;
  for (const key of Object.keys(input)) if (!FIELD_KEYS.includes(key)) at(key, 'unsupported', 'is not a supported key');
  if (!isNonEmptyString(id)) at('id', 'invalid', NON_EMPTY_STRING);
  if (!isOneOf(WIDGET_TYPES, widget)) at('widget', 'unsupported', `must be one of ${WIDGET_TYPES.join(', ')}`);
  if (label !== undefined && !isNonEmptyString(label)) at('label', 'invalid', NON_EMPTY_STRING);
  if (custom !== undefined && typeof custom !== 'boolean') at('custom', 'invalid', 'must be a boolean');
  if (visibility !== undefined && !isOneOf(VISIBILITIES, visibility)) {
    at('visibility', 'unsupported', `must be one of ${VISIBILITIES.join(', ')}`);
  }
  if (widget === CHOICE_WIDGET && !(isStringList(options) && options.length > 0)) {
    at('options', 'invalid', 'must be a non-empty array of strings');
  }
  return {
    id: id as string,
    widget: widget as WidgetType,
    ...(label === undefined ? {} : { label: label as string }),
    custom: custom === true,
    visibility: (visibility ?? DEFAULT_VISIBILITY) as Visibility,
    ...(widget === CHOICE_WIDGET && isStringList(options) ? { options: [...options] } : {}),
    ...(derived === undefined ? {} : { derived: parseDerived(derived, `${path}.derived`, issues) }),
  };
};

const reachesSelf = (start: string, byId: Map<string, SheetField>) => {
  const seen = new Set<string>();
  const pending = [...(byId.get(start)?.derived?.refs ?? [])];
  while (pending.length > 0) {
    const next = pending.pop() as string;
    if (next === start) return true;
    if (seen.has(next)) continue;
    seen.add(next);
    pending.push(...(byId.get(next)?.derived?.refs ?? []));
  }
  return false;
};

const reachingCycle = (byId: Map<string, SheetField>) => {
  const pending = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const field of byId.values()) {
    const refs = (field.derived?.refs ?? []).filter((ref) => byId.has(ref));
    pending.set(field.id, refs.length);
    for (const ref of refs)
      dependents
        .set(ref, dependents.get(ref) ?? [])
        .get(ref)
        ?.push(field.id);
  }
  const settled = [...pending.keys()].filter((id) => pending.get(id) === 0);
  while (settled.length > 0) {
    for (const dependent of dependents.get(settled.pop() as string) ?? []) {
      const left = (pending.get(dependent) as number) - 1;
      pending.set(dependent, left);
      if (left === 0) settled.push(dependent);
    }
  }
  return new Set([...pending.keys()].filter((id) => (pending.get(id) as number) > 0));
};

export const referenceIssues = (fields: SheetField[]): SheetIssue[] => {
  const issues: SheetIssue[] = [];
  const ids = new Set<string>();
  const byId = new Map(fields.map((field) => [field.id, field]));
  const candidates = reachingCycle(byId);
  fields.forEach((field, index) => {
    if (ids.has(field.id)) issues.push({ path: `fields.${index}.id`, code: 'duplicate', message: 'must be unique' });
    ids.add(field.id);
  });
  fields.forEach((field, index) => {
    field.derived?.refs.forEach((ref, refIndex) => {
      if (!ids.has(ref)) {
        issues.push({
          path: `fields.${index}.derived.refs.${refIndex}`,
          code: 'unknown_reference',
          message: 'must reference a declared field',
        });
      }
    });
    if (field.derived && candidates.has(field.id) && reachesSelf(field.id, byId)) {
      issues.push({ path: `fields.${index}.derived.refs`, code: 'cycle', message: 'must not form a cycle' });
    }
  });
  return issues;
};

export const validateSheetSchema = (input: unknown): SheetSchemaResult => {
  if (!isRecord(input)) return { ok: false, issues: [{ path: '', code: 'invalid', message: 'must be an object' }] };
  const { schemaVersion, rulepack, fields } = input;
  const issues: SheetIssue[] = [];
  if (schemaVersion !== SHEET_SCHEMA_VERSION) {
    issues.push({ path: 'schemaVersion', code: 'unsupported', message: `must be ${SHEET_SCHEMA_VERSION}` });
  }
  const provenance = parseProvenance(rulepack, issues);
  if (!Array.isArray(fields)) issues.push({ path: 'fields', code: 'invalid', message: 'must be an array' });
  const parsed: SheetField[] = [];
  (Array.isArray(fields) ? fields : []).forEach((field: unknown, index) => {
    if (isRecord(field)) parsed.push(parseField(field, `fields.${index}`, issues));
    else issues.push({ path: `fields.${index}`, code: 'invalid', message: 'must be an object' });
  });
  if (issues.length > 0) return { ok: false, issues };
  const references = referenceIssues(parsed);
  if (references.length > 0) return { ok: false, issues: references };
  return { ok: true, schema: { schemaVersion: SHEET_SCHEMA_VERSION, rulepack: provenance, fields: parsed } };
};
