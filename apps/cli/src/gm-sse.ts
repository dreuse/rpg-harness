const DATA_PREFIX = 'data:';
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

export const sseEventOf = (line: string): unknown => {
  if (!line.startsWith(DATA_PREFIX)) return undefined;
  try {
    return JSON.parse(line.slice(DATA_PREFIX.length));
  } catch {
    return undefined;
  }
};
