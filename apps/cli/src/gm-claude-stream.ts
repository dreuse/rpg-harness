import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { type ContextPacket, packetParts } from '../../../packages/memory/src/packet.ts';
import { type GmReply, isRecord, ProviderError } from './gm-api.ts';
import {
  type ClaudeCodeRoute,
  claudeArgs,
  MAX_OUTPUT_BYTES,
  NARRATION_SCHEMA,
  preparedWorkspace,
  replyOf,
} from './gm-claude-code.ts';
import { toolInputStream } from './gm-segment-stream.ts';
import { type GmSegment, segmentsOf } from './gm-segments.ts';
import { hasProposalsBlock } from './player-text.ts';

const STREAM_FORMAT = 'stream-json';
const FORMAT_FLAG = '--output-format';
const STREAM_FLAGS = ['--verbose', '--include-partial-messages'];
const STREAM_EVENT = 'stream_event';
const STRUCTURED_OUTPUT_TOOL = 'StructuredOutput';
const RESULT_EVENT = 'result';
const EXIT_OK = 0;
const ABORT_ERROR = 'AbortError';
const IGNORE = () => {};
const OUTPUT_TOO_LARGE = 'Claude Code sent too much output.';
const MALFORMED_STREAM = 'Claude Code streamed a reply that is not valid narration.';

export const claudeStreamArgs = (route: ClaudeCodeRoute, system: string, mcpConfig?: string): string[] => {
  const args = claudeArgs(route, system, mcpConfig, NARRATION_SCHEMA);
  const at = args.indexOf(FORMAT_FLAG) + 1;
  return [...args.slice(0, at), STREAM_FORMAT, ...STREAM_FLAGS, ...args.slice(at + 1)];
};

const parsedEvent = (line: string): unknown => {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
};

const isResult = (event: unknown): boolean => isRecord(event) && event.type === RESULT_EVENT;

const streamedEventOf = (event: unknown): unknown =>
  isRecord(event) && event.type === STREAM_EVENT ? event.event : undefined;

export class MalformedStreamReply extends Error {
  constructor() {
    super(MALFORMED_STREAM);
    this.name = 'MalformedStreamReply';
  }
}

const leaksProposals = (result: string): boolean => {
  const body = parsedEvent(result);
  if (!isRecord(body) || segmentsOf(body.structured_output) !== undefined) return false;
  return typeof body.result === 'string' && hasProposalsBlock(body.result);
};

export const streamClaudeNarration = async (
  route: ClaudeCodeRoute,
  system: string,
  input: string,
  onSegment: (segment: GmSegment) => void,
): Promise<GmReply> => {
  const cwd = preparedWorkspace(route);
  const child = spawn(route.bin, claudeStreamArgs(route, system), {
    cwd,
    env: route.env,
    stdio: ['pipe', 'pipe', 'ignore'],
    signal: AbortSignal.timeout(route.timeoutMs),
  });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.on('error', (error) =>
      reject(
        new ProviderError(
          error.name === ABORT_ERROR
            ? `Claude Code timed out after ${route.timeoutMs} ms.`
            : 'Claude Code could not be started.',
        ),
      ),
    );
    child.on('close', resolve);
  });
  exited.catch(IGNORE);
  let size = 0;
  let capped = false;
  child.stdout.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size > MAX_OUTPUT_BYTES && !capped) {
      capped = true;
      child.kill();
    }
  });
  child.stdin.on('error', IGNORE);
  child.stdin.end(input);
  let result = '';
  const structured = toolInputStream(STRUCTURED_OUTPUT_TOOL);
  try {
    for await (const line of createInterface({ input: child.stdout })) {
      const event = parsedEvent(line);
      if (isResult(event)) result = line;
      for (const segment of structured.push(streamedEventOf(event))) onSegment(segment);
    }
    if (capped) throw new ProviderError(OUTPUT_TOO_LARGE);
    const code = await exited;
    if (code === EXIT_OK && leaksProposals(result)) throw new MalformedStreamReply();
    return replyOf({ code, stdout: result }, route.model);
  } finally {
    child.kill();
  }
};

const PART_SEPARATOR = '\n';

export const requestClaudeStream = (
  route: ClaudeCodeRoute,
  packet: Pick<ContextPacket, 'sections'>,
  onSegment: (segment: GmSegment) => void,
): Promise<GmReply> => {
  const { instructions, stable, variable } = packetParts(packet);
  return streamClaudeNarration(route, instructions, [stable, variable].join(PART_SEPARATOR), onSegment);
};
