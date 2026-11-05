import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, type TestContext, test } from 'node:test';
import { ProviderError } from './gm-api.ts';
import { claudeCodeRouteOf, MAX_OUTPUT_BYTES } from './gm-claude-code.ts';
import { claudeStreamArgs, MalformedStreamReply, streamClaudeNarration } from './gm-claude-stream.ts';
import { type GmSegment, SEGMENTS_SCHEMA } from './gm-segments.ts';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'rpg-stream-data-'));
const DATA_ENV = { RPG_DATA_DIR: DATA_DIR };
after(() => rmSync(DATA_DIR, { recursive: true, force: true }));

const FIXTURE = join(import.meta.dirname, 'fixtures', 'claude-stream-structured.jsonl');
const recorded = () => readFileSync(FIXTURE, 'utf8').split('\n').filter(Boolean);
const NARRATION =
  'Rain drums on the roof of the Hollow Lantern. A fire cracks in the hearth. "Sit down, stranger. You are dripping on my floor." He pushes a clay cup across the table.';
const LEAKED = /\*\*|Proposals|Entity:|Thread:|old-tam \(|thornwood/i;

test('claudeStreamArgs switches the output format to stream-json with partial messages', () => {
  const args = claudeStreamArgs(claudeCodeRouteOf('claude', {}), 'sys');
  assert.equal(args[args.indexOf('--output-format') + 1], 'stream-json');
  assert.ok(args.includes('--include-partial-messages') && args.includes('--verbose'));
});

test('claudeStreamArgs forces the segments schema so the model answers with structured output', () => {
  const args = claudeStreamArgs(claudeCodeRouteOf('claude', {}), 'sys');
  assert.equal(args[args.indexOf('--json-schema') + 1], JSON.stringify(SEGMENTS_SCHEMA));
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
const textResult = (result: string) =>
  JSON.stringify({ type: 'result', is_error: false, result, usage: { input_tokens: 1, output_tokens: 2 } });

test('streams the structured segments in order with their speakers and ignores text_delta', async (t: TestContext) => {
  const bin = fakeClaude(t, recorded());
  const seen: GmSegment[] = [];
  const reply = await streamClaudeNarration(claudeCodeRouteOf(bin, DATA_ENV), 'sys', 'input', (segment) =>
    seen.push(segment),
  );
  assert.deepEqual(seen, [
    {
      text: 'Rain drums on the roof of the Hollow Lantern. A fire cracks in the hearth.',
      delivery: { emotion: 'calm', intensity: 0.4, pace: 0.9 },
    },
    {
      speakerId: 'old-tam',
      text: '"Sit down, stranger. You are dripping on my floor."',
      important: true,
      delivery: { emotion: 'tender' },
    },
    { text: 'He pushes a clay cup across the table.' },
  ]);
  assert.deepEqual(reply.segments, seen);
  assert.equal(reply.narration, NARRATION);
});

test('parses the proposals from the structured output and shows nothing about them', async (t: TestContext) => {
  const bin = fakeClaude(t, recorded());
  const seen: GmSegment[] = [];
  const reply = await streamClaudeNarration(claudeCodeRouteOf(bin, DATA_ENV), 'sys', 'input', (segment) =>
    seen.push(segment),
  );
  assert.deepEqual(
    reply.proposals?.map(({ kind, id }) => [kind, id]),
    [
      ['entity', 'old-tam'],
      ['pending', 'tam-thornwood-lights'],
    ],
  );
  assert.doesNotMatch(JSON.stringify(seen), LEAKED);
  assert.doesNotMatch(reply.narration, LEAKED);
  assert.doesNotMatch(JSON.stringify(reply.segments), LEAKED);
});

test('a text-only reply is sanitized for the player', async (t: TestContext) => {
  const bin = fakeClaude(t, [textResult('**Narration:** Rain falls on the *old* roof.')]);
  const reply = await streamClaudeNarration(claudeCodeRouteOf(bin, DATA_ENV), 'sys', 'input', () => {});
  assert.equal(reply.narration, 'Rain falls on the old roof.');
});

test('a text-only reply with a proposals block is malformed', async (t: TestContext) => {
  const leaked = '**Narration:** Rain falls.\n\n**Proposals:**\n- Entity: old-tam (npc)';
  const bin = fakeClaude(t, [textResult(leaked)]);
  await assert.rejects(
    streamClaudeNarration(claudeCodeRouteOf(bin, DATA_ENV), 'sys', 'input', () => {}),
    MalformedStreamReply,
  );
});

test('streamClaudeNarration rejects on a non-zero exit', async (t: TestContext) => {
  const bin = fakeClaude(t, recorded(), 3);
  await assert.rejects(
    streamClaudeNarration(claudeCodeRouteOf(bin, DATA_ENV), 'sys', 'input', () => {}),
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
    streamClaudeNarration(claudeCodeRouteOf(bin, DATA_ENV), 'sys', 'input', () => {}),
    /too much output/,
  );
});

test('streamClaudeNarration propagates a throwing onSegment', async (t: TestContext) => {
  const bin = fakeClaude(t, recorded());
  await assert.rejects(
    streamClaudeNarration(claudeCodeRouteOf(bin, DATA_ENV), 'sys', 'input', () => {
      throw new Error('boom');
    }),
    /boom/,
  );
});

test('the first segment reaches the callback before the reply ends', async (t: TestContext) => {
  const dir = mkdtempSync(join(tmpdir(), 'rpg-stream-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'claude');
  const lines = recorded();
  const stop = lines.findLastIndex((line) => line.includes('content_block_stop'));
  const printed = (line: string) => `printf '%s\\n' '${line}'`;
  writeFileSync(
    bin,
    [...STREAM_OK, ...lines.slice(0, stop).map(printed), 'sleep 0.3', ...lines.slice(stop).map(printed)].join('\n'),
  );
  chmodSync(bin, 0o755);
  const MIN_GAP_MS = 200;
  const heard: number[] = [];
  await streamClaudeNarration(claudeCodeRouteOf(bin, DATA_ENV), 'sys', 'input', () => void heard.push(Date.now()));
  const ended = Date.now();
  assert.equal(heard.length, 3);
  assert.ok(ended - (heard[0] ?? ended) >= MIN_GAP_MS);
});
