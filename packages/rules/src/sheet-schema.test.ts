import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SHEET_SCHEMA_VERSION, validateSheetSchema } from './sheet-schema.ts';

const rulepack = { id: 'any-pack', edition: '1', revision: 'r2', sourceRefs: ['srd:p1'] };

const schema = (fields: unknown[], overrides: Record<string, unknown> = {}) => ({
  schemaVersion: SHEET_SCHEMA_VERSION,
  rulepack,
  fields,
  ...overrides,
});

const issuesOf = (input: unknown) => {
  const result = validateSheetSchema(input);
  assert.equal(result.ok, false);
  return result.ok ? [] : result.issues;
};

test('support typed widgets, custom fields, visibility, derived expressions and stable ids', () => {
  const result = validateSheetSchema(
    schema([
      { id: 'name', widget: 'text', label: 'Name' },
      { id: 'grit', widget: 'number' },
      { id: 'stamina', widget: 'resource' },
      { id: 'sworn', widget: 'toggle' },
      { id: 'path', widget: 'choice', options: ['a', 'b'] },
      { id: 'secret', widget: 'text', custom: true, visibility: 'gm' },
      { id: 'resolve', widget: 'number', derived: { expression: 'grit + stamina', refs: ['grit', 'stamina'] } },
    ]),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.schema.schemaVersion, SHEET_SCHEMA_VERSION);
  assert.deepEqual(result.schema.rulepack, rulepack);
  assert.deepEqual(
    result.schema.fields.map((field) => field.id),
    ['name', 'grit', 'stamina', 'sworn', 'path', 'secret', 'resolve'],
  );
  assert.equal(result.schema.fields[5]?.custom, true);
  assert.equal(result.schema.fields[5]?.visibility, 'gm');
  assert.equal(result.schema.fields[0]?.visibility, 'public');
  assert.equal(result.schema.fields[6]?.derived?.expression, 'grit + stamina');
});

test('narrative character has valid sheet without numerical stats', () => {
  const result = validateSheetSchema(
    schema([
      { id: 'concept', widget: 'text' },
      { id: 'aspects', widget: 'tag' },
      { id: 'role', widget: 'choice', options: ['face', 'muscle'] },
    ]),
  );
  assert.equal(result.ok, true);
});

test('reject duplicate field ids', () => {
  const issues = issuesOf(
    schema([
      { id: 'a', widget: 'text' },
      { id: 'a', widget: 'tag' },
    ]),
  );
  assert.deepEqual(issues, [{ path: 'fields.1.id', code: 'duplicate', message: 'must be unique' }]);
});

test('reject derived expression referencing unknown field id', () => {
  const issues = issuesOf(
    schema([{ id: 'a', widget: 'number', derived: { expression: 'ghost + 1', refs: ['ghost'] } }]),
  );
  assert.deepEqual(issues, [
    { path: 'fields.0.derived.refs.0', code: 'unknown_reference', message: 'must reference a declared field' },
  ]);
});

test('reject unknown widget type', () => {
  const issues = issuesOf(schema([{ id: 'a', widget: 'hologram' }]));
  assert.equal(issues[0]?.path, 'fields.0.widget');
  assert.equal(issues[0]?.code, 'unsupported');
});

test('reject missing schema version', () => {
  const issues = issuesOf({ rulepack, fields: [] });
  assert.deepEqual(issues, [
    { path: 'schemaVersion', code: 'unsupported', message: `must be ${SHEET_SCHEMA_VERSION}` },
  ]);
});

test('reject missing provenance, bad visibility and choice without options', () => {
  const issues = issuesOf({
    schemaVersion: SHEET_SCHEMA_VERSION,
    fields: [{ id: 'a', widget: 'choice', visibility: 'nobody' }],
  });
  assert.deepEqual(
    issues.map((issue) => `${issue.path}:${issue.code}`),
    ['rulepack:missing', 'fields.0.visibility:unsupported', 'fields.0.options:invalid'],
  );
});

test('reject derived cycles', () => {
  const self = issuesOf(schema([{ id: 'a', widget: 'number', derived: { expression: 'a', refs: ['a'] } }]));
  assert.equal(self[0]?.code, 'cycle');
  const mutual = issuesOf(
    schema([
      { id: 'a', widget: 'number', derived: { expression: 'b', refs: ['b'] } },
      { id: 'b', widget: 'number', derived: { expression: 'a', refs: ['a'] } },
    ]),
  );
  assert.deepEqual(
    mutual.map((issue) => `${issue.path}:${issue.code}`),
    ['fields.0.derived.refs:cycle', 'fields.1.derived.refs:cycle'],
  );
});

test('reject unknown field keys', () => {
  const issues = issuesOf(schema([{ id: 'secret', widget: 'text', visiblity: 'gm' }]));
  assert.deepEqual(issues, [{ path: 'fields.0.visiblity', code: 'unsupported', message: 'is not a supported key' }]);
});

test('reject array holes in string lists', () => {
  const issues = issuesOf(schema([{ id: 'a', widget: 'choice', options: new Array(1) }]));
  assert.equal(issues[0]?.path, 'fields.0.options');
});
