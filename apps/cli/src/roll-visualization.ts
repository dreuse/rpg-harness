import {
  type MechanicResult,
  type MechanicReveal,
  PLAYER_ROLLED,
  type RollBreakdown,
  type RollModifierLine,
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
import { DEFAULT_WHO_ROLLS, type GmSettings, type WhoRolls } from '../../../packages/domain/src/gm.ts';
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
import { conditionModifiersOf, type ModifierPolicy, mergeModifiers } from '../../../packages/engine/src/conditions.ts';
import { type Combatant, type CombatRules, combatantOf, targetNpcOf } from '../../../packages/engine/src/damage.ts';
import { GM_ROLLER, PLAYER_ROLLER } from '../../../packages/engine/src/gm-roll.ts';
import { gmSettingsOf } from '../../../packages/engine/src/gm-settings.ts';
import { rulesDocumentsOf, usesOwnRules } from '../../../packages/engine/src/own-rules.ts';
import { reportedCheck, reportedRoll, rollExpressionOf } from '../../../packages/engine/src/roll-report.ts';
import {
  type Check,
  type CheckResolution,
  campaignConfigOf,
  type NoCheck,
  PLAYER_SOURCE,
  type ReportedRoll,
} from '../../../packages/engine/src/turn.ts';
import { type CampaignConfig, parseCampaignConfig } from '../../../packages/intent/src/config.ts';
import {
  ATTRIBUTE_AVERAGE,
  ATTRIBUTE_MAX,
  ATTRIBUTE_MIN,
  ATTRIBUTES,
  type Attribute,
  attack,
  attemptCheck,
  checkBonus,
  combatantSheet,
  createSheet,
  D20_LITE_CHECK_RULES,
  D20_LITE_COMBAT,
  D20_LITE_MANIFEST,
  D20_LITE_VOCABULARY,
  D20_SIDES,
  DEFAULT_CHECK_ATTRIBUTE,
  DEFAULT_CHECK_DC,
  keptFace,
  proficiencyOf,
} from '../../../packages/rules/src/d20-lite.ts';
import { type Rng, type RollEvent, replayRoll } from '../../../packages/rules/src/dice.ts';
import {
  DEFAULT_POOL_CONFIG,
  DICE_POOL_LITE_CHECK_RULES,
  DICE_POOL_LITE_MANIFEST,
  DICE_POOL_LITE_VOCABULARY,
  type PoolRoll,
  rollPool,
} from '../../../packages/rules/src/dice-pool-lite.ts';
import {
  type AppliedModifier,
  applicableModifiers,
  type KeepMode,
  type ModifierVocabulary,
  NO_VOCABULARY,
  summarizeModifiers,
} from '../../../packages/rules/src/modifiers.ts';
import type { ActionResolution } from '../../../packages/rules/src/resolve.ts';
import { isRecord, type ManifestIssue, type RulePackManifest } from '../../../packages/rules/src/rulepack.ts';
import type { TraitSheet } from '../../../packages/rules/src/traits.ts';

import { LocalizedError } from './messages.ts';
import { citesOwnRulesSection } from './own-rules.ts';

export const DICE_MECHANIC = 'dice';
export const POOL_MECHANIC = 'dice-pool';

const NO_BONUS = 0;
const FIRST_ROLL = 0;
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

type OfferedRoll = Pick<CheckOffer, 'modifiers' | 'difficulty'> & { readonly defender?: Combatant };

type CheckSource = (
  events: readonly CampaignEvent[],
  actorId: CharacterId,
  input: string,
  worldProfile: unknown,
  ruleId?: string,
  offered?: OfferedRoll,
) => Check | NoCheck | undefined;

const POOL_RULE = 'check.pool';
const MIN_POOL_DICE = 1;

const modifiersFor = (
  events: readonly CampaignEvent[],
  actorId: CharacterId,
  ruleId: string,
  vocabulary: ModifierVocabulary,
  offered?: OfferedRoll,
) =>
  applicableModifiers(
    mergeModifiers(offered?.modifiers ?? [], conditionModifiersOf(events, actorId, ruleId)),
    vocabulary.effects,
  );

const ATTACK_RULES: readonly string[] = D20_LITE_COMBAT.rules;
const PROFICIENCY_ID = 'proficiency';
const PROFICIENCY_REASON = 'Proficiency';
const NO_DAMAGE = 0;

type Strike = {
  readonly actionId: string;
  readonly rng: Rng;
  readonly sheet: TraitSheet;
  readonly attribute: Attribute;
  readonly flat: number;
  readonly keep: KeepMode | undefined;
  readonly modifiers: readonly AppliedModifier[];
  readonly defender: Combatant;
};

const strike = ({ actionId, rng, sheet, attribute, flat, keep, modifiers, defender }: Strike): CheckResolution => {
  const { npcId, defense, current, max } = defender;
  const struck = attack({
    actionId,
    attacker: sheet,
    target: combatantSheet({ id: npcId, defense, current, max }),
    attribute,
    damageSides: D20_LITE_COMBAT.damageSides,
    rng,
    edge: flat,
    ...(keep === undefined ? {} : { keep }),
  });
  if (!struck.ok) throw new RangeError(struck.error.issues.map(({ message }) => message).join(ISSUE_SEPARATOR));
  const lost = struck.changes.find(({ id }) => id === D20_LITE_COMBAT.hitPoints);
  const amount = lost === undefined ? NO_DAMAGE : Number(lost.from) - Number(lost.to);
  const proficiency = proficiencyOf(sheet);
  const attributeBonus = checkBonus({ sheet, attribute });
  return {
    rolls: struck.rolls,
    events: struck.events,
    bonus: attributeBonus + proficiency + flat,
    attribute: { id: attribute, value: attributeBonus },
    target: defense,
    modifiers: [
      ...modifiers,
      { id: PROFICIENCY_ID, reason: PROFICIENCY_REASON, effect: { kind: 'flat', value: proficiency } },
    ],
    ...(keep === undefined ? {} : { keep }),
    damage: { targetId: npcId, amount, defeated: current - amount <= NO_DAMAGE },
  };
};

const unavailable = (noCheck: NoCheckReason): NoCheck => ({ noCheck });

const d20Check: CheckSource = (events, actorId, input, worldProfile, ruleId, offered) => {
  const parsed = parseCharacterProfile(profileOf(events, actorId, worldProfile));
  const scores = new Map(parsed.ok ? parsed.profile.traits.map(({ id, value }) => [id, value]) : []);
  const written = ATTRIBUTES.some((id) => scores.has(id));
  const attributes = Object.fromEntries(ATTRIBUTES.map((id) => [id, written ? scores.get(id) : ATTRIBUTE_AVERAGE]));
  if (!ATTRIBUTES.every((id) => isScore(attributes[id]))) return unavailable('missing-scores');
  const sheet = createSheet({ characterId: actorId, attributes: attributes as Record<Attribute, number> });
  const attribute = ruleId === undefined ? attributeOf(input) : D20_LITE_CHECK_RULES[ruleId];
  if (attribute === undefined) return undefined;
  const modifiers = modifiersFor(events, actorId, ruleId ?? `check.${attribute}`, D20_LITE_VOCABULARY, offered);
  const { flat, keep } = summarizeModifiers(modifiers);
  const dc = D20_LITE_VOCABULARY.difficulties[offered?.difficulty ?? ''] ?? DEFAULT_CHECK_DC;
  const defender = ATTACK_RULES.includes(ruleId ?? '') ? offered?.defender : undefined;
  if (defender !== undefined)
    return (actionId, rng) => strike({ actionId, rng, sheet, attribute, flat, keep, modifiers, defender });
  return (actionId, rng) => {
    const check = attemptCheck({
      actionId,
      sheet,
      attribute,
      dc,
      rng,
      edge: flat,
      ...(keep === undefined ? {} : { keep }),
    });
    if (!check.ok) throw new RangeError(check.error.issues.map(({ message }) => message).join(ISSUE_SEPARATOR));
    const attributeBonus = checkBonus({ sheet, attribute });
    return {
      rolls: check.rolls,
      events: check.events,
      bonus: attributeBonus + flat,
      attribute: { id: attribute, value: attributeBonus },
      target: dc,
      ...(modifiers.length === 0 ? {} : { modifiers }),
      ...(keep === undefined ? {} : { keep }),
    };
  };
};

const poolCheck: CheckSource = (events, actorId, _input, _profile, ruleId, offered) => {
  const modifiers = modifiersFor(events, actorId, ruleId ?? POOL_RULE, DICE_POOL_LITE_VOCABULARY, offered);
  const dice = Math.max(MIN_POOL_DICE, BASE_POOL_DICE + summarizeModifiers(modifiers).dice);
  return (actionId, rng) => {
    const roll = rolled(rollPool({ actionId, dice, config: DEFAULT_POOL_CONFIG, rng }));
    return { rolls: roll.rolls, events: [{ event: roll.outcome }], ...(modifiers.length === 0 ? {} : { modifiers }) };
  };
};

const CHECKS: readonly (readonly [RulePackManifest, CheckSource, readonly string[], string, ModifierVocabulary])[] = [
  [D20_LITE_MANIFEST, d20Check, Object.keys(D20_LITE_CHECK_RULES), `1d${D20_SIDES}`, D20_LITE_VOCABULARY],
  [
    DICE_POOL_LITE_MANIFEST,
    poolCheck,
    DICE_POOL_LITE_CHECK_RULES,
    `${BASE_POOL_DICE}d${DEFAULT_POOL_CONFIG.sides}`,
    DICE_POOL_LITE_VOCABULARY,
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
  return rulesStrictnessOf(chosen, (saved.ok && saved.config.rulepack !== null) || usesOwnRules(state.events));
};

export const enforcedStrictnessFor = (
  state: StrictnessState,
  defaults: GmSettings = {},
): RulesStrictness | undefined => {
  const saved = parseCampaignConfig(campaignConfigOf(state.events));
  const strictness = rulesStrictnessFor(state, defaults);
  const rolls = saved.ok && (rollsDice(saved.config) || usesOwnRules(state.events));
  return strictness === 'as-written' && rolls ? strictness : undefined;
};

const checkEntryOf = (events: readonly CampaignEvent[], strictness: RulesStrictness) => {
  const saved = parseCampaignConfig(campaignConfigOf(events));
  if (!saved.ok || strictness === 'off' || !rollsDice(saved.config)) return undefined;
  const { rulepack } = saved.config;
  return CHECKS.find(
    ([pack]) => pack.id === rulepack?.id && pack.edition === rulepack.edition && pack.revision === rulepack.revision,
  );
};

export type GmRollSpec = {
  readonly ruleId?: string;
  readonly expression?: string;
  readonly roller?: string;
  readonly section?: string;
};

const ownRulesExpression = (
  events: readonly CampaignEvent[],
  strictness: RulesStrictness,
  { ruleId, expression, section }: GmRollSpec,
) => {
  if (strictness === 'off' || ruleId !== undefined) return undefined;
  const cited = citesOwnRulesSection(rulesDocumentsOf(events), section);
  return strictness === 'as-written' && !cited ? undefined : expression;
};

export const gmRollExpressionFor = (
  events: readonly CampaignEvent[],
  strictness: RulesStrictness,
  spec: GmRollSpec,
): string | undefined => {
  if (usesOwnRules(events)) return ownRulesExpression(events, strictness, spec);
  const { ruleId, expression, roller } = spec;
  if (roller === PLAYER_ROLLER) return undefined;
  const saved = parseCampaignConfig(campaignConfigOf(events));
  if (!saved.ok || !rollsDice(saved.config)) return undefined;
  if (ruleId !== undefined) {
    const entry = checkEntryOf(events, strictness);
    return entry?.[2].includes(ruleId) ? entry[3] : undefined;
  }
  return saved.config.rulepack === null || strictness !== 'off' ? expression : undefined;
};

export const modifierPolicyOf = (
  events: readonly CampaignEvent[],
  strictness: RulesStrictness,
): ModifierPolicy | undefined => {
  const saved = parseCampaignConfig(campaignConfigOf(events));
  if (!saved.ok || strictness === 'off' || !rollsDice(saved.config)) return undefined;
  return { vocabulary: checkEntryOf(events, strictness)?.[4] ?? NO_VOCABULARY, strictness };
};

const GM_ROLL_PROBE = `1d${D20_SIDES}`;

export const gmRollsAllowed = (events: readonly CampaignEvent[], strictness: RulesStrictness): boolean =>
  usesOwnRules(events)
    ? strictness !== 'off'
    : gmRollExpressionFor(events, strictness, { expression: GM_ROLL_PROBE }) !== undefined;

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
  if (usesOwnRules(events)) return undefined;
  if (!callsForCheck(input, hasRulebook(events) ? strictness : AS_WRITTEN)) return undefined;
  const setup = setupOf(events, strictness);
  return 'noCheck' in setup ? setup : setup[1](events, actorId, input, worldProfileOf(entities, actorId));
};

const defenderOf = (
  events: readonly CampaignEvent[],
  entities: readonly CampaignEntity[],
  target: string | undefined,
  pack: RulePackManifest,
): Combatant | undefined => {
  const npc = target === undefined ? undefined : targetNpcOf(entities, target);
  const rules: CombatRules = {
    pack: { id: pack.id, edition: pack.edition, revision: pack.revision },
    defense: D20_LITE_COMBAT.defense,
    hitPoints: D20_LITE_COMBAT.hitPoints,
  };
  return npc === undefined ? undefined : combatantOf(npc, events, rules);
};

export const offeredCheckFor = (
  events: readonly CampaignEvent[],
  offer: Pick<CheckOffer, 'ruleId' | 'label' | 'modifiers' | 'difficulty'> & Partial<Pick<CheckOffer, 'target'>>,
  actorId: CharacterId,
  entities = NO_ENTITIES,
): Check | undefined => {
  const { ruleId, label, target } = offer;
  const entry = checkEntryOf(events, AS_WRITTEN);
  const defender = entry === undefined ? undefined : defenderOf(events, entities, target, entry[0]);
  const offered = entry?.[2].includes(ruleId)
    ? entry[1](events, actorId, label, worldProfileOf(entities, actorId), ruleId, {
        ...offer,
        ...(defender === undefined ? {} : { defender }),
      })
    : undefined;
  return typeof offered === 'function' ? offered : undefined;
};

const acceptsOffer = (input: string) => wordsOf(input).some((word) => ATTEMPT_WORDS.has(word));

const TYPED_REPORT = /\b(?:i\s+rolled|rolled|rolei|tirei|saiu)\s+(?:a\s+|um\s+)?(\d{1,4})\b/iu;
const FIRST_GROUP = 1;
const NEEDS_REPORT = 'rollReport.needed';

export const whoRollsFor = (state: StrictnessState, defaults: GmSettings = {}): WhoRolls =>
  ({ ...defaults, ...gmSettingsOf(state.changes) }).whoRolls ?? DEFAULT_WHO_ROLLS;

export const rollExpressionFor = (
  events: readonly CampaignEvent[],
  offer: CheckOffer,
  actorId: CharacterId,
  entities = NO_ENTITIES,
): string | undefined => {
  const offered = offeredCheckFor(events, offer, actorId, entities);
  return offered === undefined ? undefined : rollExpressionOf(offered);
};

const typedReportOf = (input: string) => {
  const found = TYPED_REPORT.exec(input)?.[FIRST_GROUP];
  return found === undefined ? undefined : [Number(found)];
};

export type ActionRoll = {
  readonly input: string;
  readonly rollOfferId?: string | undefined;
  readonly reportedRoll?: readonly number[] | undefined;
  readonly whoRolls?: WhoRolls | undefined;
};

const appCheckFor = (
  events: readonly CampaignEvent[],
  { input, rollOfferId }: ActionRoll,
  actorId: CharacterId,
  entities: readonly CampaignEntity[],
  strictness: RulesStrictness,
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

export const checkForAction = (
  events: readonly CampaignEvent[],
  action: ActionRoll,
  actorId: CharacterId,
  entities = NO_ENTITIES,
  strictness: RulesStrictness = DEFAULT_RULES_STRICTNESS,
): Check | NoCheck | ReportedRoll | undefined => {
  const { input, whoRolls = DEFAULT_WHO_ROLLS } = action;
  const offer = pendingCheckOffer(events);
  const offerOpen = offer !== undefined && !offerFollowsPlayerAction(events);
  const base = appCheckFor(events, action, actorId, entities, strictness);
  const typed = whoRolls === DEFAULT_WHO_ROLLS ? undefined : typedReportOf(input);
  const usableTyped = typed !== undefined && (offerOpen || typeof base === 'function') ? typed : undefined;
  const reported = action.reportedRoll ?? usableTyped;
  if (reported === undefined) {
    if (typeof base === 'function' && whoRolls === 'me')
      throw new LocalizedError(NEEDS_REPORT, { expression: rollExpressionOf(base) });
    return base;
  }
  const offered =
    offer !== undefined && (offerOpen || action.reportedRoll !== undefined)
      ? offeredCheckFor(events, offer, actorId, entities)
      : undefined;
  const check = offered ?? (typeof base === 'function' ? base : undefined);
  return check === undefined ? reportedRoll(reported) : reportedCheck(check, reported);
};

const revealsOf = ({ pool, draws }: RollEvent): MechanicReveal[] =>
  pool.dice.flatMap(({ sides }, index) => (draws[index] ?? []).map((face) => ({ kind: 'die', sides, face }) as const));

const KEEP_MODES: readonly KeepMode[] = ['highest', 'lowest'];

const modifierLineOf = (entry: unknown): RollModifierLine[] => {
  if (!isRecord(entry) || typeof entry.id !== 'string' || typeof entry.reason !== 'string') return [];
  const { id, reason, effect } = entry;
  if (!isRecord(effect)) return [];
  if (effect.kind === 'flat' && Number.isFinite(effect.value)) {
    return [{ id, reason, kind: 'flat', value: Number(effect.value) }];
  }
  if (effect.kind === 'dice' && Number.isFinite(effect.count)) {
    return [{ id, reason, kind: 'dice', value: Number(effect.count) }];
  }
  const which = KEEP_MODES.find((known) => known === effect.which);
  return effect.kind === 'keep' && which !== undefined ? [{ id, reason, kind: 'keep', which }] : [];
};

type ResolutionDetail = {
  readonly attribute?: unknown;
  readonly modifiers?: unknown;
  readonly keep?: unknown;
  readonly target?: unknown;
};

const breakdownOf = (roll: RollEvent, detail: ResolutionDetail): RollBreakdown | undefined => {
  const modifiers = Array.isArray(detail.modifiers) ? detail.modifiers.flatMap(modifierLineOf) : [];
  const { attribute } = detail;
  const keep = KEEP_MODES.find((known) => known === detail.keep);
  const hasAttribute = isRecord(attribute) && typeof attribute.id === 'string' && Number.isFinite(attribute.value);
  const hasTarget = Number.isFinite(detail.target);
  if (modifiers.length === 0 && !hasAttribute && !hasTarget && keep === undefined) return undefined;
  return {
    modifiers,
    ...(hasAttribute ? { attribute: { id: String(attribute.id), value: Number(attribute.value) } } : {}),
    ...(hasTarget ? { target: Number(detail.target) } : {}),
    ...(keep === undefined ? {} : { kept: keptFace(roll.draws.flat(), keep) }),
  };
};

export const rollResult = (
  roll: RollEvent,
  visibility: Visibility,
  outcome?: string,
  bonus = NO_BONUS,
  source?: typeof PLAYER_ROLLED,
  roller?: string,
  detail: ResolutionDetail = {},
): MechanicResult => {
  const breakdown = breakdownOf(roll, detail);
  const diceTotal = breakdown?.kept === undefined ? roll.total : roll.pool.modifier + breakdown.kept;
  return {
    resultId: roll.rollId,
    mechanic: DICE_MECHANIC,
    visibility,
    reveals: revealsOf(roll),
    modifier: roll.pool.modifier + bonus,
    total: diceTotal + bonus,
    ...(outcome === undefined ? {} : { outcome }),
    ...(source === undefined ? {} : { source }),
    ...(roller === undefined ? {} : { roller }),
    ...(breakdown === undefined ? {} : { breakdown }),
  };
};

const outcomeOf = ({ ok, events, error }: Readonly<Record<string, unknown>>) => {
  const source = ok === true ? (Array.isArray(events) ? events[0] : undefined) : error;
  const named = isRecord(source) ? (ok === true ? source.event : source.code) : undefined;
  return typeof named === 'string' ? named : undefined;
};

export const checkResult = (check: ActionResolution, bonus: number, visibility: Visibility): MechanicResult[] => {
  const [d20] = check.rolls;
  return d20 === undefined ? [] : [rollResult(d20, visibility, outcomeOf(check), bonus)];
};

const GM_LABEL = 'GM';

const rollerLabelOf = (payload: unknown): string | undefined => {
  if (!isRecord(payload)) return undefined;
  if (typeof payload.rollerName === 'string') return payload.rollerName;
  return payload.roller === GM_ROLLER ? GM_LABEL : undefined;
};

export const resultsOf = (payload: unknown, visibility: Visibility): MechanicResult[] => {
  const resolution = isRecord(payload) ? payload.resolution : undefined;
  if (!isRecord(resolution) || !Array.isArray(resolution.rolls)) return [];
  const outcome = outcomeOf(resolution);
  const bonus = Number.isFinite(resolution.bonus) ? Number(resolution.bonus) : NO_BONUS;
  const source = resolution.source === PLAYER_SOURCE ? PLAYER_ROLLED : undefined;
  const roller = rollerLabelOf(payload);
  return resolution.rolls.flatMap((stored, index) => {
    const replayed = replayRoll(stored);
    const detail = index === FIRST_ROLL ? resolution : {};
    return replayed.ok ? [rollResult(replayed.event, visibility, outcome, bonus, source, roller, detail)] : [];
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
