import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deepFreeze } from '../../rules/src/compile.ts';
import { RULEPACK_CONTRACT_VERSION } from '../../rules/src/rulepack.ts';
import { SHEET_SCHEMA_VERSION, type SheetField, type WidgetType } from '../../rules/src/sheet-schema.ts';
import {
  applyMigration,
  type CampaignSheet,
  type FieldMappings,
  pinRuleset,
  previewMigration,
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
