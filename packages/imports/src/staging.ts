import { createHash } from 'node:crypto';
import { type ClassifyFailure, classifyFile, type IngestFormat, isSafeFileName } from './formats.ts';
import { type Journey, newJourney, withFailure, withSuccess } from './journey.ts';
import { makeProvenance, type Provenance, UNKNOWN_LOCATOR } from './provenance.ts';

const HEAD_BYTES = 4096;
const SOURCE_ID_PREFIX = 'source-';
const SOURCE_ID_SEPARATOR = '\0';

export type StageInput = { fileName: string; bytes: Uint8Array };
export type StagedDocument = {
  ok: true;
  fileName: string;
  format: IngestFormat;
  size: number;
  sha256: string;
  sourceId: string;
  provenance: Provenance;
  journey: Journey;
};
export type StageFailure = {
  ok: false;
  fileName?: string;
  failure: ClassifyFailure | 'duplicate';
  journey?: Journey;
};
export type StageResult = StagedDocument | StageFailure;

const sha256 = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex');

const sourceIdFor = (hash: string, fileName: string) =>
  SOURCE_ID_PREFIX + sha256(hash + SOURCE_ID_SEPARATOR + fileName);

export function stageDocuments(inputs: readonly StageInput[]): StageResult[] {
  const seen = new Set<string>();
  return inputs.map(({ fileName, bytes }): StageResult => {
    const classified = classifyFile({ fileName, size: bytes.length, head: bytes.subarray(0, HEAD_BYTES) });
    if (!classified.ok) {
      return isSafeFileName(fileName)
        ? { ok: false, fileName, failure: classified.failure }
        : { ok: false, failure: classified.failure };
    }
    const { format } = classified;
    const hash = sha256(bytes);
    if (seen.has(hash))
      return { ok: false, fileName, failure: 'duplicate', journey: withFailure(newJourney(format), 'duplicate') };
    seen.add(hash);
    return {
      ok: true,
      fileName,
      format,
      size: bytes.length,
      sha256: hash,
      sourceId: sourceIdFor(hash, fileName),
      provenance: makeProvenance({ sourceHash: hash, fileName, format, locator: UNKNOWN_LOCATOR, quality: 'unknown' }),
      journey: withSuccess(newJourney(format), 'stage'),
    };
  });
}
