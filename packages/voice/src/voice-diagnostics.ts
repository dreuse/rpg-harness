import { type AudioFailure, classifyAudioFailure } from './fallback.ts';
import type { SpeechMetrics } from './streaming-speech.ts';

export const VOICE_STAGES = ['synthesis', 'transfer', 'decode'] as const;
export type VoiceStage = (typeof VOICE_STAGES)[number];

export interface SpeechSample {
  readonly firstAudioMs: number;
  readonly cacheHit: boolean;
  readonly stages: Partial<Record<VoiceStage, number>>;
}

export interface VoiceDiagnosticsSummary {
  readonly samples: number;
  readonly firstAudioMs?: number;
  readonly cacheHitRate: number;
  readonly errors: Partial<Record<AudioFailure, number>>;
  readonly stages: Partial<Record<VoiceStage, number>>;
  readonly peakQueueDepth?: number;
}

export interface VoiceDiagnostics {
  record(sample: SpeechSample): void;
  fail(error: unknown): void;
  observeQueueDepth(depth: number): void;
  summary(): VoiceDiagnosticsSummary;
  reset(): void;
}

const NO_RATE = 0;
const HALF = 2;

const isDuration = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

const median = (values: readonly number[]): number | undefined => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor((sorted.length - 1) / HALF)];
};

const stagesOf = (stages: unknown): Partial<Record<VoiceStage, number>> => {
  if (typeof stages !== 'object' || stages === null) return {};
  const record = stages as Record<string, unknown>;
  return Object.fromEntries(
    VOICE_STAGES.flatMap((stage) => (isDuration(record[stage]) ? [[stage, record[stage]]] : [])),
  );
};

export const createVoiceDiagnostics = (): VoiceDiagnostics => {
  let samples: SpeechSample[] = [];
  let errors: Partial<Record<AudioFailure, number>> = {};
  let peakQueueDepth: number | undefined;
  return {
    record: ({ firstAudioMs, cacheHit, stages }) => {
      if (!isDuration(firstAudioMs) || typeof cacheHit !== 'boolean') return;
      samples.push({ firstAudioMs, cacheHit, stages: stagesOf(stages) });
    },
    fail: (error) => {
      const code = classifyAudioFailure(error);
      errors = { ...errors, [code]: (errors[code] ?? 0) + 1 };
    },
    observeQueueDepth: (depth) => {
      if (isDuration(depth)) peakQueueDepth = Math.max(peakQueueDepth ?? depth, depth);
    },
    summary: () => {
      const firstAudioMs = median(samples.map((sample) => sample.firstAudioMs));
      const stages = VOICE_STAGES.flatMap((stage) => {
        const value = median(
          samples.flatMap(({ stages: timed }) => (timed[stage] === undefined ? [] : [timed[stage]])),
        );
        return value === undefined ? [] : [[stage, value] as const];
      });
      return {
        samples: samples.length,
        ...(firstAudioMs === undefined ? {} : { firstAudioMs }),
        cacheHitRate:
          samples.length === 0 ? NO_RATE : samples.filter(({ cacheHit }) => cacheHit).length / samples.length,
        errors: { ...errors },
        stages: Object.fromEntries(stages),
        ...(peakQueueDepth === undefined ? {} : { peakQueueDepth }),
      };
    },
    reset: () => {
      samples = [];
      errors = {};
      peakQueueDepth = undefined;
    },
  };
};

const NO_CACHE_HIT = false;
const SYNTHESIS_FAILED = 'synthesis-failed';

export const streamingMetricsSink = (diagnostics: VoiceDiagnostics): ((metrics: SpeechMetrics) => void) => {
  let synthesisMs: number | undefined;
  return (metrics) => {
    if (metrics.kind === 'error') diagnostics.fail(new Error(SYNTHESIS_FAILED));
    else if (metrics.kind === 'queue-depth') diagnostics.observeQueueDepth(metrics.depth);
    else if (metrics.kind === 'synthesis') synthesisMs = metrics.ms;
    else {
      diagnostics.record({
        firstAudioMs: metrics.ms,
        cacheHit: NO_CACHE_HIT,
        stages: synthesisMs === undefined ? {} : { synthesis: synthesisMs },
      });
      synthesisMs = undefined;
    }
  };
};
