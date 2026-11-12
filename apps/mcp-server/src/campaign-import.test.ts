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
const SECOND_NAME = 'Outra Campanha';
const RULES_FILE = 'rules-01.md';
const SETTING_FILE = 'character.md';
const RULES_TEXT = '# Magias\nMagias de primeiro circulo custam um ponto.';
const SETTING_TEXT = '# Ash\nHP 12 of 12.';
const MANIFEST = {
  name: CAMPAIGN_NAME,
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

const sandbox = (manifest: unknown = MANIFEST) => {
  const root = mkdtempSync(join(tmpdir(), 'rpg-import-'));
  directories.push(root);
  const folder = join(root, 'rpg-import');
  mkdirSync(folder);
  writeFileSync(join(folder, RULES_FILE), RULES_TEXT);
  writeFileSync(join(folder, SETTING_FILE), SETTING_TEXT);
  if (manifest !== undefined) writeFileSync(join(folder, 'campaign.json'), JSON.stringify(manifest));
  const path = join(root, 'campaigns.sqlite');
  const { database } = openDatabase(path);
  const store = createCampaignStore(database);
  const engine = createEngine(store);
  return {
    root,
    folder,
    database,
    engine,
    run: (target = folder) => importCampaign(engine, store, target),
    events: (id: string) => listScopedEvents(database, id),
  };
};

test('imports rules, setting and the story so far into a campaign named in the manifest', () => {
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

test('imports a second campaign next to the first and keeps their documents apart', () => {
  const { engine, folder, run, events } = sandbox();
  const first = run();
  writeFileSync(join(folder, 'campaign.json'), JSON.stringify({ ...MANIFEST, name: SECOND_NAME, rules: [] }));
  const second = run();
  assert.deepEqual(engine.listCampaigns(), [
    { id: first, name: CAMPAIGN_NAME },
    { id: second, name: SECOND_NAME },
  ]);
  assert.deepEqual(
    rulesDocumentsOf(events(first)).map(({ name }) => name),
    [RULES_FILE],
  );
  assert.deepEqual(rulesDocumentsOf(events(second)), []);
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
  ...(['name', 'hero', 'scene', 'situation', 'storySoFar'] as const).flatMap((field) => [
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
    'a campaign name that is too long',
    (folder) =>
      writeFileSync(
        join(folder, 'campaign.json'),
        JSON.stringify({ ...MANIFEST, name: 'n'.repeat(MAX_NAME_LENGTH + 1) }),
      ),
    /name/,
  ],
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
