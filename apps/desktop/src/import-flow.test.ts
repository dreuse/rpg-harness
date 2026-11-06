import assert from 'node:assert/strict';
import { test } from 'node:test';
import { INITIAL_DRAFT, START_STEPS, type StartDraft } from '../../../packages/client-protocol/src/guided-start.ts';
import { PROTOCOL_VERSION } from '../../../packages/client-protocol/src/protocol.ts';
import { DEFAULT_PREFERENCES } from './accessibility.ts';
import type { ImportRequest, ImportResult } from './preload.ts';
import { createDesktopClient, type Transport, viewModel } from './renderer.ts';
import { renderView } from './view.ts';

const WIDE_WIDTH = 1400;
const READY = { type: 'Ready', version: PROTOCOL_VERSION, pid: 7, node: 'v24', sqlite: true, gm: 'fake' };
const REPORT = ['Rule pack: d20-lite edition original revision 1.', 'No gaps found.'];
const HOSTILE = '<img src=x onerror=alert(1)>';
const RULES_STEP = START_STEPS.guide.indexOf('rules');
const PICKED: StartDraft = {
  ...INITIAL_DRAFT,
  path: 'guide',
  step: RULES_STEP,
  choices: { ruleset: { id: 'd20-lite', edition: 'original' } },
};
const UNPICKED: StartDraft = { ...PICKED, choices: {} };
const OPTIONS = {
  genres: [],
  rulesets: [{ id: 'd20-lite', edition: 'original', blurb: 'Light.', recommended: true, readyMade: true, sheet: [] }],
};

const harness = (results: ImportResult[], draft: StartDraft = PICKED) => {
  const sent: { type: string }[] = [];
  const requests: ImportRequest[] = [];
  let receive = (_line: string) => {};
  const transport: Transport = {
    connect: () => {},
    send: (line) => sent.push(JSON.parse(line)),
    onLine: (listener) => {
      receive = listener;
    },
    onClose: () => {},
  };
  const client = createDesktopClient({
    transport,
    newActionId: () => 'a',
    startDraft: draft,
    importRulebook: async (request) => {
      requests.push(request);
      return results.shift() ?? { status: 'cancelled' };
    },
  });
  receive(JSON.stringify(READY));
  sent.length = 0;
  return { client, sent, requests };
};

const htmlOf = (client: ReturnType<typeof harness>['client']) =>
  renderView(
    viewModel({ ...client.state(), start: { ...client.state().start, open: true, options: OPTIONS } }, WIDE_WIDTH),
    DEFAULT_PREFERENCES.locale,
  );

test('rpg-42a.68 importing needs a chosen rule pack and never picks one silently', async () => {
  const { client, requests } = harness([], UNPICKED);
  await client.importRulebook();
  assert.equal(client.state().start.import?.status, 'needsPack');
  assert.deepEqual(requests, []);
});

test('rpg-42a.68 a picked file shows the report and a cancelled dialog leaves nothing behind', async () => {
  const { client, requests } = harness([{ status: 'preview', lines: REPORT }, { status: 'cancelled' }]);
  await client.importRulebook();
  assert.deepEqual(requests, [{ kind: 'pick', packId: 'd20-lite' }]);
  assert.deepEqual(client.state().start.import, { status: 'preview', lines: REPORT });
  await client.importRulebook();
  assert.equal(client.state().start.import, undefined);
});

test('rpg-42a.68 accepting installs and refreshes the start options', async () => {
  const { client, sent, requests } = harness([
    { status: 'preview', lines: REPORT },
    { status: 'installed', lines: ['Installed ruleset d20-lite-import-abc.'] },
  ]);
  await client.importRulebook();
  assert.deepEqual(sent, []);
  await client.decideImport('activate');
  assert.deepEqual(requests.at(-1), { kind: 'decide', decision: 'activate' });
  assert.equal(client.state().start.import?.status, 'installed');
  assert.deepEqual(
    sent.map(({ type }) => type),
    ['PlanCampaign'],
  );
});

test('rpg-42a.68 declining keeps the options and a failed bridge call is shown, not thrown', async () => {
  const { client, sent } = harness([
    { status: 'preview', lines: REPORT },
    { status: 'declined', lines: ['Declined.'] },
  ]);
  await client.importRulebook();
  await client.decideImport('decline');
  assert.equal(client.state().start.import?.status, 'declined');
  assert.deepEqual(sent, []);
  const broken = createDesktopClient({
    transport: { connect: () => {}, send: () => {}, onLine: () => {}, onClose: () => {} },
    newActionId: () => 'a',
    startDraft: PICKED,
    importRulebook: async () => {
      throw new Error('dialog closed');
    },
  });
  await broken.importRulebook();
  assert.deepEqual(broken.state().start.import, { status: 'failed', lines: ['dialog closed'] });
});

test('rpg-42a.68 changing the start step or choice drops a stale report', async () => {
  const { client } = harness([{ status: 'preview', lines: REPORT }]);
  await client.importRulebook();
  client.startAction({ kind: 'choose', field: 'ruleset', value: { id: 'narrative', edition: 'original' } });
  assert.equal(client.state().start.import, undefined);
});

test('rpg-42a.68 the rules step offers the import button with desktop wording and no CLI command', async () => {
  const { client } = harness([]);
  const html = htmlOf(client);
  assert.match(html, /<button type="button" data-start-import="pick">Import a rulebook<\/button>/);
  assert.doesNotMatch(html, /rpg import/);
  const other = htmlOf(harness([], { ...PICKED, step: RULES_STEP - 1 }).client);
  assert.doesNotMatch(other, /data-start-import/);
});

test('rpg-42a.68 the report is escaped text with accept and decline and no pack is chosen for the player', async () => {
  const { client } = harness([{ status: 'preview', lines: [HOSTILE, ...REPORT] }]);
  await client.importRulebook();
  const html = htmlOf(client);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img src=x/);
  assert.match(html, /data-start-import="activate">Accept/);
  assert.match(html, /data-start-import="decline">Decline/);
});

test('rpg-42a.68 the import wording is available in Portuguese', async () => {
  const { client } = harness([]);
  const html = renderView(
    viewModel({ ...client.state(), start: { ...client.state().start, open: true, options: OPTIONS } }, WIDE_WIDTH),
    'pt-BR',
  );
  assert.match(html, /data-start-import="pick">Importar um livro de regras</);
});
