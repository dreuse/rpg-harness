import type { SpeechChunk, TtsProvider } from './tts.ts';
import type { CommittedUtterance } from './voice.ts';

export interface KokoroEngine {
  ready(): boolean;
  load(): Promise<void>;
  synthesize(sentence: string, voiceId: string, signal: AbortSignal): Promise<Uint8Array>;
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
  readonly idleTimeoutMs?: number;
  readonly maxConcurrent?: number;
}

export interface KokoroProvider extends TtsProvider {
  readonly capabilities: KokoroCapabilities;
  healthy(): boolean;
  dispose(): Promise<void>;
}

export const KOKORO_PROVIDER_ID = 'kokoro';
export const KOKORO_IDLE_TIMEOUT_MS = 300_000;
export const KOKORO_MAX_CONCURRENT = 1;
export const KOKORO_MIME_TYPE = 'audio/wav';

const ENGLISH = 'en';
const LANGUAGE_SUBTAG_SEPARATOR = '-';

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

const sentenceSegmenter = new Intl.Segmenter(ENGLISH, { granularity: 'sentence' });

const splitSentences = (text: string): string[] =>
  [...sentenceSegmenter.segment(text)].map(({ segment }) => segment.trim()).filter((sentence) => sentence !== '');

const primaryLanguage = (tag: string): string => (tag.split(LANGUAGE_SUBTAG_SEPARATOR)[0] ?? '').toLowerCase();

const supports = (utterance: CommittedUtterance, voiceId: string): boolean =>
  KOKORO_CAPABILITIES.languages.includes(primaryLanguage(utterance.profile.language)) &&
  KOKORO_CAPABILITIES.voices.includes(voiceId);

const MIN_CONCURRENT = 1;

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
  idleTimeoutMs = KOKORO_IDLE_TIMEOUT_MS,
  maxConcurrent = KOKORO_MAX_CONCURRENT,
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
    if (active === 0) {
      idleTimer = setTimeout(() => void unload(), idleTimeoutMs);
      idleTimer.unref?.();
    }
  };

  const synthesizeSentence = async (
    sentence: string,
    voiceId: string,
    signal: AbortSignal,
  ): Promise<Uint8Array | undefined> => {
    if (!(await acquire(signal))) return undefined;
    try {
      await ensureLoaded();
      return await engine.synthesize(sentence, voiceId, signal);
    } finally {
      release();
    }
  };

  return {
    id: KOKORO_PROVIDER_ID,
    locality: 'local',
    retention: 'none',
    capabilities: KOKORO_CAPABILITIES,
    healthy: () => engine.ready(),
    dispose: unload,
    async *synthesize(utterance, voiceId, signal): AsyncGenerator<SpeechChunk> {
      if (!supports(utterance, voiceId)) return;
      const sentences = splitSentences(utterance.text);
      for (const [sequence, sentence] of sentences.entries()) {
        const audio = await synthesizeSentence(sentence, voiceId, signal);
        if (!audio || signal.aborted) return;
        yield {
          utteranceEventId: utterance.eventId,
          sequence,
          audio,
          mimeType: KOKORO_MIME_TYPE,
          voiceId,
          final: sequence === sentences.length - 1,
        };
      }
    },
  };
};
