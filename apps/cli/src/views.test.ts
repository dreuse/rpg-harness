import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { PROTOCOL_VERSION } from '../../../packages/client-protocol/src/protocol.ts';
import type { Visibility } from '../../../packages/domain/src/entity.ts';
import { EMPTY_GM_USAGE_LEDGER } from '../../../packages/domain/src/gm.ts';
import { CHARACTER_CREATED, commitCharacter } from '../../../packages/engine/src/character.ts';
import { createEngine } from '../../../packages/engine/src/engine.ts';
import { OOC_STATE_SAVED } from '../../../packages/engine/src/ooc.ts';
import { CHECK_RESOLVED, openScene } from '../../../packages/engine/src/turn.ts';
import { PLAYER_VIEWER } from '../../../packages/memory/src/knowledge.ts';
import { createCampaignStore } from '../../../packages/persistence/src/campaign-store.ts';
import { createCharacterStore } from '../../../packages/persistence/src/character-store.ts';
import { MIGRATIONS, openDatabase } from '../../../packages/persistence/src/database.ts';
import { createEntityStore } from '../../../packages/persistence/src/entity-store.ts';
import type { CreationRules } from '../../../packages/rules/src/character-builder.ts';
import {
  ATTRIBUTE_MAX,
  attemptCheck,
  checkBonus,
  createSheet,
  D20_LITE_CREATION,
  DEFAULT_CHECK_DC,
} from '../../../packages/rules/src/d20-lite.ts';
import { NARRATIVE_CREATION } from '../../../packages/rules/src/narrative.ts';
import { SHEET_SCHEMA_VERSION } from '../../../packages/rules/src/sheet-schema.ts';
import { importSheet, SHEET_EXPORT_FORMAT } from '../../../packages/rules/src/sheet-view.ts';
import { EMPTY_LIVE_FOLDS, foldLive } from '../../../packages/timelines/src/live-folds.ts';
import { createEngineGateway, FAKE_GAME_MASTER, openClientSession, readCampaignState } from './engine-gateway.ts';
import { main } from './main.ts';
import {
  editableSheet,
  JOURNAL_LINE_MAX,
  panelsOf,
  printable,
  renderView,
  sheetComponents,
  sheetFields,
} from './views.ts';

const CAMPAIGN = 'Ember';
const HIGH_DRAW = 0.95;
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
    assert.match(await run(dataDir, ['journal', CAMPAIGN]), /Rain drums on the roof of the Crossroads Inn\./);
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

const ESC = '\x1b';
const CSI = `${ESC}[2J`;
const OSC = `${ESC}]0;pwn\x07`;
const BIDI_OVERRIDE = '\u202e';
const C1_CSI = '\x9b31m';
const HOSTILE = `I wave${CSI}${OSC}${BIDI_OVERRIDE}${C1_CSI} back`;
const UNSAFE = /[\p{Cc}\p{Cf}]/u;

test('printable drops C0, C1 and bidi format characters but keeps line breaks', () => {
  assert.equal(printable(`a${HOSTILE}\nb`), 'aI wave[2J]0;pwn31m back\nb');
});

test('the play loop and views never print stored control or bidi characters', () =>
  withDataDir(async (dataDir) => {
    await run(dataDir, ['new', CAMPAIGN]);
    const played = await run(dataDir, ['play', CAMPAIGN], [HOSTILE, '/journal']);
    const resumed = await run(dataDir, ['resume', CAMPAIGN]);
    const journal = await run(dataDir, ['journal', CAMPAIGN]);
    for (const output of [played, resumed]) assert.match(output, /I wave\[2J\]0;pwn31m back/);
    for (const output of [played, resumed, journal]) assert.doesNotMatch(output.replaceAll('\n', ''), UNSAFE);
  }));

test('restore, list and errors never print control or bidi characters from stored names', () =>
  withDataDir(async (dataDir) => {
    const hostile = `Ev${CSI}${BIDI_OVERRIDE}${C1_CSI}il`;
    const file = join(dataDir, 'hostile.json');
    await run(dataDir, ['new', hostile]);
    await run(dataDir, ['export', hostile, file]);
    await run(dataDir, ['delete', hostile], [hostile]);
    const restored = await run(dataDir, ['restore', file]);
    const listed = await run(dataDir, ['list']);
    const errors: string[] = [];
    const io = { stdout: () => {}, stderr: (text: string) => errors.push(text), lines: lines([]) };
    await main(['restore', file], io, createEngineGateway(dataDir));
    for (const output of [restored, listed, errors.join('')]) {
      assert.match(output, /Ev\[2J31mil/);
      assert.doesNotMatch(output.replaceAll('\n', ''), UNSAFE);
    }
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

test('the sheet shows RulePack display names instead of trait ids', () =>
  withDataDir(async (dataDir) => {
    await run(dataDir, ['new', CAMPAIGN]);
    createHero(dataDir, 'Wren', D20_LITE_CREATION, { might: 6, agility: 5, wits: 7, presence: 4 });
    const sheet = await run(dataDir, ['sheet', CAMPAIGN]);
    assert.match(sheet, / {2}Might: 6/);
    assert.doesNotMatch(sheet, /might: 6/);
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
    assert.match(sheet, /^No character sheet yet\.\n?$/);
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
    const connection = openDatabase(join(dataDir, `${CAMPAIGN}.sqlite`));
    try {
      const store = createCampaignStore(connection.database);
      const campaign = createEngine(store).createCampaign(CAMPAIGN);
      openScene(store, {
        campaignId: campaign.id,
        actorName: 'Old Hero',
        sceneTitle: 'Old Inn',
        narration: 'Old rain.',
      });
      connection.database.exec(
        `ALTER TABLE turn DROP COLUMN segments; DELETE FROM schema_migrations WHERE version = ${MIGRATIONS.length};`,
      );
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

test('rpg-42a.117 the encounter view reads in Brazilian Portuguese', () =>
  withDataDir(async (dataDir) => {
    await run(dataDir, ['new', CAMPAIGN]);
    seedEncounter(
      dataDir,
      [
        [
          {
            ruleId: 'strike',
            modifiers: { flank: 2 },
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
    assert.equal(
      renderView('encounter', sourceOf(dataDir), undefined, 'pt-BR'),
      [
        'Encontro (resolved, rodada 1):',
        '  - The Wanderer: strike',
        '    Rolagem: 2d6+1 [3, 4] = 8',
        '    Modificadores: flank +2',
        '    Resultado: hit',
        '    Mudanças: stamina 5 -> 3',
        '  - The Wanderer: parry',
        '    Rolagem: 1d8 [2] = 2',
        '    Resultado: falhou (RollFailed)',
        'Desfecho: The bandits flee.',
      ].join('\n'),
    );
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

test('a d20-lite campaign accepts sheet edits from the client session and rolls attempts through the engine', () =>
  withDataDir(async (dataDir) => {
    await run(
      dataDir,
      ['new', CAMPAIGN, 'A fantasy adventure using the D20-Lite rules'],
      ['A scout named Wren with might 6, agility 5, wits 7 and presence 4.'],
    );
    const { session, campaignId, close } = openClientSession(dataDir, CAMPAIGN);
    try {
      const envelope = { version: PROTOCOL_VERSION, campaignId } as const;
      const snapshot = session.getSnapshot({ ...envelope, type: 'GetCampaignSnapshot' });
      assert.ok(snapshot.ok);
      const [hero] = snapshot.value.characters;
      const edit = {
        ...envelope,
        type: 'EditSheetField',
        actionId: randomUUID(),
        expectedRevision: snapshot.value.revision,
        actorId: hero?.id ?? '',
        fieldId: 'might',
        value: 8,
      } as const;
      const edited = { ok: true, value: { revision: snapshot.value.revision + 1 } };
      assert.deepEqual(session.editSheetField(edit), edited);
      assert.deepEqual(session.editSheetField(edit), edited);
    } finally {
      close();
    }
    assert.match(await run(dataDir, ['sheet', CAMPAIGN]), /might: 8/i);
    await run(dataDir, ['play', CAMPAIGN], ['I try to climb the wall']);
    assert.equal(readCampaignState(dataDir, CAMPAIGN).events.at(-1)?.type, CHECK_RESOLVED);
  }));

test('rpg-42a.10: an out-of-range attribute edit is rejected and an injected rng rolls the named attribute', () =>
  withDataDir(async (dataDir) => {
    await run(
      dataDir,
      ['new', CAMPAIGN, 'A fantasy adventure using the D20-Lite rules'],
      ['A scout named Wren with might 6, agility 8, wits 7 and presence 4.'],
    );
    const { session, campaignId, close } = openClientSession(dataDir, CAMPAIGN);
    try {
      const envelope = { version: PROTOCOL_VERSION, campaignId } as const;
      const snapshot = session.getSnapshot({ ...envelope, type: 'GetCampaignSnapshot' });
      assert.ok(snapshot.ok);
      const rejected = session.editSheetField({
        ...envelope,
        type: 'EditSheetField',
        actionId: randomUUID(),
        expectedRevision: snapshot.value.revision,
        actorId: snapshot.value.characters[0]?.id ?? '',
        fieldId: 'agility',
        value: ATTRIBUTE_MAX + 1,
      });
      assert.equal(rejected.ok, false);
      assert.match(rejected.ok ? '' : rejected.error.message, /agility must be between/);
    } finally {
      close();
    }
    const rng = () => HIGH_DRAW;
    const gateway = createEngineGateway(dataDir, FAKE_GAME_MASTER, rng);
    for await (const _ of gateway.open(CAMPAIGN, 'play', lines(['I try to dodge the arrow']), assert.ifError));
    const resolved = readCampaignState(dataDir, CAMPAIGN).events.at(-1);
    assert.equal(resolved?.type, CHECK_RESOLVED);
    const sheet = createSheet({
      characterId: 'wren' as never,
      attributes: { might: 6, agility: 8, wits: 7, presence: 4 },
    });
    const expected = attemptCheck({ actionId: 'dodge', sheet, attribute: 'agility', dc: DEFAULT_CHECK_DC, rng });
    const resolution = resolved?.payload.resolution as { rolls: { draws: unknown }[]; bonus: number };
    assert.deepEqual(resolution.rolls[0]?.draws, expected.rolls[0]?.draws);
    assert.equal(resolution.bonus, checkBonus({ sheet, attribute: 'agility' }));
  }));

test('an editable d20-lite sheet labels fields from the creation schema', () =>
  withDataDir(async (dataDir) => {
    await run(
      dataDir,
      ['new', CAMPAIGN, 'A fantasy adventure using the D20-Lite rules'],
      ['A scout named Wren with might 6, agility 5, wits 7 and presence 4.'],
    );
    const state = readCampaignState(dataDir, CAMPAIGN);
    const sheet = editableSheet(
      { state, entities: [], relationships: [], eventScopes: [] },
      state.characters[0]?.id ?? '',
    );
    assert.equal(sheet?.schema.fields.find(({ id }) => id === 'might')?.label, 'Might');
  }));

test('rpg-42a.21: sheet components keep groups, edit rights, display names and computed explanations', () => {
  const view = {
    rulepack: { ...RULEPACK, sourceRefs: [] },
    groups: [
      {
        id: 'core' as const,
        fields: [{ id: 'might', label: 'Might', widget: 'number' as const, value: 6, edit: { editable: true } }],
      },
      {
        id: 'computed' as const,
        fields: [{ id: 'guard', widget: 'number' as const, value: 10, edit: { editable: false } }],
      },
    ],
    computed: [
      {
        field: 'guard',
        expression: 'might + 2',
        refs: ['might'],
        bonuses: [{ source: 'Shield', target: 'guard', amount: 3 }],
        constraints: [{ field: 'guard', status: 'clamped' as const, raw: 11, value: 10 }],
      },
    ],
  };
  assert.deepEqual(sheetComponents(view), [
    { kind: 'field', id: 'might', label: 'Might', value: 6, group: 'core', editable: true },
    {
      kind: 'field',
      id: 'guard',
      label: 'guard',
      value: 10,
      group: 'computed',
      editable: false,
      explanation: '= might + 2; +3 Shield; limited from 11',
    },
  ]);
});

test('rpg-42a.72 sheet labels of built-in stats read in the app language, imported labels stay', () => {
  const view = {
    rulepack: { ...RULEPACK, id: 'd20-lite', sourceRefs: [] },
    groups: [
      {
        id: 'core' as const,
        fields: [
          { id: 'might', label: 'Might', widget: 'number' as const, value: 6, edit: { editable: true } },
          { id: 'grit', label: 'Grit', widget: 'number' as const, value: 3, edit: { editable: true } },
        ],
      },
    ],
    computed: [],
  };
  const labels = (locale: string) => sheetComponents(view, locale).map(({ label }) => label);
  assert.deepEqual(labels('es'), ['Fuerza', 'Grit']);
  assert.deepEqual(labels('pt-BR'), ['Força', 'Grit']);
  assert.deepEqual(labels('en'), ['Might', 'Grit']);
  const imported = { ...view, rulepack: { ...RULEPACK, sourceRefs: [] } };
  assert.deepEqual(
    sheetComponents(imported, 'pt-BR').map(({ label }) => label),
    ['Might', 'Grit'],
  );
});

test('sheet components pass numeric limits from the field edit', () => {
  const view = {
    rulepack: { ...RULEPACK, sourceRefs: [] },
    groups: [
      {
        id: 'core' as const,
        fields: [
          { id: 'might', widget: 'number' as const, value: 6, edit: { editable: true, min: 1, max: 10 } },
          { id: 'name', widget: 'text' as const, value: 'Ana', edit: { editable: true } },
        ],
      },
    ],
    computed: [],
  };
  const [might, name] = sheetComponents(view);
  assert.deepEqual([might?.min, might?.max], [1, 10]);
  assert.equal(Object.hasOwn(name ?? {}, 'min'), false);
});

test('rpg-42a.38 a sheetless ruleset shows the name and description and says the game uses no sheets', () =>
  withDataDir(async (dataDir) => {
    await run(dataDir, ['new', CAMPAIGN, 'A horror story using the Narrative rules']);
    createHero(dataDir, 'Wren', NARRATIVE_CREATION, {});
    const expected = 'Wren\nA drifter.\nThis game does not use character sheets.';
    assert.equal((await run(dataDir, ['sheet', CAMPAIGN])).trim(), expected);
    assert.equal((await run(dataDir, ['sheet-export', CAMPAIGN])).trim(), expected);
    assert.doesNotMatch(await run(dataDir, ['sheet', CAMPAIGN]), /No character sheet yet/);
  }));

test('rpg-42a.38 a sheetless campaign without a created character still never claims data is missing', () =>
  withDataDir(async (dataDir) => {
    await run(dataDir, ['new', CAMPAIGN, 'A horror story using the Narrative rules']);
    const sheet = await run(dataDir, ['sheet', CAMPAIGN]);
    assert.match(sheet, /This game does not use character sheets\./);
    assert.doesNotMatch(sheet, /No character sheet yet/);
  }));

test('rpg-42a.38 the sheet view of a sheetless ruleset serves the character name and description only', () =>
  withDataDir(async (dataDir) => {
    await run(dataDir, ['new', CAMPAIGN, 'A horror story using the Narrative rules']);
    createHero(dataDir, 'Wren', NARRATIVE_CREATION, {});
    const { session, campaignId, close } = openClientSession(dataDir, CAMPAIGN);
    try {
      const view = session.requestView({ version: PROTOCOL_VERSION, type: 'RequestView', campaignId, viewId: 'sheet' });
      assert.ok(view.ok);
      assert.deepEqual(
        view.value.components.map(({ id, label, value, editable }) => [id, label, value, editable]),
        [
          ['name', 'Name', 'Wren', false],
          ['description', 'Description', 'A drifter.', false],
        ],
      );
    } finally {
      close();
    }
  }));

test('rpg-42a.117 the sheetless identity fields are labelled in the campaign language', () =>
  withDataDir(async (dataDir) => {
    await run(dataDir, ['new', CAMPAIGN, 'A horror story using the Narrative rules']);
    createHero(dataDir, 'Wren', NARRATIVE_CREATION, {});
    const source = sourceOf(dataDir);
    const labels = (locale?: string) => sheetFields(source, PLAYER_VIEWER, locale).map(({ label }) => label);
    assert.deepEqual(labels('pt-BR'), ['Nome', 'Descrição']);
    assert.deepEqual(labels('es'), ['Nombre', 'Descripción']);
    assert.deepEqual(labels(), ['Name', 'Description']);
  }));

test('panels read the projected quest log and refold the supplied fold events once a turn is retconned', () => {
  const quest = (id: string, turnId: string, visibility: Visibility = PUBLIC) => ({
    id: `event-${id}`,
    campaignId: CAMPAIGN,
    turnId,
    causationId: null,
    type: 'QuestDefined',
    payload: { questId: id, title: id, objectives: [], prerequisites: [] },
    visibility,
    actorId: null,
  });
  const events = [quest('kept', 'turn-1'), quest('hidden', 'turn-1', 'gm'), quest('undone', 'turn-2')];
  const folds = events.reduce(
    (all, { visibility, actorId, ...event }) => foldLive(all, event, visibility, actorId),
    EMPTY_LIVE_FOLDS,
  );
  const state = {
    campaign: { id: CAMPAIGN, name: CAMPAIGN },
    revision: 2,
    characters: [],
    currentScene: undefined,
    turns: [],
    events: [],
    changes: [] as { type: string; payload: Record<string, unknown> }[],
    gmUsage: EMPTY_GM_USAGE_LEDGER,
    folds,
  };
  const titles = (source: typeof state, foldEvents: typeof events | undefined, scope: 'player' | 'gm') =>
    panelsOf(
      {
        state: source,
        entities: [],
        relationships: [],
        eventScopes: [],
        ...(foldEvents === undefined ? {} : { foldEvents }),
      },
      { scope },
    ).quests.map(({ title }) => title);
  assert.deepEqual(titles(state, undefined, 'player'), ['kept', 'undone']);
  assert.deepEqual(titles(state, undefined, 'gm'), ['kept', 'hidden', 'undone']);
  const retconned = {
    ...state,
    changes: [{ type: OOC_STATE_SAVED, payload: { state: { retconned: ['turn-2'] } } }],
  };
  const surviving = events.slice(0, 2);
  assert.deepEqual(titles(retconned, surviving, 'player'), ['kept']);
  assert.deepEqual(titles(retconned, surviving, 'gm'), ['kept', 'hidden']);
  assert.deepEqual(titles(retconned, undefined, 'gm'), []);
});

const ROLL_LABEL = 'Face the hunter';
const ROLL_LINES = {
  en: `You roll for: ${ROLL_LABEL}`,
  es: `Tiras para: ${ROLL_LABEL}`,
  'pt-BR': `Você rola para: ${ROLL_LABEL}`,
} as const;

for (const [locale, line] of Object.entries(ROLL_LINES))
  test(`rpg-42a.153: the ${locale} journal and recap word an accepted roll as a roll, not as speech`, () => {
    const turn = (id: string, input: string, narration = 'Reply.') => ({
      id,
      campaignId: CAMPAIGN,
      sceneId: 'scene',
      actionId: id,
      actorId: 'hero',
      input,
      narration,
    });
    const state = {
      campaign: { id: CAMPAIGN, name: CAMPAIGN },
      revision: 2,
      characters: [{ id: 'hero', campaignId: CAMPAIGN, name: 'Wren' }],
      currentScene: undefined,
      turns: [turn('typed', 'I confront the hunter'), turn('rolled', ROLL_LABEL, '')],
      events: [
        {
          id: 'e0',
          campaignId: CAMPAIGN,
          turnId: 'typed',
          causationId: null,
          type: 'CheckOffered',
          payload: { offer: { offerId: 'offer-1', ruleId: 'rule', target: 'hunter', label: ROLL_LABEL } },
        },
        {
          id: 'e1',
          campaignId: CAMPAIGN,
          turnId: 'rolled',
          causationId: null,
          type: 'PlayerActionSubmitted',
          payload: { rollOfferId: 'offer-1' },
        },
      ],
      changes: [{ type: 'CampaignCreated', payload: { name: CAMPAIGN, language: locale } }],
      gmUsage: EMPTY_GM_USAGE_LEDGER,
      folds: EMPTY_LIVE_FOLDS,
    };
    const source = { state, entities: [], relationships: [], eventScopes: [] };
    const journal = renderView('journal', source, undefined, locale);
    assert.ok(journal.includes(line), journal);
    assert.doesNotMatch(journal, new RegExp(`Wren: ${ROLL_LABEL}`));
    const { latest } = panelsOf(source, { scope: 'player' }).recap;
    assert.ok(latest?.includes(line), latest);
    assert.doesNotMatch(latest ?? '', new RegExp(`Wren: ${ROLL_LABEL}`));
  });

test('rpg-asjw.9: the journal lists one short first-sentence line per turn without a model', () => {
  const long = `${'Mist '.repeat(60)}rises. Second sentence stays out.`;
  const turn = (id: string, narration: string) => ({
    id,
    campaignId: CAMPAIGN,
    sceneId: 'scene',
    actionId: id,
    actorId: 'hero',
    input: 'I look',
    narration,
  });
  const state = {
    campaign: { id: CAMPAIGN, name: CAMPAIGN },
    revision: 5,
    characters: [{ id: 'hero', campaignId: CAMPAIGN, name: 'Wren' }],
    currentScene: undefined,
    turns: [
      turn('t1', 'You find a brass key. It is cold.'),
      turn('t2', 'You meet Mara the ferryman. She nods.'),
      turn('t3', long),
      turn('t4', ''),
      turn('t5', 'The gate opens! Nobody stirs.'),
      turn('t6', 'Rain falls\n  on the\nroof. More.'),
      turn('t7', `${'x'.repeat(JOURNAL_LINE_MAX - 2)}😀😀 tail.`),
    ],
    events: [],
    changes: [{ type: 'CampaignCreated', payload: { name: CAMPAIGN, language: 'en' } }],
    gmUsage: EMPTY_GM_USAGE_LEDGER,
    folds: EMPTY_LIVE_FOLDS,
  };
  const source = { state, entities: [], relationships: [], eventScopes: [] };
  const rows = renderView('journal', source, undefined, 'en')
    .split('\n')
    .filter((row) => /^ {2}\d+\. /.test(row));
  assert.equal(rows.length, 7);
  assert.match(rows[0] ?? '', /^ {2}1\. You find a brass key\.$/);
  assert.match(rows[1] ?? '', /^ {2}2\. You meet Mara the ferryman\.$/);
  assert.ok((rows[2] ?? '').length <= 5 + JOURNAL_LINE_MAX, rows[2]);
  assert.doesNotMatch(rows[2] ?? '', /Second sentence/);
  assert.match(rows[3] ?? '', /^ {2}4\. Wren: I look$/);
  assert.match(rows[4] ?? '', /^ {2}5\. The gate opens!$/);
  assert.match(rows[5] ?? '', /^ {2}6\. Rain falls on the roof\.$/);
  assert.ok((rows[6] ?? '').isWellFormed(), rows[6]);
  assert.ok(Array.from(rows[6]?.slice(5) ?? '').length <= JOURNAL_LINE_MAX, rows[6]);
  assert.ok((rows[6] ?? '').endsWith('…'), rows[6]);
});

test('rpg-asjw.14: the journal names people met, things found and outcomes, never GM-only events', () => {
  const turn = (id: string, narration: string) => ({
    id,
    campaignId: CAMPAIGN,
    sceneId: 'scene',
    actionId: id,
    actorId: 'hero',
    input: 'I look',
    narration,
  });
  const proposalTurn = (id: string, parent: string, ref: string) => ({
    ...turn(`${parent}:proposal:${ref}`, ''),
    id,
    input: `GM proposal ${ref}`,
  });
  const event = (id: string, turnId: string, type: string, payload: Record<string, unknown>) => ({
    id,
    campaignId: CAMPAIGN,
    turnId,
    causationId: null,
    type,
    payload,
  });
  const introduced = (id: string, turnId: string, kind: string, name: string) =>
    event(id, turnId, 'EntityIntroduced', { entity: { id: `e-${id}`, kind, name } });
  const state = {
    campaign: { id: CAMPAIGN, name: CAMPAIGN },
    revision: 5,
    characters: [{ id: 'hero', campaignId: CAMPAIGN, name: 'Wren' }],
    currentScene: undefined,
    turns: [
      turn('t1', 'You step inside. Quiet.'),
      proposalTurn('p1', 't1', 'entity:mara'),
      proposalTurn('p2', 't1', 'entity:key'),
      proposalTurn('p3', 't1', 'entity:villain'),
      turn('t2', 'Locks click. Done.'),
      proposalTurn('p4', 't2', 'quest:q'),
      turn('t3', 'Plain walk. Quiet.'),
    ],
    events: [
      introduced('v1', 'p1', 'npc', 'Mara'),
      introduced('v2', 'p2', 'item', 'Brass key'),
      introduced('v3', 'p3', 'npc', 'Secret Villain'),
      introduced('v6', 'p2', 'location', 'Old Farm'),
      event('v4', 't2', 'CheckResolved', { resolution: { events: [{ event: 'check.success' }] } }),
      event('v5', 'p4', 'QuestCompleted', { questId: 'q', outcome: 'ok' }),
    ],
    changes: [{ type: 'CampaignCreated', payload: { name: CAMPAIGN, language: 'en' } }],
    gmUsage: EMPTY_GM_USAGE_LEDGER,
    folds: EMPTY_LIVE_FOLDS,
  };
  const scope = (id: string, visibility: string) => ({ id, visibility, actorId: null });
  const source = {
    state,
    entities: [],
    relationships: [],
    eventScopes: [
      scope('v1', 'player'),
      scope('v2', 'public'),
      scope('v3', 'gm'),
      scope('v4', 'public'),
      scope('v5', 'public'),
      scope('v6', 'public'),
    ],
  };
  const rows = renderView('journal', source as never, undefined, 'en')
    .split('\n')
    .filter((row) => /^ {2}\d+\. /.test(row));
  assert.equal(rows[0], '  1. Met Mara; Found Brass key; Arrived at Old Farm');
  assert.equal(rows[1], '  2. Success: I look, Quest completed');
  assert.equal(rows[2], '  3. Plain walk.');
  assert.doesNotMatch(rows.join('\n'), /Secret Villain/);
});

const journalRowsOf = (
  introduced: readonly string[],
  input = 'I look',
  resolved = 'check.success',
  locale = 'en',
  offered?: string,
) => {
  const ev = (id: string, turnId: string, type: string, payload: Record<string, unknown>) => ({
    id,
    campaignId: CAMPAIGN,
    turnId,
    causationId: null,
    type,
    payload,
  });
  const state = {
    campaign: { id: CAMPAIGN, name: CAMPAIGN },
    revision: 1,
    characters: [{ id: 'hero', campaignId: CAMPAIGN, name: 'Wren' }],
    currentScene: undefined,
    turns: [
      { id: 't1', campaignId: CAMPAIGN, sceneId: 's', actionId: 't1', actorId: 'hero', input, narration: 'Quiet.' },
    ],
    events: [
      ...(offered === undefined
        ? []
        : [ev('o', 'o1', 'CheckOffered', { offer: { offerId: 'of', ruleId: 'r', target: 'x', label: offered } })]),
      ...introduced.map((name, index) =>
        ev(`i${index}`, 't1', 'EntityIntroduced', { entity: { id: `e${index}`, kind: 'place', name } }),
      ),
      ev('r', 't1', 'CheckResolved', { resolution: { events: [{ event: resolved }] } }),
    ],
    changes: [{ type: 'CampaignCreated', payload: { name: CAMPAIGN, language: 'en' } }],
    gmUsage: EMPTY_GM_USAGE_LEDGER,
    folds: EMPTY_LIVE_FOLDS,
  };
  const eventScopes = state.events.map(({ id }) => ({ id, visibility: 'public', actorId: null }));
  const source = { state, entities: [], relationships: [], eventScopes };
  return renderView('journal', source as never, undefined, locale)
    .split('\n')
    .filter((row) => /^ {2,}\S/.test(row) && !row.includes('Journal'));
};

test('rpg-asjw.18: a journal summary wraps whole names and never cuts inside one', () => {
  const names = ['Municipal Archive of Porto Sol', 'Helena Duarte Manor', 'The Old Lighthouse Keeper House'];
  const rows = journalRowsOf(names);
  const text = rows.join(' ');
  for (const name of names) assert.ok(text.includes(name), text);
  assert.doesNotMatch(text, /…/);
  assert.ok(rows.length > 1, text);
  for (const row of rows) assert.ok(Array.from(row.replace(/^ *(\d+\. )?/, '')).length <= JOURNAL_LINE_MAX, row);
});

test('rpg-asjw.18: a name longer than the line max stays whole', () => {
  const name = 'The Extraordinarily Long Named Municipal Archive of the Great Port City of Porto Sol and Beyond';
  assert.ok(journalRowsOf([name]).join(' ').includes(name));
});

test('rpg-asjw.18: hit and miss outcomes name the action', () => {
  assert.ok(journalRowsOf([], 'pick the archive lock')[0]?.endsWith('Success: pick the archive lock'));
  assert.ok(journalRowsOf([], 'pick the archive lock', 'check.failure')[0]?.endsWith('Failure: pick the archive lock'));
  assert.ok(journalRowsOf([], '   ')[0]?.endsWith('Success'));
});

test('rpg-asjw.18: a long action is shortened so every outcome row fits the line max', () => {
  const rows = journalRowsOf([], 'pick the archive lock '.repeat(10));
  for (const row of rows) assert.ok(Array.from(row.replace(/^ *(\d+\. )?/, '')).length <= JOURNAL_LINE_MAX, row);
  assert.ok(rows.join('').includes('…'));
});

test('rpg-asjw.18: a long action fits the line max in pt-BR hit rows', () => {
  const rows = journalRowsOf([], 'pick the archive lock '.repeat(10), 'check.success', 'pt-BR');
  assert.ok(rows.join('').includes('Sucesso: '), rows.join(' '));
  for (const row of rows) assert.ok(Array.from(row.replace(/^ *(\d+\. )?/, '')).length <= JOURNAL_LINE_MAX, row);
});

test('rpg-asjw.18: a reported roll names the offered action, not the number', () => {
  const rows = journalRowsOf([], '15', 'check.success', 'en', 'Climb the wet barn wall');
  assert.ok(rows[0]?.endsWith('Success: climb the wet barn wall'), rows.join(' '));
  assert.ok(journalRowsOf([], '15')[0]?.endsWith('Success: 15'));
});

test('panelsOf lists the applied table notes', () => {
  const state = {
    campaign: { id: CAMPAIGN, name: CAMPAIGN },
    revision: 1,
    characters: [],
    currentScene: undefined,
    turns: [],
    events: [],
    changes: [{ type: OOC_STATE_SAVED, payload: { state: { notes: ['no gore'] } } }],
    gmUsage: EMPTY_GM_USAGE_LEDGER,
    folds: EMPTY_LIVE_FOLDS,
  };
  const source = { state, entities: [], relationships: [], eventScopes: [] };
  assert.deepEqual(panelsOf(source, { scope: 'player' }).tableNotes, ['no gore']);
});
