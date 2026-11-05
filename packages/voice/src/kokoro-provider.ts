import { clamp, finiteOr, pitchRatio, shapeAudio, shapeSentences, shiftPitch } from './delivery-shaping.ts';
import { MAX_RATE, MIN_RATE } from './prosody.ts';
import type { SpeechChunk, TtsProvider } from './tts.ts';
import type { CommittedUtterance, Delivery } from './voice.ts';
import { mannerDelivery } from './voice-catalog.ts';

export interface VoiceBlend {
  readonly first: string;
  readonly second: string;
  readonly weight: number;
}

export interface KokoroEngine {
  readonly blends?: boolean;
  ready(): boolean;
  load(): Promise<void>;
  synthesize(
    sentence: string,
    voiceId: string,
    signal: AbortSignal,
    speed: number,
    blend?: VoiceBlend,
  ): Promise<Uint8Array>;
  unload(): Promise<void>;
}

export interface KokoroCapabilities {
  readonly languages: readonly string[];
  readonly voices: readonly string[];
  readonly streaming: boolean;
  readonly emotion: boolean;
}

export interface KokoroProviderOptions {
  readonly engine: KokoroEngine;
  readonly id?: string;
  readonly capabilities?: KokoroCapabilities;
  readonly idleTimeoutMs?: number;
  readonly maxConcurrent?: number;
  readonly shaping?: boolean;
  readonly voiceBlend?: (speakerId: string, voiceId: string) => VoiceBlend | undefined;
}

export interface KokoroProvider extends TtsProvider {
  readonly capabilities: KokoroCapabilities;
  healthy(): boolean;
  preload(): Promise<void>;
  dispose(): Promise<void>;
}

export const KOKORO_PROVIDER_ID = 'kokoro';
export const MLX_KOKORO_PROVIDER_ID = 'kokoro-mlx';
export const KOKORO_IDLE_TIMEOUT_MS = 300_000;
export const KOKORO_MAX_CONCURRENT = 1;
export const KOKORO_MIME_TYPE = 'audio/wav';

const ENGLISH = 'en';

export const KOKORO_CAPABILITIES: KokoroCapabilities = Object.freeze({
  languages: Object.freeze([ENGLISH]),
  voices: Object.freeze([
    'af_heart',
    'af_alloy',
    'af_aoede',
    'af_bella',
    'af_jessica',
    'af_kore',
    'af_nicole',
    'af_nova',
    'af_river',
    'af_sarah',
    'af_sky',
    'am_adam',
    'am_echo',
    'am_eric',
    'am_fenrir',
    'am_liam',
    'am_michael',
    'am_onyx',
    'am_puck',
    'am_santa',
    'bf_emma',
    'bf_isabella',
    'bm_george',
    'bm_lewis',
    'bf_alice',
    'bf_lily',
    'bm_daniel',
    'bm_fable',
  ]),
  streaming: true,
  emotion: false,
});

export const KOKORO_DELIVERY_SPEED = Object.freeze({
  neutral: 1,
  calm: 0.9,
  sad: 0.85,
  tender: 0.9,
  whisper: 0.8,
  happy: 1.1,
  tense: 1.1,
  angry: 1.15,
  fearful: 1.2,
  excited: 1.25,
});

type DeliveryEmotion = keyof typeof KOKORO_DELIVERY_SPEED;

const NEUTRAL_SPEED = KOKORO_DELIVERY_SPEED.neutral;
const FULL_INTENSITY = 1;
const NO_INTENSITY = 0;

const isEmotion = (emotion: unknown): emotion is DeliveryEmotion =>
  typeof emotion === 'string' && Object.hasOwn(KOKORO_DELIVERY_SPEED, emotion);

export const kokoroSpeed = (delivery: Delivery | undefined, profilePace?: number): number => {
  const emotionSpeed = isEmotion(delivery?.emotion) ? KOKORO_DELIVERY_SPEED[delivery.emotion] : NEUTRAL_SPEED;
  const intensity = clamp(finiteOr(delivery?.intensity, FULL_INTENSITY), NO_INTENSITY, FULL_INTENSITY);
  const pace = finiteOr(delivery?.pace, NEUTRAL_SPEED) * finiteOr(profilePace, NEUTRAL_SPEED);
  return clamp(pace * (NEUTRAL_SPEED + (emotionSpeed - NEUTRAL_SPEED) * intensity), MIN_RATE, MAX_RATE);
};

const localeOf = (tag: string): Intl.Locale | undefined => {
  try {
    return new Intl.Locale(tag);
  } catch {
    return undefined;
  }
};

export const speaksLanguage = (capabilities: Pick<KokoroCapabilities, 'languages'>, tag: string): boolean => {
  const wanted = localeOf(tag)?.maximize();
  return capabilities.languages.some((entry) => {
    const offered = localeOf(entry);
    return (
      offered !== undefined &&
      offered.language === wanted?.language &&
      (offered.region === undefined || offered.region === wanted.region)
    );
  });
};

const supports = (capabilities: KokoroCapabilities, utterance: CommittedUtterance, voiceId: string): boolean =>
  speaksLanguage(capabilities, utterance.profile.language) && capabilities.voices.includes(voiceId);

const MIN_CONCURRENT = 1;
const NO_WEIGHT = 0;
const FULL_WEIGHT = 1;

const usableBlend = (
  capabilities: KokoroCapabilities,
  voiceId: string,
  blend: VoiceBlend | undefined,
): VoiceBlend | undefined =>
  blend !== undefined &&
  blend.first === voiceId &&
  blend.second !== voiceId &&
  capabilities.voices.includes(blend.second) &&
  blend.weight > NO_WEIGHT &&
  blend.weight < FULL_WEIGHT
    ? blend
    : undefined;

const assertOptions = (idleTimeoutMs: number, maxConcurrent: number): void => {
  if (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs <= 0) {
    throw new RangeError('idleTimeoutMs must be a finite number > 0');
  }
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < MIN_CONCURRENT) {
    throw new RangeError('maxConcurrent must be an integer >= 1');
  }
};

export const createKokoroProvider = ({
  engine,
  id = KOKORO_PROVIDER_ID,
  capabilities = KOKORO_CAPABILITIES,
  idleTimeoutMs = KOKORO_IDLE_TIMEOUT_MS,
  maxConcurrent = KOKORO_MAX_CONCURRENT,
  shaping = true,
  voiceBlend,
}: KokoroProviderOptions): KokoroProvider => {
  assertOptions(idleTimeoutMs, maxConcurrent);
  let loaded: Promise<void> | undefined;
  let unloading: Promise<void> = Promise.resolve();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let active = 0;
  const waiting: Array<() => void> = [];

  const unload = (): Promise<void> => {
    clearTimeout(idleTimer);
    idleTimer = undefined;
    if (!loaded) return unloading;
    const previous = loaded;
    loaded = undefined;
    unloading = previous.then(() => engine.unload()).catch(() => undefined);
    return unloading;
  };

  const ensureLoaded = (): Promise<void> => {
    loaded ??= unloading
      .then(() => engine.load())
      .catch((error: unknown) => {
        loaded = undefined;
        throw error;
      });
    return loaded;
  };

  const armIdleTimer = (): void => {
    idleTimer = setTimeout(() => void unload(), idleTimeoutMs);
    idleTimer.unref?.();
  };

  const acquire = (signal: AbortSignal): Promise<boolean> =>
    new Promise((resolve) => {
      if (signal.aborted) return resolve(false);
      clearTimeout(idleTimer);
      if (active < maxConcurrent) {
        active += 1;
        return resolve(true);
      }
      const cancel = () => {
        waiting.splice(waiting.indexOf(grant), 1);
        resolve(false);
      };
      const grant = () => {
        signal.removeEventListener('abort', cancel);
        resolve(true);
      };
      waiting.push(grant);
      signal.addEventListener('abort', cancel, { once: true });
    });

  const release = (): void => {
    const next = waiting.shift();
    if (next) {
      next();
      return;
    }
    active -= 1;
    if (active === 0) armIdleTimer();
  };

  const synthesizeSentence = async (
    sentence: string,
    voiceId: string,
    signal: AbortSignal,
    speed: number,
    blend: VoiceBlend | undefined,
  ): Promise<Uint8Array | undefined> => {
    if (!(await acquire(signal))) return undefined;
    try {
      await ensureLoaded();
      return await engine.synthesize(sentence, voiceId, signal, speed, blend);
    } finally {
      release();
    }
  };

  return {
    id,
    locality: 'local',
    retention: 'none',
    capabilities,
    healthy: () => engine.ready(),
    preload: async () => {
      await ensureLoaded();
      if (active === 0) {
        clearTimeout(idleTimer);
        armIdleTimer();
      }
    },
    dispose: unload,
    async *synthesize(utterance, voiceId, signal): AsyncGenerator<SpeechChunk> {
      if (!supports(capabilities, utterance, voiceId)) return;
      const sentences = shapeSentences(utterance.text, utterance.delivery);
      const manner = mannerDelivery(utterance.profile.manner);
      const speed = kokoroSpeed(utterance.delivery, (utterance.profile.pace * manner.pace) / pitchRatio(manner.pitch));
      const blend = engine.blends
        ? usableBlend(capabilities, voiceId, voiceBlend?.(utterance.speakerId, voiceId))
        : undefined;
      for (const [sequence, { sentence, pauseMs }] of sentences.entries()) {
        const synthesized = await synthesizeSentence(sentence, voiceId, signal, speed, blend);
        if (!synthesized || signal.aborted) return;
        const audio = shiftPitch(synthesized, manner.pitch);
        yield {
          utteranceEventId: utterance.eventId,
          sequence,
          audio: shaping ? shapeAudio(audio, pauseMs) : audio,
          mimeType: KOKORO_MIME_TYPE,
          voiceId,
          final: sequence === sentences.length - 1,
        };
      }
    },
  };
};

export const MLX_KOKORO_CAPABILITIES: KokoroCapabilities = Object.freeze({
  languages: Object.freeze(['pt-BR']),
  voices: Object.freeze(['pf_dora', 'pm_alex', 'pm_santa']),
  streaming: true,
  emotion: false,
});
