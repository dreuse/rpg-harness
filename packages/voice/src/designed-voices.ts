import { DESIGNED_MANIFEST } from './designed-manifest.ts';
import type { CatalogAge, CatalogGender } from './voice-catalog.ts';

export interface DesignedReference {
  readonly file: string;
  readonly url: string;
}

export interface DesignedVoice {
  readonly id: string;
  readonly gender: CatalogGender;
  readonly ages: readonly CatalogAge[];
  readonly timbre: readonly string[];
  readonly licence: string;
  readonly file: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly references: readonly DesignedReference[];
  readonly weights: Readonly<Record<string, number>>;
  readonly seed: number;
  readonly similarity: {
    readonly score: number;
    readonly searchScore: number;
    readonly baselineVoice: string;
    readonly baselineScore: number;
    readonly otherTargetsMax: number;
  };
}

export interface DesignedInput {
  readonly role: string;
  readonly source: string;
  readonly licence: string;
  readonly attribution?: string;
}

export interface DesignedManifest {
  readonly similarityModel: string;
  readonly inputs: readonly DesignedInput[];
  readonly voices: readonly DesignedVoice[];
}

const manifest = DESIGNED_MANIFEST;

export const DESIGNED_INPUTS: readonly DesignedInput[] = Object.freeze(manifest.inputs);

export const DESIGNED_VOICES: readonly DesignedVoice[] = Object.freeze(manifest.voices);

export const designedVoiceOf = (voiceId: string): DesignedVoice | undefined =>
  DESIGNED_VOICES.find(({ id }) => id === voiceId);
