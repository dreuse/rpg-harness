import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Visibility } from '../../../packages/domain/src/entity.ts';
import { CHARACTER_CREATED, commitCharacter } from '../../../packages/engine/src/character.ts';
import { createEngine } from '../../../packages/engine/src/engine.ts';
import { openScene } from '../../../packages/engine/src/turn.ts';
import { createCampaignStore } from '../../../packages/persistence/src/campaign-store.ts';
import { createCharacterStore } from '../../../packages/persistence/src/character-store.ts';
import { MIGRATIONS, openDatabase } from '../../../packages/persistence/src/database.ts';
import { createEntityStore } from '../../../packages/persistence/src/entity-store.ts';
import type { CreationRules } from '../../../packages/rules/src/character-builder.ts';
import { SHEET_SCHEMA_VERSION } from '../../../packages/rules/src/sheet-schema.ts';
import { importSheet, SHEET_EXPORT_FORMAT } from '../../../packages/rules/src/sheet-view.ts';
import { createEngineGateway, readCampaignState } from './engine-gateway.ts';
import { main } from './main.ts';
import { renderView } from './views.ts';

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
const VIEWS = ['sheet', 'sheet-export', 'inventory', 'journal', 'quests', 'recap'] as const;
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

const ENCOUNTER_ID = 'ambush';
const roll = (rollId: string, sides: number, faces: number[], modifier: number) => ({
  type: 'roll.resolved',
  rollId,
  pool: { dice: [{ count: faces.length, sides }], modifier },
  draws: [faces],
  total: faces.reduce((sum, face) => sum + face, modifier),
});

const seedEncounter = (dataDir: string, actions: readonly (readonly [object, Visibility])[], outcome: string) => {
  const state = readCampaignState(dataDir, CAMPAIGN);
  const [hero] = state.characters;
  const [opening] = state.turns;
  assert.ok(hero !== undefined && opening !== undefined);
  const connection = openDatabase(join(dataDir, `${CAMPAIGN}.sqlite`));
  try {
    const event = (type: string, payload: object, visibility: Visibility) =>
      connection.database
        .prepare(INSERT_EVENT)
        .run(
          randomUUID(),
          state.campaign.id,
          opening.id,
          type,
          JSON.stringify({ encounterId: ENCOUNTER_ID, ...payload }),
          visibility,
          null,
        );
    event('EncounterStarted', { participants: [hero.id], sheets: [] }, PLAYER);
    for (const [action, visibility] of actions) {
      event('EncounterActionResolved', { actorId: hero.id, round: 1, dslVersion: 1, ...action }, visibility);
    }
    event('EncounterResolved', { outcome }, PLAYER);
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

test('show sheet on cli and export structured portable representation with provenance', () =>
  withDataDir(async (dataDir) => {
    await run(dataDir, ['new', CAMPAIGN]);
    seed(dataDir, PLAYER);
    assert.match(await run(dataDir, ['sheet', CAMPAIGN]), /\(any-pack 1\)\n {2}resolve: 3\n {2}oath: guard the road/);
    const exported = JSON.parse(await run(dataDir, ['sheet-export', CAMPAIGN]));
    assert.equal(exported.format, SHEET_EXPORT_FORMAT);
    assert.deepEqual(exported.schema.rulepack, { ...RULEPACK, sourceRefs: [] });
    assert.deepEqual(exported.entries, [
      { id: 'resolve', value: 3, source: 'core' },
      { id: 'oath', value: 'guard the road', source: 'core' },
    ]);
    assert.deepEqual(importSheet(exported), { ok: true, sheet: exported });
  }));

const CREATION_RULES: CreationRules = {
  schema: {
    schemaVersion: SHEET_SCHEMA_VERSION,
    rulepack: { ...RULEPACK, sourceRefs: [] },
    fields: [{ id: 'grit', widget: 'number', custom: false, visibility: 'public' }],
  },
  constraints: [],
  startingEquipment: [],
  overridableFields: [],
};

const GUARDED_RULES: CreationRules = {
  ...CREATION_RULES,
  schema: {
    ...CREATION_RULES.schema,
    fields: [
      ...CREATION_RULES.schema.fields,
      { id: 'doom', widget: 'text', custom: false, visibility: 'gm' },
      { id: 'omen', widget: 'text', custom: false, visibility: 'hidden' },
    ],
  },
};
const GUARDED_VALUES = { grit: 3, doom: 'SECRET_DOOM', omen: 'SECRET_OMEN' };
const GM_SHEET_VIEWER = { role: 'gm' } as const;

const createHero = (dataDir: string, name: string, rules = CREATION_RULES, values: object = { grit: 3 }) => {
  const state = readCampaignState(dataDir, CAMPAIGN);
  const [hero] = state.characters;
  assert.ok(hero !== undefined && state.currentScene !== undefined);
  const connection = openDatabase(join(dataDir, `${CAMPAIGN}.sqlite`));
  try {
    commitCharacter(createCampaignStore(connection.database), {
      campaignId: state.campaign.id,
      actionId: randomUUID(),
      expectedRevision: state.revision,
      sceneId: state.currentScene.id,
      actorId: hero.id,
      input: 'A drifter.',
      intent: 'create character',
      build: {
        rules,
        backstory: 'A drifter.',
        proposal: { name, values: { ...values }, equipment: [] },
      },
    });
  } finally {
    connection.close();
  }
};

test('the sheet shows the character created by the engine under its identity name', () =>
  withDataDir(async (dataDir) => {
    await run(dataDir, ['new', CAMPAIGN]);
    createHero(dataDir, 'Wren');
    assert.match(await run(dataDir, ['sheet', CAMPAIGN]), /^Wren \(any-pack 1\)\n {2}grit: 3/);
    assert.deepEqual(JSON.parse(await run(dataDir, ['sheet-export', CAMPAIGN])).entries, [
      { id: 'grit', value: 3, source: 'core' },
    ]);
  }));

test('views and turns show the character created by rpg new instead of the default hero', () =>
  withDataDir(async (dataDir) => {
    const created = await run(
      dataDir,
      ['new', CAMPAIGN, 'A fantasy adventure using the D20-Lite rules'],
      ['A scout named Wren with might 6, agility 5, wits 7 and presence 4.'],
    );
    assert.match(created, /Created Wren\./);
    assert.deepEqual(
      readCampaignState(dataDir, CAMPAIGN).characters.map(({ name }) => name),
      ['Wren'],
    );
    assert.match(await run(dataDir, ['play', CAMPAIGN], [ACTION]), new RegExp(`Wren: ${ACTION}`));
    assert.match(await run(dataDir, ['sheet', CAMPAIGN]), /^Wren \(d20-lite original\)/);
    assert.doesNotMatch(await run(dataDir, ['journal', CAMPAIGN]), /The Wanderer/);
  }));

const sourceOf = (dataDir: string) => ({
  state: readCampaignState(dataDir, CAMPAIGN),
  entities: [],
  relationships: [],
  eventScopes: [],
});

test('the created sheet hides gm and hidden traits from the player and shows gm traits to the gm', () =>
  withDataDir(async (dataDir) => {
    await run(dataDir, ['new', CAMPAIGN]);
    createHero(dataDir, 'Wren', GUARDED_RULES, GUARDED_VALUES);
    const player = [
      await run(dataDir, ['sheet', CAMPAIGN]),
      await run(dataDir, ['sheet-export', CAMPAIGN]),
      await run(dataDir, ['play', CAMPAIGN], ['/sheet', '/sheet-export']),
    ].join('');
    assert.match(player, /grit: 3/);
    assert.doesNotMatch(player, /SECRET_DOOM|SECRET_OMEN|\bdoom\b|\bomen\b/);
    const gm = renderView('sheet', sourceOf(dataDir), GM_SHEET_VIEWER);
    assert.match(gm, /grit: 3\n {2}doom: SECRET_DOOM$/);
    assert.doesNotMatch(gm, /SECRET_OMEN/);
  }));

test('the sheet still reads a creation event committed with owner-visible traits only', () =>
  withDataDir(async (dataDir) => {
    await run(dataDir, ['new', CAMPAIGN]);
    const state = readCampaignState(dataDir, CAMPAIGN);
    const [hero] = state.characters;
    const [opening] = state.turns;
    assert.ok(hero !== undefined && opening !== undefined);
    const profile = {
      identity: { name: hero.name },
      motivations: [],
      background: 'A drifter.',
      traits: [{ id: 'grit', value: 3 }],
      conditions: [],
      rulepack: RULEPACK,
    };
    const connection = openDatabase(join(dataDir, `${CAMPAIGN}.sqlite`));
    try {
      connection.database
        .prepare(INSERT_EVENT)
        .run(
          randomUUID(),
          state.campaign.id,
          opening.id,
          CHARACTER_CREATED,
          JSON.stringify({ actorId: hero.id, profile, equipment: [], overrides: [] }),
          GM,
          null,
        );
    } finally {
      connection.close();
    }
    assert.match(await run(dataDir, ['sheet', CAMPAIGN]), /\(any-pack 1\)\n {2}grit: 3/);
  }));

test('a gm-only stored profile stays hidden even after character creation', () =>
  withDataDir(async (dataDir) => {
    await run(dataDir, ['new', CAMPAIGN]);
    seed(dataDir, GM);
    createHero(dataDir, 'Wren');
    const sheet = await run(dataDir, ['sheet', CAMPAIGN]);
    assert.match(sheet, /^Wren\nNo character sheet yet\./);
    assert.doesNotMatch(sheet, /SECRET_TRAIT/);
  }));

test('views show empty states when there is nothing to read', () =>
  withDataDir(async (dataDir) => {
    await run(dataDir, ['new', CAMPAIGN]);
    assert.match(await run(dataDir, ['sheet', CAMPAIGN]), /No character sheet yet\./);
    assert.match(await run(dataDir, ['sheet-export', CAMPAIGN]), /No character sheet yet\./);
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

test('display trusted rolls, modifiers and encounter outcomes in readable text', () =>
  withDataDir(async (dataDir) => {
    await run(dataDir, ['new', CAMPAIGN]);
    assert.match(await run(dataDir, ['encounter', CAMPAIGN]), /No encounter yet\./);
    seedEncounter(
      dataDir,
      [
        [
          {
            ruleId: 'strike',
            modifiers: { flank: 2, cover: -1 },
            resolution: {
              ok: true,
              changes: [{ id: 'stamina', from: 5, to: 3 }],
              events: [{ actionId: 'a1', ruleId: 'strike', event: 'hit' }],
              rolls: [roll('r1', 6, [3, 4], 1)],
            },
          },
          PLAYER,
        ],
        [
          {
            ruleId: 'parry',
            modifiers: {},
            resolution: { ok: false, error: { code: 'RollFailed', issues: [] }, rolls: [roll('r2', 8, [2], 0)] },
          },
          PLAYER,
        ],
      ],
      'The bandits flee.',
    );
    const expected = [
      'Encounter (resolved, round 1):',
      '  - The Wanderer: strike',
      '    Roll: 2d6+1 [3, 4] = 8',
      '    Modifiers: flank +2, cover -1',
      '    Result: hit',
      '    Changes: stamina 5 -> 3',
      '  - The Wanderer: parry',
      '    Roll: 1d8 [2] = 2',
      '    Result: failed (RollFailed)',
      'Outcome: The bandits flee.',
    ].join('\n');
    assert.ok((await run(dataDir, ['encounter', CAMPAIGN])).includes(expected));
    assert.match(await run(dataDir, ['play', CAMPAIGN], ['/encounter']), /Roll: 2d6\+1 \[3, 4\] = 8/);
  }));

test('hidden gm rolls and narrative-only rulesets do not expose invented dice', () =>
  withDataDir(async (dataDir) => {
    await run(dataDir, ['new', CAMPAIGN]);
    seedEncounter(
      dataDir,
      [
        [
          {
            ruleId: 'SECRET_ROLL',
            modifiers: { SECRET_EDGE: 3 },
            resolution: { ok: true, changes: [], events: [], rolls: [roll('r3', 20, [17], 0)] },
          },
          GM,
        ],
        [{ ruleId: 'talk', modifiers: {}, resolution: { ok: true, changes: [], events: [], rolls: [] } }, PLAYER],
      ],
      'The guard waves you through.',
    );
    const output = await run(dataDir, ['encounter', CAMPAIGN]);
    assert.match(output, /- The Wanderer: talk\nOutcome: The guard waves you through\./);
    assert.doesNotMatch(output, /SECRET|Roll|Modifiers|\d+d\d+|17/);
  }));
