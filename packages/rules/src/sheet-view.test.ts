import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CharacterProfile } from '../../domain/src/character.ts';
import { computeDerivedStats, type DerivedStatsInput } from './derived-stats.ts';
import { SHEET_SCHEMA_VERSION, type SheetField, type SheetSchema } from './sheet-schema.ts';
import { buildSheetView, exportSheet, importSheet, SHEET_EXPORT_FORMAT, type SheetViewInput } from './sheet-view.ts';

const rulepack = { id: 'any-pack', edition: '1', revision: 'r2', sourceRefs: ['srd:p1'] };

const field = (id: string, extra: Partial<SheetField> = {}): SheetField => ({
  id,
  widget: 'number',
  custom: false,
  visibility: 'public',
  ...extra,
});

const schemaOf = (fields: SheetField[]): SheetSchema => ({ schemaVersion: SHEET_SCHEMA_VERSION, rulepack, fields });

const profileOf = (traits: CharacterProfile['traits']): CharacterProfile => ({
  identity: { name: 'Ash' },
  motivations: [],
  background: '',
  traits,
  conditions: [],
  rulepack: { id: rulepack.id, edition: rulepack.edition, revision: rulepack.revision },
});

const statsOf = (input: DerivedStatsInput) => {
  const result = computeDerivedStats(input);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error('stats failed');
  return result;
};

test('produce renderer-neutral field groups, values, allowed edits and computed descriptors', () => {
  const schema = schemaOf([
    field('might', { label: 'Might' }),
    field('stance', { widget: 'choice', options: ['calm', 'bold'] }),
    field('oath', { widget: 'text', custom: true }),
    field('guard', { derived: { expression: 'might * 2', refs: ['might'] } }),
  ]);
  const constraints = [{ field: 'might', min: 1, max: 5, onViolation: 'clamp' as const }];
  const stats = statsOf({
    schema,
    base: { might: 3 },
    bonuses: [{ source: 'item:shield', targets: ['guard'], amount: 1 }],
    constraints,
  });
  const input: SheetViewInput = {
    schema,
    profile: profileOf([
      { id: 'stance', value: 'bold' },
      { id: 'oath', value: 'protect the weak' },
    ]),
    stats,
    constraints,
    visibility: 'player',
    viewer: { role: 'player', owner: true },
  };
  const frozen = structuredClone(input);
  const view = buildSheetView(input);
  assert.deepEqual(input, frozen);
  assert.deepEqual(JSON.parse(JSON.stringify(view)), view);
  assert.deepEqual(view, {
    rulepack,
    groups: [
      {
        id: 'core',
        fields: [
          {
            id: 'might',
            widget: 'number',
            label: 'Might',
            value: 3,
            edit: { editable: true, base: 3, min: 1, max: 5 },
          },
          {
            id: 'stance',
            widget: 'choice',
            value: 'bold',
            edit: { editable: true, base: 'bold', options: ['calm', 'bold'] },
          },
        ],
      },
      {
        id: 'custom',
        fields: [
          { id: 'oath', widget: 'text', value: 'protect the weak', edit: { editable: true, base: 'protect the weak' } },
        ],
      },
      { id: 'computed', fields: [{ id: 'guard', widget: 'number', value: 7, edit: { editable: false } }] },
    ],
    computed: [
      {
        field: 'might',
        refs: [],
        bonuses: [],
        constraints: [{ field: 'might', status: 'ok', raw: 3, value: 3 }],
      },
      {
        field: 'guard',
        expression: 'might * 2',
        refs: ['might'],
        bonuses: [{ source: 'item:shield', target: 'guard', amount: 1 }],
        constraints: [],
      },
    ],
  });
  const gm = buildSheetView({ ...input, viewer: { role: 'gm' } });
  assert.deepEqual(gm, view);
  const other = buildSheetView({ ...input, viewer: { role: 'player', owner: false } });
  assert.ok(other.groups.flatMap((group) => group.fields).every((entry) => !entry.edit.editable));
});

test('editable fields expose the base and bonus-shifted bounds so saving does not reapply bonuses', () => {
  const schema = schemaOf([field('might')]);
  const constraints = [{ field: 'might', min: 1, max: 5, onViolation: 'clamp' as const }];
  const stats = statsOf({
    schema,
    base: { might: 3 },
    bonuses: [{ source: 'item:belt', targets: ['might'], amount: 2 }],
    constraints,
  });
  const view = buildSheetView({
    schema,
    profile: profileOf([{ id: 'might', value: 3 }]),
    stats,
    constraints,
    visibility: 'player',
    viewer: { role: 'player', owner: true },
  });
  assert.deepEqual(view.groups[0]?.fields[0], {
    id: 'might',
    widget: 'number',
    value: 5,
    edit: { editable: true, base: 3, min: -1, max: 3 },
  });
});

test('private npc fields and gm-only secrets never appear in player view', () => {
  const schema = schemaOf([
    field('name_hint', { widget: 'text' }),
    field('grudge', { widget: 'text', visibility: 'owner', custom: true }),
    field('true_name', { widget: 'text', visibility: 'gm', label: 'True name' }),
    field('curse', { visibility: 'gm' }),
    field('engine_flag', { widget: 'toggle', visibility: 'hidden' }),
    field('menace', { derived: { expression: 'curse + 1', refs: ['curse'] } }),
    field('dread', { visibility: 'gm', derived: { expression: 'curse * 2', refs: ['curse'] } }),
  ]);
  const stats = statsOf({
    schema,
    base: { curse: 4 },
    bonuses: [{ source: 'item:hexed-idol', targets: ['dread', 'curse'], amount: 1 }],
  });
  const input: SheetViewInput = {
    schema,
    profile: profileOf([
      { id: 'name_hint', value: 'the pale stranger' },
      { id: 'grudge', value: 'hates the duke' },
      { id: 'true_name', value: 'Vorhal' },
      { id: 'engine_flag', value: true },
    ]),
    stats,
    visibility: 'public',
    viewer: { role: 'player', owner: false },
  };
  const player = buildSheetView(input);
  const text = JSON.stringify(player);
  for (const secret of [
    'grudge',
    'duke',
    'true_name',
    'True name',
    'Vorhal',
    'curse',
    'dread',
    'engine_flag',
    'hexed',
  ]) {
    assert.ok(!text.includes(secret), `player view leaks ${secret}`);
  }
  assert.deepEqual(
    player.groups.map((group) => [group.id, group.fields.map((entry) => entry.id)]),
    [
      ['core', ['name_hint']],
      ['computed', ['menace']],
    ],
  );
  assert.deepEqual(player.computed, [{ field: 'menace', refs: [], bonuses: [], constraints: [] }]);

  const gm = buildSheetView({ ...input, viewer: { role: 'gm' } });
  const gmText = JSON.stringify(gm);
  for (const secret of ['duke', 'Vorhal', 'curse + 1', 'hexed-idol']) assert.ok(gmText.includes(secret));
  assert.ok(!gmText.includes('engine_flag'));

  const privateNpc = buildSheetView({ ...input, visibility: 'gm' });
  assert.deepEqual(privateNpc, { rulepack, groups: [], computed: [] });
  assert.ok(JSON.stringify(buildSheetView({ ...input, visibility: 'gm', viewer: { role: 'gm' } })).includes('Vorhal'));
});

test('export sheet as portable json with rulepack provenance and field sources', () => {
  const schema = schemaOf([
    field('might', { label: 'Might' }),
    field('oath', { widget: 'text', custom: true }),
    field('guard', { derived: { expression: 'might * 2', refs: ['might'] } }),
  ]);
  const stats = statsOf({ schema, base: { might: 3 }, bonuses: [], constraints: [] });
  const input: SheetViewInput = {
    schema,
    profile: profileOf([{ id: 'oath', value: 'protect the weak' }]),
    stats,
    visibility: 'player',
    viewer: { role: 'player', owner: true },
  };
  const frozen = structuredClone(input);
  const exported = exportSheet(input);
  assert.deepEqual(input, frozen);
  assert.deepEqual(JSON.parse(JSON.stringify(exported)), exported);
  assert.deepEqual(exported, {
    format: SHEET_EXPORT_FORMAT,
    schema,
    entries: [
      { id: 'might', value: 3, source: 'core' },
      { id: 'oath', value: 'protect the weak', source: 'custom' },
      { id: 'guard', value: 6, source: 'computed' },
    ],
  });
  assert.deepEqual(importSheet(JSON.parse(JSON.stringify(exported))), { ok: true, sheet: exported });
});

test('import/export preserves custom fields without exposing private npc knowledge', () => {
  const schema = schemaOf([
    field('might'),
    field('grudge', { widget: 'text', visibility: 'owner', custom: true }),
    field('true_name', { widget: 'text', visibility: 'gm', custom: true }),
    field('curse', { visibility: 'gm' }),
    field('engine_flag', { widget: 'toggle', visibility: 'hidden' }),
    field('dread', { derived: { expression: 'curse + might', refs: ['curse', 'might'] } }),
  ]);
  const stats = statsOf({ schema, base: { might: 2, curse: 4 }, bonuses: [], constraints: [] });
  const input: SheetViewInput = {
    schema,
    profile: profileOf([
      { id: 'grudge', value: 'the duke' },
      { id: 'true_name', value: 'Vorhal' },
      { id: 'engine_flag', value: true },
    ]),
    stats,
    visibility: 'public',
    viewer: { role: 'player', owner: false },
  };
  const exported = exportSheet(input);
  const text = JSON.stringify(exported);
  for (const secret of ['duke', 'Vorhal', 'true_name', 'curse', 'engine_flag', 'grudge']) {
    assert.ok(!text.includes(secret), secret);
  }
  assert.deepEqual(exported.entries, [
    { id: 'might', value: 2, source: 'core' },
    { id: 'dread', value: 6, source: 'computed' },
  ]);
  assert.deepEqual(exported.schema.fields, [field('might'), field('dread')]);
  assert.deepEqual(exportSheet({ ...input, visibility: 'gm' }).entries, []);

  const owned = exportSheet({ ...input, viewer: { role: 'player', owner: true } });
  const imported = importSheet(JSON.parse(JSON.stringify(owned)));
  assert.equal(imported.ok, true);
  if (!imported.ok) return;
  assert.deepEqual(imported.sheet, owned);
  assert.deepEqual(
    imported.sheet.entries.find(({ id }) => id === 'grudge'),
    {
      id: 'grudge',
      value: 'the duke',
      source: 'custom',
    },
  );

  const tampered = structuredClone(owned) as unknown as Record<string, unknown>;
  const bad = [
    { ...tampered, format: 'other' },
    { ...tampered, entries: [{ id: 'unknown', value: 1, source: 'core' }] },
    { ...tampered, entries: [{ id: 'might', value: { nested: true }, source: 'core' }] },
    { ...tampered, entries: [{ id: 'might', value: 1, source: 'secret' }] },
    {
      ...tampered,
      entries: [
        { id: 'might', value: 1, source: 'core' },
        { id: 'might', value: 2, source: 'core' },
      ],
    },
    { ...tampered, schema: { schemaVersion: 0 } },
    null,
  ];
  for (const input of bad) assert.equal(importSheet(input).ok, false);
});
