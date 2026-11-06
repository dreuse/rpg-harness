import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type CampaignPanels,
  type CampaignSnapshot,
  type ClientCommand,
  EVENT_COMMITTED,
  PROTOCOL_VERSION,
} from '../../../packages/client-protocol/src/protocol.ts';
import { VISUALIZATION_EVENT } from '../../../packages/client-protocol/src/visualization.ts';
import { DEFAULT_PREFERENCES } from './accessibility.ts';
import {
  createDesktopClient,
  type DesktopState,
  initialState,
  layoutFor,
  PLAY_REGIONS,
  parseSheetValue,
  type Transport,
  viewModel,
} from './renderer.ts';
import { renderView } from './view.ts';

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
  assert.deepEqual(wide.layout.columns, [['conversation'], ['sheet', 'panels']]);
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
  assert.deepEqual(wide.scene, { id: 's1', campaignId: CAMPAIGN, title: 'Docks' });
  assert.equal(wide.character, 'Ash');
  assert.deepEqual(wide.diagnostics, { pid: 42, gm: 'fake', error: undefined, attempts: 0 });

  assert.equal(viewModel(client.state(), MEDIUM_WIDTH).layout.name, 'medium');
  const compact = viewModel(client.state(), COMPACT_WIDTH).layout;
  assert.deepEqual(compact, { name: 'compact', columns: [['conversation', 'sheet', 'panels']] });
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
  assert.deepEqual(model.sheetGroups, [
    {
      id: '',
      fields: [{ id: 'hp', name: 'HP', text: '7 of 10', value: '7/10', editable: false, changed: false }],
    },
  ]);
  assert.deepEqual(viewModel(initialState, WIDE_WIDTH).sheetGroups, []);
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

test('rpg-42a.18 every play pane is in the layout at every width', () => {
  for (const width of [COMPACT_WIDTH, MEDIUM_WIDTH, WIDE_WIDTH])
    assert.deepEqual(layoutFor(width).columns.flat().toSorted(), [...PLAY_REGIONS].toSorted(), String(width));
  assert.deepEqual(layoutFor(MEDIUM_WIDTH).columns, [['conversation'], ['sheet', 'character', 'panels']]);
});

test('rpg-42a.22 going home leaves the adventure, clears its panes and refreshes the list', () => {
  const { wire, client } = connectedClient();
  client.goHome();
  const state = client.state();
  assert.equal(state.selected, undefined);
  assert.equal(state.snapshot, undefined);
  assert.equal(state.panels, undefined);
  assert.deepEqual(state.views, {});
  assert.deepEqual(wire.sent.at(-1), { version: PROTOCOL_VERSION, type: 'ListCampaigns' });
  const model = viewModel(state, WIDE_WIDTH);
  assert.equal(model.playing, false);
  assert.equal(model.character, undefined);
  wire.receive({ type: 'Snapshot', snapshot: snapshotAt(2) });
  assert.equal(client.state().snapshot, undefined);
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

test('rpg-42a.37: GM settings save at the snapshot revision and usage reaches the view', () => {
  const { wire, client } = connectedClient();
  const saved = client.saveGm({ model: 'opus', sessionBudgetTokens: 500 });
  assert.equal(saved.ok, true);
  assert.deepEqual(wire.sent.at(-1), {
    version: PROTOCOL_VERSION,
    type: 'SaveGmSettings',
    campaignId: CAMPAIGN,
    actionId: 'a0',
    expectedRevision: 1,
    model: 'opus',
    sessionBudgetTokens: 500,
  });
  wire.receive({ type: 'Rejected', actionId: 'a0', error: { code: 'Rejected', message: 'bad model' } });
  assert.deepEqual(client.state().rejected.at(-1), { actionId: 'a0', input: 'GM settings', message: 'bad model' });
  const usage = {
    turns: 1,
    inputTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 1,
    costUsd: 0,
    pricedTurns: 0,
  };
  const gm = {
    settings: { model: 'opus' },
    campaignSettings: { model: 'opus' },
    defaults: {},
    session: usage,
    campaign: usage,
  };
  wire.receive({ type: 'Snapshot', snapshot: { ...snapshotAt(2), gm } });
  assert.deepEqual(viewModel(client.state(), WIDE_WIDTH).gm, gm);
  assert.equal(client.saveGmDefaults({ model: 'sonnet' }).ok, true);
  assert.deepEqual(wire.sent.at(-1), {
    version: PROTOCOL_VERSION,
    type: 'SaveGmDefaults',
    campaignId: CAMPAIGN,
    actionId: 'a1',
    model: 'sonnet',
  });
  wire.receive({ type: 'Rejected', actionId: 'a1', error: { code: 'Rejected', message: 'bad default' } });
  assert.deepEqual(client.state().rejected.at(-1), { actionId: 'a1', input: 'GM settings', message: 'bad default' });
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
    ['Ash', 'Story only: no dice, no sheet, Fantasy', 'Docks', 'The tide turns.'],
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

test('rpg-42a.66 rename sends RenameCampaign and refreshes the list', () => {
  const { wire, client } = homeClient();
  client.rename('Harbor', 'Beacon');
  const rename = { version: PROTOCOL_VERSION, type: 'RenameCampaign', name: 'Harbor', newName: 'Beacon' };
  assert.deepEqual(wire.sent.at(-1), rename);
  wire.receive(changed(rename, OK));
  assert.equal(wire.sent.at(-1)?.type, 'ListCampaigns');
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

const rollEvent = (resultId: string, face: number) => ({
  version: PROTOCOL_VERSION,
  type: VISUALIZATION_EVENT,
  resultId,
  mechanic: 'dice',
  frames: [{ step: 0, reveal: { kind: 'die', sides: 20, face } }],
  final: { total: face, outcome: 'success' },
});

test('UI15: a roll never blocks input or delays the committed turn', () => {
  const { wire, client } = connectedClient();
  wire.receive(rollEvent('r1', 17));
  assert.equal(client.state().rolling, true);
  const submitted = client.submit('I climb');
  assert.equal(submitted.ok, true);
  assert.equal(wire.sent.at(-1)?.type, 'SubmitPlayerAction');
  wire.receive({ type: 'Snapshot', snapshot: snapshotAt(2, ['old', 'a0']) });
  const model = viewModel(client.state(), WIDE_WIDTH);
  assert.equal(model.conversation.at(-1)?.narration, 'narration a0');
  assert.equal(model.rolls[0]?.animated, true);
  assert.equal(model.rolls[0]?.groups[0]?.dice[0]?.at(-1), 17);
});

test('rpg-42a.35: a replayed roll from an earlier session shows as settled history', () => {
  const { wire, client } = connectedClient();
  wire.receive({ ...rollEvent('old', 5), replayed: true });
  assert.equal(client.state().rolling, false);
  assert.equal(viewModel(client.state(), WIDE_WIDTH).rolls[0]?.animated, false);
  wire.receive(rollEvent('new', 9));
  assert.equal(viewModel(client.state(), WIDE_WIDTH).rolls[0]?.animated, true);
});

test('UI15: skip settles the roll, history keeps recent rolls and motion preferences render immediately', () => {
  const { wire, client } = connectedClient();
  for (let index = 0; index < 7; index += 1) wire.receive(rollEvent(`r${index}`, index + 1));
  wire.receive(rollEvent('r6', 7));
  assert.deepEqual(
    client.state().rolls.map(({ resultId }) => resultId),
    ['r6', 'r5', 'r4', 'r3', 'r2'],
  );
  assert.equal(
    viewModel(client.state(), WIDE_WIDTH, { ...DEFAULT_PREFERENCES, motion: 'off' }).rolls[0]?.animated,
    false,
  );
  assert.equal(
    viewModel(client.state(), WIDE_WIDTH, { ...DEFAULT_PREFERENCES, reducedMotion: true }).rolls[0]?.animated,
    false,
  );
  assert.equal(viewModel(client.state(), WIDE_WIDTH).rolls[1]?.animated, false);
  client.settle();
  assert.equal(viewModel(client.state(), WIDE_WIDTH).rolls[0]?.animated, false);
  wire.receive({ type: 'MechanicVisualized', resultId: 'bad' });
  assert.equal(client.state().rolls.length, 5);
});

test('rpg-42a.102: the roll card collapses to a badge, reopens on demand and a new roll reopens it', () => {
  const { wire, client } = connectedClient();
  wire.receive(rollEvent('r1', 17));
  assert.equal(viewModel(client.state(), WIDE_WIDTH).rollsCollapsed, false);
  client.collapseRolls();
  assert.equal(viewModel(client.state(), WIDE_WIDTH).rollsCollapsed, true);
  client.reopenRolls();
  assert.equal(viewModel(client.state(), WIDE_WIDTH).rollsCollapsed, false);
  client.collapseRolls();
  wire.receive(rollEvent('r2', 9));
  assert.equal(viewModel(client.state(), WIDE_WIDTH).rollsCollapsed, false);
});

test('rpg-42a.102: the badge is fresh only after a collapse until it settles, a reopen or a new roll', () => {
  const { wire, client } = connectedClient();
  const fresh = () => viewModel(client.state(), WIDE_WIDTH).rollBadgeFresh;
  wire.receive(rollEvent('r1', 17));
  assert.equal(fresh(), false);
  client.collapseRolls();
  assert.equal(fresh(), true);
  client.settleBadge();
  assert.equal(fresh(), false);
  client.collapseRolls();
  client.reopenRolls();
  assert.equal(fresh(), false);
  client.collapseRolls();
  wire.receive(rollEvent('r2', 9));
  assert.equal(fresh(), false);
});

test('UI15: changed sheet values are highlighted until they settle', () => {
  const { wire, client } = connectedClient();
  const sheet = (hp: number) => ({
    campaignId: CAMPAIGN,
    viewId: 'sheet',
    components: [
      { kind: 'field', id: 'name', label: 'Name', value: 'Ash' },
      { kind: 'field', id: 'hp', label: 'HP', value: hp },
    ],
  });
  wire.receive({ type: 'View', campaignId: CAMPAIGN, view: sheet(10) });
  wire.receive({ type: 'View', campaignId: CAMPAIGN, view: sheet(7) });
  assert.deepEqual(client.state().sheetChanged, ['hp']);
  assert.deepEqual(
    viewModel(client.state(), WIDE_WIDTH).sheetGroups.flatMap(({ fields }) => fields.map(({ changed }) => changed)),
    [false, true],
  );
  client.settle();
  assert.deepEqual(client.state().sheetChanged, []);
});

const GROUPED_SHEET = {
  campaignId: CAMPAIGN,
  viewId: 'sheet',
  components: [
    { kind: 'field', id: 'might', label: 'Might', value: 3, group: 'core', editable: true },
    {
      kind: 'field',
      id: 'armor',
      label: 'Armor',
      value: 5,
      group: 'computed',
      editable: false,
      explanation: '= might + 2',
    },
  ],
};

test('rpg-42a.21: the sheet groups fields and keeps edit rights and explanations', () => {
  const { wire, client } = connectedClient();
  wire.receive({ type: 'View', campaignId: CAMPAIGN, view: GROUPED_SHEET });
  assert.deepEqual(viewModel(client.state(), WIDE_WIDTH).sheetGroups, [
    {
      id: 'core',
      fields: [{ id: 'might', name: 'Might', text: '3', value: 3, editable: true, changed: false }],
    },
    {
      id: 'computed',
      fields: [
        {
          id: 'armor',
          name: 'Armor',
          text: '5',
          value: 5,
          editable: false,
          explanation: '= might + 2',
          changed: false,
        },
      ],
    },
  ]);
});

test('rpg-42a.21: a sheet edit sends EditSheetField, shows a rejection and refreshes on acceptance', () => {
  const { wire, client } = connectedClient();
  wire.receive({ type: 'View', campaignId: CAMPAIGN, view: GROUPED_SHEET });
  const edit = client.editSheet('might', 99);
  assert.equal(edit.ok, true);
  assert.deepEqual(wire.sent.at(-1), {
    version: PROTOCOL_VERSION,
    type: 'EditSheetField',
    campaignId: CAMPAIGN,
    actionId: 'a0',
    expectedRevision: 1,
    actorId: 'hero',
    fieldId: 'might',
    value: 99,
  });
  wire.receive({ type: 'Rejected', actionId: 'a0', error: { code: 'Rejected', message: 'might must be at most 20' } });
  const might = () => viewModel(client.state(), WIDE_WIDTH).sheetGroups[0]?.fields[0];
  assert.equal(might()?.error, 'might must be at most 20');
  assert.deepEqual(client.state().rejected, []);
  client.editSheet('might', 8);
  const sent = wire.sent.length;
  wire.receive({ type: 'Accepted', actionId: 'a1' });
  assert.equal(might()?.error, undefined);
  assert.deepEqual(
    wire.sent.slice(sent).map(({ type }) => type),
    ['GetCampaignSnapshot', 'RequestView'],
  );
});

const EDIT_SHEET = {
  campaignId: CAMPAIGN,
  viewId: 'sheet',
  components: [
    ...GROUPED_SHEET.components,
    { kind: 'field', id: 'title', label: 'Title', value: 'Scout', group: 'custom', editable: true },
    { kind: 'field', id: 'hidden', label: 'Hidden', value: false, group: 'custom', editable: true },
  ],
};
const sheetEdits = (sent: readonly ClientCommand[]) =>
  sent.flatMap((command) =>
    command.type === 'EditSheetField' ? [{ fieldId: command.fieldId, value: command.value }] : [],
  );
const editingSheet = () => {
  const { wire, client } = connectedClient();
  wire.receive({ type: 'View', campaignId: CAMPAIGN, view: EDIT_SHEET });
  client.openSheetEdit();
  return { wire, client, editing: () => viewModel(client.state(), WIDE_WIDTH).sheetEditing };
};

test('rpg-42a.29: one sheet save sends only changed valid values and closes the editor', () => {
  const { wire, client, editing } = editingSheet();
  assert.equal(editing(), true);
  client.saveSheet({ might: 'lots', title: 'Warden' });
  assert.deepEqual(sheetEdits(wire.sent), []);
  assert.equal(editing(), true);
  assert.deepEqual(client.state().sheetErrors, { might: 'Enter a number.' });
  client.saveSheet({ might: ' ', title: 'Warden' });
  assert.deepEqual(sheetEdits(wire.sent), []);
  client.saveSheet({ might: '3', title: 'Warden', hidden: true, armor: '9' });
  assert.deepEqual(sheetEdits(wire.sent), [{ fieldId: 'title', value: 'Warden' }]);
  assert.equal(editing(), false);
  assert.deepEqual(client.state().sheetErrors, {});
  wire.receive({ type: 'Accepted', actionId: 'a0' });
  wire.receive({ type: 'Snapshot', snapshot: snapshotAt(2) });
  assert.deepEqual(sheetEdits(wire.sent), [
    { fieldId: 'title', value: 'Warden' },
    { fieldId: 'hidden', value: true },
  ]);
});

const STALE_REVISION = 'StaleRevision';
const revisionCheckingEngine = (wire: ReturnType<typeof fakeTransport>, start: number) => {
  let revision = start;
  let handled = wire.sent.length;
  const applied: unknown[] = [];
  const pump = () => {
    while (handled < wire.sent.length) {
      const command = wire.sent[handled++] as ClientCommand;
      if (command.type === 'GetCampaignSnapshot') wire.receive({ type: 'Snapshot', snapshot: snapshotAt(revision) });
      if (command.type !== 'EditSheetField') continue;
      if (command.expectedRevision !== revision) {
        wire.receive({
          type: 'Rejected',
          actionId: command.actionId,
          error: { code: STALE_REVISION, message: 'stale' },
        });
        continue;
      }
      revision += 1;
      applied.push(command.fieldId);
      wire.receive({ type: 'Accepted', actionId: command.actionId });
    }
  };
  return { pump, applied };
};

test('rpg-42a.29: one sheet save applies every changed field against an engine that rejects stale revisions', () => {
  const { wire, client } = editingSheet();
  const engine = revisionCheckingEngine(wire, client.state().snapshot?.revision ?? 0);
  client.saveSheet({ might: '4', title: 'Warden' });
  engine.pump();
  assert.deepEqual(engine.applied, ['might', 'title']);
  assert.deepEqual(client.state().sheetErrors, {});
  assert.equal(client.state().sheetEditing, false);
});

test('rpg-42a.29: leaving the adventure drops sheet edits not yet sent', () => {
  const { wire, client } = editingSheet();
  client.saveSheet({ might: '4', title: 'Warden' });
  wire.receive({ type: 'Accepted', actionId: 'a0' });
  client.select(OTHER);
  wire.receive({ type: 'Snapshot', snapshot: { ...snapshotAt(2), campaignId: OTHER } });
  assert.deepEqual(sheetEdits(wire.sent), [{ fieldId: 'might', value: 4 }]);
});

test('rpg-42a.29: sheet bounds from the View message reach the inputs and block out of range saves', () => {
  const { wire, client } = connectedClient();
  const bounded = {
    ...EDIT_SHEET,
    components: EDIT_SHEET.components.map((component) =>
      component.id === 'might' ? { ...component, min: 1, max: 20 } : component,
    ),
  };
  wire.receive({ type: 'View', campaignId: CAMPAIGN, view: bounded });
  client.openSheetEdit();
  const html = renderView(viewModel(client.state(), WIDE_WIDTH), 'en');
  assert.match(html, /<input id="sheet-field-might" name="might" type="number" step="any" required min="1" max="20"/);
  client.saveSheet({ might: '0' });
  assert.deepEqual(sheetEdits(wire.sent), []);
  assert.deepEqual(client.state().sheetErrors, { might: 'Enter 1 or more.' });
});

test('rpg-42a.29: cancel leaves the editor and drops its messages, a rejection reopens it', () => {
  const { wire, client, editing } = editingSheet();
  client.saveSheet({ might: '' });
  client.cancelSheetEdit();
  assert.equal(editing(), false);
  assert.deepEqual(client.state().sheetErrors, {});
  client.openSheetEdit();
  client.saveSheet({ might: '99' });
  assert.deepEqual(sheetEdits(wire.sent), [{ fieldId: 'might', value: 99 }]);
  assert.equal(editing(), false);
  wire.receive({ type: 'Rejected', actionId: 'a0', error: { code: 'Rejected', message: 'might must be at most 20' } });
  assert.equal(editing(), true);
  assert.deepEqual(client.state().sheetErrors, { might: 'might must be at most 20' });
  client.goHome();
  assert.equal(client.state().sheetEditing, false);
});

test('rpg-42a.29: sheet values are checked against the field type and its bounds', () => {
  const number = { value: 3, min: 1, max: 20 };
  assert.deepEqual(parseSheetValue(number, '7', 'en'), { ok: true, value: 7 });
  assert.deepEqual(parseSheetValue(number, '0', 'en'), { ok: false, error: 'Enter 1 or more.' });
  assert.deepEqual(parseSheetValue(number, '21', 'es'), { ok: false, error: 'Introduce 20 o menos.' });
  assert.deepEqual(parseSheetValue({ value: 3 }, 'Infinity', 'en'), { ok: false, error: 'Enter a number.' });
  assert.deepEqual(parseSheetValue({ value: 3 }, '-4.5', 'en'), { ok: true, value: -4.5 });
  assert.deepEqual(parseSheetValue({ value: false }, true, 'en'), { ok: true, value: true });
  assert.deepEqual(parseSheetValue({ value: 'Scout' }, 'Warden', 'en'), { ok: true, value: 'Warden' });
});

test('rpg-42a.21: a sheet edit needs a character and a known field', () => {
  const wire = fakeTransport();
  const client = createDesktopClient({ transport: wire.transport, newActionId: ids() });
  assert.equal(client.editSheet('might', 8).ok, false);
  const { client: ready } = connectedClient();
  assert.equal(ready.editSheet('', 8).ok, false);
});

test('rpg-42a.38 an accepted action refreshes the snapshot even when the turn committed no events', () => {
  const { wire, client } = connectedClient();
  client.submit('look around');
  const before = wire.sent.length;
  wire.receive({ type: 'Accepted', actionId: 'a0' });
  assert.deepEqual(
    wire.sent.slice(before).map(({ type }) => type),
    ['GetCampaignSnapshot', 'RequestView'],
  );
});

test('rpg-42a.38 a sheetless campaign still requests the view that carries the character card', () => {
  const { wire, client } = connectedClient();
  wire.receive({
    type: 'Snapshot',
    snapshot: { ...snapshotAt(2), rules: { resolution: 'adjudicated', sheet: 'none' } },
  });
  const before = wire.sent.length;
  client.submit('look around');
  wire.receive({ type: 'Accepted', actionId: 'a0' });
  assert.deepEqual(
    wire.sent.slice(before).map(({ type }) => type),
    ['SubmitPlayerAction', 'GetCampaignSnapshot', 'RequestView'],
  );
});

const lastNarration = (client: ReturnType<typeof connectedClient>['client']) =>
  viewModel(client.state(), WIDE_WIDTH).conversation.at(-1)?.narration;

const recordedWithoutReply = (turnId: string, revision = 2) => {
  const recorded = snapshotAt(revision, ['old', 'a0']);
  const turns = recorded.turns.map((turn, index) => (index === 1 ? { ...turn, id: turnId, narration: '' } : turn));
  return { ...recorded, turns };
};

test('rpg-cm63.22 streamed narration fills the pending turn and the turn recorded without a reply while in flight', () => {
  const { wire, client } = connectedClient();
  client.submit('look around');
  wire.receive({ type: 'Narration', turnId: 't9', text: 'The door creaks open.' });
  wire.receive({ type: 'Narration', turnId: 't9', text: 'Dust falls.' });
  assert.equal(lastNarration(client), 'The door creaks open. Dust falls.');
  assert.equal(viewModel(client.state(), WIDE_WIDTH).conversation.at(-1)?.pending, true);
  wire.receive({ type: 'Snapshot', snapshot: recordedWithoutReply('t9') });
  assert.equal(lastNarration(client), 'The door creaks open. Dust falls.');
  wire.receive({ type: 'Accepted', actionId: 'a0', revision: 2 });
  wire.receive({ type: 'Snapshot', snapshot: snapshotAt(3, ['old', 'a0']) });
  assert.equal(lastNarration(client), 'narration a0');
});

test('rpg-cm63.22 a failed narration leaves no partial streamed text once the action settles', () => {
  for (const settled of [
    { type: 'Accepted', actionId: 'a0' },
    { type: 'Rejected', actionId: 'a0', error: 'no' },
  ]) {
    const { wire, client } = connectedClient();
    client.submit('look around');
    wire.receive({ type: 'Narration', turnId: 't9', text: 'Half a sentence' });
    wire.receive({ type: 'Snapshot', snapshot: recordedWithoutReply('t9') });
    wire.receive(settled);
    assert.equal(client.state().streaming, undefined);
    wire.receive({ type: 'Snapshot', snapshot: recordedWithoutReply('t9', 3) });
    assert.equal(lastNarration(client), '');
  }
});

test('rpg-cm63.22 a late narration for an earlier turn is ignored', () => {
  const { wire, client } = connectedClient();
  client.submit('one');
  wire.receive({ type: 'Snapshot', snapshot: recordedWithoutReply('t9') });
  wire.receive({ type: 'Accepted', actionId: 'a0', revision: 2 });
  wire.receive({ type: 'Narration', turnId: 't9', text: 'Too late.' });
  assert.equal(client.state().streaming, undefined);
  client.submit('two');
  wire.receive({ type: 'Narration', turnId: 't9', text: 'Still too late.' });
  assert.equal(client.state().streaming, undefined);
  assert.equal(lastNarration(client), '');
  wire.receive({ type: 'Narration', turnId: 't10', text: 'Fresh.' });
  assert.equal(lastNarration(client), 'Fresh.');
});

test('rpg-cm63.22 a new turn id restarts the streamed text and a new action clears it', () => {
  const { wire, client } = connectedClient();
  client.submit('one');
  wire.receive({ type: 'Narration', turnId: 't1', text: 'First turn.' });
  wire.receive({ type: 'Narration', turnId: 't2', text: 'Second turn.' });
  assert.equal(lastNarration(client), 'Second turn.');
  client.submit('two');
  assert.equal(lastNarration(client), '');
});

test('rpg-cm63.22 narration lines with a bad shape are ignored and a closed session drops the stream', () => {
  const { wire, client } = connectedClient();
  client.submit('look');
  for (const line of [
    { type: 'Narration', turnId: 1, text: 'x' },
    { type: 'Narration', turnId: 't1' },
    { type: 'Narration', turnId: 't1', text: { nested: true } },
  ])
    wire.receive(line);
  assert.equal(lastNarration(client), '');
  wire.receive({ type: 'Narration', turnId: 't1', text: 'Heard.' });
  client.goHome();
  assert.equal(client.state().streaming, undefined);
});

test('rpg-cm63.22 the page shows streamed narration in place of the pending label and escapes it', () => {
  const { wire, client } = connectedClient();
  client.submit('look');
  assert.match(renderView(viewModel(client.state(), WIDE_WIDTH), 'en'), /Waiting|pending/i);
  wire.receive({ type: 'Narration', turnId: 't1', text: '<b>Wind</b> rises.' });
  const html = renderView(viewModel(client.state(), WIDE_WIDTH), 'en');
  assert.match(
    html,
    /<p data-speaker="gm"><span data-speaker-label>[^<]*<\/span>&lt;b&gt;Wind&lt;\/b&gt; rises\.<\/p>/,
  );
  assert.doesNotMatch(html, /<b>Wind/);
});

test('rpg-42a.67: the story language is sent at the snapshot revision as SetCampaignLanguage', () => {
  const { wire, client } = connectedClient();
  assert.equal(client.setStoryLanguage('pt-BR').ok, true);
  assert.deepEqual(wire.sent.at(-1), {
    version: PROTOCOL_VERSION,
    type: 'SetCampaignLanguage',
    campaignId: CAMPAIGN,
    actionId: 'a0',
    expectedRevision: 1,
    language: 'pt-BR',
  });
  assert.equal(client.setStoryLanguage('not a locale!').ok, false);
});

const ROLL_OFFER = {
  offerId: 'tam-attack',
  ruleId: 'attack.melee',
  target: 'Old Tam',
  label: 'Attack Old Tam with your sword',
};

test('rpg-42a.74: an open roll offer is a button naming the check, and accepting it sends the offer id', () => {
  const { wire, client } = connectedClient();
  assert.equal(viewModel(client.state(), WIDE_WIDTH).rollOffer, undefined);
  assert.doesNotMatch(renderView(viewModel(client.state(), WIDE_WIDTH), 'en'), /data-roll-offer/);
  wire.receive({ type: 'Snapshot', snapshot: { ...snapshotAt(2, ['old']), rollOffer: ROLL_OFFER } });
  assert.deepEqual(viewModel(client.state(), WIDE_WIDTH).rollOffer, ROLL_OFFER);
  assert.match(
    renderView(viewModel(client.state(), WIDE_WIDTH), 'en'),
    /<button type="button" data-roll-offer="tam-attack"[^>]*>Roll: Attack Old Tam with your sword<\/button>/,
  );
  assert.equal(client.acceptRoll().ok, true);
  assert.deepEqual(wire.sent.at(-1), {
    version: PROTOCOL_VERSION,
    type: 'SubmitPlayerAction',
    campaignId: CAMPAIGN,
    actionId: 'a0',
    expectedRevision: 2,
    sceneId: 's1',
    actorId: 'hero',
    input: ROLL_OFFER.label,
    rollOfferId: ROLL_OFFER.offerId,
  });
  assert.equal(viewModel(client.state(), WIDE_WIDTH).rollOffer, undefined);
});

test('rpg-42a.74: accepting a roll with no open offer is rejected', () => {
  const { client } = connectedClient();
  assert.equal(client.acceptRoll().ok, false);
});

test('rpg-42a.77: /roll in the input accepts the open offer, or sends a plain roll, never the literal text', () => {
  const { wire, client } = connectedClient();
  wire.receive({ type: 'Snapshot', snapshot: snapshotAt(2, ['old']) });
  assert.equal(client.submit('/roll').ok, true);
  assert.equal((wire.sent.at(-1) as { input: string }).input, 'roll');
  assert.equal((wire.sent.at(-1) as { rollOfferId?: string }).rollOfferId, undefined);
  wire.receive({ type: 'Snapshot', snapshot: { ...snapshotAt(3, ['old']), rollOffer: ROLL_OFFER } });
  assert.equal(client.submit(' /ROLL ').ok, true);
  assert.equal((wire.sent.at(-1) as { rollOfferId?: string }).rollOfferId, ROLL_OFFER.offerId);
});

test('rpg-42a.77: the reason an action did not roll is shown once under its turn, localized', () => {
  const { wire, client } = connectedClient();
  wire.receive({
    type: 'Snapshot',
    snapshot: { ...snapshotAt(2, ['old']), noRoll: { actionId: 'old', reason: 'no-rulebook' } },
  });
  const html = renderView(viewModel(client.state(), WIDE_WIDTH), 'en');
  assert.equal(html.match(/No roll: this campaign has no rulebook/g)?.length, 1);
  assert.match(renderView(viewModel(client.state(), WIDE_WIDTH), 'pt-BR'), /Sem rolagem: esta campanha/);
});

test('rpg-42a.89: a roll tray entry names the NPC that rolled and escapes the label', () => {
  const { wire, client } = connectedClient();
  const npcRoll = (resultId: string, roller: string) => ({
    ...rollEvent(resultId, 12),
    final: { total: 15, modifier: 3, roller },
  });
  wire.receive(npcRoll('tam-swing', 'Old Tam'));
  const html = renderView(viewModel(client.state(), WIDE_WIDTH), 'en');
  assert.match(html, /<figcaption>[^<]*d20 12[^<]*rolled by Old Tam<\/figcaption>/);
  assert.match(renderView(viewModel(client.state(), WIDE_WIDTH), 'pt-BR'), /rolada por Old Tam/);
  wire.receive(npcRoll('hostile', '<b>Tam</b>'));
  const hostile = renderView(viewModel(client.state(), WIDE_WIDTH), 'en');
  assert.doesNotMatch(hostile, /<b>Tam<\/b>/);
  assert.match(hostile, /rolled by &lt;b&gt;Tam&lt;\/b&gt;/);
  assert.match(hostile, /<details data-roll-history>[\s\S]*rolled by Old Tam/);
});

test('rpg-42a.93: the client rejects an unknown slash command instead of sending it as story text', () => {
  const { wire, client } = connectedClient();
  const sentBefore = wire.sent.length;
  const result = client.submit('/x marks the spot');
  assert.equal(result.ok, false);
  assert.equal(wire.sent.length, sentBefore);
  assert.equal(client.submit('/sheet').ok, false);
  assert.equal(client.submit('/gm hello there').ok, true);
});

const PHYSICAL_OFFER = { ...ROLL_OFFER, expression: '1d20' };

test('rpg-42a.96: reporting a physical roll sends the total as reportedRoll with the offer id', () => {
  const { wire, client } = connectedClient();
  wire.receive({ type: 'Snapshot', snapshot: { ...snapshotAt(2, ['old']), rollOffer: PHYSICAL_OFFER } });
  assert.match(
    renderView(viewModel(client.state(), WIDE_WIDTH), 'en'),
    /<form data-roll-report-form aria-label="Report your roll"><label for="roll-report-input">Your result for 1d20<\/label><input id="roll-report-input" name="total" type="number" step="1" min="1" max="20" required>/,
  );
  assert.equal(client.reportRoll(14).ok, true);
  assert.deepEqual(wire.sent.at(-1), {
    version: PROTOCOL_VERSION,
    type: 'SubmitPlayerAction',
    campaignId: CAMPAIGN,
    actionId: 'a0',
    expectedRevision: 2,
    sceneId: 's1',
    actorId: 'hero',
    input: ROLL_OFFER.label,
    rollOfferId: ROLL_OFFER.offerId,
    reportedRoll: [14],
  });
});

test('rpg-42a.96: the report field spans the whole expression and is absent for an app-rolled offer', () => {
  const { wire, client } = connectedClient();
  wire.receive({
    type: 'Snapshot',
    snapshot: { ...snapshotAt(2, ['old']), rollOffer: { ...ROLL_OFFER, expression: '2d6+1d8' } },
  });
  assert.match(renderView(viewModel(client.state(), WIDE_WIDTH), 'en'), /min="3" max="20"/);
  wire.receive({ type: 'Snapshot', snapshot: { ...snapshotAt(3, ['old']), rollOffer: ROLL_OFFER } });
  assert.doesNotMatch(renderView(viewModel(client.state(), WIDE_WIDTH), 'en'), /data-roll-report-form/);
  assert.equal(client.reportRoll(14).ok, false);
});

test('rpg-42a.96: a rejected report shows the server message in the alert', () => {
  const { wire, client } = connectedClient();
  wire.receive({ type: 'Snapshot', snapshot: { ...snapshotAt(2, ['old']), rollOffer: PHYSICAL_OFFER } });
  client.reportRoll(99);
  wire.receive({
    type: 'Rejected',
    actionId: 'a0',
    error: { code: 'Rejected', message: '1d20 can only give 1 to 20. Roll again or check the dice.' },
  });
  assert.match(
    renderView(viewModel(client.state(), WIDE_WIDTH), 'en'),
    /<ul role="alert"><li>Attack Old Tam with your sword: 1d20 can only give 1 to 20/,
  );
});

const pendingTurnSnapshot = (revision: number, actionId: string): CampaignSnapshot => {
  const snapshot = snapshotAt(revision, [actionId]);
  return { ...snapshot, turns: snapshot.turns.map((turn) => ({ ...turn, narration: '' })) };
};
const LIMIT = { kind: 'limit', detail: '3:30pm (Europe/Lisbon)' };

test('rpg-42a.101 a failed narration shows the reason and a retry, and retry resends the same action', () => {
  const { wire, client } = connectedClient();
  assert.ok(client.submit('wait').ok);
  wire.receive({ type: 'NarrationFailed', actionId: 'a0', failure: LIMIT });
  wire.receive({ type: 'Accepted', actionId: 'a0' });
  wire.receive({ type: 'Snapshot', snapshot: pendingTurnSnapshot(3, 'a0') });
  const model = viewModel(client.state(), WIDE_WIDTH);
  assert.deepEqual(model.conversation.at(-1)?.failure, LIMIT);
  assert.equal(client.state().outbox.length, 0);
  const html = renderView(model, 'en');
  assert.match(html, /usage limit is reached\. It resets 3:30pm \(Europe\/Lisbon\)/);
  assert.match(html, /data-retry-turn/);
  assert.doesNotMatch(html, /No reply/);
  assert.match(renderView(model, 'pt-BR'), /limite de uso/);
  assert.match(renderView(model, 'es'), /límite de uso/);

  const sentBefore = wire.sent.length;
  client.retryNarration();
  const [resent] = wire.sent.slice(sentBefore);
  assert.ok(resent?.type === 'SubmitPlayerAction' && resent.actionId === 'a0' && resent.input === 'wait');
  assert.equal(client.state().stalled, undefined);
  assert.equal(client.state().outbox.length, 1);
  assert.equal(viewModel(client.state(), WIDE_WIDTH).conversation.at(-1)?.failure, undefined);
});

test('rpg-42a.101 a retry that works clears the notice and shows the narration', () => {
  const { wire, client } = connectedClient();
  client.submit('wait');
  wire.receive({ type: 'NarrationFailed', actionId: 'a0', failure: LIMIT });
  wire.receive({ type: 'Accepted', actionId: 'a0' });
  wire.receive({ type: 'Snapshot', snapshot: pendingTurnSnapshot(3, 'a0') });
  client.retryNarration();
  wire.receive({ type: 'Accepted', actionId: 'a0' });
  wire.receive({ type: 'Snapshot', snapshot: snapshotAt(4, ['a0']) });
  const html = renderView(viewModel(client.state(), WIDE_WIDTH), 'en');
  assert.match(html, /narration a0/);
  assert.doesNotMatch(html, /data-retry-turn|usage limit/);
});

test('rpg-42a.101 a new action drops the retry of the older failed one', () => {
  const { wire, client } = connectedClient();
  client.submit('wait');
  wire.receive({ type: 'NarrationFailed', actionId: 'a0', failure: LIMIT });
  wire.receive({ type: 'Accepted', actionId: 'a0' });
  wire.receive({ type: 'Snapshot', snapshot: pendingTurnSnapshot(3, 'a0') });
  client.submit('look');
  assert.equal(client.state().stalled, undefined);
  assert.doesNotMatch(renderView(viewModel(client.state(), WIDE_WIDTH), 'en'), /data-retry-turn/);
  const before = wire.sent.length;
  client.retryNarration();
  assert.equal(wire.sent.length, before);
});

test('rpg-42a.113 a fresh client shows a lost reply and retries the committed turn', () => {
  const wire = fakeTransport();
  const client = createDesktopClient({ transport: wire.transport, newActionId: ids() });
  wire.receive(READY);
  client.select(CAMPAIGN);
  wire.receive({ type: 'Snapshot', snapshot: pendingTurnSnapshot(3, 'a0') });
  const model = viewModel(client.state(), WIDE_WIDTH);
  assert.deepEqual(model.conversation.at(-1)?.failure, { kind: 'lost' });
  const html = renderView(model, 'en');
  assert.match(html, /reply was not saved/);
  assert.match(html, /data-retry-turn/);

  const sentBefore = wire.sent.length;
  client.retryNarration();
  const [resent] = wire.sent.slice(sentBefore);
  assert.ok(resent?.type === 'SubmitPlayerAction' && resent.actionId === 'a0' && resent.input === 'input a0');
  assert.ok(resent.expectedRevision === 3 && resent.sceneId === 's1' && resent.actorId === 'hero');
  assert.equal(client.state().outbox.length, 1);
  assert.doesNotMatch(renderView(viewModel(client.state(), WIDE_WIDTH), 'en'), /data-retry-turn/);
});

test('rpg-42a.113 only the latest empty turn can be retried', () => {
  const { wire, client } = connectedClient();
  const snapshot = snapshotAt(3, ['a0', 'a1']);
  const [first, second] = snapshot.turns;
  assert.ok(first !== undefined && second !== undefined);
  wire.receive({ type: 'Snapshot', snapshot: { ...snapshot, turns: [{ ...first, narration: '' }, second] } });
  const model = viewModel(client.state(), WIDE_WIDTH);
  assert.ok(model.conversation.every(({ failure }) => failure === undefined));
  assert.doesNotMatch(renderView(model, 'en'), /data-retry-turn/);
  const before = wire.sent.length;
  client.retryNarration();
  assert.equal(wire.sent.length, before);
});

test('rpg-42a.113 a turn still queued in the outbox shows no retry', () => {
  const { wire, client } = connectedClient();
  assert.ok(client.submit('wait').ok);
  wire.receive({ type: 'Snapshot', snapshot: pendingTurnSnapshot(3, 'a0') });
  assert.equal(client.state().outbox.length, 1);
  assert.doesNotMatch(renderView(viewModel(client.state(), WIDE_WIDTH), 'en'), /data-retry-turn/);
});
