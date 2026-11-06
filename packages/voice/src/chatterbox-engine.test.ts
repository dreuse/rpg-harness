import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import {
  CHATTERBOX_CAPABILITIES,
  CHATTERBOX_DELIVERY_EXPRESSION,
  CHATTERBOX_MODEL_FILES,
  CHATTERBOX_MODEL_REVISION,
  CHATTERBOX_PROVIDER_ID,
  CHATTERBOX_SERVICE_SOURCE,
  CHATTERBOX_VOICE,
  chatterboxExpression,
  chatterboxInstalled,
  chatterboxPaths,
  createChatterboxEngine,
  createChatterboxProvider,
  MAX_EXAGGERATION,
  MIN_EXAGGERATION,
} from './chatterbox-engine.ts';
import { KOKORO_DELIVERY_SPEED, MLX_KOKORO_PROVIDER_ID } from './kokoro-provider.ts';
import { voicesFor } from './language-voices.ts';
import { fakeFetch, fakeSpawn } from './test-service-fakes.ts';

const SENTENCE = 'Quando a porta abriu,';
const NEUTRAL_EXAGGERATION = 0.5;
const NEUTRAL_CFG = 0.5;
const SPEED = 1;

const withDir = async (run: (dir: string) => Promise<void>): Promise<void> => {
  const dir = mkdtempSync(join(tmpdir(), 'rpg-chatterbox-'));
  try {
    await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const install = (dir: string): void => {
  const paths = chatterboxPaths(dir);
  mkdirSync(dirname(paths.python), { recursive: true });
  writeFileSync(paths.python, '');
  mkdirSync(paths.modelDir, { recursive: true });
  for (const file of CHATTERBOX_MODEL_FILES) {
    writeFileSync(join(paths.modelDir, file.path), '');
    truncateSync(join(paths.modelDir, file.path), file.bytes);
  }
};

test('the provider is an optional local pt-BR provider with one default voice and emotion control', () => {
  assert.equal(CHATTERBOX_PROVIDER_ID, 'chatterbox');
  assert.deepEqual(CHATTERBOX_CAPABILITIES.languages, ['pt-BR']);
  assert.deepEqual(CHATTERBOX_CAPABILITIES.voices, [CHATTERBOX_VOICE]);
  assert.equal(CHATTERBOX_CAPABILITIES.emotion, true);
  const provider = createChatterboxProvider({ dir: tmpdir(), platform: 'linux' });
  assert.equal(provider.id, CHATTERBOX_PROVIDER_ID);
  assert.equal(provider.locality, 'local');
  assert.equal(provider.retention, 'none');
  assert.equal(provider.healthy(), false);
});

test('Kokoro stays the default pt-BR voice provider', () => {
  assert.equal(voicesFor('pt-BR', 'mlx')?.providerId, MLX_KOKORO_PROVIDER_ID);
});

test('is ready on any platform with the venv and every pinned model file at its exact size', async () => {
  await withDir(async (dir) => {
    const engine = createChatterboxEngine({ dir, platform: 'darwin' });
    assert.equal(engine.ready(), false);
    install(dir);
    assert.equal(chatterboxInstalled(dir), true);
    assert.equal(engine.ready(), true);
    assert.equal(createChatterboxEngine({ dir, platform: 'linux' }).ready(), true);
    const [first] = CHATTERBOX_MODEL_FILES;
    assert.ok(first);
    truncateSync(join(chatterboxPaths(dir).modelDir, first.path), first.bytes - 1);
    assert.equal(engine.ready(), false);
  });
});

test('sends the sentence with the delivery expression and no speed to the loopback service', async () => {
  await withDir(async (dir) => {
    const { spawned, spawn } = fakeSpawn();
    const { calls, fetch } = fakeFetch();
    const engine = createChatterboxEngine({ dir, spawn, fetch });
    await engine.load();
    const paths = chatterboxPaths(dir);
    const [{ command, args, options } = assert.fail('not spawned')] = spawned;
    assert.equal(command, paths.python);
    assert.deepEqual(args, ['-I', paths.service, 'serve']);
    assert.equal(options.env?.RPG_CHATTERBOX_MODEL_DIR, paths.modelDir);
    assert.equal(options.env?.HF_HUB_OFFLINE, '1');
    await engine.synthesize(SENTENCE, CHATTERBOX_VOICE, new AbortController().signal, SPEED, undefined, {
      emotion: 'angry',
      intensity: 1,
    });
    const body = JSON.parse(String(calls[0]?.init.body));
    assert.deepEqual(body, {
      text: SENTENCE,
      voice: CHATTERBOX_VOICE,
      ...chatterboxExpression({ emotion: 'angry', intensity: 1 }),
    });
    await engine.unload();
  });
});

test('a neutral or missing delivery uses the Chatterbox defaults', () => {
  for (const delivery of [undefined, {}, { emotion: 'neutral' }, { emotion: 'smug' }, { emotion: 'toString' }]) {
    assert.deepEqual(chatterboxExpression(delivery), { exaggeration: NEUTRAL_EXAGGERATION, cfg_weight: NEUTRAL_CFG });
  }
});

test('every delivery emotion has an expression and zero intensity means neutral', () => {
  assert.deepEqual(Object.keys(CHATTERBOX_DELIVERY_EXPRESSION).sort(), Object.keys(KOKORO_DELIVERY_SPEED).sort());
  for (const emotion of Object.keys(CHATTERBOX_DELIVERY_EXPRESSION)) {
    assert.deepEqual(chatterboxExpression({ emotion, intensity: 0 }), {
      exaggeration: NEUTRAL_EXAGGERATION,
      cfg_weight: NEUTRAL_CFG,
    });
    const { exaggeration, cfg_weight } = chatterboxExpression({ emotion });
    assert.ok(exaggeration >= MIN_EXAGGERATION && exaggeration <= MAX_EXAGGERATION, emotion);
    assert.ok(cfg_weight >= 0 && cfg_weight <= 1, emotion);
  }
});

test('angry and excited raise exaggeration, tense raises it less, whisper and calm lower it', () => {
  const exaggeration = (emotion: string) => chatterboxExpression({ emotion }).exaggeration;
  assert.ok(exaggeration('angry') > exaggeration('tense'));
  assert.ok(exaggeration('tense') > NEUTRAL_EXAGGERATION);
  assert.ok(exaggeration('excited') > NEUTRAL_EXAGGERATION);
  assert.ok(exaggeration('calm') < NEUTRAL_EXAGGERATION);
  assert.ok(exaggeration('whisper') < exaggeration('calm'));
  assert.ok(chatterboxExpression({ emotion: 'angry' }).cfg_weight < NEUTRAL_CFG);
  const half = chatterboxExpression({ emotion: 'angry', intensity: 0.5 }).exaggeration;
  assert.ok(half > NEUTRAL_EXAGGERATION && half < exaggeration('angry'));
});

test('the service script binds loopback, pins the model revision and every file path', () => {
  const source = readFileSync(CHATTERBOX_SERVICE_SOURCE, 'utf8');
  assert.ok(source.includes('HOST = "127.0.0.1"'));
  assert.ok(source.includes(`REVISION = "${CHATTERBOX_MODEL_REVISION}"`));
  assert.ok(source.includes(`VOICES = {"${CHATTERBOX_VOICE}"}`));
  for (const file of CHATTERBOX_MODEL_FILES) assert.ok(source.includes(`"${file.path}"`), file.path);
});

test('the venv python lives under Scripts on Windows', () => {
  assert.equal(chatterboxPaths('/x', 'win32').python, join('/x', 'venv', 'Scripts', 'python.exe'));
  assert.equal(chatterboxPaths('/x', 'linux').python, join('/x', 'venv', 'bin', 'python'));
});
