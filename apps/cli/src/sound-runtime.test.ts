import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import {
  type CampaignSnapshot,
  type ClientEvent,
  type ClientSession,
  EVENT_COMMITTED,
  PROTOCOL_VERSION,
} from '../../../packages/client-protocol/src/protocol.ts';
import type { Scene } from '../../../packages/domain/src/campaign.ts';
import type { AmbientSink } from '../../../packages/voice/src/ambience.ts';
import type { SoundClock } from '../../../packages/voice/src/sound-controller.ts';
import { DEFAULT_SOUND_SETTINGS } from '../../../packages/voice/src/sound-settings.ts';
import { createSoundRuntime, DEFAULT_SCENE, followScenes } from './sound-runtime.ts';

const dirs: string[] = [];
const tempDir = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sound-runtime-'));
  dirs.push(dir);
  return dir;
};
const ON = { ...DEFAULT_SOUND_SETTINGS, music: { enabled: true, volume: 0.5 } };
const clock: SoundClock = { now: () => 0, every: () => () => undefined };

const fakeSink = () => {
  const started: string[] = [];
  let disposed = false;
  const sink: AmbientSink & { dispose(): void } = {
    start: (id) => void started.push(id),
    stop: () => undefined,
    setVolume: () => undefined,
    dispose: () => {
      disposed = true;
    },
  };
  return { sink, started, disposed: () => disposed };
};

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

test('returns nothing when every channel is off', async () => {
  const { sink } = fakeSink();
  assert.equal(createSoundRuntime(await tempDir(), { settings: DEFAULT_SOUND_SETTINGS, sink, clock }), undefined);
});

test('an enabled channel without downloaded sounds plays nothing', async () => {
  const { sink, started } = fakeSink();
  const runtime = createSoundRuntime(await tempDir(), { settings: ON, sink, clock });
  assert.notEqual(runtime, undefined);
  assert.deepEqual(started, []);
});

test('plays the music bed for the default scene when the sound is installed', async () => {
  const { sink, started } = fakeSink();
  createSoundRuntime(await tempDir(), { settings: ON, sink, clock, installed: () => true });
  assert.deepEqual(started, ['music:calm']);
  assert.deepEqual(DEFAULT_SCENE.mood, []);
});

test('dispose stops the sink', async () => {
  const { sink, disposed } = fakeSink();
  createSoundRuntime(await tempDir(), { settings: ON, sink, clock, installed: () => true })?.dispose();
  assert.equal(disposed(), true);
});

test('rpg-cm63.34 the opening scene picks the ambience and rings the scene effect', async () => {
  const { sink, started } = fakeSink();
  const settings = {
    ...ON,
    ambience: { enabled: true, volume: 0.5 },
    effects: { enabled: true, volume: 0.5 },
  };
  createSoundRuntime(await tempDir(), {
    settings,
    sink,
    clock,
    installed: () => true,
    scene: { location: 'tavern', mood: [] },
  });
  assert.deepEqual(started.sort(), ['ambience:tavern', 'effect:bell', 'music:calm']);
});

const ALL_ON = {
  ...ON,
  ambience: { enabled: true, volume: 0.5 },
  effects: { enabled: true, volume: 0.5 },
};
const CAMPAIGN = 'campaign-1';
const INN: Scene = { id: 'scene-1', campaignId: CAMPAIGN, title: 'The Inn' };
const GATE: Scene = {
  id: 'scene-2',
  campaignId: CAMPAIGN,
  title: 'The Gate',
  locationKind: 'sea',
  moodTags: ['exploration'],
};

const fakeSession = (first: Scene) => {
  let scene = first;
  let listener: ((event: ClientEvent) => void) | undefined;
  const subscribed: unknown[] = [];
  let unsubscribed = 0;
  const snapshot = (): CampaignSnapshot => ({ revision: 1, currentScene: scene }) as CampaignSnapshot;
  const session: Pick<ClientSession, 'getSnapshot' | 'subscribeEvents'> = {
    getSnapshot: () => ({ ok: true, value: snapshot() }),
    subscribeEvents: (command, next) => {
      subscribed.push(command);
      listener = next;
      return () => {
        unsubscribed += 1;
      };
    },
  };
  const commit = (next: Scene) => {
    scene = next;
    listener?.({ version: PROTOCOL_VERSION, type: EVENT_COMMITTED, revision: 2, event: {} } as ClientEvent);
  };
  return { session, snapshot, commit, subscribed, unsubscribed: () => unsubscribed };
};

test('rpg-cm63.41 a new scene switches the sounds to its persisted tags and rings the scene effect', async () => {
  const { sink, started } = fakeSink();
  const runtime = createSoundRuntime(await tempDir(), { settings: ALL_ON, sink, clock, installed: () => true });
  assert.ok(runtime);
  const fake = fakeSession(INN);
  followScenes(runtime.controller, fake.session, CAMPAIGN, fake.snapshot());
  assert.deepEqual(fake.subscribed, [
    { version: PROTOCOL_VERSION, campaignId: CAMPAIGN, type: 'SubscribeEvents', fromRevision: 1 },
  ]);
  const before = started.length;
  fake.commit(GATE);
  assert.deepEqual(started.slice(before).sort(), ['ambience:sea', 'effect:bell', 'music:exploration']);
});

test('rpg-cm63.41 an event that leaves the scene unchanged does not ring the scene effect', async () => {
  const { sink, started } = fakeSink();
  const runtime = createSoundRuntime(await tempDir(), { settings: ALL_ON, sink, clock, installed: () => true });
  assert.ok(runtime);
  const fake = fakeSession(INN);
  followScenes(runtime.controller, fake.session, CAMPAIGN, fake.snapshot());
  const before = started.length;
  fake.commit(INN);
  assert.equal(started.length, before);
});

test('rpg-cm63.41 following the scenes can be stopped', async () => {
  const { sink } = fakeSink();
  const runtime = createSoundRuntime(await tempDir(), { settings: ALL_ON, sink, clock, installed: () => true });
  assert.ok(runtime);
  const fake = fakeSession(INN);
  followScenes(runtime.controller, fake.session, CAMPAIGN, fake.snapshot())();
  assert.equal(fake.unsubscribed(), 1);
});
