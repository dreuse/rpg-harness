import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { missingKeys } from '../../../packages/client-protocol/src/locale.ts';
import { createEngineGateway } from './engine-gateway.ts';
import { CLI_CATALOG, errorText } from './messages.ts';
import { describeConfig, planCampaign, planResult, startingCharacter } from './quickstart.ts';

const PORTUGUESE = 'pt-BR';
const CAMPAIGN = 'Ember';
const D20 = { id: 'd20-lite', edition: 'original' };
const NARRATIVE = { id: 'narrative', edition: 'original' };

const dataDirFor = (t: TestContext) => {
  const dir = mkdtempSync(join(tmpdir(), 'rpg-localized-'));
  mkdirSync(dir, { recursive: true });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const failure = (run: () => unknown): unknown => {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('expected a failure');
};

const collect = async (lines: AsyncIterable<string>) => {
  const out: string[] = [];
  for await (const line of lines) out.push(line);
  return out.join('\n');
};

test('rpg-42a.53 an unknown or ambiguous ruleset is explained in Brazilian Portuguese', () => {
  const error = failure(() => planCampaign(undefined, { ruleset: { id: 'dnd', edition: '1.9' } }));
  assert.equal(
    errorText(PORTUGUESE, error),
    'O livro de regras dnd 1.9 não está instalado. Livros de regras instalados: d20-lite original, dice-pool-lite original, narrative original. Rode rpg import <arquivo> para adicionar os arquivos de regras ou use um livro de regras instalado.',
  );
  assert.match(errorText('en', error), /^Ruleset dnd 1\.9 is not installed\. Installed rulesets: /);
});

test('rpg-42a.53 an unknown genre, a long intent and a conflicting intent read in Brazilian Portuguese', () => {
  assert.equal(
    errorText(
      PORTUGUESE,
      failure(() => planCampaign(undefined, { genre: 'noir' })),
    ),
    'O gênero noir não está instalado. Gêneros instalados: fantasy, science-fiction, horror, investigative-mystery, modern-adventure, blank-world.',
  );
  assert.equal(
    errorText(
      PORTUGUESE,
      failure(() => planCampaign('x'.repeat(5000))),
    ),
    'A intenção da campanha pode ter no máximo 2.000 caracteres.',
  );
});

test('rpg-42a.53 a client that cannot show a feature says which client to use, in Brazilian Portuguese', () => {
  const error = failure(() => planCampaign(undefined, { ruleset: NARRATIVE, diceVisualization: true }));
  assert.equal(
    errorText(PORTUGUESE, error),
    'diceVisualization precisa de um livro de regras com dados.\nUse o cliente tui ou desktop para diceVisualization.',
  );
  assert.equal(
    errorText('en', error),
    'diceVisualization needs a ruleset with dice.\nUse the tui or desktop client for diceVisualization.',
  );
});

test('rpg-42a.53 a plan failure carries the player locale when the caller has one', () => {
  const result = planResult({ version: 1, type: 'PlanCampaign', choices: { genre: 'noir' } }, undefined, PORTUGUESE);
  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.error.message, /^O gênero noir não está instalado\./);
});

test('rpg-42a.53 a character that lacks details names the sheet fields in Brazilian Portuguese', () => {
  const config = planCampaign(undefined, { ruleset: D20, character: 'Quiet stranger' });
  const error = failure(() => startingCharacter(config));
  assert.equal(
    errorText(PORTUGUESE, error),
    'Seu personagem precisa de Força, Agilidade, Raciocínio e Presença. Inclua isso na descrição ou pule esta etapa.',
  );
  assert.equal(
    errorText('en', error),
    'Your character needs Might, Agility, Wits, and Presence. Add them to your description, or skip this step.',
  );
});

test('rpg-42a.53 the saved settings read in Brazilian Portuguese and the GM prompt text stays English', () => {
  const config = planCampaign(undefined, { ruleset: NARRATIVE, genre: 'horror' });
  assert.equal(
    describeConfig(config, PORTUGUESE),
    'Regras: narrative original (escolhido)\nGênero: Terror crescente 1.0.0 (escolhido)\nDados: como as regras decidem (padrão)',
  );
  assert.match(
    describeConfig(config),
    /^Ruleset: narrative original \(explicit\)\nGenre: horror 1\.0\.0 \(explicit\)\nDice: as the ruleset decides \(default\)$/,
  );
});

test('rpg-42a.53 gateway success messages read in Brazilian Portuguese', async (t) => {
  const dataDir = dataDirFor(t);
  const gateway = createEngineGateway(dataDir);
  const created = await collect(gateway.create(CAMPAIGN, undefined, async () => undefined, undefined, PORTUGUESE));
  assert.match(created, /^Configurações salvas:$/m);
  assert.match(created, /^Regras: /m);
  const file = join(dataDir, 'ember.rpg');
  assert.match(
    gateway.exportCampaign(CAMPAIGN, file, PORTUGUESE),
    /^Campanha Ember exportada com \d+ (versão|versões) de regras (fixada|fixadas) em /,
  );
  assert.match(gateway.backup(CAMPAIGN, PORTUGUESE), /^Backup da campanha Ember salvo em /);
  assert.match(
    gateway.settings(undefined, {}, PORTUGUESE),
    /^Padrões do app para todas as campanhas:\nModelo do mestre: /,
  );
  const backupFile = /em (.+)\.$/.exec(gateway.backup(CAMPAIGN, PORTUGUESE))?.[1] ?? '';
  await collect(
    gateway.remove(
      CAMPAIGN,
      (async function* () {
        yield CAMPAIGN;
      })(),
    ),
  );
  assert.equal(
    gateway.restore(backupFile, PORTUGUESE),
    'Campanha Ember restaurada. Rode rpg resume Ember para continuar.',
  );
});

test('rpg-42a.53 the new catalog keys exist in every CLI locale', () => {
  assert.deepEqual(missingKeys(CLI_CATALOG), []);
});
