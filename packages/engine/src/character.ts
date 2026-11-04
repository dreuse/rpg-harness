import { type CampaignStore, CHARACTER_CREATED, type CommittedTurn } from '../../domain/src/campaign.ts';
import type { CharacterProfile } from '../../domain/src/character.ts';
import { type BuildInput, buildCharacter, type CreationRules } from '../../rules/src/character-builder.ts';
import type { Visibility } from '../../rules/src/sheet-schema.ts';
import { commit, InvalidActionError, loadState, type PlayerAction, recorded, replayOf, validate } from './turn.ts';

export { CHARACTER_CREATED };

const OWNER_VISIBLE: readonly Visibility[] = ['public', 'owner'];

const ownerVisible = (rules: CreationRules, profile: CharacterProfile): CharacterProfile => {
  const visible = new Set(
    rules.schema.fields.filter((field) => OWNER_VISIBLE.includes(field.visibility)).map((field) => field.id),
  );
  return { ...profile, traits: profile.traits.filter((trait) => visible.has(trait.id)) };
};

export type CharacterCreation = PlayerAction & { readonly build: BuildInput };

export const commitCharacter = (store: CampaignStore, input: CharacterCreation): CommittedTurn => {
  const { actionId, actorId, campaignId } = input;
  const result = buildCharacter(input.build);
  if (result.status !== 'created')
    throw new InvalidActionError(actionId, `character for ${actorId} is ${result.status}`);
  const { fields } = input.build.rules.schema;
  const traitVisibility = Object.fromEntries(fields.map(({ id, visibility }) => [id, visibility]));
  const payload = { actorId, ...result.character, traitVisibility };
  const legacy = { actorId, ...result.character, profile: ownerVisible(input.build.rules, result.character.profile) };
  const state = loadState(store, campaignId);
  const stored = replayOf(
    state,
    input,
    (turn) => recorded(CHARACTER_CREATED, payload)(turn) || recorded(CHARACTER_CREATED, legacy)(turn),
  );
  if (stored !== undefined) return stored;
  validate(state, input);
  const character = { id: actorId, campaignId, name: result.character.profile.identity.name };
  return commit(store, input, [[CHARACTER_CREATED, payload]], [character]);
};
