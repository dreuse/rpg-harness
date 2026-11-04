import type { CampaignId } from '../../domain/src/campaign.ts';
import {
  CHARACTER_KIND,
  type CharacterProfile,
  InvalidCharacterProfileError,
  isProfileVisibility,
  type ProfileVisibility,
  parseCharacterProfile,
  VISIBILITY_ISSUE,
} from '../../domain/src/character.ts';
import type { EntityId, EntityStore } from '../../domain/src/entity.ts';

export type CharacterStore = {
  saveProfile(campaignId: CampaignId, id: EntityId, input: unknown, visibility: ProfileVisibility): void;
  getProfile(campaignId: CampaignId, id: EntityId): CharacterProfile | undefined;
};

const deepFreeze = <T>(value: T): T => {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};

export const createCharacterStore = (entities: EntityStore): CharacterStore => ({
  saveProfile: (campaignId, id, input, visibility) => {
    if (!isProfileVisibility(visibility)) throw new InvalidCharacterProfileError([VISIBILITY_ISSUE]);
    const result = parseCharacterProfile(input);
    if (!result.ok) throw new InvalidCharacterProfileError(result.issues);
    const { profile } = result;
    entities.saveEntity({
      id,
      campaignId,
      kind: CHARACTER_KIND,
      name: profile.identity.name,
      data: profile,
      visibility,
      actorId: null,
    });
  },
  getProfile: (campaignId, id) => {
    const entity = entities.getEntity(campaignId, id);
    if (entity?.kind !== CHARACTER_KIND) return undefined;
    const result = parseCharacterProfile(entity.data);
    if (!result.ok) throw new InvalidCharacterProfileError(result.issues);
    return deepFreeze(result.profile);
  },
});
