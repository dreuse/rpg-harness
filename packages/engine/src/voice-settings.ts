import { randomUUID } from 'node:crypto';
import { type CampaignEvent, type CampaignStore, MAIN_BRANCH } from '../../domain/src/campaign.ts';
import { type SavedVoiceSettings, toSavedVoiceSettings } from '../../domain/src/voice.ts';
import { InvalidActionError } from './turn.ts';

export const VOICE_SETTINGS_SAVED = 'VoiceSettingsSaved';
const INVALID_SETTINGS = 'voice settings are invalid or lack microphone consent';

export type VoiceSettingsSave = {
  readonly campaignId: string;
  readonly actionId: string;
  readonly expectedRevision: number;
  readonly settings: unknown;
};

export const saveVoiceSettings = (
  store: CampaignStore,
  { campaignId, actionId, expectedRevision, settings }: VoiceSettingsSave,
): SavedVoiceSettings => {
  const saved = toSavedVoiceSettings(settings);
  if (saved === undefined) throw new InvalidActionError(actionId, INVALID_SETTINGS);
  const payload = { settings: saved };
  const event = { id: randomUUID(), campaignId, branchId: MAIN_BRANCH, actionId, type: VOICE_SETTINGS_SAVED, payload };
  store.recordChange({ expectedRevision, event });
  return saved;
};

export const voiceSettingsOf = (
  events: readonly Pick<CampaignEvent, 'type' | 'payload'>[],
): SavedVoiceSettings | undefined =>
  toSavedVoiceSettings(events.findLast(({ type }) => type === VOICE_SETTINGS_SAVED)?.payload.settings);
