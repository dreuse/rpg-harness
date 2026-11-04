import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type CampaignPanels, watchPanels } from '../../../packages/client-protocol/src/panels.ts';
import {
  type ClientEvent,
  type ClientSession,
  EVENT_COMMITTED,
  type ListCampaigns,
  MAX_INPUT_LENGTH,
  PROTOCOL_VERSION,
} from '../../../packages/client-protocol/src/protocol.ts';
import { parseSheetSchema, type SheetEdit } from '../../../packages/client-protocol/src/sheet-widgets.ts';
import { VISUALIZATION_EVENT } from '../../../packages/client-protocol/src/visualization.ts';
import { CAMPAIGN_CONFIGURED, MAIN_BRANCH, StaleRevisionError } from '../../../packages/domain/src/campaign.ts';
import type { Visibility } from '../../../packages/domain/src/entity.ts';
import { CHARACTER_CREATED } from '../../../packages/engine/src/character.ts';
import { createEngine } from '../../../packages/engine/src/engine.ts';
import { openScene } from '../../../packages/engine/src/turn.ts';
import { type CampaignConfig, generateCampaignConfig } from '../../../packages/intent/src/config.ts';
import { createCampaignIntent } from '../../../packages/intent/src/intent.ts';
import { GM_VIEWER, PLAYER_VIEWER, type Viewer } from '../../../packages/memory/src/knowledge.ts';
import { createCampaignStore } from '../../../packages/persistence/src/campaign-store.ts';
import { createCharacterStore } from '../../../packages/persistence/src/character-store.ts';
import { openDatabase } from '../../../packages/persistence/src/database.ts';
import { createEntityStore } from '../../../packages/persistence/src/entity-store.ts';
import { createRoller, createSeededRng } from '../../../packages/rules/src/dice.ts';
import { createClientSessions, type SheetPort, scopedEventsOf, worldOf } from './client-session.ts';
import { BUILT_IN_PACKS } from './import-gateway.ts';

const IN_MEMORY = ':memory:';
const RULEPACK = { id: 'house', edition: '1', revision: 'r1' };
const GM_SECRET = 'The stranger is Duke Varn in disguise.';
const RIVAL = 'rival';
const RIVAL_VIEWER: Viewer = { scope: 'actor', actorId: RIVAL };
const OPENING_REVISION = 1;
const INSERT_EVENT =
  'INSERT INTO event_log (id, campaign_id, branch_id, revision, turn_id, type, payload, visibility, actor_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)';

const ROLL_SEED = 11;
const D20 = { dice: [{ count: 1, sides: 20 }], modifier: 2 };
const explicit = <T>(value: T) => ({ value, provenance: 'explicit' as const });
const DICE_REGISTRY = {
  rulepacks: [{ ...RULEPACK, capabilities: { dice: true }, sourceRefs: [] }],
  genres: [],
};

const visualizingConfig = () => {
  const intent = createCampaignIntent({
    ruleset: explicit({ id: RULEPACK.id, edition: RULEPACK.edition }),
    diceVisualization: explicit(true),
    client: explicit('tui'),
  });
  const generated = generateCampaignConfig(intent, DICE_REGISTRY);
  assert.ok(generated.ok);
  return generated.config;
};

const resolvedRoll = (rollId: string) => {
  const rolled = createRoller(createSeededRng(ROLL_SEED))(rollId, D20);
  assert.ok(rolled.ok);
  return {
    ruleId: 'swim',
    resolution: { ok: true, changes: [], events: [{ event: 'swim.made' }], rolls: [rolled.roll] },
  };
};

const SHEET_SCHEMA = parseSheetSchema({
  fields: [
    { id: 'name', label: 'Name', type: 'text', editable: true },
    { id: 'stress', label: 'Stress', type: 'number', editable: true },
    { id: 'wounded', label: 'Wounded', type: 'flag', editable: false },
    { id: 'title', label: 'Title', type: 'computed', template: '{name}' },
    { id: 'scar', label: 'Scar', type: 'text', editable: true, when: { field: 'wounded', equals: true } },
  ],
});

const fakeSheets = (owner: string) => {
  const commits: SheetEdit[] = [];
  const values: Record<string, unknown> = { name: 'Ash', stress: 2, wounded: false };
  assert.ok(SHEET_SCHEMA.ok);
  const sheets: SheetPort = {
    read: (_, actorId) => (actorId === owner ? { schema: SHEET_SCHEMA.value, values } : undefined),
    commit: (edit) => {
      if (edit.expectedRevision !== OPENING_REVISION)
        throw new StaleRevisionError(edit.expectedRevision, OPENING_REVISION);
      commits.push(edit);
    },
  };
  return { sheets, commits };
};

const setup = (config?: CampaignConfig) => {
  const { database } = openDatabase(IN_MEMORY);
  const store = createCampaignStore(database);
  const engine = createEngine(store);
  const campaign = engine.createCampaign('Ashfall');
  const { turn } = openScene(store, {
    campaignId: campaign.id,
    actorName: 'The Wanderer',
    sceneTitle: 'The Crossroads Inn',
    narration: 'Rain drums on the roof.',
    ...(config === undefined ? {} : { config }),
  });
  createEntityStore(database).saveEntity({
    id: RIVAL,
    campaignId: campaign.id,
    kind: 'npc',
    name: 'Rival',
    data: {},
    visibility: 'gm',
    actorId: null,
  });
  const seed = (id: string, type: string, payload: object, visibility: Visibility, actorId: string | null = null) =>
    database
      .prepare(INSERT_EVENT)
      .run(id, campaign.id, MAIN_BRANCH, OPENING_REVISION, turn.id, type, JSON.stringify(payload), visibility, actorId);
  seed('gm-note', 'GmNoteRecorded', { gmOnly: GM_SECRET }, 'gm');
  seed('clue', 'CluePosted', { clue: 'muddy boots' }, 'player');
  seed('rival-plan', 'PlanFormed', { plan: 'follow the wanderer' }, 'actor-scoped', RIVAL);
  const entities = createEntityStore(database);
  const carry = (id: string, name: string, visibility: Visibility) => {
    entities.saveEntity({ id, campaignId: campaign.id, kind: 'item', name, data: {}, visibility, actorId: null });
    entities.saveRelationship({
      id: `carries-${id}`,
      campaignId: campaign.id,
      kind: 'carries',
      sourceId: turn.actorId,
      targetId: id,
      data: {},
    });
  };
  const quest = (questId: string, title: string) => ({ questId, title, objectives: [], prerequisites: [] });
  const citation = (ruleId: string, section: string) => ({ citation: { ruleId, section, rulepack: RULEPACK } });
  const furnish = () => {
    entities.saveEntity({
      id: turn.actorId,
      campaignId: campaign.id,
      kind: 'character',
      name: 'The Wanderer',
      data: {},
      visibility: 'player',
      actorId: null,
    });
    carry('lantern', 'Brass lantern', 'player');
    carry('seal', GM_SECRET, 'gm');
    seed('ferry-quest', 'QuestDefined', quest('ferry', 'Find the ferryman'), 'player');
    seed('duke-quest', 'QuestDefined', quest('duke', GM_SECRET), 'gm');
    seed('swim-check', 'RuleResolved', citation('swim', 'Chapter 2'), 'player');
    seed('duke-check', 'RuleResolved', citation('disguise', GM_SECRET), 'gm');
  };
  const sessionFor = createClientSessions(engine, campaign.id, scopedEventsOf(database), worldOf(database));
  const envelope = { version: PROTOCOL_VERSION, campaignId: campaign.id } as const;
  return { engine, database, campaignId: campaign.id, turn, sessionFor, envelope, furnish, seed, quest };
};

type Envelope = ReturnType<typeof setup>['envelope'];

const collect = (session: ClientSession, envelope: Envelope) => {
  const received: ClientEvent[] = [];
  session.subscribeEvents({ ...envelope, type: 'SubscribeEvents' }, (event) => received.push(event));
  return received;
};

const ids = (events: readonly ClientEvent[]) =>
  events.flatMap((event) => (event.type === EVENT_COMMITTED ? [event.event.id] : []));

test('UI01: player snapshot never carries the seeded GM note', () => {
  const { engine, campaignId, sessionFor, envelope } = setup();
  assert.ok(JSON.stringify(engine.getState(campaignId)).includes(GM_SECRET));
  const snapshot = sessionFor(PLAYER_VIEWER).getSnapshot({ ...envelope, type: 'GetCampaignSnapshot' });
  assert.ok(snapshot.ok);
  assert.equal(snapshot.value.revision, OPENING_REVISION);
  assert.equal(snapshot.value.currentScene?.title, 'The Crossroads Inn');
  assert.ok(Object.isFrozen(snapshot.value.campaign));
  assert.doesNotMatch(JSON.stringify(snapshot.value), /Duke Varn/);
});

test('UI01: events are filtered by viewer role and ownership before they reach the client', () => {
  const { sessionFor, envelope } = setup();
  const player = collect(sessionFor(PLAYER_VIEWER), envelope);
  const rival = collect(sessionFor(RIVAL_VIEWER), envelope);
  const gm = collect(sessionFor(GM_VIEWER), envelope);
  assert.deepEqual(ids(player), ['clue']);
  assert.deepEqual(ids(rival), ['rival-plan']);
  assert.ok(['gm-note', 'clue', 'rival-plan'].every((id) => ids(gm).includes(id)));
  assert.doesNotMatch(JSON.stringify(player), /Duke Varn/);
});

test('UI01: a committed action reaches every subscriber only through its viewer filter', () => {
  const { sessionFor, envelope, turn } = setup();
  const playerSession = sessionFor(PLAYER_VIEWER);
  const player = collect(playerSession, envelope);
  const gm = collect(sessionFor(GM_VIEWER), envelope);
  const before = gm.length;
  const accepted = playerSession.submitPlayerAction({
    ...envelope,
    type: 'SubmitPlayerAction',
    actionId: 'action-1',
    expectedRevision: OPENING_REVISION,
    sceneId: turn.sceneId,
    actorId: turn.actorId,
    input: 'I ask the stranger for news.',
  });
  assert.deepEqual(accepted, { ok: true, value: { revision: OPENING_REVISION + 1 } });
  assert.ok(gm.length > before);
  assert.ok(
    gm.slice(before).every((event) => event.type === EVENT_COMMITTED && event.revision === OPENING_REVISION + 1),
  );
  assert.deepEqual(ids(player), ['clue']);
});

test('UI01: session validates every command at the boundary', () => {
  const { sessionFor, envelope, turn } = setup();
  const session = sessionFor(PLAYER_VIEWER);
  const action = {
    ...envelope,
    type: 'SubmitPlayerAction',
    actionId: 'action-1',
    expectedRevision: OPENING_REVISION,
    sceneId: turn.sceneId,
    actorId: turn.actorId,
  } as const;
  const code = (result: { ok: boolean; error?: { code: string } }) => result.error?.code;
  assert.equal(
    code(session.submitPlayerAction({ ...action, input: 'a'.repeat(MAX_INPUT_LENGTH + 1) })),
    'MalformedCommand',
  );
  assert.equal(
    code(session.getSnapshot({ ...envelope, campaignId: 'someone-else', type: 'GetCampaignSnapshot' })),
    'Rejected',
  );
  assert.equal(code(session.submitPlayerAction({ ...action, input: 'go', expectedRevision: 0 })), 'StaleRevision');
  assert.equal(
    code(session.selectCapability({ ...envelope, type: 'SelectCapability', capabilityId: 'combat', enabled: true })),
    'Rejected',
  );
  assert.equal(code(session.requestView({ ...envelope, type: 'RequestView', viewId: 'map' })), 'Rejected');
  const ignored: ClientEvent[] = [];
  session.subscribeEvents({ ...envelope, campaignId: 'someone-else', type: 'SubscribeEvents' }, (event) =>
    ignored.push(event),
  );
  assert.deepEqual(ignored, []);
});

test('rpg-p5p5: ListCampaigns lists the campaign the session serves and validates the command', () => {
  const { sessionFor, campaignId } = setup();
  const session = sessionFor(PLAYER_VIEWER);
  const listed = session.listCampaigns({ version: PROTOCOL_VERSION, type: 'ListCampaigns' });
  assert.ok(listed.ok);
  assert.equal(listed.value.version, PROTOCOL_VERSION);
  assert.deepEqual(
    listed.value.campaigns.map(({ id }) => id),
    [campaignId],
  );
  assert.ok(Object.isFrozen(listed.value.campaigns));
  const unscoped = { version: PROTOCOL_VERSION, type: 'ListCampaigns', campaignId } as unknown as ListCampaigns;
  assert.equal(session.listCampaigns(unscoped).ok, false);
  const wrongType = { version: PROTOCOL_VERSION, type: 'GetCampaignSnapshot', campaignId } as unknown as ListCampaigns;
  assert.deepEqual(session.listCampaigns(wrongType), {
    ok: false,
    error: { code: 'UnknownCommand', message: 'expected ListCampaigns' },
  });
});

test('UI04 display inventory, quest journal, rule citations and world recap with live updates', () => {
  const { campaignId, turn, sessionFor, envelope, furnish, seed, quest } = setup();
  furnish();
  const received: CampaignPanels[] = [];
  const unsubscribe = watchPanels(sessionFor(PLAYER_VIEWER), campaignId, (panels) => received.push(panels));
  const [first] = received;
  assert.ok(first !== undefined);
  assert.equal(first.revision, OPENING_REVISION);
  assert.deepEqual(first.inventory, [{ id: 'lantern', name: 'Brass lantern' }]);
  assert.deepEqual(first.quests, [{ id: 'ferry', title: 'Find the ferryman', status: 'pending', objectives: [] }]);
  assert.deepEqual(first.citations, [
    { eventId: 'swim-check', ruleId: 'swim', section: 'Chapter 2', rulepack: RULEPACK },
  ]);
  assert.deepEqual(first.recap, { scene: 'The Crossroads Inn', latest: 'Rain drums on the roof.' });
  assert.ok(Object.isFrozen(first.inventory));

  seed('letter-quest', 'QuestDefined', quest('letter', 'Trace the letter'), 'player');
  const snapshot = { ...envelope, type: 'GetCampaignSnapshot' } as const;
  assert.ok(sessionFor(PLAYER_VIEWER).getSnapshot(snapshot).ok);
  assert.deepEqual(
    received.at(-1)?.quests.map(({ id }) => id),
    ['ferry', 'letter'],
  );

  const seen = received.length;
  unsubscribe();
  seed('late-quest', 'QuestDefined', quest('late', 'Too late'), 'player');
  assert.ok(sessionFor(PLAYER_VIEWER).getSnapshot(snapshot).ok);
  assert.equal(received.length, seen);

  const gmPanels: CampaignPanels[] = [];
  watchPanels(sessionFor(GM_VIEWER), campaignId, (panels) => gmPanels.push(panels));
  const accepted = sessionFor(GM_VIEWER).submitPlayerAction({
    ...envelope,
    type: 'SubmitPlayerAction',
    actionId: 'action-1',
    expectedRevision: OPENING_REVISION,
    sceneId: turn.sceneId,
    actorId: turn.actorId,
    input: 'I ask the stranger for news.',
  });
  assert.ok(accepted.ok);
  assert.equal(gmPanels.at(-1)?.revision, OPENING_REVISION + 1);
  assert.match(gmPanels.at(-1)?.recap.latest ?? '', /I ask the stranger for news\./);
});

test('UI04 secret facts are filtered server-side, not hidden only with css', () => {
  const { campaignId, sessionFor, envelope, furnish } = setup();
  furnish();
  const command = { ...envelope, type: 'GetCampaignPanels' } as const;
  const player = sessionFor(PLAYER_VIEWER).getPanels(command);
  const gm = sessionFor(GM_VIEWER).getPanels(command);
  assert.ok(player.ok && gm.ok);
  assert.doesNotMatch(JSON.stringify(player.value), /Duke Varn/);
  assert.ok(gm.value.inventory.some(({ name }) => name === GM_SECRET));
  assert.ok(gm.value.quests.some(({ title }) => title === GM_SECRET));
  assert.ok(gm.value.citations.some(({ section }) => section === GM_SECRET));
  const delivered: CampaignPanels[] = [];
  watchPanels(sessionFor(PLAYER_VIEWER), campaignId, (panels) => delivered.push(panels))();
  assert.ok(delivered.length > 0);
  assert.doesNotMatch(JSON.stringify(delivered), /Duke Varn/);
  const rejected = sessionFor(PLAYER_VIEWER).getPanels({ ...command, campaignId: 'someone-else' });
  assert.equal(rejected.ok ? undefined : rejected.error.code, 'Rejected');
});

test('visualizations reach each session only when its viewer may see the result', () => {
  const { sessionFor, envelope } = setup();
  const sessions = { gm: GM_VIEWER, player: PLAYER_VIEWER, actor: RIVAL_VIEWER };
  const received = Object.fromEntries(
    Object.entries(sessions).map(([name, viewer]) => [name, collect(sessionFor(viewer), envelope)]),
  );
  const visibilities: readonly Visibility[] = ['gm', 'player', 'public', 'actor-scoped'];
  for (const visibility of visibilities)
    sessionFor.visualize(
      { resultId: visibility, mechanic: 'd20', visibility, reveals: [{ kind: 'die', sides: 20, face: 7 }], total: 7 },
      { enabled: true },
    );
  const shown = (events: readonly ClientEvent[] = []) =>
    events.flatMap((event) => (event.type === VISUALIZATION_EVENT ? [event.resultId] : []));
  assert.deepEqual(shown(received.gm), ['gm', 'player', 'public', 'actor-scoped']);
  assert.deepEqual(shown(received.player), ['player', 'public']);
  assert.deepEqual(shown(received.actor), []);
});

test('committed rolls reach each session as visualizations through the event visibility', () => {
  const { sessionFor, envelope, seed } = setup();
  seed('config', CAMPAIGN_CONFIGURED, { config: visualizingConfig() }, 'gm');
  const player = collect(sessionFor(PLAYER_VIEWER), envelope);
  const rival = collect(sessionFor(RIVAL_VIEWER), envelope);
  const gm = collect(sessionFor(GM_VIEWER), envelope);
  seed('swim-roll', 'RuleResolved', resolvedRoll('swim-roll'), 'player');
  seed('ambush-roll', 'RuleResolved', resolvedRoll('ambush-roll'), 'gm');
  seed('rival-roll', 'RuleResolved', resolvedRoll('rival-roll'), 'actor-scoped', RIVAL);
  sessionFor(PLAYER_VIEWER).getSnapshot({ ...envelope, type: 'GetCampaignSnapshot' });
  const shown = (events: readonly ClientEvent[]) =>
    events.flatMap((event) => (event.type === VISUALIZATION_EVENT ? [[event.resultId, event.final.outcome]] : []));
  assert.deepEqual(shown(player), [['swim-roll', 'swim.made']]);
  assert.deepEqual(shown(rival), []);
  assert.deepEqual(shown(gm), [
    ['swim-roll', 'swim.made'],
    ['ambush-roll', 'swim.made'],
    ['rival-roll', 'swim.made'],
  ]);
  assert.doesNotMatch(JSON.stringify(player), /ambush-roll|rival-roll/);
});

test('committed rolls are not visualized when the campaign has not turned visualization on', () => {
  const { sessionFor, envelope, seed } = setup();
  const gm = collect(sessionFor(GM_VIEWER), envelope);
  seed('swim-roll', 'RuleResolved', resolvedRoll('swim-roll'), 'public');
  sessionFor(GM_VIEWER).getSnapshot({ ...envelope, type: 'GetCampaignSnapshot' });
  assert.deepEqual(
    gm.filter((event) => event.type === VISUALIZATION_EVENT),
    [],
  );
  assert.ok(ids(gm).includes('swim-roll'));
});

test('EditSheetField commits a re-validated edit through the engine sheet port', () => {
  const { engine, campaignId, turn, envelope } = setup();
  const { sheets, commits } = fakeSheets(turn.actorId);
  const session = createClientSessions(engine, campaignId, () => [], undefined, sheets)(PLAYER_VIEWER);
  const edit = {
    ...envelope,
    type: 'EditSheetField',
    actionId: 'edit-1',
    expectedRevision: OPENING_REVISION,
    actorId: turn.actorId,
    fieldId: 'stress',
    value: 4,
  } as const;
  assert.deepEqual(session.editSheetField(edit), { ok: true, value: { revision: OPENING_REVISION } });
  assert.deepEqual(commits, [
    {
      campaignId,
      actionId: 'edit-1',
      actorId: turn.actorId,
      expectedRevision: OPENING_REVISION,
      fieldId: 'stress',
      value: 4,
    },
  ]);

  const code = (result: { ok: boolean; error?: { code: string } }) => result.error?.code;
  const rejected: [Partial<typeof edit> | Record<string, unknown>, string][] = [
    [{ expectedRevision: OPENING_REVISION + 1 }, 'StaleRevision'],
    [{ fieldId: 'wounded', value: true }, 'Rejected'],
    [{ fieldId: 'title', value: 'Rook' }, 'Rejected'],
    [{ fieldId: 'scar', value: 'burn' }, 'Rejected'],
    [{ fieldId: 'missing', value: 'x' }, 'Rejected'],
    [{ actorId: 'someone-else' }, 'Rejected'],
    [{ campaignId: 'someone-else' }, 'Rejected'],
    [{ value: 'four' }, 'MalformedCommand'],
    [{ value: { hp: 999 } }, 'MalformedCommand'],
    [{ state: { hp: 999 } }, 'UnexpectedField'],
  ];
  for (const [change, expected] of rejected)
    assert.equal(code(session.editSheetField({ ...edit, ...change } as typeof edit)), expected, JSON.stringify(change));
  assert.equal(commits.length, 1);
});

test('EditSheetField maps a failing sheet port or a missing one to a typed rejection', () => {
  const { engine, campaignId, turn, envelope } = setup();
  const edit = {
    ...envelope,
    type: 'EditSheetField',
    actionId: 'edit-1',
    expectedRevision: OPENING_REVISION,
    actorId: turn.actorId,
    fieldId: 'name',
    value: 'Rook',
  } as const;
  const code = (result: { ok: boolean; error?: { code: string } }) => result.error?.code;
  const noSheets = createClientSessions(engine, campaignId, () => [])(PLAYER_VIEWER);
  assert.equal(code(noSheets.editSheetField(edit)), 'Rejected');
  const boom = () => {
    throw new Error('boom');
  };
  for (const sheets of [
    { ...fakeSheets(turn.actorId).sheets, read: boom },
    { ...fakeSheets(turn.actorId).sheets, commit: boom },
  ]) {
    const session = createClientSessions(engine, campaignId, () => [], undefined, sheets)(PLAYER_VIEWER);
    assert.equal(code(session.editSheetField(edit)), 'Rejected');
  }
});

const traitsOf = (events: readonly ClientEvent[], eventId: string) =>
  events.flatMap((event) =>
    event.type === EVENT_COMMITTED && event.event.id === eventId
      ? [(event.event.payload.profile as { traits: { id: string }[] }).traits.map(({ id }) => id)]
      : [],
  );

test('rpg-qzx.8: CharacterCreated redacts gm and hidden traits for non-gm subscribers', () => {
  const { sessionFor, envelope, seed } = setup();
  const payload = {
    actorId: 'hero',
    profile: {
      traits: [
        { id: 'grit', value: 3 },
        { id: 'sheet-note', value: 'OWNER-ONLY' },
        { id: 'doom', value: 'GM-DOOM' },
        { id: 'secret', value: 'HIDDEN-SECRET' },
      ],
    },
    overrides: [
      { fieldId: 'grit', value: 3 },
      { fieldId: 'doom', value: 'GM-DOOM' },
    ],
    traitVisibility: { grit: 'public', 'sheet-note': 'owner', doom: 'gm', secret: 'hidden' },
  };
  seed('created', 'CharacterCreated', payload, 'public');
  const player = collect(sessionFor(PLAYER_VIEWER), envelope);
  const owner = collect(sessionFor({ scope: 'actor', actorId: 'hero' }), envelope);
  const stranger = collect(sessionFor({ scope: 'actor', actorId: RIVAL }), envelope);
  const gm = collect(sessionFor(GM_VIEWER), envelope);
  assert.deepEqual(traitsOf(player, 'created'), [['grit']]);
  assert.deepEqual(traitsOf(stranger, 'created'), [['grit']]);
  assert.deepEqual(traitsOf(owner, 'created'), [['grit', 'sheet-note']]);
  assert.deepEqual(traitsOf(gm, 'created'), [['grit', 'sheet-note', 'doom', 'secret']]);
  assert.doesNotMatch(JSON.stringify(stranger), /GM-DOOM|HIDDEN-SECRET|OWNER-ONLY/);
  assert.match(JSON.stringify(gm), /GM-DOOM/);
  assert.doesNotMatch(JSON.stringify(player), /GM-DOOM|HIDDEN-SECRET|OWNER-ONLY|doom|secret/);
});

test('rpg-qzx.9: legacy CharacterCreated without traitVisibility fails closed for non-owner viewers', () => {
  const { sessionFor, envelope, seed } = setup();
  const payload = {
    actorId: 'hero',
    profile: { traits: [{ id: 'grit', value: 3 }] },
    overrides: [{ fieldId: 'doom', value: 'GM-DOOM' }],
  };
  seed('legacy', 'CharacterCreated', payload, 'public');
  const overridesOf = (events: readonly ClientEvent[]) =>
    events.flatMap((event) =>
      event.type === EVENT_COMMITTED && event.event.id === 'legacy' ? [event.event.payload.overrides] : [],
    );
  const player = collect(sessionFor(PLAYER_VIEWER), envelope);
  const stranger = collect(sessionFor({ scope: 'actor', actorId: RIVAL }), envelope);
  const owner = collect(sessionFor({ scope: 'actor', actorId: 'hero' }), envelope);
  const gm = collect(sessionFor(GM_VIEWER), envelope);
  assert.deepEqual(traitsOf(player, 'legacy'), [[]]);
  assert.deepEqual(traitsOf(stranger, 'legacy'), [[]]);
  assert.deepEqual(overridesOf(player), [[]]);
  assert.deepEqual(overridesOf(stranger), [[]]);
  assert.doesNotMatch(JSON.stringify(stranger), /GM-DOOM/);
  assert.deepEqual(traitsOf(owner, 'legacy'), [['grit']]);
  assert.match(JSON.stringify(owner), /GM-DOOM/);
  assert.deepEqual(traitsOf(gm, 'legacy'), [['grit']]);
});

test('RequestView sheet serves the hero sheet fields with their stored values', () => {
  const { database, sessionFor, envelope, campaignId, turn } = setup();
  const request = { ...envelope, type: 'RequestView', viewId: 'sheet' } as const;
  assert.deepEqual(sessionFor(PLAYER_VIEWER).requestView(request), {
    ok: true,
    value: { campaignId, viewId: 'sheet', components: [] },
  });
  createCharacterStore(createEntityStore(database)).saveProfile(
    campaignId,
    turn.actorId,
    {
      identity: { name: 'The Wanderer' },
      motivations: [],
      background: '',
      traits: [
        { id: 'resolve', value: 3 },
        { id: 'oath', value: 'guard the road' },
      ],
      conditions: [],
      rulepack: RULEPACK,
    },
    'player',
  );
  assert.deepEqual(sessionFor(PLAYER_VIEWER).requestView(request), {
    ok: true,
    value: {
      campaignId,
      viewId: 'sheet',
      components: [
        { kind: 'field', id: 'resolve', label: 'resolve', value: 3 },
        { kind: 'field', id: 'oath', label: 'oath', value: 'guard the road' },
      ],
    },
  });
  assert.deepEqual(sessionFor(RIVAL_VIEWER).requestView(request), {
    ok: true,
    value: { campaignId, viewId: 'sheet', components: [] },
  });
  const owner = sessionFor({ scope: 'actor', actorId: turn.actorId }).requestView(request);
  assert.equal(owner.ok && owner.value.components.length, 2);
});

const visualizedConfig = (enabled: boolean) => {
  const explicit = <T>(value: T) => ({ value, provenance: 'explicit' as const });
  const rulepack = { ...RULEPACK, capabilities: { dice: true }, sourceRefs: [] };
  const intent = createCampaignIntent({
    ruleset: explicit({ id: RULEPACK.id, edition: RULEPACK.edition }),
    client: explicit('tui'),
    diceVisualization: explicit(enabled),
  });
  const result = generateCampaignConfig(intent, { rulepacks: [rulepack], genres: [] });
  assert.ok(result.ok, JSON.stringify(result));
  return result.config;
};

const ROLL = {
  type: 'roll.resolved',
  rollId: 'r1',
  pool: { dice: [{ count: 1, sides: 20 }], modifier: 2 },
  draws: [[14]],
  total: 16,
};

const resolveRoll = (seed: ReturnType<typeof setup>['seed'], actorId: string, visibility: Visibility) => {
  seed(
    `start-${visibility}`,
    'EncounterStarted',
    { encounterId: 'ambush', participants: [actorId], sheets: [] },
    visibility,
  );
  seed(
    `strike-${visibility}`,
    'EncounterActionResolved',
    {
      encounterId: 'ambush',
      actorId,
      round: 1,
      ruleId: 'strike',
      dslVersion: 1,
      modifiers: {},
      resolution: { ok: true, changes: [], events: [], rolls: [ROLL] },
    },
    visibility,
  );
};

const mechanics = (events: readonly ClientEvent[]) => events.filter((event) => event.type === VISUALIZATION_EVENT);

test('a newly resolved encounter roll reaches subscribers as MechanicVisualized when dice visualization is on', () => {
  const { sessionFor, envelope, seed, turn } = setup(visualizedConfig(true));
  const player = collect(sessionFor(PLAYER_VIEWER), envelope);
  resolveRoll(seed, turn.actorId, 'player');
  sessionFor(PLAYER_VIEWER).getSnapshot({ ...envelope, type: 'GetCampaignSnapshot' });
  assert.deepEqual(mechanics(player), [
    {
      version: PROTOCOL_VERSION,
      type: VISUALIZATION_EVENT,
      resultId: 'r1',
      mechanic: 'dice',
      frames: [{ step: 0, reveal: { kind: 'die', sides: 20, face: 14 } }],
      final: { total: 16, outcome: undefined, modifier: 2 },
    },
  ]);
  sessionFor(PLAYER_VIEWER).getSnapshot({ ...envelope, type: 'GetCampaignSnapshot' });
  assert.equal(mechanics(player).length, 1);
});

test('encounter rolls stay hidden when dice visualization is off or the roll is gm-only', () => {
  const off = setup(visualizedConfig(false));
  const muted = collect(off.sessionFor(PLAYER_VIEWER), off.envelope);
  resolveRoll(off.seed, off.turn.actorId, 'player');
  off.sessionFor(PLAYER_VIEWER).getSnapshot({ ...off.envelope, type: 'GetCampaignSnapshot' });
  assert.deepEqual(mechanics(muted), []);

  const on = setup(visualizedConfig(true));
  const player = collect(on.sessionFor(PLAYER_VIEWER), on.envelope);
  const gm = collect(on.sessionFor(GM_VIEWER), on.envelope);
  resolveRoll(on.seed, on.turn.actorId, 'gm');
  on.sessionFor(PLAYER_VIEWER).getSnapshot({ ...on.envelope, type: 'GetCampaignSnapshot' });
  assert.deepEqual(mechanics(player), []);
  assert.equal(mechanics(gm).length, 1);
});

test('rolls of the current encounter stored before subscribing replay once to the new subscriber', () => {
  const on = setup(visualizedConfig(true));
  resolveRoll(on.seed, on.turn.actorId, 'player');
  const player = collect(on.sessionFor(PLAYER_VIEWER), on.envelope);
  on.sessionFor(PLAYER_VIEWER).getSnapshot({ ...on.envelope, type: 'GetCampaignSnapshot' });
  assert.equal(mechanics(player).length, 1);

  const secret = setup(visualizedConfig(true));
  resolveRoll(secret.seed, secret.turn.actorId, 'gm');
  assert.deepEqual(mechanics(collect(secret.sessionFor(PLAYER_VIEWER), secret.envelope)), []);
  assert.equal(mechanics(collect(secret.sessionFor(GM_VIEWER), secret.envelope)).length, 1);

  const off = setup(visualizedConfig(false));
  resolveRoll(off.seed, off.turn.actorId, 'player');
  assert.deepEqual(mechanics(collect(off.sessionFor(PLAYER_VIEWER), off.envelope)), []);
});

const secondClient = (database: ReturnType<typeof setup>['database'], campaignId: string) =>
  createClientSessions(
    createEngine(createCampaignStore(database)),
    campaignId,
    scopedEventsOf(database),
    worldOf(database),
  );

const committed = (events: readonly ClientEvent[]) =>
  events.flatMap((event) => (event.type === EVENT_COMMITTED ? [event] : []));

test('clients subscribe to canonical event revisions and can resume same campaign', () => {
  const { database, campaignId, sessionFor, envelope, turn } = setup();
  const tui = secondClient(database, campaignId)(GM_VIEWER);
  const desktop = sessionFor(GM_VIEWER);
  const tuiPlayer = secondClient(database, campaignId)(PLAYER_VIEWER);
  const action = { ...envelope, type: 'SubmitPlayerAction', sceneId: turn.sceneId, actorId: turn.actorId } as const;
  const tuiEvents: ClientEvent[] = [];
  const stop = tui.subscribeEvents({ ...envelope, type: 'SubscribeEvents' }, (event) => tuiEvents.push(event));
  const desktopEvents = collect(desktop, envelope);
  const playerEvents = collect(tuiPlayer, envelope);
  const first = tui.submitPlayerAction({ ...action, actionId: 'a1', expectedRevision: OPENING_REVISION, input: 'go' });
  assert.ok(first.ok);
  assert.ok(desktop.getSnapshot({ ...envelope, type: 'GetCampaignSnapshot' }).ok);
  assert.deepEqual(ids(desktopEvents), ids(tuiEvents));
  stop();
  const seen = ids(tuiEvents);
  const lastRevision = Math.max(...committed(tuiEvents).map(({ revision }) => revision));
  const second = desktop.submitPlayerAction({
    ...action,
    actionId: 'a2',
    expectedRevision: first.value.revision,
    input: 'wait',
  });
  assert.ok(second.ok);
  const resumed = collect(tui, envelope);
  const missed: ClientEvent[] = [];
  tui.subscribeEvents({ ...envelope, type: 'SubscribeEvents', fromRevision: lastRevision }, (event) =>
    missed.push(event),
  );
  const missedIds = ids(missed);
  assert.ok(missedIds.length > 0);
  assert.ok(committed(missed).every(({ revision }) => revision === second.value.revision));
  assert.ok(missedIds.every((id) => !seen.includes(id)));
  assert.deepEqual([...seen, ...missedIds], ids(resumed));
  assert.equal(new Set(ids(resumed)).size, ids(resumed).length);
  const revisions = committed(resumed).map(({ revision }) => revision);
  assert.deepEqual(
    revisions,
    [...revisions].sort((a, b) => a - b),
  );
  assert.ok(tuiPlayer.getSnapshot({ ...envelope, type: 'GetCampaignSnapshot' }).ok);
  assert.deepEqual(ids(playerEvents), ['clue']);
  assert.doesNotMatch(JSON.stringify(playerEvents), /Duke Varn/);
});

test('stale ui action cannot overwrite newer state from another client', () => {
  const { database, campaignId, sessionFor, envelope, turn } = setup();
  const tui = secondClient(database, campaignId)(PLAYER_VIEWER);
  const desktop = sessionFor(PLAYER_VIEWER);
  const action = { ...envelope, type: 'SubmitPlayerAction', sceneId: turn.sceneId, actorId: turn.actorId } as const;
  const snapshot = () => tui.getSnapshot({ ...envelope, type: 'GetCampaignSnapshot' });
  const stale = snapshot();
  assert.ok(stale.ok);
  const newer = desktop.submitPlayerAction({
    ...action,
    actionId: 'b1',
    expectedRevision: stale.value.revision,
    input: 'I bar the door.',
  });
  assert.ok(newer.ok);
  const before = snapshot();
  const rejected = tui.submitPlayerAction({
    ...action,
    actionId: 'a1',
    expectedRevision: stale.value.revision,
    input: 'I open the door.',
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.ok || rejected.error.code, 'StaleRevision');
  const after = snapshot();
  assert.deepEqual(after, before);
  assert.ok(after.ok);
  assert.equal(after.value.revision, newer.value.revision);
  const retried = tui.submitPlayerAction({
    ...action,
    actionId: 'a1',
    expectedRevision: after.value.revision,
    input: 'I open the door.',
  });
  assert.deepEqual(retried, { ok: true, value: { revision: newer.value.revision + 1 } });
});

test('an attempt in a d20-lite campaign rolls through the engine and reaches the player mechanics feed', () => {
  const explicit = <T>(value: T) => ({ value, provenance: 'explicit' as const });
  const intent = createCampaignIntent({
    ruleset: explicit({ id: 'd20-lite', edition: 'original' }),
    client: explicit('tui'),
    diceVisualization: explicit(true),
  });
  const generated = generateCampaignConfig(intent, { rulepacks: BUILT_IN_PACKS, genres: [] });
  assert.ok(generated.ok, JSON.stringify(generated));
  const { sessionFor, envelope, turn, seed } = setup(generated.config);
  const traits = ['might', 'agility', 'wits', 'presence'].map((id) => ({ id, value: 5 }));
  const profile = { identity: { name: 'Wren' }, motivations: [], background: '', traits, conditions: [] };
  const rulepack = { id: 'd20-lite', edition: 'original', revision: '1' };
  seed('wren', CHARACTER_CREATED, { actorId: turn.actorId, profile: { ...profile, rulepack } }, 'player');
  const player = collect(sessionFor(PLAYER_VIEWER), envelope);
  const accepted = sessionFor(PLAYER_VIEWER).submitPlayerAction({
    ...envelope,
    type: 'SubmitPlayerAction',
    actionId: 'climb',
    expectedRevision: OPENING_REVISION,
    sceneId: turn.sceneId,
    actorId: turn.actorId,
    input: 'I try to climb the wall',
  });
  assert.ok(accepted.ok, JSON.stringify(accepted));
  const [shown] = mechanics(player);
  const reveal = shown?.type === VISUALIZATION_EVENT ? shown.frames[0]?.reveal : undefined;
  assert.deepEqual(reveal?.kind === 'die' && reveal.sides, 20);
  assert.match((shown?.type === VISUALIZATION_EVENT && shown.final.outcome) || '', /^check\./);
});
