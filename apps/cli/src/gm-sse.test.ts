import assert from 'node:assert/strict';
import { test } from 'node:test';
import { segmentDeltas } from '../../../packages/voice/src/streaming-speech.ts';
import { sseLinesOf, sseTextDeltasOf } from './gm-sse.ts';

const data = (text: string) =>
  `data: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text } })}`;
async function* lines(values: readonly string[]) {
  for (const value of values) yield value;
}
async function* bytes(parts: readonly string[]) {
  for (const part of parts) yield new TextEncoder().encode(part);
}
const collect = async (source: AsyncIterable<string>) => {
  const out: string[] = [];
  for await (const item of source) out.push(item);
  return out;
};

test('sseTextDeltasOf keeps text deltas and ignores events, pings and malformed data', async () => {
  const out = await collect(
    sseTextDeltasOf(
      lines([
        'event: content_block_delta',
        data('Hello there. '),
        ': ping',
        'data: {oops',
        'data: [DONE]',
        data('Bye.'),
      ]),
    ),
  );
  assert.deepEqual(out, ['Hello there. ', 'Bye.']);
});

test('sseLinesOf rebuilds lines split across byte chunks', async () => {
  const whole = `${data('The door creaks open slowly. ')}\n\n${data('Dust falls.')}\n`;
  const half = Math.floor(whole.length / 2);
  const out = await collect(sseLinesOf(bytes([whole.slice(0, half), whole.slice(half)])));
  assert.deepEqual(
    out.filter((line) => line !== ''),
    whole.split('\n').filter((line) => line !== ''),
  );
});

test('a fake SSE byte stream becomes complete segments', async () => {
  const whole = `${data('The door creaks ')}\n${data('open slowly. ')}\n${data('Dust falls.')}\n`;
  const segments = await collect(segmentDeltas(sseTextDeltasOf(sseLinesOf(bytes([whole])))));
  assert.deepEqual(segments, ['The door creaks open slowly.', 'Dust falls.']);
});
