import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import type { ModelConsent, ModelManager } from '../../../packages/voice/src/kokoro-model.ts';
import {
  createKokoroProvider,
  KOKORO_CAPABILITIES,
  KOKORO_PROVIDER_ID,
} from '../../../packages/voice/src/kokoro-provider.ts';
import { createVoiceHost, fakeVoiceProviders, type HostedProvider, PREVIEW_LINES } from './voice-host.ts';

const OFFER = { source: 'https://models.example/kokoro', bytes: 10, sizeMiB: 0 };
const NARRATOR = 'af_heart';
const AUDIO = new Uint8Array([1, 2, 3]);
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
  const { model, calls } = fakeModel(installed, modelOptions);
  let unloaded = 0;
  const provider = createKokoroProvider({
    engine: {
      ready: () => true,
      load: async () => {},
      synthesize: async (sentence) => {
        spoken.push(sentence);
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
  return { host, spoken, calls, unloaded: () => unloaded };
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

test('rpg-cm63.7 voice host previews a fixed line in the campaign language and caches it', async () => {
  const { host, spoken } = setup(true);
  const first = await host.preview(PREVIEW);
  assert.deepEqual(first, { chunks: [AUDIO, AUDIO], synthesisMs: STEP_MS, cacheHit: false });
  assert.equal(spoken.join(' '), PREVIEW_LINES.en);
  const again = await host.preview(PREVIEW);
  assert.equal(again.cacheHit, true);
  assert.equal(spoken.length, 2);
  assert.ok((await host.check()).cacheBytes >= AUDIO.byteLength * 2);
  host.clearCache();
  assert.equal((await host.check()).cacheBytes, 0);
});

test('rpg-cm63.7 voice host rejects previews it cannot speak instead of guessing', async () => {
  const { host, spoken } = setup(true);
  const invalid = [
    { ...PREVIEW, providerId: 'elsewhere' },
    { ...PREVIEW, voiceId: 'pf_dora' },
    { ...PREVIEW, language: 'pt-BR' },
    { ...PREVIEW, speed: 9 },
    { ...PREVIEW, text: 'say anything' },
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
