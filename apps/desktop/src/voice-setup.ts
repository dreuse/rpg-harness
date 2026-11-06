import { type AudioFailure, classifyAudioFailure } from '../../../packages/voice/src/fallback.ts';
import type { ModelConsent } from '../../../packages/voice/src/kokoro-model.ts';
import { speaksLanguage } from '../../../packages/voice/src/kokoro-provider.ts';
import { DEFAULT_PLAYBACK_SPEED } from '../../../packages/voice/src/playback.ts';
import type { PlaybackCommand } from '../../../packages/voice/src/playback-controls.ts';
import type { SpokenOutputMode } from '../../../packages/voice/src/voice.ts';
import { createVoiceDiagnostics, type VoiceDiagnosticsSummary } from '../../../packages/voice/src/voice-diagnostics.ts';
import type { PreviewAudio, PreviewRequest, VoiceHostStatus, VoiceProviderStatus } from './voice-host.ts';

export const VOICE_ON_MODE: SpokenOutputMode = 'full';
export const NARRATOR_ONLY_MODE: SpokenOutputMode = 'narrator';
export const MIN_VOLUME = 0;
export const MAX_VOLUME = 1;
export const MAX_NPC_NAME_LENGTH = 60;
const MS_PER_SECOND = 1000;
export const SETUP_STEPS = [
  'closed',
  'checking',
  'consent',
  'downloading',
  'previewing',
  'ready',
  'unavailable',
  'failed',
] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];

export type SpeechPreferences = {
  readonly providerId?: string;
  readonly narratorVoice?: string;
  readonly volume: number;
  readonly npcVoices: Readonly<Record<string, Readonly<Record<string, string>>>>;
};

type NpcVoices = Readonly<Record<string, string>>;
const NO_NPC_VOICES: NpcVoices = {};

export const DEFAULT_SPEECH: SpeechPreferences = { volume: MAX_VOLUME, npcVoices: {} };

export type VoiceBridge = {
  check(): Promise<VoiceHostStatus>;
  download(providerId: string, consent: ModelConsent): Promise<void>;
  remove(providerId: string): Promise<void>;
  preview(request: PreviewRequest): Promise<PreviewAudio>;
  clearCache(): Promise<void>;
  playback(command: PlaybackCommand): Promise<boolean>;
  diagnostics(): Promise<VoiceDiagnosticsSummary | undefined>;
  onProgress(listener: (bytes: number) => void): void;
};

export type AudioOut = {
  play(
    chunks: readonly Uint8Array[],
    volume: number,
  ): Promise<{ readonly decodeMs: number; readonly durationMs?: number }>;
  stop?(): void;
};

type DecodedAudio = { readonly duration: number };
export type AudioContextLike = {
  readonly currentTime: number;
  readonly destination: unknown;
  resume(): Promise<void>;
  decodeAudioData(data: ArrayBuffer): Promise<DecodedAudio>;
  createGain(): { readonly gain: { value: number }; connect(target: unknown): unknown };
  createBufferSource(): {
    buffer: DecodedAudio | null | undefined;
    connect(target: unknown): unknown;
    onended: ((event: Event) => unknown) | null;
    start(at: number): void;
    stop(): void;
  };
};

export const MAX_SPEECH_CHARS = 4000;
const SENTENCE_END = /[.!?…]["')\]]*\s/g;
const WHITESPACE = /\s/g;

const lastMatchEnd = (text: string, pattern: RegExp) => {
  let end = 0;
  for (const match of text.matchAll(pattern)) end = match.index + match[0].length;
  return end;
};

export const splitSpeech = (text: string, limit: number): string[] => {
  const pieces: string[] = [];
  let rest = text.trim();
  while (rest.length > limit) {
    const window = rest.slice(0, limit + 1);
    const cut = lastMatchEnd(window, SENTENCE_END) || lastMatchEnd(window, WHITESPACE) || limit;
    pieces.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest !== '') pieces.push(rest);
  return pieces;
};

export const browserAudio = (context: () => AudioContextLike, now = () => performance.now()): AudioOut => {
  let shared: AudioContextLike | undefined;
  const playing = new Set<ReturnType<AudioContextLike['createBufferSource']>>();
  let stops = 0;
  return {
    stop: () => {
      stops += 1;
      for (const source of playing) source.stop();
      playing.clear();
    },
    play: async (chunks, volume) => {
      shared ??= context();
      const audio = shared;
      await audio.resume();
      const started = now();
      const stopsAtStart = stops;
      const buffers = await Promise.all(chunks.map((chunk) => audio.decodeAudioData(chunk.slice().buffer)));
      const decodeMs = now() - started;
      if (stops !== stopsAtStart) return { decodeMs };
      const gain = audio.createGain();
      gain.gain.value = volume;
      gain.connect(audio.destination);
      const begin = audio.currentTime;
      let at = begin;
      for (const buffer of buffers) {
        const source = audio.createBufferSource();
        source.buffer = buffer;
        source.connect(gain);
        source.onended = () => playing.delete(source);
        source.start(at);
        playing.add(source);
        at += buffer.duration;
      }
      return { decodeMs, durationMs: (at - begin) * MS_PER_SECOND };
    },
  };
};

export type VoiceSetupOptions = {
  readonly bridge?: VoiceBridge;
  readonly audio: AudioOut;
  readonly now?: () => number;
  readonly speech: SpeechPreferences;
  readonly language: () => string;
  readonly campaign: () => string | undefined;
  readonly speakers?: () => readonly string[];
  readonly speed?: () => number;
  readonly saveSpeech: (speech: SpeechPreferences) => void;
  readonly setOutput: (mode: SpokenOutputMode) => void;
  readonly changed: () => void;
};

const OFF: SpokenOutputMode = 'off';
const NO_COUNT = 0;

const isVolume = (value: unknown): value is number =>
  typeof value === 'number' && value >= MIN_VOLUME && value <= MAX_VOLUME;

const isMap = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= NO_COUNT;

const isCounts = (value: unknown) => isMap(value) && Object.values(value).every(isCount);

const isEngineSummary = (value: unknown): value is VoiceDiagnosticsSummary =>
  isMap(value) &&
  isCount(value.samples) &&
  isCount(value.cacheHitRate) &&
  isCounts(value.errors) &&
  isCounts(value.stages) &&
  (value.firstAudioMs === undefined || isCount(value.firstAudioMs)) &&
  (value.peakQueueDepth === undefined || isCount(value.peakQueueDepth));

const isNpcVoices = (value: unknown): value is NpcVoices =>
  isMap(value) &&
  Object.entries(value).every(
    ([name, voice]) => name !== '' && name.length <= MAX_NPC_NAME_LENGTH && typeof voice === 'string' && voice !== '',
  );

export const withoutFlatNpcVoices = (value: unknown): unknown => {
  if (!isMap(value) || !isMap(value.npcVoices)) return value;
  const flat = Object.values(value.npcVoices).some((voices) => typeof voices === 'string');
  return flat ? { ...value, npcVoices: {} } : value;
};

export const isSpeechPreferences = (value: unknown): value is SpeechPreferences => {
  if (!isMap(value)) return false;
  const { providerId, narratorVoice, volume, npcVoices } = value;
  const optionalText = (text: unknown) => text === undefined || (typeof text === 'string' && text !== '');
  return (
    optionalText(providerId) &&
    optionalText(narratorVoice) &&
    isVolume(volume) &&
    isMap(npcVoices) &&
    Object.entries(npcVoices).every(([campaign, voices]) => campaign !== '' && isNpcVoices(voices))
  );
};

export const createVoiceSetup = ({
  bridge,
  audio,
  now = () => performance.now(),
  speech: initial,
  language,
  campaign,
  speakers = () => [],
  speed = () => DEFAULT_PLAYBACK_SPEED,
  saveSpeech,
  setOutput,
  changed,
}: VoiceSetupOptions) => {
  const diagnostics = createVoiceDiagnostics();
  let speech = initial;
  let step: SetupStep = 'closed';
  let status: VoiceHostStatus = { providers: [], cacheBytes: 0 };
  let progress: { bytes: number; total: number } | undefined;
  let error: AudioFailure | undefined;
  let engine: VoiceDiagnosticsSummary | undefined;

  const go = (next: SetupStep) => {
    step = next;
    changed();
  };
  const speaking = () => status.providers.filter((provider) => speaksLanguage(provider, language()));
  const active = (): VoiceProviderStatus | undefined =>
    speaking().find(({ id }) => id === speech.providerId) ?? speaking().find(({ optIn }) => optIn !== true);
  const narratorOf = (provider: VoiceProviderStatus) =>
    speech.narratorVoice !== undefined && provider.voices.includes(speech.narratorVoice)
      ? speech.narratorVoice
      : provider.narrator;
  const hasNpcVoices = (provider: VoiceProviderStatus) =>
    provider.voices.some((voice) => voice !== narratorOf(provider));
  const failed = (cause: unknown) => {
    diagnostics.fail(cause);
    error = classifyAudioFailure(cause);
  };
  const observeEngine = async () => {
    try {
      const summary = await bridge?.diagnostics();
      engine = isEngineSummary(summary) ? summary : undefined;
    } catch {
      engine = undefined;
    }
  };
  const refresh = async () => {
    if (bridge === undefined) return;
    try {
      status = await bridge.check();
    } catch (cause) {
      failed(cause);
    }
    await observeEngine();
    changed();
  };
  const observe = async () => {
    await observeEngine();
    changed();
  };

  const play = async (provider: VoiceProviderStatus, voiceId: string) => {
    if (bridge === undefined) return false;
    try {
      const started = now();
      const { chunks, synthesisMs, cacheHit } = await bridge.preview({
        providerId: provider.id,
        voiceId,
        language: language(),
        speed: speed(),
      });
      const received = now();
      const { decodeMs } = await audio.play(chunks, speech.volume);
      diagnostics.record({
        firstAudioMs: now() - started,
        cacheHit,
        stages: { synthesis: synthesisMs, transfer: Math.max(0, received - started - synthesisMs), decode: decodeMs },
      });
      error = undefined;
      return true;
    } catch (cause) {
      failed(cause);
      return false;
    } finally {
      await refresh();
    }
  };

  const previewSetup = async (provider: VoiceProviderStatus) => {
    go('previewing');
    if (!(await play(provider, narratorOf(provider)))) return go('failed');
    setOutput(hasNpcVoices(provider) ? VOICE_ON_MODE : NARRATOR_ONLY_MODE);
    go('ready');
  };

  const turnOn = async () => {
    error = undefined;
    go('checking');
    await refresh();
    const provider = active();
    if (provider === undefined) return go(error === undefined ? 'unavailable' : 'failed');
    if (provider.installed) return previewSetup(provider);
    go('consent');
  };

  const accept = async () => {
    const provider = active();
    if (step !== 'consent' || provider === undefined || bridge === undefined) return;
    progress = { bytes: 0, total: provider.offer.bytes };
    go('downloading');
    try {
      await bridge.download(provider.id, { accepted: true, ...provider.offer });
    } catch (cause) {
      failed(cause);
      progress = undefined;
      return go('failed');
    }
    progress = undefined;
    await refresh();
    const installed = active();
    if (installed === undefined) return go('failed');
    return previewSetup(installed);
  };

  bridge?.onProgress((bytes) => {
    if (step !== 'downloading' || progress === undefined) return;
    progress = { ...progress, bytes };
    changed();
  });

  const save = (next: SpeechPreferences) => {
    speech = next;
    saveSpeech(next);
    changed();
  };

  const offersVoice = (voice: unknown) => typeof voice === 'string' && active()?.voices.includes(voice) === true;

  const update = (patch: Partial<Pick<SpeechPreferences, 'providerId' | 'narratorVoice' | 'volume'>>) => {
    if ('volume' in patch && !isVolume(patch.volume)) return;
    if ('providerId' in patch && !speaking().some(({ id }) => id === patch.providerId)) return;
    if ('narratorVoice' in patch && !offersVoice(patch.narratorVoice)) return;
    save({ ...speech, ...patch });
  };

  const npcVoicesOf = (id: string | undefined): NpcVoices =>
    id !== undefined && Object.hasOwn(speech.npcVoices, id) ? (speech.npcVoices[id] ?? NO_NPC_VOICES) : NO_NPC_VOICES;

  const saveNpcVoices = (id: string, voices: NpcVoices) => {
    const { [id]: _previous, ...others } = speech.npcVoices;
    save({ ...speech, npcVoices: Object.keys(voices).length === 0 ? others : { ...others, [id]: voices } });
  };

  const forgetCampaign = (id: string) => {
    if (Object.hasOwn(speech.npcVoices, id)) saveNpcVoices(id, NO_NPC_VOICES);
  };

  const setNpcVoice = (name: string, voice: string) => {
    const id = campaign();
    const speaker = name.trim();
    if (id === undefined || speaker === '' || speaker.length > MAX_NPC_NAME_LENGTH || !offersVoice(voice)) return;
    saveNpcVoices(id, { ...npcVoicesOf(id), [speaker]: voice });
  };

  const removeNpcVoice = (name: string) => {
    const id = campaign();
    const voices = npcVoicesOf(id);
    if (id === undefined || !Object.hasOwn(voices, name)) return;
    const { [name]: _removed, ...rest } = voices;
    saveNpcVoices(id, rest);
  };

  const voiceOf = (speaker?: string) => {
    const provider = active();
    if (provider === undefined) return undefined;
    const voices = npcVoicesOf(campaign());
    const override = speaker === undefined || !Object.hasOwn(voices, speaker) ? undefined : voices[speaker];
    return override !== undefined && provider.voices.includes(override) ? override : narratorOf(provider);
  };

  const preview = async (speaker?: string) => {
    const provider = active();
    const voiceId = voiceOf(speaker);
    if (provider !== undefined && voiceId !== undefined) await play(provider, voiceId);
  };

  const previewVoice = async (voiceId: string) => {
    const provider = active();
    if (provider === undefined || !provider.voices.includes(voiceId)) return;
    await play(provider, voiceId);
  };

  const unvoiced = (voices: NpcVoices) => [
    ...new Set(
      speakers()
        .map((name) => name.trim())
        .filter((name) => name !== '' && name.length <= MAX_NPC_NAME_LENGTH && !Object.hasOwn(voices, name)),
    ),
  ];

  const removeModel = async (providerId: string) => {
    if (bridge === undefined) return;
    try {
      await bridge.remove(providerId);
    } catch (cause) {
      failed(cause);
    }
    await refresh();
  };

  const clearCache = async () => {
    if (bridge === undefined) return;
    try {
      await bridge.clearCache();
    } catch (cause) {
      failed(cause);
    }
    await refresh();
  };

  const view = () => {
    const provider = active();
    const npcVoices = npcVoicesOf(campaign());
    return {
      step,
      provider,
      narratorVoice: provider === undefined ? undefined : narratorOf(provider),
      providers: status.providers,
      speaking: speaking(),
      cacheBytes: status.cacheBytes,
      progress,
      error,
      speech,
      npcVoices,
      speakers: unvoiced(npcVoices),
      diagnostics: diagnostics.summary(),
      engine,
    };
  };

  return {
    turnOn,
    accept,
    decline: () => go('closed'),
    finish: () => go('closed'),
    turnOff: () => {
      setOutput(OFF);
      go('closed');
    },
    preview,
    voiceOf,
    previewVoice,
    refresh,
    observe,
    update,
    setNpcVoice,
    forgetCampaign,
    removeNpcVoice,
    removeModel,
    clearCache,
    view,
  };
};

export type VoiceSetup = ReturnType<typeof createVoiceSetup>;
export type VoiceSetupView = ReturnType<VoiceSetup['view']>;
