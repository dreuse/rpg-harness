import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sseEventOf, sseLinesOf } from './gm-sse.ts';

const EVENT = { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{}' } };
const data = (event: object) => `data: ${JSON.stringify(event)}`;
async function* bytes(parts: readonly string[]) {
  for (const part of parts) yield new TextEncoder().encode(part);
}
const collect = async (source: AsyncIterable<string>) => {
  const out: string[] = [];
  for await (const item of source) out.push(item);
  return out;
};

test('sseEventOf parses data lines and ignores events, pings and malformed data', () => {
  assert.deepEqual(sseEventOf(data(EVENT)), EVENT);
  for (const line of ['event: content_block_delta', ': ping', 'data: {oops', ''])
    assert.equal(sseEventOf(line), undefined);
});

test('sseLinesOf rebuilds lines split across byte chunks', async () => {
  const whole = `${data(EVENT)}\n\n${data(EVENT)}\n`;
  const half = Math.floor(whole.length / 2);
  const out = await collect(sseLinesOf(bytes([whole.slice(0, half), whole.slice(half)])));
  assert.deepEqual(
    out.filter((line) => line !== ''),
    whole.split('\n').filter((line) => line !== ''),
  );
});
