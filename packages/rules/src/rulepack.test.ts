import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_RULES_USAGE } from '../../domain/src/rules-usage.ts';
import {
  CapabilityDisabledError,
  capabilityState,
  listCapabilities,
  RULEPACK_CONTRACT_VERSION,
  type RulePackManifest,
  requireCapability,
  rulesUsageOf,
  SUPPORTED_PRIMITIVES,
  validateManifest,
} from './rulepack.ts';

const ROLL = 'roll';
const SOCIAL = 'social';
const CUSTOM = 'x-homebrew';
const MISSING = 'combat';
const UNSUPPORTED_VERSION = RULEPACK_CONTRACT_VERSION + 1;
const FORBIDDEN_REQUIRED_NAMES = ['d20', 'dice', 'combat', 'stats', 'strength'];

const manifest = (overrides: Partial<RulePackManifest> = {}): RulePackManifest => ({
  contractVersion: RULEPACK_CONTRACT_VERSION,
  id: 'pack',
  edition: 'lite',
  revision: '1',
  capabilities: {},
  sourceRefs: [],
  ...overrides,
});

test('versioned mechanical contracts, supported primitives and capability introspection', () => {
  assert.ok(SUPPORTED_PRIMITIVES.includes('random'));
  assert.ok(SUPPORTED_PRIMITIVES.includes('effects'));

  const valid = manifest({
    capabilities: { [ROLL]: true, [SOCIAL]: 'adjudicated', [CUSTOM]: false },
    characterSheetSchemaId: 'sheet',
    sourceRefs: ['srd#1'],
  });
  assert.deepEqual(validateManifest(valid), { ok: true, manifest: valid });

  const invalid = validateManifest({
    contractVersion: UNSUPPORTED_VERSION,
    id: '',
    edition: 1,
    capabilities: { [ROLL]: 'yes' },
    characterSheetSchemaId: 2,
    sourceRefs: [3],
  });
  assert.equal(invalid.ok, false);
  assert.deepEqual(invalid.ok ? [] : invalid.issues.map((issue) => issue.path), [
    'contractVersion',
    'id',
    'edition',
    'revision',
    `capabilities.${ROLL}`,
    'characterSheetSchemaId',
    'sourceRefs.0',
  ]);
  assert.equal(validateManifest(null).ok, false);
  assert.equal(validateManifest({ ...valid, capabilities: [] }).ok, false);

  assert.equal(capabilityState(valid, ROLL), 'deterministic');
  assert.equal(capabilityState(valid, SOCIAL), 'adjudicated');
  assert.equal(capabilityState(valid, CUSTOM), 'disabled');
  assert.equal(capabilityState(valid, MISSING), 'disabled');
  assert.deepEqual(listCapabilities(valid), [
    { name: ROLL, state: 'deterministic' },
    { name: SOCIAL, state: 'adjudicated' },
    { name: CUSTOM, state: 'disabled' },
  ]);

  assert.equal(requireCapability(valid, ROLL), 'deterministic');
  assert.equal(requireCapability(valid, SOCIAL), 'adjudicated');
  assert.throws(
    () => requireCapability(valid, MISSING),
    (error) =>
      error instanceof CapabilityDisabledError &&
      error.code === 'CapabilityDisabled' &&
      error.packId === valid.id &&
      error.capability === MISSING,
  );
});

test('rejects non-plain objects and snapshots the validated manifest', () => {
  class Capabilities {}
  assert.equal(validateManifest(manifest({ capabilities: new Map() as never })).ok, false);
  assert.equal(validateManifest(manifest({ capabilities: new Capabilities() as never })).ok, false);
  assert.equal(validateManifest(manifest({ capabilities: new Date() as never })).ok, false);
  assert.equal(validateManifest(new Date()).ok, false);
  assert.equal(validateManifest(Object.assign(new Capabilities(), manifest())).ok, false);
  assert.equal(validateManifest(manifest({ capabilities: { '': true } })).ok, false);
  assert.equal(
    validateManifest({ ...manifest(), capabilities: Object.assign(Object.create(null), { [ROLL]: true }) }).ok,
    true,
  );

  let rollValue: unknown = true;
  const input = {
    ...manifest(),
    capabilities: {
      get [ROLL]() {
        return rollValue;
      },
    },
    sourceRefs: ['srd#1'],
  };
  const result = validateManifest(input);
  rollValue = false;
  input.sourceRefs.push('srd#2');
  assert.ok(result.ok);
  assert.notEqual(result.manifest, input);
  assert.equal(capabilityState(result.manifest, ROLL), 'deterministic');
  assert.deepEqual(result.manifest.sourceRefs, ['srd#1']);
});

test('lists prototype-named capability keys as own data', () => {
  const capabilities = JSON.parse('{"__proto__":true,"constructor":"adjudicated"}');
  const result = validateManifest(manifest({ capabilities }));
  assert.ok(result.ok);
  assert.deepEqual(listCapabilities(result.manifest), [
    { name: '__proto__', state: 'deterministic' },
    { name: 'constructor', state: 'adjudicated' },
  ]);
  assert.equal(capabilityState(result.manifest, 'toString'), 'disabled');
});

test('no default d20 stat, dice or combat field is required', () => {
  const narrativeOnly = {
    contractVersion: RULEPACK_CONTRACT_VERSION,
    id: 'narrative',
    edition: 'v1',
    revision: '1',
    capabilities: {},
    sourceRefs: [],
  };
  assert.deepEqual(validateManifest(narrativeOnly), { ok: true, manifest: narrativeOnly });

  const issues = validateManifest({});
  const requiredPaths = issues.ok ? [] : issues.issues.map((issue) => issue.path.toLowerCase());
  for (const name of FORBIDDEN_REQUIRED_NAMES) {
    assert.ok(!requiredPaths.some((path) => path.includes(name)), name);
  }
  assert.deepEqual(listCapabilities(manifest()), []);
});

test('declares resolution style and sheet usage, with defaults for packs that omit them', () => {
  const declared = manifest({ resolution: 'adjudicated', sheet: 'none' });
  assert.deepEqual(validateManifest(declared), { ok: true, manifest: declared });
  assert.deepEqual(rulesUsageOf(declared), { resolution: 'adjudicated', sheet: 'none' });
  assert.deepEqual(rulesUsageOf(manifest()), DEFAULT_RULES_USAGE);
  const bad = validateManifest({ ...manifest(), resolution: 'coin', sheet: 'huge' });
  assert.deepEqual(bad.ok ? [] : bad.issues.map(({ path }) => path), ['resolution', 'sheet']);
});

test('rpg-42a.58: a manifest carries an optional style and rejects a malformed one', () => {
  const style = { tone: ['heroic'], keepOutOfProse: ['raw DCs'] };
  const styled = validateManifest({ ...manifest(), style });
  assert.equal(styled.ok && styled.manifest.style?.tone?.[0], 'heroic');
  const plain = validateManifest(manifest());
  assert.equal(plain.ok && Object.hasOwn(plain.manifest, 'style'), false);
  const bad = validateManifest({ ...manifest(), style: { tone: 'heroic' } });
  assert.equal(bad.ok, false);
  assert.deepEqual(!bad.ok && bad.issues.map(({ path }) => path), ['style']);
});
