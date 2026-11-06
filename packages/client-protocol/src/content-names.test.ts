import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as packs from '../../content/src/packs.ts';
import { D20_LITE_CREATION } from '../../rules/src/d20-lite.ts';
import { contentText } from './content-names.ts';

const TRANSLATED_LOCALES = ['es', 'pt-BR'];
const ENGLISH = 'en';
const IMPORTED_ID = 'acme-noir';
const MISSING = '\u0000missing';

const builtInLabels = () => {
  const genres = Object.values(packs).map(({ genre }) => genre);
  const stats = D20_LITE_CREATION.schema.fields.flatMap(({ label }) => (label === undefined ? [] : [label]));
  return [
    ...genres.map(({ id, name }) => ['genre', id, name] as const),
    ...genres.map(({ id, name, examples }) => ['genre.blurb', id, examples[0] ?? name] as const),
    ...genres.flatMap(({ archetypes }) => archetypes.map(({ name }) => ['archetype', name, name] as const)),
    ...genres.flatMap(({ archetypes }) =>
      archetypes.map(({ name, summary }) => ['archetype.summary', name, summary] as const),
    ),
    ...stats.map((label) => ['stat', label, label] as const),
  ];
};

for (const locale of TRANSLATED_LOCALES) {
  test(`rpg-42a.72 every built-in pack label has a ${locale} string`, () => {
    for (const [kind, id] of builtInLabels()) {
      assert.notEqual(contentText(locale, kind, id, MISSING), MISSING, `${locale} ${kind} ${id}`);
    }
  });

  test(`rpg-42a.72 imported pack text stays unchanged in ${locale}`, () => {
    assert.equal(contentText(locale, 'genre', IMPORTED_ID, 'Acme noir'), 'Acme noir');
    assert.equal(contentText(locale, 'archetype', 'Gumshoe', 'Gumshoe'), 'Gumshoe');
    assert.equal(contentText(locale, 'stat', 'Grit', 'Grit'), 'Grit');
  });
}

test('rpg-42a.72 English keeps the pack text', () => {
  for (const [kind, id, english] of builtInLabels()) assert.equal(contentText(ENGLISH, kind, id, english), english);
});

test('rpg-42a.53 built-in genre, character and stat names read in Brazilian Portuguese', () => {
  assert.equal(contentText('pt-BR', 'genre', 'fantasy', 'Fantasy'), 'Fantasia');
  assert.equal(
    contentText('pt-BR', 'genre.blurb', 'horror', 'x'),
    'O arranhar parou no instante em que você prendeu a respiração.',
  );
  assert.equal(contentText('pt-BR', 'archetype', 'Hedge witch', 'Hedge witch'), 'Bruxa do campo');
  assert.equal(
    contentText('pt-BR', 'archetype.summary', 'Pilot', 'x'),
    'Leva as pessoas para dentro e para fora quando as estradas fecham',
  );
  assert.equal(contentText('pt-BR', 'stat', 'Wits', 'Wits'), 'Raciocínio');
});

test('rpg-42a.53 content the pack names itself keeps the pack text, in every locale', () => {
  assert.equal(contentText('pt-BR', 'genre', 'acme-noir', 'Acme noir'), 'Acme noir');
  assert.equal(contentText('en', 'genre', 'fantasy', 'Fantasy'), 'Fantasy');
  assert.equal(contentText('es', 'stat', 'Grit', 'Grit'), 'Grit');
});
