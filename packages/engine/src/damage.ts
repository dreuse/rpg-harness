import { type CampaignEvent, DAMAGE_APPLIED } from '../../domain/src/campaign.ts';
import { type CharacterProfile, parseCharacterProfile, type RulePackLink } from '../../domain/src/character.ts';
import type { CampaignEntity, EntityId } from '../../domain/src/entity.ts';
import { PLAYER_VIEWER, visibleTo } from '../../memory/src/knowledge.ts';
import { isRecord } from '../../rules/src/rulepack.ts';

export const NPC_SHEET_FIELD = 'sheet';

export type CombatRules = {
  readonly pack: RulePackLink;
  readonly defense: string;
  readonly hitPoints: string;
};
export type Combatant = {
  readonly npcId: EntityId;
  readonly name: string;
  readonly defense: number;
  readonly current: number;
  readonly max: number;
};
export type DamageDealt = { readonly targetId: EntityId; readonly amount: number; readonly defeated: boolean };

const NPC_KIND = 'npc';
const NO_DAMAGE = 0;
const SINGLE = 1;
const FULL_DETAIL = 'full';
const SPARSE_DETAIL = 'sparse';

const normalized = (text: string) => text.trim().toLowerCase();

const profileOf = ({ data }: CampaignEntity): CharacterProfile | undefined => {
  const sheet = data[NPC_SHEET_FIELD];
  if (!isRecord(sheet)) return undefined;
  const parsed =
    sheet.detail === FULL_DETAIL
      ? parseCharacterProfile(sheet.profile)
      : sheet.detail === SPARSE_DETAIL
        ? parseCharacterProfile({
            identity: { name: sheet.name },
            motivations: sheet.motivations,
            background: sheet.background,
            traits: sheet.traits,
            conditions: [],
            rulepack: sheet.rulepack,
          })
        : undefined;
  return parsed?.ok ? parsed.profile : undefined;
};

const sameRulepack = (left: RulePackLink, right: RulePackLink) =>
  left.id === right.id && left.edition === right.edition && left.revision === right.revision;

const wholeTrait = ({ traits }: CharacterProfile, id: string): number | undefined => {
  const value = traits.find((trait) => trait.id === id)?.value;
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
};

export const damageTakenOf = (events: readonly CampaignEvent[], npcId: EntityId): number =>
  events
    .filter(({ type, payload }) => type === DAMAGE_APPLIED && payload.targetId === npcId)
    .reduce((sum, { payload }) => sum + Number(payload.amount), NO_DAMAGE);

export const targetNpcOf = (entities: readonly CampaignEntity[], target: string): CampaignEntity | undefined => {
  const npcs = visibleTo(entities, PLAYER_VIEWER).filter(({ kind }) => kind === NPC_KIND);
  const named = npcs.filter(({ name }) => normalized(name) === normalized(target));
  const matches = npcs.some(({ id }) => id === target) ? npcs.filter(({ id }) => id === target) : named;
  return matches.length === SINGLE ? matches[0] : undefined;
};

export const combatantOf = (
  entity: CampaignEntity,
  events: readonly CampaignEvent[],
  { pack, defense, hitPoints }: CombatRules,
): Combatant | undefined => {
  const profile = profileOf(entity);
  if (profile === undefined || !sameRulepack(profile.rulepack, pack)) return undefined;
  const armor = wholeTrait(profile, defense);
  const max = wholeTrait(profile, hitPoints);
  if (armor === undefined || max === undefined || max < NO_DAMAGE) return undefined;
  const current = Math.max(NO_DAMAGE, max - damageTakenOf(events, entity.id));
  return { npcId: entity.id, name: entity.name, defense: armor, current, max };
};
