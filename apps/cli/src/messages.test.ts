import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { missingKeys } from '../../../packages/client-protocol/src/locale.ts';
import { PROTOCOL_VERSION } from '../../../packages/client-protocol/src/protocol.ts';
import { toVisualizationEvent } from '../../../packages/client-protocol/src/visualization.ts';
import { archiveCampaign, createCampaignFrom, deleteCampaign, unarchiveCampaign } from './engine-gateway.ts';
import { ProviderError } from './gm-api.ts';
import { type CampaignGateway, main } from './main.ts';
import { CLI_CATALOG, CLI_LOCALES, errorText, say } from './messages.ts';
import { PLAIN_TERMINAL, renderLinear, rollFrames, type TuiData } from './tui.ts';
import { runHome } from './tui-home.ts';
import { guidedStart } from './tui-start.ts';

const PORTUGUESE = 'pt-BR';
const SPANISH = 'es';
const TEMP_PREFIX = 'rpg-messages-';
const WIDE = { ...PLAIN_TERMINAL, width: 200 };

const lines = async function* (input: readonly string[]) {
  yield* input;
};

const mechanic = toVisualizationEvent(
  {
    resultId: 'r1',
    mechanic: 'attack',
    visibility: 'public',
    reveals: [{ kind: 'die', sides: 20, face: 14 }],
    modifier: 2,
    total: 1500,
    outcome: 'hit',
  },
  'player',
  { enabled: true },
);

const data: TuiData = {
  snapshot: {
    version: PROTOCOL_VERSION,
    campaignId: 'c1',
    revision: 1,
    campaign: { id: 'c1', name: 'Ember' },
    characters: [{ id: 'h1', campaignId: 'c1', name: 'Wanderer' }],
    currentScene: { id: 's1', campaignId: 'c1', title: 'Docks' },
    turns: [],
  },
  sheet: [],
  events: [],
  mechanics: mechanic === undefined ? [] : [mechanic],
  locale: PORTUGUESE,
};

test('rpg-42a.39 every CLI and TUI locale has every catalog key', () => {
  assert.deepEqual(CLI_LOCALES, ['en', PORTUGUESE, SPANISH]);
  assert.deepEqual(missingKeys(CLI_CATALOG), []);
});

test('rpg-42a.109 Spanish CLI keys do not fall back to English', () => {
  assert.equal(say(SPANISH, 'tui.voiceOff'), 'La voz está desactivada. Inicia la TUI con --voice para usarla.');
});

test('rpg-42a.39 the TUI panes, sheet and dice read in Brazilian Portuguese', () => {
  const text = renderLinear(data, WIDE).join('\n');
  assert.match(text, /^Conversa:$/m);
  assert.match(text, /^Ainda não há conversa\.$/m);
  assert.match(text, /^Ficha:$/m);
  assert.match(text, /^Personagem: Wanderer$/m);
  assert.match(text, /^Registro de eventos:$/m);
  assert.match(text, /^attack: d20 -> 14; modificador \+2; total 1\.500; resultado hit$/m);
});

test('rpg-42a.39 the TUI home reads in Brazilian Portuguese', async () => {
  let output = '';
  const ports = {
    list: () => [],
    archived: () => [],
    archive: () => {},
    rename: () => {},
    unarchive: () => {},
    remove: () => {},
    play: async () => {},
    start: async function* () {},
  };
  await runHome(
    ports,
    { capabilities: PLAIN_TERMINAL, lines: lines(['?', 'q']), write: (text) => (output += text), locale: PORTUGUESE },
    0,
  );
  assert.match(output, /^Nenhuma aventura ainda\. Digite n para começar uma ou q para sair\.$/m);
  assert.match(output, /^Digite uma das opções acima\.$/m);
});

const tempDataDir = (t: TestContext) => {
  const dataDir = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  return dataDir;
};

test('rpg-42a.39 the TUI guided start reads in Brazilian Portuguese', async (t) => {
  const out: string[] = [];
  for await (const text of guidedStart(tempDataDir(t), lines(['q']), createCampaignFrom, PORTUGUESE)) out.push(text);
  assert.match(out[0] ?? '', /^Nova aventura$/m);
  assert.match(out[0] ?? '', /^ {2}2\. Me guie - /m);
  assert.match(out[0] ?? '', /^Digite um número para escolher\.$/m);
  assert.match(out[0] ?? '', /^Digite q para parar e voltar depois\.$/m);
  assert.match(out[1] ?? '', /^Seu progresso foi salvo\./);
});

test('rpg-42a.39 CLI help and usage errors read in Brazilian Portuguese', async () => {
  const out: string[] = [];
  const err: string[] = [];
  const io = { stdout: (text: string) => out.push(text), stderr: (text: string) => err.push(text), lines: lines([]) };
  const gateway = {} as CampaignGateway;
  assert.equal(await main(['help'], { ...io, locale: PORTUGUESE }, gateway), 0);
  assert.match(out.join(''), /^Uso: rpg \[comando\]$/m);
  assert.match(out.join(''), /^ {2}play <campanha> - Começa a jogar uma campanha\.$/m);
  assert.match(out.join(''), /^ {2}claude \[campaign\] - Abre o Claude Code/m);
  await main(['play'], { ...io, locale: PORTUGUESE }, gateway);
  assert.match(err.join(''), /^Falta o nome da campanha para play\.$/m);
  assert.match(err.join(''), /^Rode rpg help para ver o uso\.$/m);
});

const thrown = (action: () => unknown, locale: string) => {
  try {
    action();
  } catch (error) {
    return errorText(locale, error);
  }
  return undefined;
};

test('rpg-42a.39 campaign errors read in the player locale and stay English by default', (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  assert.equal(
    thrown(() => archiveCampaign(dataDir, 'Nope'), PORTUGUESE),
    'Não existe campanha chamada Nope. Rode rpg new Nope primeiro.',
  );
  assert.equal(
    thrown(() => archiveCampaign(dataDir, 'Nope'), 'en'),
    'No campaign named Nope. Run rpg new Nope first.',
  );
  assert.equal(
    thrown(() => unarchiveCampaign(dataDir, 'Nope'), PORTUGUESE),
    'Não existe campanha arquivada chamada Nope.',
  );
  assert.equal(
    thrown(() => deleteCampaign(dataDir, 'Nope', 'Nope'), 'not a locale!'),
    'No campaign named Nope. Run rpg new Nope first.',
  );
  assert.equal(errorText(PORTUGUESE, new Error('plain')), 'plain');
  assert.equal(errorText(PORTUGUESE, 'raw'), 'raw');
});

test('rpg-42a.39 built-in roll outcomes read in the player locale and unknown ones stay as written', () => {
  assert.ok(mechanic);
  const checked = { ...mechanic, final: { ...mechanic.final, outcome: 'check.critical' } };
  assert.match(rollFrames(checked, 1, PORTUGUESE).at(-1) ?? '', /; resultado crítico$/);
  assert.match(rollFrames(checked, 1).at(-1) ?? '', /; outcome critical$/);
  assert.match(rollFrames(mechanic, 1, PORTUGUESE).at(-1) ?? '', /; resultado hit$/);
});

test('rpg-42a.39 a malformed locale renders English instead of throwing', () => {
  assert.ok(mechanic);
  assert.match(rollFrames(mechanic, 1, 'pt_BR').at(-1) ?? '', /; modifier \+2;/);
  assert.match(renderLinear({ ...data, locale: 'not a locale!' }, WIDE).join('\n'), /^Conversation:$/m);
});

test('rpg-42a.101 a provider failure reads in the player language, with the reason and not the raw message', () => {
  const failure = new ProviderError('Claude Code stopped with exit code 1.', undefined, false, {
    kind: 'limit',
    detail: '3:30pm',
  });
  assert.match(errorText('en', failure), /usage limit is reached\. It resets 3:30pm/);
  assert.match(errorText('pt-BR', failure), /limite de uso/);
  assert.match(errorText('es', failure), /límite de uso/);
  assert.equal(
    errorText('en', new ProviderError('The provider is unavailable (HTTP 503).')).includes('HTTP 503'),
    true,
  );
});
