import type { IngestFormat } from './formats.ts';
import { type Journey, withFailure, withSuccess } from './journey.ts';
import { type ExtractionQuality, type Locator, makeProvenance, UNKNOWN_LOCATOR } from './provenance.ts';
import type { StagedDocument } from './staging.ts';
import { type UntrustedContent, wrapUntrusted } from './untrusted.ts';

const FIRST_PAGE = 1;

type RawPlacement = { section?: string; quality: ExtractionQuality };
export type RawBlock =
  | (RawPlacement & { type: 'text'; text: string })
  | (RawPlacement & { type: 'table'; rows: readonly (readonly string[])[] });
export type RawPage = { page?: number; blocks: readonly RawBlock[]; image?: Uint8Array };
export type ScannedPage = { page: number | undefined; image: Uint8Array };

export type PageReader = (bytes: Uint8Array, format: IngestFormat) => readonly RawPage[] | Promise<readonly RawPage[]>;
export type VisionFallback = (scan: ScannedPage) => Promise<readonly RawBlock[]>;
export type ExtractOptions = { readPages: PageReader; vision?: VisionFallback };

export type ExtractedBlock =
  | { type: 'text'; content: UntrustedContent }
  | { type: 'table'; rows: readonly (readonly UntrustedContent[])[] };
export type ExtractionMethod = 'text' | 'vision' | 'none';
export type ExtractedPage = {
  page?: number;
  complete: boolean;
  method: ExtractionMethod;
  blocks: readonly ExtractedBlock[];
};
export type Extraction = {
  sourceId: string;
  complete: boolean;
  pages: readonly ExtractedPage[];
  journey: Journey;
};

const isPageNumber = (page: number | undefined): page is number =>
  typeof page === 'number' && Number.isSafeInteger(page) && page >= FIRST_PAGE;

function locatorFor(page: number | undefined, section: string | undefined): Locator {
  const known = { ...(isPageNumber(page) && { page }), ...(section && { section }) };
  return Object.keys(known).length ? { kind: 'known', ...known } : UNKNOWN_LOCATOR;
}

function toBlock(document: StagedDocument, page: number | undefined, raw: RawBlock): ExtractedBlock {
  const provenance = makeProvenance({
    ...document.provenance,
    locator: locatorFor(page, raw.section),
    quality: raw.quality,
  });
  const wrap = (text: string) => wrapUntrusted(text, provenance);
  return raw.type === 'text'
    ? { type: 'text', content: wrap(raw.text) }
    : { type: 'table', rows: raw.rows.map((row) => row.map(wrap)) };
}

async function readScan(vision: VisionFallback | undefined, scan: ScannedPage) {
  if (!vision) return undefined;
  try {
    return await vision(scan);
  } catch {
    return undefined;
  }
}

async function extractPage(document: StagedDocument, raw: RawPage, vision?: VisionFallback): Promise<ExtractedPage> {
  const page = isPageNumber(raw.page) ? raw.page : undefined;
  const at = page === undefined ? {} : { page };
  const build = (method: ExtractionMethod, blocks: readonly RawBlock[]): ExtractedPage => ({
    ...at,
    complete: method !== 'none',
    method,
    blocks: blocks.map((block) => toBlock(document, page, block)),
  });
  if (raw.blocks.length || !raw.image) return build('text', raw.blocks);
  const recognised = await readScan(vision, { page, image: raw.image });
  return recognised?.length ? build('vision', recognised) : build('none', []);
}

export async function extractDocument(
  document: StagedDocument,
  bytes: Uint8Array,
  { readPages, vision }: ExtractOptions,
): Promise<Extraction> {
  const raw = await readPages(bytes, document.format);
  const pages = await Promise.all(raw.map((page) => extractPage(document, page, vision)));
  const complete = pages.every((page) => page.complete);
  return {
    sourceId: document.sourceId,
    complete,
    pages,
    journey: complete
      ? withSuccess(document.journey, 'extract')
      : withFailure(document.journey, 'scanned_needs_vision'),
  };
}
