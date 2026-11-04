import type {
  Campaign,
  CampaignId,
  Character,
  CharacterId,
  DomainEvent,
  Scene,
  SceneId,
  Turn,
} from '../../domain/src/campaign.ts';

export const PROTOCOL_VERSION = 1;
export type ProtocolVersion = typeof PROTOCOL_VERSION;

export const COMMAND_TYPES = [
  'GetCampaignSnapshot',
  'SubmitPlayerAction',
  'SelectCapability',
  'RequestView',
  'SubscribeEvents',
] as const;
export type CommandType = (typeof COMMAND_TYPES)[number];

export const VIEW_COMPONENT_KINDS = [
  'field',
  'group',
  'progress',
  'roll',
  'clock',
  'inventory',
  'relationship',
  'journal',
] as const;
export type ViewComponentKind = (typeof VIEW_COMPONENT_KINDS)[number];

export const EVENT_COMMITTED = 'EventCommitted';

type Envelope<T extends CommandType> = {
  readonly version: ProtocolVersion;
  readonly type: T;
  readonly campaignId: CampaignId;
};

export type GetCampaignSnapshot = Envelope<'GetCampaignSnapshot'>;
export type SubmitPlayerAction = Envelope<'SubmitPlayerAction'> & {
  readonly actionId: string;
  readonly expectedRevision: number;
  readonly sceneId: SceneId;
  readonly actorId: CharacterId;
  readonly input: string;
};
export type SelectCapability = Envelope<'SelectCapability'> & {
  readonly capabilityId: string;
  readonly enabled: boolean;
};
export type RequestView = Envelope<'RequestView'> & { readonly viewId: string };
export type SubscribeEvents = Envelope<'SubscribeEvents'> & { readonly fromRevision?: number };

export type ClientCommand = GetCampaignSnapshot | SubmitPlayerAction | SelectCapability | RequestView | SubscribeEvents;

export type ClientDomainEvent = Readonly<DomainEvent>;

export type EventCommitted = {
  readonly version: ProtocolVersion;
  readonly type: typeof EVENT_COMMITTED;
  readonly revision: number;
  readonly event: ClientDomainEvent;
};

export type ClientEvent = EventCommitted;

export type CampaignSnapshot = {
  readonly version: ProtocolVersion;
  readonly campaignId: CampaignId;
  readonly revision: number;
  readonly campaign: Campaign;
  readonly characters: readonly Character[];
  readonly currentScene: Scene | undefined;
  readonly turns: readonly Turn[];
};

export type ViewComponent = {
  readonly kind: ViewComponentKind;
  readonly id: string;
  readonly label: string;
};

export type ViewDescriptor = { readonly viewId: string; readonly components: readonly ViewComponent[] };

export type Accepted = { readonly revision: number };

export const PROTOCOL_ERROR_CODES = [
  'UnsupportedVersion',
  'UnknownCommand',
  'MalformedCommand',
  'UnexpectedField',
  'Rejected',
] as const;
export type ProtocolErrorCode = (typeof PROTOCOL_ERROR_CODES)[number];

export type ProtocolError = { readonly code: ProtocolErrorCode; readonly message: string };

export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ProtocolError };

export type Unsubscribe = () => void;

export interface ClientSession {
  getSnapshot(command: GetCampaignSnapshot): Result<CampaignSnapshot>;
  submitPlayerAction(command: SubmitPlayerAction): Result<Accepted>;
  selectCapability(command: SelectCapability): Result<Accepted>;
  requestView(command: RequestView): Result<ViewDescriptor>;
  subscribeEvents(command: SubscribeEvents, listener: (event: ClientEvent) => void): Unsubscribe;
}

type FieldKind = 'id' | 'text' | 'revision' | 'flag';
type FieldSpec = { readonly kind: FieldKind; readonly optional?: true };

const ENVELOPE_FIELDS = ['version', 'type', 'campaignId'];
const ID: FieldSpec = { kind: 'id' };

const COMMAND_FIELDS: Record<CommandType, Readonly<Record<string, FieldSpec>>> = {
  GetCampaignSnapshot: {},
  SubmitPlayerAction: {
    actionId: ID,
    expectedRevision: { kind: 'revision' },
    sceneId: ID,
    actorId: ID,
    input: { kind: 'text' },
  },
  SelectCapability: { capabilityId: ID, enabled: { kind: 'flag' } },
  RequestView: { viewId: ID },
  SubscribeEvents: { fromRevision: { kind: 'revision', optional: true } },
};

const FIELD_CHECKS: Record<FieldKind, (value: unknown) => boolean> = {
  id: (value) => typeof value === 'string' && value.length > 0,
  text: (value) => typeof value === 'string',
  revision: (value) => Number.isSafeInteger(value) && (value as number) >= 0,
  flag: (value) => typeof value === 'boolean',
};

const failure = (code: ProtocolErrorCode, message: string): Result<never> => ({ ok: false, error: { code, message } });

const isRecord = (input: unknown): input is Record<string, unknown> =>
  typeof input === 'object' && input !== null && !Array.isArray(input);

const isCommandType = (type: unknown): type is CommandType => COMMAND_TYPES.some((known) => known === type);

const readOwnValues = (
  input: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> | undefined => {
  try {
    return Object.fromEntries(keys.filter((key) => Object.hasOwn(input, key)).map((key) => [key, input[key]]));
  } catch {
    return undefined;
  }
};

export const parseCommand = (input: unknown): Result<ClientCommand> => {
  if (!isRecord(input)) return failure('MalformedCommand', 'command must be an object');
  const version = Object.hasOwn(input, 'version') ? input.version : undefined;
  if (version !== PROTOCOL_VERSION) return failure('UnsupportedVersion', `unsupported version ${String(version)}`);
  const type = Object.hasOwn(input, 'type') ? input.type : undefined;
  if (!isCommandType(type)) return failure('UnknownCommand', `unknown command ${String(type)}`);
  const fields = COMMAND_FIELDS[type];
  const unexpected = Reflect.ownKeys(input).find(
    (key) => typeof key !== 'string' || (!ENVELOPE_FIELDS.includes(key) && !Object.hasOwn(fields, key)),
  );
  if (unexpected !== undefined) return failure('UnexpectedField', `${type} does not accept ${String(unexpected)}`);
  const own = readOwnValues(input, [...ENVELOPE_FIELDS, ...Object.keys(fields)]);
  if (own === undefined) return failure('MalformedCommand', `${type} has unreadable fields`);
  const specs: [string, FieldSpec][] = [['campaignId', ID], ...Object.entries(fields)];
  const invalid = specs.find(([key, spec]) =>
    Object.hasOwn(own, key) ? !FIELD_CHECKS[spec.kind](own[key]) : spec.optional !== true,
  );
  if (invalid !== undefined) return failure('MalformedCommand', `${type}.${invalid[0]} is missing or invalid`);
  return { ok: true, value: Object.freeze(own) as ClientCommand };
};

const deepFreeze = <T>(value: T, visited = new WeakSet<object>()): T => {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value) || visited.has(value)) return value;
  visited.add(value);
  for (const child of Object.values(value)) deepFreeze(child, visited);
  return Object.freeze(value);
};

export const toClientEvent = (event: DomainEvent): ClientEvent =>
  deepFreeze({
    version: PROTOCOL_VERSION,
    type: EVENT_COMMITTED,
    revision: event.revision,
    event: structuredClone(event),
  });
