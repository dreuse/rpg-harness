import { type IngestFormat, isSafeFileName } from './formats.ts';

export const EXTRACTION_QUALITIES = ['high', 'medium', 'low', 'unknown'] as const;
export type ExtractionQuality = (typeof EXTRACTION_QUALITIES)[number];

const SHA256_HEX = /^[0-9a-f]{64}$/;

export type Locator = { kind: 'known'; page?: number; section?: string; title?: string } | { kind: 'unknown' };
export const UNKNOWN_LOCATOR: Locator = { kind: 'unknown' };

export type Provenance = {
  sourceHash: string;
  fileName: string;
  format: IngestFormat;
  locator: Locator;
  quality: ExtractionQuality;
};

export const isSha256 = (value: string) => SHA256_HEX.test(value);

export function makeProvenance(input: Provenance): Provenance {
  if (!isSha256(input.sourceHash)) throw new Error('sourceHash must be a lowercase sha256 hex string');
  if (!isSafeFileName(input.fileName)) throw new Error('fileName must be a base name');
  const { locator } = input;
  if (locator.kind === 'known' && locator.page === undefined && !locator.section && !locator.title) {
    throw new Error('a known locator needs a page, section or title');
  }
  return input;
}
