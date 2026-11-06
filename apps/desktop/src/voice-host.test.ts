import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { audioCacheKey } from '../../../packages/voice/src/audio-budget.ts';
import { createFileAudioCache } from '../../../packages/voice/src/audio-cache-store.ts';
import {
  KOKORO_PT_BR_MODEL_OFFER,
  type ModelConsent,
  type ModelManager,
} from '../../../packages/voice/src/kokoro-model.ts';
import {
  createKokoroProvider,
  KOKORO_CAPABILITIES,
  KOKORO_MIME_TYPE,
  KOKORO_ONNX_PROVIDER_ID,
  KOKORO_PROVIDER_ID,
  MLX_KOKORO_CAPABILITIES,
  MLX_KOKORO_PROVIDER_ID,
} from '../../../packages/voice/src/kokoro-provider.ts';
import {
  chatterboxProviders,
  createVoiceHost,
  f5Providers,
  fakeVoiceProviders,
  type HostedProvider,
  MAX_EMOTION_CHARS,
  MAX_PRONUNCIATION_CHARS,
  MAX_PRONUNCIATIONS,
  MAX_SPEECH_CHARS,
  MAX_STYLE_CHARS,
  mlxAudioProviders,
  onnxProviders,
  PREVIEW_LINES,
  voiceProviders,
} from './voice-host.ts';

const OFFER = { source: 'https://models.example/kokoro', bytes: 10, sizeMiB: 0 };
const NARRATOR = 'af_heart';
const AUDIO = new Uint8Array([1, 2, 3]);
const PREVIEW_PIECES = 3;
const STEP_MS = 7;
const CACHE_DIR_PREFIX = 'rpg-voice-host-';

let cacheDir = '';
beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), CACHE_DIR_PREFIX));
});
afterEach(() => rmSync(cacheDir, { recursive: true, force: true }));

const MIB = 1024 * 1024;
const BIG_OFFER = { source: 'https://models.example/kokoro', bytes: 3 * MIB, sizeMiB: 3 };

type ModelOptions = {
  readonly offer?: typeof OFFER;
  readonly steps?: readonly number[];
  readonly gate?: Promise<void>;
};

const fakeModel = (installed = false, { offer = OFFER, steps = [offer.bytes], gate }: ModelOptions = {}) => {
  const calls: string[] = [];
  let present = installed;
  const model: ModelManager = {
    offer,
    status: async () => ({ installed: present, bytes: present ? offer.bytes : 0 }),
    download: async (_consent, _signal, onProgress) => {
      calls.push('download');
      await gate;
      for (const bytes of steps) onProgress?.(bytes);
      present = true;
    },
    remove: async () => {
      calls.push('remove');
      present = false;
    },
  };
  return { model, calls };
};

const setup = (installed = false, modelOptions: ModelOptions = {}) => {
  const spoken: string[] = [];
  const speeds: number[] = [];
  const { model, calls } = fakeModel(installed, modelOptions);
  let unloaded = 0;
  const provider = createKokoroProvider({
    engine: {
      ready: () => true,
      load: async () => {},
      synthesize: async (sentence, _voiceId, _signal, speed) => {
        spoken.push(sentence);
        speeds.push(speed);
        return AUDIO;
      },
      unload: async () => {
        unloaded += 1;
      },
    },
  });
  const hosted: HostedProvider = {
    id: KOKORO_PROVIDER_ID,
    capabilities: KOKORO_CAPABILITIES,
    narrator: NARRATOR,
    model,
    provider,
  };
  let clock = 0;
  const host = createVoiceHost({ providers: [hosted], cacheDir, now: () => (clock += STEP_MS) });
  return { host, spoken, speeds, calls, unloaded: () => unloaded };
};

const consent: ModelConsent = { accepted: true, ...OFFER };
const PREVIEW = { providerId: KOKORO_PROVIDER_ID, voiceId: NARRATOR, language: 'en', speed: 1 };

test('rpg-cm63.7 voice host reports each local provider with its model offer and install state', async () => {
  const { host } = setup();
  assert.deepEqual(await host.check(), {
    providers: [
      {
        id: KOKORO_PROVIDER_ID,
        languages: KOKORO_CAPABILITIES.languages,
        voices: KOKORO_CAPABILITIES.voices,
        narrator: NARRATOR,
        installed: false,
        bytes: 0,
        offer: OFFER,
      },
    ],
    cacheBytes: 0,
  });
});

test('rpg-cm63.7 voice host downloads with progress only for a known provider', async () => {
  const { host, calls } = setup();
  const progress: number[] = [];
  await assert.rejects(
    host.download('elsewhere', consent, () => {}),
    /unknown voice provider/,
  );
  await host.download(KOKORO_PROVIDER_ID, consent, (bytes) => progress.push(bytes));
  assert.deepEqual(progress, [OFFER.bytes]);
  assert.deepEqual(calls, ['download']);
  assert.equal((await host.check()).providers[0]?.installed, true);
});

test('rpg-cm63.7 voice host rejects a download without a well-formed consent', async () => {
  const { host, calls } = setup();
  for (const invalid of [
    undefined,
    'yes',
    { ...consent, accepted: 'true' },
    { ...consent, bytes: '10' },
    { accepted: true },
  ])
    await assert.rejects(
      host.download(KOKORO_PROVIDER_ID, invalid, () => {}),
      RangeError,
    );
  assert.deepEqual(calls, []);
});

test('rpg-cm63.7 voice host shares one in-flight download per provider', async () => {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { host, calls } = setup(false, { gate });
  const first = host.download(KOKORO_PROVIDER_ID, consent, () => {});
  const second = host.download(KOKORO_PROVIDER_ID, consent, () => {});
  release();
  await Promise.all([first, second]);
  assert.deepEqual(calls, ['download']);
  await host.download(KOKORO_PROVIDER_ID, consent, () => {});
  assert.deepEqual(calls, ['download', 'download']);
});

test('rpg-cm63.7 voice host reports download progress only when the shown MiB value changes', async () => {
  const steps = [1, 1000, MIB, MIB + 5, 2 * MIB, 2 * MIB + 9, 3 * MIB];
  const { host } = setup(false, { offer: BIG_OFFER, steps });
  const progress: number[] = [];
  await host.download(KOKORO_PROVIDER_ID, { accepted: true, ...BIG_OFFER }, (bytes) => progress.push(bytes));
  assert.deepEqual(progress, [MIB, 2 * MIB, 3 * MIB]);
});

const PREVIEW_SPEED = 1.5;

test('rpg-cm63.26 voice host previews at the requested speed, applied once', async () => {
  const { host, speeds } = setup(true);
  await host.preview({ ...PREVIEW, speed: PREVIEW_SPEED });
  assert.deepEqual([...new Set(speeds)], [PREVIEW_SPEED]);
});

test('rpg-cm63.7 voice host previews a fixed line in the campaign language and caches it', async () => {
  const { host, spoken } = setup(true);
  const first = await host.preview(PREVIEW);
  assert.deepEqual(first, { chunks: [AUDIO, AUDIO, AUDIO], synthesisMs: STEP_MS, cacheHit: false });
  assert.equal(spoken.join(' '), PREVIEW_LINES.en);
  const again = await host.preview(PREVIEW);
  assert.equal(again.cacheHit, true);
  assert.equal(spoken.length, PREVIEW_PIECES);
  assert.ok((await host.check()).cacheBytes >= AUDIO.byteLength * PREVIEW_PIECES);
  host.clearCache();
  assert.equal((await host.check()).cacheBytes, 0);
});

test('rpg-cm63.46 voice host speaks the given text and replays it from the audio cache', async () => {
  const { host, spoken } = setup(true);
  const request = { ...PREVIEW, voiceId: 'am_adam', text: 'The door creaks.' };
  const first = await host.preview(request);
  assert.equal(first.cacheHit, false);
  assert.equal(spoken.join(' '), request.text);
  const again = await host.preview(request);
  assert.equal(again.cacheHit, true);
  assert.deepEqual(again.chunks, first.chunks);
  assert.equal(spoken.length, 1);
  assert.equal((await host.preview({ ...request, text: 'Another line.' })).cacheHit, false);
});

const LIVE_CACHE_BYTES = 1024 * 1024;
const LIVE_LINE = 'Who goes there?';
const LIVE_DELIVERY = { emotion: 'angry', intensity: 0.8, pace: 1.1 };
const LIVE_STYLE = 'gravelly';
const LIVE_PRONUNCIATIONS = { Vyrnax: 'VEER-nax', Ash: 'ash' };

const seedLiveUtterance = (profile: { style: string; pronunciations: Record<string, string> }, delivery?: object) => {
  const key = audioCacheKey(
    KOKORO_PROVIDER_ID,
    'am_adam',
    {
      text: LIVE_LINE,
      speakerId: 'Vyrnax',
      eventId: 'live-event',
      profile: { id: 'Vyrnax', language: 'en', pace: 1, ...profile, fallbacks: [] },
      ...(delivery === undefined ? {} : { delivery }),
    },
    { modelVersion: OFFER.source, outputFormat: KOKORO_MIME_TYPE },
  );
  createFileAudioCache(cacheDir, LIVE_CACHE_BYTES).set(key, [
    {
      audio: AUDIO,
      final: true,
      utteranceEventId: 'live-event',
      sequence: 0,
      mimeType: KOKORO_MIME_TYPE,
      voiceId: 'am_adam',
    },
  ]);
};

test('rpg-cm63.49 a replay request with the live delivery hits the audio cache entry stored when spoken live', async () => {
  seedLiveUtterance({ style: '', pronunciations: {} }, LIVE_DELIVERY);
  const { host, spoken } = setup(true);
  const request = { ...PREVIEW, voiceId: 'am_adam', text: LIVE_LINE };
  const replay = await host.preview({ ...request, delivery: LIVE_DELIVERY });
  assert.equal(replay.cacheHit, true);
  assert.deepEqual(replay.chunks, [AUDIO]);
  assert.deepEqual(spoken, []);
  assert.equal((await host.preview(request)).cacheHit, false);
});

test('rpg-cm63.49 a replay request with the live style and pronunciations hits the stored audio cache entry', async () => {
  seedLiveUtterance({ style: LIVE_STYLE, pronunciations: LIVE_PRONUNCIATIONS });
  const { host, spoken } = setup(true);
  const request = { ...PREVIEW, voiceId: 'am_adam', text: LIVE_LINE };
  const replay = await host.preview({ ...request, style: LIVE_STYLE, pronunciations: LIVE_PRONUNCIATIONS });
  assert.equal(replay.cacheHit, true);
  assert.deepEqual(spoken, []);
  assert.equal((await host.preview({ ...request, style: LIVE_STYLE })).cacheHit, false);
});

test('rpg-cm63.49 voice host rejects a replay request with malformed delivery, style or pronunciations', async () => {
  const { host, spoken } = setup(true);
  const request = { ...PREVIEW, text: LIVE_LINE };
  const invalid = [
    { ...request, delivery: 'angry' },
    { ...request, delivery: { emotion: 7 } },
    { ...request, delivery: { emotion: 'x'.repeat(MAX_EMOTION_CHARS + 1) } },
    { ...request, delivery: { intensity: Number.NaN } },
    { ...request, delivery: { pace: Number.POSITIVE_INFINITY } },
    { ...request, delivery: { intensity: 'high' } },
    { ...request, delivery: { volume: 1 } },
    { ...request, style: 7 },
    { ...request, pronunciations: 'x' },
    { ...request, pronunciations: { Ash: 7 } },
    { ...request, style: 'x'.repeat(MAX_STYLE_CHARS + 1) },
    {
      ...request,
      pronunciations: Object.fromEntries(Array.from({ length: MAX_PRONUNCIATIONS + 1 }, (_, i) => [`w${i}`, 'x'])),
    },
    { ...request, pronunciations: { ['k'.repeat(MAX_PRONUNCIATION_CHARS + 1)]: 'x' } },
    { ...request, pronunciations: { Ash: 'v'.repeat(MAX_PRONUNCIATION_CHARS + 1) } },
  ];
  for (const bad of invalid) await assert.rejects(host.preview(bad), RangeError);
  assert.deepEqual(spoken, []);
});

test('rpg-cm63.7 voice host rejects previews it cannot speak instead of guessing', async () => {
  const { host, spoken } = setup(true);
  const invalid = [
    { ...PREVIEW, providerId: 'elsewhere' },
    { ...PREVIEW, voiceId: 'pf_dora' },
    { ...PREVIEW, language: 'pt-BR' },
    { ...PREVIEW, speed: 9 },
    { ...PREVIEW, text: '' },
    { ...PREVIEW, text: 7 },
    { ...PREVIEW, text: 'x'.repeat(MAX_SPEECH_CHARS + 1) },
    { ...PREVIEW, language: 'xx', text: 'Hello' },
    'nonsense',
  ];
  for (const request of invalid) await assert.rejects(host.preview(request), RangeError);
  assert.deepEqual(spoken, []);
});

test('rpg-cm63.7 voice host removes an installed model and unloads its provider', async () => {
  const { host, calls, unloaded } = setup(true);
  await host.preview(PREVIEW);
  await host.remove(KOKORO_PROVIDER_ID);
  assert.deepEqual(calls, ['remove']);
  assert.equal(unloaded(), 1);
  assert.equal((await host.check()).providers[0]?.installed, false);
});

test('rpg-cm63.7 fake voice route downloads with progress and previews valid wav without network', async () => {
  const ticks: (() => void)[] = [];
  const host = createVoiceHost({ cacheDir, providers: fakeVoiceProviders((run) => ticks.push(run)) });
  const [provider] = (await host.check()).providers;
  assert.ok(provider && !provider.installed);
  const progress: number[] = [];
  const done = host.download(provider.id, { accepted: true, ...provider.offer }, (bytes) => progress.push(bytes));
  while (progress.at(-1) !== provider.offer.bytes) {
    await Promise.resolve();
    ticks.shift()?.();
  }
  await done;
  assert.ok(progress.length > 1);
  const { chunks } = await host.preview({ ...PREVIEW, providerId: provider.id });
  assert.ok(chunks.length > 0);
  assert.ok(chunks.every((chunk) => new TextDecoder().decode(chunk.subarray(0, 4)) === 'RIFF'));
});

test('rpg-cm63.8 a preview cached by one host is a cache hit for a new host over the same directory', async () => {
  const first = setup(true);
  const firstPreview = await first.host.preview(PREVIEW);
  const second = setup(true);
  const secondPreview = await second.host.preview(PREVIEW);
  assert.equal(firstPreview.cacheHit, false);
  assert.equal(secondPreview.cacheHit, true);
  assert.deepEqual(second.spoken, []);
  assert.deepEqual(secondPreview.chunks, firstPreview.chunks);
});

test('rpg-cm63.8 clearing the cache removes persisted previews', async () => {
  const { host } = setup(true);
  await host.preview(PREVIEW);
  host.clearCache();
  assert.equal((await host.check()).cacheBytes, 0);
  assert.equal((await setup(true).host.preview(PREVIEW)).cacheHit, false);
});

const MLX_OFFER = { source: 'https://pypi.example/mlx', bytes: 5, sizeMiB: 0 };
const fakeInstaller = (calls: string[], installed = false) => ({
  offer: MLX_OFFER,
  status: async () => ({ supported: true, installed }),
  install: async (consent: ModelConsent | undefined) => void calls.push(`install:${consent?.accepted}`),
  remove: async () => void calls.push('remove'),
});

test('the mlx voice is offered with the pt-BR narrator and installs only through consent', async () => {
  const calls: string[] = [];
  const [hosted] = mlxAudioProviders('/mlx', fakeInstaller(calls));
  assert.equal(hosted?.id, MLX_KOKORO_PROVIDER_ID);
  assert.equal(hosted?.narrator, 'pf_dora');
  assert.deepEqual(await hosted?.model.status(), { installed: false, bytes: 0 });
  const host = createVoiceHost({ providers: hosted ? [hosted] : [], cacheDir });
  await assert.rejects(
    host.download(MLX_KOKORO_PROVIDER_ID, { accepted: false }, () => {}),
    RangeError,
  );
  assert.deepEqual(calls, []);
  await host.download(MLX_KOKORO_PROVIDER_ID, { accepted: true, ...MLX_OFFER }, () => {});
  await host.remove(MLX_KOKORO_PROVIDER_ID);
  assert.deepEqual(calls, ['install:true', 'remove']);
});

test('the host lists the mlx voice only where it is supported', () => {
  const ids = (supported: boolean) => voiceProviders({}, '/dir', supported).map(({ id }) => id);
  assert.deepEqual(ids(true), [KOKORO_PROVIDER_ID, MLX_KOKORO_PROVIDER_ID, 'chatterbox', 'f5-tts']);
  assert.deepEqual(ids(false), [KOKORO_PROVIDER_ID, KOKORO_ONNX_PROVIDER_ID, 'f5-tts']);
});

test('the onnx pt-BR voice is offered with the pinned pt-BR files and the pt-BR narrator', async () => {
  const [hosted] = onnxProviders(cacheDir);
  assert.equal(hosted?.id, KOKORO_ONNX_PROVIDER_ID);
  assert.deepEqual(hosted?.capabilities, MLX_KOKORO_CAPABILITIES);
  assert.equal(hosted?.narrator, 'pf_dora');
  assert.deepEqual(hosted?.model.offer, KOKORO_PT_BR_MODEL_OFFER);
  assert.deepEqual(await hosted?.model.status(), { installed: false, bytes: 0 });
  const host = createVoiceHost({ providers: hosted ? [hosted] : [], cacheDir });
  await assert.rejects(
    host.download(KOKORO_ONNX_PROVIDER_ID, { accepted: false }, () => {}),
    RangeError,
  );
});

test('the host forced to the onnx route lists the onnx voice even where mlx is supported', () => {
  const env = { RPG_PT_BR_ROUTE: 'onnx' };
  assert.ok(voiceProviders(env, '/dir').some(({ id }) => id === KOKORO_ONNX_PROVIDER_ID));
  assert.ok(!voiceProviders(env, '/dir').some(({ id }) => id === MLX_KOKORO_PROVIDER_ID));
});

test('prepare preloads the healthy onnx voice for pt-BR', async () => {
  const calls: string[] = [];
  const provider = createKokoroProvider({
    id: KOKORO_ONNX_PROVIDER_ID,
    capabilities: MLX_KOKORO_CAPABILITIES,
    engine: {
      ready: () => true,
      load: async () => void calls.push('load'),
      synthesize: async () => AUDIO,
      unload: async () => {},
    },
  });
  const [hosted] = onnxProviders(cacheDir);
  const host = createVoiceHost({ providers: hosted ? [{ ...hosted, provider }] : [], cacheDir });
  assert.equal(host.prepare('pt-BR'), undefined);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ['load']);
});

test('rpg-cm63.55 chatterbox and f5 install only through consent and f5 reports its credits', async () => {
  for (const [make, id] of [
    [chatterboxProviders, 'chatterbox'],
    [f5Providers, 'f5-tts'],
  ] as const) {
    const calls: string[] = [];
    const [hosted] = make('/svc', fakeInstaller(calls));
    assert.equal(hosted?.id, id);
    assert.deepEqual(await hosted?.model.status(), { installed: false, bytes: 0 });
    const host = createVoiceHost({ providers: hosted ? [hosted] : [], cacheDir });
    await assert.rejects(
      host.download(id, { accepted: false }, () => {}),
      RangeError,
    );
    await host.download(id, { accepted: true, ...MLX_OFFER }, () => {});
    await host.remove(id);
    assert.deepEqual(calls, ['install:true', 'remove']);
    const [status] = (await host.check()).providers;
    assert.equal(status?.attributions !== undefined, id === 'f5-tts');
  }
});

const MLX_LANGUAGE = 'pt-BR';
const NO_VOICE_LANGUAGE = 'xx';

const preloadHost = ({ healthy = true, failPreload = false } = {}) => {
  let preloads = 0;
  const base = createKokoroProvider({
    id: MLX_KOKORO_PROVIDER_ID,
    capabilities: MLX_KOKORO_CAPABILITIES,
    engine: { ready: () => true, load: async () => {}, synthesize: async () => AUDIO, unload: async () => {} },
  });
  const provider = {
    synthesize: base.synthesize,
    dispose: base.dispose,
    healthy: () => healthy,
    preload: async () => {
      preloads += 1;
      if (failPreload) throw new Error('preload failed');
    },
  };
  const hosted: HostedProvider = {
    id: MLX_KOKORO_PROVIDER_ID,
    capabilities: MLX_KOKORO_CAPABILITIES,
    narrator: 'pf_dora',
    model: fakeModel().model,
    provider,
  };
  return { host: createVoiceHost({ providers: [hosted], cacheDir }), preloads: () => preloads };
};

test('rpg-cm63.24 prepare preloads a healthy mlx voice and stays silent', () => {
  const { host, preloads } = preloadHost();
  assert.equal(host.prepare(MLX_LANGUAGE), undefined);
  assert.equal(preloads(), 1);
});

test('rpg-cm63.24 prepare notes a language without a voice and skips preload', () => {
  const { host, preloads } = preloadHost();
  assert.match(host.prepare(NO_VOICE_LANGUAGE) ?? '', /No spoken voice exists/);
  assert.equal(preloads(), 0);
});

test('rpg-cm63.24 prepare notes an unhealthy or missing provider', () => {
  const unhealthy = preloadHost({ healthy: false });
  assert.match(unhealthy.host.prepare(MLX_LANGUAGE) ?? '', /not available on this computer/);
  assert.equal(unhealthy.preloads(), 0);
  const missing = createVoiceHost({ providers: [], cacheDir });
  assert.match(missing.prepare(MLX_LANGUAGE) ?? '', /not available on this computer/);
});

test('rpg-cm63.24 prepare remembers a failed preload and reports the voice unavailable', async () => {
  const { host } = preloadHost({ failPreload: true });
  assert.equal(host.prepare(MLX_LANGUAGE), undefined);
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(host.prepare(MLX_LANGUAGE) ?? '', /not available on this computer/);
});

test('rpg-cm63.55 a failing opt-in voice previews with the default voice instead of going silent', async () => {
  const kokoro = createKokoroProvider({
    engine: { ready: () => true, load: async () => {}, synthesize: async () => AUDIO, unload: async () => {} },
  });
  const failing: HostedProvider = {
    id: 'f5-tts',
    capabilities: { ...KOKORO_CAPABILITIES, voices: ['f5-voice'] },
    narrator: 'f5-voice',
    model: fakeModel(true).model,
    optIn: true,
    provider: {
      synthesize: () => ({ [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(new Error('down')) }) }),
      dispose: async () => {},
      preload: async () => {},
      healthy: () => true,
    },
  };
  const fallback: HostedProvider = {
    id: KOKORO_PROVIDER_ID,
    capabilities: KOKORO_CAPABILITIES,
    narrator: NARRATOR,
    model: fakeModel(true).model,
    provider: kokoro,
  };
  const host = createVoiceHost({ providers: [failing, fallback], cacheDir });
  const { chunks } = await host.preview({ ...PREVIEW, providerId: 'f5-tts', voiceId: 'f5-voice' });
  assert.ok(chunks.length > 0 && chunks.every((chunk) => chunk === AUDIO));
  await assert.rejects(host.preview({ ...PREVIEW, providerId: 'f5-tts', voiceId: 'f5-voice', language: 'xx' }));
});
