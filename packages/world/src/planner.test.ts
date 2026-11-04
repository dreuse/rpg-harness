import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createWorldActor, startCooldown, type WorldActor } from './actor.ts';
import {
  createLlmPlanner,
  createSimplePlanner,
  DUPLICATE_ACTION,
  INVENTED_RESOURCE,
  KIND_NOT_PERMITTED,
  type LlmPlanContext,
  MALFORMED_DRAFT,
  MALFORMED_OUTPUT,
  MAX_LLM_DRAFTS,
  MAX_PROPOSALS_PER_ACTOR,
  PORT_FAILURE,
  PROPOSAL_LIMIT,
  type SimpleBehavior,
  UNEXPECTED_FIELD,
  UNKNOWN_ACTOR,
  UNKNOWN_FACT,
} from './planner.ts';
import { advanceWorld, FOREIGN_ACTOR, GAME_TIME_SOURCE, INITIAL_CURSOR, type PlanRequest } from './scheduler.ts';
import { admitProposals, type WorldConfig } from './world.ts';

const witnessed = (factId: string) =>
  ({ factId, channel: 'witnessed', sourceId: null, eventId: 'e1', tick: 0 }) as const;

const guild: WorldActor = createWorldActor({
  id: 'guild',
  kind: 'faction',
  name: 'Guild',
  goals: ['expand'],
  resources: { coin: 5, agents: 0 },
  knowledge: [witnessed('rival-weak'), witnessed('route-open')],
});
const hermit: WorldActor = createWorldActor({ id: 'hermit', kind: 'npc', name: 'Hermit' });

const behaviors: SimpleBehavior[] = [
  { kind: 'trade', knowledgeRefs: ['route-open'], resourceRefs: ['coin'] },
  { kind: 'spy', knowledgeRefs: ['rival-weak'], resourceRefs: ['agents'] },
  { kind: 'scheme', knowledgeRefs: ['rival-weak'], resourceRefs: [] },
  { kind: 'raid', knowledgeRefs: ['vault-open'], resourceRefs: [] },
];

const config: WorldConfig = {
  mode: 'balanced',
  budget: { maxActors: 4, maxActions: 8 },
  triggers: [{ kind: 'interval', every: 1, from: 0 }],
};

const request = (actorId: string, tick = 3): PlanRequest => ({
  actorId,
  clock: { tick, events: [] },
  triggers: config.triggers,
});

const draft = (extra: Record<string, unknown> = {}) => ({
  actorId: 'guild',
  kind: 'scheme',
  knowledgeRefs: ['rival-weak'],
  resourceRefs: [],
  ...extra,
});

const llm = (output: unknown) => createLlmPlanner([guild, hermit], behaviors, async () => output);

describe('W04 deterministic and LLM-driven actor planners', () => {
  it('generate typed scoped action proposals with deterministic simple behaviors and optional llm planning', async () => {
    const simple = createSimplePlanner([guild, hermit], behaviors);
    assert.deepEqual(simple(request('guild')), [
      {
        actionId: 'guild:trade@3',
        actorId: 'guild',
        kind: 'trade',
        knowledgeRefs: ['route-open'],
        resourceRefs: ['coin'],
        tick: 3,
      },
      {
        actionId: 'guild:scheme@3',
        actorId: 'guild',
        kind: 'scheme',
        knowledgeRefs: ['rival-weak'],
        resourceRefs: [],
        tick: 3,
      },
    ]);
    assert.deepEqual(simple(request('hermit')), []);
    assert.deepEqual(simple(request('stranger')), []);

    const run = advanceWorld(
      config,
      INITIAL_CURSOR,
      { source: GAME_TIME_SOURCE, approved: true, fromTick: 0, toTick: 1 },
      ['guild'],
      simple,
    );
    assert.ok(run.ok);
    assert.deepEqual(
      run.accepted.map((a) => a.actionId),
      ['guild:trade@1', 'guild:scheme@1'],
    );

    const seen: LlmPlanContext[] = [];
    const planner = createLlmPlanner([guild], behaviors, async (context) => {
      seen.push(context);
      return [draft({ kind: 'trade', knowledgeRefs: ['route-open'], resourceRefs: ['coin'] })];
    });
    const outcome = await planner(request('guild'));
    assert.equal(outcome.source, 'llm');
    assert.deepEqual(outcome.rejected, []);
    assert.deepEqual(outcome.proposals, [
      {
        actionId: 'guild:trade@3',
        actorId: 'guild',
        kind: 'trade',
        knowledgeRefs: ['route-open'],
        resourceRefs: ['coin'],
        tick: 3,
      },
    ]);
    assert.deepEqual(seen[0], {
      actorId: 'guild',
      actorKind: 'faction',
      goals: ['expand'],
      knownFacts: ['rival-weak', 'route-open'],
      resources: { coin: 5, agents: 0 },
      allowedKinds: ['trade', 'spy', 'scheme', 'raid'],
      clock: { tick: 3, events: [] },
      triggers: config.triggers,
    });
    assert.equal(admitProposals(config, outcome.proposals).accepted.length, 1);
  });

  it('an llm agent cannot write directly to world state or invent actor resources', async () => {
    const before = structuredClone(guild);
    const planner = createLlmPlanner([guild], behaviors, async (context) => {
      (context.resources as Record<string, number>).coin = 9999;
      (context.knownFacts as string[]).push('vault-open');
      return [
        draft({ kind: 'trade', knowledgeRefs: ['route-open'], resourceRefs: ['dragon-hoard'] }),
        draft({ kind: 'raid', knowledgeRefs: ['vault-open'] }),
        draft({ effects: { coin: 9999 } }),
        draft({ actorId: 'hermit' }),
        draft(),
      ];
    });
    const outcome = await planner(request('guild'));
    assert.deepEqual(guild, before);
    assert.deepEqual(
      outcome.proposals.map((p) => p.actionId),
      ['guild:scheme@3'],
    );
    assert.deepEqual(
      outcome.rejected.map((r) => r.reason),
      [INVENTED_RESOURCE, UNKNOWN_FACT, UNEXPECTED_FIELD, FOREIGN_ACTOR],
    );
    assert.ok(outcome.proposals.every((p) => !('effects' in p)));
  });

  it('falls back to simple behaviors on malformed llm output or port failure', async () => {
    const fallback = createSimplePlanner([guild], behaviors)(request('guild'));
    for (const output of [undefined, 'trade please', { kind: 'trade' }, Array(MAX_LLM_DRAFTS + 1).fill(draft())]) {
      const outcome = await llm(output)(request('guild'));
      assert.equal(outcome.source, 'fallback');
      assert.deepEqual(outcome.proposals, fallback);
      assert.deepEqual(
        outcome.rejected.map((r) => r.reason),
        [MALFORMED_OUTPUT],
      );
    }
    const failing = createLlmPlanner([guild], behaviors, async () => {
      throw new Error('provider down');
    });
    const outcome = await failing(request('guild'));
    assert.equal(outcome.source, 'fallback');
    assert.deepEqual(outcome.proposals, fallback);
    assert.deepEqual(
      outcome.rejected.map((r) => r.reason),
      [PORT_FAILURE],
    );
  });

  it('drops malformed llm drafts and duplicates with explicit reasons', async () => {
    const outcome = await llm([
      null,
      draft({ kind: '' }),
      draft({ kind: 'teleport' }),
      draft({ knowledgeRefs: [] }),
      draft({ resourceRefs: 'coin' }),
      draft({ tick: 99, actionId: 'x' }),
    ])(request('guild'));
    assert.deepEqual(outcome.proposals, []);
    assert.deepEqual(
      outcome.rejected.map((r) => r.reason),
      [MALFORMED_DRAFT, MALFORMED_DRAFT, KIND_NOT_PERMITTED, MALFORMED_DRAFT, MALFORMED_DRAFT, UNEXPECTED_FIELD],
    );
    const dup = await llm([draft(), draft()])(request('guild'));
    assert.deepEqual(
      dup.proposals.map((p) => p.actionId),
      ['guild:scheme@3'],
    );
    assert.deepEqual(
      dup.rejected.map((r) => r.reason),
      [DUPLICATE_ACTION],
    );
  });

  it('reads each llm draft once so getters and sparse arrays cannot bypass scope checks', async () => {
    const owned = new Set(Object.keys(guild.resources).filter((ref) => (guild.resources[ref] as number) > 0));
    for (const honestReads of [1, 2, 3]) {
      let reads = 0;
      const swapping = {
        actorId: 'guild',
        kind: 'trade',
        knowledgeRefs: ['route-open'],
        get resourceRefs() {
          reads += 1;
          return reads <= honestReads ? ['coin'] : ['dragon-hoard'];
        },
      };
      const outcome = await llm([swapping])(request('guild'));
      assert.ok(outcome.proposals.every((p) => p.resourceRefs.every((ref) => owned.has(ref))));
    }
    const sparse = await llm([
      draft({ kind: 'trade', knowledgeRefs: ['route-open'], resourceRefs: Array(1) }),
      draft({ knowledgeRefs: Object.assign(Array(2), { 0: 'rival-weak' }) }),
    ])(request('guild'));
    assert.deepEqual(sparse.proposals, []);
    assert.deepEqual(
      sparse.rejected.map((r) => r.reason),
      [MALFORMED_DRAFT, MALFORMED_DRAFT],
    );
    const SECRET = 'sk-provider-secret';
    const throwing = {
      get kind() {
        throw new Error(SECRET);
      },
    };
    const outcome = await llm([throwing])(request('guild'));
    assert.equal(outcome.source, 'fallback');
    assert.deepEqual(
      outcome.rejected.map((r) => r.reason),
      [PORT_FAILURE],
    );
    assert.ok(!JSON.stringify(outcome).includes(SECRET));
  });

  it('rejects planning for an unknown actor without calling the port', async () => {
    let called = false;
    const planner = createLlmPlanner([guild], behaviors, async () => {
      called = true;
      return [];
    });
    const outcome = await planner(request('stranger'));
    assert.equal(called, false);
    assert.deepEqual(outcome, {
      source: 'rejected',
      proposals: [],
      rejected: [{ item: 'stranger', reason: UNKNOWN_ACTOR }],
    });
  });

  it('is deterministic, respects cooldowns and bounds proposals per actor', async () => {
    const many: SimpleBehavior[] = Array.from({ length: MAX_PROPOSALS_PER_ACTOR * 2 }, (_, i) => ({
      kind: `act-${i}`,
      knowledgeRefs: ['rival-weak'],
      resourceRefs: [],
    }));
    const simple = createSimplePlanner([guild], many);
    const first = simple(request('guild'));
    assert.deepEqual(simple(request('guild')), first);
    assert.equal(first.length, MAX_PROPOSALS_PER_ACTOR);
    assert.deepEqual(
      first.map((p) => p.actionId),
      many.slice(0, MAX_PROPOSALS_PER_ACTOR).map((b) => `guild:${b.kind}@3`),
    );
    const resting = startCooldown(guild, 'trade', 2, 5);
    assert.deepEqual(
      createSimplePlanner([resting], behaviors)(request('guild')).map((p) => p.kind),
      ['scheme'],
    );
    const flood = await createLlmPlanner([guild], many, async () => many.map((b) => draft({ kind: b.kind })))(
      request('guild'),
    );
    assert.equal(flood.proposals.length, MAX_PROPOSALS_PER_ACTOR);
    assert.deepEqual(
      flood.rejected.map((r) => r.reason),
      Array(many.length - MAX_PROPOSALS_PER_ACTOR).fill(PROPOSAL_LIMIT),
    );
    const a = await llm([draft()])(request('guild'));
    const b = await llm([draft()])(request('guild'));
    assert.deepEqual(a, b);
  });
});
