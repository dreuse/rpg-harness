import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CAMPAIGN_TOOLS } from '../../../packages/mcp/src/tools.ts';
import type { SummaryLevel } from '../../../packages/memory/src/history.ts';
import { type ContextPacket, frameData, packetParts } from '../../../packages/memory/src/packet.ts';
import {
  GM_MODEL_ENV,
  type GmReply,
  isRecord,
  PROVIDER_DEFAULT_MODEL,
  ProviderError,
  SUMMARY_MODEL_ENV,
  SUMMARY_PROMPT,
  SYSTEM_PROMPT,
  usageOf,
} from './gm-api.ts';
import { narrationOf, narratorSegments, SEGMENTS_SCHEMA, segmentsOf } from './gm-segments.ts';

export const GM_PROFILE_ENV = 'RPG_GM_PROFILE';
export const FULL_PROFILE = 'full';
export const LEAN_PROFILE = 'lean';
export type GmProfile = typeof FULL_PROFILE | typeof LEAN_PROFILE;
export const CLAUDE_TIMEOUT_MS = 120_000;
export const CLAUDE_MAX_RETRIES = 1;
export const CHEAP_CLAUDE_MODEL = 'haiku';
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

const GAME_SERVER = 'rpg';
const toolName = (name: string) => `mcp__${GAME_SERVER}__${name}`;
export const READ_ONLY_GAME_TOOLS = CAMPAIGN_TOOLS.filter(({ annotations }) => annotations.readOnlyHint).map(
  ({ name }) => toolName(name),
);
export const WRITE_GAME_TOOLS = CAMPAIGN_TOOLS.filter(({ annotations }) => !annotations.readOnlyHint).map(({ name }) =>
  toolName(name),
);

const MCP_SERVER_ENTRY = join(import.meta.dirname, '../../mcp-server/src/main.ts');
const DATABASE_ENV = 'RPG_DATABASE_PATH';
const TEMP_PREFIX = 'rpg-gm-';
const MCP_CONFIG_FILE = 'mcp.json';
const PRIVATE_FILE_MODE = 0o600;
const MAX_OUTPUT_BYTES = 1_048_576;
const ABORT_ERROR = 'AbortError';
const TOOL_SEPARATOR = ',';
const NO_BUILT_IN_TOOLS = '';
const PART_SEPARATOR = '\n';
const NO_PROMPT_MODE = 'dontAsk';
const IGNORE = () => {};
const NARRATION_SCHEMA = JSON.stringify(SEGMENTS_SCHEMA);

export type ClaudeCodeRoute = {
  readonly bin: string;
  readonly profile: GmProfile;
  readonly model: string | undefined;
  readonly summaryModel: string;
  readonly timeoutMs: number;
  readonly env: NodeJS.ProcessEnv;
  readonly gameServer: boolean;
};

export const claudeCodeRouteOf = (
  bin: string,
  env: NodeJS.ProcessEnv,
  versions: { readonly electron?: string } = process.versions,
): ClaudeCodeRoute => ({
  bin,
  profile: env[GM_PROFILE_ENV]?.trim() === LEAN_PROFILE ? LEAN_PROFILE : FULL_PROFILE,
  model: env[GM_MODEL_ENV]?.trim() || undefined,
  summaryModel: env[SUMMARY_MODEL_ENV]?.trim() || CHEAP_CLAUDE_MODEL,
  timeoutMs: CLAUDE_TIMEOUT_MS,
  env: Object.fromEntries(CHILD_ENV_KEYS.flatMap((name) => (env[name] === undefined ? [] : [[name, env[name]]]))),
  gameServer: versions.electron === undefined,
});

export const claudeArgs = (
  { profile, model }: ClaudeCodeRoute,
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
  '--append-system-prompt',
  system,
  ...(mcpConfig === undefined ? [] : ['--mcp-config', mcpConfig]),
  ...(schema === undefined ? [] : ['--json-schema', schema]),
  ...(profile === LEAN_PROFILE ? ['--strict-mcp-config', '--tools', NO_BUILT_IN_TOOLS] : []),
  '--allowedTools',
  READ_ONLY_GAME_TOOLS.join(TOOL_SEPARATOR),
  '--disallowedTools',
  WRITE_GAME_TOOLS.join(TOOL_SEPARATOR),
  ...(model === undefined || model === PROVIDER_DEFAULT_MODEL ? [] : [`--model=${model}`]),
];

const gameMcpConfig = (databasePath: string) => ({
  mcpServers: {
    [GAME_SERVER]: { command: process.execPath, args: [MCP_SERVER_ENTRY], env: { [DATABASE_ENV]: databasePath } },
  },
});

type Exit = { readonly code: number | null; readonly stdout: string };

const run = ({ bin, env, timeoutMs }: ClaudeCodeRoute, args: string[], input: string, cwd: string) =>
  new Promise<Exit>((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'ignore'],
      signal: AbortSignal.timeout(timeoutMs),
    });
    const chunks: Buffer[] = [];
    let size = 0;
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_OUTPUT_BYTES) child.kill();
      else chunks.push(chunk);
    });
    child.on('error', (error) =>
      reject(
        new ProviderError(
          error.name === ABORT_ERROR
            ? `Claude Code timed out after ${timeoutMs} ms.`
            : 'Claude Code could not be started.',
        ),
      ),
    );
    child.on('close', (code) => resolve({ code, stdout: Buffer.concat(chunks).toString() }));
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

const replyOf = ({ code, stdout }: Exit, model: string | undefined): GmReply => {
  if (code !== 0) throw new ProviderError(`Claude Code stopped with exit code ${code}.`);
  const body = parsed(stdout);
  if (!isRecord(body)) throw new ProviderError('Claude Code sent a malformed reply.');
  if (body.is_error !== false)
    throw new ProviderError(
      'Claude Code reported an error. Run claude once in a terminal to check that it is signed in.',
    );
  const text = typeof body.result === 'string' ? body.result.trim() : '';
  const segments = segmentsOf(body.structured_output) ?? (text === '' ? undefined : narratorSegments(text));
  if (segments === undefined) throw new ProviderError('Claude Code sent a malformed reply.');
  return {
    narration: narrationOf(segments),
    segments,
    usage: usageOf(body.usage, model ?? PROVIDER_DEFAULT_MODEL, body.total_cost_usd),
  };
};

const attempt = async (route: ClaudeCodeRoute, system: string, input: string, databasePath?: string) => {
  const schema = databasePath === undefined ? undefined : NARRATION_SCHEMA;
  const dir = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
  try {
    const config = databasePath === undefined || !route.gameServer ? undefined : join(dir, MCP_CONFIG_FILE);
    if (config !== undefined && databasePath !== undefined)
      writeFileSync(config, JSON.stringify(gameMcpConfig(databasePath)), { mode: PRIVATE_FILE_MODE });
    return replyOf(await run(route, claudeArgs(route, system, config, schema), input, dir), route.model);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const request = async (route: ClaudeCodeRoute, system: string, input: string, databasePath?: string) => {
  for (let tried = 0; ; tried += 1) {
    try {
      return await attempt(route, system, input, databasePath);
    } catch (error) {
      if (!(error instanceof ProviderError) || tried === CLAUDE_MAX_RETRIES) throw error;
    }
  }
};

export const requestClaudeNarration = (
  route: ClaudeCodeRoute,
  packet: Pick<ContextPacket, 'sections'>,
  databasePath: string,
): Promise<GmReply> => {
  const { stable, variable } = packetParts(packet);
  return request(route, SYSTEM_PROMPT, [stable, variable].join(PART_SEPARATOR), databasePath);
};

export const requestClaudeSummary = async (
  route: ClaudeCodeRoute,
  level: SummaryLevel,
  texts: readonly string[],
): Promise<string> =>
  (await request({ ...route, model: route.summaryModel }, SUMMARY_PROMPT, frameData({ level, texts }))).narration;
