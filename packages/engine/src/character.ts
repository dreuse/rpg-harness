import {
  type CampaignEvent,
  type CampaignState,
  type CampaignStore,
  CHARACTER_CREATED,
  CHECK_OFFERED,
  type CharacterId,
  type CommittedTurn,
  PLAYER_ACTION_SUBMITTED,
  SYSTEM_TURN,
  type TurnVisibility,
} from '../../domain/src/campaign.ts';
import type { CharacterProfile } from '../../domain/src/character.ts';
import { type BuildInput, buildCharacter, type CreationRules } from '../../rules/src/character-builder.ts';
import { isRecord } from '../../rules/src/rulepack.ts';
import type { Visibility } from '../../rules/src/sheet-schema.ts';
import { GM_PROPOSAL_INPUT } from './check-offer.ts';
import {
  commitSystem,
  InvalidActionError,
  loadState,
  type PlayerAction,
  recorded,
  replayOf,
  requireValid,
  storedTurnOf,
  validate,
} from './turn.ts';

export { CHARACTER_CREATED };

export const SHEET_FIELD_EDITED = 'SheetFieldEdited';

const OWNER_VISIBLE: readonly Visibility[] = ['public', 'owner'];
const EDIT_INTENT = 'edit sheet field';
const EDIT_VISIBILITY: TurnVisibility = 'player';
const NO_SCENE = '';

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
    store,
    state,
    input,
    (turn) => recorded(CHARACTER_CREATED, payload)(turn) || recorded(CHARACTER_CREATED, legacy)(turn),
  );
  if (stored !== undefined) return stored;
  validate(state, input);
  const character = { id: actorId, campaignId, name: result.character.profile.identity.name };
  return commitSystem(store, input, [[CHARACTER_CREATED, payload]], [character]);
};

export type SheetFieldEdit = Pick<PlayerAction, 'campaignId' | 'actionId' | 'expectedRevision' | 'actorId'> & {
  readonly fieldId: string;
  readonly value: unknown;
};

const isSheetValue = (value: unknown) =>
  typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));

export const editSheetField = (store: CampaignStore, edit: SheetFieldEdit): CommittedTurn => {
  const { campaignId, actionId, expectedRevision, actorId, fieldId, value } = edit;
  const state = loadState(store, campaignId);
  const sceneId = storedTurnOf(store, state, actionId)?.turn.sceneId ?? state.currentScene?.id ?? NO_SCENE;
  const action = {
    campaignId,
    actionId,
    expectedRevision,
    sceneId,
    actorId,
    input: `${EDIT_INTENT} ${fieldId}`,
    intent: EDIT_INTENT,
  };
  const payload = { actorId, fieldId, value };
  const stored = replayOf(store, state, action, recorded(SHEET_FIELD_EDITED, payload));
  if (stored !== undefined) return stored;
  validate(state, action);
  requireValid(actionId, fieldId.trim() !== '', 'field id is blank');
  requireValid(actionId, isSheetValue(value), `value for ${fieldId} must be text, a finite number or a flag`);
  return commitSystem(store, action, [[SHEET_FIELD_EDITED, payload, EDIT_VISIBILITY]]);
};

export const profileOf = (events: readonly CampaignEvent[], actorId: CharacterId, worldProfile?: unknown): unknown => {
  const created =
    worldProfile === undefined
      ? events.findLast(({ type, payload }) => type === CHARACTER_CREATED && payload.actorId === actorId)
      : undefined;
  const profile = worldProfile ?? created?.payload.profile;
  if (!isRecord(profile) || !Array.isArray(profile.traits)) return profile;
  const edits = new Map(
    events
      .slice(created === undefined ? 0 : events.indexOf(created) + 1)
      .filter(({ type, payload }) => type === SHEET_FIELD_EDITED && payload.actorId === actorId)
      .map(({ payload }) => [payload.fieldId, payload.value]),
  );
  const traits = profile.traits.map((trait: unknown) =>
    isRecord(trait) && edits.has(trait.id) ? { ...trait, value: edits.get(trait.id) } : trait,
  );
  return { ...profile, traits };
};

export const playTurns = ({ turns, events }: Pick<CampaignState, 'turns' | 'events'>) => {
  const accepted = new Map(
    events.flatMap(({ type, turnId, payload }) =>
      type === PLAYER_ACTION_SUBMITTED && typeof payload.rollOfferId === 'string'
        ? [[turnId, payload.rollOfferId] as const]
        : [],
    ),
  );
  return turns
    .filter(({ kind, input }) => kind !== SYSTEM_TURN && !input.startsWith(GM_PROPOSAL_INPUT))
    .map((turn) => {
      const rollOfferId = accepted.get(turn.id);
      return rollOfferId === undefined ? turn : { ...turn, rollOfferId };
    });
};
