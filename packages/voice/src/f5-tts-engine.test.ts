import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import {
  createF5Engine,
  createF5Provider,
  F5_ATTRIBUTIONS,
  F5_CAPABILITIES,
  F5_LICENCE,
  F5_MAX_SPEED,
  F5_MEASURED_FIRST_AUDIO_MS,
  F5_MIN_SPEED,
  F5_MODEL_FILES,
  F5_NFE_STEP,
  F5_PROVIDER_ID,
  F5_SERVICE_SOURCE,
  F5_WAIT_NOTE,
  f5Installed,
  f5Manifest,
  f5Paths,
} from './f5-tts-engine.ts';
import { F5_VOICES } from './f5-voices.ts';
import { KOKORO_DELIVERY_SPEED, MLX_KOKORO_PROVIDER_ID } from './kokoro-provider.ts';
import { voicesFor } from './language-voices.ts';
import { fakeFetch, fakeSpawn } from './test-service-fakes.ts';
import type { CommittedUtterance } from './voice.ts';
import { VOICE_CATALOG } from './voice-catalog.ts';

const SENTENCE = 'Quando a porta abriu';
const SPEED = 1;
const MIN_FEMALE = 2;
const MIN_MALE = 2;

const withDir = async (run: (dir: string) => Promise<void>): Promise<void> => {
  const dir = mkdtempSync(join(tmpdir(), 'rpg-f5-'));
  try {
    await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const install = (dir: string, platform?: string): void => {
  const paths = f5Paths(dir, platform);
  mkdirSync(dirname(paths.python), { recursive: true });
  writeFileSync(paths.python, '');
  for (const file of F5_MODEL_FILES) {
    const target = join(paths.modelDir, file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, '');
    truncateSync(target, file.bytes);
  }
};

test('the provider is an optional local pt-BR provider with the named reference voices and speed control only', () => {
  assert.equal(F5_PROVIDER_ID, 'f5-tts');
  assert.deepEqual(F5_CAPABILITIES.languages, ['pt-BR']);
  assert.deepEqual(
    F5_CAPABILITIES.voices,
    F5_VOICES.map((voice) => voice.id),
  );
  assert.equal(F5_CAPABILITIES.emotion, false);
  const provider = createF5Provider({ dir: tmpdir() });
  assert.equal(provider.id, F5_PROVIDER_ID);
  assert.equal(provider.locality, 'local');
  assert.equal(provider.retention, 'none');
  assert.equal(provider.healthy(), false);
});

test('Kokoro stays the default pt-BR voice provider', () => {
  assert.equal(voicesFor('pt-BR', 'mlx')?.providerId, MLX_KOKORO_PROVIDER_ID);
});

test('the male references are different clips', () => {
  const males = F5_VOICES.filter((voice) => voice.gender === 'male');
  assert.equal(new Set(males.map((voice) => voice.member)).size, males.length);
  assert.equal(new Set(males.map((voice) => voice.clip.sha256)).size, males.length);
});

test('there are at least two female and two male voices, each tagged and with a recorded licence and checksum', () => {
  const count = (gender: string) => F5_VOICES.filter((voice) => voice.gender === gender).length;
  assert.ok(count('female') >= MIN_FEMALE);
  assert.ok(count('male') >= MIN_MALE);
  for (const voice of F5_VOICES) {
    const entry = VOICE_CATALOG[voice.id];
    assert.ok(entry, voice.id);
    assert.equal(entry.gender, voice.gender);
    assert.ok(entry.ages.length > 0 && entry.timbre.length > 0);
    assert.match(voice.clip.sha256, /^[0-9a-f]{64}$/);
    assert.ok(voice.clip.bytes > 0 && voice.refText.length > 0);
    assert.equal(voice.licence, 'CC-BY-4.0');
    assert.match(voice.attribution, /FLEURS/);
    assert.match(voice.source, /^https:\/\/huggingface\.co\/datasets\/google\/fleurs\/blob\/[0-9a-f]{40}\//);
    assert.ok(F5_MODEL_FILES.some((file) => file.path === voice.clip.path));
  }
  assert.equal(new Set(F5_VOICES.map((voice) => voice.id)).size, F5_VOICES.length);
});

test('is ready on any platform once the venv and every pinned file are present at their exact size', async () => {
  await withDir(async (dir) => {
    const engine = createF5Engine({ dir });
    assert.equal(engine.ready(), false);
    install(dir);
    assert.equal(f5Installed(dir), true);
    assert.equal(engine.ready(), true);
    const [first] = F5_MODEL_FILES;
    assert.ok(first);
    truncateSync(join(f5Paths(dir).modelDir, first.path), first.bytes - 1);
    assert.equal(engine.ready(), false);
  });
});

test('the venv python lives where each platform puts it', () => {
  assert.equal(f5Paths('/x', 'linux').python, join('/x', 'venv', 'bin', 'python'));
  assert.equal(f5Paths('/x', 'darwin').python, join('/x', 'venv', 'bin', 'python'));
  assert.equal(f5Paths('/x', 'win32').python, join('/x', 'venv', 'Scripts', 'python.exe'));
});

test('sends the sentence, voice and speed to the loopback service, offline', async () => {
  await withDir(async (dir) => {
    const { spawned, spawn } = fakeSpawn();
    const { calls, fetch } = fakeFetch();
    const engine = createF5Engine({ dir, spawn, fetch });
    await engine.load();
    const paths = f5Paths(dir);
    const [{ command, args, options } = assert.fail('not spawned')] = spawned;
    assert.equal(command, paths.python);
    assert.deepEqual(args, ['-I', paths.service, 'serve']);
    assert.equal(options.env?.RPG_F5_MODEL_DIR, paths.modelDir);
    assert.equal(options.env?.RPG_F5_MANIFEST, paths.manifest);
    assert.equal(options.env?.HF_HUB_OFFLINE, '1');
    const [voice] = F5_VOICES;
    assert.ok(voice);
    await engine.synthesize(SENTENCE, voice.id, new AbortController().signal, 1.1);
    assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), { text: SENTENCE, voice: voice.id, speed: 1.1 });
    await engine.synthesize(SENTENCE, voice.id, new AbortController().signal, 9);
    assert.equal(JSON.parse(String(calls[1]?.init.body)).speed, F5_MAX_SPEED);
    await engine.synthesize(SENTENCE, voice.id, new AbortController().signal, Number.NaN);
    assert.equal(JSON.parse(String(calls[2]?.init.body)).speed, SPEED);
    await engine.synthesize(SENTENCE, voice.id, new AbortController().signal, 0.1);
    assert.equal(JSON.parse(String(calls[3]?.init.body)).speed, F5_MIN_SPEED);
    await engine.unload();
  });
});

const utterance = (emotion: string | undefined, voiceId: string): CommittedUtterance => ({
  text: SENTENCE,
  speakerId: 'gm',
  eventId: 'ev-1',
  ...(emotion === undefined ? {} : { delivery: { emotion, intensity: 1 } }),
  profile: {
    id: 'narrator',
    language: 'pt-BR',
    pace: 1,
    style: 'calm',
    pronunciations: {},
    fallbacks: [{ providerId: F5_PROVIDER_ID, voiceId }],
  },
});

test('every delivery emotion maps to a speed in step with the shared delivery vocabulary', async () => {
  await withDir(async (dir) => {
    const { spawn } = fakeSpawn();
    const { calls, fetch } = fakeFetch();
    const provider = createF5Provider({ dir, spawn, fetch, shaping: false });
    const [voice] = F5_VOICES;
    assert.ok(voice);
    const recorded = new Map<string, number>();
    const speeds = (emotion: string): number => recorded.get(emotion) ?? Number.NaN;
    for (const emotion of Object.keys(KOKORO_DELIVERY_SPEED)) {
      const before = calls.length;
      for await (const chunk of provider.synthesize(
        utterance(emotion, voice.id),
        voice.id,
        new AbortController().signal,
      ))
        assert.ok(chunk.audio.length > 0);
      recorded.set(emotion, JSON.parse(String(calls[before]?.init.body)).speed);
      assert.ok(speeds(emotion) >= F5_MIN_SPEED && speeds(emotion) <= F5_MAX_SPEED, emotion);
    }
    assert.equal(speeds('neutral'), SPEED);
    assert.ok(speeds('calm') < speeds('neutral'));
    assert.ok(speeds('whisper') < speeds('calm'));
    assert.ok(speeds('tense') > speeds('neutral'));
    assert.ok(speeds('angry') > speeds('tense'));
    assert.ok(speeds('excited') >= speeds('angry'));
    await provider.dispose();
  });
});

test('the service script binds loopback and reads its pins from the manifest', () => {
  const source = readFileSync(F5_SERVICE_SOURCE, 'utf8');
  assert.ok(source.includes('HOST = "127.0.0.1"'));
  assert.ok(source.includes(`MIN_SPEED = ${F5_MIN_SPEED}`));
  assert.ok(source.includes(`MAX_SPEED = ${F5_MAX_SPEED}`));
});

test('the slower option shows its measured wait and the manifest passes the step count to the service', () => {
  assert.match(F5_WAIT_NOTE, /^Slower, more expressive voice\./);
  assert.ok(F5_WAIT_NOTE.includes(`${Math.round(F5_MEASURED_FIRST_AUDIO_MS.cpu / 1000)} seconds`));
  assert.equal(f5Manifest().model.nfeStep, F5_NFE_STEP);
});

test('the attributions name the model licence, the vocoder and every voice with its source', () => {
  const credits = F5_ATTRIBUTIONS.join('\n');
  assert.ok(credits.includes(F5_LICENCE));
  assert.ok(credits.includes('charactr/vocos-mel-24khz'));
  for (const voice of F5_VOICES) assert.ok(credits.includes(voice.source), voice.id);
});
