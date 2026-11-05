import type {
  Campaign,
  CampaignId,
  Character,
  CharacterId,
  DomainEvent,
  EventId,
  Scene,
  SceneId,
  Turn,
} from '../../domain/src/campaign.ts';
import type { RuleCitation } from '../../domain/src/character.ts';
import type { GmSettings, GmUsageTotals } from '../../domain/src/gm.ts';
import type { RulesUsage } from '../../domain/src/rules-usage.ts';
import { CLAIM_KINDS, type ClaimKind, type StoryMemory } from '../../domain/src/story-memory.ts';
import { isLocale, type SavedVoiceSettings } from '../../domain/src/voice.ts';
import type { VisualizationEvent } from './visualization.ts';

export type { StoryMemory, StoryMemoryEntry, StoryMemoryGroup } from '../../domain/src/story-memory.ts';
export type {
  MicrophoneMode,
  SavedVoiceSettings,
  SpokenOutputMode,
  VoiceFallback,
  VoiceProfile,
} from '../../domain/src/voice.ts';
export {
  MAX_VOICE_SPEED,
  MICROPHONE_MODES,
  MIN_VOICE_SPEED,
  SPOKEN_OUTPUT_MODES,
} from '../../domain/src/voice.ts';

export const PROTOCOL_VERSION = 1;
export const MAX_INPUT_LENGTH = 4096;
export const MAX_CAMPAIGN_NAME_LENGTH = 120;
export type ProtocolVersion = typeof PROTOCOL_VERSION;

export const COMMAND_TYPES = [
  'ListCampaigns',
  'CreateCampaign',
  'ArchiveCampaign',
  'DeleteCampaign',
  'OpenCampaign',
  'UnarchiveCampaign',
  'PlanCampaign',
  'GetCampaignSnapshot',
  'GetCampaignPanels',
  'SubmitPlayerAction',
  'SelectCapability',
  'RequestView',
  'SubscribeEvents',
  'EditSheetField',
  'SaveVoiceSettings',
  'SaveGmSettings',
  'SaveGmDefaults',
  'GetStoryMemory',
  'CorrectStoryFact',
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
  'quest',
  'encounter',
  'map',
  'investigation',
] as const;
export type ViewComponentKind = (typeof VIEW_COMPONENT_KINDS)[number];

export const EVENT_COMMITTED = 'EventCommitted';
export const CAMPAIGN_HEALTHS = ['ok', 'needs-migration', 'unreadable'] as const;
export type CampaignHealth = (typeof CAMPAIGN_HEALTHS)[number];

type Header<T extends CommandType> = { readonly version: ProtocolVersion; readonly type: T };
type Envelope<T extends CommandType> = Header<T> & { readonly campaignId: CampaignId };

export type ListCampaigns = Header<'ListCampaigns'>;
export type CreateCampaign = Header<'CreateCampaign'> & {
  readonly name: string;
  readonly intent?: string;
  readonly choices?: Readonly<Record<string, unknown>>;
  readonly language?: string;
};
export type ArchiveCampaign = Header<'ArchiveCampaign'> & { readonly name: string };
export type DeleteCampaign = Header<'DeleteCampaign'> & {
  readonly name: string;
  readonly confirm: string;
  readonly archived?: boolean;
};
export type OpenCampaign = Header<'OpenCampaign'> & { readonly name: string };
export type UnarchiveCampaign = Header<'UnarchiveCampaign'> & { readonly name: string };
export type PlanCampaign = Header<'PlanCampaign'> &
  Omit<CreateCampaign, keyof Header<'CreateCampaign'> | 'name' | 'language'>;
export type CampaignCommand =
  | CreateCampaign
  | ArchiveCampaign
  | DeleteCampaign
  | OpenCampaign
  | UnarchiveCampaign
  | PlanCampaign;

export type GetCampaignSnapshot = Envelope<'GetCampaignSnapshot'>;
export type GetCampaignPanels = Envelope<'GetCampaignPanels'>;
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
export type EditSheetField = Envelope<'EditSheetField'> & {
  readonly actionId: string;
  readonly expectedRevision: number;
  readonly actorId: CharacterId;
  readonly fieldId: string;
  readonly value: unknown;
};

export type SaveVoiceSettings = Envelope<'SaveVoiceSettings'> & {
  readonly actionId: string;
  readonly expectedRevision: number;
} & SavedVoiceSettings;

export type SaveGmSettings = Envelope<'SaveGmSettings'> & {
  readonly actionId: string;
  readonly expectedRevision: number;
} & GmSettings;

export type SaveGmDefaults = Envelope<'SaveGmDefaults'> & { readonly actionId: string } & GmSettings;

export type GetStoryMemory = Envelope<'GetStoryMemory'>;
export type CorrectStoryFact = Envelope<'CorrectStoryFact'> & {
  readonly actionId: string;
  readonly expectedRevision: number;
  readonly actorId: CharacterId;
  readonly entityId: string;
  readonly kind: ClaimKind;
  readonly key?: string;
  readonly value: string;
};

export type ClientCommand =
  | ListCampaigns
  | CampaignCommand
  | GetCampaignSnapshot
  | GetCampaignPanels
  | SubmitPlayerAction
  | SelectCapability
  | RequestView
  | SubscribeEvents
  | EditSheetField
  | SaveVoiceSettings
  | SaveGmSettings
  | SaveGmDefaults
  | GetStoryMemory
  | CorrectStoryFact;

export type ClientDomainEvent = Readonly<DomainEvent>;

export type EventCommitted = {
  readonly version: ProtocolVersion;
  readonly type: typeof EVENT_COMMITTED;
  readonly revision: number;
  readonly event: ClientDomainEvent;
};

export type ClientEvent = EventCommitted | VisualizationEvent;

export type Provenanced<T> = T & { readonly provenance: string };

export type CampaignSummary = {
  readonly id: CampaignId | null;
  readonly name: string;
  readonly health: CampaignHealth;
  readonly lastPlayedAt: string | null;
  readonly sceneTitle: string | null;
  readonly characters: readonly Pick<Character, 'id' | 'name'>[];
  readonly ruleset: Provenanced<{ readonly id: string; readonly edition: string; readonly revision: string }> | null;
  readonly genre: Provenanced<{ readonly id: string; readonly version: string }> | null;
  readonly lastNarration: string | null;
  readonly turnCount: number;
};

export type CampaignList = {
  readonly version: ProtocolVersion;
  readonly campaigns: readonly CampaignSummary[];
  readonly archived?: readonly CampaignSummary[];
};

export type CampaignRemoved = { readonly version: ProtocolVersion; readonly name: string };

export type StartGenre = {
  readonly id: string;
  readonly name: string;
  readonly blurb: string;
  readonly characters: readonly { readonly name: string; readonly summary: string }[];
};
export type StartRuleset = {
  readonly id: string;
  readonly edition: string;
  readonly blurb: string;
  readonly recommended: boolean;
  readonly readyMade: boolean;
  readonly sheet: readonly string[];
  readonly usage?: RulesUsage;
};
export type StartOptions = { readonly genres: readonly StartGenre[]; readonly rulesets: readonly StartRuleset[] };
export type PlanEntry = { readonly field: string; readonly value: string; readonly provenance: string };
export type CampaignPlan = {
  readonly version: ProtocolVersion;
  readonly options: StartOptions;
  readonly entries: readonly PlanEntry[];
};

export type SpeakingNpc = { readonly id: string; readonly name: string };

export type CampaignSnapshot = {
  readonly version: ProtocolVersion;
  readonly campaignId: CampaignId;
  readonly revision: number;
  readonly campaign: Campaign;
  readonly characters: readonly Character[];
  readonly speakers?: readonly SpeakingNpc[];
  readonly currentScene: Scene | undefined;
  readonly turns: readonly Turn[];
  readonly language?: string;
  readonly voice?: SavedVoiceSettings;
  readonly gm?: GmSnapshot;
  readonly rules?: RulesUsage;
};

export type GmSnapshot = {
  readonly settings: GmSettings;
  readonly campaignSettings: GmSettings;
  readonly defaults: GmSettings;
  readonly session: GmUsageTotals;
  readonly campaign: GmUsageTotals;
  readonly contextTight?: boolean;
};

export type InventoryEntry = { readonly id: string; readonly name: string };
export type QuestEntry = {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly objectives: readonly { readonly summary: string; readonly done: boolean }[];
};
export type CitationEntry = { readonly eventId: EventId } & RuleCitation;
export type WorldRecap = { readonly scene: string | undefined; readonly latest: string | undefined };

export type CampaignPanels = {
  readonly version: ProtocolVersion;
  readonly campaignId: CampaignId;
  readonly revision: number;
  readonly inventory: readonly InventoryEntry[];
  readonly quests: readonly QuestEntry[];
  readonly citations: readonly CitationEntry[];
  readonly recap: WorldRecap;
};

export type StoryMemoryView = {
  readonly version: ProtocolVersion;
  readonly campaignId: CampaignId;
  readonly revision: number;
  readonly memory: StoryMemory;
};

export type ViewValue = string | number | boolean | null;

export type ViewComponent = {
  readonly kind: ViewComponentKind;
  readonly id: string;
  readonly label: string;
  readonly value?: ViewValue;
  readonly group?: string;
  readonly editable?: boolean;
  readonly explanation?: string;
  readonly min?: number;
  readonly max?: number;
};

export type ViewDescriptor = {
  readonly campaignId: CampaignId;
  readonly viewId: string;
  readonly components: readonly ViewComponent[];
};

export type Accepted = { readonly revision: number };

export const PROTOCOL_ERROR_CODES = [
  'UnsupportedVersion',
  'UnknownCommand',
  'MalformedCommand',
  'UnexpectedField',
  'Rejected',
  'StaleRevision',
  'UnknownEdition',
] as const;
export type ProtocolErrorCode = (typeof PROTOCOL_ERROR_CODES)[number];

export type ProtocolError = { readonly code: ProtocolErrorCode; readonly message: string };

export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ProtocolError };

export type Unsubscribe = () => void;

export interface ClientSession {
  listCampaigns(command: ListCampaigns): Result<CampaignList>;
  getSnapshot(command: GetCampaignSnapshot): Result<CampaignSnapshot>;
  getPanels(command: GetCampaignPanels): Result<CampaignPanels>;
  submitPlayerAction(command: SubmitPlayerAction): Result<Accepted>;
  selectCapability(command: SelectCapability): Result<Accepted>;
  requestView(command: RequestView): Result<ViewDescriptor>;
  subscribeEvents(command: SubscribeEvents, listener: (event: ClientEvent) => void): Unsubscribe;
  editSheetField(command: EditSheetField): Result<Accepted>;
  saveVoiceSettings(command: SaveVoiceSettings): Result<Accepted>;
  saveGmSettings(command: SaveGmSettings): Result<Accepted>;
}

type FieldKind =
  | 'id'
  | 'name'
  | 'text'
  | 'revision'
  | 'flag'
  | 'number'
  | 'primitive'
  | 'record'
  | 'locale'
  | 'claimKind';
type FieldSpec = { readonly kind: FieldKind; readonly optional?: true };

const HEADER_FIELDS = ['version', 'type'];
const ENVELOPE_FIELDS = [...HEADER_FIELDS, 'campaignId'];
const UNSCOPED: readonly CommandType[] = [
  'ListCampaigns',
  'CreateCampaign',
  'ArchiveCampaign',
  'DeleteCampaign',
  'OpenCampaign',
  'UnarchiveCampaign',
  'PlanCampaign',
];
const ID: FieldSpec = { kind: 'id' };
const NAME: FieldSpec = { kind: 'name' };
const PLAN_FIELDS = ['intent', 'choices'];
const EXCLUSIVE_FIELDS: Partial<Record<CommandType, readonly string[]>> = {
  CreateCampaign: PLAN_FIELDS,
  PlanCampaign: PLAN_FIELDS,
};
const PLAN_SPECS: Readonly<Record<string, FieldSpec>> = {
  intent: { kind: 'text', optional: true },
  choices: { kind: 'record', optional: true },
};

const COMMAND_FIELDS: Record<CommandType, Readonly<Record<string, FieldSpec>>> = {
  ListCampaigns: {},
  CreateCampaign: { name: NAME, ...PLAN_SPECS, language: { kind: 'locale', optional: true } },
  ArchiveCampaign: { name: NAME },
  DeleteCampaign: { name: NAME, confirm: ID, archived: { kind: 'flag', optional: true } },
  OpenCampaign: { name: NAME },
  UnarchiveCampaign: { name: NAME },
  PlanCampaign: PLAN_SPECS,
  GetCampaignSnapshot: {},
  GetCampaignPanels: {},
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
  EditSheetField: {
    actionId: ID,
    expectedRevision: { kind: 'revision' },
    actorId: ID,
    fieldId: ID,
    value: { kind: 'primitive' },
  },
  SaveVoiceSettings: {
    actionId: ID,
    expectedRevision: { kind: 'revision' },
    microphone: ID,
    spokenOutput: ID,
    locale: ID,
    speed: { kind: 'number' },
    consentGrantedAt: { kind: 'id', optional: true },
    npcVoices: { kind: 'record', optional: true },
  },
  SaveGmSettings: {
    actionId: ID,
    expectedRevision: { kind: 'revision' },
    model: { kind: 'id', optional: true },
    summaryModel: { kind: 'id', optional: true },
    sessionBudgetTokens: { kind: 'number', optional: true },
    rulesStrictness: { kind: 'id', optional: true },
  },
  SaveGmDefaults: {
    actionId: ID,
    model: { kind: 'id', optional: true },
    summaryModel: { kind: 'id', optional: true },
    sessionBudgetTokens: { kind: 'number', optional: true },
    rulesStrictness: { kind: 'id', optional: true },
  },
  GetStoryMemory: {},
  CorrectStoryFact: {
    actionId: ID,
    expectedRevision: { kind: 'revision' },
    actorId: ID,
    entityId: ID,
    kind: { kind: 'claimKind' },
    key: { kind: 'id', optional: true },
    value: { kind: 'text' },
  },
};

const FIELD_CHECKS: Record<FieldKind, (value: unknown) => boolean> = {
  id: (value) => typeof value === 'string' && value.length > 0,
  name: (value) => FIELD_CHECKS.id(value) && (value as string).length <= MAX_CAMPAIGN_NAME_LENGTH,
  text: (value) => typeof value === 'string' && value.length <= MAX_INPUT_LENGTH,
  revision: (value) => Number.isSafeInteger(value) && (value as number) >= 0,
  flag: (value) => typeof value === 'boolean',
  number: (value) => typeof value === 'number' && Number.isFinite(value),
  primitive: (value) => FIELD_CHECKS.text(value) || FIELD_CHECKS.flag(value) || FIELD_CHECKS.number(value),
  record: (value) => isRecord(value),
  locale: isLocale,
  claimKind: (value) => CLAIM_KINDS.some((kind) => kind === value),
};

export const failure = (code: ProtocolErrorCode, message: string): Result<never> => ({
  ok: false,
  error: { code, message },
});

const isRecord = (input: unknown): input is Record<string, unknown> =>
  typeof input === 'object' && input !== null && !Array.isArray(input);

const isCommandType = (type: unknown): type is CommandType => COMMAND_TYPES.some((known) => known === type);

const describe = (value: unknown) => (typeof value === 'object' && value !== null ? typeof value : String(value));

type OwnSnapshot = { readonly keys: readonly PropertyKey[]; readonly own: Record<string, unknown> };

const snapshotOwn = (input: unknown): Result<OwnSnapshot> => {
  try {
    if (!isRecord(input)) return failure('MalformedCommand', 'command must be an object');
    const keys = Reflect.ownKeys(input);
    const own = Object.fromEntries(keys.filter((key) => typeof key === 'string').map((key) => [key, input[key]]));
    return { ok: true, value: { keys, own } };
  } catch {
    return failure('MalformedCommand', 'command has unreadable fields');
  }
};

export const parseCommand = (input: unknown): Result<ClientCommand> => {
  const snapshot = snapshotOwn(input);
  if (!snapshot.ok) return snapshot;
  const { keys, own } = snapshot.value;
  const { version, type } = own;
  if (version !== PROTOCOL_VERSION) return failure('UnsupportedVersion', `unsupported version ${describe(version)}`);
  if (!isCommandType(type)) return failure('UnknownCommand', `unknown command ${describe(type)}`);
  const fields = COMMAND_FIELDS[type];
  const scoped = !UNSCOPED.includes(type);
  const envelope = scoped ? ENVELOPE_FIELDS : HEADER_FIELDS;
  const unexpected = keys.find(
    (key) => typeof key !== 'string' || (!envelope.includes(key) && !Object.hasOwn(fields, key)),
  );
  if (unexpected !== undefined) return failure('UnexpectedField', `${type} does not accept ${String(unexpected)}`);
  const specs = Object.entries(scoped ? { campaignId: ID, ...fields } : fields);
  const invalid = specs.find(([key, spec]) =>
    Object.hasOwn(own, key) ? !FIELD_CHECKS[spec.kind](own[key]) : spec.optional !== true,
  );
  if (invalid !== undefined) return failure('MalformedCommand', `${type}.${invalid[0]} is missing or invalid`);
  const exclusive = EXCLUSIVE_FIELDS[type]?.filter((key) => Object.hasOwn(own, key)) ?? [];
  if (exclusive.length > 1) return failure('MalformedCommand', `${type} takes only one of ${exclusive.join(', ')}`);
  const ordered = [...envelope, ...Object.keys(fields)].filter((key) => Object.hasOwn(own, key));
  return { ok: true, value: Object.freeze(Object.fromEntries(ordered.map((key) => [key, own[key]]))) as ClientCommand };
};

export const deepFreeze = <T>(value: T, visited = new WeakSet<object>()): T => {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value) || visited.has(value)) return value;
  visited.add(value);
  for (const child of Object.values(value)) deepFreeze(child, visited);
  return Object.freeze(value);
};

export const toClientEvent = (event: DomainEvent): EventCommitted =>
  deepFreeze({
    version: PROTOCOL_VERSION,
    type: EVENT_COMMITTED,
    revision: event.revision,
    event: structuredClone(event),
  });
