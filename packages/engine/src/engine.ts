import { randomUUID } from 'node:crypto';
import {
  CAMPAIGN_CREATED,
  CAMPAIGN_LANGUAGE_CHANGED,
  CAMPAIGN_RENAMED,
  type Campaign,
  type CampaignChange,
  type CampaignEvent,
  type CampaignId,
  CampaignNotFoundError,
  type CampaignState,
  type CampaignStore,
  type CommittedTurn,
  MAIN_BRANCH,
} from '../../domain/src/campaign.ts';
import type { GmSettings } from '../../domain/src/gm.ts';
import { isLocale, type SavedVoiceSettings } from '../../domain/src/voice.ts';
import type { Rng } from '../../rules/src/dice.ts';
import { type GmSettingsSave, saveGmSettings } from './gm-settings.ts';
import { type Check, type NoCheck, type PlayerAction, performAction, type ReportedRoll } from './turn.ts';
import { saveVoiceSettings, type VoiceSettingsSave } from './voice-settings.ts';

export type CampaignLanguageSave = {
  readonly campaignId: CampaignId;
  readonly actionId: string;
  readonly expectedRevision: number;
  readonly language: string;
};

export type Engine = {
  createCampaign(name: string, language?: string): Campaign;
  getCampaign(id: CampaignId): Campaign;
  getState(id: CampaignId): CampaignState;
  renameCampaign(id: CampaignId, name: string): Campaign;
  submitAction(action: PlayerAction, check?: Check | NoCheck | ReportedRoll): CommittedTurn;
  setCampaignLanguage(save: CampaignLanguageSave): string;
  saveVoiceSettings(save: VoiceSettingsSave): SavedVoiceSettings;
  saveGmSettings(save: GmSettingsSave): GmSettings;
};

const LANGUAGE_EVENTS: ReadonlySet<string> = new Set([CAMPAIGN_CREATED, CAMPAIGN_LANGUAGE_CHANGED]);

const change = ({ id, name }: Campaign, type: string, language?: string): CampaignChange => ({
  id: randomUUID(),
  campaignId: id,
  branchId: MAIN_BRANCH,
  actionId: randomUUID(),
  type,
  payload: language === undefined ? { name } : { name, language },
});

export const campaignLanguageOf = (events: readonly Pick<CampaignEvent, 'type' | 'payload'>[]): string | undefined => {
  const language = events.findLast(({ type }) => LANGUAGE_EVENTS.has(type))?.payload.language;
  return isLocale(language) ? language : undefined;
};

const loadState = (store: CampaignStore, id: CampaignId) => {
  const state = store.load(id);
  if (state === undefined) throw new CampaignNotFoundError(id);
  return state;
};

export const createEngine = (store: CampaignStore, rng: Rng = Math.random): Engine => ({
  createCampaign: (name, language) => {
    if (language !== undefined && !isLocale(language)) throw new RangeError(`invalid campaign language ${language}`);
    const campaign = { id: randomUUID(), name };
    store.createCampaign(campaign, change(campaign, CAMPAIGN_CREATED, language));
    return campaign;
  },
  getCampaign: (id) => loadState(store, id).campaign,
  getState: (id) => loadState(store, id),
  renameCampaign: (id, name) => {
    const { revision } = loadState(store, id);
    const campaign = { id, name };
    store.renameCampaign({ expectedRevision: revision, campaign, event: change(campaign, CAMPAIGN_RENAMED) });
    return campaign;
  },
  setCampaignLanguage: ({ campaignId, actionId, expectedRevision, language }) => {
    if (!isLocale(language)) throw new RangeError(`invalid campaign language ${language}`);
    loadState(store, campaignId);
    store.recordChange({
      expectedRevision,
      event: {
        id: randomUUID(),
        campaignId,
        branchId: MAIN_BRANCH,
        actionId,
        type: CAMPAIGN_LANGUAGE_CHANGED,
        payload: { language },
      },
    });
    return language;
  },
  submitAction: (action, check) => performAction(store, action, check, rng),
  saveVoiceSettings: (save) => saveVoiceSettings(store, save),
  saveGmSettings: (save) => saveGmSettings(store, save),
});
