import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CampaignEntity, EntityStore } from '../../domain/src/entity.ts';
import {
  type ActorFact,
  canDecide,
  createWorldActor,
  knows,
  learn,
  loadWorldActor,
  MAX_ACTOR_ENTRIES,
  remember,
  saveWorldActor,
  startCooldown,
  unknownRefs,
} from './actor.ts';

const CAMPAIGN = 'c1';

const memoryStore = (): EntityStore => {
  const rows = new Map<string, string>();
  return {
    saveEntity: (entity) => void rows.set(entity.id, JSON.stringify(entity)),
    getEntity: (campaignId, id) => {
      const row = rows.get(id);
      const entity = row === undefined ? undefined : (JSON.parse(row) as CampaignEntity);
      return entity?.campaignId === campaignId ? entity : undefined;
    },
    listEntities: () => [],
    saveRelationship: () => {},
    listRelationships: () => [],
  };
};

const secret: ActorFact = { id: 'f-secret', visibility: 'gm', actorId: null };
const publicFact: ActorFact = { id: 'f-public', visibility: 'public', actorId: null };

describe('W02 WorldActor and faction state', () => {
  it('persist goals, resources, plans, memories, knowledge and decision cooldowns', () => {
    let actor = createWorldActor({
      id: 'guild',
      kind: 'faction',
      name: 'Thieves Guild',
      goals: ['control the docks'],
      resources: { coin: 40, agents: 3 },
      plans: [{ id: 'p1', goal: 'control the docks', steps: ['bribe harbormaster'] }],
    });
    actor = remember(actor, { id: 'm1', summary: 'raid failed', tick: 2 });
    actor = learn(actor, secret, { channel: 'told', sourceId: 'informant', eventId: 'e7', tick: 3 });
    actor = startCooldown(actor, 'expand', 3, 5);
    const store = memoryStore();
    saveWorldActor(store, CAMPAIGN, actor);
    const loaded = loadWorldActor(store, CAMPAIGN, 'guild');
    assert.deepEqual(loaded, actor);
    assert.ok(loaded);
    assert.equal(knows(loaded, secret.id), true);
    assert.equal(canDecide(loaded, 'expand', 7), false);
    assert.equal(canDecide(loaded, 'expand', 8), true);
    assert.equal(loadWorldActor(store, 'other', 'guild'), undefined);
    for (let i = 0; i < MAX_ACTOR_ENTRIES + 1; i++) actor = remember(actor, { id: `m${i}`, summary: 's', tick: i });
    assert.equal(actor.memories.length, MAX_ACTOR_ENTRIES);
  });

  it('actors cannot know secret facts without an information path', () => {
    const actor = createWorldActor({ id: 'npc1', kind: 'npc', name: 'Mira' });
    const noPath = learn(actor, secret, { channel: 'witnessed', sourceId: null, eventId: null, tick: 1 });
    assert.equal(knows(noPath, secret.id), false);
    assert.deepEqual(unknownRefs(noPath, [secret.id]), [secret.id]);
    const badChannel = learn(actor, secret, { channel: 'psychic', sourceId: null, eventId: 'e1', tick: 1 } as never);
    assert.equal(knows(badChannel, secret.id), false);
    const otherScoped: ActorFact = { id: 'f-other', visibility: 'actor-scoped', actorId: 'npc2' };
    assert.equal(
      knows(learn(actor, otherScoped, { channel: 'rumor', sourceId: null, eventId: null, tick: 1 }), otherScoped.id),
      false,
    );
    const witnessed = learn(actor, secret, { channel: 'witnessed', sourceId: null, eventId: 'e1', tick: 1 });
    assert.equal(knows(witnessed, secret.id), true);
    const heard = learn(actor, publicFact, { channel: 'rumor', sourceId: null, eventId: null, tick: 1 });
    assert.deepEqual(unknownRefs(heard, [publicFact.id, secret.id]), [secret.id]);
    const store = memoryStore();
    store.saveEntity({
      id: 'forged',
      campaignId: CAMPAIGN,
      kind: 'npc',
      name: 'Forged',
      visibility: 'gm',
      actorId: null,
      data: { knowledge: [{ factId: secret.id }] },
    });
    assert.equal(loadWorldActor(store, CAMPAIGN, 'forged'), undefined);
  });

  it('rejects information paths that do not reach the actor', () => {
    const z = createWorldActor({ id: 'z', kind: 'npc', name: 'Zed' });
    const gm: ActorFact = { id: 'sec', visibility: 'gm', actorId: null };
    const tries = [
      { channel: 'witnessed', sourceId: 'z', eventId: null, tick: 0 },
      { channel: 'witnessed', sourceId: 'npc9', eventId: null, tick: 0 },
      { channel: 'told', sourceId: null, eventId: 'e1', tick: 0 },
      { channel: 'told', sourceId: 'z', eventId: 'e1', tick: 0 },
      { channel: 'rumor', sourceId: null, eventId: null, tick: 0 },
    ] as const;
    for (const path of tries) assert.equal(knows(learn(z, gm, path), gm.id), false, path.channel);
    assert.equal(knows(learn(z, gm, { channel: 'told', sourceId: 'npc9', eventId: null, tick: 0 }), gm.id), true);
    assert.equal(knows(learn(z, gm, { channel: 'rumor', sourceId: 'npc9', eventId: null, tick: 0 }), gm.id), true);
    const empty = learn(z, { ...publicFact, id: '' }, { channel: 'rumor', sourceId: null, eventId: null, tick: 0 });
    assert.deepEqual(empty.knowledge, []);
  });

  it('keeps saved state within the bounds that load accepts', () => {
    let a = createWorldActor({ id: 'a', kind: 'faction', name: 'A' });
    assert.throws(() => {
      for (let i = 0; i < MAX_ACTOR_ENTRIES + 1; i++) a = startCooldown(a, `d${i}`, 1, 1);
    }, RangeError);
    let pruned = createWorldActor({ id: 'p', kind: 'npc', name: 'P' });
    for (let i = 0; i < MAX_ACTOR_ENTRIES; i++) pruned = startCooldown(pruned, `d${i}`, 1, 1);
    pruned = startCooldown(pruned, 'late', 2, 1);
    assert.deepEqual(Object.keys(pruned.cooldowns), ['late']);
    const b = createWorldActor({ id: 'b', kind: 'npc', name: 'B' });
    assert.throws(() => startCooldown(b, 'x', Number.MAX_SAFE_INTEGER, 1), RangeError);
    const many = Array.from({ length: MAX_ACTOR_ENTRIES + 1 }, (_, i) => `g${i}`);
    for (const extra of [
      { goals: many },
      { plans: [{ id: 'p1', goal: 'g', steps: many }] },
      { resources: Object.fromEntries(many.map((k) => [k, 1])) },
    ])
      assert.throws(() => createWorldActor({ id: 'c', kind: 'npc', name: 'C', ...extra }), RangeError);
    const store = memoryStore();
    assert.throws(() => saveWorldActor(store, CAMPAIGN, { ...b, goals: many }), RangeError);
    assert.equal(store.getEntity(CAMPAIGN, 'b'), undefined);
  });

  it('load rejects non-record data and pathless knowledge', () => {
    const store = memoryStore();
    const base = { campaignId: CAMPAIGN, kind: 'npc' as const, name: 'N', visibility: 'gm' as const, actorId: null };
    store.saveEntity({ ...base, id: 'null', data: null as never });
    assert.equal(loadWorldActor(store, CAMPAIGN, 'null'), undefined);
    const valid = createWorldActor({ id: 'k', kind: 'npc', name: 'N' });
    const { id, kind, name, ...data } = valid;
    const pathless = { factId: 'f', channel: 'told', sourceId: null, eventId: null, tick: 0 };
    store.saveEntity({ ...base, id, data: { ...data, knowledge: [pathless] } });
    assert.equal(loadWorldActor(store, CAMPAIGN, 'k'), undefined);
    store.saveEntity({ ...base, id, data: { ...data, knowledge: [{ ...pathless, channel: 'rumor' }] } });
    assert.equal(loadWorldActor(store, CAMPAIGN, 'k')?.knowledge.length, 1);
  });
});
