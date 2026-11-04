import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Visibility } from '../../../packages/domain/src/entity.ts';
import { createEngine } from '../../../packages/engine/src/engine.ts';
import { openScene } from '../../../packages/engine/src/turn.ts';
import { createCampaignStore } from '../../../packages/persistence/src/campaign-store.ts';
import { createCharacterStore } from '../../../packages/persistence/src/character-store.ts';
import { MIGRATIONS, openDatabase } from '../../../packages/persistence/src/database.ts';
import { createEntityStore } from '../../../packages/persistence/src/entity-store.ts';
import { createEngineGateway, readCampaignState } from './engine-gateway.ts';
import { main } from './main.ts';

const CAMPAIGN = 'Ember';
const ACTION = 'I light the lantern';
const PLAYER: Visibility = 'player';
const PUBLIC: Visibility = 'public';
const GM: Visibility = 'gm';
const ACTOR_SCOPED: Visibility = 'actor-scoped';
const RIVAL = 'rival';
const RULEPACK = { id: 'any-pack', edition: '1', revision: 'r1' };
const SECRETS = [
  'SECRET_TRAIT',
  'SECRET_BLADE',
  'SECRET_QUEST',
  'SECRET_OBJECTIVE',
  'SECRET_FACT',
  'SECRET_RING',
  'SECRET_PLOT',
];
const VIEWS = ['sheet', 'inventory', 'journal', 'quests', 'recap'] as const;
const INSERT_EVENT =
  'INSERT INTO event_log (id, campaign_id, turn_id, type, payload, visibility, actor_id) VALUES (?, ?, ?, ?, ?, ?, ?)';
const INSERT_FACT = 'INSERT INTO fact (id, campaign_id, statement, layer, visibility) VALUES (?, ?, ?, ?, ?)';

const withDataDir = async (run: (dataDir: string) => Promise<void>) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'rpg-views-'));
  try {
    await run(dataDir);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
};

const seed = (dataDir: string, profileVisibility: Visibility & ('player' | 'gm')) => {
  const state = readCampaignState(dataDir, CAMPAIGN);
  const [hero] = state.characters;
  const [opening] = state.turns;
  assert.ok(hero !== undefined && opening !== undefined);
  const connection = openDatabase(join(dataDir, `${CAMPAIGN}.sqlite`));
  try {
    const { database } = connection;
    const entities = createEntityStore(database);
    const campaignId = state.campaign.id;
    createCharacterStore(entities).saveProfile(
      campaignId,
      hero.id,
      {
        identity: { name: hero.name },
        motivations: [],
        background: '',
        traits: [
          { id: 'resolve', value: 3 },
          { id: 'oath', value: profileVisibility === GM ? 'SECRET_TRAIT' : 'guard the road' },
        ],
        conditions: [],
        rulepack: RULEPACK,
      },
      profileVisibility,
    );
    const item = (id: string, name: string, visibility: Visibility, actorId: string | null = null) => {
      entities.saveEntity({ id, campaignId, kind: 'item', name, data: {}, visibility, actorId });
      entities.saveRelationship({
        id: randomUUID(),
        campaignId,
        kind: 'carries',
        sourceId: hero.id,
        targetId: id,
        data: {},
      });
    };
    item('lantern', 'Brass lantern', PUBLIC);
    item('blade', 'SECRET_BLADE', GM);
    entities.saveEntity({ id: RIVAL, campaignId, kind: 'npc', name: 'Rival', data: {}, visibility: GM, actorId: null });
    item('ring', 'SECRET_RING', ACTOR_SCOPED, RIVAL);
    entities.saveEntity({
      id: 'stone',
      campaignId,
      kind: 'item',
      name: 'Loose stone',
      data: {},
      visibility: PUBLIC,
      actorId: null,
    });
    const event = (type: string, payload: object, visibility: Visibility, actorId: string | null = null) =>
      database
        .prepare(INSERT_EVENT)
        .run(randomUUID(), campaignId, opening.id, type, JSON.stringify(payload), visibility, actorId);
    const objectives = (summary: string) => [{ id: 'first', summary }];
    event(
      'QuestDefined',
      { questId: 'ferry', title: 'Find the ferryman', objectives: objectives('Ask at the docks'), prerequisites: [] },
      PLAYER,
    );
    event('QuestActivated', { questId: 'ferry' }, PLAYER);
    event(
      'QuestDefined',
      { questId: 'plot', title: 'SECRET_QUEST', objectives: objectives('SECRET_OBJECTIVE'), prerequisites: [] },
      GM,
    );
    event(
      'QuestDefined',
      { questId: 'scheme', title: 'SECRET_PLOT', objectives: objectives('Bide time'), prerequisites: [] },
      ACTOR_SCOPED,
      RIVAL,
    );
    event('QuestActivated', { questId: 'scheme' }, ACTOR_SCOPED, RIVAL);
    database.prepare(INSERT_FACT).run(randomUUID(), campaignId, 'SECRET_FACT', 'canon', GM);
  } finally {
    connection.close();
  }
};

const lines = async function* (input: readonly string[]) {
  yield* input;
};

const run = async (dataDir: string, argv: readonly string[], input: readonly string[] = []) => {
  const out: string[] = [];
  const err: string[] = [];
  const io = {
    stdout: (text: string) => out.push(text),
    stderr: (text: string) => err.push(text),
    lines: lines(input),
  };
  const code = await main(argv, io, createEngineGateway(dataDir));
  assert.deepEqual(err, []);
  assert.equal(code, 0);
  return out.join('');
};

test('read character state, inventory, important events and quests using concise commands', () =>
  withDataDir(async (dataDir) => {
    await run(dataDir, ['new', CAMPAIGN]);
    seed(dataDir, PLAYER);
    const session = await run(dataDir, ['play', CAMPAIGN], [ACTION, ...VIEWS.map((view) => `/${view}`)]);
    assert.match(session, /resolve: 3/);
    assert.match(session, /oath: guard the road/);
    assert.match(session, /Brass lantern/);
    assert.doesNotMatch(session, /Loose stone/);
    assert.match(session, new RegExp(`The Wanderer: ${ACTION}`));
    assert.match(session, /Find the ferryman \(active\)/);
    assert.match(session, /\[ \] Ask at the docks/);
    assert.match(await run(dataDir, ['recap', CAMPAIGN]), /The Crossroads Inn/);
    assert.match(await run(dataDir, ['sheet', CAMPAIGN]), /resolve: 3/);
    assert.match(await run(dataDir, ['inventory', CAMPAIGN]), /Brass lantern/);
    assert.match(await run(dataDir, ['journal', CAMPAIGN]), new RegExp(ACTION));
    assert.match(await run(dataDir, ['quests', CAMPAIGN]), /Find the ferryman/);
  }));

test('views show empty states when there is nothing to read', () =>
  withDataDir(async (dataDir) => {
    await run(dataDir, ['new', CAMPAIGN]);
    assert.match(await run(dataDir, ['sheet', CAMPAIGN]), /No character sheet yet\./);
    assert.match(await run(dataDir, ['inventory', CAMPAIGN]), /No items yet\./);
    assert.match(await run(dataDir, ['quests', CAMPAIGN]), /No quests yet\./);
    assert.match(await run(dataDir, ['journal', CAMPAIGN]), /Rain drums/);
  }));

test('player-facing views never expose hidden gm-only data', () =>
  withDataDir(async (dataDir) => {
    await run(dataDir, ['new', CAMPAIGN]);
    seed(dataDir, GM);
    const outputs = await Promise.all(VIEWS.map((view) => run(dataDir, [view, CAMPAIGN])));
    outputs.push(
      await run(
        dataDir,
        ['play', CAMPAIGN],
        VIEWS.map((view) => `/${view}`),
      ),
    );
    for (const output of outputs) for (const secret of SECRETS) assert.doesNotMatch(output, new RegExp(secret));
    assert.match(outputs.join(''), /No character sheet yet\./);
  }));

test('resume and views upgrade a campaign saved before the latest migration', () =>
  withDataDir(async (dataDir) => {
    const connection = openDatabase(join(dataDir, `${CAMPAIGN}.sqlite`), { migrations: MIGRATIONS.slice(0, -1) });
    try {
      const store = createCampaignStore(connection.database);
      const campaign = createEngine(store).createCampaign(CAMPAIGN);
      openScene(store, {
        campaignId: campaign.id,
        actorName: 'Old Hero',
        sceneTitle: 'Old Inn',
        narration: 'Old rain.',
      });
    } finally {
      connection.close();
    }
    assert.match(await run(dataDir, ['sheet', CAMPAIGN]), /No character sheet yet\./);
    assert.match(await run(dataDir, ['play', CAMPAIGN]), /Old Inn/);
  }));
