import { randomUUID } from 'node:crypto';
import { type Campaign, CampaignNotFoundError, StaleRevisionError } from '../../domain/src/campaign.ts';
import type { Engine } from '../../engine/src/engine.ts';
import { InvalidActionError } from '../../engine/src/turn.ts';

export const MAX_REQUEST_BYTES = 4096;
export const MAX_NAME_LENGTH = 120;
export const MAX_ID_LENGTH = 64;
const MIN_LENGTH = 1;
const MIN_REVISION = 0;

type StringSchema = { readonly type: 'string'; readonly minLength: number; readonly maxLength: number };

type IntegerSchema = { readonly type: 'integer'; readonly minimum: number };

type ArraySchema = { readonly type: 'array'; readonly items: JsonSchema };

interface NestedSchema extends ObjectSchema<JsonSchema> {}

type JsonSchema = StringSchema | IntegerSchema | ArraySchema | NestedSchema;

type ObjectSchema<Property extends JsonSchema = StringSchema> = {
  readonly type: 'object';
  readonly properties: Readonly<Record<string, Property>>;
  readonly required: readonly string[];
  readonly additionalProperties: false;
};

export type ToolDefinition = {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: ObjectSchema<StringSchema | IntegerSchema>;
  readonly outputSchema: ObjectSchema<JsonSchema>;
  readonly annotations: { readonly readOnlyHint: boolean };
};

export type ToolErrorCode =
  | 'UnknownTool'
  | 'InvalidArguments'
  | 'RequestTooLarge'
  | 'CampaignNotFound'
  | 'StaleRevision'
  | 'SceneNotFound'
  | 'InvalidAction';

export type SceneState = {
  readonly campaignId: string;
  readonly revision: number;
  readonly scene: { readonly id: string; readonly title: string };
  readonly characters: readonly { readonly id: string; readonly name: string }[];
};

type ToolOutput = Campaign | SceneState;

export type ToolResult = {
  readonly isError: boolean;
  readonly content: readonly { readonly type: 'text'; readonly text: string }[];
  readonly structuredContent: ToolOutput | { readonly code: ToolErrorCode; readonly message: string };
};

const ID: StringSchema = { type: 'string', minLength: MIN_LENGTH, maxLength: MAX_ID_LENGTH };
const NAME: StringSchema = { type: 'string', minLength: MIN_LENGTH, maxLength: MAX_NAME_LENGTH };

const objectSchema = <Property extends JsonSchema>(properties: Record<string, Property>): ObjectSchema<Property> => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

const REVISION: IntegerSchema = { type: 'integer', minimum: MIN_REVISION };

const CAMPAIGN_SCHEMA = objectSchema({ id: ID, name: NAME });
const SCENE_STATE_SCHEMA = objectSchema<JsonSchema>({
  campaignId: ID,
  revision: REVISION,
  scene: objectSchema({ id: ID, title: NAME }),
  characters: { type: 'array', items: CAMPAIGN_SCHEMA },
});

export const CAMPAIGN_TOOLS: readonly ToolDefinition[] = [
  {
    name: 'create_campaign',
    description: 'Create a campaign and return it.',
    inputSchema: objectSchema({ name: NAME }),
    outputSchema: CAMPAIGN_SCHEMA,
    annotations: { readOnlyHint: false },
  },
  {
    name: 'get_campaign',
    description: 'Read one campaign by id.',
    inputSchema: objectSchema({ id: ID }),
    outputSchema: CAMPAIGN_SCHEMA,
    annotations: { readOnlyHint: true },
  },
  {
    name: 'rename_campaign',
    description: 'Rename one campaign and return it.',
    inputSchema: objectSchema({ id: ID, name: NAME }),
    outputSchema: CAMPAIGN_SCHEMA,
    annotations: { readOnlyHint: false },
  },
  {
    name: 'get_scene',
    description: 'Read the current scene, characters and revision of one campaign.',
    inputSchema: objectSchema({ campaignId: ID }),
    outputSchema: SCENE_STATE_SCHEMA,
    annotations: { readOnlyHint: true },
  },
  {
    name: 'submit_action',
    description: 'Validate and commit one player action, then return the next scene state.',
    inputSchema: objectSchema<StringSchema | IntegerSchema>({
      campaignId: ID,
      expectedRevision: REVISION,
      sceneId: ID,
      actorId: ID,
      input: NAME,
      intent: NAME,
    }),
    outputSchema: SCENE_STATE_SCHEMA,
    annotations: { readOnlyHint: false },
  },
];

class ToolError extends Error {
  readonly code: ToolErrorCode;
  constructor(code: ToolErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

const success = (output: ToolOutput): ToolResult => ({
  isError: false,
  content: [{ type: 'text', text: JSON.stringify(output) }],
  structuredContent: output,
});

const failure = ({ code, message }: ToolError): ToolResult => ({
  isError: true,
  content: [{ type: 'text', text: `${code}: ${message}` }],
  structuredContent: { code, message },
});

const requestBytes = (args: unknown) => {
  try {
    return Buffer.byteLength(JSON.stringify(args) ?? '');
  } catch {
    throw new ToolError('InvalidArguments', 'arguments must be JSON');
  }
};

type Arguments = Record<string, string | number>;

const fieldError = (key: string, field: StringSchema | IntegerSchema) =>
  new ToolError(
    'InvalidArguments',
    field.type === 'integer'
      ? `${key} must be an integer of at least ${field.minimum}`
      : `${key} must be a string of ${field.minLength} to ${field.maxLength} characters`,
  );

const validField = (field: StringSchema | IntegerSchema, value: unknown) =>
  field.type === 'integer'
    ? Number.isInteger(value) && (value as number) >= field.minimum
    : typeof value === 'string' && value.length >= field.minLength && value.length <= field.maxLength;

const validate = (schema: ToolDefinition['inputSchema'], args: unknown): Arguments => {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    throw new ToolError('InvalidArguments', 'arguments must be an object');
  }
  const extra = Object.keys(args).filter((key) => !Object.hasOwn(schema.properties, key));
  if (extra.length > 0) throw new ToolError('InvalidArguments', `unknown arguments: ${extra.join(', ')}`);
  const values = args as Record<string, unknown>;
  for (const [key, field] of Object.entries(schema.properties)) {
    if (!validField(field, values[key])) throw fieldError(key, field);
  }
  return values as Arguments;
};

const readScene = (engine: Engine, campaignId: string): SceneState => {
  const { currentScene, revision, characters } = engine.getState(campaignId);
  if (currentScene === undefined) throw new ToolError('SceneNotFound', `campaign ${campaignId} has no current scene`);
  return {
    campaignId,
    revision,
    scene: { id: currentScene.id, title: currentScene.title },
    characters: characters.map(({ id, name }) => ({ id, name })),
  };
};

const submitAction = (engine: Engine, { campaignId, expectedRevision, sceneId, actorId, input, intent }: Arguments) => {
  engine.submitAction({
    campaignId: String(campaignId),
    actionId: randomUUID(),
    expectedRevision: Number(expectedRevision),
    sceneId: String(sceneId),
    actorId: String(actorId),
    input: String(input),
    intent: String(intent),
  });
  return readScene(engine, String(campaignId));
};

const HANDLERS: Record<string, (engine: Engine, args: Arguments) => ToolOutput> = {
  create_campaign: (engine, { name }) => engine.createCampaign(String(name)),
  get_campaign: (engine, { id }) => engine.getCampaign(String(id)),
  get_scene: (engine, { campaignId }) => readScene(engine, String(campaignId)),
  rename_campaign: (engine, { id, name }) => engine.renameCampaign(String(id), String(name)),
  submit_action: submitAction,
};

const toToolError = (error: unknown) => {
  if (error instanceof ToolError) return error;
  if (error instanceof CampaignNotFoundError) return new ToolError('CampaignNotFound', error.message);
  if (error instanceof StaleRevisionError) return new ToolError('StaleRevision', error.message);
  if (error instanceof InvalidActionError) return new ToolError('InvalidAction', error.message);
  throw error;
};

export const callTool = (engine: Engine, name: string, args: unknown): ToolResult => {
  try {
    const tool = CAMPAIGN_TOOLS.find((candidate) => candidate.name === name);
    const handler = HANDLERS[name];
    if (tool === undefined || handler === undefined) throw new ToolError('UnknownTool', `unknown tool ${name}`);
    if (requestBytes(args) > MAX_REQUEST_BYTES) {
      throw new ToolError('RequestTooLarge', `arguments exceed ${MAX_REQUEST_BYTES} bytes`);
    }
    return success(handler(engine, validate(tool.inputSchema, args)));
  } catch (error) {
    return failure(toToolError(error));
  }
};
