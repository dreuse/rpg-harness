import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type CampaignSnapshot,
  type ClientCommand,
  PROTOCOL_VERSION,
} from '../../../packages/client-protocol/src/protocol.ts';
import { DEFAULT_PREFERENCES, translate } from './accessibility.ts';
import { createDesktopClient, type Transport, viewModel } from './renderer.ts';
import { OOC_ATTRIBUTE, OOC_PANEL, renderView } from './view.ts';

const CAMPAIGN = 'c1';
const WIDE_WIDTH = 1600;
const READY = { type: 'Ready', version: PROTOCOL_VERSION, pid: 42, node: 'v24', sqlite: true, gm: 'fake' };
const NOTE = 'NPCs speak modern English';
const PROPOSAL = { kind: 'table_note', summary: `Table note: ${NOTE}`, note: NOTE };
const SNAPSHOT: CampaignSnapshot = {
  version: PROTOCOL_VERSION,
  campaignId: CAMPAIGN,
  revision: 4,
  campaign: { id: CAMPAIGN, name: 'Harbor' },
  characters: [{ id: 'hero', campaignId: CAMPAIGN, name: 'Ash' }],
  currentScene: { id: 's1', campaignId: CAMPAIGN, title: 'Docks' },
  turns: [],
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

const answered = (receive: (message: object) => void, actionId: string) =>
  receive({
    type: 'OocResult',
    command: 'SubmitOocMessage',
    actionId,
    result: { ok: true, value: { reply: 'I can keep this.', proposals: [PROPOSAL] } },
  });

test('rpg-42a.91: with Talk to the GM on, input goes to the GM and never becomes a story action', () => {
  const { client, sent, html } = connected();
  assert.equal(client.state().ooc.active, false);
  client.toggleOoc();
  assert.equal(client.state().ooc.active, true);
  const result = client.submit(NOTE);
  assert.ok(result.ok);
  assert.deepEqual(sent, [
    { version: PROTOCOL_VERSION, type: 'SubmitOocMessage', campaignId: CAMPAIGN, actionId: 'a0', text: NOTE },
  ]);
  assert.deepEqual(client.state().outbox, []);
  assert.equal(viewModel(client.state(), WIDE_WIDTH).conversation.length, 0);
  assert.ok(html().includes('<h2 id="heading-conversation">Conversation</h2><ol aria-live="polite"></ol>'));
});

test('rpg-42a.91: a typed /gm or (( )) prefix routes out of character even with the toggle off', () => {
  const { client, sent } = connected();
  assert.ok(client.submit('/gm you forgot my +2 for high ground').ok);
  assert.ok(client.submit('(( undo that ))').ok);
  assert.deepEqual(
    sent.map((command) => [command.type, 'text' in command ? command.text : undefined]),
    [
      ['SubmitOocMessage', 'you forgot my +2 for high ground'],
      ['SubmitOocMessage', 'undo that'],
    ],
  );
  assert.deepEqual(client.state().outbox, []);
});

test('rpg-42a.91: the GM reply shows its proposals; confirm applies one, decline changes nothing, undo reverts', () => {
  const { client, sent, receive, html } = connected();
  client.submit('/gm remember this');
  answered(receive, 'a0');
  const exchange = client.state().ooc.exchanges[0];
  assert.equal(exchange?.reply, 'I can keep this.');
  assert.match(html(), /I can keep this\./);
  assert.match(html(), new RegExp(`${OOC_ATTRIBUTE}="confirm"`));
  assert.match(html(), new RegExp(`${OOC_ATTRIBUTE}="decline"`));
  assert.match(html(), new RegExp(`id="${OOC_PANEL}"`));

  sent.length = 0;
  client.declineOoc('a0', 0);
  assert.deepEqual(sent, []);
  assert.equal(client.state().ooc.exchanges[0]?.proposals[0]?.status, 'declined');
  assert.doesNotMatch(html(), new RegExp(`${OOC_ATTRIBUTE}="confirm"`));

  client.submit('/gm remember this again');
  answered(receive, 'a1');
  sent.length = 0;
  client.confirmOoc('a1', 0);
  assert.deepEqual(sent, [
    {
      version: PROTOCOL_VERSION,
      type: 'ConfirmOocProposal',
      campaignId: CAMPAIGN,
      actionId: 'a2',
      expectedRevision: SNAPSHOT.revision,
      proposal: PROPOSAL,
    },
  ]);
  receive({
    type: 'OocResult',
    command: 'ConfirmOocProposal',
    actionId: 'a2',
    result: { ok: true, value: { revision: 5, summary: PROPOSAL.summary } },
  });
  assert.equal(client.state().ooc.exchanges[1]?.proposals[0]?.status, 'applied');
  assert.equal(client.state().ooc.undoable, PROPOSAL.summary);
  assert.match(html(), new RegExp(`${OOC_ATTRIBUTE}="undo"`));

  sent.length = 0;
  client.undoOoc();
  assert.deepEqual(
    sent.map(({ type }) => type),
    ['UndoOocChange'],
  );
  receive({
    type: 'OocResult',
    command: 'UndoOocChange',
    actionId: 'a3',
    result: { ok: true, value: { revision: 6, summary: PROPOSAL.summary } },
  });
  assert.equal(client.state().ooc.undoable, undefined);
});

test('rpg-42a.91: a rejected message or confirmation shows the error and keeps the proposal open', () => {
  const { client, receive, html } = connected();
  client.submit('/gm hello');
  receive({
    type: 'OocResult',
    command: 'SubmitOocMessage',
    actionId: 'a0',
    result: { ok: false, error: { code: 'Rejected', message: 'engine is busy' } },
  });
  assert.match(html(), /engine is busy/);
  client.submit('/gm remember');
  answered(receive, 'a1');
  client.confirmOoc('a1', 0);
  receive({
    type: 'OocResult',
    command: 'ConfirmOocProposal',
    actionId: 'a2',
    result: { ok: false, error: { code: 'StaleRevision', message: 'stale' } },
  });
  assert.equal(client.state().ooc.exchanges[1]?.proposals[0]?.status, 'open');
  assert.match(html(), /stale/);
});

test('rpg-42a.91: the toggle label and panel are localized in English and Brazilian Portuguese', () => {
  const { client, html } = connected();
  client.toggleOoc();
  client.submit('/gm oi');
  assert.equal(translate('en', 'ooc.toggle'), 'Talk to the GM');
  assert.equal(translate('pt-BR', 'ooc.toggle'), 'Falar com o mestre');
  assert.equal(translate('es', 'ooc.toggle'), 'Hablar con el narrador');
  assert.match(html('en'), /Out-of-character chat with the GM/);
  assert.match(html('pt-BR'), /Conversa com o mestre fora do personagem/);
  assert.match(html('pt-BR'), /Você \(fora do personagem\)/);
  assert.match(html('es'), /Charla con el narrador fuera del personaje/);
});
