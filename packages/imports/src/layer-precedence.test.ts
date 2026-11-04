import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type LayerKind, type RuleLayer, resolveLayers } from './layer-precedence.ts';
import type { RulePackRef } from './preview.ts';

const PACK = { id: 'pack', edition: 'core', revision: '1' } as const satisfies RulePackRef;
const OTHER_EDITION = 'second';
const OTHER_REVISION = '2';
const BASE = 'base-text';
const SUPPLEMENT_A = 'supplement-a';
const SUPPLEMENT_B = 'supplement-b';
const ERRATA = 'errata-1';
const OTHER_ERRATA = 'errata-2';
const OPTION = 'option-1';
const CAMPAIGN = 'campaign-override';
const UNKNOWN_SOURCE = 'unknown-source';
const ENTRY_ID = 'rest';

const layer = (
  kind: LayerKind,
  sourceRef: string,
  entries: Record<string, unknown>,
  rulePack: RulePackRef = PACK,
): RuleLayer => ({
  kind,
  sourceRef,
  rulePack,
  entries: Object.entries(entries).map(([id, value]) => ({ id, revision: sourceRef, value })),
});

test('I13 support precedence of campaign overrides, options, errata, supplements and base texts', () => {
  const layers = [
    layer('campaign', CAMPAIGN, { campaign: 'campaign' }),
    layer('base', BASE, { base: 'base', supplement: 'base', errata: 'base', option: 'base', campaign: 'base' }),
    layer('supplement', SUPPLEMENT_B, { supplement: 'b', errata: 'b' }),
    layer('errata', ERRATA, { errata: 'errata', option: 'errata', campaign: 'errata' }),
    layer('supplement', SUPPLEMENT_A, { supplement: 'a', option: 'a' }),
    layer('option', OPTION, { option: 'option', campaign: 'option' }),
  ];
  const result = resolveLayers({ rulePack: PACK, layers, supplementOrder: [SUPPLEMENT_A, SUPPLEMENT_B] });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.resolved.rulePack, PACK);
  const byId = Object.fromEntries(result.resolved.entries.map((entry) => [entry.id, entry]));
  assert.deepEqual(
    result.resolved.entries.map(({ id, value, source }) => [id, value, source.sourceRef]),
    [
      ['base', 'base', BASE],
      ['campaign', 'campaign', CAMPAIGN],
      ['errata', 'errata', ERRATA],
      ['option', 'option', OPTION],
      ['supplement', 'b', SUPPLEMENT_B],
    ],
  );
  assert.deepEqual(byId.campaign?.source, { kind: 'campaign', sourceRef: CAMPAIGN, revision: CAMPAIGN });
  assert.deepEqual(
    byId.campaign?.shadowed.map(({ kind, sourceRef }) => [kind, sourceRef]),
    [
      ['option', OPTION],
      ['errata', ERRATA],
      ['base', BASE],
    ],
  );
  assert.deepEqual(
    byId.supplement?.shadowed.map(({ sourceRef }) => sourceRef),
    [SUPPLEMENT_A, BASE],
  );
  assert.equal(byId.option?.resolution, 'precedence');
  assert.equal(Object.isFrozen(result.resolved), true);
});

test('I13 version conflicts require explicit resolution; mixed editions are not merged silently', () => {
  const base = layer('base', BASE, { [ENTRY_ID]: 'base' });
  const mixed = resolveLayers({
    rulePack: PACK,
    layers: [base, layer('errata', ERRATA, { [ENTRY_ID]: 'new' }, { ...PACK, edition: OTHER_EDITION })],
  });
  assert.equal(mixed.ok, false);
  if (mixed.ok) return;
  assert.equal(mixed.error.code, 'EditionMismatch');
  assert.deepEqual(mixed.error.issues, [{ path: 'layers.1.rulePack.edition', message: `must be ${PACK.edition}` }]);

  const errata = [
    base,
    layer('errata', ERRATA, { [ENTRY_ID]: 'one' }),
    layer('errata', OTHER_ERRATA, { [ENTRY_ID]: 'two' }),
  ];
  const conflict = resolveLayers({ rulePack: PACK, layers: errata });
  assert.equal(conflict.ok, false);
  if (conflict.ok) return;
  assert.equal(conflict.error.code, 'VersionConflict');
  assert.deepEqual(conflict.error.issues, [
    { path: `resolutions.${ENTRY_ID}`, message: `must name one of ${ERRATA}, ${OTHER_ERRATA}` },
  ]);

  const unordered = [
    layer('supplement', SUPPLEMENT_A, { [ENTRY_ID]: 'a' }),
    layer('supplement', SUPPLEMENT_B, { [ENTRY_ID]: 'b' }),
  ];
  const tie = resolveLayers({ rulePack: PACK, layers: unordered });
  assert.equal(tie.ok === false && tie.error.code, 'VersionConflict');

  const invalid = resolveLayers({ rulePack: PACK, layers: errata, resolutions: { [ENTRY_ID]: BASE } });
  assert.equal(invalid.ok === false && invalid.error.code, 'InvalidResolution');
  const stray = resolveLayers({
    rulePack: PACK,
    layers: errata,
    resolutions: { [ENTRY_ID]: OTHER_ERRATA, other: UNKNOWN_SOURCE },
  });
  assert.equal(stray.ok === false && stray.error.code, 'InvalidResolution');

  const explicit = resolveLayers({ rulePack: PACK, layers: errata, resolutions: { [ENTRY_ID]: OTHER_ERRATA } });
  assert.equal(explicit.ok, true);
  if (!explicit.ok) return;
  const [entry] = explicit.resolved.entries;
  assert.equal(entry?.value, 'two');
  assert.equal(entry?.resolution, 'explicit');
  assert.deepEqual(
    entry?.shadowed.map(({ sourceRef }) => sourceRef),
    [ERRATA, BASE],
  );

  const badOrder = resolveLayers({
    rulePack: PACK,
    layers: unordered,
    supplementOrder: [SUPPLEMENT_A, UNKNOWN_SOURCE],
  });
  assert.equal(badOrder.ok === false && badOrder.error.code, 'InvalidSupplementOrder');
  const duplicate = resolveLayers({ rulePack: PACK, layers: [base, base] });
  assert.equal(duplicate.ok === false && duplicate.error.code, 'DuplicateSource');
  const otherPack = resolveLayers({ rulePack: PACK, layers: [layer('base', BASE, {}, { ...PACK, id: 'other' })] });
  assert.equal(otherPack.ok === false && otherPack.error.code, 'RulePackMismatch');
});

test('I13 identical tied entries need no resolution and non-data layers are rejected', () => {
  const same = [
    layer('errata', ERRATA, { [ENTRY_ID]: 'same' }),
    { ...layer('errata', OTHER_ERRATA, {}), entries: [{ id: ENTRY_ID, revision: ERRATA, value: 'same' }] },
  ];
  const result = resolveLayers({ rulePack: PACK, layers: same });
  assert.equal(result.ok && result.resolved.entries[0]?.source.sourceRef, ERRATA);
  const invalid = resolveLayers({ rulePack: PACK, layers: [layer('base', BASE, { [ENTRY_ID]: () => ENTRY_ID })] });
  assert.equal(invalid.ok === false && invalid.error.code, 'InvalidLayer');
});

test('I13 malformed layers fail with InvalidLayer paths', () => {
  const unknownKind = resolveLayers({
    rulePack: PACK,
    layers: [{ ...layer('base', BASE, {}), kind: 'homebrew' as LayerKind }],
  });
  assert.deepEqual(unknownKind.ok === false && unknownKind.error, {
    code: 'InvalidLayer',
    issues: [{ path: 'layers.0.kind', message: 'must be one of base, supplement, errata, option, campaign' }],
  });
  const noEntries = resolveLayers({
    rulePack: PACK,
    layers: [{ ...layer('base', BASE, {}), entries: ENTRY_ID as unknown as RuleLayer['entries'] }],
  });
  assert.deepEqual(noEntries.ok === false && noEntries.error, {
    code: 'InvalidLayer',
    issues: [{ path: 'layers.0.entries', message: 'must be an array' }],
  });
});

test('I13 layers pinned to another revision fail with RevisionMismatch', () => {
  const drift = resolveLayers({
    rulePack: PACK,
    layers: [layer('base', BASE, {}), layer('errata', ERRATA, {}, { ...PACK, revision: OTHER_REVISION })],
  });
  assert.deepEqual(drift.ok === false && drift.error, {
    code: 'RevisionMismatch',
    issues: [{ path: 'layers.1.rulePack.revision', message: `must be ${PACK.revision}` }],
  });
});

test('I13 duplicate supplement order refs report their paths', () => {
  const layers = [layer('supplement', SUPPLEMENT_A, {}), layer('supplement', SUPPLEMENT_B, {})];
  const result = resolveLayers({ rulePack: PACK, layers, supplementOrder: [SUPPLEMENT_A, SUPPLEMENT_B, SUPPLEMENT_A] });
  assert.deepEqual(result.ok === false && result.error, {
    code: 'InvalidSupplementOrder',
    issues: [{ path: 'supplementOrder.2', message: `${SUPPLEMENT_A} is listed more than once` }],
  });
});

test('I13 conflict message lists contenders sorted by source ref', () => {
  const layers = [layer('errata', OTHER_ERRATA, { [ENTRY_ID]: 'two' }), layer('errata', ERRATA, { [ENTRY_ID]: 'one' })];
  const result = resolveLayers({ rulePack: PACK, layers });
  assert.deepEqual(result.ok === false && result.error.issues, [
    { path: `resolutions.${ENTRY_ID}`, message: `must name one of ${ERRATA}, ${OTHER_ERRATA}` },
  ]);
});
