import { isRecord } from './gm-api.ts';

const DATA_PREFIX = 'data:';
const TEXT_DELTA = 'text_delta';
const BLOCK_DELTA = 'content_block_delta';
const LINE_BREAK = '\n';

export async function* sseLinesOf(chunks: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of chunks) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split(LINE_BREAK);
    buffer = lines.pop() ?? '';
    yield* lines.map((line) => line.replace(/\r$/, ''));
  }
  buffer += decoder.decode();
  if (buffer !== '') yield buffer;
}

const deltaOf = (line: string): string | undefined => {
  if (!line.startsWith(DATA_PREFIX)) return undefined;
  try {
    const event: unknown = JSON.parse(line.slice(DATA_PREFIX.length));
    if (!isRecord(event) || event.type !== BLOCK_DELTA || !isRecord(event.delta)) return undefined;
    const { type, text } = event.delta;
    return type === TEXT_DELTA && typeof text === 'string' ? text : undefined;
  } catch {
    return undefined;
  }
};

export async function* sseTextDeltasOf(lines: AsyncIterable<string>): AsyncGenerator<string> {
  for await (const line of lines) {
    const text = deltaOf(line);
    if (text !== undefined) yield text;
  }
}
