import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { type ContextPacket, packetParts } from '../../../packages/memory/src/packet.ts';
import { type GmReply, isRecord, ProviderError } from './gm-api.ts';
import { type ClaudeCodeRoute, claudeArgs, MAX_OUTPUT_BYTES, preparedWorkspace, replyOf } from './gm-claude-code.ts';

const STREAM_FORMAT = 'stream-json';
const FORMAT_FLAG = '--output-format';
const STREAM_FLAGS = ['--verbose', '--include-partial-messages'];
const STREAM_EVENT = 'stream_event';
const TEXT_DELTA = 'text_delta';
const RESULT_EVENT = 'result';
const ABORT_ERROR = 'AbortError';
const IGNORE = () => {};
const STREAMING_SPEECH_MODULE = '../../../packages/voice/src/streaming-speech.ts';
const OUTPUT_TOO_LARGE = 'Claude Code sent too much output.';

export const claudeStreamArgs = (route: ClaudeCodeRoute, system: string, mcpConfig?: string): string[] => {
  const args = claudeArgs(route, system, mcpConfig);
  const at = args.indexOf(FORMAT_FLAG) + 1;
  return [...args.slice(0, at), STREAM_FORMAT, ...STREAM_FLAGS, ...args.slice(at + 1)];
};

const deltaOf = (line: string): string | undefined => {
  try {
    const event: unknown = JSON.parse(line);
    if (!isRecord(event) || event.type !== STREAM_EVENT || !isRecord(event.event)) return undefined;
    const { delta } = event.event;
    return isRecord(delta) && delta.type === TEXT_DELTA && typeof delta.text === 'string' ? delta.text : undefined;
  } catch {
    return undefined;
  }
};

export async function* textDeltasOf(lines: AsyncIterable<string>): AsyncGenerator<string> {
  for await (const line of lines) {
    const text = deltaOf(line);
    if (text !== undefined) yield text;
  }
}

const isResult = (line: string): boolean => {
  try {
    const event: unknown = JSON.parse(line);
    return isRecord(event) && event.type === RESULT_EVENT;
  } catch {
    return false;
  }
};

export const streamClaudeNarration = async (
  route: ClaudeCodeRoute,
  system: string,
  input: string,
  onSegment: (segment: string) => void,
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
  async function* observed(): AsyncGenerator<string> {
    for await (const line of createInterface({ input: child.stdout })) {
      if (isResult(line)) result = line;
      yield line;
    }
  }
  const { segmentDeltas } = await import(STREAMING_SPEECH_MODULE);
  try {
    for await (const segment of segmentDeltas(textDeltasOf(observed()))) onSegment(segment);
    if (capped) throw new ProviderError(OUTPUT_TOO_LARGE);
    return replyOf({ code: await exited, stdout: result }, route.model);
  } finally {
    child.kill();
  }
};

const PART_SEPARATOR = '\n';

export const requestClaudeStream = (
  route: ClaudeCodeRoute,
  packet: Pick<ContextPacket, 'sections'>,
  onSegment: (segment: string) => void,
): Promise<GmReply> => {
  const { instructions, stable, variable } = packetParts(packet);
  return streamClaudeNarration(route, instructions, [stable, variable].join(PART_SEPARATOR), onSegment);
};
