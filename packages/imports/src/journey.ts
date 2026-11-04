import type { IngestFormat } from './formats.ts';

export const INGEST_STAGES = ['stage', 'extract', 'interpret', 'compile', 'validate', 'review', 'activate'] as const;
export const STAGE_STATES = ['pending', 'running', 'succeeded', 'failed'] as const;

export type IngestStage = (typeof INGEST_STAGES)[number];
export type StageState = (typeof STAGE_STATES)[number];

export const FAILURE_STAGE = {
  unsupported_format: 'stage',
  mime_mismatch: 'stage',
  size_cap_exceeded: 'stage',
  unsafe_path: 'stage',
  duplicate: 'stage',
  extraction_failed: 'extract',
  encrypted: 'extract',
  scanned_needs_vision: 'extract',
  malformed_structure: 'extract',
  unsafe_archive_entry: 'extract',
  archive_size_exceeded: 'extract',
  low_confidence: 'interpret',
  compile_failed: 'compile',
  validation_failed: 'validate',
  rejected_by_user: 'review',
} as const satisfies Record<string, IngestStage>;

export type FailureKind = keyof typeof FAILURE_STAGE;
export const FAILURE_KINDS = Object.keys(FAILURE_STAGE) as FailureKind[];

export const failureStage = (failure: FailureKind): IngestStage => FAILURE_STAGE[failure];

const STAGE_FAILURES: readonly FailureKind[] = [
  'unsupported_format',
  'mime_mismatch',
  'size_cap_exceeded',
  'unsafe_path',
  'duplicate',
];
const PIPELINE_FAILURES: readonly FailureKind[] = [
  'low_confidence',
  'compile_failed',
  'validation_failed',
  'rejected_by_user',
];

const EXTRACT_FAILURES: Record<IngestFormat, readonly FailureKind[]> = {
  pdf: ['extraction_failed', 'encrypted', 'scanned_needs_vision'],
  docx: ['extraction_failed', 'encrypted', 'scanned_needs_vision', 'unsafe_archive_entry', 'archive_size_exceeded'],
  text: ['extraction_failed'],
  markdown: ['extraction_failed'],
  yaml: ['malformed_structure'],
  json: ['malformed_structure'],
  png: ['extraction_failed', 'scanned_needs_vision'],
  jpg: ['extraction_failed', 'scanned_needs_vision'],
  csv: ['extraction_failed', 'malformed_structure'],
  xlsx: ['extraction_failed', 'encrypted', 'malformed_structure', 'unsafe_archive_entry', 'archive_size_exceeded'],
};

export const failuresFor = (format: IngestFormat): readonly FailureKind[] => [
  ...STAGE_FAILURES,
  ...EXTRACT_FAILURES[format],
  ...PIPELINE_FAILURES,
];

export type Journey = {
  format: IngestFormat;
  states: Record<IngestStage, StageState>;
  failure?: FailureKind;
};

export const newJourney = (format: IngestFormat): Journey => ({
  format,
  states: Object.fromEntries(INGEST_STAGES.map((stage) => [stage, 'pending'])) as Record<IngestStage, StageState>,
});

export function withSuccess(journey: Journey, stage: IngestStage): Journey {
  return { ...journey, states: { ...journey.states, [stage]: 'succeeded' } };
}

export function withFailure(journey: Journey, failure: FailureKind): Journey {
  if (!failuresFor(journey.format).includes(failure)) {
    throw new Error(`${failure} cannot occur for ${journey.format}`);
  }
  const stage = failureStage(failure);
  const earlier = INGEST_STAGES.slice(0, INGEST_STAGES.indexOf(stage));
  if (earlier.some((previous) => journey.states[previous] !== 'succeeded')) {
    throw new Error(`${failure} requires earlier stages to succeed`);
  }
  return { ...journey, states: { ...journey.states, [stage]: 'failed' }, failure };
}
