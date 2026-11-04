export type Locality = 'local' | 'cloud';
export type Retention = 'none' | 'session' | 'persistent';
export type MicrophoneMode = 'off' | 'push-to-talk' | 'hands-free';
export type SpokenOutputMode = 'off' | 'narrator' | 'dialogue' | 'full';

export interface TranscriptSegment {
  readonly id: string;
  readonly text: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly confidence: number;
  readonly final: boolean;
  readonly locale: string;
}

export interface PrivacyDisclosure {
  readonly id: string;
  readonly locality: Locality;
  readonly retention: Retention;
}

export interface AudioInputProvider extends PrivacyDisclosure {
  transcribe(audio: AsyncIterable<Uint8Array>): AsyncIterable<TranscriptSegment>;
}

export interface VoiceProfile {
  readonly id: string;
  readonly language: string;
  readonly pace: number;
  readonly style: string;
  readonly pronunciations: Readonly<Record<string, string>>;
  readonly fallbacks: readonly { readonly providerId: string; readonly voiceId: string }[];
}

export interface CommittedUtterance {
  readonly text: string;
  readonly speakerId: string;
  readonly eventId: string;
  readonly profile: VoiceProfile;
}

export interface AudioOutputProvider extends PrivacyDisclosure {
  speak(utterance: CommittedUtterance): AsyncIterable<Uint8Array>;
}

export interface RealtimeSession {
  readonly segments: AsyncIterable<TranscriptSegment>;
  interrupt(): void;
  close(): void;
}

export interface RealtimeProvider extends PrivacyDisclosure {
  open(profile: VoiceProfile): RealtimeSession;
}

export type VoiceConsent =
  | { readonly granted: false }
  | {
      readonly granted: true;
      readonly grantedAt: string;
      readonly providerIds: readonly string[];
    };

export interface VoiceSettings {
  readonly microphone: MicrophoneMode;
  readonly spokenOutput: SpokenOutputMode;
  readonly consent: VoiceConsent;
}

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  microphone: 'off',
  spokenOutput: 'off',
  consent: { granted: false },
};

export type VoiceMode =
  | { readonly kind: 'typed-input-only' }
  | {
      readonly kind: 'voice';
      readonly microphone: MicrophoneMode;
      readonly spokenOutput: SpokenOutputMode;
    };

const TYPED_INPUT_ONLY: VoiceMode = { kind: 'typed-input-only' };

export const resolveVoiceMode = (settings: VoiceSettings): VoiceMode => {
  const { microphone, spokenOutput, consent } = settings;
  if (!consent.granted || consent.providerIds.length === 0 || (microphone === 'off' && spokenOutput === 'off')) {
    return TYPED_INPUT_ONLY;
  }
  return { kind: 'voice', microphone, spokenOutput };
};

export interface UsageRate {
  readonly unit: string;
  readonly currency: string;
  readonly pricePerUnit: number;
}

export interface CostEstimate {
  readonly unit: string;
  readonly currency: string;
  readonly units: number;
  readonly amount: number;
}

const INVALID_QUANTITY = 'must be a finite number >= 0';

const assertQuantity = (name: string, value: number): void => {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} ${INVALID_QUANTITY}`);
  }
};

export const estimateCost = (rate: UsageRate, units: number): CostEstimate => {
  assertQuantity('units', units);
  assertQuantity('pricePerUnit', rate.pricePerUnit);
  return {
    unit: rate.unit,
    currency: rate.currency,
    units,
    amount: rate.pricePerUnit * units,
  };
};
