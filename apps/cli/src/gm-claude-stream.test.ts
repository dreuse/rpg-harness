import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { segmentDeltas } from '../../../packages/voice/src/streaming-speech.ts';
import { ProviderError } from './gm-api.ts';
import { claudeCodeRouteOf, MAX_OUTPUT_BYTES } from './gm-claude-code.ts';
import { claudeStreamArgs, streamClaudeNarration, textDeltasOf } from './gm-claude-stream.ts';

const delta = (text: string) =>
  JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } });
async function* lines(values: readonly string[]) {
  for (const value of values) yield value;
}
const collect = async (source: AsyncIterable<string>) => {
  const out: string[] = [];
  for await (const item of source) out.push(item);
  return out;
};

test('claudeStreamArgs switches the output format to stream-json with partial messages', () => {
  const args = claudeStreamArgs(claudeCodeRouteOf('claude', {}), 'sys');
  assert.equal(args[args.indexOf('--output-format') + 1], 'stream-json');
  assert.ok(args.includes('--include-partial-messages') && args.includes('--verbose'));
});

test('textDeltasOf yields text deltas, skips other and malformed lines', async () => {
  const out = await collect(
    textDeltasOf(lines([delta('The door creaks open. '), 'not json', '{"type":"system"}', '', delta('Dust falls.')])),
  );
  assert.deepEqual(out, ['The door creaks open. ', 'Dust falls.']);
});

test('a fake stream-json stream feeds complete segments', async () => {
  const stream = textDeltasOf(lines([delta('The door creaks '), delta('open slowly. '), delta('Dust falls.')]));
  assert.deepEqual(await collect(segmentDeltas(stream)), ['The door creaks open slowly.', 'Dust falls.']);
});

const STREAM_OK = ['#!/bin/sh', 'cat >/dev/null'];
const fakeClaude = (t: TestContext, outputLines: readonly string[], exitCode = 0) => {
  const dir = mkdtempSync(join(tmpdir(), 'rpg-stream-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'claude');
  const printed = outputLines.map((line) => `printf '%s\\n' '${line}'`);
  writeFileSync(bin, [...STREAM_OK, ...printed, `exit ${exitCode}`].join('\n'));
  chmodSync(bin, 0o755);
  return bin;
};
const resultLine = JSON.stringify({
  type: 'result',
  is_error: false,
  result: 'The door creaks open slowly. Dust falls.',
  usage: { input_tokens: 1, output_tokens: 2 },
});

test('streamClaudeNarration hands segments to the callback and returns the final reply', async (t: TestContext) => {
  const bin = fakeClaude(t, [delta('The door creaks '), delta('open slowly. '), delta('Dust falls.'), resultLine]);
  const seen: string[] = [];
  const reply = await streamClaudeNarration(
    claudeCodeRouteOf(bin, {}),
    'sys',
    'input',
    (segment) => void seen.push(segment),
  );
  assert.deepEqual(seen, ['The door creaks open slowly.', 'Dust falls.']);
  assert.equal(reply.narration, 'The door creaks open slowly. Dust falls.');
});

test('streamClaudeNarration rejects on a non-zero exit', async (t: TestContext) => {
  const bin = fakeClaude(t, [delta('Hello there friend. '), resultLine], 3);
  await assert.rejects(
    streamClaudeNarration(claudeCodeRouteOf(bin, {}), 'sys', 'input', () => {}),
    ProviderError,
  );
});

test('streamClaudeNarration stops and fails when stdout passes the size cap', async (t: TestContext) => {
  const dir = mkdtempSync(join(tmpdir(), 'rpg-stream-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'claude');
  writeFileSync(
    bin,
    ['#!/bin/sh', 'cat >/dev/null', `yes aaaaaaaaaaaaaaaa | head -c ${MAX_OUTPUT_BYTES * 2}`].join('\n'),
  );
  chmodSync(bin, 0o755);
  await assert.rejects(
    streamClaudeNarration(claudeCodeRouteOf(bin, {}), 'sys', 'input', () => {}),
    /too much output/,
  );
});

test('streamClaudeNarration propagates a throwing onSegment', async (t: TestContext) => {
  const bin = fakeClaude(t, [delta('Hello there friend. '), resultLine]);
  await assert.rejects(
    streamClaudeNarration(claudeCodeRouteOf(bin, {}), 'sys', 'input', () => {
      throw new Error('boom');
    }),
    /boom/,
  );
});
