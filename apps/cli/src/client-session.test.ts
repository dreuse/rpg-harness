import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type ClientEvent,
  type ClientSession,
  MAX_INPUT_LENGTH,
  PROTOCOL_VERSION,
} from '../../../packages/client-protocol/src/protocol.ts';
import { MAIN_BRANCH } from '../../../packages/domain/src/campaign.ts';
import type { Visibility } from '../../../packages/domain/src/entity.ts';
import { createEngine } from '../../../packages/engine/src/engine.ts';
import { openScene } from '../../../packages/engine/src/turn.ts';
import { GM_VIEWER, PLAYER_VIEWER, type Viewer } from '../../../packages/memory/src/knowledge.ts';
import { createCampaignStore } from '../../../packages/persistence/src/campaign-store.ts';
import { openDatabase } from '../../../packages/persistence/src/database.ts';
import { createEntityStore } from '../../../packages/persistence/src/entity-store.ts';
import { createClientSessions, scopedEventsOf } from './client-session.ts';

const IN_MEMORY = ':memory:';
const GM_SECRET = 'The stranger is Duke Varn in disguise.';
const RIVAL = 'rival';
const RIVAL_VIEWER: Viewer = { scope: 'actor', actorId: RIVAL };
const OPENING_REVISION = 1;
const INSERT_EVENT =
  'INSERT INTO event_log (id, campaign_id, branch_id, revision, turn_id, type, payload, visibility, actor_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)';

const setup = () => {
  const { database } = openDatabase(IN_MEMORY);
  const store = createCampaignStore(database);
  const engine = createEngine(store);
  const campaign = engine.createCampaign('Ashfall');
  const { turn } = openScene(store, {
    campaignId: campaign.id,
    actorName: 'The Wanderer',
    sceneTitle: 'The Crossroads Inn',
    narration: 'Rain drums on the roof.',
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
  const sessionFor = createClientSessions(engine, campaign.id, scopedEventsOf(database));
  const envelope = { version: PROTOCOL_VERSION, campaignId: campaign.id } as const;
  return { engine, campaignId: campaign.id, turn, sessionFor, envelope };
};

type Envelope = ReturnType<typeof setup>['envelope'];

const collect = (session: ClientSession, envelope: Envelope) => {
  const received: ClientEvent[] = [];
  session.subscribeEvents({ ...envelope, type: 'SubscribeEvents' }, (event) => received.push(event));
  return received;
};

const ids = (events: readonly ClientEvent[]) => events.map(({ event }) => event.id);

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
  assert.ok(gm.slice(before).every(({ revision }) => revision === OPENING_REVISION + 1));
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
  assert.equal(code(session.submitPlayerAction({ ...action, input: 'go', expectedRevision: 0 })), 'Rejected');
  assert.equal(
    code(session.selectCapability({ ...envelope, type: 'SelectCapability', capabilityId: 'combat', enabled: true })),
    'Rejected',
  );
  assert.equal(code(session.requestView({ ...envelope, type: 'RequestView', viewId: 'sheet' })), 'Rejected');
  const ignored: ClientEvent[] = [];
  session.subscribeEvents({ ...envelope, campaignId: 'someone-else', type: 'SubscribeEvents' }, (event) =>
    ignored.push(event),
  );
  assert.deepEqual(ignored, []);
});
