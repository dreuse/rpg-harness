import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildCharacter, type CreationRules } from '../../../packages/rules/src/character-builder.ts';
import { SHEET_SCHEMA_VERSION, type SheetField } from '../../../packages/rules/src/sheet-schema.ts';
import { createCharacter, describedBuild } from './character-creation.ts';

const rulepack = { id: 'any-pack', edition: '2', revision: 'r1', sourceRefs: [] };

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
    rulepack,
    fields: [
      field('grit', { label: 'Grit' }),
      field('wits'),
      field('calling', { widget: 'choice', label: 'Calling', options: ['scout', 'healer'] }),
      field('nickname', { widget: 'text', custom: true }),
    ],
  },
  constraints: [
    { field: 'grit', min: 1, max: 5, onViolation: 'report' },
    { field: 'wits', min: 1, max: 5, onViolation: 'report' },
  ],
  startingEquipment: ['rope', 'lantern'],
  overridableFields: [],
};

const scripted = (answers: readonly string[]) => {
  const asked: string[] = [];
  const ask = async (question: string) => {
    asked.push(question);
    return answers[asked.length - 1];
  };
  return { asked, ask };
};

const created = ({ result }: Awaited<ReturnType<typeof createCharacter>>) => {
  assert.equal(result.status, 'created', JSON.stringify(result));
  return result.status === 'created' ? result.character : assert.fail();
};

test('create valid characters from descriptions or guided choices', async () => {
  const described = scripted([]);
  const fromDescription = await createCharacter(
    rules,
    'A healer named Ash with grit 3 and wits 2, carrying rope.',
    described.ask,
  );
  const fromText = created(fromDescription);
  assert.deepEqual(described.asked, []);
  assert.equal(fromText.profile.identity.name, 'Ash');
  assert.deepEqual(fromText.profile.traits, [
    { id: 'grit', value: 3 },
    { id: 'wits', value: 2 },
    { id: 'calling', value: 'healer' },
  ]);
  assert.deepEqual(fromText.equipment, ['rope']);

  const guided = scripted(['Bryn', '4', '1', 'Scout']);
  const fromChoices = created(await createCharacter(rules, '', guided.ask));
  assert.equal(guided.asked.length, 4);
  assert.equal(fromChoices.profile.identity.name, 'Bryn');
  assert.deepEqual(fromChoices.profile.traits, [
    { id: 'grit', value: 4 },
    { id: 'wits', value: 1 },
    { id: 'calling', value: 'scout' },
  ]);

  const replayed = buildCharacter(fromDescription.build);
  assert.deepEqual(replayed.status === 'created' ? replayed.character : undefined, fromText);
});

test('an ambiguous required mechanical choice is asked once, not silently invented', async () => {
  const unsure = scripted(['Ash', 'either']);
  const { result } = await createCharacter(rules, 'Ash, a scout or maybe a healer, grit 3 and wits 2.', unsure.ask);
  assert.equal(unsure.asked.length, 2);
  assert.match(unsure.asked[1] ?? '', /Calling.*scout, healer/);
  assert.equal(result.status, 'pending');
  assert.deepEqual(result.status === 'pending' ? result.questions.map(({ fieldId }) => fieldId) : [], ['calling']);

  const decided = scripted(['healer']);
  const character = created(
    await createCharacter(rules, 'Named Ash, a scout or maybe a healer, grit 3 and wits 2.', decided.ask),
  );
  assert.equal(decided.asked.length, 1);
  assert.deepEqual(character.profile.traits.at(-1), { id: 'calling', value: 'healer' });
});

test('a description cannot invent unsupported stats or items', async () => {
  const quiet = scripted([]);
  const { result: tooStrong } = await createCharacter(rules, 'A healer named Ash, grit 9, wits 2.', quiet.ask);
  assert.equal(tooStrong.status, 'rejected');
  assert.deepEqual(tooStrong.status === 'rejected' ? tooStrong.issues.map(({ path, code }) => [path, code]) : [], [
    ['proposal.values.grit', 'out_of_range'],
  ]);

  const character = created(
    await createCharacter(
      rules,
      'A healer named Ash, grit 3, wits 2, luck 18, with rope and a relic blade.',
      quiet.ask,
    ),
  );
  assert.deepEqual(quiet.asked, []);
  assert.deepEqual(
    character.profile.traits.map(({ id }) => id),
    ['grit', 'wits', 'calling'],
  );
  assert.deepEqual(character.equipment, ['rope']);
});

test('describedBuild falls back to a short name from the first clause', () => {
  const build = describedBuild(rules, 'Weathered river pilot who never sails twice, grit 3');
  assert.equal(build.proposal.name, 'Weathered river pilot who');
  assert.equal(describedBuild(rules, 'Ash').proposal.name, 'Ash');
});
