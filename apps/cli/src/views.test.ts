import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { PROTOCOL_VERSION } from '../../../packages/client-protocol/src/protocol.ts';
import type { Visibility } from '../../../packages/domain/src/entity.ts';
import { CHARACTER_CREATED, commitCharacter } from '../../../packages/engine/src/character.ts';
import { createEngine } from '../../../packages/engine/src/engine.ts';
import { CHECK_RESOLVED, openScene } from '../../../packages/engine/src/turn.ts';
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
import { createEngineGateway, FAKE_GAME_MASTER, openClientSession, readCampaignState } from './engine-gateway.ts';
import { main } from './main.ts';
import { editableSheet, printable, renderView, sheetComponents } from './views.ts';

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
    for (const output of [played, resumed, journal]) {
      assert.match(output, /I wave\[2J\]0;pwn31m back/);
      assert.doesNotMatch(output.replaceAll('\n', ''), UNSAFE);
    }
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
