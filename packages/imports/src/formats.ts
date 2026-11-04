export const INGEST_FORMATS = ['pdf', 'docx', 'text', 'markdown', 'yaml', 'json', 'png', 'jpg', 'csv', 'xlsx'] as const;
export type IngestFormat = (typeof INGEST_FORMATS)[number];

const BYTES_PER_MIB = 1024 * 1024;
const MAX_IMPORT_MIB = 50;
export const MAX_IMPORT_BYTES = MAX_IMPORT_MIB * BYTES_PER_MIB;

const EXTENSION_FORMATS: Record<string, IngestFormat> = {
  pdf: 'pdf',
  docx: 'docx',
  txt: 'text',
  md: 'markdown',
  markdown: 'markdown',
  yaml: 'yaml',
  yml: 'yaml',
  json: 'json',
  png: 'png',
  jpg: 'jpg',
  jpeg: 'jpg',
  csv: 'csv',
  xlsx: 'xlsx',
};

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d];
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_MAGIC = [0xff, 0xd8, 0xff];
const BINARY_MAGIC: Partial<Record<IngestFormat, number[]>> = {
  pdf: PDF_MAGIC,
  docx: ZIP_MAGIC,
  xlsx: ZIP_MAGIC,
  png: PNG_MAGIC,
  jpg: JPEG_MAGIC,
};
const NUL_BYTE = 0x00;
const PATH_SEPARATORS = /[/\\]/;
const DRIVE_SEPARATOR = ':';
const CONTROL_CHARS = /\p{Cc}/u;
const PARENT_SEGMENT = '..';

export type ClassifyFailure = 'unsupported_format' | 'mime_mismatch' | 'size_cap_exceeded' | 'unsafe_path';
export type ClassifyResult = { ok: true; format: IngestFormat } | { ok: false; failure: ClassifyFailure };
export type FileProbe = { fileName: string; size: number; head: Uint8Array };

const startsWith = (head: Uint8Array, magic: number[]) => magic.every((byte, index) => head[index] === byte);

const matchesContent = (format: IngestFormat, head: Uint8Array): boolean => {
  const magic = BINARY_MAGIC[format];
  return magic ? startsWith(head, magic) : !head.includes(NUL_BYTE);
};

export const isSafeFileName = (fileName: string) =>
  fileName.length > 0 &&
  fileName !== PARENT_SEGMENT &&
  !fileName.includes(DRIVE_SEPARATOR) &&
  !PATH_SEPARATORS.test(fileName) &&
  !CONTROL_CHARS.test(fileName);

const isValidSize = (size: number) => Number.isSafeInteger(size) && size >= 0 && size <= MAX_IMPORT_BYTES;

export function classifyFile({ fileName, size, head }: FileProbe): ClassifyResult {
  if (!isSafeFileName(fileName)) return { ok: false, failure: 'unsafe_path' };
  const dot = fileName.lastIndexOf('.');
  if (dot <= 0) return { ok: false, failure: 'unsupported_format' };
  const extension = fileName.slice(dot + 1).toLowerCase();
  const format = Object.hasOwn(EXTENSION_FORMATS, extension) ? EXTENSION_FORMATS[extension] : undefined;
  if (!format) return { ok: false, failure: 'unsupported_format' };
  if (!isValidSize(size)) return { ok: false, failure: 'size_cap_exceeded' };
  if (!matchesContent(format, head)) return { ok: false, failure: 'mime_mismatch' };
  return { ok: true, format };
}
