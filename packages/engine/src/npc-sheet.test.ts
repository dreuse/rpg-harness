import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Fact } from '../../memory/src/knowledge.ts';
import type { CreationRules } from '../../rules/src/character-builder.ts';
import { SHEET_SCHEMA_VERSION, type SheetField } from '../../rules/src/sheet-schema.ts';
import { assignNpcRole, type FullNpcSheet, npcPreview, type SparseNpcSheet } from './npc-sheet.ts';

const CAMPAIGN_ID = 'campaign-1';
const NPC_ID = 'npc-warden';
const PROVENANCE = { id: 'any-pack', edition: '2', revision: 'r7', sourceRefs: ['srd:npcs'] };
const RULEPACK_LINK = { id: PROVENANCE.id, edition: PROVENANCE.edition, revision: PROVENANCE.revision };
const PRIVATE_GOAL = 'SECRET-GOAL: open the sea gate for the smugglers';
const SECRET_BACKGROUND = 'SECRET-PAST: was a smuggler captain';
const SECRET_IDENTITY = 'SECRET-ALIAS: the Gull';
const SECRET_ALLEGIANCE = 'SECRET-ALLEGIANCE: smuggler ring';
const SECRET_SCAR = 'SECRET-SCAR: brand of the ring';
const SECRET_MOOD = 'SECRET-MOOD: terrified';
const SECRET_FACT = 'SECRET-FACT: the warden holds the gate key';
const SECRET_KNOWLEDGE = 'SECRET-KNOWLEDGE: the warden knows the hero is a spy';
const SECRET_RELATIONSHIP = 'SECRET-RELATIONSHIP: the warden owes the smuggler a life debt';
const PUBLIC_FACT = 'The warden keeps the harbor lamps lit.';
const SECRET_MARKER = 'SECRET-';

const field = (id: string, extra: Partial<SheetField> = {}): SheetField => ({
  id,
  widget: 'number',
  custom: false,
  visibility: 'public',
  ...extra,
});

const rules: CreationRules = {
  schema: {
    schemaVersion: SHEET_SCHEMA_VERSION,
    rulepack: PROVENANCE,
    fields: [
      field('grit', { label: 'Grit' }),
      field('nerve'),
      field('allegiance', { widget: 'text', visibility: 'gm' }),
      field('scar', { widget: 'text', visibility: 'hidden' }),
      field('mood', { widget: 'text', visibility: 'owner' }),
      field('guard', { derived: { expression: 'grit + nerve', refs: ['grit', 'nerve'] } }),
    ],
  },
  constraints: [{ field: 'grit', min: 0, max: 5, onViolation: 'report' }],
  startingEquipment: [],
  overridableFields: [],
};

const sparse: SparseNpcSheet = {
  detail: 'sparse',
  npcId: NPC_ID,
  role: 'minor',
  name: 'Warden Oslo',
  motivations: [PRIVATE_GOAL],
  background: SECRET_BACKGROUND,
  traits: [{ id: 'grit', value: 2 }],
  rulepack: RULEPACK_LINK,
};

const fact = (id: string, statement: string, overrides: Partial<Fact> = {}): Fact => ({
  id,
  campaignId: CAMPAIGN_ID,
  subjectId: NPC_ID,
  statement,
  layer: 'canon',
  visibility: 'public',
  actorId: null,
  sourceEventId: null,
  ...overrides,
});

const facts: Fact[] = [
  fact('public', PUBLIC_FACT),
  fact('gm-secret', SECRET_FACT, { visibility: 'gm' }),
  fact('npc-knowledge', SECRET_KNOWLEDGE, { visibility: 'actor-scoped', actorId: NPC_ID, subjectId: 'hero' }),
  fact('own-knowledge', SECRET_KNOWLEDGE, { visibility: 'actor-scoped', actorId: NPC_ID }),
  fact('hidden-relationship', SECRET_RELATIONSHIP, { visibility: 'gm', layer: 'belief' }),
  fact('other-npc', 'The smuggler sings off key.', { subjectId: 'npc-smuggler' }),
];

const expand = (values: Record<string, number | string>) => {
  const result = assignNpcRole(sparse, 'major', { rules, values });
  assert.equal(result.status, 'expanded');
  return (result as { sheet: FullNpcSheet }).sheet;
};

test('support sparse npc profiles and expand to full schema if narrative role grows', () => {
  assert.deepEqual(assignNpcRole(sparse, 'minor', { rules, values: {} }), { status: 'sparse', sheet: sparse });

  const pending = assignNpcRole(sparse, 'major', { rules, values: {} });
  assert.deepEqual(pending, { status: 'pending', questions: [{ fieldId: 'nerve', widget: 'number' }] });

  const full = expand({ nerve: 3, allegiance: SECRET_ALLEGIANCE });
  assert.deepEqual(full, {
    detail: 'full',
    npcId: NPC_ID,
    role: 'major',
    profile: {
      identity: { name: 'Warden Oslo' },
      motivations: [PRIVATE_GOAL],
      background: SECRET_BACKGROUND,
      traits: [
        { id: 'grit', value: 2 },
        { id: 'nerve', value: 3 },
        { id: 'allegiance', value: SECRET_ALLEGIANCE },
      ],
      conditions: [],
      rulepack: RULEPACK_LINK,
    },
    rulepack: PROVENANCE,
  });
  assert.notEqual(full.rulepack, PROVENANCE);

  assert.deepEqual(assignNpcRole(full, 'minor', { rules, values: {} }), {
    status: 'expanded',
    sheet: { ...full, role: 'minor' },
  });

  const rejected = assignNpcRole(sparse, 'major', { rules, values: { grit: 9, nerve: 1 } });
  assert.equal(rejected.status, 'rejected');

  const otherEdition = { ...sparse, rulepack: { ...RULEPACK_LINK, edition: '1' } };
  assert.deepEqual(assignNpcRole(otherEdition, 'major', { rules, values: { nerve: 1 } }), {
    status: 'rejected',
    issues: [{ path: 'rulepack', code: 'invalid', message: 'must match the sheet schema rulepack' }],
  });
});

test('npc player-facing preview cannot reveal secrets or private goals', () => {
  const full = expand({ nerve: 3, allegiance: SECRET_ALLEGIANCE, scar: SECRET_SCAR, mood: SECRET_MOOD });
  const disguised: FullNpcSheet = {
    ...full,
    profile: { ...full.profile, identity: { ...full.profile.identity, alias: SECRET_IDENTITY } },
  };
  const expected = {
    npcId: NPC_ID,
    name: 'Warden Oslo',
    traits: [
      { id: 'grit', label: 'Grit', value: 2 },
      { id: 'nerve', value: 3 },
    ],
    facts: [PUBLIC_FACT],
  };

  for (const sheet of [sparse, disguised]) {
    const preview = npcPreview(sheet, rules.schema, facts, 'public');
    assert.doesNotMatch(JSON.stringify(preview), new RegExp(SECRET_MARKER));
    if (sheet === disguised) assert.deepEqual(preview, expected);
  }
  assert.deepEqual(npcPreview(sparse, rules.schema, facts, 'public'), { ...expected, traits: [expected.traits[0]] });
});

test('npc player-facing preview reveals nothing for a gm-only npc', () => {
  const hidden = { ...sparse, name: 'SECRET-NAME: the Gull', traits: [{ id: 'grit', value: 'SECRET-TRAIT' }] };
  assert.deepEqual(npcPreview(hidden, rules.schema, facts, 'gm'), { npcId: NPC_ID, name: '', traits: [], facts: [] });
});

test('npc player-facing preview drops traits when the sheet rulepack differs from the schema', () => {
  const otherRevision = { ...RULEPACK_LINK, revision: 'r1' };
  const full = expand({ nerve: 3 });
  const sheets = [
    { ...sparse, rulepack: otherRevision },
    { ...full, profile: { ...full.profile, rulepack: otherRevision } },
  ];
  for (const sheet of sheets) assert.deepEqual(npcPreview(sheet, rules.schema, facts, 'public').traits, []);
});
