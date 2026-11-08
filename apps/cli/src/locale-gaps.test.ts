import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { missingKeys } from '../../../packages/client-protocol/src/locale.ts';
import { createCampaignFrom } from './engine-gateway.ts';
import { hermeticGmEnv } from './gm-test-env.ts';
import { CLI_CATALOG, CLI_LOCALES, say } from './messages.ts';
import { guidedStart } from './tui-start.ts';

const BIN = join(import.meta.dirname, 'bin.ts');
const PORTUGUESE = 'pt-BR';
const CAMPAIGN = 'Ember';
const COUNT_PARAM = 'count';

const dataDirOf = (t: TestContext) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'rpg-locale-gaps-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  return dataDir;
};

const rpg = (dataDir: string, locale: string, args: readonly string[], input = '') => {
  const result = spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    input,
    env: { ...hermeticGmEnv(), RPG_DATA_DIR: dataDir, RPG_LANG: locale },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
};

const lines = async function* (input: readonly string[]) {
  yield* input;
};

test('every CLI message key renders to text in every locale, never to the raw key', () => {
  assert.deepEqual(missingKeys(CLI_CATALOG), []);
  const keys = new Set(Object.values(CLI_CATALOG).flatMap((entries) => Object.keys(entries)));
  for (const locale of CLI_LOCALES) {
    for (const key of keys) {
      assert.notEqual(say(locale, key, { [COUNT_PARAM]: 2 }), key, `${locale} renders ${key} raw`);
    }
  }
});

test('help describes every command in every locale without raw keys', (t) => {
  for (const locale of CLI_LOCALES) {
    const help = rpg(dataDirOf(t), locale, ['help']);
    assert.doesNotMatch(help, /command\./, locale);
  }
});

test('list, archive and delete read in Brazilian Portuguese', (t) => {
  const dataDir = dataDirOf(t);
  rpg(dataDir, PORTUGUESE, ['new', CAMPAIGN]);
  assert.match(rpg(dataDir, PORTUGUESE, ['list']), /^Campanhas: Ember\nArquivadas: nenhum$/m);
  assert.match(rpg(dataDir, PORTUGUESE, ['archive', CAMPAIGN]), /^Campanha Ember arquivada\./);
  const kept = rpg(dataDir, PORTUGUESE, ['delete', CAMPAIGN], 'no\n');
  assert.doesNotMatch(kept, /Deleting|Kept|Type /);
  assert.match(kept, /A campanha Ember foi mantida\./);
  assert.match(rpg(dataDir, PORTUGUESE, ['delete', CAMPAIGN], `${CAMPAIGN}\n`), /Campanha Ember apagada\./);
  assert.match(rpg(dataDir, 'en', ['list']), /^Campaigns: none\nArchived: none$/m);
});

test('the play header carries no version number', (t) => {
  const dataDir = dataDirOf(t);
  const out = rpg(dataDir, PORTUGUESE, ['new', CAMPAIGN, 'um mistério investigativo']);
  assert.match(out, /Mistério investigativo/);
  assert.doesNotMatch(out, /Mistério investigativo \d/);
});

test('guided summary localizes none and the export count pluralizes', async (t) => {
  const out: string[] = [];
  const dataDir = dataDirOf(t);
  for await (const text of guidedStart(
    dataDir,
    lines(['2', '', 's', '4', 's', 's', 's', 's', 's', 'q']),
    createCampaignFrom,
    PORTUGUESE,
  ))
    out.push(text);
  assert.match(out.join('\n'), /^Regras: nenhum/m);
  assert.match(out.join('\n'), /^Personagem: nenhum/m);
  assert.equal(say(PORTUGUESE, 'campaign.exported', { name: 'A', count: 0, file: 'f' }).includes('0 versões'), true);
  assert.equal(say(PORTUGUESE, 'campaign.exported', { name: 'A', count: 1, file: 'f' }).includes('1 versão'), true);
  assert.equal(say('en', 'campaign.exported', { name: 'A', count: 0, file: 'f' }).includes('0 rulepack pins'), true);
  assert.equal(say('en', 'campaign.exported', { name: 'A', count: 1, file: 'f' }).includes('1 rulepack pin '), true);
});

test('a genre option never repeats its label as its description', async (t) => {
  const out: string[] = [];
  for await (const text of guidedStart(dataDirOf(t), lines(['2', '', 'q']), createCampaignFrom, PORTUGUESE))
    out.push(text);
  assert.match(out.join('\n'), /^ {2}6\. Mundo em branco$/m);
});
