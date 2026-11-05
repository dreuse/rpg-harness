import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VISUALIZATION_EVENT } from '../../../packages/client-protocol/src/visualization.ts';
import { CAMPAIGN_CONFIGURED, type CampaignEvent } from '../../../packages/domain/src/campaign.ts';
import { CHARACTER_CREATED, SHEET_FIELD_EDITED } from '../../../packages/engine/src/character.ts';
import { generateCampaignConfig } from '../../../packages/intent/src/config.ts';
import { createCampaignIntent } from '../../../packages/intent/src/intent.ts';
import {
  attemptCheck,
  checkBonus,
  createSheet,
  D20_LITE_MANIFEST,
  DEFAULT_CHECK_ATTRIBUTE,
  DEFAULT_CHECK_DC,
} from '../../../packages/rules/src/d20-lite.ts';
import { createSeededRng } from '../../../packages/rules/src/dice.ts';
import { DEFAULT_POOL_CONFIG, rollPool } from '../../../packages/rules/src/dice-pool-lite.ts';
import { BUILT_IN_PACKS } from './import-gateway.ts';
import {
  checkFor,
  checkResult,
  DICE_MECHANIC,
  emitVisualizations,
  POOL_MECHANIC,
  poolResult,
  resultsOf,
  rollResult,
  visualizationPreferenceOf,
} from './roll-visualization.ts';

const SEED = 7;
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

  assert.equal(checkFor(configured(builtInConfig('d20-lite')), TRY, HERO), undefined);
  assert.equal(checkFor([...campaign, sheetEdited(DEFAULT_CHECK_ATTRIBUTE, 99)], TRY, HERO), undefined);
  assert.equal(checkFor(campaign, TRY, 'stranger'), undefined);
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
