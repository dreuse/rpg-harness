import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { KOKORO_PT_BR_MODEL_OFFER, type ModelFile } from '../../../packages/voice/src/kokoro-model.ts';
import { voiceModelCommand } from './voice-model-command.ts';

const dirs: string[] = [];
const BODY = new TextEncoder().encode('weights');
const FILES: readonly ModelFile[] = [
  { path: 'onnx/model.onnx', sha256: createHash('sha256').update(BODY).digest('hex'), bytes: BODY.length },
];
const tempDir = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'voice-model-command-'));
  dirs.push(dir);
  return dir;
};
const collect = async (lines: AsyncIterable<string>) => {
  const out: string[] = [];
  for await (const line of lines) out.push(line);
  return out.join('\n');
};

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

test('without consent it shows the pt-BR offer and downloads nothing', async () => {
  const dir = await tempDir();
  const fetchSpy = (() => assert.fail('must not download')) as unknown as typeof fetch;
  const text = await collect(voiceModelCommand(dir, { accept: false }, { fetch: fetchSpy }));
  assert.match(text, new RegExp(`Download ${KOKORO_PT_BR_MODEL_OFFER.sizeMiB} MiB`));
  assert.ok(text.includes(KOKORO_PT_BR_MODEL_OFFER.source));
  assert.match(text, /--yes/);
  assert.match(text, /not installed/);
});

test('with consent it downloads and verifies the files, then reports them installed', async () => {
  const dir = await tempDir();
  const fetchOk = (async () => new Response(BODY)) as unknown as typeof fetch;
  const text = await collect(voiceModelCommand(dir, { accept: true }, { fetch: fetchOk, files: FILES }));
  assert.match(text, /Downloaded and verified/);
  assert.match(text, /installed/);
  assert.doesNotMatch(text, /not installed/);
});

test('a tampered download is rejected', async () => {
  const dir = await tempDir();
  const evil = (async () => new Response('evil!!!')) as unknown as typeof fetch;
  await assert.rejects(collect(voiceModelCommand(dir, { accept: true }, { fetch: evil, files: FILES })), /checksum/);
});

test('the text speaks pt-BR', async () => {
  const dir = await tempDir();
  const text = await collect(voiceModelCommand(dir, { accept: false }, { locale: 'pt-BR' }));
  assert.match(text, /Baixe/);
  assert.match(text, /não instalada/);
});
