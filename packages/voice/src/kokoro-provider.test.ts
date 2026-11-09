import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import {
  CLAUSE_PAUSE_MS,
  decodeWav,
  encodeWav,
  PARAGRAPH_PAUSE_MS,
  SCENE_BREAK_PAUSE_MS,
  type Wav,
} from './delivery-shaping.ts';
import { DESIGNED_VOICES } from './designed-voices.ts';
import {
  createKokoroProvider,
  KOKORO_CAPABILITIES,
  KOKORO_DELIVERY_SPEED,
  KOKORO_IDLE_TIMEOUT_MS,
  KOKORO_MAX_CONCURRENT,
  KOKORO_NO_AUDIO_MESSAGE,
  KOKORO_PROVIDER_ID,
  type KokoroEngine,
  MLX_KOKORO_CAPABILITIES,
  MLX_KOKORO_PROVIDER_ID,
  type VoiceBlend,
} from './kokoro-provider.ts';
import { PT_BR_BLENDS } from './pt-br-blends.ts';
import { trailingSilenceMs } from './test-silence.ts';
import type { SpeechChunk } from './tts.ts';
import type { CommittedUtterance, VoiceProfile } from './voice.ts';

const VOICE = 'af_heart';
const PROFILE: VoiceProfile = {
  id: 'narrator',
  language: 'en-GB',
  pace: 1,
  style: 'calm',
  pronunciations: {},
  fallbacks: [{ providerId: KOKORO_PROVIDER_ID, voiceId: VOICE }],
};
const THREE_SENTENCES = 'The door creaks. Who goes there? Run!';
const UTTERANCE: CommittedUtterance = { text: THREE_SENTENCES, speakerId: 'gm', eventId: 'ev-1', profile: PROFILE };
const WAV = 'audio/wav';
const SENTENCE_COUNT = 3;

interface FakeEngine extends KokoroEngine {
  readonly calls: string[];
  loads: number;
  unloads: number;
  active: number;
  peak: number;
  isReady: boolean;
  failLoad: boolean;
  gate?: Promise<void>;
}

const fakeEngine = (): FakeEngine => {
  const engine: FakeEngine = {
    calls: [],
    loads: 0,
    unloads: 0,
    active: 0,
    peak: 0,
    isReady: true,
    failLoad: false,
    ready: () => engine.isReady,
    load: async () => {
      engine.loads += 1;
      if (engine.failLoad) throw new Error('load failed');
    },
    synthesize: async (sentence) => {
      engine.calls.push(sentence);
      engine.active += 1;
      engine.peak = Math.max(engine.peak, engine.active);
      await engine.gate;
      engine.active -= 1;
      return new TextEncoder().encode(sentence);
    },
    unload: async () => {
      engine.unloads += 1;
    },
  };
  return engine;
};

const collect = async (chunks: AsyncIterable<SpeechChunk>): Promise<SpeechChunk[]> => {
  const out: SpeechChunk[] = [];
  for await (const chunk of chunks) out.push(chunk);
  return out;
};

const speak = (provider: ReturnType<typeof createKokoroProvider>, utterance = UTTERANCE, voiceId = VOICE) =>
  collect(provider.synthesize(utterance, voiceId, new AbortController().signal));

test('reports English-only local capabilities without emotion', () => {
  const provider = createKokoroProvider({ engine: fakeEngine() });
  assert.equal(provider.id, KOKORO_PROVIDER_ID);
  assert.equal(provider.locality, 'local');
  assert.equal(provider.retention, 'none');
  assert.deepEqual(provider.capabilities, KOKORO_CAPABILITIES);
  assert.deepEqual(KOKORO_CAPABILITIES.languages, ['en']);
  assert.ok(KOKORO_CAPABILITIES.voices.includes(VOICE));
  assert.equal(KOKORO_CAPABILITIES.streaming, true);
  assert.equal(KOKORO_CAPABILITIES.emotion, false);
});

test('loads lazily and yields one WAV chunk per sentence with the last one final', async () => {
  const engine = fakeEngine();
  const provider = createKokoroProvider({ engine });
  assert.equal(engine.loads, 0);
  const chunks = await speak(provider);
  assert.equal(engine.loads, 1);
  assert.deepEqual(engine.calls, ['The door creaks.', 'Who goes there?', 'Run!']);
  assert.deepEqual(
    chunks.map((chunk) => [chunk.sequence, chunk.final, chunk.mimeType, chunk.voiceId, chunk.utteranceEventId]),
    [
      [0, false, WAV, VOICE, 'ev-1'],
      [1, false, WAV, VOICE, 'ev-1'],
      [2, true, WAV, VOICE, 'ev-1'],
    ],
  );
  await speak(provider);
  assert.equal(engine.loads, 1);
  await provider.dispose();
});

test('passes the delivery speed to the engine and neutral speed without delivery', async () => {
  const engine = fakeEngine();
  const speeds: number[] = [];
  const synthesize = engine.synthesize;
  engine.synthesize = (sentence, voiceId, signal, speed) => {
    speeds.push(speed);
    return synthesize(sentence, voiceId, signal, speed);
  };
  const provider = createKokoroProvider({ engine });
  await speak(provider, { ...UTTERANCE, text: 'Run!', delivery: { emotion: 'sad', intensity: 1 } });
  await speak(provider, { ...UTTERANCE, text: 'Run!' });
  assert.deepEqual(speeds, [KOKORO_DELIVERY_SPEED.sad, KOKORO_DELIVERY_SPEED.neutral]);
  await provider.dispose();
});

test('the profile pace scales the engine speed with or without delivery', async () => {
  const engine = fakeEngine();
  const speeds: number[] = [];
  const synthesize = engine.synthesize;
  engine.synthesize = (sentence, voiceId, signal, speed) => {
    speeds.push(speed);
    return synthesize(sentence, voiceId, signal, speed);
  };
  const provider = createKokoroProvider({ engine });
  const fast = { ...PROFILE, pace: 1.5 };
  await speak(provider, { ...UTTERANCE, text: 'Run!', profile: fast });
  await speak(provider, { ...UTTERANCE, text: 'Run!', profile: fast, delivery: { pace: 0.5 } });
  await speak(provider, { ...UTTERANCE, text: 'Run!', profile: { ...PROFILE, pace: 10 } });
  assert.deepEqual(speeds, [1.5, 0.75, 2]);
  await provider.dispose();
});

test('yields nothing for a non-English profile or an unknown voice', async () => {
  const engine = fakeEngine();
  const provider = createKokoroProvider({ engine });
  const portuguese = { ...UTTERANCE, profile: { ...PROFILE, language: 'pt-BR' } };
  assert.deepEqual(await speak(provider, portuguese), []);
  assert.deepEqual(await speak(provider, UTTERANCE, 'pf_dora'), []);
  assert.equal(engine.loads, 0);
});

test('an engine that returns no audio without an abort fails the synthesis', async () => {
  const engine = fakeEngine();
  engine.synthesize = async () => undefined as unknown as Uint8Array;
  const provider = createKokoroProvider({ engine });
  await assert.rejects(speak(provider), { message: KOKORO_NO_AUDIO_MESSAGE });
  await provider.dispose();
});

test('stops synthesizing further sentences once aborted', async () => {
  const engine = fakeEngine();
  const provider = createKokoroProvider({ engine });
  const controller = new AbortController();
  const chunks: SpeechChunk[] = [];
  for await (const chunk of provider.synthesize(UTTERANCE, VOICE, controller.signal)) {
    chunks.push(chunk);
    controller.abort();
  }
  assert.equal(chunks.length, 1);
  assert.equal(engine.calls.length, 1);
  await provider.dispose();
});

test('unloads after the idle timeout and reloads on next use', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const engine = fakeEngine();
    const provider = createKokoroProvider({ engine });
    await speak(provider);
    mock.timers.tick(KOKORO_IDLE_TIMEOUT_MS - 1);
    assert.equal(engine.unloads, 0);
    mock.timers.tick(1);
    await Promise.resolve();
    assert.equal(engine.unloads, 1);
    await speak(provider);
    assert.equal(engine.loads, 2);
  } finally {
    mock.timers.reset();
  }
});

test('queues synthesis beyond the concurrency limit', async () => {
  const engine = fakeEngine();
  let open = () => {};
  engine.gate = new Promise((resolve) => {
    open = resolve;
  });
  const provider = createKokoroProvider({ engine });
  const first = speak(provider);
  const second = speak(provider);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(engine.active, KOKORO_MAX_CONCURRENT);
  open();
  const results = await Promise.all([first, second]);
  assert.equal(engine.peak, KOKORO_MAX_CONCURRENT);
  assert.deepEqual(
    results.map((chunks) => chunks.length),
    [SENTENCE_COUNT, SENTENCE_COUNT],
  );
  await provider.dispose();
});

test('a queued request leaves the queue when aborted', async () => {
  const engine = fakeEngine();
  let open = () => {};
  engine.gate = new Promise((resolve) => {
    open = resolve;
  });
  const provider = createKokoroProvider({ engine });
  const first = speak(provider);
  const controller = new AbortController();
  const queued = collect(provider.synthesize(UTTERANCE, VOICE, controller.signal));
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  assert.deepEqual(await queued, []);
  open();
  assert.equal((await first).length, SENTENCE_COUNT);
  assert.equal(engine.calls.length, SENTENCE_COUNT);
  await provider.dispose();
});

test('health follows the engine and a failed load is retried on next use', async () => {
  const engine = fakeEngine();
  const provider = createKokoroProvider({ engine });
  assert.equal(provider.healthy(), true);
  engine.isReady = false;
  assert.equal(provider.healthy(), false);
  engine.failLoad = true;
  await assert.rejects(speak(provider), /load failed/);
  engine.failLoad = false;
  assert.equal((await speak(provider)).length, SENTENCE_COUNT);
  assert.equal(engine.loads, 2);
  await provider.dispose();
});

const failingUnloadEngine = (): FakeEngine => {
  const engine = fakeEngine();
  engine.unload = async () => {
    engine.unloads += 1;
    throw new Error('unload failed');
  };
  return engine;
};

const watchUnhandled = (): { readonly reasons: unknown[]; stop(): void } => {
  const reasons: unknown[] = [];
  const onRejection = (reason: unknown) => reasons.push(reason);
  process.on('unhandledRejection', onRejection);
  return { reasons, stop: () => process.off('unhandledRejection', onRejection) };
};

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('a failed idle unload is absorbed and the next use reloads', async () => {
  const unhandled = watchUnhandled();
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const engine = failingUnloadEngine();
    const provider = createKokoroProvider({ engine });
    await speak(provider);
    mock.timers.tick(KOKORO_IDLE_TIMEOUT_MS);
    await settle();
    assert.equal(engine.unloads, 1);
    assert.deepEqual(unhandled.reasons, []);
    assert.equal((await speak(provider)).length, SENTENCE_COUNT);
    assert.equal(engine.loads, 2);
  } finally {
    mock.timers.reset();
    unhandled.stop();
  }
});

test('a failed dispose unload is absorbed and the next use reloads', async () => {
  const engine = failingUnloadEngine();
  const provider = createKokoroProvider({ engine });
  await speak(provider);
  await provider.dispose();
  assert.equal(engine.unloads, 1);
  assert.equal((await speak(provider)).length, SENTENCE_COUNT);
  assert.equal(engine.loads, 2);
  await provider.dispose();
});

test('rejects invalid concurrency and idle timeout options', () => {
  for (const maxConcurrent of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => createKokoroProvider({ engine: fakeEngine(), maxConcurrent }), RangeError);
  }
  for (const idleTimeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => createKokoroProvider({ engine: fakeEngine(), idleTimeoutMs }), RangeError);
  }
});

test('dispose unloads a loaded model', async () => {
  const engine = fakeEngine();
  const provider = createKokoroProvider({ engine });
  await provider.dispose();
  assert.equal(engine.unloads, 0);
  await speak(provider);
  await provider.dispose();
  assert.equal(engine.unloads, 1);
});

const PT_BR_CAPABILITIES = { languages: ['pt-BR'], voices: ['pf_dora'], streaming: true, emotion: false };
const ptProfile = (language: string): CommittedUtterance => ({
  ...UTTERANCE,
  text: 'Fala baixo. O capitão escuta tudo.',
  profile: { ...PROFILE, language, fallbacks: [{ providerId: 'kokoro-mlx', voiceId: 'pf_dora' }] },
});

test('takes its id and capabilities from the options and matches the language region', async () => {
  const engine = fakeEngine();
  const provider = createKokoroProvider({ engine, id: 'kokoro-mlx', capabilities: PT_BR_CAPABILITIES });
  assert.equal(provider.id, 'kokoro-mlx');
  assert.deepEqual(provider.capabilities, PT_BR_CAPABILITIES);
  assert.equal((await speak(provider, ptProfile('pt-BR'), 'pf_dora')).length, 2);
  assert.equal((await speak(provider, ptProfile('pt'), 'pf_dora')).length, 2);
  assert.deepEqual(await speak(provider, ptProfile('pt-PT'), 'pf_dora'), []);
  assert.deepEqual(await speak(provider, UTTERANCE, VOICE), []);
  await provider.dispose();
});

test('an English capability without a region matches every English region', async () => {
  const provider = createKokoroProvider({ engine: fakeEngine() });
  for (const language of ['en', 'en-US', 'en-AU']) {
    assert.equal((await speak(provider, { ...UTTERANCE, profile: { ...PROFILE, language } })).length, SENTENCE_COUNT);
  }
  await provider.dispose();
});

test('preload loads the engine once before the first sentence and starts the idle timer', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const engine = fakeEngine();
    const provider = createKokoroProvider({ engine });
    await provider.preload();
    assert.equal(engine.loads, 1);
    await speak(provider);
    assert.equal(engine.loads, 1);
    mock.timers.tick(KOKORO_IDLE_TIMEOUT_MS);
    await settle();
    assert.equal(engine.unloads, 1);
    await provider.preload();
    mock.timers.tick(KOKORO_IDLE_TIMEOUT_MS);
    await settle();
    assert.equal(engine.unloads, 2);
  } finally {
    mock.timers.reset();
  }
});

const RATE = 24_000;
const TONE_SAMPLES = 2400;
const TONE_AMPLITUDE = 0.02;
const MS_PER_SECOND = 1000;
const TENSE_SPEED = 1.1;

const toneWav = (): Uint8Array => {
  const wav: Wav = {
    format: 1,
    bits: 16,
    channels: 1,
    sampleRate: RATE,
    samples: Float32Array.from({ length: TONE_SAMPLES }, (_, i) => TONE_AMPLITUDE * Math.sin(i / 4)),
  };
  return encodeWav(wav);
};

const wavEngine = (): FakeEngine => {
  const engine = fakeEngine();
  engine.synthesize = async (sentence) => {
    engine.calls.push(sentence);
    return toneWav();
  };
  return engine;
};

const silenceMsOf = (audio: Uint8Array): number => {
  const wav = decodeWav(audio);
  assert.ok(wav);
  const tail = wav.samples.length - TONE_SAMPLES;
  assert.ok(wav.samples.subarray(TONE_SAMPLES).every((sample) => sample === 0));
  return (tail / RATE) * MS_PER_SECOND;
};

const PROVIDERS = [
  { name: 'kokoro', id: KOKORO_PROVIDER_ID, capabilities: KOKORO_CAPABILITIES, language: 'en-US', voice: VOICE },
  {
    name: 'kokoro-mlx',
    id: MLX_KOKORO_PROVIDER_ID,
    capabilities: MLX_KOKORO_CAPABILITIES,
    language: 'pt-BR',
    voice: 'pf_dora',
  },
] as const;

const speakAs = (
  provider: ReturnType<typeof createKokoroProvider>,
  { language, voice }: (typeof PROVIDERS)[number],
  text: string,
  overrides: Partial<CommittedUtterance> = {},
) =>
  speak(provider, { ...UTTERANCE, text, profile: { ...PROFILE, language }, ...overrides } as CommittedUtterance, voice);

for (const target of PROVIDERS) {
  const build = (engine: KokoroEngine, extra = {}) =>
    createKokoroProvider({ engine, id: target.id, capabilities: target.capabilities, ...extra });

  test(`${target.name}: passes the speed for whisper, calm and tense deliveries`, async () => {
    const engine = fakeEngine();
    const speeds: number[] = [];
    engine.synthesize = async (_sentence, _voice, _signal, speed) => {
      speeds.push(speed);
      return new Uint8Array();
    };
    const provider = build(engine);
    for (const emotion of ['whisper', 'calm', 'tense']) {
      await speakAs(provider, target, 'Run.', { delivery: { emotion, intensity: 1 } });
    }
    assert.deepEqual(speeds, [KOKORO_DELIVERY_SPEED.whisper, KOKORO_DELIVERY_SPEED.calm, TENSE_SPEED]);
    assert.equal(KOKORO_DELIVERY_SPEED.tense, TENSE_SPEED);
    await provider.dispose();
  });

  test(`${target.name}: appends the pause after each sentence but the last and keeps sequence and final`, async () => {
    const provider = build(wavEngine());
    const text = target.language === 'en-US' ? 'He waited. “Who?” Nothing.' : 'Ele esperou. “Quem?” Nada.';
    const chunks = await speakAs(provider, target, text);
    assert.deepEqual(
      chunks.map(({ sequence, final }) => [sequence, final]),
      [
        [0, false],
        [1, false],
        [2, true],
      ],
    );
    const [first, second, last] = chunks.map(({ audio }) => silenceMsOf(audio));
    assert.ok((first ?? 0) > 0 && (second ?? 0) > 0);
    assert.ok((first ?? 0) > (second ?? 0));
    assert.equal(last, 0);
    const tense = await speakAs(provider, target, text, { delivery: { emotion: 'tense' } });
    assert.ok(silenceMsOf(tense[0]?.audio ?? new Uint8Array()) < (first ?? 0));
    await provider.dispose();
  });

  test(`${target.name}: adds paragraph and scene silence and never synthesizes the marker`, async () => {
    const engine = wavEngine();
    const provider = build(engine);
    const chunks = await speakAs(provider, target, 'Gate.\n\nDawn.\n\n***\n\nLater.');
    assert.deepEqual(engine.calls, ['Gate.', 'Dawn.', 'Later.']);
    assert.deepEqual(
      chunks.map(({ audio }) => Math.round(silenceMsOf(audio))),
      [PARAGRAPH_PAUSE_MS, SCENE_BREAK_PAUSE_MS, 0],
    );
    await provider.dispose();
  });

  test(`${target.name}: matches loudness across chunks and leaves them untouched when shaping is off`, async () => {
    const shaped = build(wavEngine());
    const raw = build(wavEngine(), { shaping: false });
    const [shapedChunk] = await speakAs(shaped, target, 'Run.');
    const [rawChunk] = await speakAs(raw, target, 'Run.');
    assert.deepEqual(rawChunk?.audio, toneWav());
    const level = (audio: Uint8Array) => {
      const samples = decodeWav(audio)?.samples ?? new Float32Array();
      return Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / TONE_SAMPLES);
    };
    assert.ok(level(shapedChunk?.audio ?? new Uint8Array()) > level(toneWav()) * 2);
    await shaped.dispose();
    await raw.dispose();
  });

  test(`${target.name}: gives a blend to an engine that can blend and the single voice to one that cannot`, async () => {
    const [first, second] = target.capabilities.voices;
    assert.ok(first && second);
    const blend: VoiceBlend = { first: target.voice, second: target.voice === first ? second : first, weight: 0.3 };
    const seen: Array<VoiceBlend | undefined> = [];
    const capture = (engine: FakeEngine) => {
      engine.synthesize = async (_sentence, _voice, _signal, _speed, received) => {
        seen.push(received);
        return new Uint8Array();
      };
      return engine;
    };
    const blending = build(Object.assign(capture(fakeEngine()), { blends: true }), { voiceBlend: () => blend });
    await speakAs(blending, target, 'Run.');
    const single = build(capture(fakeEngine()), { voiceBlend: () => blend });
    await speakAs(single, target, 'Run.');
    assert.deepEqual(seen, [blend, undefined]);
    await blending.dispose();
    await single.dispose();
  });

  test(`${target.name}: ignores a blend outside its capabilities or for another primary voice`, async () => {
    const seen: Array<VoiceBlend | undefined> = [];
    const engine = Object.assign(fakeEngine(), { blends: true });
    engine.synthesize = async (_sentence, _voice, _signal, _speed, received) => {
      seen.push(received);
      return new Uint8Array();
    };
    const other = target.capabilities.voices.find((voice) => voice !== target.voice) ?? '';
    const blends: VoiceBlend[] = [
      { first: target.voice, second: 'zz_unknown', weight: 0.3 },
      { first: other, second: target.voice, weight: 0.3 },
      { first: target.voice, second: other, weight: 0 },
      { first: target.voice, second: other, weight: 1 },
    ];
    for (const blend of blends) {
      const provider = build(engine, { voiceBlend: () => blend });
      await speakAs(provider, target, 'Run.');
      await provider.dispose();
    }
    assert.deepEqual(seen, [undefined, undefined, undefined, undefined]);
  });
}

test('rpg-cm63.44 a manner changes the engine speed and lowers or raises the pitch', async () => {
  const wav = encodeWav({
    format: 1,
    bits: 16,
    channels: 1,
    sampleRate: 24_000,
    samples: Float32Array.from({ length: 4800 }, (_, i) => 0.5 * Math.sin((2 * Math.PI * i) / 24)),
  });
  const lengthWith = async (manner: VoiceProfile['manner']) => {
    const engine = fakeEngine();
    const speeds: number[] = [];
    engine.synthesize = async (_sentence, _voice, _signal, speed) => {
      speeds.push(speed);
      return wav;
    };
    const profile = { ...PROFILE, ...(manner === undefined ? {} : { manner }) };
    const [chunk] = await speak(createKokoroProvider({ engine }), { ...UTTERANCE, text: 'Hello there.', profile });
    return { speed: speeds[0] ?? 0, samples: decodeWav(chunk?.audio ?? new Uint8Array())?.samples.length ?? 0 };
  };
  const plain = await lengthWith(undefined);
  const menacing = await lengthWith('menacing');
  const cheerful = await lengthWith('cheerful');
  assert.equal(plain.speed, 1);
  assert.ok(menacing.speed < cheerful.speed);
  assert.ok(menacing.samples > plain.samples && plain.samples > cheerful.samples);
});

const PCM_FORMAT = 1;
const PCM_BITS = 16;
const PT_BR_RATE = 24_000;
const PT_BR_TONE_SAMPLES = 2400;
const PT_BR_TONE_PERIOD = 24;
const PT_BR_TONE_AMPLITUDE = 0.3;
const PT_BR_PARAGRAPH =
  'Quando a porta abriu, ninguém falou; o capitão olhou o mapa: nada. Você vem comigo? Ele parou — e ouviu. Vai embora!';

test('rpg-cm63.47 a pt-BR paragraph is spoken clause by clause with an audible silence after each mark', async () => {
  const engine = fakeEngine();
  engine.synthesize = async (sentence) => {
    engine.calls.push(sentence);
    return encodeWav({
      format: PCM_FORMAT,
      bits: PCM_BITS,
      channels: 1,
      sampleRate: PT_BR_RATE,
      samples: Float32Array.from(
        { length: PT_BR_TONE_SAMPLES },
        (_, i) => PT_BR_TONE_AMPLITUDE * Math.sin((2 * Math.PI * (i + 1)) / PT_BR_TONE_PERIOD),
      ),
    });
  };
  const provider = createKokoroProvider({ engine });
  const chunks = await speak(provider, { ...UTTERANCE, text: PT_BR_PARAGRAPH });
  assert.deepEqual(engine.calls, [
    'Quando a porta abriu,',
    'ninguém falou;',
    'o capitão olhou o mapa:',
    'nada.',
    'Você vem comigo?',
    'Ele parou —',
    'e ouviu.',
    'Vai embora!',
  ]);
  const gaps = chunks.map((chunk) => trailingSilenceMs(chunk.audio));
  assert.deepEqual(gaps.slice(0, 3), [CLAUSE_PAUSE_MS[','], CLAUSE_PAUSE_MS[';'], CLAUSE_PAUSE_MS[':']]);
  assert.equal(gaps[5], CLAUSE_PAUSE_MS['—']);
  assert.ok((gaps[4] ?? 0) > (gaps[3] ?? 0));
  assert.ok((gaps[3] ?? 0) > (gaps[2] ?? 0));
  assert.equal(gaps.at(-1), 0);
  assert.equal(chunks.at(-1)?.final, true);
  assert.deepEqual(
    chunks.map((chunk) => chunk.sequence),
    [0, 1, 2, 3, 4, 5, 6, 7],
  );
  await provider.dispose();
});

test('rpg-cm63.47 the utterance delivery reaches the engine so an expressive engine can map it', async () => {
  const engine = fakeEngine();
  const deliveries: unknown[] = [];
  const synthesize = engine.synthesize;
  engine.synthesize = (sentence, voiceId, signal, speed, blend, delivery) => {
    deliveries.push(delivery);
    return synthesize(sentence, voiceId, signal, speed, blend, delivery);
  };
  const delivery = { emotion: 'whisper', intensity: 0.5 };
  await speak(createKokoroProvider({ engine }), { ...UTTERANCE, text: 'Psiu, venha.', delivery });
  assert.deepEqual(deliveries, [delivery, delivery]);
});

const NAMED_BLEND = PT_BR_BLENDS[0];
const NAMED_BLEND_PROFILE: VoiceProfile = { ...PROFILE, language: 'pt-BR' };

const speakNamedBlend = async (
  engine: KokoroEngine,
  voiceId: string,
  voiceBlend?: () => VoiceBlend,
): Promise<SpeechChunk[]> => {
  const provider = createKokoroProvider({
    engine,
    capabilities: MLX_KOKORO_CAPABILITIES,
    ...(voiceBlend === undefined ? {} : { voiceBlend }),
  });
  const chunks: SpeechChunk[] = [];
  const utterance = { ...UTTERANCE, text: 'Oi.', profile: NAMED_BLEND_PROFILE };
  for await (const chunk of provider.synthesize(utterance, voiceId, new AbortController().signal)) chunks.push(chunk);
  await provider.dispose();
  return chunks;
};

const capturingEngine = (blends: boolean) => {
  const seen: Array<{ voiceId: string; blend: VoiceBlend | undefined }> = [];
  const engine = Object.assign(wavEngine(), { blends });
  engine.synthesize = async (_sentence, voiceId, _signal, _speed, blend) => {
    seen.push({ voiceId, blend });
    return toneWav();
  };
  return { engine, seen };
};

test('rpg-cm63.45 a named blend asks the engine for the first voice with the fixed blend and reports its own id', async () => {
  assert.ok(NAMED_BLEND);
  const { engine, seen } = capturingEngine(true);
  const chunks = await speakNamedBlend(engine, NAMED_BLEND.id);
  assert.deepEqual(seen, [
    {
      voiceId: NAMED_BLEND.first,
      blend: { first: NAMED_BLEND.first, second: NAMED_BLEND.second, weight: NAMED_BLEND.weight },
    },
  ]);
  assert.equal(chunks[0]?.voiceId, NAMED_BLEND.id);
});

test('rpg-cm63.45 a named blend ignores the per-character blend', async () => {
  assert.ok(NAMED_BLEND);
  const { engine, seen } = capturingEngine(true);
  await speakNamedBlend(engine, NAMED_BLEND.id, () => ({
    first: NAMED_BLEND.first,
    second: 'pm_santa',
    weight: 0.2,
  }));
  assert.equal(seen[0]?.blend?.second, NAMED_BLEND.second);
});

test('rpg-cm63.45 an engine that cannot blend stays silent so the next provider speaks', async () => {
  assert.ok(NAMED_BLEND);
  const { engine, seen } = capturingEngine(false);
  assert.deepEqual(await speakNamedBlend(engine, NAMED_BLEND.id), []);
  assert.deepEqual(seen, []);
});

const DESIGNED = DESIGNED_VOICES[0];

test('rpg-cm63.63 a designed voice goes to the engine under its own id with no blend and is reported by id', async () => {
  assert.ok(DESIGNED);
  const { engine, seen } = capturingEngine(true);
  const chunks = await speakNamedBlend(engine, DESIGNED.id);
  assert.deepEqual(seen, [{ voiceId: DESIGNED.id, blend: undefined }]);
  assert.equal(chunks[0]?.voiceId, DESIGNED.id);
});

test('rpg-cm63.63 a designed voice ignores the per-character blend', async () => {
  assert.ok(DESIGNED);
  const { engine, seen } = capturingEngine(true);
  await speakNamedBlend(engine, DESIGNED.id, () => ({ first: DESIGNED.id, second: 'pm_santa', weight: 0.2 }));
  assert.equal(seen[0]?.blend, undefined);
});

test('rpg-cm63.63 an engine that cannot load voicepacks stays silent for a designed voice', async () => {
  assert.ok(DESIGNED);
  const { engine, seen } = capturingEngine(false);
  assert.deepEqual(await speakNamedBlend(engine, DESIGNED.id), []);
  assert.deepEqual(seen, []);
});
