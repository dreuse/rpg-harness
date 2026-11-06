import assert from 'node:assert/strict';
import { test } from 'node:test';
import { contentText } from './content-names.ts';

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
  assert.equal(contentText('es', 'stat', 'Might', 'Might'), 'Might');
});
