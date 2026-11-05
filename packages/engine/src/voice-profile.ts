import type { CampaignEvent, CampaignStore, CommittedTurn } from '../../domain/src/campaign.ts';
import type { EntityId, EntityStore } from '../../domain/src/entity.ts';
import { NARRATOR_SPEAKER, toVoiceProfile, type VoiceProfile } from '../../domain/src/voice.ts';
import { commit, loadState, type PlayerAction, recorded, replayOf, requireValid, validate } from './turn.ts';

export const VOICE_PROFILE_SET = 'VoiceProfileSet';

export type VoiceProfileAssignment = PlayerAction & { readonly speakerId: EntityId; readonly profile: unknown };

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
  return commit(store, input, [[VOICE_PROFILE_SET, { speakerId, profile }]]);
};

export const voiceProfileOf = (events: readonly CampaignEvent[], speakerId: EntityId): VoiceProfile | undefined =>
  toVoiceProfile(
    events.findLast((event) => event.type === VOICE_PROFILE_SET && event.payload.speakerId === speakerId)?.payload
      .profile,
  );
