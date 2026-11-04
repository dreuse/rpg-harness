import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendRevision, type CharacterRevision } from '../../rules/src/character-audit.ts';
import { deepFreeze } from '../../rules/src/compile.ts';
import { RULEPACK_CONTRACT_VERSION } from '../../rules/src/rulepack.ts';
import { SHEET_SCHEMA_VERSION, type SheetField, type WidgetType } from '../../rules/src/sheet-schema.ts';
import {
  applyMigration,
  applySheetMigration,
  type CampaignPin,
  type CampaignSheet,
  type FieldMappings,
  pinRuleset,
  previewMigration,
  previewSheetMigration,
  type RulesetRevision,
} from './ruleset-migration.ts';

const PACK_ID = 'pack';
const EDITION = 'core';
const OTHER_EDITION = 'second';
const CAMPAIGN_ID = 'campaign-1';
const SOURCE_V1 = 'a'.repeat(64);
const SOURCE_V2 = 'b'.repeat(64);
const SOURCE_V3 = 'c'.repeat(64);
const KEPT_VALUE = 7;
const LEGACY_VALUE = 3;
const MISSING_REVISION = '9';

const field = (id: string, widget: WidgetType = 'number'): SheetField => ({
  id,
  widget,
  custom: false,
  visibility: 'public',
});

const revision = (revisionId: string, sourceRef: string, fields: SheetField[], edition = EDITION): RulesetRevision => ({
  rulePack: {
    contractVersion: RULEPACK_CONTRACT_VERSION,
    id: PACK_ID,
    edition,
    revision: revisionId,
    capabilities: {},
    sourceRefs: [sourceRef],
  },
  sheet: {
    schemaVersion: SHEET_SCHEMA_VERSION,
    rulepack: { id: PACK_ID, edition, revision: revisionId, sourceRefs: [sourceRef] },
    fields,
  },
});

const V1 = revision('1', SOURCE_V1, [field('field-a'), field('field-b'), field('field-c'), field('field-d')]);
const V2 = revision('2', SOURCE_V2, [
  field('field-a'),
  field('field-b'),
  field('field-c'),
  field('field-d'),
  field('field-e'),
]);
const V3 = revision('3', SOURCE_V3, [field('field-a'), field('field-c', 'text'), field('field-e'), field('field-f')]);
const OTHER = revision('1', SOURCE_V1, [field('field-a')], OTHER_EDITION);
const CATALOG = [V1, V2, V3, OTHER];

const ref = ({ rulePack: { id, edition, revision: rev } }: RulesetRevision) => ({ id, edition, revision: rev });

const sheet = (rulePack = ref(V1)): CampaignSheet => ({
  characterId: 'char-1',
  rulePack,
  values: { 'field-a': KEPT_VALUE, 'field-b': LEGACY_VALUE, 'field-c': LEGACY_VALUE, 'field-d': LEGACY_VALUE },
});

const V3_MAPPINGS: FieldMappings = {
  'field-b': { kind: 'rename', to: 'field-f' },
  'field-c': { kind: 'reset' },
  'field-d': { kind: 'drop' },
};

const unwrap = <T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> => {
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result as Extract<T, { ok: true }>;
};

test('I10 pins ruleset versions and previews/applies compatible or explicit migrations', () => {
  const { pin } = unwrap(pinRuleset(CATALOG, CAMPAIGN_ID, ref(V1)));
  assert.deepEqual(pin, { campaignId: CAMPAIGN_ID, rulePack: ref(V1), sourceRefs: [SOURCE_V1], previous: [] });

  const compatible = unwrap(previewMigration(CATALOG, pin, ref(V2))).preview;
  assert.deepEqual(compatible.changes, [
    { kind: 'added', fieldId: 'field-e', from: null, to: 'number', resolution: 'compatible', mapping: null },
  ]);
  assert.deepEqual(compatible.blocked, []);
  const toV2 = unwrap(applyMigration(CATALOG, pin, ref(V2), [sheet()]));
  assert.deepEqual(toV2.pin, {
    campaignId: CAMPAIGN_ID,
    rulePack: ref(V2),
    sourceRefs: [SOURCE_V2],
    previous: [ref(V1)],
  });
  assert.deepEqual(toV2.sheets, [{ ...sheet(), rulePack: ref(V2) }]);

  const explicit = unwrap(previewMigration(CATALOG, toV2.pin, ref(V3), V3_MAPPINGS)).preview;
  assert.deepEqual(explicit.changes, [
    {
      kind: 'renamed',
      fieldId: 'field-b',
      from: 'number',
      to: 'number',
      resolution: 'explicit',
      mapping: V3_MAPPINGS['field-b'],
    },
    {
      kind: 'changed-type',
      fieldId: 'field-c',
      from: 'number',
      to: 'text',
      resolution: 'explicit',
      mapping: V3_MAPPINGS['field-c'],
    },
    {
      kind: 'removed',
      fieldId: 'field-d',
      from: 'number',
      to: null,
      resolution: 'explicit',
      mapping: V3_MAPPINGS['field-d'],
    },
  ]);
  assert.deepEqual(explicit.blocked, []);
  const toV3 = applyMigration(CATALOG, toV2.pin, ref(V3), toV2.sheets, V3_MAPPINGS);
  assert.deepEqual(unwrap(toV3).pin.previous, [ref(V1), ref(V2)]);
  assert.deepEqual(unwrap(toV3).sheets, [
    { characterId: 'char-1', rulePack: ref(V3), values: { 'field-a': KEPT_VALUE, 'field-f': LEGACY_VALUE } },
  ]);
  assert.deepEqual(applyMigration(CATALOG, toV2.pin, ref(V3), toV2.sheets, V3_MAPPINGS), toV3, 'deterministic');

  const again = unwrap(applyMigration(CATALOG, unwrap(toV3).pin, ref(V3), unwrap(toV3).sheets, V3_MAPPINGS));
  assert.deepEqual(again.pin, unwrap(toV3).pin, 'reapplying is a no-op');
  assert.deepEqual(again.sheets, unwrap(toV3).sheets);
  assert.deepEqual(again.preview.changes, []);
});

test('I10 incompatible sheet fields block silent migration', () => {
  const { pin } = unwrap(pinRuleset(CATALOG, CAMPAIGN_ID, ref(V1)));
  const { preview } = unwrap(previewMigration(CATALOG, pin, ref(V3)));
  assert.deepEqual(preview.blocked, ['field-b', 'field-c', 'field-d']);
  assert.deepEqual(
    preview.changes.map(({ kind, fieldId, resolution, mapping }) => [kind, fieldId, resolution, mapping]),
    [
      ['removed', 'field-b', 'explicit', null],
      ['changed-type', 'field-c', 'explicit', null],
      ['removed', 'field-d', 'explicit', null],
      ['added', 'field-e', 'compatible', null],
      ['added', 'field-f', 'compatible', null],
    ],
  );
  const result = applyMigration(CATALOG, pin, ref(V3), [sheet()]);
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.error.code, 'IncompatibleFields');
  assert.deepEqual(!result.ok && result.error.issues.map(({ path }) => path), [
    'mappings.field-b',
    'mappings.field-c',
    'mappings.field-d',
  ]);
});

test('I10 explicit mapping resolves a blocked field', () => {
  const { pin } = unwrap(pinRuleset(CATALOG, CAMPAIGN_ID, ref(V2)));
  const { 'field-c': _reset, ...partial } = V3_MAPPINGS;
  const blocked = applyMigration(CATALOG, pin, ref(V3), [sheet(ref(V2))], partial);
  assert.deepEqual(!blocked.ok && blocked.error.issues.map(({ path }) => path), ['mappings.field-c']);
  const resolved = unwrap(applyMigration(CATALOG, pin, ref(V3), [sheet(ref(V2))], V3_MAPPINGS));
  assert.equal(Object.hasOwn(resolved.sheets[0]?.values ?? {}, 'field-c'), false);
});

test('I10 rejects unknown pinned versions', () => {
  const unknown = { ...ref(V1), revision: MISSING_REVISION };
  const pinned = pinRuleset(CATALOG, CAMPAIGN_ID, unknown);
  assert.equal(!pinned.ok && pinned.error.code, 'UnknownRevision');
  const stale = { campaignId: CAMPAIGN_ID, rulePack: unknown, sourceRefs: [], previous: [] };
  const fromUnknown = previewMigration(CATALOG, stale, ref(V2));
  assert.equal(!fromUnknown.ok && fromUnknown.error.code, 'UnknownRevision');
  const { pin } = unwrap(pinRuleset(CATALOG, CAMPAIGN_ID, ref(V1)));
  const toUnknown = previewMigration(CATALOG, pin, unknown);
  assert.equal(!toUnknown.ok && toUnknown.error.code, 'UnknownRevision');
});

test('I10 refuses downgrades and edition changes', () => {
  const { pin } = unwrap(pinRuleset(CATALOG, CAMPAIGN_ID, ref(V2)));
  const downgrade = previewMigration(CATALOG, pin, ref(V1));
  assert.equal(!downgrade.ok && downgrade.error.code, 'DowngradeRefused');
  const edition = previewMigration(CATALOG, pin, ref(OTHER));
  assert.equal(!edition.ok && edition.error.code, 'EditionMismatch');
});

test('I10 rejects invalid mappings and sheets pinned elsewhere', () => {
  const { pin } = unwrap(pinRuleset(CATALOG, CAMPAIGN_ID, ref(V2)));
  const invalid: unknown[] = [
    { ...V3_MAPPINGS, 'field-b': { kind: 'rename', to: 'field-a' } },
    { ...V3_MAPPINGS, 'field-c': { kind: 'drop' } },
    { ...V3_MAPPINGS, 'field-a': { kind: 'drop' } },
    { ...V3_MAPPINGS, 'field-d': { kind: 'rename', to: 'field-f' } },
    { ...V3_MAPPINGS, 'field-d': { kind: 'eval', code: '1' } },
  ];
  for (const mappings of invalid) {
    const result = previewMigration(CATALOG, pin, ref(V3), mappings as FieldMappings);
    assert.equal(!result.ok && result.error.code, 'InvalidMapping', JSON.stringify(mappings));
  }
  const mismatch = applyMigration(CATALOG, pin, ref(V3), [sheet(ref(V1))], V3_MAPPINGS);
  assert.equal(!mismatch.ok && mismatch.error.code, 'SheetPinMismatch');
});

test('I10 never mutates its inputs', () => {
  const catalog = deepFreeze(structuredClone(CATALOG));
  const { pin } = unwrap(pinRuleset(catalog, CAMPAIGN_ID, ref(V2)));
  const sheets = deepFreeze([sheet(ref(V2))]);
  const mappings = deepFreeze(structuredClone(V3_MAPPINGS));
  const snapshot = structuredClone({ catalog, pin, sheets, mappings });
  const result = unwrap(applyMigration(catalog, deepFreeze(pin), ref(V3), sheets, mappings));
  assert.deepEqual({ catalog, pin, sheets, mappings }, snapshot);
  assert.ok(Object.isFrozen(result.sheets[0]?.values));
  assert.notEqual(result.sheets[0], sheets[0]);
});

const CHARACTER_ID = 'char-1';
const MIGRATION_CAUSE = 'evt-migrate';
const REPLAY_CAUSE = 'evt-replay';
const OTHER_CHARACTER_ID = 'char-2';
const APPROVER = 'player';
const WOUNDED_VALUE = 5;
const DESTRUCTIVE_FIELDS = ['field-c', 'field-d'];
const RENAMED = revision('2', SOURCE_V2, [field('field-a'), field('field-z'), field('field-c'), field('field-d')]);
const RENAME_CATALOG = [V1, RENAMED];
const RENAME_MAPPINGS: FieldMappings = { 'field-b': { kind: 'rename', to: 'field-z' } };

const migrationRevision = (
  from: RulesetRevision,
  to: RulesetRevision,
  origin: CharacterRevision['origin'],
): CharacterRevision => ({
  characterId: CHARACTER_ID,
  kind: 'rulepack',
  targetId: PACK_ID,
  origin,
  cause: MIGRATION_CAUSE,
  source: APPROVER,
  rulepack: ref(to),
  previous: from.rulePack.revision,
  next: to.rulePack.revision,
});

const apply = (
  pin: CampaignPin,
  target: RulesetRevision,
  sheets: readonly CampaignSheet[],
  log: readonly CharacterRevision[],
  options: { mappings?: FieldMappings; approved?: readonly string[]; catalog?: readonly RulesetRevision[] } = {},
) =>
  applySheetMigration({
    catalog: options.catalog ?? CATALOG,
    pin,
    target: ref(target),
    sheets,
    mappings: options.mappings ?? {},
    log,
    cause: MIGRATION_CAUSE,
    source: APPROVER,
    approved: options.approved ?? [],
  });

const migratedToV2 = () => {
  const { pin } = unwrap(pinRuleset(CATALOG, CAMPAIGN_ID, ref(V1)));
  const wound = unwrap(
    appendRevision([], {
      characterId: CHARACTER_ID,
      kind: 'resource',
      targetId: 'field-a',
      origin: 'in-world',
      cause: 'evt-1',
      source: 'act-1',
      rulepack: ref(V1),
      previous: KEPT_VALUE,
      next: WOUNDED_VALUE,
    }),
  );
  return unwrap(apply(pin, V2, [sheet()], wound.log));
};

test('S11 previews and applies safe field transformations on new ruleset versions', () => {
  const { pin } = unwrap(pinRuleset(CATALOG, CAMPAIGN_ID, ref(V1)));
  const compatible = unwrap(previewSheetMigration({ catalog: CATALOG, pin, target: ref(V2), sheets: [sheet()] }));
  assert.deepEqual(compatible.approvals, []);
  assert.deepEqual(compatible.sheets, [{ ...sheet(), rulePack: ref(V2) }]);
  const toV2 = unwrap(apply(pin, V2, [sheet()], []));
  assert.deepEqual(toV2.sheets, compatible.sheets);
  assert.deepEqual(toV2.pin.rulePack, ref(V2));
  assert.deepEqual(toV2.log, [migrationRevision(V1, V2, 'ruleset-migration')]);

  const renamePin = unwrap(pinRuleset(RENAME_CATALOG, CAMPAIGN_ID, ref(V1))).pin;
  const renamed = unwrap(
    previewSheetMigration({
      catalog: RENAME_CATALOG,
      pin: renamePin,
      target: ref(RENAMED),
      sheets: [sheet()],
      mappings: RENAME_MAPPINGS,
    }),
  );
  assert.deepEqual(renamed.approvals, [], 'a rename keeps the value and needs no approval');
  const applied = unwrap(
    apply(renamePin, RENAMED, [sheet()], [], { catalog: RENAME_CATALOG, mappings: RENAME_MAPPINGS }),
  );
  assert.deepEqual(applied.sheets, [
    {
      characterId: CHARACTER_ID,
      rulePack: ref(RENAMED),
      values: { 'field-a': KEPT_VALUE, 'field-z': LEGACY_VALUE, 'field-c': LEGACY_VALUE, 'field-d': LEGACY_VALUE },
    },
  ]);
  assert.deepEqual(applied.log, [migrationRevision(V1, RENAMED, 'ruleset-migration')]);
});

test('S11 historical sheets and events stay unchanged after a migration', () => {
  const before = migratedToV2();
  const snapshot = structuredClone({ sheets: before.sheets, log: before.log });
  const after = unwrap(
    apply(before.pin, V3, before.sheets, before.log, { mappings: V3_MAPPINGS, approved: DESTRUCTIVE_FIELDS }),
  );
  assert.deepEqual({ sheets: before.sheets, log: before.log }, snapshot);
  assert.equal(after.log.length, before.log.length + 1);
  for (const [index, entry] of before.log.entries()) assert.equal(after.log[index], entry);
  assert.deepEqual(after.log.at(-1), migrationRevision(V2, V3, 'approved-migration'));
});

test('S11 incompatible migrations require explicit approval', () => {
  const before = migratedToV2();
  const preview = unwrap(
    previewSheetMigration({
      catalog: CATALOG,
      pin: before.pin,
      target: ref(V3),
      sheets: before.sheets,
      mappings: V3_MAPPINGS,
    }),
  );
  assert.deepEqual(preview.approvals, DESTRUCTIVE_FIELDS);
  for (const approved of [[], ['field-c']]) {
    const refused = apply(before.pin, V3, before.sheets, before.log, { mappings: V3_MAPPINGS, approved });
    assert.equal(!refused.ok && refused.error.code, 'ApprovalRequired');
    assert.deepEqual(
      !refused.ok && refused.error.issues.map(({ path }) => path),
      DESTRUCTIVE_FIELDS.filter((fieldId) => !approved.includes(fieldId)).map((fieldId) => `approved.${fieldId}`),
    );
  }
  const unmapped = apply(before.pin, V3, before.sheets, before.log, { approved: ['field-b', ...DESTRUCTIVE_FIELDS] });
  assert.equal(!unmapped.ok && unmapped.error.code, 'IncompatibleFields');
  const approved = unwrap(
    apply(before.pin, V3, before.sheets, before.log, { mappings: V3_MAPPINGS, approved: DESTRUCTIVE_FIELDS }),
  );
  assert.equal(approved.log.at(-1)?.origin, 'approved-migration');
  assert.equal(approved.log.at(-1)?.source, APPROVER);
  assert.deepEqual(approved.sheets, [
    { characterId: CHARACTER_ID, rulePack: ref(V3), values: { 'field-a': KEPT_VALUE, 'field-f': LEGACY_VALUE } },
  ]);
});

test('S11 preview has no side effects; applying twice or against the wrong pin is refused', () => {
  const before = migratedToV2();
  const request = { catalog: CATALOG, pin: before.pin, target: ref(V3), sheets: before.sheets, mappings: V3_MAPPINGS };
  const snapshot = structuredClone({ request, log: before.log });
  assert.deepEqual(previewSheetMigration(request), previewSheetMigration(request));
  assert.deepEqual({ request, log: before.log }, snapshot);

  const again = apply(before.pin, V2, before.sheets, before.log);
  assert.equal(!again.ok && again.error.code, 'AlreadyMigrated');

  const { pin: stalePin } = unwrap(pinRuleset(CATALOG, CAMPAIGN_ID, ref(V1)));
  const replay = applySheetMigration({
    catalog: CATALOG,
    pin: stalePin,
    target: ref(V2),
    sheets: [sheet()],
    log: before.log,
    cause: REPLAY_CAUSE,
    source: APPROVER,
    approved: [],
  });
  assert.equal(!replay.ok && replay.error.code, 'AuditRejected');
  assert.deepEqual(!replay.ok && replay.error.issues, [
    { path: 'sheets.0.previous', message: 'must equal the latest recorded value' },
  ]);

  const wrongPin = apply(before.pin, V3, [sheet()], before.log, {
    mappings: V3_MAPPINGS,
    approved: DESTRUCTIVE_FIELDS,
  });
  assert.equal(!wrongPin.ok && wrongPin.error.code, 'SheetPinMismatch');
});

test('S11 refuses malformed, unknown or duplicate approvals', () => {
  const before = migratedToV2();
  const cases: readonly [unknown, readonly string[]][] = [
    ['I did not approve field-c or field-d', ['approved']],
    [undefined, ['approved']],
    [null, ['approved']],
    [[...DESTRUCTIVE_FIELDS, ''], ['approved.2']],
    [[...DESTRUCTIVE_FIELDS, 'field-a'], ['approved.2']],
    [[...DESTRUCTIVE_FIELDS, 'field-c'], ['approved.2']],
  ];
  for (const [approved, paths] of cases) {
    const result = applySheetMigration({
      catalog: CATALOG,
      pin: before.pin,
      target: ref(V3),
      sheets: before.sheets,
      mappings: V3_MAPPINGS,
      log: before.log,
      cause: MIGRATION_CAUSE,
      source: APPROVER,
      approved: approved as readonly string[],
    });
    assert.equal(!result.ok && result.error.code, 'ApprovalRequired', JSON.stringify(approved));
    assert.deepEqual(!result.ok && result.error.issues.map(({ path }) => path), paths, JSON.stringify(approved));
  }
});

test('S11 a failed append returns no partial log and an empty migration copies the log', () => {
  const { pin } = unwrap(pinRuleset(CATALOG, CAMPAIGN_ID, ref(V1)));
  const other = { ...sheet(), characterId: OTHER_CHARACTER_ID };
  const { log } = unwrap(apply(pin, V2, [other], []));
  const partial = apply(pin, V2, [sheet(), other], log);
  assert.deepEqual(partial, {
    ok: false,
    error: {
      code: 'AuditRejected',
      issues: [{ path: 'sheets.1.previous', message: 'must equal the latest recorded value' }],
    },
  });

  const empty = unwrap(apply(pin, V2, [], log));
  assert.deepEqual(empty.log, log);
  assert.notEqual(empty.log, log);
  assert.ok(Object.isFrozen(empty.log));
});
