import { isAbsolute } from 'node:path';
import type { CampaignStore } from '../../../packages/domain/src/campaign.ts';
import type { Engine } from '../../../packages/engine/src/engine.ts';
import {
  isRulesDocument,
  MAX_RULES_DOCUMENTS,
  type RulesDocument,
  SETTING_DOCUMENT_KIND,
} from '../../../packages/engine/src/own-rules.ts';
import { openScene } from '../../../packages/engine/src/turn.ts';
import { isSafeFileName } from '../../../packages/imports/src/formats.ts';
import { CAMPAIGN_LEVEL, MAX_NAME_LENGTH, PLAYER_VISIBILITY } from '../../../packages/mcp/src/tools.ts';
import { readInside } from '../../cli/src/import-gateway.ts';
import { rulesDocumentOf } from '../../cli/src/own-rules-files.ts';

export const MANIFEST_FILE = 'campaign.json';
export const MAX_STORY_CHARS = 20_000;
const LANGUAGES: readonly unknown[] = ['en', 'pt-BR'];

type Fields = Record<string, unknown>;

const parseManifest = (bytes: Uint8Array): Fields => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error(`${MANIFEST_FILE} is not valid JSON.`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    throw new Error(`${MANIFEST_FILE} must be a JSON object.`);
  return parsed as Fields;
};

const textField = (fields: Fields, key: string, limit: number) => {
  const value = fields[key];
  if (typeof value !== 'string' || value.trim() === '' || value.length > limit)
    throw new Error(`${MANIFEST_FILE}: ${key} must be a text of 1 to ${limit} characters.`);
  return value;
};

const fileList = (fields: Fields, key: string) => {
  const value = fields[key];
  if (!Array.isArray(value) || !value.every((file) => typeof file === 'string' && isSafeFileName(file)))
    throw new Error(`${MANIFEST_FILE}: ${key} must be a list of file names without folders.`);
  return value as string[];
};

const languageOf = (fields: Fields) => {
  const { language } = fields;
  if (language !== undefined && !LANGUAGES.includes(language))
    throw new Error(`${MANIFEST_FILE}: language must be one of ${LANGUAGES.join(', ')}.`);
  return language as string | undefined;
};

const documentOf = (folder: string, file: string, kind?: typeof SETTING_DOCUMENT_KIND): RulesDocument => {
  const { fileName, bytes } = readInside(folder, file);
  const document = rulesDocumentOf(fileName, bytes, kind);
  if (!isRulesDocument(document)) throw new Error(`${file} is not a valid rules document.`);
  return document;
};

export const importCampaign = (engine: Engine, store: CampaignStore, folder: string) => {
  if (!isAbsolute(folder)) throw new Error('The folder must be an absolute path.');
  const manifest = parseManifest(readInside(folder, MANIFEST_FILE).bytes);
  const name = textField(manifest, 'name', MAX_NAME_LENGTH);
  const hero = textField(manifest, 'hero', MAX_NAME_LENGTH);
  const scene = textField(manifest, 'scene', MAX_NAME_LENGTH);
  const situation = textField(manifest, 'situation', MAX_STORY_CHARS);
  const storySoFar = textField(manifest, 'storySoFar', MAX_STORY_CHARS);
  const language = languageOf(manifest);
  const rules = fileList(manifest, 'rules');
  const setting = fileList(manifest, 'setting');
  if (rules.length + setting.length > MAX_RULES_DOCUMENTS)
    throw new Error(`Import at most ${MAX_RULES_DOCUMENTS} rules and setting files in total.`);
  const rulesDocuments = [
    ...rules.map((file) => documentOf(folder, file)),
    ...setting.map((file) => documentOf(folder, file, SETTING_DOCUMENT_KIND)),
  ];

  const { id: campaignId } = engine.createCampaign(name, language);
  const opening = openScene(store, {
    campaignId,
    actorName: hero,
    sceneTitle: scene,
    narration: situation,
    rulesDocuments,
  });
  engine.recordSummary({
    campaignId,
    actionId: crypto.randomUUID(),
    expectedRevision: engine.getState(campaignId).revision,
    level: CAMPAIGN_LEVEL,
    scopeId: campaignId,
    summary: {
      id: crypto.randomUUID(),
      campaignId,
      text: storySoFar,
      sourceEventIds: opening.events.map(({ id }) => id),
      visibility: PLAYER_VISIBILITY,
      actorId: null,
    },
  });
  return campaignId;
};
