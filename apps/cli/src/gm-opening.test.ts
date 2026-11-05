import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';
import { PROTOCOL_VERSION } from '../../../packages/client-protocol/src/protocol.ts';
import { CONTEXT_BUDGETS, type ContextPacket, packetParts } from '../../../packages/memory/src/packet.ts';
import { openDatabase } from '../../../packages/persistence/src/database.ts';
import {
  createCampaignFrom,
  createEngineGateway,
  FAKE_GAME_MASTER,
  type GameMaster,
  readCampaignState,
} from './engine-gateway.ts';
import { SYSTEM_PROMPT } from './gm-api.ts';

const PITCH = 'a short fantasy adventure in a drowned chapel';
const FANTASY_PITCH = 'a fantasy adventure in a drowned chapel';
const TITLE = 'a short fantasy adventure';
const CHAPEL = 'The Drowned Chapel';
const OPENING_NARRATION = 'Water laps at the pews of the drowned chapel. A sexton named Orrin waves you in.';
const PLAYER_NAME = 'Ashfall';
const NO_CHARACTER = async () => undefined;
const GENERIC_NOTICE = 'opening is generic';
const MAX_NAME = 40;

const fileOf = (dataDir: string, name: string) => join(dataDir, `${encodeURIComponent(name)}.sqlite`);

const tempDataDir = (t: TestContext) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'rpg-opening-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  return dataDir;
};

const scriptedGm = (packets: ContextPacket[] = []): GameMaster => ({
  request: async (packet) => {
    packets.push(packet);
    return {
      narration: OPENING_NARRATION,
      segments: [{ text: OPENING_NARRATION }],
      proposals: [
        { kind: 'entity', id: 'drowned-chapel', entityKind: 'location', name: CHAPEL, visibility: 'player' },
        { kind: 'entity', id: 'orrin', entityKind: 'npc', name: 'Orrin', facts: ['The sexton.'], visibility: 'player' },
      ],
    };
  },
  summarizer: FAKE_GAME_MASTER.summarizer,
});

const run = async (dataDir: string, gm: GameMaster, name: string, intent?: string) => {
  const out: string[] = [];
  for await (const text of createEngineGateway(dataDir, gm).create(name, intent, NO_CHARACTER)) out.push(text);
  return out.join('\n');
};

const entityNames = (dataDir: string, name: string) => {
  const connection = openDatabase(fileOf(dataDir, name));
  try {
    return connection.database
      .prepare('SELECT name FROM entity ORDER BY name')
      .all()
      .map((row) => String(row.name));
  } finally {
    connection.close();
  }
};

describe('rpg-42a.46 pitch opening', () => {
  it('opens from the GM with committed entities and a short unique name', async (t) => {
    const dataDir = tempDataDir(t);
    const packets: ContextPacket[] = [];
    const out = await run(dataDir, scriptedGm(packets), PITCH);
    assert.ok(!existsSync(fileOf(dataDir, PITCH)));
    assert.ok(existsSync(fileOf(dataDir, TITLE)));
    assert.ok(TITLE.length <= MAX_NAME);
    assert.match(out, new RegExp(`Campaign: ${TITLE}`));
    assert.match(out, /drowned chapel/);
    assert.ok(!/Crossroads/.test(out));
    assert.ok(!out.includes(GENERIC_NOTICE));
    const { currentScene } = readCampaignState(dataDir, TITLE);
    assert.equal(currentScene?.title, CHAPEL);
    const names = entityNames(dataDir, TITLE);
    assert.ok(names.includes('Orrin') && names.includes(CHAPEL));
    const sent = JSON.stringify(packets[0]?.sections);
    assert.ok(sent.includes(PITCH));
    assert.ok(sent.includes('fantasy'));
    assert.ok(packetParts(packets[0] ?? { sections: [] }).instructions.length > 0);
    assert.ok(packets[0]?.budget === CONTEXT_BUDGETS.compact);
    await run(dataDir, scriptedGm(), PITCH);
    assert.ok(existsSync(fileOf(dataDir, `${TITLE} 2`)));
  });

  it('rpg-cm63.41 persists the GM location kind and mood tags on the opening scene', async (t) => {
    const dataDir = tempDataDir(t);
    const tagged: GameMaster = {
      ...scriptedGm(),
      request: async () => ({
        narration: OPENING_NARRATION,
        segments: [{ text: OPENING_NARRATION }],
        proposals: [
          {
            kind: 'entity',
            id: 'drowned-chapel',
            entityKind: 'location',
            name: CHAPEL,
            locationKind: 'ruins',
            mood: ['tense', 'rain'],
            visibility: 'player',
          },
        ],
      }),
    };
    await run(dataDir, tagged, PITCH);
    const { currentScene } = readCampaignState(dataDir, TITLE);
    assert.equal(currentScene?.locationKind, 'ruins');
    assert.deepEqual(currentScene?.moodTags, ['tense', 'rain']);
  });

  it('rpg-cm63.41 leaves the tags off a scene the GM did not tag', async (t) => {
    const dataDir = tempDataDir(t);
    await run(dataDir, scriptedGm(), PITCH);
    const { currentScene } = readCampaignState(dataDir, TITLE);
    assert.equal(currentScene?.locationKind, undefined);
    assert.equal(currentScene?.moodTags, undefined);
  });

  it('stores the full pitch as campaign data', async (t) => {
    const dataDir = tempDataDir(t);
    await run(dataDir, scriptedGm(), PITCH);
    const connection = openDatabase(fileOf(dataDir, TITLE));
    const facts = connection.database.prepare('SELECT statement FROM fact').all();
    connection.close();
    assert.ok(facts.some((row) => String(row.statement).includes(PITCH)));
  });

  it('keeps an explicit name and uses the generic opening with the fake GM', async (t) => {
    const dataDir = tempDataDir(t);
    const out = await run(dataDir, FAKE_GAME_MASTER, PLAYER_NAME, FANTASY_PITCH);
    assert.ok(existsSync(fileOf(dataDir, PLAYER_NAME)));
    assert.match(out, /opening is generic/);
    assert.match(out, /Fantasy/);
  });

  it('tells the GM to answer the stranger and name characters', () => {
    assert.match(SYSTEM_PROMPT, /answers? .*question/i);
    assert.match(SYSTEM_PROMPT, /name/i);
  });

  it('guided start creates the campaign from a scripted GM and a pitch', async (t) => {
    const dataDir = tempDataDir(t);
    const command = {
      version: PROTOCOL_VERSION,
      type: 'CreateCampaign',
      name: PLAYER_NAME,
      intent: FANTASY_PITCH,
    } as const;
    const summary = await createCampaignFrom(dataDir, command, undefined, scriptedGm());
    assert.equal(summary.name, PLAYER_NAME);
    assert.ok(entityNames(dataDir, PLAYER_NAME).includes('Orrin'));
  });
});
