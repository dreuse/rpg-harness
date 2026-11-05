import type { CampaignEvent, EventId } from '../../domain/src/campaign.ts';
import type { EntityId } from '../../domain/src/entity.ts';
import type { RulesStrictness } from '../../domain/src/rules-usage.ts';
import { type Fact, type FactId, type Viewer, visibleTo } from '../../memory/src/knowledge.ts';

export type NarrationClaim =
  | { readonly kind: 'effect'; readonly ref: string; readonly eventId: EventId | null }
  | { readonly kind: 'equipment'; readonly ref: string; readonly actorId: EntityId; readonly itemId: EntityId }
  | { readonly kind: 'fact'; readonly ref: string; readonly factId: FactId };

export const VIOLATION_KINDS = [
  'uncommitted-effect',
  'impossible-equipment',
  'secret-leak',
  'unknown-fact',
  'unresolved-outcome',
] as const;
export type ViolationKind = (typeof VIOLATION_KINDS)[number];

export type Violation = {
  readonly kind: ViolationKind;
  readonly ref: string | null;
  readonly reason: string;
  readonly sourceId: string | null;
};

export type ConsistencyReport = { readonly ok: boolean; readonly violations: readonly Violation[] };

export type ConsistencyInput = {
  readonly narration: string;
  readonly claims: readonly NarrationClaim[];
  readonly events: readonly CampaignEvent[];
  readonly facts: readonly Fact[];
  readonly equipment: Readonly<Record<EntityId, readonly EntityId[]>>;
  readonly viewer: Viewer;
  readonly rulesStrictness?: RulesStrictness;
  readonly checkResolved?: boolean;
};

const NO_LENGTH = 0;
const AS_WRITTEN: RulesStrictness = 'as-written';

const REASONS: Readonly<Record<ViolationKind, string>> = {
  'uncommitted-effect': 'claimed effect has no committed event',
  'impossible-equipment': 'actor does not hold the claimed item',
  'secret-leak': 'narration reveals a fact the viewer may not see',
  'unknown-fact': 'claimed fact is not a known fact',
  'unresolved-outcome': 'narration claims a mechanical result the engine did not resolve',
};

const violation = (kind: ViolationKind, ref: string | null, sourceId: string | null): Violation => ({
  kind,
  ref,
  reason: REASONS[kind],
  sourceId,
});

const checkClaim = (claim: NarrationClaim, input: ConsistencyInput, visible: ReadonlySet<FactId>): Violation[] => {
  switch (claim.kind) {
    case 'effect':
      return input.events.some((event) => event.id === claim.eventId)
        ? []
        : [violation('uncommitted-effect', claim.ref, claim.eventId)];
    case 'equipment':
      return Object.hasOwn(input.equipment, claim.actorId) && input.equipment[claim.actorId]?.includes(claim.itemId)
        ? []
        : [violation('impossible-equipment', claim.ref, claim.itemId)];
    case 'fact':
      if (!input.facts.some((fact) => fact.id === claim.factId)) {
        return [violation('unknown-fact', claim.ref, claim.factId)];
      }
      return visible.has(claim.factId) ? [] : [violation('secret-leak', claim.ref, claim.factId)];
    default:
      return [];
  }
};

const WHITESPACE_RUN = /\s+/g;
const SINGLE_SPACE = ' ';

export const normalize = (text: string): string => text.toLowerCase().replace(WHITESPACE_RUN, SINGLE_SPACE).trim();

const restatedSecrets = (input: ConsistencyInput, visible: ReadonlySet<FactId>): Violation[] => {
  const narration = normalize(input.narration);
  return input.facts
    .filter((fact) => {
      const statement = normalize(fact.statement);
      return !visible.has(fact.id) && statement.length > NO_LENGTH && narration.includes(statement);
    })
    .map((fact) => violation('secret-leak', null, fact.id));
};

const COMBATANTS_EN =
  'goblins?|orcs?|ogres?|bandits?|guards?|skeletons?|wolf|wolves|beasts?|creatures?|monsters?|enem(?:y|ies)|foes?|dragons?|rats?|spiders?|trolls?|kobolds?|cultists?|soldiers?|thugs?|brutes?|zombies?|ghouls?|knights?|assassins?';
const COMBATANTS_PT =
  'goblins?|orcs?|ogros?|bandidos?|guardas?|esqueletos?|lobos?|monstros?|criaturas?|inimigos?|drag(?:ão|ões)|trolls?|kobolds?|cultistas?|soldados?|brutamontes|zumbis?|ghouls?|cavaleiros?|assassinos?|aranhas?|ratos?';
const WEAPONS_EN = 'blade|sword|axe|dagger|spear|arrow|bolt|fist|mace|club|staff|spell|shot|swing|thrust';
const WEAPONS_PT =
  'lâmina|espada|machado|adaga|lança|flecha|virote|punho|maça|clava|cajado|feitiço|tiro|golpe|estocada';
const VERBS_EN = 'hits?|strikes?|struck|misses?|missed|wounds?|slays?|kills?|connects?|pierces?|slashes';
const VERBS_PT = 'acerta|acertou|atinge|atingiu|fere|feriu|mata|matou|erra|errou|perfura|perfurou';
const ARTICLES_EN = 'the|a|an|your|its';
const ARTICLES_PT = 'o|a|os|as|um|uma|seu|sua';
const FILLER = '(?:\\p{L}+\\s+){0,2}?';

const word = (alternatives: string) => `(?<!\\p{L})(?:${alternatives})(?!\\p{L})`;
const claim = (...parts: string[]) => new RegExp(parts.join('\\s+'), 'iu');
const targeted = (verbs: string, articles: string, combatants: string) =>
  claim(word(verbs), `(?:(?:${articles})\\s+)?${FILLER}${word(combatants)}`);
const wielded = (weapons: string, verbs: string) => claim(word(weapons), `${FILLER}${word(verbs)}`);
const fighting = (combatants: string, verbs: string) => claim(word(combatants), word(verbs));

const MECHANICAL_CLAIMS: readonly RegExp[] = [
  /(?<!\p{L})\d+ (?:points? of )?damage(?!\p{L})/iu,
  /(?<!\p{L})\d+ (?:pontos? de )?dano(?!\p{L})/iu,
  targeted(VERBS_EN, ARTICLES_EN, COMBATANTS_EN),
  wielded(WEAPONS_EN, VERBS_EN),
  fighting(COMBATANTS_EN, VERBS_EN),
  targeted(VERBS_PT, ARTICLES_PT, COMBATANTS_PT),
  wielded(WEAPONS_PT, VERBS_PT),
  fighting(COMBATANTS_PT, VERBS_PT),
];

export const claimsMechanicalResult = (narration: string): boolean =>
  MECHANICAL_CLAIMS.some((claim) => claim.test(narration));

const unresolvedOutcomes = ({ narration, rulesStrictness, checkResolved }: ConsistencyInput): Violation[] =>
  rulesStrictness === AS_WRITTEN && checkResolved !== true && claimsMechanicalResult(narration)
    ? [violation('unresolved-outcome', null, null)]
    : [];

export const checkConsistency = (input: ConsistencyInput): ConsistencyReport => {
  const visible = new Set(visibleTo(input.facts, input.viewer).map((fact) => fact.id));
  const violations = [
    ...input.claims.flatMap((claim) => checkClaim(claim, input, visible)),
    ...restatedSecrets(input, visible),
    ...unresolvedOutcomes(input),
  ];
  return { ok: violations.length === 0, violations };
};
