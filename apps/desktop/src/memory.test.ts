import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type CampaignSnapshot,
  type ClientCommand,
  PROTOCOL_VERSION,
} from '../../../packages/client-protocol/src/protocol.ts';
import { DEFAULT_PREFERENCES } from './accessibility.ts';
import { createDesktopClient, type Transport, viewModel } from './renderer.ts';
import { MEMORY_ATTRIBUTE, MEMORY_PANEL, renderView } from './view.ts';

const CAMPAIGN = 'c1';
const WIDE_WIDTH = 1600;
const READY = { type: 'Ready', version: PROTOCOL_VERSION, pid: 42, node: 'v24', sqlite: true, gm: 'fake' };
const SNAPSHOT: CampaignSnapshot = {
  version: PROTOCOL_VERSION,
  campaignId: CAMPAIGN,
  revision: 4,
  campaign: { id: CAMPAIGN, name: 'Harbor' },
  characters: [{ id: 'hero', campaignId: CAMPAIGN, name: 'Ash' }],
  currentScene: { id: 's1', campaignId: CAMPAIGN, title: 'Docks' },
  turns: [],
};
const fact = (entityId: string, entityName: string, value: string, corrected = false) => ({
  entityId,
  entityName,
  kind: 'alive',
  key: '',
  value,
  sourceEventId: 'e1',
  corrected,
});
const MEMORY_VIEW = {
  version: PROTOCOL_VERSION,
  campaignId: CAMPAIGN,
  revision: 7,
  memory: { person: [fact('p1', 'Mira', 'alive', true)], place: [fact('l1', 'Ember Inn', 'alive')], thread: [] },
};

const connected = () => {
  const sent: ClientCommand[] = [];
  let onLine = (_line: string) => {};
  const transport: Transport = {
    connect: () => {},
    send: (line) => {
      sent.push(JSON.parse(line) as ClientCommand);
    },
    onLine: (listener) => {
      onLine = listener;
    },
    onClose: () => {},
  };
  let next = 0;
  const client = createDesktopClient({ transport, newActionId: () => `a${next++}` });
  const receive = (message: object) => onLine(JSON.stringify(message));
  receive(READY);
  client.select(CAMPAIGN);
  receive({ type: 'Snapshot', snapshot: SNAPSHOT });
  sent.length = 0;
  const html = (locale = 'en') =>
    renderView(viewModel(client.state(), WIDE_WIDTH, { ...DEFAULT_PREFERENCES, locale }), locale);
  return { client, sent, receive, html };
};

const remembered = (receive: (message: object) => void) =>
  receive({ type: 'StoryResult', command: 'GetStoryMemory', result: { ok: true, value: MEMORY_VIEW } });

test('rpg-42a.61: opening the panel asks for the story memory and lists facts by person, place and thread', () => {
  const { client, sent, receive, html } = connected();
  assert.doesNotMatch(html(), new RegExp(`id="${MEMORY_PANEL}"`));
  client.toggleMemory();
  assert.deepEqual(sent, [{ version: PROTOCOL_VERSION, type: 'GetStoryMemory', campaignId: CAMPAIGN }]);
  remembered(receive);
  const page = html();
  assert.match(page, new RegExp(`id="${MEMORY_PANEL}"`));
  assert.match(page, /What the story remembers/);
  assert.match(page, /People.*Mira - alive: alive.*corrected.*Places.*Ember Inn - alive: alive.*Threads/s);
  assert.match(page, new RegExp(`${MEMORY_ATTRIBUTE}="correct"`));
  assert.match(page, /<label[^>]*>New value<\/label>|New value/);
  assert.match(html('pt-BR'), /O que a história lembra/);
  assert.match(html('es'), /Lo que recuerda la historia/);
  client.toggleMemory();
  assert.doesNotMatch(html(), new RegExp(`id="${MEMORY_PANEL}"`));
});

test('rpg-42a.61: correcting a fact sends CorrectStoryFact with the memory revision, then reloads', () => {
  const { client, sent, receive } = connected();
  client.toggleMemory();
  remembered(receive);
  sent.length = 0;
  client.correctFact(1, 'dead');
  assert.deepEqual(sent, [
    {
      version: PROTOCOL_VERSION,
      type: 'CorrectStoryFact',
      campaignId: CAMPAIGN,
      actionId: 'a0',
      expectedRevision: 7,
      actorId: 'hero',
      entityId: 'l1',
      kind: 'alive',
      key: '',
      value: 'dead',
    },
  ]);
  sent.length = 0;
  receive({ type: 'StoryResult', command: 'CorrectStoryFact', result: { ok: true, value: { revision: 8 } } });
  assert.ok(sent.some(({ type }) => type === 'GetStoryMemory'));
});

test('rpg-42a.61: a rejected memory or correction shows a plain notice and never crashes', () => {
  const { client, receive, html } = connected();
  client.toggleMemory();
  receive({
    type: 'StoryResult',
    command: 'GetStoryMemory',
    result: { ok: false, error: { code: 'Rejected', message: 'no story' } },
  });
  assert.match(html(), /The story memory is not available right now\./);
  assert.match(html('pt-BR'), /A memória da história não está disponível agora\./);
  remembered(receive);
  client.correctFact(0, 'dead');
  receive({
    type: 'StoryResult',
    command: 'CorrectStoryFact',
    result: { ok: false, error: { code: 'StaleRevision', message: 'stale' } },
  });
  assert.match(html(), /The correction was refused: stale/);
  assert.match(html('pt-BR'), /A correção foi recusada: stale/);
  client.correctFact(9, 'dead');
});
