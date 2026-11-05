import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ModelConsent } from '../../../packages/voice/src/kokoro-model.ts';
import type { SpokenOutputMode } from '../../../packages/voice/src/voice.ts';
import type { PreviewRequest, VoiceHostStatus, VoiceProviderStatus } from './voice-host.ts';
import {
  browserAudio,
  createVoiceSetup,
  DEFAULT_SPEECH,
  MAX_NPC_NAME_LENGTH,
  type SpeechPreferences,
  VOICE_ON_MODE,
  type VoiceBridge,
} from './voice-setup.ts';

const OFFER = { source: 'https://models.example/kokoro', bytes: 100, sizeMiB: 0 };
const AUDIO = new Uint8Array([1]);
const KOKORO: VoiceProviderStatus = {
  id: 'kokoro',
  languages: ['en'],
  voices: ['af_heart', 'am_adam', 'bf_emma'],
  narrator: 'af_heart',
  installed: false,
  bytes: 0,
  offer: OFFER,
};
const CAMPAIGN_TEXT = 'Vyrnax the dragon wakes beneath Emberfall';
const CAMPAIGN = 'campaign-a';
const OTHER_CAMPAIGN = 'campaign-b';

type Options = {
  installed?: boolean;
  providers?: VoiceProviderStatus[];
  failPreview?: unknown;
  failDownload?: unknown;
  speakers?: string[];
  engineSummary?: unknown;
  failDiagnostics?: unknown;
};

const fakeBridge = ({
  installed = false,
  providers,
  failPreview,
  failDownload,
  engineSummary,
  failDiagnostics,
}: Options = {}) => {
  const calls: unknown[][] = [];
  let present = installed;
  let progress = (_bytes: number) => {};
  let finish = () => {};
  let cacheBytes = 0;
  const bridge: VoiceBridge = {
    check: async (): Promise<VoiceHostStatus> => ({
      providers: providers ?? [{ ...KOKORO, installed: present, bytes: present ? OFFER.bytes : 0 }],
      cacheBytes,
    }),
    download: (providerId: string, consent: ModelConsent) => {
      calls.push(['download', providerId, consent]);
      if (failDownload !== undefined) return Promise.reject(failDownload);
      return new Promise<void>((resolve) => {
        finish = () => {
          present = true;
          resolve();
        };
      });
    },
    remove: async (providerId: string) => {
      calls.push(['remove', providerId]);
      present = false;
    },
    preview: async (request: PreviewRequest) => {
      calls.push(['preview', request]);
      if (failPreview !== undefined) throw failPreview;
      const cacheHit = cacheBytes > 0;
      cacheBytes = AUDIO.byteLength;
      return { chunks: [AUDIO], synthesisMs: cacheHit ? 0 : 50, cacheHit };
    },
    clearCache: async () => {
      calls.push(['clear']);
      cacheBytes = 0;
    },
    playback: async () => true,
    diagnostics: async () => {
      if (failDiagnostics !== undefined) throw failDiagnostics;
      return engineSummary as never;
    },
    onProgress: (listener) => {
      progress = listener;
    },
  };
  return { bridge, calls, progress: (bytes: number) => progress(bytes), finish: () => finish() };
};

const setup = (options: Options = {}, speech: SpeechPreferences = DEFAULT_SPEECH, language = 'en') => {
  const fake = fakeBridge(options);
  const played: { chunks: readonly Uint8Array[]; volume: number }[] = [];
  const outputs: SpokenOutputMode[] = [];
  const saved: SpeechPreferences[] = [];
  let clock = 0;
  let renders = 0;
  let campaign: string | undefined = CAMPAIGN;
  const controller = createVoiceSetup({
    bridge: fake.bridge,
    audio: {
      play: async (chunks, volume) => {
        played.push({ chunks, volume });
        clock += 10;
        return { decodeMs: 10 };
      },
    },
    now: () => (clock += 100),
    speech,
    language: () => language,
    campaign: () => campaign,
    speakers: () => options.speakers ?? [],
    saveSpeech: (next) => saved.push(next),
    setOutput: (mode) => outputs.push(mode),
    changed: () => {
      renders += 1;
    },
  });
  const open = (id: string | undefined) => {
    campaign = id;
  };
  return { ...fake, controller, played, outputs, saved, open, renders: () => renders };
};

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('rpg-cm63.7 turning voice on checks providers, proposes the local default and asks consent with size and source', async () => {
  const { controller, calls, outputs } = setup();
  const checking = controller.turnOn();
  assert.equal(controller.view().step, 'checking');
  await checking;
  const view = controller.view();
  assert.equal(view.step, 'consent');
  assert.equal(view.provider?.id, 'kokoro');
  assert.deepEqual(view.provider?.offer, OFFER);
  assert.deepEqual(calls, []);
  assert.deepEqual(outputs, []);
});

test('rpg-cm63.7 consent downloads with progress, then plays the narrator preview and turns voice on', async () => {
  const { controller, calls, progress, finish, played, outputs } = setup();
  await controller.turnOn();
  const accepted = controller.accept();
  assert.equal(controller.view().step, 'downloading');
  progress(40);
  assert.deepEqual(controller.view().progress, { bytes: 40, total: OFFER.bytes });
  finish();
  await accepted;
  assert.deepEqual(calls.slice(0, 2), [
    ['download', 'kokoro', { accepted: true, ...OFFER }],
    ['preview', { providerId: 'kokoro', voiceId: 'af_heart', language: 'en', speed: 1 }],
  ]);
  assert.equal(played.length, 1);
  assert.equal(controller.view().step, 'ready');
  assert.deepEqual(outputs, [VOICE_ON_MODE]);
});

test('rpg-cm63.7 an installed model skips consent and goes straight to the preview', async () => {
  const { controller, calls, outputs } = setup({ installed: true });
  await controller.turnOn();
  assert.equal(controller.view().step, 'ready');
  assert.equal(calls[0]?.[0], 'preview');
  assert.deepEqual(outputs, [VOICE_ON_MODE]);
});

test('rpg-cm63.7 declining keeps text-only play and downloads nothing', async () => {
  const { controller, calls, outputs } = setup();
  await controller.turnOn();
  controller.decline();
  assert.equal(controller.view().step, 'closed');
  assert.deepEqual(calls, []);
  assert.deepEqual(outputs, []);
});

test('rpg-cm63.7 no provider for the campaign language says so and keeps text', async () => {
  const { controller, calls, outputs } = setup({}, DEFAULT_SPEECH, 'es');
  await controller.turnOn();
  assert.equal(controller.view().step, 'unavailable');
  assert.deepEqual(calls, []);
  assert.deepEqual(outputs, []);
});

test('rpg-cm63.7 a failed download or preview keeps voice off and records only an error code', async () => {
  const download = setup({ failDownload: new Error(CAMPAIGN_TEXT) });
  await download.controller.turnOn();
  await download.controller.accept();
  assert.equal(download.controller.view().step, 'failed');
  assert.equal(download.controller.view().error, 'provider-error');
  assert.deepEqual(download.outputs, []);

  const preview = setup({
    installed: true,
    failPreview: Object.assign(new Error(CAMPAIGN_TEXT), { name: 'TimeoutError' }),
  });
  await preview.controller.turnOn();
  assert.equal(preview.controller.view().step, 'failed');
  assert.equal(preview.controller.view().error, 'timeout');
  assert.deepEqual(preview.outputs, []);
  assert.doesNotMatch(JSON.stringify(preview.controller.view()), /Vyrnax|dragon|Emberfall/);
});

test('rpg-cm63.7 diagnostics record time to first audio, cache hits and where the time goes', async () => {
  const { controller } = setup({ installed: true });
  await controller.turnOn();
  await controller.preview();
  assert.deepEqual(controller.view().diagnostics, {
    samples: 2,
    firstAudioMs: 210,
    cacheHitRate: 0.5,
    errors: {},
    stages: { synthesis: 0, transfer: 50, decode: 10 },
  });
});

test('rpg-cm63.7 narrator voice, volume, provider and NPC overrides save and apply to the next preview', async () => {
  const { controller, calls, saved, played } = setup({ installed: true });
  await controller.refresh();
  controller.update({ narratorVoice: 'am_adam', volume: 0.4 });
  controller.setNpcVoice('Guard', 'bf_emma');
  await controller.preview();
  await controller.preview('Guard');
  assert.deepEqual(saved.at(-1), {
    ...DEFAULT_SPEECH,
    narratorVoice: 'am_adam',
    volume: 0.4,
    npcVoices: { [CAMPAIGN]: { Guard: 'bf_emma' } },
  });
  const voices = calls.filter(([kind]) => kind === 'preview').map(([, request]) => (request as PreviewRequest).voiceId);
  assert.deepEqual(voices, ['am_adam', 'bf_emma']);
  assert.deepEqual(
    played.map(({ volume }) => volume),
    [0.4, 0.4],
  );
  controller.removeNpcVoice('Guard');
  assert.deepEqual(saved.at(-1)?.npcVoices, {});
});

test('rpg-cm63.7 character voice overrides belong to one campaign and never leak into another', async () => {
  const { controller, calls, saved, open } = setup({ installed: true });
  await controller.refresh();
  controller.setNpcVoice('Wren', 'bf_emma');
  open(OTHER_CAMPAIGN);
  assert.deepEqual(controller.view().npcVoices, {});
  await controller.preview('Wren');
  controller.setNpcVoice('Wren', 'am_adam');
  open(CAMPAIGN);
  assert.deepEqual(controller.view().npcVoices, { Wren: 'bf_emma' });
  assert.deepEqual(saved.at(-1)?.npcVoices, {
    [CAMPAIGN]: { Wren: 'bf_emma' },
    [OTHER_CAMPAIGN]: { Wren: 'am_adam' },
  });
  const voices = calls.filter(([kind]) => kind === 'preview').map(([, request]) => (request as PreviewRequest).voiceId);
  assert.deepEqual(voices, ['af_heart']);
  open(undefined);
  const before = saved.length;
  controller.setNpcVoice('Wren', 'am_adam');
  assert.equal(saved.length, before);
});

test('rpg-cm63.15 offers the known speaking characters that have no voice yet', async () => {
  const tooLong = 'x'.repeat(MAX_NPC_NAME_LENGTH + 1);
  const { controller } = setup({ installed: true, speakers: ['Wren', ' ', tooLong, 'Guard', 'Wren'] });
  await controller.refresh();
  assert.deepEqual(controller.view().speakers, ['Wren', 'Guard']);
  controller.setNpcVoice('Guard', 'bf_emma');
  assert.deepEqual(controller.view().speakers, ['Wren']);
});

test('rpg-cm63.15 previews a voice choice before it is assigned and ignores voices the provider lacks', async () => {
  const { controller, calls } = setup({ installed: true });
  await controller.refresh();
  await controller.previewVoice('bf_emma');
  await controller.previewVoice('not-a-voice');
  const voices = calls.filter(([kind]) => kind === 'preview').map(([, request]) => (request as PreviewRequest).voiceId);
  assert.deepEqual(voices, ['bf_emma']);
});

test('rpg-cm63.7 rejects speech settings outside what the provider offers', async () => {
  const { controller, saved } = setup({ installed: true });
  await controller.refresh();
  controller.update({ narratorVoice: 'not-a-voice' });
  controller.update({ volume: 3 });
  controller.update({ providerId: 'elsewhere' });
  controller.setNpcVoice('', 'am_adam');
  controller.setNpcVoice('Guard', 'not-a-voice');
  assert.deepEqual(saved, []);
});

test('rpg-cm63.7 removes installed models and clears the cache from advanced settings', async () => {
  const { controller, calls } = setup({ installed: true });
  await controller.turnOn();
  assert.equal(controller.view().cacheBytes, AUDIO.byteLength);
  await controller.clearCache();
  assert.equal(controller.view().cacheBytes, 0);
  await controller.removeModel('kokoro');
  assert.deepEqual(calls.slice(-2), [['clear'], ['remove', 'kokoro']]);
  assert.equal(controller.view().providers[0]?.installed, false);
});

test('rpg-cm63.7 without a voice bridge the setup reports unavailable and text play continues', async () => {
  const outputs: SpokenOutputMode[] = [];
  const controller = createVoiceSetup({
    audio: { play: async () => ({ decodeMs: 0 }) },
    speech: DEFAULT_SPEECH,
    language: () => 'en',
    campaign: () => undefined,
    saveSpeech: () => {},
    setOutput: (mode) => outputs.push(mode),
    changed: () => {},
  });
  await controller.turnOn();
  assert.equal(controller.view().step, 'unavailable');
  assert.deepEqual(outputs, []);
  await settle();
});

test('rpg-cm63.7 browser audio decodes every chunk, queues them in order and applies the volume', async () => {
  const started: [number, number][] = [];
  let gainValue = -1;
  let contexts = 0;
  let clock = 0;
  const context = () => {
    contexts += 1;
    return {
      currentTime: 3,
      destination: {},
      resume: async () => {},
      decodeAudioData: async (data: ArrayBuffer) => {
        clock += 4;
        return { duration: data.byteLength };
      },
      createGain: () => ({
        gain: {
          set value(volume: number) {
            gainValue = volume;
          },
        },
        connect: () => {},
      }),
      createBufferSource: () => {
        const source = {
          buffer: undefined as { duration: number } | undefined,
          connect: () => {},
          start: (at: number) => started.push([at, source.buffer?.duration ?? 0]),
        };
        return source;
      },
    };
  };
  const audio = browserAudio(context, () => clock);
  assert.deepEqual(await audio.play([new Uint8Array(2), new Uint8Array(5)], 0.3), { decodeMs: 8, durationMs: 7000 });
  await audio.play([new Uint8Array(1)], 0.3);
  assert.deepEqual(started, [
    [3, 2],
    [5, 5],
    [3, 1],
  ]);
  assert.equal(gainValue, 0.3);
  assert.equal(contexts, 1);
});

const ENGINE_SUMMARY = { samples: 3, cacheHitRate: 0, errors: { timeout: 1 }, stages: {}, peakQueueDepth: 4 };

test('rpg-cm63.22 refresh reads the engine speech summary and observe updates it', async () => {
  const { controller, bridge } = setup({ engineSummary: ENGINE_SUMMARY });
  assert.equal(controller.view().engine, undefined);
  await controller.refresh();
  assert.deepEqual(controller.view().engine, ENGINE_SUMMARY);
  const later = { ...ENGINE_SUMMARY, samples: 5 };
  bridge.diagnostics = async () => later;
  await controller.observe();
  assert.equal(controller.view().engine?.samples, 5);
});

test('rpg-cm63.22 the engine speech summary ignores malformed answers and failed requests', async () => {
  for (const options of [
    { engineSummary: 'nope' },
    { engineSummary: { samples: -1, cacheHitRate: 0, errors: {}, stages: {} } },
    { engineSummary: { samples: 1, cacheHitRate: 0, errors: { timeout: 'many' }, stages: {} } },
    { engineSummary: undefined },
    { failDiagnostics: new Error('engine stopped') },
  ]) {
    const { controller } = setup(options);
    await controller.refresh();
    assert.equal(controller.view().engine, undefined);
  }
});
