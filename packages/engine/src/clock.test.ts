import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock, test } from 'node:test';
import { type CampaignEvent, type CampaignStore, SYSTEM_TURN } from '../../domain/src/campaign.ts';
import { createCampaignStore } from '../../persistence/src/campaign-store.ts';
import { openDatabase } from '../../persistence/src/database.ts';
import { advanceGameTime, defineClock, GAME_TIME_TRIGGERS, scheduleEffect, worldTime } from './clock.ts';
import { InvalidActionError, type PlayerAction, performAction } from './turn.ts';

const IN_MEMORY = ':memory:';
const DB_FILE = 'campaign.db';
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const CAMPAIGN = { id: 'campaign-1', name: 'Harbor Lights' };
const MARA = { id: 'mara', campaignId: CAMPAIGN.id, name: 'Mara' };
const SCENE = { id: 'scene-1', campaignId: CAMPAIGN.id, title: 'The Dock at Dusk' };
const CREATED_EVENT = {
  id: 'created-1',
  campaignId: CAMPAIGN.id,
  branchId: 'main',
  actionId: 'create',
  type: 'CampaignCreated',
  payload: { name: CAMPAIGN.name },
};
const SETUP_TURN = {
  id: 'turn-0',
  campaignId: CAMPAIGN.id,
  sceneId: SCENE.id,
  actionId: 'setup',
  actorId: MARA.id,
  input: 'Begin.',
  narration: 'A lantern sways at the end of the pier.',
};
const ALARM = { clockId: 'alarm', label: 'Harbor alarm', segments: 3 };
const TIDE = {
  effectId: 'tide',
  due: { kind: 'time', at: 6 },
  effect: { summary: 'The tide strands the boats.' },
} as const;
const GUARDS = {
  effectId: 'guards',
  due: { kind: 'clock', clockId: ALARM.clockId },
  effect: { summary: 'The guards seal the docks.', tags: ['lockdown'] },
} as const;

const fileStore = (path: string) => {
  const connection = openDatabase(path);
  return { store: createCampaignStore(connection.database), close: () => connection.close() };
};

const setup = (store: CampaignStore) => {
  store.createCampaign(CAMPAIGN, CREATED_EVENT);
  store.commitTurn({ expectedRevision: 0, turn: SETUP_TURN, characters: [MARA], scenes: [SCENE], events: [] });
};

const events = (store: CampaignStore): readonly CampaignEvent[] => store.load(CAMPAIGN.id)?.events ?? [];
const revision = (store: CampaignStore) => store.load(CAMPAIGN.id)?.revision ?? 0;

const actionFor = (store: CampaignStore, actionId: string): PlayerAction => ({
  campaignId: CAMPAIGN.id,
  actionId,
  expectedRevision: revision(store),
  sceneId: SCENE.id,
  actorId: MARA.id,
  input: `${actionId}.`,
  intent: `Mara does ${actionId}.`,
});

const fired = (turnEvents: readonly CampaignEvent[]) =>
  turnEvents.filter(({ type }) => type === 'DelayedEffectFired').map(({ payload }) => payload);

test('advance event clocks and delayed effects only on approved game-time triggers', () => {
  const { store, close } = fileStore(IN_MEMORY);
  try {
    setup(store);
    assert.deepEqual(GAME_TIME_TRIGGERS, ['time-passage', 'clock-tick']);
    defineClock(store, { ...actionFor(store, 'define-alarm'), ...ALARM });
    scheduleEffect(store, { ...actionFor(store, 'schedule-tide'), ...TIDE });
    scheduleEffect(store, { ...actionFor(store, 'schedule-guards'), ...GUARDS });
    assert.deepEqual(worldTime(events(store)).clocks, [{ ...ALARM, current: 0 }]);

    performAction(store, actionFor(store, 'wander'));
    assert.equal(worldTime(events(store)).now, 0);

    const rest = advanceGameTime(store, {
      ...actionFor(store, 'rest'),
      trigger: { kind: 'time-passage', units: 4, reason: 'Mara rests.' },
    });
    assert.equal(rest.turn.kind, SYSTEM_TURN);
    assert.deepEqual(
      rest.events.map(({ type }) => type),
      ['PlayerActionSubmitted', 'ActionValidated', 'GameTimeAdvanced'],
    );
    assert.deepEqual(fired(rest.events), []);

    const tick = advanceGameTime(store, {
      ...actionFor(store, 'noise'),
      trigger: { kind: 'clock-tick', clockId: ALARM.clockId, segments: 2, reason: 'A crate falls.' },
    });
    assert.deepEqual(fired(tick.events), []);
    assert.equal(worldTime(events(store)).clocks[0]?.current, 2);

    const wait = advanceGameTime(store, {
      ...actionFor(store, 'wait'),
      trigger: { kind: 'time-passage', units: 2, reason: 'Mara waits for dark.' },
    });
    assert.deepEqual(fired(wait.events), [{ effectId: TIDE.effectId, effect: TIDE.effect }]);

    const shout = advanceGameTime(store, {
      ...actionFor(store, 'shout'),
      trigger: { kind: 'clock-tick', clockId: ALARM.clockId, segments: 1, reason: 'A guard shouts.' },
    });
    assert.deepEqual(
      shout.events.map(({ type }) => type),
      ['PlayerActionSubmitted', 'ActionValidated', 'ClockTicked', 'ClockCompleted', 'DelayedEffectFired'],
    );
    assert.deepEqual(fired(shout.events), [{ effectId: GUARDS.effectId, effect: GUARDS.effect }]);

    const state = worldTime(events(store));
    assert.equal(state.now, 6);
    assert.deepEqual(state.clocks, [{ ...ALARM, current: ALARM.segments }]);
    assert.deepEqual(
      state.effects.map(({ effectId, fired: done }) => [effectId, done]),
      [
        [TIDE.effectId, true],
        [GUARDS.effectId, true],
      ],
    );
    assert.deepEqual(worldTime([...events(store)]), state);

    const rejected = (actionId: string, run: (action: PlayerAction) => unknown) => {
      const before = revision(store);
      assert.throws(() => run(actionFor(store, actionId)), InvalidActionError, actionId);
      assert.equal(revision(store), before, actionId);
    };
    const trigger = (a: PlayerAction, t: unknown) => advanceGameTime(store, { ...a, trigger: t as never });
    rejected('wall-clock', (a) => trigger(a, { kind: 'wall-clock', units: 1, reason: 'Real time.' }));
    rejected('zero', (a) => trigger(a, { kind: 'time-passage', units: 0, reason: 'Nothing.' }));
    rejected('fraction', (a) => trigger(a, { kind: 'time-passage', units: 1.5, reason: 'Half.' }));
    rejected('no-reason', (a) => trigger(a, { kind: 'time-passage', units: 1, reason: ' ' }));
    rejected('unknown-clock', (a) => trigger(a, { kind: 'clock-tick', clockId: 'x', segments: 1, reason: 'X.' }));
    rejected('full-clock', (a) =>
      trigger(a, { kind: 'clock-tick', clockId: ALARM.clockId, segments: 1, reason: 'Again.' }),
    );
    rejected('duplicate-clock', (a) => defineClock(store, { ...a, ...ALARM }));
    rejected('bad-segments', (a) => defineClock(store, { ...a, ...ALARM, clockId: 'b', segments: 0 }));
    rejected('past-effect', (a) =>
      scheduleEffect(store, { ...a, ...TIDE, effectId: 'late', due: { kind: 'time', at: 6 } }),
    );
    rejected('duplicate-effect', (a) => scheduleEffect(store, { ...a, ...TIDE, due: { kind: 'time', at: 9 } }));
    rejected('done-clock-effect', (a) => scheduleEffect(store, { ...a, ...GUARDS, effectId: 'late' }));
    rejected('bad-due', (a) => scheduleEffect(store, { ...a, ...TIDE, effectId: 'e', due: { kind: 'dice' } as never }));
    rejected('code-effect', (a) =>
      scheduleEffect(store, {
        ...a,
        effectId: 'e',
        due: { kind: 'time', at: 9 },
        effect: { summary: 'Eval.', run: () => 1 } as never,
      }),
    );
  } finally {
    close();
  }
});

test('closing the app does not unexpectedly advance game time', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'rpg-clock-'));
  const path = join(directory, DB_FILE);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const first = fileStore(path);
  setup(first.store);
  defineClock(first.store, { ...actionFor(first.store, 'define-alarm'), ...ALARM });
  scheduleEffect(first.store, { ...actionFor(first.store, 'schedule-tide'), ...TIDE });
  advanceGameTime(first.store, {
    ...actionFor(first.store, 'rest'),
    trigger: { kind: 'time-passage', units: 5, reason: 'Mara rests.' },
  });
  const before = worldTime(events(first.store));
  const eventCount = events(first.store).length;
  first.close();

  mock.timers.enable({ apis: ['Date'] });
  t.after(() => mock.timers.reset());
  mock.timers.tick(ONE_YEAR_MS);

  const reopened = fileStore(path);
  try {
    assert.deepEqual(worldTime(events(reopened.store)), before);
    assert.equal(before.now, 5);
    assert.equal(events(reopened.store).length, eventCount);
    performAction(reopened.store, actionFor(reopened.store, 'look'));
    const after = worldTime(events(reopened.store));
    assert.equal(after.now, before.now);
    assert.deepEqual(after.clocks, before.clocks);
    assert.equal(after.effects[0]?.fired, false);
  } finally {
    reopened.close();
  }
});
