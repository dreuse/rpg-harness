import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { missingKeys } from '../../../packages/client-protocol/src/locale.ts';
import { restoreArchive } from './campaign-archive.ts';
import { createEngineGateway } from './engine-gateway.ts';
import { launchClaude } from './gm-claude-code.ts';
import { readInside } from './import-gateway.ts';
import { CLI_CATALOG, errorText, say } from './messages.ts';
import { builderIssueText, describeConfig, planCampaign, planResult, startingCharacter } from './quickstart.ts';

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
    'Seu pedido diz "animação de dados", mas esta aventura não tem dados. Escolha regras com dados ou remova essas palavras.\nUse o cliente tui ou desktop para animação de dados.',
  );
  assert.equal(
    errorText('en', error),
    'Your pitch says "dice animation", but this adventure has no dice. Pick rules with dice, or remove those words.\nUse the tui or desktop client for dice animation.',
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

test('rpg-42a.117 a character that does not fit explains each engine issue in Brazilian Portuguese', () => {
  const config = planCampaign(undefined, { ruleset: D20, character: 'Might 99 Agility 3 Wits 3 Presence 3' });
  const error = failure(() => startingCharacter(config));
  assert.equal(errorText(PORTUGUESE, error), 'Seu personagem não se encaixa nas regras: deve estar entre 0 e 10.');
  assert.equal(errorText('en', error), 'Your character does not fit the rules: must be between 0 and 10.');
});

test('rpg-42a.148 builder issues localize from code and bounds, not from the English message', () => {
  const unbounded = builderIssueText({ path: 'a', code: 'out_of_range', message: 'x', max: 6 });
  const bounded = builderIssueText({ path: 'a', code: 'out_of_range', message: 'x', min: 1, max: 5 });
  const widget = builderIssueText({ path: 'a', code: 'invalid_value', message: 'x', widget: 'choice' });
  const list = builderIssueText({ path: 'a', code: 'not_list', message: 'x' });
  assert.equal(errorText(PORTUGUESE, unbounded), 'deve estar entre -∞ e 6');
  assert.equal(errorText(PORTUGUESE, bounded), 'deve estar entre 1 e 5');
  assert.equal(errorText('es', bounded), 'debe estar entre 1 y 5');
  assert.equal(errorText('en', widget), 'must fit the choice widget');
  assert.equal(errorText(PORTUGUESE, list), 'deve ser uma lista');
  assert.equal(builderIssueText({ path: 'a', code: 'out_of_range', message: 'overflow' }), 'overflow');
});

test('rpg-42a.117 a config issue line reads in Brazilian Portuguese and stays English by default', () => {
  const error = failure(() => planCampaign(undefined, { genre: 5 }));
  assert.equal(errorText(PORTUGUESE, error), 'Seu pedido tem um problema com "genre.value": valor inválido.');
  assert.equal(errorText('en', error), 'Your pitch has a problem with "genre.value": invalid value.');
});

test('rpg-42a.117 archive, import and Claude Code leaf errors read in Brazilian Portuguese', (t) => {
  const dir = dataDirFor(t);
  const junk = join(dir, 'junk.json');
  writeFileSync(junk, '{}');
  const rejected = failure(() => restoreArchive(junk, dir, (name) => join(dir, name)));
  assert.equal(errorText(PORTUGUESE, rejected), 'Arquivo rejeitado: o arquivo não é um arquivo de campanha válido.');
  assert.equal(errorText('en', rejected), 'Archive rejected: file is not a valid campaign archive.');
  writeFileSync(join(dir, 'inside.txt'), 'x');
  mkdirSync(join(dir, 'folder'));
  assert.equal(
    errorText(
      PORTUGUESE,
      failure(() => readInside(dir, 'folder')),
    ),
    'folder não é um arquivo comum.',
  );
  assert.equal(
    errorText(
      PORTUGUESE,
      failure(() => launchClaude({ PATH: '' }, dir)),
    ),
    'O Claude Code não foi encontrado. Instale-o, rode claude uma vez para entrar na conta e tente de novo.',
  );
  assert.equal(
    errorText(
      'en',
      failure(() => launchClaude({ PATH: '' }, dir)),
    ),
    'Claude Code was not found. Install it, run claude once to sign in, then try again.',
  );
});

test('rpg-42a.53 the saved settings read in Brazilian Portuguese and the GM prompt text stays English', () => {
  const config = planCampaign(undefined, { ruleset: NARRATIVE, genre: 'horror' });
  assert.equal(
    describeConfig(config, PORTUGUESE),
    'Regras: narrative original (escolhido)\nGênero: Terror crescente (escolhido)\nDados: como as regras decidem (padrão)',
  );
  assert.match(
    describeConfig(config),
    /^Ruleset: narrative original \(explicit\)\nGenre: horror \(explicit\)\nDice: as the ruleset decides \(default\)$/,
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

test('rpg-42a.117 the read views and the recap read in Brazilian Portuguese and stay English by default', async (t) => {
  const dataDir = dataDirFor(t);
  const gateway = createEngineGateway(dataDir);
  await collect(gateway.create(CAMPAIGN, undefined, async () => undefined, undefined, PORTUGUESE));
  assert.equal(gateway.view(CAMPAIGN, 'sheet', PORTUGUESE), 'O Andarilho\nAinda não há ficha de personagem.');
  assert.equal(gateway.view(CAMPAIGN, 'inventory', PORTUGUESE), 'Inventário:\nAinda não há itens.');
  assert.equal(gateway.view(CAMPAIGN, 'quests', PORTUGUESE), 'Missões:\nAinda não há missões.');
  assert.equal(gateway.view(CAMPAIGN, 'encounter', PORTUGUESE), 'Ainda não há encontro.');
  assert.match(gateway.view(CAMPAIGN, 'journal', PORTUGUESE), /^Diário:\n/);
  assert.match(gateway.view(CAMPAIGN, 'recap', PORTUGUESE), /^Regras: /);
  assert.equal(gateway.view(CAMPAIGN, 'inventory'), 'Inventory:\nNo items yet.');
  assert.match(gateway.view(CAMPAIGN, 'recap'), /^Ruleset: /);
});

test('rpg-42a.117 the incomplete import count uses singular and plural forms', () => {
  assert.equal(say('en', 'import.incomplete', { count: 1 }), 'Import not completed: 1 gap left.');
  assert.equal(say('en', 'import.incomplete', { count: 3 }), 'Import not completed: 3 gaps left.');
  assert.equal(say(PORTUGUESE, 'import.incomplete', { count: 2 }), 'Importação não concluída: 2 lacunas restantes.');
});

test('rpg-42a.53 the new catalog keys exist in every CLI locale', () => {
  assert.deepEqual(missingKeys(CLI_CATALOG), []);
});

const D20_PITCH = 'A fantasy adventure using the D20-Lite rules';
const PROMPT_ENGLISH = 'Describe your character, or press Enter to play as The Wanderer.';

const createWith = async (t: TestContext, description: string, locale: string) => {
  const asked: string[] = [];
  const ask = async (prompt: string) => {
    asked.push(prompt);
    return description;
  };
  const text = await collect(createEngineGateway(dataDirFor(t)).create(CAMPAIGN, D20_PITCH, ask, undefined, locale));
  return { asked, text };
};

test('rpg-42a.140 a created character, an unfinished one and the prompt read in Brazilian Portuguese', async (t) => {
  const done = await createWith(t, 'A scout named Wren with might 6, agility 5, wits 7 and presence 4.', PORTUGUESE);
  assert.match(done.text, /Personagem Wren criado\./);
  const spanish = await createWith(t, 'A scout named Wren with might 6, agility 5, wits 7 and presence 4.', 'es');
  assert.match(spanish.text, /Personaje Wren creado\./);
  assert.notEqual(done.asked[0], PROMPT_ENGLISH);
  const pending = await createWith(t, 'A scout named Wren.', PORTUGUESE);
  assert.match(pending.text, /Personagem não criado, você joga como O Andarilho: sem resposta para /);
  const english = await createWith(t, 'A scout named Wren.', 'en');
  assert.match(english.text, /Character not created, you play as The Wanderer: no answer for /);
  assert.equal(english.asked[0], PROMPT_ENGLISH);
});

test('rpg-42a.140 invalid builder values in an unfinished character read in Brazilian Portuguese', async (t) => {
  const invalid = await createWith(
    t,
    'A scout named Wren with might 99, agility 5, wits 7 and presence 4.',
    PORTUGUESE,
  );
  assert.match(invalid.text, /Personagem não criado, você joga como O Andarilho: .*deve estar entre 0 e 10/);
});
