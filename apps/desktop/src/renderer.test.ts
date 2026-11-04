import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type CampaignPanels,
  type CampaignSnapshot,
  type ClientCommand,
  EVENT_COMMITTED,
  PROTOCOL_VERSION,
} from '../../../packages/client-protocol/src/protocol.ts';
import { DEFAULT_PREFERENCES } from './accessibility.ts';
import {
  createDesktopClient,
  type DesktopState,
  initialState,
  layoutFor,
  type Transport,
  viewModel,
} from './renderer.ts';

const CAMPAIGN = 'c1';
const OTHER = 'c2';
const COMPACT_WIDTH = 480;
const MEDIUM_WIDTH = 1000;
const WIDE_WIDTH = 1600;
const READY = { type: 'Ready', version: PROTOCOL_VERSION, pid: 42, node: 'v24', sqlite: true, gm: 'fake' };

const snapshotAt = (revision: number, actionIds: readonly string[] = []): CampaignSnapshot => ({
  version: PROTOCOL_VERSION,
  campaignId: CAMPAIGN,
  revision,
  campaign: { id: CAMPAIGN, name: 'Harbor' },
  characters: [{ id: 'hero', campaignId: CAMPAIGN, name: 'Ash' }],
  currentScene: { id: 's1', campaignId: CAMPAIGN, title: 'Docks' },
  turns: actionIds.map((actionId, index) => ({
    id: `t${index}`,
    campaignId: CAMPAIGN,
    sceneId: 's1',
    actionId,
    actorId: 'hero',
    input: `input ${actionId}`,
    narration: `narration ${actionId}`,
  })),
});

const PANELS: CampaignPanels = {
  version: PROTOCOL_VERSION,
  campaignId: CAMPAIGN,
  revision: 1,
  inventory: [{ id: 'rope', name: 'Rope' }],
  quests: [],
  citations: [],
  recap: { scene: 'Docks', latest: undefined },
};

const SHEET_VIEW = { viewId: 'sheet', components: [{ kind: 'field', id: 'name', label: 'Name' }] };

const fakeTransport = () => {
  const sent: ClientCommand[] = [];
  let onLine = (_line: string) => {};
  let onClose = (_error: string) => {};
  let connects = 0;
  const transport: Transport = {
    connect: () => {
      connects += 1;
    },
    send: (line) => {
      sent.push(JSON.parse(line) as ClientCommand);
    },
    onLine: (listener) => {
      onLine = listener;
    },
    onClose: (listener) => {
      onClose = listener;
    },
  };
  return {
    transport,
    sent,
    connects: () => connects,
    receive: (message: object) => onLine(JSON.stringify(message)),
    receiveRaw: (line: string) => onLine(line),
    close: (error: string) => onClose(error),
  };
};

const ids = () => {
  let next = 0;
  return () => `a${next++}`;
};

const connectedClient = () => {
  const wire = fakeTransport();
  const client = createDesktopClient({ transport: wire.transport, newActionId: ids() });
  wire.receive(READY);
  wire.receive({ type: 'Campaigns', campaigns: [snapshotAt(0).campaign, { id: OTHER, name: 'Spire' }] });
  client.select(CAMPAIGN);
  wire.receive({ type: 'Snapshot', snapshot: snapshotAt(1, ['old']) });
  wire.receive({ type: 'Panels', panels: PANELS });
  wire.receive({ type: 'View', campaignId: CAMPAIGN, view: SHEET_VIEW });
  return { wire, client };
};

test('UI08: provide responsive desktop conversation, sheets, panels and campaign selection', () => {
  const { wire, client } = connectedClient();
  assert.deepEqual(
    wire.sent.map(({ type }) => type),
    ['GetCampaignSnapshot', 'RequestView'],
  );

  const wide = viewModel(client.state(), WIDE_WIDTH);
  assert.equal(wide.layout.name, 'wide');
  assert.deepEqual(wide.layout.columns, [['campaigns'], ['status', 'conversation'], ['sheet', 'panels']]);
  assert.deepEqual(wide.campaigns, [
    { id: CAMPAIGN, name: 'Harbor', selected: true },
    { id: OTHER, name: 'Spire', selected: false },
  ]);
  assert.deepEqual(wide.conversation, [
    { actionId: 'old', input: 'input old', narration: 'narration old', pending: false },
  ]);
  assert.deepEqual(wide.sheet, SHEET_VIEW);
  assert.deepEqual(wide.panels?.inventory, PANELS.inventory);
  assert.equal(wide.status.label, 'Connected to engine 42 (fake GM)');

  assert.equal(viewModel(client.state(), MEDIUM_WIDTH).layout.name, 'medium');
  const compact = viewModel(client.state(), COMPACT_WIDTH).layout;
  assert.deepEqual(compact, { name: 'compact', columns: [['status', 'conversation', 'sheet', 'panels']] });
  assert.equal(layoutFor(Number.NaN).name, 'compact');

  const submitted = client.submit('look around');
  assert.equal(submitted.ok, true);
  assert.deepEqual(wire.sent.at(-1), {
    version: PROTOCOL_VERSION,
    type: 'SubmitPlayerAction',
    campaignId: CAMPAIGN,
    actionId: 'a0',
    expectedRevision: 1,
    sceneId: 's1',
    actorId: 'hero',
    input: 'look around',
  });
  assert.equal(viewModel(client.state(), WIDE_WIDTH).conversation.at(-1)?.pending, true);
  wire.receive({ type: 'Accepted', actionId: 'a0', revision: 2 });
  wire.receive({ version: PROTOCOL_VERSION, type: EVENT_COMMITTED, revision: 2, event: { campaignId: CAMPAIGN } });
  assert.deepEqual(
    wire.sent.slice(-2).map(({ type }) => type),
    ['GetCampaignSnapshot', 'RequestView'],
  );
  wire.receive({ type: 'Snapshot', snapshot: snapshotAt(2, ['old', 'a0']) });
  assert.deepEqual(
    viewModel(client.state(), WIDE_WIDTH).conversation.map(({ actionId, pending }) => [actionId, pending]),
    [
      ['old', false],
      ['a0', false],
    ],
  );

  wire.receive({
    type: 'View',
    campaignId: CAMPAIGN,
    view: { viewId: 'sheet', components: [{ kind: 'script', id: 'x', label: 'x' }] },
  });
  assert.deepEqual(viewModel(client.state(), WIDE_WIDTH).sheet, SHEET_VIEW);

  client.select(OTHER);
  const switched = viewModel(client.state(), WIDE_WIDTH);
  assert.equal(switched.campaigns.find(({ selected }) => selected)?.id, OTHER);
  assert.deepEqual(switched.conversation, []);
  assert.equal(switched.sheet, undefined);
  wire.receive({ type: 'View', campaignId: CAMPAIGN, view: SHEET_VIEW });
  assert.equal(viewModel(client.state(), WIDE_WIDTH).sheet, undefined);
  assert.equal(wire.sent.at(-2)?.campaignId, OTHER);
});

test('UI08: offline / disconnected engine state is shown accurately with safe retry', () => {
  const wire = fakeTransport();
  const client = createDesktopClient({ transport: wire.transport, newActionId: ids() });
  assert.equal(wire.connects(), 1);
  assert.deepEqual(viewModel(client.state(), WIDE_WIDTH).status, {
    connection: 'connecting',
    label: 'Connecting to engine',
    canRetry: false,
    queued: 0,
  });
  wire.receive({ ...READY, version: PROTOCOL_VERSION + 1 });
  assert.equal(client.state().connection.status, 'disconnected');
  assert.match(client.state().connection.lastError ?? '', /unsupported engine protocol/);
  wire.receiveRaw('not json');
  assert.equal(client.state().connection.status, 'disconnected');

  wire.receive(READY);
  wire.receive({ type: 'Campaigns', campaigns: [snapshotAt(0).campaign] });
  client.select(CAMPAIGN);
  wire.receive({ type: 'Snapshot', snapshot: snapshotAt(1) });
  assert.equal(client.submit('open the door').ok, true);
  const sentBefore = wire.sent.length;

  wire.close('Engine 42 exited (1).');
  assert.deepEqual(viewModel(client.state(), WIDE_WIDTH).status, {
    connection: 'disconnected',
    label: 'Engine offline: Engine 42 exited (1).',
    canRetry: true,
    queued: 1,
  });
  assert.equal(client.submit('wait').ok, true);
  assert.equal(wire.sent.length, sentBefore);
  assert.equal(viewModel(client.state(), WIDE_WIDTH).status.queued, 2);

  client.retry();
  client.retry();
  assert.equal(wire.connects(), 2);
  assert.deepEqual(viewModel(client.state(), WIDE_WIDTH).status, {
    connection: 'reconnecting',
    label: 'Reconnecting to engine (attempt 1)',
    canRetry: false,
    queued: 2,
  });
  wire.close('spawn failed');
  client.retry();
  assert.equal(client.state().connection.attempts, 2);
  assert.equal(wire.sent.length, sentBefore);

  wire.receive(READY);
  const resent = wire.sent.slice(sentBefore).filter(({ type }) => type === 'SubmitPlayerAction');
  assert.deepEqual(
    resent.map((command) => command.type === 'SubmitPlayerAction' && command.actionId),
    ['a0', 'a1'],
  );
  assert.equal(client.state().connection.attempts, 0);

  wire.receive({ type: 'Accepted', actionId: 'a0', revision: 2 });
  wire.receive({ type: 'Accepted', actionId: 'a0', revision: 2 });
  wire.receive({ type: 'Rejected', actionId: 'a1', error: { code: 'Rejected', message: 'stale revision' } });
  wire.receive({ type: 'Snapshot', snapshot: snapshotAt(2, ['a0']) });
  const shown = viewModel(client.state(), WIDE_WIDTH);
  assert.deepEqual(
    shown.conversation.map(({ actionId }) => actionId),
    ['a0'],
  );
  assert.equal(shown.status.queued, 0);
  assert.deepEqual(shown.rejected, [{ actionId: 'a1', input: 'wait', message: 'stale revision' }]);
});

test('UI10 view model carries font scale, motion flag and text-only sheet labels', () => {
  const state = {
    ...initialState,
    views: { sheet: { viewId: 'sheet', components: [{ kind: 'progress', id: 'hp', label: 'HP', value: '7/10' }] } },
  } as DesktopState;
  const model = viewModel(state, WIDE_WIDTH, { ...DEFAULT_PREFERENCES, fontScale: 1.5, reducedMotion: true });
  assert.equal(model.fontScale, 1.5);
  assert.equal(model.animate, false);
  assert.deepEqual(model.sheetLabels, [{ id: 'hp', label: 'HP: 7 of 10' }]);
  assert.deepEqual(viewModel(initialState, WIDE_WIDTH).sheetLabels, []);
});

test('UI10 status label follows the locale preference', () => {
  const es = { ...DEFAULT_PREFERENCES, locale: 'es' };
  const label = (connection: DesktopState['connection']) =>
    viewModel({ ...initialState, connection }, WIDE_WIDTH, es).status.label;
  assert.equal(label({ status: 'connecting', attempts: 0 }), 'Conectando con el motor');
  assert.equal(
    label({ status: 'connected', attempts: 0, engine: { pid: 42, gm: 'fake' } }),
    'Conectado al motor 42 (GM fake)',
  );
  assert.equal(label({ status: 'disconnected', attempts: 0, lastError: 'boom' }), 'Motor sin conexión: boom');
  assert.equal(label({ status: 'reconnecting', attempts: 2 }), 'Reconectando con el motor (intento 2)');
});
