import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { type GenrePack, loadGenrePack } from '../../../packages/content/src/genrepack.ts';
import { FANTASY_PACK, HORROR_PACK, MYSTERY_PACK, SCIENCE_FICTION_PACK } from '../../../packages/content/src/packs.ts';
import type { CampaignState, CampaignStore } from '../../../packages/domain/src/campaign.ts';
import type { RuleCitation } from '../../../packages/domain/src/character.ts';
import { advanceGameTime, defineClock, scheduleEffect, worldTime } from '../../../packages/engine/src/clock.ts';
import { type Narrator, playGameplayTurn } from '../../../packages/engine/src/gameplay.ts';
import { type CitedRuleMove, RuleCitationError, resolveCitedRule } from '../../../packages/engine/src/mechanics.ts';
import { createFakeGameMaster, runScript } from '../../../packages/engine/src/scripted-session.ts';
import { loadState, type PlayerAction } from '../../../packages/engine/src/turn.ts';
import { houseRuleMechanics } from '../../../packages/imports/src/effective-mechanics.ts';
import {
  applyHouseRule,
  baseEffectiveRules,
  type EffectiveRules,
  type HouseRule,
  undoHouseRule,
} from '../../../packages/imports/src/house-rules.ts';
import { PLAYER_VIEWER } from '../../../packages/memory/src/knowledge.ts';
import { createCampaignStore } from '../../../packages/persistence/src/campaign-store.ts';
import { openDatabase } from '../../../packages/persistence/src/database.ts';
import { compileRule } from '../../../packages/rules/src/compile.ts';
import { D20_LITE_MANIFEST } from '../../../packages/rules/src/d20-lite.ts';
import { DICE_POOL_LITE_MANIFEST } from '../../../packages/rules/src/dice-pool-lite.ts';
import {
  type EffectiveMechanic,
  type NumberExpr,
  RULE_DSL_VERSION,
  type RuleDsl,
} from '../../../packages/rules/src/dsl.ts';
import {
  checkRequiredCapabilities,
  RULEPACK_CONTRACT_VERSION,
  type RulePackManifest,
} from '../../../packages/rules/src/rulepack.ts';
import type { TraitSheet } from '../../../packages/rules/src/traits.ts';
import { createScriptedRng } from '../../../packages/testkit/src/fixtures.ts';

const TEMP_PREFIX = 'rpg-q04-';
const DATABASE_FILE = 'campaigns.sqlite';
const ENGINE_SOURCE = join(import.meta.dirname, '..', '..', '..', 'packages', 'engine', 'src');
const TEST_SUFFIX = '.test.ts';
const SOURCE_SUFFIX = '.ts';
const SETUP_REVISION = 1;
const SKILL = 2;
const DRAWS = [0.25, 0.75, 0.5, 0.9];
const D20_SIDES = 20;
const POOL_SIDES = 6;
const POOL_DICE = 3;
const HOUSE_POOL_DICE = 4;
const KEPT_DICE = 1;
const THREAT_SEGMENTS = 4;
const PROGRESS_SEGMENTS = 2;
const THREAT_STEP = 2;
const PROGRESS_STEP = 1;
const TIME_UNITS = 3;
const TIME_EFFECT_AT = 3;
const RULE_ID = 'task.resolve';
const OUTCOME = 'outcome';
const BASE_SECTION = 'core-chapter-2';
const RULEPACK_SOURCE = 'rulepack';
const HOUSE_RULE_SOURCE = 'house_rule';
const THREAT = 'threat';
const PROGRESS = 'progress';
const THREAT_EFFECT = 'threat-strikes';
const PROGRESS_EFFECT = 'progress-pays';
const TIME_EFFECT = 'dawn-breaks';
const RULE_RESOLVED = 'RuleResolved';
const CLOCK_TICKED = 'ClockTicked';
const CLOCK_COMPLETED = 'ClockCompleted';
const EFFECT_FIRED = 'DelayedEffectFired';
const ACTION_VALIDATED = 'ActionValidated';
const NARRATION_CONTEXT = { facts: [], equipment: {}, viewer: PLAYER_VIEWER };
const SOURCE_MISMATCH = 'SourceMismatch';
const NARRATED_ACTIONS = ['first-task', 'second-task'];

const ruleOf = (dice: NumberExpr): RuleDsl => ({
  dslVersion: RULE_DSL_VERSION,
  id: RULE_ID,
  effects: [
    {
      kind: 'setTrait',
      trait: OUTCOME,
      value: { kind: 'arith', op: 'add', left: dice, right: { kind: 'ref', id: 'skill' } },
    },
    { kind: 'emitEvent', event: 'task.resolved' },
  ],
});

const manifestOf = (id: string, edition: string): RulePackManifest => ({
  contractVersion: RULEPACK_CONTRACT_VERSION,
  id,
  edition,
  revision: '1',
  capabilities: { random: true, arithmetic: true, effects: true },
  sourceRefs: [BASE_SECTION],
});

const poolDice = (count: number): NumberExpr => ({
  kind: 'dice',
  count,
  sides: POOL_SIDES,
  modifier: 0,
  keep: { which: 'highest', count: KEPT_DICE },
});

const RULESETS = [
  {
    manifest: manifestOf('single-die-system', 'd20'),
    rule: ruleOf({ kind: 'dice', count: 1, sides: D20_SIDES, modifier: 0 }),
  },
  { manifest: manifestOf('dice-pool-system', 'pool'), rule: ruleOf(poolDice(POOL_DICE)) },
] as const;
const POOL_RULESET = RULESETS[1];

const GENRES = [FANTASY_PACK, SCIENCE_FICTION_PACK, HORROR_PACK, MYSTERY_PACK].map(({ genre }) => {
  const result = loadGenrePack(genre);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.pack;
});

const HOUSE_RULE: HouseRule = {
  id: 'extra-die',
  source: { kind: HOUSE_RULE_SOURCE, author: 'table', note: 'Roll one more die and keep the best.' },
  rule: ruleOf(poolDice(HOUSE_POOL_DICE)),
};

const unwrap = <T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> => {
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result as Extract<T, { ok: true }>;
};

const baseRules = ({ manifest, rule }: (typeof RULESETS)[number]): EffectiveRules =>
  unwrap(
    baseEffectiveRules(manifest, [unwrap(compileRule({ rule, rulePack: manifest, sourceRefs: [BASE_SECTION] })).rule]),
  ).effective;

const withDatabaseFile = (run: (path: string) => void) => {
  const directory = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
  try {
    run(join(directory, DATABASE_FILE));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

const inSession = <T>(path: string, run: (store: CampaignStore) => T): T => {
  const connection = openDatabase(path);
  try {
    return run(createCampaignStore(connection.database));
  } finally {
    connection.close();
  }
};

type Campaign = { readonly id: string; readonly actorId: string; readonly sceneId: string };

const startCampaign = (store: CampaignStore, id: string, genre: GenrePack): Campaign => {
  const campaign = { id, actorId: `${id}-hero`, sceneId: `${id}-scene` };
  store.createCampaign(
    { id, name: genre.name },
    { id: `${id}-created`, campaignId: id, branchId: 'main', actionId: 'create', type: 'CampaignCreated', payload: {} },
  );
  store.commitTurn({
    expectedRevision: 0,
    turn: {
      id: `${id}-turn-0`,
      campaignId: id,
      sceneId: campaign.sceneId,
      actionId: 'setup',
      actorId: campaign.actorId,
      input: 'Begin.',
      narration: genre.examples[0] ?? genre.name,
    },
    characters: [{ id: campaign.actorId, campaignId: id, name: genre.archetypes[0]?.name ?? genre.name }],
    scenes: [{ id: campaign.sceneId, campaignId: id, title: genre.name }],
    events: [],
  });
  return campaign;
};

const actionFor = (store: CampaignStore, { id, actorId, sceneId }: Campaign, actionId: string): PlayerAction => ({
  campaignId: id,
  actionId,
  expectedRevision: loadState(store, id).revision,
  sceneId,
  actorId,
  input: `I attempt ${actionId}.`,
  intent: actionId,
});

const sheetOf = ({ actorId }: Campaign): TraitSheet => ({
  characterId: actorId,
  traits: [
    { id: 'skill', kind: 'trait', value: SKILL },
    { id: OUTCOME, kind: 'trait', value: 0 },
  ],
});

const citationOf = (mechanic: EffectiveMechanic): RuleCitation => ({
  ruleId: mechanic.ruleId,
  rulepack: mechanic.rulePack,
  section: mechanic.source.sourceRef,
});

const ruleMove = (
  store: CampaignStore,
  campaign: Campaign,
  actionId: string,
  effective: EffectiveRules,
  citation = citationOf(houseRuleMechanics(effective)[0] as EffectiveMechanic),
): CitedRuleMove => ({
  ...actionFor(store, campaign, actionId),
  citation,
  rulePack: citation.rulepack,
  mechanics: houseRuleMechanics(effective),
  sheet: sheetOf(campaign),
  rng: createScriptedRng(DRAWS),
});

const narrator: Narrator = { narrate: ({ turn }) => ({ narration: `${turn.input} The world answers.`, claims: [] }) };

const playRule = (store: CampaignStore, move: CitedRuleMove) => {
  const outcome = playGameplayTurn(store, narrator, resolveCitedRule, move, NARRATION_CONTEXT);
  assert.ok('narration' in outcome);
  return outcome.committed;
};

const gmTurn = (store: CampaignStore, campaign: Campaign, actionId: string, genre: GenrePack) => {
  const { campaignId: _campaignId, expectedRevision: _revision, ...proposal } = actionFor(store, campaign, actionId);
  const reply = { proposal, narration: genre.narrativeConstraints[0] ?? genre.name };
  const [outcome] = runScript(store, createFakeGameMaster([reply]), campaign.id, 1);
  assert.ok(outcome !== undefined && 'committed' in outcome);
};

const tick = (store: CampaignStore, campaign: Campaign, actionId: string, clockId: string, segments: number) =>
  advanceGameTime(store, {
    ...actionFor(store, campaign, actionId),
    trigger: { kind: 'clock-tick', clockId, segments, reason: actionId },
  });

const define = (store: CampaignStore, campaign: Campaign, clockId: string, segments: number) =>
  defineClock(store, { ...actionFor(store, campaign, `define-${clockId}`), clockId, label: clockId, segments });

const defineClocks = (store: CampaignStore, campaign: Campaign) => {
  define(store, campaign, THREAT, THREAT_SEGMENTS);
  define(store, campaign, PROGRESS, PROGRESS_SEGMENTS);
};

const schedule = (
  store: CampaignStore,
  campaign: Campaign,
  effectId: string,
  due: Parameters<typeof scheduleEffect>[1]['due'],
) =>
  scheduleEffect(store, {
    ...actionFor(store, campaign, `schedule-${effectId}`),
    effectId,
    due,
    effect: { summary: effectId },
  });

const eventsOf = (state: CampaignState, type: string) => state.events.filter((event) => event.type === type);

const assertCausalIntegrity = ({ turns, events }: CampaignState) => {
  const order = new Map(turns.map(({ id }, index) => [id, index]));
  const positions = events.map(({ turnId }) => order.get(turnId) ?? -1);
  assert.ok(positions.every((position) => position >= 0));
  assert.deepEqual(
    positions,
    [...positions].sort((left, right) => left - right),
  );
  assert.equal(new Set(events.map(({ id }) => id)).size, events.length);
  for (const turn of turns) {
    const own = events.filter(({ turnId }) => turnId === turn.id);
    assert.deepEqual(
      own.map(({ causationId }) => causationId),
      own.map((_, index) => (index === 0 ? null : (own[index - 1]?.id ?? null))),
    );
  }
  eventsOf({ turns, events } as CampaignState, ACTION_VALIDATED).forEach(({ payload }, index) => {
    assert.deepEqual(payload, { revision: SETUP_REVISION + index + 1 });
  });
};

const projectionsByTurn = ({ turns, events }: CampaignState) =>
  turns.map((_, index) => {
    const included = new Set(turns.slice(0, index + 1).map(({ id }) => id));
    return worldTime(events.filter(({ turnId }) => included.has(turnId)));
  });

const engineSources = () =>
  readdirSync(ENGINE_SOURCE)
    .filter((file) => file.endsWith(SOURCE_SUFFIX) && !file.endsWith(TEST_SUFFIX))
    .map((file) => readFileSync(join(ENGINE_SOURCE, file), 'utf8').toLowerCase());

test('verify fantasy, sci-fi, horror and mystery multi-session campaigns across rulesets', () =>
  withDatabaseFile((path) => {
    const runs = GENRES.flatMap((genre) =>
      RULESETS.map((ruleset) => ({ genre, ruleset, id: `${genre.id}-${ruleset.manifest.id}` })),
    );
    for (const { genre, ruleset } of runs) {
      assert.deepEqual(checkRequiredCapabilities(ruleset.manifest, genre.requiredRuleCapabilities ?? []), { ok: true });
    }

    const campaigns = inSession(path, (store) =>
      runs.map(({ genre, ruleset, id }) => {
        const campaign = startCampaign(store, id, genre);
        defineClocks(store, campaign);
        schedule(store, campaign, PROGRESS_EFFECT, { kind: 'clock', clockId: PROGRESS });
        gmTurn(store, campaign, 'explore', genre);
        playRule(store, ruleMove(store, campaign, NARRATED_ACTIONS[0] as string, baseRules(ruleset)));
        return campaign;
      }),
    );

    const live = inSession(path, (store) =>
      runs.map(({ genre, ruleset }, index) => {
        const campaign = campaigns[index] as Campaign;
        tick(store, campaign, 'push-on', PROGRESS, PROGRESS_SEGMENTS);
        advanceGameTime(store, {
          ...actionFor(store, campaign, 'rest'),
          trigger: { kind: 'time-passage', units: TIME_UNITS, reason: 'rest' },
        });
        gmTurn(store, campaign, 'regroup', genre);
        playRule(store, ruleMove(store, campaign, NARRATED_ACTIONS[1] as string, baseRules(ruleset)));
        return loadState(store, campaign.id);
      }),
    );

    const resumed = inSession(path, (store) => campaigns.map(({ id }) => loadState(store, id)));
    assert.deepEqual(resumed, live);

    const shapes = resumed.map(({ turns, events }) =>
      turns.map(({ id }) => events.filter(({ turnId }) => turnId === id).map(({ type }) => type)),
    );
    resumed.forEach((state, index) => {
      const { ruleset } = runs[index] as (typeof runs)[number];
      assert.equal(state.revision, live[index]?.revision);
      assert.ok(state.events.every(({ campaignId }) => campaignId === state.campaign.id));
      assert.deepEqual(shapes[index], shapes[0]);
      assertCausalIntegrity(state);
      assert.deepEqual(worldTime(state.events), {
        now: TIME_UNITS,
        clocks: [
          { clockId: THREAT, label: THREAT, segments: THREAT_SEGMENTS, current: 0 },
          { clockId: PROGRESS, label: PROGRESS, segments: PROGRESS_SEGMENTS, current: PROGRESS_SEGMENTS },
        ],
        effects: [
          {
            effectId: PROGRESS_EFFECT,
            due: { kind: 'clock', clockId: PROGRESS },
            effect: { summary: PROGRESS_EFFECT },
            fired: true,
          },
        ],
      });
      const resolved = eventsOf(state, RULE_RESOLVED);
      assert.equal(resolved.length, RULESETS.length);
      for (const { payload } of resolved) {
        const { id, edition, revision } = ruleset.manifest;
        assert.deepEqual(payload.rulePack, { id, edition, revision });
        assert.equal((payload.resolution as { ok: boolean }).ok, true);
      }
      const narrated = state.turns.filter(({ actionId }) => NARRATED_ACTIONS.includes(actionId));
      assert.deepEqual(
        narrated.map(({ narration }) => narration),
        NARRATED_ACTIONS.map((actionId) => `I attempt ${actionId}. The world answers.`),
      );
    });

    const forbidden = [
      ...GENRES.map(({ id }) => id),
      ...RULESETS.map(({ manifest }) => manifest.id),
      D20_LITE_MANIFEST.id,
      DICE_POOL_LITE_MANIFEST.id,
    ];
    for (const source of engineSources()) {
      for (const word of forbidden) assert.equal(source.includes(word), false, `engine core mentions ${word}`);
    }
  }));

test('multiple concurrent world clocks and imported house rules retain causal integrity', () =>
  withDatabaseFile((path) => {
    const base = baseRules(POOL_RULESET);
    const overlaid = unwrap(applyHouseRule(base, HOUSE_RULE)).effective;
    const genre = HORROR_PACK.genre as GenrePack;
    const snapshots: ReturnType<typeof worldTime>[] = [];
    const record = (store: CampaignStore, id: string) => snapshots.push(worldTime(loadState(store, id).events));
    const step = (store: CampaignStore, id: string, run: () => unknown) => {
      run();
      record(store, id);
    };

    const campaign = inSession(path, (store) => {
      const started = startCampaign(store, 'haunting', genre);
      record(store, started.id);
      step(store, started.id, () => define(store, started, THREAT, THREAT_SEGMENTS));
      step(store, started.id, () => define(store, started, PROGRESS, PROGRESS_SEGMENTS));
      step(store, started.id, () => schedule(store, started, THREAT_EFFECT, { kind: 'clock', clockId: THREAT }));
      step(store, started.id, () => schedule(store, started, PROGRESS_EFFECT, { kind: 'clock', clockId: PROGRESS }));
      step(store, started.id, () => schedule(store, started, TIME_EFFECT, { kind: 'time', at: TIME_EFFECT_AT }));
      step(store, started.id, () => tick(store, started, 'threat-1', THREAT, THREAT_STEP));
      step(store, started.id, () => tick(store, started, 'progress-1', PROGRESS, PROGRESS_STEP));
      step(store, started.id, () => playRule(store, ruleMove(store, started, 'base-task', base)));
      return started;
    });

    inSession(path, (store) => {
      const before = loadState(store, campaign.id);
      assert.throws(
        () =>
          resolveCitedRule(
            store,
            ruleMove(
              store,
              campaign,
              'stale-task',
              overlaid,
              citationOf(houseRuleMechanics(base)[0] as EffectiveMechanic),
            ),
          ),
        (error) => error instanceof RuleCitationError && error.code === SOURCE_MISMATCH,
      );
      assert.deepEqual(loadState(store, campaign.id), before);
      step(store, campaign.id, () => tick(store, campaign, 'progress-2', PROGRESS, PROGRESS_STEP));
      step(store, campaign.id, () => playRule(store, ruleMove(store, campaign, 'house-task', overlaid)));
      step(store, campaign.id, () =>
        advanceGameTime(store, {
          ...actionFor(store, campaign, 'wait'),
          trigger: { kind: 'time-passage', units: TIME_UNITS, reason: 'wait' },
        }),
      );
    });

    const houseTurn = inSession(path, (store) => {
      step(store, campaign.id, () => tick(store, campaign, 'threat-2', THREAT, THREAT_STEP));
      const undone = unwrap(undoHouseRule(overlaid)).effective;
      const replay = resolveCitedRule(store, ruleMove(store, campaign, 'house-task', undone));
      const state = loadState(store, campaign.id);
      assert.throws(
        () =>
          resolveCitedRule(
            store,
            ruleMove(
              store,
              campaign,
              'late-task',
              undone,
              citationOf(houseRuleMechanics(overlaid)[0] as EffectiveMechanic),
            ),
          ),
        (error) => error instanceof RuleCitationError && error.code === SOURCE_MISMATCH,
      );
      assert.deepEqual(loadState(store, campaign.id), state);
      return replay;
    });

    const state = inSession(path, (store) => loadState(store, campaign.id));
    assertCausalIntegrity(state);
    assert.deepEqual(projectionsByTurn(state), snapshots);
    assert.deepEqual(worldTime(state.events).clocks, [
      { clockId: THREAT, label: THREAT, segments: THREAT_SEGMENTS, current: THREAT_SEGMENTS },
      { clockId: PROGRESS, label: PROGRESS, segments: PROGRESS_SEGMENTS, current: PROGRESS_SEGMENTS },
    ]);

    const ticks = eventsOf(state, CLOCK_TICKED).map(({ payload }) => [payload.clockId, payload.current]);
    assert.deepEqual(ticks, [
      [THREAT, THREAT_STEP],
      [PROGRESS, PROGRESS_STEP],
      [PROGRESS, PROGRESS_SEGMENTS],
      [THREAT, THREAT_SEGMENTS],
    ]);
    const completed = eventsOf(state, CLOCK_COMPLETED);
    const fired = eventsOf(state, EFFECT_FIRED);
    assert.deepEqual(
      fired.map(({ payload }) => payload.effectId),
      [PROGRESS_EFFECT, TIME_EFFECT, THREAT_EFFECT],
    );
    assert.deepEqual(
      completed.map(({ payload }) => payload.clockId),
      [PROGRESS, THREAT],
    );
    assert.equal(fired[0]?.causationId, completed[0]?.id);
    assert.equal(fired[2]?.causationId, completed[1]?.id);

    const resolved = eventsOf(state, RULE_RESOLVED);
    assert.equal(resolved.length, 2);
    const [baseResolution, houseResolution] = resolved;
    const layer = overlaid.layers[0];
    assert.deepEqual(baseResolution?.payload.rulePack, houseResolution?.payload.rulePack);
    assert.deepEqual(baseResolution?.payload.source, {
      kind: RULEPACK_SOURCE,
      sourceRef: BASE_SECTION,
      revision: POOL_RULESET.manifest.revision,
      overlayHash: base.version.overlayHash,
      depth: base.version.depth,
    });
    assert.deepEqual(houseResolution?.payload.source, {
      kind: HOUSE_RULE_SOURCE,
      sourceRef: layer?.sourceHash,
      revision: POOL_RULESET.manifest.revision,
      overlayHash: overlaid.version.overlayHash,
      depth: overlaid.version.depth,
    });
    assert.equal(base.version.depth, 0);
    assert.equal(overlaid.version.depth, 1);
    assert.notEqual(overlaid.version.overlayHash, base.version.overlayHash);
    assert.deepEqual(houseTurn.events.at(-1), houseResolution);
  }));
