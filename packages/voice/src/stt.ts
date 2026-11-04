import {
  type AudioInputProvider,
  type Locality,
  resolveVoiceMode,
  type TranscriptSegment,
  type VoiceSettings,
} from './voice.ts';

export const LOW_CONFIDENCE_THRESHOLD = 0.7;

const MIN_CONFIDENCE = 0;
const MAX_CONFIDENCE = 1;
const CLOUD: Locality = 'cloud';

export type TranscriptQuality = 'clear' | 'low-confidence';

export type SttFallbackReason = 'no-consent' | 'provider-unavailable' | 'provider-not-consented' | 'provider-error';

export type SttStatus =
  | { readonly kind: 'listening'; readonly providerId: string; readonly locality: Locality }
  | { readonly kind: 'typed-input-only'; readonly reason: SttFallbackReason };

export interface TranscriptionSession {
  readonly segments: AsyncIterable<TranscriptSegment>;
  status(): SttStatus;
}

export interface TranscriptionOptions {
  readonly settings: VoiceSettings;
  readonly providers: readonly AudioInputProvider[];
  readonly providerId: string;
  readonly audio: AsyncIterable<Uint8Array>;
}

export interface ClarificationDecision {
  readonly decision: 'accept' | 'needs-clarification';
  readonly quality: TranscriptQuality;
}

const typedOnly = (reason: SttFallbackReason): SttStatus => ({ kind: 'typed-input-only', reason });

const selectProvider = (options: TranscriptionOptions): AudioInputProvider | SttFallbackReason => {
  const mode = resolveVoiceMode(options.settings);
  if (mode.kind !== 'voice' || mode.microphone === 'off') return 'no-consent';
  const provider = options.providers.find((candidate) => candidate.id === options.providerId);
  if (!provider) return 'provider-unavailable';
  const consent = options.settings.consent;
  const consentedIds = consent.granted ? consent.providerIds : [];
  if (provider.locality === CLOUD && !consentedIds.includes(provider.id)) return 'provider-not-consented';
  return provider;
};

const isTimestamp = (value: unknown): value is number => Number.isFinite(value) && (value as number) >= 0;

export const isValidSegment = (value: unknown): value is TranscriptSegment => {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.id === 'string' &&
    typeof item.text === 'string' &&
    typeof item.locale === 'string' &&
    typeof item.final === 'boolean' &&
    isTimestamp(item.startMs) &&
    isTimestamp(item.endMs) &&
    item.endMs >= item.startMs &&
    typeof item.confidence === 'number' &&
    item.confidence >= MIN_CONFIDENCE &&
    item.confidence <= MAX_CONFIDENCE
  );
};

export const startTranscription = (options: TranscriptionOptions): TranscriptionSession => {
  const selected = selectProvider(options);
  if (typeof selected === 'string') {
    const status = typedOnly(selected);
    return { segments: (async function* () {})(), status: () => status };
  }
  const provider = selected;
  let current: SttStatus = { kind: 'listening', providerId: provider.id, locality: provider.locality };
  async function* segments(): AsyncGenerator<TranscriptSegment> {
    try {
      for await (const item of provider.transcribe(options.audio)) {
        if (isValidSegment(item)) yield item;
      }
    } catch {
      current = typedOnly('provider-error');
    }
  }
  return { segments: segments(), status: () => current };
};

export const segmentQuality = (segment: TranscriptSegment): TranscriptQuality =>
  segment.confidence >= LOW_CONFIDENCE_THRESHOLD ? 'clear' : 'low-confidence';

export const transcriptQuality = (segments: readonly TranscriptSegment[]): TranscriptQuality =>
  segments.length > 0 && segments.every((segment) => segmentQuality(segment) === 'clear') ? 'clear' : 'low-confidence';

export const decideAction = (segments: readonly TranscriptSegment[], consequential: boolean): ClarificationDecision => {
  const quality = transcriptQuality(segments);
  const decision = quality === 'low-confidence' && consequential ? 'needs-clarification' : 'accept';
  return { decision, quality };
};
