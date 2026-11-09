import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { createEngineGateway, gameMasterFor } from './engine-gateway.ts';
import { CLAUDE_BIN_ENV } from './gm-api.ts';
import { hermeticGmEnv } from './gm-test-env.ts';
import { CLI_LOCALES, errorText, say } from './messages.ts';
import { soundRequestOf } from './sound-command.ts';

const BIN = join(import.meta.dirname, 'bin.ts');
const PORTUGUESE = 'pt-BR';
const ENGLISH = 'en';
const MISSING_PATH = join(tmpdir(), 'rpg-localized-errors-missing', 'nested', 'file.rpg');
const CLOSED_RELEASES_URL = 'http://127.0.0.1:9/releases';
const RAW_ERRORS = /ENOENT|Unknown option|Volume must/;

const dataDirOf = (t: TestContext) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'rpg-localized-errors-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  return dataDir;
};

const rpg = (dataDir: string, locale: string, args: readonly string[], env: NodeJS.ProcessEnv = {}) =>
  spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    env: { ...hermeticGmEnv(), RPG_DATA_DIR: dataDir, RPG_LANG: locale, ...env },
  });

test('the Claude Code game master notice speaks the locale', async () => {
  const env = { ...hermeticGmEnv(), [CLAUDE_BIN_ENV]: process.execPath };
  const portuguese = await gameMasterFor(env, PORTUGUESE);
  assert.equal(portuguese.gm.notice, say(PORTUGUESE, 'gm.notice.claudeCode'));
  assert.match(portuguese.gm.notice ?? '', /Claude Code neste computador/);
  const english = await gameMasterFor(env, ENGLISH);
  assert.equal(english.gm.notice, 'The game master is Claude Code on this computer.');
});

test('a volume out of range is reported in the locale', () => {
  assert.equal(soundRequestOf({ 'ambience-volume': '2' }, PORTUGUESE), say(PORTUGUESE, 'sound.invalidVolume'));
  assert.match(String(soundRequestOf({ 'ambience-volume': '2' }, PORTUGUESE)), /Volume deve ser/);
  assert.equal(soundRequestOf({ 'ambience-volume': '2' }, ENGLISH), 'Volume must be a number from 0 to 1.');
});

test('an unknown option is reported in the locale', (t) => {
  const portuguese = rpg(dataDirOf(t), PORTUGUESE, ['sound', '--bogus']);
  assert.equal(portuguese.status, 2);
  assert.match(portuguese.stderr, /Opção desconhecida: --bogus/);
  assert.doesNotMatch(portuguese.stderr, RAW_ERRORS);
  const english = rpg(dataDirOf(t), ENGLISH, ['sound', '--bogus']);
  assert.match(english.stderr, /Unknown option: --bogus/);
});

test('exporting to a missing folder is reported in the locale', (t) => {
  const dataDir = dataDirOf(t);
  assert.equal(rpg(dataDir, ENGLISH, ['new', 'Ember']).status, 0);
  const portuguese = rpg(dataDir, PORTUGUESE, ['export', 'Ember', MISSING_PATH]);
  assert.equal(portuguese.status, 1);
  assert.match(portuguese.stderr, /A pasta de destino não existe/);
  assert.doesNotMatch(portuguese.stderr, RAW_ERRORS);
  assert.match(
    rpg(dataDir, ENGLISH, ['export', 'Ember', MISSING_PATH]).stderr,
    /The destination folder does not exist/,
  );
});

test('restoring a missing file is reported in the locale', (t) => {
  const dataDir = dataDirOf(t);
  const portuguese = rpg(dataDir, PORTUGUESE, ['restore', MISSING_PATH]);
  assert.equal(portuguese.status, 1);
  assert.match(portuguese.stderr, /O arquivo não foi encontrado/);
  assert.doesNotMatch(portuguese.stderr, RAW_ERRORS);
  assert.match(rpg(dataDir, ENGLISH, ['restore', MISSING_PATH]).stderr, /The file was not found/);
});

test('help placeholders speak the locale', (t) => {
  const portuguese = rpg(dataDirOf(t), PORTUGUESE, ['help']).stdout;
  assert.match(portuguese, /play <campanha>/);
  assert.match(portuguese, /new <nome\|premissa>/);
  assert.doesNotMatch(portuguese, /<campaign>|<name\|pitch>/);
  const english = rpg(dataDirOf(t), ENGLISH, ['help']).stdout;
  assert.match(english, /play <campaign>/);
  assert.match(english, /new <name\|pitch>/);
});

test('the sound hint names the rpg command', () => {
  for (const locale of CLI_LOCALES) assert.match(say(locale, 'sound.installedNo'), /rpg sound --download/);
});

test('update --check says why it cannot check and exits non-zero', (t) => {
  const env = { RPG_RELEASES_URL: CLOSED_RELEASES_URL };
  const portuguese = rpg(dataDirOf(t), PORTUGUESE, ['update', '--check'], env);
  assert.equal(portuguese.status, 1);
  assert.match(portuguese.stderr, /Não foi possível verificar atualizações/);
  const english = rpg(dataDirOf(t), ENGLISH, ['update', '--check'], env);
  assert.equal(english.status, 1);
  assert.match(english.stderr, /Could not check for updates/);
});

test('a gateway restore error carries the locale text', async (t) => {
  const dataDir = dataDirOf(t);
  const { gm } = await gameMasterFor(hermeticGmEnv());
  const gateway = createEngineGateway(dataDir, gm);
  assert.throws(
    () => gateway.restore(MISSING_PATH, PORTUGUESE),
    (error) => /O arquivo não foi encontrado/.test(errorText(PORTUGUESE, error)),
  );
});
