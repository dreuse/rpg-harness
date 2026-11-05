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
  REGIONS,
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

const SHEET_VIEW = {
  campaignId: CAMPAIGN,
  viewId: 'sheet',
  components: [{ kind: 'field', id: 'name', label: 'Name' }],
};

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
    ['ListCampaigns', 'SubscribeEvents', 'GetCampaignSnapshot', 'RequestView'],
  );
  assert.deepEqual(wire.sent[0], { version: PROTOCOL_VERSION, type: 'ListCampaigns' });
  assert.deepEqual(wire.sent[1], { version: PROTOCOL_VERSION, type: 'SubscribeEvents', campaignId: CAMPAIGN });

  const wide = viewModel(client.state(), WIDE_WIDTH);
  assert.equal(wide.layout.name, 'wide');
  assert.deepEqual(wide.layout.columns, [['campaigns'], ['status', 'conversation'], ['sheet', 'panels']]);
  assert.deepEqual(
    wide.home.cards.map(({ name, selected }) => [name, selected]),
    [
      ['Harbor', true],
      ['Spire', false],
    ],
  );
  assert.deepEqual(wide.conversation, [
    { actionId: 'old', input: 'input old', narration: 'narration old', pending: false },
  ]);
  assert.deepEqual(wide.sheet, SHEET_VIEW);
  assert.deepEqual(wide.panels?.inventory, PANELS.inventory);
  assert.equal(wide.status.label, 'Connected');
  assert.deepEqual(wide.title, { campaign: 'Harbor', scene: 'Docks' });
  assert.deepEqual(wide.diagnostics, { pid: 42, gm: 'fake', error: undefined, attempts: 0 });

  assert.equal(viewModel(client.state(), MEDIUM_WIDTH).layout.name, 'medium');
  const compact = viewModel(client.state(), COMPACT_WIDTH).layout;
  assert.deepEqual(compact, { name: 'compact', columns: [['status', 'conversation', 'sheet', 'panels', 'campaigns']] });
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
    view: { campaignId: CAMPAIGN, viewId: 'sheet', components: [{ kind: 'script', id: 'x', label: 'x' }] },
  });
  assert.deepEqual(viewModel(client.state(), WIDE_WIDTH).sheet, SHEET_VIEW);

  client.select(OTHER);
  const switched = viewModel(client.state(), WIDE_WIDTH);
  assert.equal(switched.home.cards.find(({ selected }) => selected)?.name, 'Spire');
  assert.deepEqual(switched.conversation, []);
  assert.equal(switched.sheet, undefined);
  wire.receive({ type: 'View', campaignId: CAMPAIGN, view: SHEET_VIEW });
  assert.equal(viewModel(client.state(), WIDE_WIDTH).sheet, undefined);
  assert.deepEqual(wire.sent.at(-2), { version: PROTOCOL_VERSION, type: 'GetCampaignSnapshot', campaignId: OTHER });
});

test('UI08: offline / disconnected engine state is shown accurately with safe retry', () => {
  const wire = fakeTransport();
  const client = createDesktopClient({ transport: wire.transport, newActionId: ids() });
  assert.equal(wire.connects(), 1);
  assert.deepEqual(viewModel(client.state(), WIDE_WIDTH).status, {
    connection: 'connecting',
    label: 'Connecting',
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
    label: 'Offline',
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
    label: 'Reconnecting (attempt 1)',
    canRetry: false,
    queued: 2,
  });
  wire.close('spawn failed');
  client.retry();
  assert.equal(client.state().connection.attempts, 2);
  assert.equal(wire.sent.length, sentBefore);

  wire.receive(READY);
  assert.deepEqual(
    wire.sent.slice(sentBefore).map(({ type }) => type),
    ['ListCampaigns', 'SubscribeEvents', 'GetCampaignSnapshot', 'RequestView'],
  );
  assert.equal(client.state().connection.attempts, 0);
  wire.receive({ type: 'Snapshot', snapshot: snapshotAt(3) });
  const resent = wire.sent.slice(sentBefore).filter(({ type }) => type === 'SubmitPlayerAction');
  assert.deepEqual(
    resent.map((command) => command.type === 'SubmitPlayerAction' && [command.actionId, command.expectedRevision]),
    [
      ['a0', 3],
      ['a1', 3],
    ],
  );
  wire.receive({ type: 'Snapshot', snapshot: snapshotAt(3) });
  assert.equal(wire.sent.filter(({ type }) => type === 'SubmitPlayerAction').length, resent.length + 1);

  wire.receive({ type: 'Accepted', actionId: 'a0', revision: 2 });
  wire.receive({ type: 'Accepted', actionId: 'a0', revision: 2 });
  wire.receive({ type: 'Rejected', actionId: 'a1', error: { code: 'Rejected', message: 'stale revision' } });
  wire.receive({ type: 'Snapshot', snapshot: snapshotAt(4, ['a0']) });
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
    views: {
      sheet: {
        campaignId: CAMPAIGN,
        viewId: 'sheet',
        components: [{ kind: 'progress', id: 'hp', label: 'HP', value: '7/10' }],
      },
    },
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
  assert.equal(label({ status: 'connecting', attempts: 0 }), 'Conectando');
  assert.equal(label({ status: 'connected', attempts: 0, engine: { pid: 42, gm: 'fake' } }), 'Conectado');
  assert.equal(label({ status: 'disconnected', attempts: 0, lastError: 'boom' }), 'Sin conexión');
  assert.equal(label({ status: 'reconnecting', attempts: 2 }), 'Reconectando (intento 2)');
});

test('rpg-42a.18 every pane is in the layout at every width', () => {
  for (const width of [COMPACT_WIDTH, MEDIUM_WIDTH, WIDE_WIDTH])
    assert.deepEqual(layoutFor(width).columns.flat().toSorted(), [...REGIONS].toSorted(), String(width));
  assert.deepEqual(layoutFor(MEDIUM_WIDTH).columns, [
    ['status', 'conversation'],
    ['sheet', 'panels', 'campaigns'],
  ]);
});

test('rpg-42a.18 the disconnect error stays in diagnostics, not in the status label', () => {
  const connection = { status: 'disconnected', attempts: 3, lastError: 'Engine 42 exited (1).' } as const;
  const model = viewModel({ ...initialState, connection }, WIDE_WIDTH);
  assert.equal(model.status.label, 'Offline');
  assert.deepEqual(model.diagnostics, { pid: undefined, gm: undefined, error: connection.lastError, attempts: 3 });
  assert.deepEqual(model.title, { campaign: undefined, scene: undefined });
});

test('rpg-p5p5: queued actions rebase onto a newer snapshot revision and keep their action id', () => {
  const { wire, client } = connectedClient();
  wire.close('Engine 42 exited (1).');
  assert.equal(client.submit('hide').ok, true);
  assert.deepEqual(
    client.state().outbox.map(({ actionId, expectedRevision }) => [actionId, expectedRevision]),
    [['a0', 1]],
  );
  wire.receive(READY);
  wire.receive({ type: 'Snapshot', snapshot: { ...snapshotAt(5), campaignId: OTHER } });
  assert.equal(client.state().outbox[0]?.expectedRevision, 1);
  wire.receive({ type: 'Snapshot', snapshot: snapshotAt(5) });
  const [rebased] = client.state().outbox;
  assert.equal(rebased?.actionId, 'a0');
  assert.equal(rebased?.expectedRevision, 5);
  assert.ok(Object.isFrozen(rebased));
  assert.deepEqual(wire.sent.at(-1), rebased);
  wire.receive({ type: 'Snapshot', snapshot: snapshotAt(0) });
  assert.equal(client.state().outbox[0]?.expectedRevision, 5);
});

test('rpg-p5p5: an action submitted between Ready and the first snapshot is sent once, rebased', () => {
  const { wire, client } = connectedClient();
  wire.close('Engine 42 exited (1).');
  wire.receive(READY);
  assert.equal(client.submit('duck').ok, true);
  wire.receive({ type: 'Snapshot', snapshot: snapshotAt(4) });
  const submitted = wire.sent.filter(({ type }) => type === 'SubmitPlayerAction');
  assert.deepEqual(
    submitted.map((command) => command.type === 'SubmitPlayerAction' && [command.actionId, command.expectedRevision]),
    [['a0', 4]],
  );
});

test('A21 a disconnect clears pending voice saves', () => {
  const { wire, client } = connectedClient();
  assert.equal(client.saveVoice({ microphone: 'off', spokenOutput: 'off', locale: 'en', speed: 1 }).ok, true);
  assert.equal(client.voicePending(), true);
  wire.close('Engine 42 exited (1).');
  assert.equal(client.voicePending(), false);
});

const NOW = Date.parse('2026-11-04T12:00:00.000Z');
const HOUR_MS = 3_600_000;
const HARBOR = {
  id: CAMPAIGN,
  name: 'Harbor',
  health: 'ok',
  lastPlayedAt: new Date(NOW - HOUR_MS).toISOString(),
  sceneTitle: 'Docks',
  characters: [{ id: 'hero', name: 'Ash' }],
  ruleset: { id: 'narrative', edition: 'original', revision: 'r1', provenance: 'explicit' },
  genre: { id: 'fantasy', version: '1.0.0', provenance: 'derived' },
  lastNarration: 'The tide turns.',
  turnCount: 1,
};
const BROKEN = { id: null, name: 'Junk', health: 'unreadable' };
const homeClient = () => {
  const wire = fakeTransport();
  const client = createDesktopClient({ transport: wire.transport, newActionId: ids() });
  wire.receive(READY);
  wire.receive({
    type: 'Campaigns',
    campaigns: [BROKEN, HARBOR, { name: 7 }],
    archived: [{ ...HARBOR, name: 'Spire' }],
  });
  return { wire, client };
};
const changed = (command: object, result: object) => ({ type: 'Changed', command, result });
const OK = { ok: true, value: { version: PROTOCOL_VERSION, name: 'Harbor' } };

test('rpg-42a.13 the home lists every campaign by last played, keeps unhealthy ones and shows where play stopped', () => {
  const { client } = homeClient();
  const { home, playing } = viewModel(client.state(), WIDE_WIDTH, DEFAULT_PREFERENCES, NOW);
  assert.equal(playing, false);
  assert.deepEqual(
    home.cards.map(({ name, playable, when }) => [name, playable, when]),
    [
      ['Harbor', true, '1 hour ago'],
      ['Junk', false, undefined],
    ],
  );
  assert.deepEqual(
    [home.cards[0]?.characters, home.cards[0]?.rules, home.cards[0]?.scene, home.cards[0]?.narration],
    ['Ash', 'narrative original, fantasy', 'Docks', 'The tide turns.'],
  );
  assert.deepEqual(
    home.archived.map(({ name }) => name),
    ['Spire'],
  );
  assert.equal(home.search, false);
});

test('rpg-42a.13 continue opens the campaign in the engine and follows it once the engine serves it', () => {
  const { wire, client } = homeClient();
  client.continueCampaign('Harbor');
  const open = { version: PROTOCOL_VERSION, type: 'OpenCampaign', name: 'Harbor' };
  assert.deepEqual(wire.sent.at(-1), open);
  assert.equal(client.state().selected, undefined);
  wire.receive(changed(open, { ok: true, value: HARBOR }));
  assert.equal(client.state().selected, CAMPAIGN);
  assert.deepEqual(
    wire.sent.slice(-4).map(({ type }) => type),
    ['SubscribeEvents', 'GetCampaignSnapshot', 'RequestView', 'ListCampaigns'],
  );
  wire.receive(
    changed(
      { ...open, name: 'Nowhere' },
      { ok: false, error: { code: 'Rejected', message: 'No campaign named Nowhere.' } },
    ),
  );
  assert.equal(viewModel(client.state(), WIDE_WIDTH).home.error, 'No campaign named Nowhere.');
});

test('rpg-42a.13 archive and delete wait for confirmation and archive can be undone', () => {
  const { wire, client } = homeClient();
  const sentBefore = wire.sent.length;
  client.askHome('archive', 'Harbor');
  assert.deepEqual(viewModel(client.state(), WIDE_WIDTH).home.confirm, { kind: 'archive', name: 'Harbor' });
  client.cancelHome();
  assert.equal(viewModel(client.state(), WIDE_WIDTH).home.confirm, undefined);
  assert.equal(wire.sent.length, sentBefore);
  client.askHome('archive', 'Harbor');
  client.confirmHome();
  const archive = { version: PROTOCOL_VERSION, type: 'ArchiveCampaign', name: 'Harbor' };
  assert.deepEqual(wire.sent.at(-1), archive);
  wire.receive(changed(archive, OK));
  assert.equal(viewModel(client.state(), WIDE_WIDTH).home.undo, 'Harbor');
  assert.equal(wire.sent.at(-1)?.type, 'ListCampaigns');
  client.undoArchive();
  const unarchive = { version: PROTOCOL_VERSION, type: 'UnarchiveCampaign', name: 'Harbor' };
  assert.deepEqual(wire.sent.at(-1), unarchive);
  wire.receive(changed(unarchive, OK));
  assert.equal(viewModel(client.state(), WIDE_WIDTH).home.undo, undefined);
  client.askHome('delete', 'Junk');
  client.confirmHome();
  assert.deepEqual(wire.sent.at(-1), {
    version: PROTOCOL_VERSION,
    type: 'DeleteCampaign',
    name: 'Junk',
    confirm: 'Junk',
  });
  client.unarchive('Spire');
  assert.deepEqual(wire.sent.at(-1), { ...unarchive, name: 'Spire' });
});

test('rpg-42a.13 search shows only after more than five campaigns and filters the cards', () => {
  const wire = fakeTransport();
  const client = createDesktopClient({ transport: wire.transport, newActionId: ids() });
  wire.receive(READY);
  const many = Array.from({ length: 5 }, (_, index) => ({
    ...HARBOR,
    id: `c${index + 10}`,
    name: `Tale ${index}`,
    characters: [],
  }));
  wire.receive({ type: 'Campaigns', campaigns: [...many, HARBOR] });
  assert.equal(viewModel(client.state(), WIDE_WIDTH).home.search, true);
  client.search('ash');
  const { home } = viewModel(client.state(), WIDE_WIDTH);
  assert.equal(home.query, 'ash');
  assert.deepEqual(
    home.cards.map(({ name }) => name),
    ['Harbor'],
  );
});
