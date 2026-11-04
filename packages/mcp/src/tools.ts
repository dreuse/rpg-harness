import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { createCampaignStore } from '../../persistence/src/campaign-store.ts';

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
  readonly inputSchema: ObjectSchema;
  readonly outputSchema: ObjectSchema<JsonSchema>;
  readonly annotations: { readonly readOnlyHint: boolean };
};

export type ToolErrorCode =
  | 'UnknownTool'
  | 'InvalidArguments'
  | 'RequestTooLarge'
  | 'CampaignNotFound'
  | 'SceneNotFound';

export type Campaign = { readonly id: string; readonly name: string };

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

const CAMPAIGN_SCHEMA = objectSchema({ id: ID, name: NAME });
const SCENE_STATE_SCHEMA = objectSchema<JsonSchema>({
  campaignId: ID,
  revision: { type: 'integer', minimum: MIN_REVISION },
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
];

const SELECT_CAMPAIGN = 'SELECT id, name FROM campaign WHERE id = ?';
const INSERT_CAMPAIGN = 'INSERT INTO campaign (id, name) VALUES (?, ?)';
const UPDATE_CAMPAIGN = 'UPDATE campaign SET name = ? WHERE id = ?';
const APPEND_EVENT = 'INSERT INTO event_log (campaign_id, payload) VALUES (?, ?)';

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

const validate = (schema: ObjectSchema, args: unknown): Record<string, string> => {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    throw new ToolError('InvalidArguments', 'arguments must be an object');
  }
  const extra = Object.keys(args).filter((key) => !Object.hasOwn(schema.properties, key));
  if (extra.length > 0) throw new ToolError('InvalidArguments', `unknown arguments: ${extra.join(', ')}`);
  const values = args as Record<string, unknown>;
  for (const [key, field] of Object.entries(schema.properties)) {
    const value = values[key];
    if (typeof value !== 'string' || value.length < field.minLength || value.length > field.maxLength) {
      throw new ToolError(
        'InvalidArguments',
        `${key} must be a string of ${field.minLength} to ${field.maxLength} characters`,
      );
    }
  }
  return values as Record<string, string>;
};

const readCampaign = (database: DatabaseSync, id: string): Campaign => {
  const row = database.prepare(SELECT_CAMPAIGN).get(id);
  if (row === undefined) throw new ToolError('CampaignNotFound', `no campaign with id ${id}`);
  return { id: String(row.id), name: String(row.name) };
};

const inTransaction = <T>(database: DatabaseSync, run: () => T): T => {
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = run();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
};

const appendEvent = (database: DatabaseSync, campaignId: string, payload: Record<string, string>) =>
  database.prepare(APPEND_EVENT).run(campaignId, JSON.stringify(payload));

const readScene = (database: DatabaseSync, campaignId: string): SceneState => {
  const state = createCampaignStore(database).load(campaignId);
  if (state === undefined) throw new ToolError('CampaignNotFound', `no campaign with id ${campaignId}`);
  const { currentScene, revision, characters } = state;
  if (currentScene === undefined) throw new ToolError('SceneNotFound', `campaign ${campaignId} has no current scene`);
  return {
    campaignId,
    revision,
    scene: { id: currentScene.id, title: currentScene.title },
    characters: characters.map(({ id, name }) => ({ id, name })),
  };
};

const HANDLERS: Record<string, (database: DatabaseSync, args: Record<string, string>) => ToolOutput> = {
  create_campaign: (database, { name = '' }) =>
    inTransaction(database, () => {
      const id = randomUUID();
      database.prepare(INSERT_CAMPAIGN).run(id, name);
      appendEvent(database, id, { type: 'CampaignCreated', name });
      return { id, name };
    }),
  get_campaign: (database, { id = '' }) => readCampaign(database, id),
  get_scene: (database, { campaignId = '' }) => readScene(database, campaignId),
  rename_campaign: (database, { id = '', name = '' }) =>
    inTransaction(database, () => {
      readCampaign(database, id);
      database.prepare(UPDATE_CAMPAIGN).run(name, id);
      appendEvent(database, id, { type: 'CampaignRenamed', name });
      return { id, name };
    }),
};

export const callTool = (database: DatabaseSync, name: string, args: unknown): ToolResult => {
  try {
    const tool = CAMPAIGN_TOOLS.find((candidate) => candidate.name === name);
    const handler = HANDLERS[name];
    if (tool === undefined || handler === undefined) throw new ToolError('UnknownTool', `unknown tool ${name}`);
    if (requestBytes(args) > MAX_REQUEST_BYTES) {
      throw new ToolError('RequestTooLarge', `arguments exceed ${MAX_REQUEST_BYTES} bytes`);
    }
    return success(handler(database, validate(tool.inputSchema, args)));
  } catch (error) {
    if (error instanceof ToolError) return failure(error);
    throw error;
  }
};
