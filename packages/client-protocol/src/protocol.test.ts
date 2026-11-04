import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { type DomainEvent, MAIN_BRANCH } from '../../domain/src/campaign.ts';
import { createEventLog } from './event-log.ts';
import {
  type CampaignSnapshot,
  type ClientEvent,
  type ClientSession,
  COMMAND_TYPES,
  MAX_INPUT_LENGTH,
  PROTOCOL_VERSION,
  parseCommand,
  toClientEvent,
} from './protocol.ts';

const CAMPAIGN_ID = 'campaign-1';
const SRC_DIR = import.meta.dirname;
const ALLOWED_IMPORT_PREFIXES = ['../../domain/src/', './'];
const IMPORT_PATTERN = /from '([^']+)'/g;
const TEST_SUFFIX = '.test.ts';

const domainEvent = (revision: number): DomainEvent => ({
  id: `event-${revision}`,
  campaignId: CAMPAIGN_ID,
  branchId: MAIN_BRANCH,
  turnId: null,
  actorId: null,
  causationId: null,
  type: 'SceneOpened',
  payload: { revision },
  revision,
});

const envelope = { version: PROTOCOL_VERSION, campaignId: CAMPAIGN_ID } as const;

const ACTION = {
  ...envelope,
  type: 'SubmitPlayerAction',
  actionId: 'action-1',
  expectedRevision: 2,
  sceneId: 'scene-1',
  actorId: 'character-1',
  input: 'I open the door.',
};

const VALID_COMMANDS = [
  { ...envelope, type: 'GetCampaignSnapshot' },
  ACTION,
  { ...envelope, type: 'SelectCapability', capabilityId: 'combat', enabled: true },
  { ...envelope, type: 'RequestView', viewId: 'character-sheet' },
  { ...envelope, type: 'SubscribeEvents', fromRevision: 0 },
  { ...envelope, type: 'SubscribeEvents' },
];

const inMemorySession = (): ClientSession & { commit(event: DomainEvent): void } => {
  const log = createEventLog({ campaignId: CAMPAIGN_ID, branchId: MAIN_BRANCH });
  let revision = 0;
  const snapshot = (): CampaignSnapshot => ({
    version: PROTOCOL_VERSION,
    campaignId: CAMPAIGN_ID,
    revision,
    campaign: { id: CAMPAIGN_ID, name: 'Ashfall' },
    characters: [],
    currentScene: undefined,
    turns: [],
  });
  return {
    commit(event) {
      revision = event.revision;
      log.publish(toClientEvent(event));
    },
    getSnapshot: () => ({ ok: true, value: snapshot() }),
    submitPlayerAction: () => ({ ok: true, value: { revision } }),
    selectCapability: () => ({ ok: true, value: { revision } }),
    requestView: (command) => ({ ok: true, value: { viewId: command.viewId, components: [] } }),
    subscribeEvents: (command, listener) => log.subscribe(command.fromRevision ?? 0, listener),
  };
};

const code = (result: ReturnType<typeof parseCommand>) => (result.ok ? undefined : result.error.code);

test('UI01: provide versioned commands and typed events for ui clients; support snapshot + subscription', () => {
  for (const command of VALID_COMMANDS) assert.deepEqual(parseCommand(command), { ok: true, value: command });

  const session = inMemorySession();
  session.commit(domainEvent(1));
  session.commit(domainEvent(2));
  const snapshot = session.getSnapshot({ ...envelope, type: 'GetCampaignSnapshot' });
  assert.ok(snapshot.ok);
  session.commit(domainEvent(3));

  const received: ClientEvent[] = [];
  const unsubscribe = session.subscribeEvents(
    { ...envelope, type: 'SubscribeEvents', fromRevision: snapshot.value.revision },
    (event) => received.push(event),
  );
  session.commit(domainEvent(3));
  session.commit(domainEvent(4));
  unsubscribe();
  session.commit(domainEvent(5));

  assert.deepEqual(
    received.map((event) => [event.version, event.type, event.revision]),
    [
      [PROTOCOL_VERSION, 'EventCommitted', 3],
      [PROTOCOL_VERSION, 'EventCommitted', 4],
    ],
  );
  assert.equal(received[0]?.event.type, 'SceneOpened');
});

test('UI01: rejects unknown version, unknown command and malformed payloads with typed errors', () => {
  assert.equal(code(parseCommand({ ...ACTION, version: PROTOCOL_VERSION + 1 })), 'UnsupportedVersion');
  assert.equal(code(parseCommand({ ...ACTION, version: String(PROTOCOL_VERSION) })), 'UnsupportedVersion');
  assert.equal(code(parseCommand({ ...ACTION, type: 'Teleport' })), 'UnknownCommand');
  assert.equal(code(parseCommand({ ...ACTION, expectedRevision: -1 })), 'MalformedCommand');
  assert.equal(code(parseCommand({ ...ACTION, expectedRevision: 1.5 })), 'MalformedCommand');
  assert.equal(code(parseCommand({ ...ACTION, actorId: '' })), 'MalformedCommand');
  assert.equal(code(parseCommand({ ...ACTION, input: 7 })), 'MalformedCommand');
  const { sceneId: _, ...withoutScene } = ACTION;
  assert.equal(code(parseCommand(withoutScene)), 'MalformedCommand');
  for (const input of [null, 'GetCampaignSnapshot', [], 42, undefined]) {
    assert.equal(code(parseCommand(input)), 'MalformedCommand');
  }
});

test('UI01: clients cannot bypass the engine or trust unsolicited model state writes', () => {
  assert.deepEqual(COMMAND_TYPES, [
    'GetCampaignSnapshot',
    'SubmitPlayerAction',
    'SelectCapability',
    'RequestView',
    'SubscribeEvents',
  ]);
  for (const type of ['WriteState', 'SetState', 'CommitEvent', '__proto__', 'toString']) {
    assert.equal(code(parseCommand({ ...envelope, type })), 'UnknownCommand');
  }
  assert.equal(code(parseCommand({ ...ACTION, state: { hp: 999 } })), 'UnexpectedField');
  assert.equal(code(parseCommand({ ...ACTION, revision: 99 })), 'UnexpectedField');

  const event = toClientEvent(domainEvent(1));
  assert.ok(Object.isFrozen(event));
  assert.ok(Object.isFrozen(event.event));
  assert.ok(Object.isFrozen(event.event.payload));
  assert.throws(() => Object.assign(event, { revision: 42 }), TypeError);
});

test('UI01: rejects inherited envelope fields and symbol-keyed extra fields', () => {
  const inherited = Object.create({ ...envelope, type: 'GetCampaignSnapshot' });
  assert.equal(code(parseCommand(inherited)), 'UnsupportedVersion');
  const inheritedCampaign = Object.assign(Object.create({ campaignId: CAMPAIGN_ID }), {
    version: PROTOCOL_VERSION,
    type: 'GetCampaignSnapshot',
  });
  assert.equal(code(parseCommand(inheritedCampaign)), 'MalformedCommand');
  const inheritedField = Object.assign(Object.create({ viewId: 'sheet' }), { ...envelope, type: 'RequestView' });
  assert.equal(code(parseCommand(inheritedField)), 'MalformedCommand');
  assert.equal(code(parseCommand({ ...ACTION, [Symbol('state')]: { hp: 999 } })), 'UnexpectedField');

  const withInheritedExtra = Object.assign(Object.create({ state: { hp: 999 } }), {
    ...envelope,
    type: 'SubscribeEvents',
  });
  const parsed = parseCommand(withInheritedExtra);
  assert.ok(parsed.ok);
  assert.deepEqual(Reflect.ownKeys(parsed.value), ['version', 'type', 'campaignId']);
  assert.equal(Object.getPrototypeOf(parsed.value), Object.prototype);
});

test('UI01: returns exactly the values it validated and maps throwing getters to a typed error', () => {
  let reads = 0;
  const shifting = { ...envelope, type: 'RequestView' };
  Object.defineProperty(shifting, 'viewId', {
    enumerable: true,
    get: () => (reads++ === 0 ? 'sheet' : 42),
  });
  const parsed = parseCommand(shifting);
  assert.ok(parsed.ok);
  assert.equal((parsed.value as { viewId: unknown }).viewId, 'sheet');

  const throwing = { ...envelope, type: 'RequestView' };
  Object.defineProperty(throwing, 'viewId', {
    enumerable: true,
    get: () => {
      throw new Error('boom');
    },
  });
  assert.equal(code(parseCommand(throwing)), 'MalformedCommand');
});

const flipping = <T>(first: T, second: unknown) => {
  let reads = 0;
  return { enumerable: true, get: () => (reads++ === 0 ? first : second) };
};

const throwing = {
  enumerable: true,
  get: (): never => {
    throw new Error('boom');
  },
};

test('UI01: reads version and type once, so a flipping getter cannot change the validated command', () => {
  const version = Object.defineProperty(
    { type: 'RequestView', campaignId: CAMPAIGN_ID, viewId: 'sheet' },
    'version',
    flipping(PROTOCOL_VERSION, PROTOCOL_VERSION + 1),
  );
  const versionParsed = parseCommand(version);
  assert.ok(versionParsed.ok);
  assert.equal(versionParsed.value.version, PROTOCOL_VERSION);

  const type = Object.defineProperty(
    { ...envelope, viewId: 'sheet' },
    'type',
    flipping('RequestView', 'SubmitPlayerAction'),
  );
  const typeParsed = parseCommand(type);
  assert.ok(typeParsed.ok);
  assert.equal(typeParsed.value.type, 'RequestView');
});

test('UI01: reads every own property exactly once', () => {
  const reads = new Map<PropertyKey, number>();
  const counted = new Proxy(ACTION, {
    get: (target, key, receiver) => {
      reads.set(key, (reads.get(key) ?? 0) + 1);
      return Reflect.get(target, key, receiver);
    },
  });
  assert.ok(parseCommand(counted).ok);
  assert.deepEqual(Object.fromEntries(reads), Object.fromEntries(Object.keys(ACTION).map((key) => [key, 1])));
});

test('UI01: maps throwing envelope getters and hostile proxies to a typed error instead of throwing', () => {
  for (const key of ['version', 'type']) {
    assert.equal(
      code(parseCommand(Object.defineProperty({ ...envelope, type: 'GetCampaignSnapshot' }, key, throwing))),
      'MalformedCommand',
    );
  }
  const fail = () => {
    throw new Error('boom');
  };
  for (const trap of ['get', 'ownKeys']) {
    assert.equal(code(parseCommand(new Proxy({ ...ACTION }, { [trap]: fail }))), 'MalformedCommand');
  }
  for (const trap of ['has', 'getOwnPropertyDescriptor', 'getPrototypeOf']) {
    assert.doesNotThrow(() => parseCommand(new Proxy({ ...ACTION }, { [trap]: fail })));
  }
  const revocable = Proxy.revocable({ ...ACTION }, {});
  revocable.revoke();
  assert.equal(code(parseCommand(revocable.proxy)), 'MalformedCommand');
  assert.equal(code(parseCommand({ ...ACTION, version: Object.create(null) })), 'UnsupportedVersion');
  assert.equal(code(parseCommand({ ...ACTION, type: Object.create(null) })), 'UnknownCommand');
});

test('UI01: rejects player input longer than the protocol limit', () => {
  assert.ok(parseCommand({ ...ACTION, input: 'a'.repeat(MAX_INPUT_LENGTH) }).ok);
  assert.equal(code(parseCommand({ ...ACTION, input: 'a'.repeat(MAX_INPUT_LENGTH + 1) })), 'MalformedCommand');
});

test('UI01: toClientEvent freezes cyclic payloads without overflowing', () => {
  const payload: Record<string, unknown> = { name: 'loop' };
  payload.self = payload;
  const event = toClientEvent({ ...domainEvent(1), payload });
  assert.ok(Object.isFrozen(event.event.payload));
  assert.equal(event.event.payload.self, event.event.payload);
});

test('UI01: client-protocol imports nothing but @rpg/domain', () => {
  const foreign = readdirSync(SRC_DIR)
    .filter((file) => !file.endsWith(TEST_SUFFIX))
    .flatMap((file) => [...readFileSync(join(SRC_DIR, file), 'utf8').matchAll(IMPORT_PATTERN)])
    .map((match) => match[1] ?? '')
    .filter((specifier) => !ALLOWED_IMPORT_PREFIXES.some((prefix) => specifier.startsWith(prefix)));
  assert.deepEqual(foreign, []);
});
