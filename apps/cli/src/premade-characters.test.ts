import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { contentAliases } from '../../../packages/client-protocol/src/content-names.ts';
import { PROTOCOL_VERSION } from '../../../packages/client-protocol/src/protocol.ts';
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
