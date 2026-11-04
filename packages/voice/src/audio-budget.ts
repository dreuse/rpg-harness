import { type SpeakOptions, type SpeechChunk, type SpeechOutcome, speakOrText, type TtsProvider } from './tts.ts';
import { type CommittedUtterance, estimateCost, resolveVoiceMode, type UsageRate } from './voice.ts';

export interface AudioCache {
  readonly bytes: number;
  get(key: string): readonly SpeechChunk[] | undefined;
  set(key: string, chunks: readonly SpeechChunk[]): void;
}

const sizeOf = (chunks: readonly SpeechChunk[]): number =>
  chunks.reduce((total, chunk) => total + chunk.audio.byteLength, 0);

export const createAudioCache = (maxBytes: number): AudioCache => {
  if (!Number.isFinite(maxBytes) || maxBytes < 0) throw new RangeError('maxBytes must be a finite number >= 0');
  const entries = new Map<string, readonly SpeechChunk[]>();
  let bytes = 0;
  const remove = (key: string): void => {
    const existing = entries.get(key);
    if (!existing) return;
    entries.delete(key);
    bytes -= sizeOf(existing);
  };
  return {
    get bytes() {
      return bytes;
    },
    get(key) {
      const chunks = entries.get(key);
      if (!chunks) return undefined;
      entries.delete(key);
      entries.set(key, chunks);
      return chunks;
    },
    set(key, chunks) {
      remove(key);
      const size = sizeOf(chunks);
      if (size > maxBytes) return;
      for (const oldest of entries.keys()) {
        if (bytes + size <= maxBytes) break;
        remove(oldest);
      }
      entries.set(key, chunks);
      bytes += size;
    },
  };
};

export const audioCacheKey = (providerId: string, voiceId: string, utterance: CommittedUtterance): string => {
  const { language, pace, style, pronunciations } = utterance.profile;
  const sortedPronunciations = Object.entries(pronunciations).sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify([providerId, voiceId, language, pace, style, sortedPronunciations, utterance.text]);
};

export interface UsageEntry {
  readonly providerId: string;
  readonly voiceId: string;
  readonly units: number;
  readonly amount: number;
  readonly cacheHits: number;
}

export interface UsageReport {
  readonly currency: string;
  readonly cap: number | undefined;
  readonly spent: number;
  readonly remaining: number | undefined;
  readonly entries: readonly UsageEntry[];
}

export interface UsageLedger {
  readonly rate: UsageRate;
  remaining(): number;
  charge(providerId: string, voiceId: string, units: number): void;
  countCacheHit(providerId: string, voiceId: string): void;
  report(): UsageReport;
}

export interface UsageLedgerOptions {
  readonly rate: UsageRate;
  readonly cap?: number;
}

export const createUsageLedger = ({ rate, cap }: UsageLedgerOptions): UsageLedger => {
  if (cap !== undefined && (!Number.isFinite(cap) || cap < 0)) {
    throw new RangeError('cap must be a finite number >= 0');
  }
  const entries = new Map<string, UsageEntry>();
  const update = (providerId: string, voiceId: string, change: (entry: UsageEntry) => UsageEntry): void => {
    const key = JSON.stringify([providerId, voiceId]);
    const entry = entries.get(key) ?? { providerId, voiceId, units: 0, amount: 0, cacheHits: 0 };
    entries.set(key, change(entry));
  };
  const spent = (): number => [...entries.values()].reduce((total, entry) => total + entry.amount, 0);
  const remaining = (): number => (cap === undefined ? Number.POSITIVE_INFINITY : Math.max(0, cap - spent()));
  return {
    rate,
    remaining,
    charge: (providerId, voiceId, units) => {
      const { amount } = estimateCost(rate, units);
      update(providerId, voiceId, (entry) => ({ ...entry, units: entry.units + units, amount: entry.amount + amount }));
    },
    countCacheHit: (providerId, voiceId) =>
      update(providerId, voiceId, (entry) => ({ ...entry, cacheHits: entry.cacheHits + 1 })),
    report: () => ({
      currency: rate.currency,
      cap,
      spent: spent(),
      remaining: cap === undefined ? undefined : remaining(),
      entries: [...entries.values()],
    }),
  };
};

export interface BudgetedSpeakOptions extends Omit<SpeakOptions, 'rate' | 'budget'> {
  readonly ledger: UsageLedger;
  readonly cache?: AudioCache;
  readonly safeToCache?: boolean;
  readonly budget?: number;
}

interface VoiceChoice {
  readonly providerId: string;
  readonly voiceId: string;
}

async function* replay(chunks: readonly SpeechChunk[], utteranceEventId: string): AsyncGenerator<SpeechChunk> {
  for (const chunk of chunks) yield { ...chunk, audio: chunk.audio.slice(), utteranceEventId };
}

async function* store(chunks: AsyncIterable<SpeechChunk>, cache: AudioCache, key: string): AsyncGenerator<SpeechChunk> {
  const collected: SpeechChunk[] = [];
  for await (const chunk of chunks) {
    collected.push({ ...chunk, audio: chunk.audio.slice() });
    yield chunk;
  }
  if (collected.at(-1)?.final) cache.set(key, collected);
}

const findCached = (options: BudgetedSpeakOptions, cache: AudioCache): SpeechOutcome | undefined => {
  const consent = options.settings.consent;
  const consented = consent.granted ? consent.providerIds : [];
  for (const { providerId, voiceId } of options.utterance.profile.fallbacks) {
    if (!consented.includes(providerId)) continue;
    const chunks = cache.get(audioCacheKey(providerId, voiceId, options.utterance));
    if (!chunks) continue;
    options.ledger.countCacheHit(providerId, voiceId);
    return { kind: 'speech', chunks: replay(chunks, options.utterance.eventId) };
  }
  return undefined;
};

const trackChoice = (provider: TtsProvider, onStart: (choice: VoiceChoice) => void): TtsProvider => ({
  id: provider.id,
  locality: provider.locality,
  retention: provider.retention,
  healthy: () => provider.healthy?.() ?? true,
  synthesize: (utterance, voiceId, signal) => {
    onStart({ providerId: provider.id, voiceId });
    return provider.synthesize(utterance, voiceId, signal);
  },
});

export const speakWithBudget = async (options: BudgetedSpeakOptions): Promise<SpeechOutcome> => {
  const mode = resolveVoiceMode(options.settings);
  if (mode.kind !== 'voice' || mode.spokenOutput === 'off') return { kind: 'text', reason: 'voice-off' };
  const cache = options.safeToCache ? options.cache : undefined;
  const cached = cache && !options.signal?.aborted ? findCached(options, cache) : undefined;
  if (cached) return cached;
  let choice: VoiceChoice | undefined;
  const outcome = await speakOrText({
    ...options,
    providers: options.providers.map((provider) => trackChoice(provider, (started) => (choice = started))),
    rate: options.ledger.rate,
    budget: Math.min(options.budget ?? Number.POSITIVE_INFINITY, options.ledger.remaining()),
  });
  if (outcome.kind !== 'speech' || !choice) return outcome;
  options.ledger.charge(choice.providerId, choice.voiceId, options.utterance.text.length);
  if (!cache) return outcome;
  const key = audioCacheKey(choice.providerId, choice.voiceId, options.utterance);
  return { kind: 'speech', chunks: store(outcome.chunks, cache, key) };
};
