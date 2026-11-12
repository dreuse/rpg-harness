import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { createEngine } from '../../../packages/engine/src/engine.ts';
import {
  MAX_RULES_DOCUMENT_CHARS,
  MAX_RULES_DOCUMENTS,
  rulesDocumentsOf,
  settingDocumentsOf,
} from '../../../packages/engine/src/own-rules.ts';
import { MAX_NAME_LENGTH } from '../../../packages/mcp/src/tools.ts';
import { summariesOf } from '../../../packages/memory/src/history.ts';
import { createCampaignStore } from '../../../packages/persistence/src/campaign-store.ts';
import { openDatabase } from '../../../packages/persistence/src/database.ts';
import { listScopedEvents } from '../../../packages/persistence/src/event-store.ts';
import { importCampaign } from './campaign-import.ts';

const CAMPAIGN_NAME = 'Ola Mundo';
const DATABASE_FILE = `${encodeURIComponent(CAMPAIGN_NAME)}.sqlite`;
const RULES_FILE = 'rules-01.md';
const SETTING_FILE = 'character.md';
const RULES_TEXT = '# Magias\nMagias de primeiro circulo custam um ponto.';
const SETTING_TEXT = '# Ash\nHP 12 of 12.';
const MANIFEST = {
  language: 'pt-BR',
  hero: 'Ash',
  scene: 'O Farol',
  situation: 'Ash chega ao farol.',
  storySoFar: 'Ash fugiu da cidade.',
  rules: [RULES_FILE],
  setting: [SETTING_FILE],
};

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const sandbox = (manifest: unknown = MANIFEST, databaseFile = DATABASE_FILE) => {
  const root = mkdtempSync(join(tmpdir(), 'rpg-import-'));
  directories.push(root);
  const folder = join(root, 'rpg-import');
  mkdirSync(folder);
  writeFileSync(join(folder, RULES_FILE), RULES_TEXT);
  writeFileSync(join(folder, SETTING_FILE), SETTING_TEXT);
  if (manifest !== undefined) writeFileSync(join(folder, 'campaign.json'), JSON.stringify(manifest));
  const path = join(root, databaseFile);
  const { database } = openDatabase(path);
  const store = createCampaignStore(database);
  const engine = createEngine(store);
  return {
    root,
    folder,
    database,
    engine,
    run: (target = folder) => importCampaign(engine, store, path, target),
    events: (id: string) => listScopedEvents(database, id),
  };
};

test('imports rules, setting and the story so far into a campaign named after the database file', () => {
  const { engine, run, events } = sandbox();
  const id = run();
  assert.deepEqual(engine.listCampaigns(), [{ id, name: CAMPAIGN_NAME }]);
  const state = engine.getState(id);
  assert.equal(state.currentScene?.title, MANIFEST.scene);
  assert.equal(state.characters[0]?.name, MANIFEST.hero);
  assert.equal(state.turns[0]?.narration, MANIFEST.situation);
  assert.deepEqual(
    rulesDocumentsOf(events(id)).map(({ name }) => name),
    [RULES_FILE],
  );
  assert.deepEqual(
    settingDocumentsOf(events(id)).map(({ name }) => name),
    [SETTING_FILE],
  );
  const [written] = summariesOf(events(id));
  assert.equal(written?.level, 'campaign');
  assert.equal(written?.scopeId, id);
  assert.equal(written?.summary.text, MANIFEST.storySoFar);
  assert.equal(written?.summary.visibility, 'player');
  assert.equal(written?.summary.actorId, null);
});

test('names the campaign after a database file that is not URI encoded, cut to the name limit', () => {
  const percent = sandbox(MANIFEST, '50%.sqlite');
  assert.equal(percent.engine.getCampaign(percent.run()).name, '50%');
  const long = sandbox(MANIFEST, `${'a'.repeat(MAX_NAME_LENGTH + 1)}.sqlite`);
  assert.equal(long.engine.getCampaign(long.run()).name, 'a'.repeat(MAX_NAME_LENGTH));
});

test('refuses a database that already holds a campaign', () => {
  const { engine, run } = sandbox();
  engine.createCampaign('Existing');
  assert.throws(run, /already/);
  assert.equal(engine.listCampaigns().length, 1);
});

test('refuses a relative folder', () => {
  const { engine, run } = sandbox();
  assert.throws(() => run('rpg-import'), /absolute/);
  assert.deepEqual(engine.listCampaigns(), []);
});

const refused: [string, (folder: string) => void, RegExp][] = [
  [
    'a path that escapes the folder',
    (folder) => writeFileSync(join(folder, 'campaign.json'), JSON.stringify({ ...MANIFEST, rules: ['../outside.md'] })),
    /rules/,
  ],
  [
    'a symlink that leaves the folder',
    (folder) => {
      writeFileSync(join(folder, '..', 'secret.md'), '# Secret');
      symlinkSync(join(folder, '..', 'secret.md'), join(folder, 'link.md'));
      writeFileSync(join(folder, 'campaign.json'), JSON.stringify({ ...MANIFEST, rules: ['link.md'] }));
    },
    /outside/,
  ],
  [
    'a binary file',
    (folder) => writeFileSync(join(folder, RULES_FILE), Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0x01])),
    /text|binary/,
  ],
  [
    'a pdf file',
    (folder) => {
      writeFileSync(join(folder, 'rules.pdf'), '%PDF-1.4');
      writeFileSync(join(folder, 'campaign.json'), JSON.stringify({ ...MANIFEST, rules: ['rules.pdf'] }));
    },
    /not supported/,
  ],
  [
    'a document over the character cap',
    (folder) => writeFileSync(join(folder, RULES_FILE), 'a'.repeat(MAX_RULES_DOCUMENT_CHARS + 1)),
    /longer than/,
  ],
  ['a blank document', (folder) => writeFileSync(join(folder, RULES_FILE), '   \n'), /not a valid/],
  [
    'more files than the document cap',
    (folder) => {
      const names = Array.from({ length: MAX_RULES_DOCUMENTS + 1 }, (_, index) => `extra-${index}.md`);
      for (const name of names) writeFileSync(join(folder, name), '# Extra');
      writeFileSync(join(folder, 'campaign.json'), JSON.stringify({ ...MANIFEST, rules: names }));
    },
    /at most/,
  ],
  ['a missing manifest', (folder) => rmSync(join(folder, 'campaign.json')), /ENOENT/],
  ['a manifest that is not json', (folder) => writeFileSync(join(folder, 'campaign.json'), '{'), /JSON/],
  ['a manifest that is not an object', (folder) => writeFileSync(join(folder, 'campaign.json'), '[]'), /object/],
  ...(['hero', 'scene', 'situation', 'storySoFar'] as const).flatMap((field) => [
    [
      `a missing ${field}`,
      (folder: string) => {
        const { [field]: _omitted, ...rest } = MANIFEST;
        writeFileSync(join(folder, 'campaign.json'), JSON.stringify(rest));
      },
      new RegExp(field),
    ] as [string, (folder: string) => void, RegExp],
    [
      `a blank ${field}`,
      (folder: string) => writeFileSync(join(folder, 'campaign.json'), JSON.stringify({ ...MANIFEST, [field]: '  ' })),
      new RegExp(field),
    ] as [string, (folder: string) => void, RegExp],
  ]),
  [
    'a hero name that is too long',
    (folder) => writeFileSync(join(folder, 'campaign.json'), JSON.stringify({ ...MANIFEST, hero: 'h'.repeat(121) })),
    /hero/,
  ],
  [
    'an unknown language',
    (folder) => writeFileSync(join(folder, 'campaign.json'), JSON.stringify({ ...MANIFEST, language: 'xx' })),
    /language/,
  ],
  [
    'a file list that is not a list of names',
    (folder) => writeFileSync(join(folder, 'campaign.json'), JSON.stringify({ ...MANIFEST, setting: 'character.md' })),
    /setting/,
  ],
  [
    'a file name with a folder in it',
    (folder) => writeFileSync(join(folder, 'campaign.json'), JSON.stringify({ ...MANIFEST, rules: ['a/b.md'] })),
    /rules/,
  ],
];

for (const [label, arrange, message] of refused) {
  test(`refuses ${label} and leaves no campaign behind`, () => {
    const { engine, folder, run } = sandbox();
    arrange(folder);
    assert.throws(run, message);
    assert.deepEqual(engine.listCampaigns(), []);
  });
}
