import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { type GmFailure, gmFailureText } from '../../../packages/client-protocol/src/gm-failure.ts';
import { DEFAULT_LOCALE } from '../../../packages/client-protocol/src/locale.ts';
import type { GmUsage } from '../../../packages/domain/src/gm.ts';
import { CAMPAIGN_TOOLS } from '../../../packages/mcp/src/tools.ts';
import type { SummaryLevel } from '../../../packages/memory/src/history.ts';
import { type ContextPacket, frameData, packetParts } from '../../../packages/memory/src/packet.ts';
import { CLAUDE_WORKSPACE_DIR, ensureClaudeWorkspace } from './claude-workspace.ts';
import {
  claudeBinOf,
  GM_MODEL_ENV,
  type GmReply,
  isRecord,
  PROVIDER_DEFAULT_MODEL,
  ProviderError,
  SUMMARY_MODEL_ENV,
  summaryPrompt,
  TOO_LONG_PATTERN,
  usageOf,
} from './gm-api.ts';
import { proposalsOf } from './gm-proposals.ts';
import { narrationOf, SEGMENTS_SCHEMA, segmentsOf } from './gm-segments.ts';
import { LocalizedError } from './messages.ts';
import { userDataDir } from './setup-check.ts';

export const GM_PROFILE_ENV = 'RPG_GM_PROFILE';
export const FULL_PROFILE = 'full';
export const LEAN_PROFILE = 'lean';
export type GmProfile = typeof FULL_PROFILE | typeof LEAN_PROFILE;
export const CLAUDE_TIMEOUT_MS = 120_000;
export const CLAUDE_MAX_RETRIES = 1;
export const CHEAP_CLAUDE_MODEL = 'haiku';
export const BALANCED_CLAUDE_MODEL = 'sonnet';

const resolvedModelOf = (model: string | undefined) =>
  model === undefined || model === PROVIDER_DEFAULT_MODEL ? BALANCED_CLAUDE_MODEL : model;
export const BALANCED_EFFORT = 'medium';
export const CHEAP_EFFORT = 'low';
export const CHILD_ENV_KEYS: readonly string[] = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'CLAUDE_CONFIG_DIR',
];
export const TERMINAL_ENV_KEYS: readonly string[] = ['TERM', 'COLORTERM'];

const GAME_SERVER = 'rpg';
const toolName = (name: string) => `mcp__${GAME_SERVER}__${name}`;
export const READ_ONLY_GAME_TOOLS = CAMPAIGN_TOOLS.filter(({ annotations }) => annotations.readOnlyHint).map(
  ({ name }) => toolName(name),
);
export const WRITE_GAME_TOOLS = CAMPAIGN_TOOLS.filter(({ annotations }) => !annotations.readOnlyHint).map(({ name }) =>
  toolName(name),
);

const MCP_SERVER_ENTRY = join(import.meta.dirname, '../../mcp-server/src/main.ts');
const ASAR_SEGMENT = /[\\/][^\\/]*\.asar[\\/]/;
const ELECTRON_RUN_AS_NODE_ENV = 'ELECTRON_RUN_AS_NODE';
const ENABLED = '1';
const DATABASE_ENV = 'RPG_DATABASE_PATH';
const TEMP_PREFIX = 'rpg-gm-';
const MCP_CONFIG_FILE = 'mcp.json';
const PRIVATE_FILE_MODE = 0o600;
export const MAX_OUTPUT_BYTES = 1_048_576;
const ABORT_ERROR = 'AbortError';
const TOOL_SEPARATOR = ',';
const NO_BUILT_IN_TOOLS = '';
const EXIT_INTERRUPTED = 1;
const MAX_STDERR_BYTES = 16_384;
const LIMIT_PATTERN = /usage limit|hit your limit|limit reached/i;
const RESET_PATTERN = /resets?\s+(?:at\s+)?([^\n·|]+)/i;
const AUTH_PATTERN = /not logged in|\/login|invalid api key|unauthorized|authentication/i;
const RESET_GROUP = 1;
const MAX_RESET_DETAIL_CHARS = 80;
const FINAL_FAILURE_KINDS: ReadonlySet<string> = new Set(['limit', 'auth', 'notInstalled']);
const WORKSPACE_FAILED = 'The Claude Code workspace could not be prepared.';
const MALFORMED_REPLY = 'Claude Code sent a malformed reply.';
const REPORTED_ERROR = 'Claude Code reported an error. Run claude once in a terminal to check that it is signed in.';
const SETTING_SOURCES = ['--setting-sources', 'project'];
const PART_SEPARATOR = '\n';
const NO_PROMPT_MODE = 'dontAsk';
const IGNORE = () => {};
export const NARRATION_SCHEMA = JSON.stringify(SEGMENTS_SCHEMA);

export type ClaudeCodeRoute = {
  readonly bin: string;
  readonly profile: GmProfile;
  readonly model: string | undefined;
  readonly summaryModel: string;
  readonly effort: string;
  readonly timeoutMs: number;
  readonly env: NodeJS.ProcessEnv;
  readonly workspace: string;
};

const childEnvOf = (keys: readonly string[], env: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
  Object.fromEntries(keys.flatMap((name) => (env[name] === undefined ? [] : [[name, env[name]]])));

const workspaceOf = (env: NodeJS.ProcessEnv) =>
  join(userDataDir({ platform: process.platform, env, homedir: homedir() }), CLAUDE_WORKSPACE_DIR);

export const claudeCodeRouteOf = (bin: string, env: NodeJS.ProcessEnv): ClaudeCodeRoute => ({
  bin,
  profile: env[GM_PROFILE_ENV]?.trim() === LEAN_PROFILE ? LEAN_PROFILE : FULL_PROFILE,
  model: env[GM_MODEL_ENV]?.trim() || undefined,
  summaryModel: env[SUMMARY_MODEL_ENV]?.trim() || CHEAP_CLAUDE_MODEL,
  effort: BALANCED_EFFORT,
  timeoutMs: CLAUDE_TIMEOUT_MS,
  env: childEnvOf(CHILD_ENV_KEYS, env),
  workspace: workspaceOf(env),
});

export const claudeError = (failure: GmFailure, message = gmFailureText(DEFAULT_LOCALE, failure), tooLong = false) =>
  new ProviderError(message, undefined, tooLong, failure);

export const claudeFailureOf = (said: string): GmFailure | undefined => {
  if (LIMIT_PATTERN.test(said)) {
    const reset = RESET_PATTERN.exec(said)?.[RESET_GROUP]?.slice(0, MAX_RESET_DETAIL_CHARS).trim();
    return reset ? { kind: 'limit', detail: reset } : { kind: 'limit' };
  }
  return AUTH_PATTERN.test(said) ? { kind: 'auth' } : undefined;
};

export const startFailure = (error: Error, timeoutMs: number) =>
  error.name === ABORT_ERROR
    ? claudeError({ kind: 'timeout' }, `Claude Code timed out after ${timeoutMs} ms.`)
    : claudeError({ kind: 'notInstalled' }, 'Claude Code could not be started.');

export const boundedText = (stream: NodeJS.ReadableStream): (() => string) => {
  const chunks: Buffer[] = [];
  let size = 0;
  stream.on('data', (chunk: Buffer) => {
    if (size >= MAX_STDERR_BYTES) return;
    size += chunk.length;
    chunks.push(chunk);
  });
  return () => Buffer.concat(chunks).toString();
};

export const preparedWorkspace = ({ workspace }: ClaudeCodeRoute): string => {
  try {
    return ensureClaudeWorkspace(workspace);
  } catch {
    throw claudeError({ kind: 'workspace' }, WORKSPACE_FAILED);
  }
};

export const claudeArgs = (
  { profile, model, effort }: ClaudeCodeRoute,
  system: string,
  mcpConfig?: string,
  schema?: string,
): string[] => [
  '-p',
  '--output-format',
  'json',
  '--no-session-persistence',
  '--permission-mode',
  NO_PROMPT_MODE,
  ...SETTING_SOURCES,
  '--append-system-prompt',
  system,
  ...(mcpConfig === undefined ? [] : ['--mcp-config', mcpConfig]),
  ...(schema === undefined ? [] : ['--json-schema', schema]),
  ...(profile === LEAN_PROFILE ? ['--strict-mcp-config', '--tools', NO_BUILT_IN_TOOLS] : []),
  '--allowedTools',
  READ_ONLY_GAME_TOOLS.join(TOOL_SEPARATOR),
  '--disallowedTools',
  WRITE_GAME_TOOLS.join(TOOL_SEPARATOR),
  `--model=${resolvedModelOf(model)}`,
  '--effort',
  effort,
];

export const gameServerLaunchable = (entry: string = MCP_SERVER_ENTRY): boolean => !ASAR_SEGMENT.test(entry);

export const gameMcpConfig = (databasePath: string, versions: { readonly electron?: string } = process.versions) => ({
  mcpServers: {
    [GAME_SERVER]: {
      command: process.execPath,
      args: [MCP_SERVER_ENTRY],
      env: {
        [DATABASE_ENV]: databasePath,
        ...(versions.electron === undefined ? {} : { [ELECTRON_RUN_AS_NODE_ENV]: ENABLED }),
      },
    },
  },
});

export type Exit = { readonly code: number | null; readonly stdout: string; readonly stderr?: string };

const run = ({ bin, env, timeoutMs }: ClaudeCodeRoute, args: string[], input: string, cwd: string) =>
  new Promise<Exit>((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      signal: AbortSignal.timeout(timeoutMs),
    });
    const stderr = boundedText(child.stderr);
    const chunks: Buffer[] = [];
    let size = 0;
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_OUTPUT_BYTES) child.kill();
      else chunks.push(chunk);
    });
    child.on('error', (error) => reject(startFailure(error, timeoutMs)));
    child.on('close', (code) => resolve({ code, stdout: Buffer.concat(chunks).toString(), stderr: stderr() }));
    child.stdin.on('error', IGNORE);
    child.stdin.end(input);
  });

const parsed = (stdout: string): unknown => {
  try {
    return JSON.parse(stdout);
  } catch {
    return undefined;
  }
};

const resultOf = (body: Record<string, unknown>) => (typeof body.result === 'string' ? body.result : '');

const saidOf = (body: unknown, stderr: string) => [isRecord(body) ? resultOf(body) : '', stderr].join(PART_SEPARATOR);

export const replyOf = ({ code, stdout, stderr = '' }: Exit, model: string | undefined): GmReply => {
  const body = parsed(stdout);
  const said = saidOf(body, stderr);
  const failure = claudeFailureOf(said);
  const tooLong = TOO_LONG_PATTERN.test(isRecord(body) ? resultOf(body) : stderr);
  if (code !== 0)
    throw failure === undefined
      ? claudeError({ kind: 'exit', detail: String(code) }, `Claude Code stopped with exit code ${code}.`, tooLong)
      : claudeError(failure);
  if (!isRecord(body)) throw claudeError({ kind: 'malformed' }, MALFORMED_REPLY);
  if (body.is_error !== false)
    throw failure === undefined ? claudeError({ kind: 'reported' }, REPORTED_ERROR, tooLong) : claudeError(failure);
  const text = typeof body.result === 'string' ? body.result.trim() : '';
  const segments = segmentsOf(body.structured_output) ?? segmentsOf({ segments: [{ text }] });
  if (segments === undefined) throw claudeError({ kind: 'malformed' }, MALFORMED_REPLY);
  const proposals = proposalsOf(body.structured_output);
  return {
    narration: narrationOf(segments),
    segments,
    ...(proposals === undefined ? {} : { proposals }),
    usage: usageOf(body.usage, resolvedModelOf(model), body.total_cost_usd),
  };
};

const attempt = async (route: ClaudeCodeRoute, system: string, input: string, databasePath?: string) => {
  const schema = databasePath === undefined ? undefined : NARRATION_SCHEMA;
  const dir = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
  try {
    const config = databasePath === undefined || !gameServerLaunchable() ? undefined : join(dir, MCP_CONFIG_FILE);
    if (config !== undefined && databasePath !== undefined)
      writeFileSync(config, JSON.stringify(gameMcpConfig(databasePath)), { mode: PRIVATE_FILE_MODE });
    const cwd = preparedWorkspace(route);
    return replyOf(await run(route, claudeArgs(route, system, config, schema), input, cwd), route.model);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const request = async (route: ClaudeCodeRoute, system: string, input: string, databasePath?: string) => {
  for (let tried = 0; ; tried += 1) {
    try {
      return await attempt(route, system, input, databasePath);
    } catch (error) {
      if (!(error instanceof ProviderError) || error.tooLong || tried === CLAUDE_MAX_RETRIES) throw error;
      if (error.failure !== undefined && FINAL_FAILURE_KINDS.has(error.failure.kind)) throw error;
    }
  }
};

export const requestClaudeNarration = (
  route: ClaudeCodeRoute,
  packet: Pick<ContextPacket, 'sections'>,
  databasePath: string,
): Promise<GmReply> => {
  const { instructions, stable, variable } = packetParts(packet);
  return request(route, instructions, [stable, variable].join(PART_SEPARATOR), databasePath);
};

export const requestClaudeText = async (route: ClaudeCodeRoute, system: string, content: string): Promise<string> =>
  (await request({ ...route, model: route.summaryModel, effort: CHEAP_EFFORT }, system, content)).narration;

export const requestClaudeSummary = async (
  route: ClaudeCodeRoute,
  level: SummaryLevel,
  texts: readonly string[],
  language: string | undefined,
  onUsage?: (usage: GmUsage) => void,
): Promise<string> => {
  const reply = await request(
    { ...route, model: route.summaryModel, effort: CHEAP_EFFORT },
    summaryPrompt(language),
    frameData({ level, texts }),
  );
  onUsage?.(reply.usage);
  return reply.narration;
};

const MCP_CONFIG_FLAG = '--mcp-config';

export const launchClaude = (env: NodeJS.ProcessEnv, dataDir: string, campaignDatabase?: string): number => {
  const bin = claudeBinOf(env);
  if (bin === undefined) throw new LocalizedError('claude.missing');
  const workspace = ensureClaudeWorkspace(join(dataDir, CLAUDE_WORKSPACE_DIR));
  const args = [
    ...SETTING_SOURCES,
    ...(campaignDatabase === undefined || !gameServerLaunchable()
      ? []
      : [MCP_CONFIG_FLAG, JSON.stringify(gameMcpConfig(campaignDatabase))]),
  ];
  const { status, error } = spawnSync(bin, args, {
    cwd: workspace,
    env: childEnvOf([...CHILD_ENV_KEYS, ...TERMINAL_ENV_KEYS], env),
    stdio: 'inherit',
  });
  if (error !== undefined) throw new LocalizedError('claude.missing');
  return status ?? EXIT_INTERRUPTED;
};
