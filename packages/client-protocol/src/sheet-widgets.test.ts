import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PROTOCOL_VERSION, parseCommand } from './protocol.ts';
import {
  parseSheetSchema,
  renderSheet,
  requestSheetEdit,
  type SheetSchema,
  UNRENDERABLE_VALUE,
} from './sheet-widgets.ts';

const schemaInput = {
  fields: [
    { id: 'name', label: 'Name', type: 'text', editable: true },
    { id: 'stress', label: 'Stress', type: 'number', editable: true },
    { id: 'wounded', label: 'Wounded', type: 'flag', editable: false },
    { id: 'title', label: 'Title', type: 'computed', template: '{name} ({stress} stress)' },
    { id: 'scar', label: 'Scar', type: 'text', editable: true, when: { field: 'wounded', equals: true } },
    { id: 'aura', label: 'Aura', type: 'dice-pool', editable: true },
  ],
};

const edit = { campaignId: 'c1', actionId: 'a1', actorId: 'pc1', expectedRevision: 3 };

const parsed = (input: unknown): SheetSchema => {
  const result = parseSheetSchema(input);
  assert.equal(result.ok, true, result.ok ? '' : result.error.message);
  return (result as { value: SheetSchema }).value;
};

test('render schema-driven fichas with computed labels, conditions and editable approved fields', () => {
  const schema = parsed(schemaInput);
  assert.ok(Object.isFrozen(schema));
  const values = { name: 'Ash', stress: 2, wounded: false };
  const widgets = renderSheet(schema, values);
  assert.deepEqual(
    widgets.slice(0, 4).map(({ id, kind, value, editable }) => ({ id, kind, value, editable })),
    [
      { id: 'name', kind: 'text', value: 'Ash', editable: true },
      { id: 'stress', kind: 'number', value: 2, editable: true },
      { id: 'wounded', kind: 'flag', value: false, editable: false },
      { id: 'title', kind: 'computed', value: 'Ash (2 stress)', editable: false },
    ],
  );
  assert.equal(
    widgets.some((widget) => widget.id === 'scar'),
    false,
  );
  assert.equal(
    renderSheet(schema, { ...values, wounded: true }).some((widget) => widget.id === 'scar'),
    true,
  );

  const request = requestSheetEdit(schema, values, { ...edit, fieldId: 'stress', value: 4 });
  assert.deepEqual(request, {
    ok: true,
    value: { version: PROTOCOL_VERSION, type: 'EditSheetField', ...edit, fieldId: 'stress', value: 4 },
  });
  assert.deepEqual(request.ok && parseCommand(request.value), request);
  assert.equal(values.stress, 2);
  for (const rejected of [
    { fieldId: 'stress', value: 'four' },
    { fieldId: 'wounded', value: true },
    { fieldId: 'title', value: 'x' },
    { fieldId: 'scar', value: 'burn' },
    { fieldId: 'missing', value: 'x' },
  ]) {
    assert.equal(requestSheetEdit(schema, values, { ...edit, ...rejected }).ok, false, rejected.fieldId);
  }

  for (const bad of [
    null,
    { fields: 'x' },
    { fields: [{ ...schemaInput.fields[0], script: 'x' }] },
    { fields: [{ ...schemaInput.fields[0], label: () => 'x' }] },
    { fields: [{ id: 't', label: 'T', type: 'computed', template: '{name}', editable: true }] },
    { fields: [{ id: 't', label: 'T', type: 'computed' }] },
    { fields: [schemaInput.fields[0], schemaInput.fields[0]] },
    { fields: [{ ...schemaInput.fields[4], when: { field: 'wounded', equals: {} } }] },
  ]) {
    assert.equal(parseSheetSchema(bad).ok, false, JSON.stringify(bad));
  }
});

test('unknown custom fields degrade gracefully without data loss', () => {
  const schema = parsed(schemaInput);
  const custom = { sigils: ['moon', 'tide'], depth: { level: 2 } };
  const values = { name: 'Ash', stress: 'high', aura: 5, ...custom };
  const snapshot = structuredClone(values);
  const widgets = renderSheet(schema, values);
  const byId = new Map(widgets.map((widget) => [widget.id, widget]));

  assert.deepEqual(byId.get('stress'), { id: 'stress', label: 'Stress', kind: 'raw', value: 'high', editable: false });
  assert.deepEqual(byId.get('aura'), { id: 'aura', label: 'Aura', kind: 'raw', value: 5, editable: false });
  assert.deepEqual(byId.get('sigils'), {
    id: 'sigils',
    label: 'sigils',
    kind: 'raw',
    value: custom.sigils,
    editable: false,
  });
  assert.deepEqual(byId.get('depth')?.value, custom.depth);
  assert.equal(byId.get('title')?.value, 'Ash (high stress)');
  assert.notEqual(byId.get('depth')?.value, values.depth);

  for (const fieldId of ['aura', 'sigils', 'depth']) {
    assert.equal(requestSheetEdit(schema, values, { ...edit, fieldId, value: 1 }).ok, false, fieldId);
  }
  const request = requestSheetEdit(schema, values, { ...edit, fieldId: 'name', value: 'Rook' });
  assert.equal(request.ok && request.value.fieldId, 'name');
  const committed = { ...values, name: 'Rook' };
  const rerendered = new Map(renderSheet(schema, committed).map((widget) => [widget.id, widget.value]));
  assert.deepEqual(rerendered.get('sigils'), custom.sigils);
  assert.deepEqual(rerendered.get('depth'), custom.depth);
  assert.equal(rerendered.get('aura'), 5);
  assert.deepEqual(values, snapshot);
});

test('sheet edit requests keep the envelope and reject invalid context', () => {
  const schema = parsed(schemaInput);
  const values = { name: 'Ash' };
  const spoofed = { ...edit, fieldId: 'name', value: 'Rook', type: 'DeleteCampaign', version: 99, extra: 1 };
  assert.deepEqual(requestSheetEdit(schema, values, spoofed), {
    ok: true,
    value: { version: PROTOCOL_VERSION, type: 'EditSheetField', ...edit, fieldId: 'name', value: 'Rook' },
  });
  for (const bad of [
    { campaignId: '' },
    { actionId: 1 },
    { actorId: undefined },
    { fieldId: '' },
    { expectedRevision: -1 },
    { expectedRevision: 1.5 },
    { expectedRevision: '3' },
  ]) {
    const input = { ...edit, fieldId: 'name', value: 'Rook', ...bad } as unknown as Parameters<
      typeof requestSheetEdit
    >[2];
    assert.equal(requestSheetEdit(schema, values, input).ok, false, JSON.stringify(bad));
  }
});

test('stored values under computed ids and uncloneable values stay visible as raw widgets', () => {
  const schema = parsed(schemaInput);
  const widgets = renderSheet(schema, { name: 'Ash', title: 'Stored', hook: () => 1, mark: Symbol('m') });
  const raw = widgets.filter((widget) => widget.kind === 'raw');
  assert.deepEqual(
    raw.map(({ id, value }) => ({ id, value })),
    [
      { id: 'aura', value: undefined },
      { id: 'title', value: 'Stored' },
      { id: 'hook', value: UNRENDERABLE_VALUE },
      { id: 'mark', value: UNRENDERABLE_VALUE },
    ],
  );
  assert.equal(widgets.find((widget) => widget.kind === 'computed')?.value, 'Ash ( stress)');
});
