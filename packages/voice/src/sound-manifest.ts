import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const SOUND_KINDS = ['ambience', 'effect', 'music'] as const;
export type SoundKind = (typeof SOUND_KINDS)[number];

export interface SoundEntry {
  readonly kind: SoundKind;
  readonly key: string;
  readonly file: string;
  readonly mimeType: string;
  readonly url: string;
  readonly sourcePage: string;
  readonly author: string;
  readonly license: typeof CC0_LICENSE;
  readonly sha256: string;
  readonly bytes: number;
}

export interface SoundManifestIssue {
  readonly index: number;
  readonly field: string;
}

export type SoundManifestResult =
  | { readonly ok: true; readonly sounds: readonly SoundEntry[] }
  | { readonly ok: false; readonly issues: readonly SoundManifestIssue[] };

export const CC0_LICENSE = 'CC0';
export const MANIFEST_VERSION = 1;
export const BUNDLED_MANIFEST_PATH = join(import.meta.dirname, '..', 'sounds', 'manifest.json');

const NOT_AN_ENTRY = -1;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const SAFE_FILE = /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/;
const HTTPS = 'https:';
const TEXT = 'utf8';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isText = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';

const isHttps = (value: unknown): boolean => {
  try {
    return typeof value === 'string' && new URL(value).protocol === HTTPS;
  } catch {
    return false;
  }
};

const FIELD_CHECKS: readonly (readonly [string, (value: unknown) => boolean])[] = [
  ['kind', (value) => SOUND_KINDS.some((kind) => kind === value)],
  ['key', isText],
  ['file', (value) => typeof value === 'string' && SAFE_FILE.test(value)],
  ['mimeType', isText],
  ['url', isHttps],
  ['sourcePage', isHttps],
  ['author', isText],
  ['license', (value) => value === CC0_LICENSE],
  ['sha256', (value) => typeof value === 'string' && SHA256_HEX.test(value)],
  ['bytes', (value) => Number.isSafeInteger(value) && (value as number) > 0],
];

export const validateSoundManifest = (value: unknown): SoundManifestResult => {
  if (!isRecord(value) || value.version !== MANIFEST_VERSION || !Array.isArray(value.sounds)) {
    return { ok: false, issues: [{ index: NOT_AN_ENTRY, field: 'version' }] };
  }
  const issues: SoundManifestIssue[] = [];
  const seen = new Set<string>();
  value.sounds.forEach((sound: unknown, index: number) => {
    const record = isRecord(sound) ? sound : {};
    for (const [field, valid] of FIELD_CHECKS) if (!valid(record[field])) issues.push({ index, field });
    const identity = `${String(record.kind)}:${String(record.key)}`;
    if (seen.has(identity)) issues.push({ index, field: 'key' });
    seen.add(identity);
  });
  return issues.length > 0 ? { ok: false, issues } : { ok: true, sounds: value.sounds as readonly SoundEntry[] };
};

export const loadBundledManifest = (): readonly SoundEntry[] => {
  const result = validateSoundManifest(JSON.parse(readFileSync(BUNDLED_MANIFEST_PATH, TEXT)));
  if (!result.ok) throw new Error(`sound manifest rejected: ${JSON.stringify(result.issues)}`);
  return result.sounds;
};
