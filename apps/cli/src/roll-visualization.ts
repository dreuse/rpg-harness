import {
  type MechanicResult,
  type MechanicReveal,
  toVisualizationEvent,
  type ViewerScope,
  type VisualizationEvent,
  type VisualizationPreference,
} from '../../../packages/client-protocol/src/visualization.ts';
import type {
  CampaignEvent,
  CampaignState,
  CharacterId,
  NoCheckReason,
} from '../../../packages/domain/src/campaign.ts';
import { CHARACTER_KIND, parseCharacterProfile } from '../../../packages/domain/src/character.ts';
import type { CampaignEntity, Visibility } from '../../../packages/domain/src/entity.ts';
import type { GmSettings } from '../../../packages/domain/src/gm.ts';
import {
  DEFAULT_RULES_STRICTNESS,
  type RulesStrictness,
  rulesStrictnessOf,
} from '../../../packages/domain/src/rules-usage.ts';
import { profileOf } from '../../../packages/engine/src/character.ts';
import {
  type CheckOffer,
  offerFollowsPlayerAction,
  pendingCheckOffer,
} from '../../../packages/engine/src/check-offer.ts';
import { gmSettingsOf } from '../../../packages/engine/src/gm-settings.ts';
import { type Check, campaignConfigOf, type NoCheck } from '../../../packages/engine/src/turn.ts';
import { type CampaignConfig, parseCampaignConfig } from '../../../packages/intent/src/config.ts';
import {
  ATTRIBUTE_AVERAGE,
  ATTRIBUTE_MAX,
  ATTRIBUTE_MIN,
  ATTRIBUTES,
  type Attribute,
  attemptCheck,
  checkBonus,
  createSheet,
  D20_LITE_CHECK_RULES,
  D20_LITE_MANIFEST,
  DEFAULT_CHECK_ATTRIBUTE,
  DEFAULT_CHECK_DC,
} from '../../../packages/rules/src/d20-lite.ts';
import { type RollEvent, replayRoll } from '../../../packages/rules/src/dice.ts';
import {
  DEFAULT_POOL_CONFIG,
  DICE_POOL_LITE_CHECK_RULES,
  DICE_POOL_LITE_MANIFEST,
  type PoolRoll,
  rollPool,
} from '../../../packages/rules/src/dice-pool-lite.ts';
import type { ActionResolution } from '../../../packages/rules/src/resolve.ts';
import { isRecord, type ManifestIssue, type RulePackManifest } from '../../../packages/rules/src/rulepack.ts';

export const DICE_MECHANIC = 'dice';
export const POOL_MECHANIC = 'dice-pool';

const NO_BONUS = 0;
const VISUALIZATION_OFF: VisualizationPreference = { enabled: false };
const DICE_FIELD = 'dice';
const DICE_OFF = 'off';
const ATTEMPT_WORDS = new Set([
  'try',
  'tries',
  'attempt',
  'attempts',
  'roll',
  'rolls',
  'tento',
  'tenta',
  'tentar',
  'tentei',
  'tentamos',
  'rolo',
  'rola',
  'rolar',
]);
const RULED_ACTION_WORDS = new Set([
  'attack',
  'attacks',
  'swing',
  'swings',
  'stab',
  'stabs',
  'shoot',
  'shoots',
  'ataco',
  'ataca',
  'atacar',
  'golpeio',
  'golpeia',
  'golpear',
  'esfaqueio',
  'esfaqueia',
  'atiro',
  'atira',
  'atirar',
  'disparo',
  'dispara',
  'disparar',
]);
const WORD_SEPARATOR = /[^\p{L}]+/u;
const BASE_POOL_DICE = 2;
const ATTRIBUTE_WORDS: ReadonlyMap<string, Attribute> = new Map(
  Object.entries({
    might: 'might',
    strength: 'might',
    force: 'might',
    lift: 'might',
    agility: 'agility',
    dexterity: 'agility',
    dodge: 'agility',
    sneak: 'agility',
    shoot: 'agility',
    atiro: 'agility',
    atira: 'agility',
    atirar: 'agility',
    disparo: 'agility',
    dispara: 'agility',
    disparar: 'agility',
    ataco: 'might',
    ataca: 'might',
    atacar: 'might',
    golpeio: 'might',
    golpeia: 'might',
    golpear: 'might',
    attack: 'might',
    strike: 'might',
    swing: 'might',
    stab: 'might',
    wits: 'wits',
    intellect: 'wits',
    recall: 'wits',
    search: 'wits',
    presence: 'presence',
    charm: 'presence',
    persuade: 'presence',
    intimidate: 'presence',
  } as const),
);
const NO_ENTITIES: readonly CampaignEntity[] = [];
const NO_RULES: readonly string[] = [];
const CLOSED_OFFER = 'the roll offer is no longer open';
const AS_WRITTEN: RulesStrictness = 'as-written';
const ISSUE_SEPARATOR = '; ';

const rolled = <T>(result: { ok: true; roll: T } | { ok: false; issues: ManifestIssue[] }): T => {
  if (!result.ok) throw new RangeError(result.issues.map(({ message }) => message).join(ISSUE_SEPARATOR));
  return result.roll;
};

const isScore = (value: unknown): value is number =>
  Number.isInteger(value) && Number(value) >= ATTRIBUTE_MIN && Number(value) <= ATTRIBUTE_MAX;

const wordsOf = (input: string) => input.toLowerCase().split(WORD_SEPARATOR);

const attributeOf = (input: string): Attribute =>
  wordsOf(input)
    .map((word) => ATTRIBUTE_WORDS.get(word))
    .find((attribute) => attribute !== undefined) ?? DEFAULT_CHECK_ATTRIBUTE;

type CheckSource = (
  events: readonly CampaignEvent[],
  actorId: CharacterId,
  input: string,
  worldProfile: unknown,
  ruleId?: string,
) => Check | NoCheck | undefined;

const unavailable = (noCheck: NoCheckReason): NoCheck => ({ noCheck });

const d20Check: CheckSource = (events, actorId, input, worldProfile, ruleId) => {
  const parsed = parseCharacterProfile(profileOf(events, actorId, worldProfile));
  const scores = new Map(parsed.ok ? parsed.profile.traits.map(({ id, value }) => [id, value]) : []);
  const written = ATTRIBUTES.some((id) => scores.has(id));
  const attributes = Object.fromEntries(ATTRIBUTES.map((id) => [id, written ? scores.get(id) : ATTRIBUTE_AVERAGE]));
  if (!ATTRIBUTES.every((id) => isScore(attributes[id]))) return unavailable('missing-scores');
  const sheet = createSheet({ characterId: actorId, attributes: attributes as Record<Attribute, number> });
  const attribute = ruleId === undefined ? attributeOf(input) : D20_LITE_CHECK_RULES[ruleId];
  if (attribute === undefined) return undefined;
  return (actionId, rng) => {
    const check = attemptCheck({ actionId, sheet, attribute, dc: DEFAULT_CHECK_DC, rng });
    if (!check.ok) throw new RangeError(check.error.issues.map(({ message }) => message).join(ISSUE_SEPARATOR));
    return { rolls: check.rolls, events: check.events, bonus: checkBonus({ sheet, attribute }) };
  };
};

const CHECKS: readonly (readonly [RulePackManifest, CheckSource, readonly string[]])[] = [
  [D20_LITE_MANIFEST, d20Check, Object.keys(D20_LITE_CHECK_RULES)],
  [
    DICE_POOL_LITE_MANIFEST,
    () => (actionId, rng) => {
      const roll = rolled(rollPool({ actionId, dice: BASE_POOL_DICE, config: DEFAULT_POOL_CONFIG, rng }));
      return { rolls: roll.rolls, events: [{ event: roll.outcome }] };
    },
    DICE_POOL_LITE_CHECK_RULES,
  ],
];

const callsForCheck = (input: string, strictness: RulesStrictness) =>
  strictness !== 'off' &&
  wordsOf(input).some(
    (word) => ATTEMPT_WORDS.has(word) || (strictness === 'as-written' && RULED_ACTION_WORDS.has(word)),
  );

const rollsDice = ({ values, capabilities }: CampaignConfig) =>
  values.dice !== DICE_OFF && capabilities.supported.includes(DICE_FIELD);

type StrictnessState = Pick<CampaignState, 'events' | 'changes'>;

export const rulesStrictnessFor = (state: StrictnessState, defaults: GmSettings = {}): RulesStrictness => {
  const saved = parseCampaignConfig(campaignConfigOf(state.events));
  const chosen = { ...defaults, ...gmSettingsOf(state.changes) }.rulesStrictness;
  return rulesStrictnessOf(chosen, saved.ok && saved.config.rulepack !== null);
};

export const enforcedStrictnessFor = (
  state: StrictnessState,
  defaults: GmSettings = {},
): RulesStrictness | undefined => {
  const saved = parseCampaignConfig(campaignConfigOf(state.events));
  const strictness = rulesStrictnessFor(state, defaults);
  return strictness === 'as-written' && saved.ok && rollsDice(saved.config) ? strictness : undefined;
};

const checkEntryOf = (events: readonly CampaignEvent[], strictness: RulesStrictness) => {
  const saved = parseCampaignConfig(campaignConfigOf(events));
  if (!saved.ok || strictness === 'off' || !rollsDice(saved.config)) return undefined;
  const { rulepack } = saved.config;
  return CHECKS.find(
    ([pack]) => pack.id === rulepack?.id && pack.edition === rulepack.edition && pack.revision === rulepack.revision,
  );
};

export const checkRulesFor = (
  events: readonly CampaignEvent[],
  strictness: RulesStrictness = DEFAULT_RULES_STRICTNESS,
): readonly string[] => checkEntryOf(events, strictness)?.[2] ?? NO_RULES;

const worldProfileOf = (entities: readonly CampaignEntity[], actorId: CharacterId) =>
  entities.find(({ id, kind }) => id === actorId && kind === CHARACTER_KIND)?.data;

const hasRulebook = (events: readonly CampaignEvent[]) => {
  const saved = parseCampaignConfig(campaignConfigOf(events));
  return saved.ok && saved.config.rulepack !== null;
};

const setupOf = (events: readonly CampaignEvent[], strictness: RulesStrictness) => {
  const saved = parseCampaignConfig(campaignConfigOf(events));
  if (!saved.ok || saved.config.rulepack === null) return unavailable('no-rulebook');
  if (!rollsDice(saved.config)) return unavailable('dice-off');
  return checkEntryOf(events, strictness) ?? unavailable('unsupported-rulebook');
};

export const checkFor = (
  events: readonly CampaignEvent[],
  input: string,
  actorId: CharacterId,
  entities = NO_ENTITIES,
  strictness: RulesStrictness = DEFAULT_RULES_STRICTNESS,
): Check | NoCheck | undefined => {
  if (!callsForCheck(input, hasRulebook(events) ? strictness : AS_WRITTEN)) return undefined;
  const setup = setupOf(events, strictness);
  return 'noCheck' in setup ? setup : setup[1](events, actorId, input, worldProfileOf(entities, actorId));
};

export const offeredCheckFor = (
  events: readonly CampaignEvent[],
  { ruleId, label }: Pick<CheckOffer, 'ruleId' | 'label'>,
  actorId: CharacterId,
  entities = NO_ENTITIES,
): Check | undefined => {
  const entry = checkEntryOf(events, AS_WRITTEN);
  const offered = entry?.[2].includes(ruleId)
    ? entry[1](events, actorId, label, worldProfileOf(entities, actorId), ruleId)
    : undefined;
  return typeof offered === 'function' ? offered : undefined;
};

const acceptsOffer = (input: string) => wordsOf(input).some((word) => ATTEMPT_WORDS.has(word));

export const checkForAction = (
  events: readonly CampaignEvent[],
  { input, rollOfferId }: { readonly input: string; readonly rollOfferId?: string | undefined },
  actorId: CharacterId,
  entities = NO_ENTITIES,
  strictness: RulesStrictness = DEFAULT_RULES_STRICTNESS,
): Check | NoCheck | undefined => {
  const offer = pendingCheckOffer(events);
  if (rollOfferId !== undefined && offer?.offerId !== rollOfferId) throw new RangeError(CLOSED_OFFER);
  if (offer !== undefined && rollOfferId !== undefined) {
    const offered = offeredCheckFor(events, offer, actorId, entities);
    if (offered === undefined) throw new RangeError(CLOSED_OFFER);
    return offered;
  }
  const textAccepts = offer !== undefined && acceptsOffer(input) && !offerFollowsPlayerAction(events);
  return (
    (textAccepts ? offeredCheckFor(events, offer, actorId, entities) : undefined) ??
    checkFor(events, input, actorId, entities, strictness)
  );
};

const revealsOf = ({ pool, draws }: RollEvent): MechanicReveal[] =>
  pool.dice.flatMap(({ sides }, index) => (draws[index] ?? []).map((face) => ({ kind: 'die', sides, face }) as const));

export const rollResult = (
  roll: RollEvent,
  visibility: Visibility,
  outcome?: string,
  bonus = NO_BONUS,
): MechanicResult => ({
  resultId: roll.rollId,
  mechanic: DICE_MECHANIC,
  visibility,
  reveals: revealsOf(roll),
  modifier: roll.pool.modifier + bonus,
  total: roll.total + bonus,
  ...(outcome === undefined ? {} : { outcome }),
});

const outcomeOf = ({ ok, events, error }: Readonly<Record<string, unknown>>) => {
  const source = ok === true ? (Array.isArray(events) ? events[0] : undefined) : error;
  const named = isRecord(source) ? (ok === true ? source.event : source.code) : undefined;
  return typeof named === 'string' ? named : undefined;
};

export const checkResult = (check: ActionResolution, bonus: number, visibility: Visibility): MechanicResult[] => {
  const [d20] = check.rolls;
  return d20 === undefined ? [] : [rollResult(d20, visibility, outcomeOf(check), bonus)];
};

export const resultsOf = (payload: unknown, visibility: Visibility): MechanicResult[] => {
  const resolution = isRecord(payload) ? payload.resolution : undefined;
  if (!isRecord(resolution) || !Array.isArray(resolution.rolls)) return [];
  const outcome = outcomeOf(resolution);
  const bonus = Number.isFinite(resolution.bonus) ? Number(resolution.bonus) : NO_BONUS;
  return resolution.rolls.flatMap((stored) => {
    const replayed = replayRoll(stored);
    return replayed.ok ? [rollResult(replayed.event, visibility, outcome, bonus)] : [];
  });
};

export const visualizationPreferenceOf = (events: readonly CampaignEvent[]): VisualizationPreference => {
  const saved = parseCampaignConfig(campaignConfigOf(events));
  return saved.ok ? { enabled: saved.config.values.diceVisualization } : VISUALIZATION_OFF;
};

export const poolResult = (resultId: string, roll: PoolRoll, visibility: Visibility): MechanicResult => ({
  resultId,
  mechanic: POOL_MECHANIC,
  visibility,
  reveals: roll.rolls.flatMap(revealsOf),
  total: roll.successes,
  outcome: roll.outcome,
});

export const emitVisualizations = (
  results: readonly MechanicResult[],
  viewer: ViewerScope,
  preference: VisualizationPreference,
): VisualizationEvent[] => results.flatMap((result) => toVisualizationEvent(result, viewer, preference) ?? []);
