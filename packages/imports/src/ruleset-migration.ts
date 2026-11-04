import { isDeepStrictEqual } from 'node:util';
import type { EventId } from '../../domain/src/campaign.ts';
import {
  appendRevision,
  type CharacterRevision,
  type RevisionKind,
  type RevisionOrigin,
} from '../../rules/src/character-audit.ts';
import { deepFreeze } from '../../rules/src/compile.ts';
import {
  isNonEmptyString,
  isRecord,
  type ManifestIssue,
  NON_EMPTY_STRING,
  type RulePackManifest,
} from '../../rules/src/rulepack.ts';
import type { SheetField, SheetSchema, WidgetType } from '../../rules/src/sheet-schema.ts';
import type { TraitValue } from '../../rules/src/traits.ts';
import type { RulePackRef } from './preview.ts';

export const MAPPING_KINDS = ['rename', 'drop', 'reset'] as const;
const RENAME = 'rename';
const REMOVED_MAPPINGS: readonly MappingKind[] = [RENAME, 'drop'];
const CHANGED_TYPE_MAPPINGS: readonly MappingKind[] = ['reset'];
const MAPPING_KEYS = ['kind'];
const RENAME_KEYS = ['kind', 'to'];
const MAPPINGS_PATH = 'mappings';
const APPROVED_PATH = 'approved';
const DESTRUCTIVE_MAPPINGS: readonly MappingKind[] = ['drop', 'reset'];
const RULEPACK_KIND: RevisionKind = 'rulepack';
const SAFE_ORIGIN: RevisionOrigin = 'ruleset-migration';
const APPROVED_ORIGIN: RevisionOrigin = 'approved-migration';

export type MappingKind = (typeof MAPPING_KINDS)[number];
export type FieldMapping =
  | { readonly kind: typeof RENAME; readonly to: string }
  | { readonly kind: Exclude<MappingKind, typeof RENAME> };
export type FieldMappings = Readonly<Record<string, FieldMapping>>;

export type RulesetRevision = Readonly<{ rulePack: RulePackManifest; sheet: SheetSchema }>;
export type CampaignPin = Readonly<{
  campaignId: string;
  rulePack: RulePackRef;
  sourceRefs: readonly string[];
  previous: readonly RulePackRef[];
}>;
export type CampaignSheet = Readonly<{
  characterId: string;
  rulePack: RulePackRef;
  values: Readonly<Record<string, TraitValue>>;
}>;

export type ChangeKind = 'added' | 'removed' | 'renamed' | 'changed-type';
export type Resolution = 'compatible' | 'explicit';
export type FieldChange = Readonly<{
  kind: ChangeKind;
  fieldId: string;
  from: WidgetType | null;
  to: WidgetType | null;
  resolution: Resolution;
  mapping: FieldMapping | null;
}>;
export type MigrationPreview = Readonly<{
  from: RulePackRef;
  to: RulePackRef;
  changes: readonly FieldChange[];
  blocked: readonly string[];
}>;

export type MigrationErrorCode =
  | 'UnknownRevision'
  | 'RulePackMismatch'
  | 'EditionMismatch'
  | 'DowngradeRefused'
  | 'InvalidMapping'
  | 'IncompatibleFields'
  | 'SheetPinMismatch'
  | 'AlreadyMigrated'
  | 'ApprovalRequired'
  | 'AuditRejected';
export type MigrationError = { code: MigrationErrorCode; issues: ManifestIssue[] };
type Failure = { ok: false; error: MigrationError };

export type PinResult = { ok: true; pin: CampaignPin } | Failure;
export type PreviewResult = { ok: true; preview: MigrationPreview } | Failure;
export type MigrationResult =
  | { ok: true; pin: CampaignPin; sheets: readonly CampaignSheet[]; preview: MigrationPreview }
  | Failure;

const fail = (code: MigrationErrorCode, issues: ManifestIssue[]): Failure => ({
  ok: false,
  error: { code, issues },
});

const refOf = ({ id, edition, revision }: RulePackRef): RulePackRef => ({ id, edition, revision });

const sourceRefsOf = ({ rulePack, sheet }: RulesetRevision) => [
  ...new Set([...rulePack.sourceRefs, ...sheet.rulepack.sourceRefs]),
];

const locate = (catalog: readonly RulesetRevision[], ref: RulePackRef, path: string) => {
  const index = catalog.findIndex(({ rulePack }) => isDeepStrictEqual(refOf(rulePack), refOf(ref)));
  const entry = catalog[index];
  if (!entry) {
    return fail('UnknownRevision', [
      { path, message: `${ref.id} ${ref.edition} revision ${ref.revision} is not installed` },
    ]);
  }
  if (!isDeepStrictEqual(refOf(entry.sheet.rulepack), refOf(entry.rulePack))) {
    return fail('RulePackMismatch', [{ path, message: 'sheet schema is not pinned to its rulepack revision' }]);
  }
  return { ok: true as const, index, entry };
};

export const pinRuleset = (catalog: readonly RulesetRevision[], campaignId: string, ref: RulePackRef): PinResult => {
  const found = locate(catalog, ref, 'rulePack');
  if (!found.ok) return found;
  const pin = {
    campaignId,
    rulePack: refOf(found.entry.rulePack),
    sourceRefs: sourceRefsOf(found.entry),
    previous: [],
  };
  return { ok: true, pin: deepFreeze(structuredClone(pin)) };
};

const byId = (schema: SheetSchema) => new Map(schema.fields.map((field) => [field.id, field]));

const allowedMappings = (old: SheetField, next: SheetField | undefined) => {
  if (!next) return REMOVED_MAPPINGS;
  return next.widget === old.widget ? [] : CHANGED_TYPE_MAPPINGS;
};

const mappingIssues = (input: unknown, from: SheetSchema, to: SheetSchema): ManifestIssue[] => {
  if (!isRecord(input)) return [{ path: MAPPINGS_PATH, message: 'must be an object' }];
  const oldFields = byId(from);
  const newFields = byId(to);
  const targets = new Set<string>();
  return Object.entries(input).flatMap(([fieldId, mapping]): ManifestIssue[] => {
    const path = `${MAPPINGS_PATH}.${fieldId}`;
    if (!isRecord(mapping) || !MAPPING_KINDS.includes(mapping.kind as MappingKind)) {
      return [{ path, message: `must be one of ${MAPPING_KINDS.join(', ')}` }];
    }
    const kind = mapping.kind as MappingKind;
    const keys = kind === RENAME ? RENAME_KEYS : MAPPING_KEYS;
    if (Object.keys(mapping).some((key) => !keys.includes(key))) return [{ path, message: 'has unsupported keys' }];
    const old = oldFields.get(fieldId);
    if (!old) return [{ path, message: 'is not a field of the pinned revision' }];
    if (!allowedMappings(old, newFields.get(fieldId)).includes(kind)) {
      return [{ path, message: `${kind} does not apply to this field` }];
    }
    if (kind !== RENAME) return [];
    const { to: target } = mapping;
    const added = isNonEmptyString(target) && !oldFields.has(target) ? newFields.get(target) : undefined;
    if (!added) return [{ path: `${path}.to`, message: 'must name a field added by the target revision' }];
    if (added.widget !== old.widget) return [{ path: `${path}.to`, message: 'must keep the field widget' }];
    if (targets.has(added.id)) return [{ path: `${path}.to`, message: 'is already a rename target' }];
    targets.add(added.id);
    return [];
  });
};

const diffFields = (from: SheetSchema, to: SheetSchema, mappings: FieldMappings): FieldChange[] => {
  const oldFields = byId(from);
  const newFields = byId(to);
  const renamed = new Set(Object.values(mappings).flatMap((mapping) => (mapping.kind === RENAME ? [mapping.to] : [])));
  const explicit = from.fields.flatMap((old): FieldChange[] => {
    const next = newFields.get(old.id);
    const mapping = Object.hasOwn(mappings, old.id) ? (mappings[old.id] as FieldMapping) : null;
    const change = { fieldId: old.id, from: old.widget, resolution: 'explicit' as const, mapping };
    if (next) return next.widget === old.widget ? [] : [{ ...change, kind: 'changed-type', to: next.widget }];
    if (mapping?.kind === RENAME)
      return [{ ...change, kind: 'renamed', to: newFields.get(mapping.to)?.widget ?? null }];
    return [{ ...change, kind: 'removed', to: null }];
  });
  const added = to.fields
    .filter((field) => !oldFields.has(field.id) && !renamed.has(field.id))
    .map(
      (field): FieldChange => ({
        kind: 'added',
        fieldId: field.id,
        from: null,
        to: field.widget,
        resolution: 'compatible',
        mapping: null,
      }),
    );
  return [...explicit, ...added];
};

export const previewMigration = (
  catalog: readonly RulesetRevision[],
  pin: CampaignPin,
  target: RulePackRef,
  mappings: FieldMappings = {},
): PreviewResult => {
  const from = locate(catalog, pin.rulePack, 'pin.rulePack');
  if (!from.ok) return from;
  const to = locate(catalog, target, 'target');
  if (!to.ok) return to;
  const source = from.entry.rulePack;
  const next = to.entry.rulePack;
  if (next.id !== source.id) return fail('RulePackMismatch', [{ path: 'target.id', message: `must be ${source.id}` }]);
  if (next.edition !== source.edition) {
    return fail('EditionMismatch', [{ path: 'target.edition', message: `must be ${source.edition}` }]);
  }
  if (to.index < from.index) {
    return fail('DowngradeRefused', [{ path: 'target.revision', message: `must not precede ${source.revision}` }]);
  }
  const noop = to.index === from.index;
  const issues = noop ? [] : mappingIssues(mappings, from.entry.sheet, to.entry.sheet);
  if (issues.length > 0) return fail('InvalidMapping', issues);
  const changes = noop ? [] : diffFields(from.entry.sheet, to.entry.sheet, structuredClone(mappings));
  const blocked = changes.filter(({ resolution, mapping }) => resolution === 'explicit' && !mapping);
  const preview = { from: refOf(source), to: refOf(next), changes, blocked: blocked.map(({ fieldId }) => fieldId) };
  return { ok: true, preview: deepFreeze(structuredClone(preview)) };
};

const migrateValues = (values: CampaignSheet['values'], changes: readonly FieldChange[]) =>
  changes.reduce<Record<string, TraitValue>>(
    (next, { fieldId, mapping }) => {
      if (!mapping || !Object.hasOwn(next, fieldId)) return next;
      const { [fieldId]: value, ...rest } = next;
      return mapping.kind === RENAME ? { ...rest, [mapping.to]: value as TraitValue } : rest;
    },
    { ...values },
  );

export const applyMigration = (
  catalog: readonly RulesetRevision[],
  pin: CampaignPin,
  target: RulePackRef,
  sheets: readonly CampaignSheet[],
  mappings: FieldMappings = {},
): MigrationResult => {
  const previewed = previewMigration(catalog, pin, target, mappings);
  if (!previewed.ok) return previewed;
  const { preview } = previewed;
  const unmapped = preview.changes.filter(({ resolution, mapping }) => resolution === 'explicit' && !mapping);
  if (unmapped.length > 0) {
    return fail(
      'IncompatibleFields',
      unmapped.map(({ kind, fieldId }) => ({
        path: `${MAPPINGS_PATH}.${fieldId}`,
        message: `${kind} field needs an explicit mapping`,
      })),
    );
  }
  const strays = sheets.flatMap((sheet, index) =>
    isDeepStrictEqual(refOf(sheet.rulePack), refOf(pin.rulePack))
      ? []
      : [{ path: `sheets.${index}.rulePack`, message: `must be pinned to ${pin.rulePack.revision}` }],
  );
  if (strays.length > 0) return fail('SheetPinMismatch', strays);
  if (isDeepStrictEqual(preview.from, preview.to)) {
    return deepFreeze(structuredClone({ ok: true as const, pin, sheets, preview }));
  }
  const revision = catalog.find(({ rulePack }) => isDeepStrictEqual(refOf(rulePack), preview.to)) as RulesetRevision;
  const migrated = {
    pin: {
      campaignId: pin.campaignId,
      rulePack: preview.to,
      sourceRefs: sourceRefsOf(revision),
      previous: [...pin.previous, refOf(pin.rulePack)],
    },
    sheets: sheets.map((sheet) => ({
      characterId: sheet.characterId,
      rulePack: preview.to,
      values: migrateValues(sheet.values, preview.changes),
    })),
  };
  return deepFreeze(structuredClone({ ok: true as const, ...migrated, preview }));
};

export type SheetMigrationRequest = Readonly<{
  catalog: readonly RulesetRevision[];
  pin: CampaignPin;
  target: RulePackRef;
  sheets: readonly CampaignSheet[];
  mappings?: FieldMappings;
}>;
export type SheetMigrationApproval = SheetMigrationRequest &
  Readonly<{ log: readonly CharacterRevision[]; cause: EventId; source: string; approved: readonly string[] }>;
type Migrated = { pin: CampaignPin; sheets: readonly CampaignSheet[]; preview: MigrationPreview };
export type SheetPreviewResult = ({ ok: true; approvals: readonly string[] } & Migrated) | Failure;
export type SheetMigrationResult = ({ ok: true; log: readonly CharacterRevision[] } & Migrated) | Failure;

export const previewSheetMigration = (request: SheetMigrationRequest): SheetPreviewResult => {
  const migrated = applyMigration(request.catalog, request.pin, request.target, request.sheets, request.mappings);
  if (!migrated.ok) return migrated;
  const approvals = migrated.preview.changes.flatMap(({ fieldId, mapping }) =>
    mapping && DESTRUCTIVE_MAPPINGS.includes(mapping.kind) ? [fieldId] : [],
  );
  return Object.freeze({ ...migrated, approvals: Object.freeze(approvals) });
};

const approvalIssues = (approved: unknown, approvals: readonly string[]): ManifestIssue[] => {
  if (!Array.isArray(approved)) return [{ path: APPROVED_PATH, message: 'must be a list of field ids' }];
  const needed = new Set(approvals);
  const seen = new Set<string>();
  const invalid = approved.flatMap((fieldId, index): ManifestIssue[] => {
    const path = `${APPROVED_PATH}.${index}`;
    if (!isNonEmptyString(fieldId)) return [{ path, message: NON_EMPTY_STRING }];
    if (seen.has(fieldId)) return [{ path, message: 'is already approved' }];
    seen.add(fieldId);
    return needed.has(fieldId) ? [] : [{ path, message: 'is not a field that needs approval' }];
  });
  const missing = approvals
    .filter((fieldId) => !seen.has(fieldId))
    .map((fieldId) => ({ path: `${APPROVED_PATH}.${fieldId}`, message: 'needs explicit approval' }));
  return [...invalid, ...missing];
};

export const applySheetMigration = (request: SheetMigrationApproval): SheetMigrationResult => {
  const previewed = previewSheetMigration(request);
  if (!previewed.ok) return previewed;
  const { pin, sheets, preview, approvals } = previewed;
  if (isDeepStrictEqual(preview.from, preview.to)) {
    return fail('AlreadyMigrated', [{ path: 'target', message: `campaign is already on ${preview.to.revision}` }]);
  }
  const issues = approvalIssues(request.approved, approvals);
  if (issues.length > 0) return fail('ApprovalRequired', issues);
  const origin = approvals.length > 0 ? APPROVED_ORIGIN : SAFE_ORIGIN;
  let log: readonly CharacterRevision[] = Object.freeze([...request.log]);
  for (const [index, { characterId }] of sheets.entries()) {
    const appended = appendRevision(log, {
      characterId,
      kind: RULEPACK_KIND,
      targetId: preview.to.id,
      origin,
      cause: request.cause,
      source: request.source,
      rulepack: preview.to,
      previous: preview.from.revision,
      next: preview.to.revision,
    });
    if (!appended.ok) {
      return fail(
        'AuditRejected',
        appended.error.issues.map(({ path, message }) => ({ path: `sheets.${index}.${path}`, message })),
      );
    }
    log = appended.log;
  }
  return Object.freeze({ ok: true as const, pin, sheets, preview, log });
};
