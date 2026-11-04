import type { CampaignStore, CommittedTurn } from '../../domain/src/campaign.ts';
import { type BuildInput, buildCharacter } from '../../rules/src/character-builder.ts';
import { commit, InvalidActionError, loadState, type PlayerAction, recorded, replayOf, validate } from './turn.ts';

export const CHARACTER_CREATED = 'CharacterCreated';

export type CharacterCreation = PlayerAction & { readonly build: BuildInput };

export const commitCharacter = (store: CampaignStore, input: CharacterCreation): CommittedTurn => {
  const { actionId, actorId, campaignId } = input;
  const result = buildCharacter(input.build);
  if (result.status !== 'created')
    throw new InvalidActionError(actionId, `character for ${actorId} is ${result.status}`);
  const payload = { actorId, ...result.character };
  const state = loadState(store, campaignId);
  const stored = replayOf(state, input, recorded(CHARACTER_CREATED, payload));
  if (stored !== undefined) return stored;
  validate(state, input);
  const character = { id: actorId, campaignId, name: result.character.profile.identity.name };
  return commit(store, input, [[CHARACTER_CREATED, payload]], [character]);
};
