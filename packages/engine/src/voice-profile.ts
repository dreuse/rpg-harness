import type { CampaignEvent, CampaignStore, CommittedTurn } from '../../domain/src/campaign.ts';
import type { EntityId, EntityStore } from '../../domain/src/entity.ts';
import {
  NARRATOR_SPEAKER,
  toVoiceProfile,
  toVoiceTraits,
  VOICE_TRAITS_FIELD,
  type VoiceProfile,
} from '../../domain/src/voice.ts';
import { commitSystem, loadState, type PlayerAction, recorded, replayOf, requireValid, validate } from './turn.ts';

export const VOICE_PROFILE_SET = 'VoiceProfileSet';
export const VOICE_TRAITS_SET = 'VoiceTraitsSet';

export type VoiceProfileAssignment = PlayerAction & { readonly speakerId: EntityId; readonly profile: unknown };

export type VoiceTraitsAssignment = PlayerAction & { readonly speakerId: EntityId; readonly traits: unknown };

const NPC_KIND = 'npc';

export const setVoiceProfile = (
  store: CampaignStore,
  entities: EntityStore,
  input: VoiceProfileAssignment,
): CommittedTurn => {
  const { actionId, campaignId, speakerId } = input;
  const profile = toVoiceProfile(input.profile);
  const state = loadState(store, campaignId);
  const stored = replayOf(store, state, input, recorded(VOICE_PROFILE_SET, { speakerId, profile }));
  if (stored !== undefined) return stored;
  validate(state, input);
  requireValid(actionId, profile !== undefined, `voice profile for ${speakerId} is invalid`);
  requireValid(
    actionId,
    speakerId === NARRATOR_SPEAKER || entities.getEntity(campaignId, speakerId)?.kind === NPC_KIND,
    `speaker ${speakerId} is neither the narrator nor an npc`,
  );
  return commitSystem(store, input, [[VOICE_PROFILE_SET, { speakerId, profile }]]);
};

export const setVoiceTraits = (
  store: CampaignStore,
  entities: EntityStore,
  input: VoiceTraitsAssignment,
): CommittedTurn => {
  const { actionId, campaignId, speakerId } = input;
  const traits = toVoiceTraits(input.traits);
  const state = loadState(store, campaignId);
  const npc = entities.getEntity(campaignId, speakerId);
  const project = (committed: CommittedTurn) => {
    if (npc !== undefined) entities.saveEntity({ ...npc, data: { ...npc.data, [VOICE_TRAITS_FIELD]: traits } });
    return committed;
  };
  const stored = replayOf(store, state, input, recorded(VOICE_TRAITS_SET, { speakerId, traits }));
  if (stored !== undefined) return project(stored);
  validate(state, input);
  requireValid(actionId, traits !== undefined, `voice traits for ${speakerId} are invalid`);
  requireValid(actionId, npc?.kind === NPC_KIND, `speaker ${speakerId} is not an npc`);
  requireValid(actionId, npc?.data[VOICE_TRAITS_FIELD] === undefined, `npc ${speakerId} already has voice traits`);
  return project(commitSystem(store, input, [[VOICE_TRAITS_SET, { speakerId, traits }]]));
};

export const voiceProfileOf = (events: readonly CampaignEvent[], speakerId: EntityId): VoiceProfile | undefined =>
  toVoiceProfile(
    events.findLast((event) => event.type === VOICE_PROFILE_SET && event.payload.speakerId === speakerId)?.payload
      .profile,
  );
