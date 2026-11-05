import { randomUUID } from 'node:crypto';
import {
  CAMPAIGN_CREATED,
  CAMPAIGN_RENAMED,
  type Campaign,
  type CampaignChange,
  type CampaignId,
  CampaignNotFoundError,
  type CampaignState,
  type CampaignStore,
  type CommittedTurn,
  MAIN_BRANCH,
} from '../../domain/src/campaign.ts';
import type { GmSettings } from '../../domain/src/gm.ts';
import type { SavedVoiceSettings } from '../../domain/src/voice.ts';
import type { Rng } from '../../rules/src/dice.ts';
import { type GmSettingsSave, saveGmSettings } from './gm-settings.ts';
import { type Check, type PlayerAction, performAction } from './turn.ts';
import { saveVoiceSettings, type VoiceSettingsSave } from './voice-settings.ts';

export type Engine = {
  createCampaign(name: string): Campaign;
  getCampaign(id: CampaignId): Campaign;
  getState(id: CampaignId): CampaignState;
  renameCampaign(id: CampaignId, name: string): Campaign;
  submitAction(action: PlayerAction, check?: Check): CommittedTurn;
  saveVoiceSettings(save: VoiceSettingsSave): SavedVoiceSettings;
  saveGmSettings(save: GmSettingsSave): GmSettings;
};

const change = ({ id, name }: Campaign, type: string): CampaignChange => ({
  id: randomUUID(),
  campaignId: id,
  branchId: MAIN_BRANCH,
  actionId: randomUUID(),
  type,
  payload: { name },
});

const loadState = (store: CampaignStore, id: CampaignId) => {
  const state = store.load(id);
  if (state === undefined) throw new CampaignNotFoundError(id);
  return state;
};

export const createEngine = (store: CampaignStore, rng: Rng = Math.random): Engine => ({
  createCampaign: (name) => {
    const campaign = { id: randomUUID(), name };
    store.createCampaign(campaign, change(campaign, CAMPAIGN_CREATED));
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
  submitAction: (action, check) => performAction(store, action, check, rng),
  saveVoiceSettings: (save) => saveVoiceSettings(store, save),
  saveGmSettings: (save) => saveGmSettings(store, save),
});
