import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { contentAliases } from '../../../packages/client-protocol/src/content-names.ts';
import { PROTOCOL_VERSION } from '../../../packages/client-protocol/src/protocol.ts';
import { ATTRIBUTE_AVERAGE } from '../../../packages/rules/src/d20-lite.ts';
import { createCampaignFrom, createEngineGateway } from './engine-gateway.ts';
import { BUILT_IN_PACKS } from './import-gateway.ts';
import { planCampaign, startingCharacter, startOptions } from './quickstart.ts';

const D20_PITCH = 'A fantasy adventure using the D20-Lite rules';
const DEFAULT_NAMES = { en: 'The Wanderer', 'pt-BR': 'O Andarilho', es: 'El Caminante' };

const dataDirFor = (t: TestContext) => {
  const dir = mkdtempSync(join(tmpdir(), 'rpg-premade-'));
  mkdirSync(dir, { recursive: true });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const collect = async (stream: AsyncIterable<string>) => {
  const parts: string[] = [];
  for await (const part of stream) parts.push(part);
  return parts.join('\n');
};

test('rpg-asjw.4 every genre premade starts under every built-in ruleset, in every language', () => {
  for (const { id: genre, characters } of startOptions().genres)
    for (const { id, edition } of BUILT_IN_PACKS)
      for (const { id: archetype, name } of characters)
        for (const character of [name, ...contentAliases('archetype', archetype ?? name)]) {
          const config = planCampaign(undefined, { ruleset: { id, edition }, genre, character });
          assert.ok(startingCharacter(config), `${genre}/${id}/${character}`);
        }
});

test('rpg-asjw.4 a skipped character gets a localized default name and a sheet under d20', async (t) => {
  for (const [locale, hero] of Object.entries(DEFAULT_NAMES)) {
    const dataDir = dataDirFor(t);
    const gateway = createEngineGateway(dataDir);
    await collect(gateway.create('Ember', D20_PITCH, async () => '', undefined, locale));
    const sheet = gateway.view('Ember', 'sheet', locale);
    assert.ok(sheet.startsWith(hero), sheet);
    assert.match(sheet, /d20-lite/);
  }
});

const PORTUGUESE = 'pt-BR';
const D20_MYSTERY = { ruleset: { id: 'd20-lite', edition: 'original' }, genre: 'mystery' };

const startedSheet = async (t: TestContext, character?: string) => {
  const dataDir = dataDirFor(t);
  const choices = character === undefined ? D20_MYSTERY : { ...D20_MYSTERY, character };
  await createCampaignFrom(dataDir, {
    version: PROTOCOL_VERSION,
    type: 'CreateCampaign',
    name: 'Ember',
    language: PORTUGUESE,
    choices,
  });
  return createEngineGateway(dataDir).view('Ember', 'sheet', PORTUGUESE);
};

test('rpg-asjw.4 a guided start without a character gets the localized hero and a d20 sheet', async (t) => {
  const sheet = await startedSheet(t);
  assert.ok(sheet.startsWith('O Andarilho'), sheet);
  assert.match(sheet, /d20-lite/);
});

test('rpg-asjw.4 a guided start with a premade character in Portuguese gets its sheet', async (t) => {
  const sheet = await startedSheet(t, 'Detetive');
  assert.ok(sheet.startsWith('Detetive'), sheet);
  assert.match(sheet, /d20-lite/);
});

const ATTRIBUTE_PATTERN = /(?:Força|Agilidade|Raciocínio|Presença)\D*(\d+)/g;

const D20_LITE = { id: 'd20-lite', edition: 'original' };

const spreadOf = (genre: string, character: string) => {
  const config = planCampaign(undefined, { ruleset: D20_LITE, genre, character });
  return JSON.stringify(startingCharacter(config)?.proposal.values);
};

test('rpg-asjw.11 the Detetive sheet is not flat and favours Raciocínio', async (t) => {
  const sheet = await startedSheet(t, 'Detetive');
  const scores = [...sheet.matchAll(ATTRIBUTE_PATTERN)].map((match) => Number(match[1]));
  assert.equal(scores.length, 4, sheet);
  assert.ok(new Set(scores).size > 1, sheet);
  assert.equal(Math.max(...scores), scores[2], sheet);
});

test('rpg-asjw.11 every premade of a genre has its own spread, whatever the language', () => {
  for (const { id: genre, characters } of startOptions().genres) {
    const spreads = characters.map(({ id, name }) => {
      const [first, ...rest] = [name, ...contentAliases('archetype', id ?? name)].map((c) => spreadOf(genre, c));
      assert.ok(
        rest.every((other) => other === first),
        `${genre}/${name}`,
      );
      const scores = Object.values(JSON.parse(first ?? '{}')).filter((value) => typeof value === 'number');
      assert.ok(Math.max(...scores) > ATTRIBUTE_AVERAGE, `${genre}/${name}`);
      return first;
    });
    assert.equal(new Set(spreads).size, spreads.length, genre);
  }
});

test('rpg-asjw.17 a premade picked by id or English name is stored under its Portuguese name', async (t) => {
  for (const pick of ['detective', 'Detective', 'Detetive']) {
    const dataDir = dataDirFor(t);
    await createCampaignFrom(dataDir, {
      version: PROTOCOL_VERSION,
      type: 'CreateCampaign',
      name: 'Ember',
      language: PORTUGUESE,
      choices: { ...D20_MYSTERY, character: pick },
    });
    const gateway = createEngineGateway(dataDir);
    assert.ok(gateway.view('Ember', 'sheet', PORTUGUESE).startsWith('Detetive'), pick);
    const recap = gateway.view('Ember', 'recap', PORTUGUESE);
    assert.ok(!recap.includes('Detective'), recap);
    assert.equal(readFileSync(join(dataDir, 'Ember.sqlite')).includes('Detective'), false, pick);
  }
});
