import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VISUALIZATION_EVENT } from '../../../packages/client-protocol/src/visualization.ts';
import {
  CAMPAIGN_CONFIGURED,
  type CampaignEvent,
  CHECK_OFFERED,
  DAMAGE_APPLIED,
  PLAYER_ACTION_SUBMITTED,
  RULES_DOCUMENT_ADDED,
} from '../../../packages/domain/src/campaign.ts';
import type { CampaignEntity } from '../../../packages/domain/src/entity.ts';
import { CHARACTER_CREATED, SHEET_FIELD_EDITED } from '../../../packages/engine/src/character.ts';
import { NPC_SHEET_FIELD } from '../../../packages/engine/src/damage.ts';
import { GM_SETTINGS_SAVED } from '../../../packages/engine/src/gm-settings.ts';
import type { ReportedRoll } from '../../../packages/engine/src/turn.ts';
import { generateCampaignConfig } from '../../../packages/intent/src/config.ts';
import { createCampaignIntent } from '../../../packages/intent/src/intent.ts';
import {
  attemptCheck,
  checkBonus,
  createSheet,
  D20_LITE_MANIFEST,
  DEFAULT_CHECK_ATTRIBUTE,
  DEFAULT_CHECK_DC,
  PROFICIENCY_BASE,
} from '../../../packages/rules/src/d20-lite.ts';
import { createSeededRng } from '../../../packages/rules/src/dice.ts';
import { DEFAULT_POOL_CONFIG, rollPool } from '../../../packages/rules/src/dice-pool-lite.ts';
import { BUILT_IN_PACKS } from './import-gateway.ts';
import {
  checkForAction as checkForActionOrReason,
  checkFor as checkForOrReason,
  checkResult,
  checkRulesFor,
  DICE_MECHANIC,
  emitVisualizations,
  enforcedStrictnessFor,
  gmRollExpressionFor,
  offeredCheckFor,
  POOL_MECHANIC,
  poolResult,
  resultsOf,
  rollResult,
  rulesStrictnessFor,
  visualizationPreferenceOf,
} from './roll-visualization.ts';

const SEED = 7;
const PROFICIENCY = PROFICIENCY_BASE;
const DC = 12;
const POOL_DICE = 4;
const ENABLED = { enabled: true };
const ATTRIBUTES = { might: 5, agility: 5, wits: 5, presence: 5 };
const STRONG = { ...ATTRIBUTES, might: 8 };
const MIGHT_MOD = 3;
const EDGE = 1;
const DICE_REGISTRY = {
  rulepacks: [{ id: 'house', edition: '1', revision: 'r1', capabilities: { dice: true }, sourceRefs: [] }],
  genres: [],
};
const explicit = <T>(value: T) => ({ value, provenance: 'explicit' as const });

const visualizingConfig = (diceVisualization: boolean) => {
  const intent = createCampaignIntent({
    ruleset: explicit({ id: 'house', edition: '1' }),
    diceVisualization: explicit(diceVisualization),
    client: explicit('tui'),
  });
  const generated = generateCampaignConfig(intent, DICE_REGISTRY);
  assert.ok(generated.ok);
  return generated.config;
};

const configured = (config: unknown) =>
  [{ type: CAMPAIGN_CONFIGURED, payload: { config } }] as unknown as CampaignEvent[];

const d20Roll = () => {
  const sheet = createSheet({ characterId: 'hero' as never, attributes: ATTRIBUTES });
  const [roll] = attemptCheck({
    actionId: 'check-1',
    sheet,
    attribute: 'might',
    dc: DC,
    rng: createSeededRng(SEED),
  }).rolls;
  assert.ok(roll);
  return roll;
};

const pool = () => {
  const rolled = rollPool({
    actionId: 'pool-1',
    dice: POOL_DICE,
    config: DEFAULT_POOL_CONFIG,
    rng: createSeededRng(SEED),
  });
  assert.ok(rolled.ok);
  return rolled.roll;
};

test('maps a d20 roll to a visible mechanic result', () => {
  const roll = d20Roll();
  const [event] = emitVisualizations([rollResult(roll, 'public', 'success')], 'player', ENABLED);
  assert.deepEqual(event && { ...event, version: undefined }, {
    version: undefined,
    type: VISUALIZATION_EVENT,
    resultId: roll.rollId,
    mechanic: DICE_MECHANIC,
    frames: [{ step: 0, reveal: { kind: 'die', sides: 20, face: roll.draws[0]?.[0] } }],
    final: { total: roll.total, outcome: 'success', modifier: 0 },
  });
});

test('maps a pool roll to one die frame per face with successes as total', () => {
  const roll = pool();
  const [event] = emitVisualizations([poolResult('pool-1', roll, 'player')], 'player', ENABLED);
  assert.equal(event?.mechanic, POOL_MECHANIC);
  assert.equal(event?.resultId, 'pool-1');
  assert.deepEqual(
    event?.frames.map(({ reveal }) => reveal),
    roll.faces.map((face) => ({ kind: 'die', sides: DEFAULT_POOL_CONFIG.sides, face })),
  );
  assert.deepEqual(event?.final, { total: roll.successes, outcome: roll.outcome });
});

test('hides a gm roll from the player and shows it to the gm', () => {
  const results = [rollResult(d20Roll(), 'gm', 'success'), poolResult('pool-1', pool(), 'gm')];
  assert.deepEqual(emitVisualizations(results, 'player', ENABLED), []);
  assert.equal(emitVisualizations(results, 'gm', ENABLED).length, results.length);
});

test('emits nothing when the visualization preference is disabled', () => {
  assert.deepEqual(emitVisualizations([rollResult(d20Roll(), 'public')], 'gm', { enabled: false }), []);
});

test('a d20 check total adds the check bonus and carries the check outcome', () => {
  const sheet = createSheet({ characterId: 'hero' as never, attributes: STRONG });
  const check = attemptCheck({
    actionId: 'check-2',
    sheet,
    attribute: 'might',
    dc: DC,
    rng: createSeededRng(SEED),
    edge: EDGE,
  });
  const [d20] = check.rolls;
  assert.ok(d20 && check.ok);
  const [result] = checkResult(check, checkBonus({ sheet, attribute: 'might', edge: EDGE }), 'player');
  assert.equal(result?.total, d20.total + MIGHT_MOD + EDGE);
  assert.equal(result?.modifier, MIGHT_MOD + EDGE);
  assert.equal(result?.outcome, check.events[0]?.event);
  assert.match(String(result?.outcome), /^check\./);
});

test('maps the rolls of a committed resolution with its outcome and skips forged rolls', () => {
  const roll = d20Roll();
  const resolution = { ok: true, events: [{ event: 'attack.hit' }], rolls: [roll, { ...roll, total: -1 }] };
  assert.deepEqual(resultsOf({ resolution }, 'player'), [rollResult(roll, 'player', 'attack.hit')]);
  const failed = { ok: false, error: { code: 'PreconditionFailed' }, rolls: [roll] };
  assert.equal(resultsOf({ resolution: failed }, 'gm')[0]?.outcome, 'PreconditionFailed');
  assert.deepEqual(resultsOf({ clue: 'muddy boots' }, 'player'), []);
});

test('reads the visualization preference from the saved campaign config, off by default', () => {
  assert.deepEqual(visualizationPreferenceOf([]), { enabled: false });
  assert.deepEqual(visualizationPreferenceOf(configured({ broken: true })), { enabled: false });
  assert.deepEqual(visualizationPreferenceOf(configured(visualizingConfig(false))), { enabled: false });
  assert.deepEqual(visualizationPreferenceOf(configured(visualizingConfig(true))), { enabled: true });
});

const builtInConfig = (id: string, dice: 'rulepack' | 'on' | 'off' = 'rulepack') => {
  const intent = createCampaignIntent({ ruleset: explicit({ id, edition: 'original' }), dice: explicit(dice) });
  const generated = generateCampaignConfig(intent, { rulepacks: BUILT_IN_PACKS, genres: [] });
  assert.ok(generated.ok, JSON.stringify(generated));
  return generated.config;
};

test('built-in dice rulepacks let a campaign turn dice visualization on', () => {
  for (const id of ['d20-lite', 'dice-pool-lite']) {
    const intent = createCampaignIntent({
      ruleset: explicit({ id, edition: 'original' }),
      diceVisualization: explicit(true),
      client: explicit('tui'),
    });
    const generated = generateCampaignConfig(intent, { rulepacks: BUILT_IN_PACKS, genres: [] });
    assert.ok(generated.ok, JSON.stringify(generated));
    assert.deepEqual(visualizationPreferenceOf(configured(generated.config)), ENABLED);
  }
});

const rollOnly = (check: ReturnType<typeof checkForOrReason> | ReportedRoll) =>
  typeof check === 'function' ? check : undefined;
const checkFor = (...args: Parameters<typeof checkForOrReason>) => rollOnly(checkForOrReason(...args));
const checkForAction = (...args: Parameters<typeof checkForActionOrReason>) =>
  rollOnly(checkForActionOrReason(...args));
const HERO = 'hero';
const heroCreated = (values: Readonly<Record<string, number>>) =>
  ({
    type: CHARACTER_CREATED,
    payload: {
      actorId: HERO,
      profile: {
        identity: { name: 'Wren' },
        motivations: [],
        background: 'A scout.',
        traits: Object.entries(values).map(([id, value]) => ({ id, value })),
        conditions: [],
        rulepack: {
          id: D20_LITE_MANIFEST.id,
          edition: D20_LITE_MANIFEST.edition,
          revision: D20_LITE_MANIFEST.revision,
        },
      },
    },
  }) as unknown as CampaignEvent;
const sheetEdited = (fieldId: string, value: unknown) =>
  ({ type: SHEET_FIELD_EDITED, payload: { actorId: HERO, fieldId, value } }) as unknown as CampaignEvent;

test('a d20-lite attempt checks the hero default attribute against the pack DC and shows the outcome', () => {
  const TRY = 'I try to climb the wall';
  const campaign = [...configured(builtInConfig('d20-lite')), heroCreated(ATTRIBUTES)];
  const resolved = checkFor(campaign, TRY, HERO)?.('climb', createSeededRng(SEED));
  const expected = attemptCheck({
    actionId: 'climb',
    sheet: createSheet({ characterId: HERO as never, attributes: ATTRIBUTES }),
    attribute: DEFAULT_CHECK_ATTRIBUTE,
    dc: DEFAULT_CHECK_DC,
    rng: createSeededRng(SEED),
  });
  assert.ok(resolved && expected.ok);
  assert.deepEqual(resolved.events[0]?.event, expected.events[0]?.event);
  assert.equal(resolved.bonus, 0);

  const strong = checkFor(
    [...campaign, sheetEdited(DEFAULT_CHECK_ATTRIBUTE, STRONG.might)],
    TRY,
    HERO,
  )?.('climb', createSeededRng(SEED));
  assert.ok(strong);
  const [shown] = resultsOf({ resolution: { ok: true, ...strong } }, 'player');
  assert.equal(shown?.modifier, MIGHT_MOD);
  assert.match(shown?.outcome ?? '', /^check\./);

  assert.equal(checkFor([...campaign, sheetEdited(DEFAULT_CHECK_ATTRIBUTE, 99)], TRY, HERO), undefined);
});

test('rpg-42a.77: a d20-lite actor without scores rolls with modifier 0', () => {
  const TRY = 'I try to climb the wall';
  const campaign = configured(builtInConfig('d20-lite'));
  assert.equal(checkFor(campaign, TRY, HERO)?.('a', createSeededRng(SEED)).bonus, 0);
  assert.equal(
    checkFor([...campaign, heroCreated(ATTRIBUTES)], TRY, 'stranger')?.('a', createSeededRng(SEED)).bonus,
    0,
  );
});

test('rpg-42a.77: a matched action with no possible check names the reason', () => {
  const ATTACK_WORD = 'Attack';
  const d20 = configured(builtInConfig('d20-lite'));
  assert.deepEqual(checkForOrReason(configured(visualizingConfig(true)), ATTACK_WORD, HERO), {
    noCheck: 'unsupported-rulebook',
  });
  assert.deepEqual(checkForOrReason([], ATTACK_WORD, HERO, undefined, 'off'), { noCheck: 'no-rulebook' });
  assert.deepEqual(
    checkForOrReason([...configured(builtInConfig('d20-lite', 'off')), heroCreated(ATTRIBUTES)], ATTACK_WORD, HERO),
    { noCheck: 'dice-off' },
  );
  assert.deepEqual(
    checkForOrReason(
      [...d20, heroCreated(ATTRIBUTES), sheetEdited(DEFAULT_CHECK_ATTRIBUTE, 99)],
      ATTACK_WORD,
      HERO,
      undefined,
      'as-written',
    ),
    { noCheck: 'missing-scores' },
  );
  assert.equal(checkForOrReason(d20, 'I wave', HERO), undefined);
});

test('rpg-42a.10: an attempt checks the attribute its words name and falls back to the default', () => {
  const campaign = [
    ...configured(builtInConfig('d20-lite')),
    heroCreated({ might: 6, agility: 8, wits: 3, presence: 9 }),
  ];
  const modifierOf = (input: string) => {
    const resolved = checkFor(campaign, input, HERO)?.('act', createSeededRng(SEED));
    return resolved?.bonus;
  };
  assert.equal(modifierOf('I try to dodge the arrow'), 3);
  assert.equal(modifierOf('I try to use my wits'), -2);
  assert.equal(modifierOf('I try to persuade the guard'), 4);
  assert.equal(modifierOf('I try to climb the wall'), 1);
});

test('rpg-42a.10: a world-entity character rolls with its sheet edits', () => {
  const profile = heroCreated(ATTRIBUTES).payload.profile;
  const entity = {
    id: HERO,
    campaignId: 'c',
    kind: 'character',
    name: 'Wren',
    data: profile,
    visibility: 'player',
    actorId: null,
  };
  const events = [...configured(builtInConfig('d20-lite')), sheetEdited(DEFAULT_CHECK_ATTRIBUTE, STRONG.might)];
  const resolved = checkFor(events, 'I try to climb the wall', HERO, [entity as never])?.(
    'climb',
    createSeededRng(SEED),
  );
  assert.equal(resolved?.bonus, MIGHT_MOD);
});

test('an attempt in a dice campaign gets the rulepack check and every other turn rolls nothing', () => {
  const TRY = 'I try to climb the wall';
  const pool = checkFor(
    configured(builtInConfig('dice-pool-lite')),
    'I attempt the lock',
    HERO,
  )?.('lock', createSeededRng(SEED));
  assert.ok(pool);
  assert.equal(pool.rolls[0]?.pool.dice[0]?.sides, DEFAULT_POOL_CONFIG.sides);
  assert.ok(['success', 'mixed', 'complication', 'failure'].includes(pool.events[0]?.event ?? ''));

  assert.equal(
    checkFor([...configured(builtInConfig('d20-lite')), heroCreated(ATTRIBUTES)], 'I wave at the stranger', HERO),
    undefined,
  );
  assert.equal(
    checkFor([...configured(builtInConfig('d20-lite', 'off')), heroCreated(ATTRIBUTES)], TRY, HERO),
    undefined,
  );
  assert.equal(checkFor(configured(builtInConfig('narrative')), TRY, HERO), undefined);
  assert.equal(checkFor(configured(visualizingConfig(true)), TRY, HERO), undefined);
  assert.equal(checkFor([], TRY, HERO), undefined);
});

const ATTACK = 'I attack the goblin';
const CLIMB = 'I try to climb the wall';
const SAVED_STRICTNESS = (rulesStrictness: string) =>
  [{ type: GM_SETTINGS_SAVED, payload: { settings: { rulesStrictness } } }] as unknown as CampaignEvent[];

test('rpg-42a.58: as-written turns an attack into an engine roll that relaxed and off skip', () => {
  const campaign = [...configured(builtInConfig('d20-lite')), heroCreated(ATTRIBUTES)];
  assert.ok(checkFor(campaign, ATTACK, HERO, undefined, 'as-written'));
  assert.equal(checkFor(campaign, ATTACK, HERO, undefined, 'relaxed'), undefined);
  assert.equal(checkFor(campaign, ATTACK, HERO, undefined, 'off'), undefined);
  assert.ok(checkFor(campaign, CLIMB, HERO, undefined, 'relaxed'));
  assert.equal(checkFor(campaign, CLIMB, HERO, undefined, 'off'), undefined);
});

test('rpg-42a.58: an attack checks might and a shot checks agility', () => {
  const campaign = [...configured(builtInConfig('d20-lite')), heroCreated({ ...ATTRIBUTES, might: 8, agility: 3 })];
  assert.equal(checkFor(campaign, ATTACK, HERO)?.('a', createSeededRng(SEED)).bonus, MIGHT_MOD);
  assert.equal(checkFor(campaign, 'I shoot the goblin', HERO)?.('a', createSeededRng(SEED)).bonus, -2);
});

test('rpg-42a.58: strictness is the campaign choice, then the app default, then as-written for a RulePack', () => {
  const d20 = { events: configured(builtInConfig('d20-lite')), changes: [] as CampaignEvent[] };
  assert.equal(rulesStrictnessFor(d20), 'as-written');
  assert.equal(rulesStrictnessFor({ ...d20, changes: SAVED_STRICTNESS('relaxed') }), 'relaxed');
  assert.equal(rulesStrictnessFor(d20, { rulesStrictness: 'off' }), 'off');
  assert.equal(
    rulesStrictnessFor({ ...d20, changes: SAVED_STRICTNESS('relaxed') }, { rulesStrictness: 'off' }),
    'relaxed',
  );
  assert.equal(rulesStrictnessFor({ events: [], changes: [] }), 'off');
});

test('rpg-42a.58: the post-check applies only to as-written campaigns that roll dice', () => {
  const d20 = { events: configured(builtInConfig('d20-lite')), changes: [] as CampaignEvent[] };
  assert.equal(enforcedStrictnessFor(d20), 'as-written');
  assert.equal(enforcedStrictnessFor({ ...d20, changes: SAVED_STRICTNESS('relaxed') }), undefined);
  const diceOff = { events: configured(builtInConfig('d20-lite', 'off')), changes: [] as CampaignEvent[] };
  assert.equal(enforcedStrictnessFor(diceOff), undefined);
});

test('rpg-42a.58: Portuguese attempts and attacks call for the same checks as English ones', () => {
  const campaign = [...configured(builtInConfig('d20-lite')), heroCreated({ ...ATTRIBUTES, might: 8, agility: 3 })];
  for (const input of ['Eu tento escalar o muro', 'Tentar abrir a porta', 'Eu rolo para me esquivar'])
    assert.ok(checkFor(campaign, input, HERO, undefined, 'relaxed'), input);
  for (const input of ['Eu ataco o goblin', 'Ela golpeia o ogro', 'Eu atiro no lobo', 'Eu disparo a flecha'])
    assert.ok(checkFor(campaign, input, HERO, undefined, 'as-written'), input);
  assert.equal(checkFor(campaign, 'Eu ataco o goblin', HERO, undefined, 'relaxed'), undefined);
  assert.equal(checkFor(campaign, 'Eu ataco o goblin', HERO, undefined, 'off'), undefined);
  assert.equal(checkFor(campaign, 'Eu tento escalar o muro', HERO, undefined, 'off'), undefined);
  assert.equal(checkFor(campaign, 'Eu ataco o goblin', HERO)?.('a', createSeededRng(SEED)).bonus, MIGHT_MOD);
  assert.equal(checkFor(campaign, 'Eu atiro no lobo', HERO)?.('a', createSeededRng(SEED)).bonus, -2);
});

test('rpg-42a.58: nouns that look like attack verbs do not call for a check', () => {
  const campaign = [...configured(builtInConfig('d20-lite')), heroCreated(ATTRIBUTES)];
  for (const input of ['I light a fire', 'I strike a deal with the merchant', 'I warm my hands by the fire'])
    assert.equal(checkFor(campaign, input, HERO, undefined, 'as-written'), undefined, input);
});

const D20_SIDES = 20;
const OFFER = { offerId: 'tam-attack', ruleId: 'attack.melee', target: 'Old Tam', label: 'Attack Old Tam' };

test('rpg-42a.74: the d20 pack lists the check rules a GM may call, and off lists none', () => {
  const campaign = [...configured(builtInConfig('d20-lite')), heroCreated(ATTRIBUTES)];
  for (const strictness of ['as-written', 'relaxed'] as const) {
    const rules = checkRulesFor(campaign, strictness);
    assert.ok(rules.includes('attack.melee') && rules.includes('attack.ranged'), strictness);
  }
  assert.deepEqual(checkRulesFor(campaign, 'off'), []);
  assert.deepEqual(checkRulesFor(configured(builtInConfig('d20-lite', 'off')), 'as-written'), []);
  assert.deepEqual(checkRulesFor([], 'as-written'), []);
});

test('rpg-42a.74: an offered rule rolls a d20 whatever the player typed', () => {
  const campaign = [...configured(builtInConfig('d20-lite')), heroCreated({ ...ATTRIBUTES, might: 8, agility: 3 })];
  const melee = offeredCheckFor(campaign, OFFER, HERO)?.('a', createSeededRng(SEED));
  assert.equal(melee?.rolls[0]?.pool.dice[0]?.sides, D20_SIDES);
  assert.equal(melee?.bonus, MIGHT_MOD);
  const ranged = offeredCheckFor(campaign, { ...OFFER, ruleId: 'attack.ranged' }, HERO)?.('a', createSeededRng(SEED));
  assert.equal(ranged?.bonus, -2);
});

const FOE_DEFENSE = 12;
const FOE_HP = 9;
const HIT_FACE = 19;
const MISS_FACE = 2;
const DAMAGE_FACE = 3;
const HALF = 0.5;
const D6 = 6;

const drawing = (...rolls: [face: number, sides: number][]) => {
  const queue = rolls.map(([face, sides]) => (face - 1 + HALF) / sides);
  return () => queue.shift() ?? 0;
};

const foeSheet = (hp: number | null = FOE_HP, rulepack = D20_LITE_MANIFEST.revision) => ({
  detail: 'sparse',
  npcId: 'npc-tam',
  role: 'minor',
  name: 'Old Tam',
  motivations: [],
  background: '',
  traits: [{ id: 'defense', value: FOE_DEFENSE }, ...(hp === null ? [] : [{ id: 'hp', value: hp }])],
  rulepack: { id: D20_LITE_MANIFEST.id, edition: D20_LITE_MANIFEST.edition, revision: rulepack },
});

const tam = (sheet?: unknown, visibility: CampaignEntity['visibility'] = 'public'): CampaignEntity => ({
  id: 'npc-tam',
  campaignId: 'campaign-1',
  kind: 'npc',
  name: 'Old Tam',
  data: sheet === undefined ? {} : { [NPC_SHEET_FIELD]: sheet },
  visibility,
  actorId: null,
});

const strongHero = () => [...configured(builtInConfig('d20-lite')), heroCreated({ ...ATTRIBUTES, might: 8 })];

const strike = (events: CampaignEvent[], entities: CampaignEntity[], rng: () => number, ruleId = 'attack.melee') =>
  offeredCheckFor(events, { ...OFFER, ruleId }, HERO, entities)?.('a', rng);

test('rpg-42a.84: a hit against a target sheet rolls damage and reports it', () => {
  const result = strike(strongHero(), [tam(foeSheet())], drawing([HIT_FACE, D20_SIDES], [DAMAGE_FACE, D6]));
  assert.equal(result?.events[0]?.event, 'attack.hit');
  assert.equal(result?.target, FOE_DEFENSE);
  assert.equal(result?.bonus, MIGHT_MOD + PROFICIENCY);
  assert.deepEqual(result?.damage, { targetId: 'npc-tam', amount: MIGHT_MOD + DAMAGE_FACE, defeated: false });
  assert.deepEqual(
    result?.modifiers?.map(({ id }) => id),
    ['proficiency'],
  );
});

test('rpg-42a.84: a miss deals nothing and a hit that empties the hit points defeats the target', () => {
  const miss = strike(strongHero(), [tam(foeSheet())], drawing([MISS_FACE, D20_SIDES]));
  assert.equal(miss?.events[0]?.event, 'attack.miss');
  assert.equal(miss?.damage?.amount ?? 0, 0);
  const rolls = drawing([HIT_FACE, D20_SIDES], [DAMAGE_FACE, D6]);
  const finisher = strike(strongHero(), [tam(foeSheet(2))], rolls);
  assert.deepEqual(finisher?.damage, { targetId: 'npc-tam', amount: 2, defeated: true });
});

test('rpg-42a.84: earlier damage lowers the hit points the next attack sees', () => {
  const earlier = {
    type: DAMAGE_APPLIED,
    payload: { targetId: 'npc-tam', amount: FOE_HP - 1, defeated: false },
  } as unknown as CampaignEvent;
  const result = strike(
    [...strongHero(), earlier],
    [tam(foeSheet())],
    drawing([HIT_FACE, D20_SIDES], [DAMAGE_FACE, D6]),
  );
  assert.deepEqual(result?.damage, { targetId: 'npc-tam', amount: 1, defeated: true });
});

test('rpg-42a.84: without usable target data the offered roll behaves as before', () => {
  const rng = () => 0.5;
  const plain = strike(strongHero(), [], rng);
  assert.equal(plain?.damage, undefined);
  assert.equal(plain?.target, DEFAULT_CHECK_DC);
  assert.equal(plain?.bonus, MIGHT_MOD);
  const unusable = [tam(), tam(foeSheet(null)), tam(foeSheet(FOE_HP, 'r99')), tam('not a sheet')];
  for (const entity of unusable) {
    const result = strike(strongHero(), [entity], rng);
    assert.equal(result?.damage, undefined);
    assert.equal(result?.target, DEFAULT_CHECK_DC);
  }
  const notAnAttack = strike(strongHero(), [tam(foeSheet())], rng, 'check.might');
  assert.equal(notAnAttack?.damage, undefined);
  assert.equal(notAnAttack?.target, DEFAULT_CHECK_DC);
});

test('rpg-42a.84: a GM-only npc target rolls as a plain check and leaks no defense', () => {
  const result = strike(strongHero(), [tam(foeSheet(), 'gm')], () => 0.5);
  assert.equal(result?.damage, undefined);
  assert.equal(result?.target, DEFAULT_CHECK_DC);
});

test('rpg-42a.84: a pool rulepack rolls only, whatever the target sheet holds', () => {
  const campaign = configured(builtInConfig('dice-pool-lite'));
  const result = offeredCheckFor(campaign, { ...OFFER, ruleId: 'check.pool' }, HERO, [tam(foeSheet())])?.(
    'a',
    createSeededRng(SEED),
  );
  assert.equal(result?.damage, undefined);
});

test('rpg-42a.74: an offered rule the pack does not define is refused', () => {
  const campaign = [...configured(builtInConfig('d20-lite')), heroCreated(ATTRIBUTES)];
  assert.equal(offeredCheckFor(campaign, { ...OFFER, ruleId: 'attack.vorpal' }, HERO), undefined);
  assert.equal(offeredCheckFor([], OFFER, HERO), undefined);
});

const submitted = (input: string) =>
  ({ type: PLAYER_ACTION_SUBMITTED, payload: { input } }) as unknown as CampaignEvent;
const offered = (offer = { ...OFFER, ruleId: 'attack.ranged' }) =>
  ({ type: CHECK_OFFERED, payload: { offer } }) as unknown as CampaignEvent;
const RANGED_BONUS = -2;
const LOCK = 'I try to pick the lock';

test('rpg-42a.74: a text reply accepts the open offer only while no player action follows it', () => {
  const base = [...configured(builtInConfig('d20-lite')), heroCreated({ ...ATTRIBUTES, might: 8, agility: 3 })];
  const bonusOf = (events: readonly CampaignEvent[], input: string) =>
    checkForAction(events, { input }, HERO, undefined, 'as-written')?.('a', createSeededRng(SEED)).bonus;
  const open = [...base, submitted('I shoot at Tam'), offered()];
  assert.equal(bonusOf(open, LOCK), RANGED_BONUS);
  const proposalTurn = [...open, submitted('GM proposal entity stranger')];
  assert.equal(bonusOf(proposalTurn, LOCK), RANGED_BONUS);
  const moved = [...open, submitted('I look at the bar')];
  assert.equal(bonusOf(moved, LOCK), MIGHT_MOD);
});

test('rpg-42a.74: an offer id is still accepted after later actions', () => {
  const base = [...configured(builtInConfig('d20-lite')), heroCreated({ ...ATTRIBUTES, might: 8, agility: 3 })];
  const events = [...base, offered(), submitted('I look at the bar')];
  const check = checkForAction(events, { input: 'Yes', rollOfferId: OFFER.offerId }, HERO, undefined, 'as-written');
  assert.equal(check?.('a', createSeededRng(SEED)).bonus, RANGED_BONUS);
});

test('rpg-42a.74: an offer id whose rule the pack no longer defines is closed, not a plain action', () => {
  const base = [...configured(builtInConfig('d20-lite')), heroCreated(ATTRIBUTES)];
  const events = [...base, offered({ ...OFFER, ruleId: 'attack.vorpal' })];
  assert.throws(
    () => checkForAction(events, { input: 'Yes', rollOfferId: OFFER.offerId }, HERO, undefined, 'as-written'),
    /no longer open/,
  );
});

test('rpg-42a.89: a GM roll resolves to a dice expression the RulePack allows', () => {
  const d20 = [...configured(builtInConfig('d20-lite')), heroCreated(ATTRIBUTES)];
  assert.equal(gmRollExpressionFor(d20, 'as-written', { ruleId: 'attack.melee' }), '1d20');
  assert.equal(gmRollExpressionFor(d20, 'as-written', { expression: '1d8+2' }), '1d8+2');
  assert.equal(gmRollExpressionFor(d20, 'as-written', { ruleId: 'attack.vorpal' }), undefined);
  assert.equal(gmRollExpressionFor(d20, 'off', { ruleId: 'attack.melee' }), undefined);
  assert.equal(gmRollExpressionFor(d20, 'off', { expression: '1d6' }), undefined);
  const pool = configured(builtInConfig('dice-pool-lite'));
  assert.equal(gmRollExpressionFor(pool, 'as-written', { ruleId: 'check.pool' }), '2d6');
  assert.equal(
    gmRollExpressionFor(configured(builtInConfig('d20-lite', 'off')), 'as-written', { expression: '1d6' }),
    undefined,
  );
  assert.equal(gmRollExpressionFor([], 'as-written', { expression: '1d6' }), undefined);
  assert.equal(gmRollExpressionFor(d20, 'as-written', { expression: '1d6', roller: 'player' }), undefined);
});

test('rpg-42a.82: own rules refuse every roll when strictness is off and a ruleId always', () => {
  const document = {
    name: 'rules.md',
    format: 'markdown',
    sourceHash: 'a'.repeat(64),
    text: '# Melee Attacks\nRoll 2d6.',
  };
  const events = [{ type: RULES_DOCUMENT_ADDED, payload: { document } }] as unknown as CampaignEvent[];
  const roll = { expression: '2d6', roller: 'player', section: 'Melee Attacks' };
  assert.equal(gmRollExpressionFor(events, 'off', roll), undefined);
  assert.equal(gmRollExpressionFor(events, 'as-written', roll), '2d6');
  assert.equal(gmRollExpressionFor(events, 'as-written', { ...roll, ruleId: 'attack.melee' }), undefined);
});

test('rpg-42a.89: a GM roll carries its roller label into the mechanic result', () => {
  const roll = d20Roll();
  const resolution = { ok: true, rolls: [roll], events: [] };
  assert.equal(resultsOf({ resolution, roller: 'old-tam', rollerName: 'Old Tam' }, 'player')[0]?.roller, 'Old Tam');
  assert.equal(resultsOf({ resolution, roller: 'gm' }, 'player')[0]?.roller, 'GM');
  assert.equal(resultsOf({ resolution }, 'player')[0]?.roller, undefined);
  assert.equal(resultsOf({ resolution, roller: 'gm' }, 'gm').length, 1);
  assert.deepEqual(emitVisualizations(resultsOf({ resolution, roller: 'gm' }, 'gm'), 'player', ENABLED), []);
});

test('rpg-42a.103: an offered die-step modifier changes the damage die of an attack', () => {
  const stepped = 8;
  const STEP_TEST_HP = 50;
  const empowered = { id: 'empowered', reason: 'a blessed blade', effect: { kind: 'step', steps: 1 } } as const;
  const offer = { ...OFFER, modifiers: [empowered] };
  const result = offeredCheckFor(strongHero(), offer, HERO, [tam(foeSheet(STEP_TEST_HP))])?.(
    'a',
    drawing([HIT_FACE, D20_SIDES], [stepped, stepped]),
  );
  assert.deepEqual(result?.damage, { targetId: 'npc-tam', amount: MIGHT_MOD + stepped, defeated: false });
  assert.ok(result?.modifiers?.some(({ id }) => id === 'empowered'));
});

test('rpg-42a.103: a die-step modifier on a plain check is not applied or shown', () => {
  const empowered = { id: 'empowered', reason: 'a blessed blade', effect: { kind: 'step', steps: 1 } } as const;
  const offer = { ...OFFER, ruleId: 'check.might', modifiers: [empowered] };
  const result = offeredCheckFor(strongHero(), offer, HERO, [tam(foeSheet())])?.('a', drawing([HIT_FACE, D20_SIDES]));
  assert.equal(result?.modifiers, undefined);
});
