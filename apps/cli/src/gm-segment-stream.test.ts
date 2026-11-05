import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toolInputStream } from './gm-segment-stream.ts';
import { MAX_SEGMENTS } from './gm-segments.ts';

const TOOL = 'StructuredOutput';
const start = (index: number, name: string) => ({
  type: 'content_block_start',
  index,
  content_block: { type: 'tool_use', id: `t${index}`, name, input: {} },
});
const delta = (index: number, partial_json: string) => ({
  type: 'content_block_delta',
  index,
  delta: { type: 'input_json_delta', partial_json },
});
const OBJECT = JSON.stringify({
  segments: [
    { text: 'Rain falls on the Hollow Lantern.', delivery: { emotion: 'calm', intensity: 0.4 } },
    { speakerId: 'old-tam', text: 'He says, "Sit, stranger."', important: true },
    { speakerId: 'narrator', text: '**Narration:** He pours ale.' },
  ],
  proposals: [{ kind: 'entity', id: 'old-tam' }],
});

const feed = (chunks: readonly string[], events: readonly object[] = []) => {
  const stream = toolInputStream(TOOL);
  const out = events.flatMap((event) => stream.push(event));
  return { stream, out: [...out, ...chunks.flatMap((chunk) => stream.push(delta(1, chunk)))] };
};

test('emits each segment as soon as its object closes, in order, with speaker and delivery', () => {
  const stream = toolInputStream(TOOL);
  stream.push(start(1, TOOL));
  const seen: string[][] = [];
  for (const char of OBJECT) seen.push(stream.push(delta(1, char)).map(({ text }) => text));
  assert.deepEqual(seen.flat(), ['Rain falls on the Hollow Lantern.', 'He says, "Sit, stranger."', 'He pours ale.']);
  const FIRST_CLOSE = '"intensity":0.4}}';
  assert.equal(
    seen.findIndex((texts) => texts.length > 0),
    OBJECT.indexOf(FIRST_CLOSE) + FIRST_CLOSE.length - 1,
  );
});

test('keeps speakerId, delivery and important on the segments and sanitizes the text', () => {
  const { out } = feed([OBJECT], [start(1, TOOL)]);
  assert.deepEqual(out, [
    { text: 'Rain falls on the Hollow Lantern.', delivery: { emotion: 'calm', intensity: 0.4 } },
    { speakerId: 'old-tam', text: 'He says, "Sit, stranger."', important: true },
    { text: 'He pours ale.' },
  ]);
});

test('never emits proposals objects', () => {
  const { out } = feed(['{"proposals":[{"text":"leak"}],"segments":[{"text":"Hi there."}]}'], [start(1, TOOL)]);
  assert.deepEqual(out, [{ text: 'Hi there.' }]);
});

test('ignores text deltas and other tool blocks', () => {
  const stream = toolInputStream(TOOL);
  const events = [
    start(0, 'mcp__rpg__get_entity'),
    delta(0, '{"segments":[{"text":"not mine"}]}'),
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '**Narration:** Preamble.' } },
    start(1, TOOL),
    delta(1, '{"segments":[{"text":"Real line."}]}'),
  ];
  assert.deepEqual(
    events.flatMap((event) => stream.push(event)),
    [{ text: 'Real line.' }],
  );
});

test('survives escapes and a quote split across chunks', () => {
  const { out } = feed(
    ['{"segments":[{"text":"She said \\', '"no\\" to {me}.","speakerId":"a"}', ']}'],
    [start(1, TOOL)],
  );
  assert.deepEqual(out, [{ speakerId: 'a', text: 'She said "no" to {me}.' }]);
});

test('skips malformed and empty segment objects without throwing', () => {
  const { out } = feed(['{"segments":[{"text":"   "},{"nope":1},{"text":"Fine."}]}'], [start(1, TOOL)]);
  assert.deepEqual(out, [{ text: 'Fine.' }]);
});

test('drops a segment that carries a proposals block', () => {
  const leaked = JSON.stringify({ segments: [{ text: 'Rain.\n\n**Proposals:**\n- Entity: x' }, { text: 'Ok then.' }] });
  assert.deepEqual(feed([leaked], [start(1, TOOL)]).out, [{ text: 'Ok then.' }]);
});

test('input() returns the whole tool input once complete', () => {
  const { stream } = feed([OBJECT], [start(1, TOOL)]);
  assert.deepEqual(stream.input(), JSON.parse(OBJECT));
});

test('input() is undefined for a truncated or missing tool call', () => {
  assert.equal(toolInputStream(TOOL).input(), undefined);
  assert.equal(feed(['{"segments":[{"te'], [start(1, TOOL)]).stream.input(), undefined);
});

test('a finished tool block no longer feeds deltas and message_start clears the active block', () => {
  const stream = toolInputStream(TOOL);
  stream.push(start(1, TOOL));
  stream.push(start(1, 'mcp__rpg__get_entity'));
  assert.deepEqual(stream.push(delta(1, '{"segments":[{"text":"Stale."}]}')), []);
  stream.push(start(2, TOOL));
  stream.push({ type: 'message_start' });
  assert.deepEqual(stream.push(delta(2, '{"segments":[{"text":"Stale."}]}')), []);
});

test('stops emitting after the maximum number of segments', () => {
  const many = JSON.stringify({
    segments: Array.from({ length: MAX_SEGMENTS + 5 }, (_, at) => ({ text: `Line ${at}.` })),
  });
  const { out } = feed([many], [start(1, TOOL)]);
  assert.equal(out.length, MAX_SEGMENTS);
  assert.equal(out.at(-1)?.text, `Line ${MAX_SEGMENTS - 1}.`);
});
