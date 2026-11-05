import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type GmSettings, toGmSettings } from '../../../packages/domain/src/gm.ts';

export const GM_DEFAULTS_FILE = 'gm-settings.json';
const TEXT = 'utf8';

export const readGmDefaults = (dataDir: string): GmSettings => {
  try {
    return toGmSettings(JSON.parse(readFileSync(join(dataDir, GM_DEFAULTS_FILE), TEXT))) ?? {};
  } catch {
    return {};
  }
};

export const writeGmDefaults = (dataDir: string, settings: GmSettings) => {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, GM_DEFAULTS_FILE), JSON.stringify(settings));
};
