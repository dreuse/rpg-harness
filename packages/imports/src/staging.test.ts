import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { MAX_IMPORT_BYTES } from './formats.ts';
import { UNKNOWN_LOCATOR } from './provenance.ts';
import { stageDocuments } from './staging.ts';

const encode = (text: string) => new TextEncoder().encode(text);
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

const PDF = encode('%PDF-1.7 rules');
const NOTES = encode('# notes');
const RULES = encode('{"a":1}');
const TRAVERSAL_NAME = '../../etc/passwd';

test('stage multiple files with type/size validation, integrity hashes and source identity', () => {
  const results = stageDocuments([
    { fileName: 'core.pdf', bytes: PDF },
    { fileName: 'notes.md', bytes: NOTES },
    { fileName: 'rules.json', bytes: RULES },
    { fileName: 'copy.md', bytes: NOTES },
  ]);

  assert.equal(results.length, 4);
  const [pdf, notes, rules, copy] = results;
  assert.ok(pdf?.ok && notes?.ok && rules?.ok);
  assert.deepEqual(
    [pdf, notes, rules].map(({ fileName, format, size, sha256: hash }) => ({ fileName, format, size, hash })),
    [
      { fileName: 'core.pdf', format: 'pdf', size: PDF.length, hash: sha256(PDF) },
      { fileName: 'notes.md', format: 'markdown', size: NOTES.length, hash: sha256(NOTES) },
      { fileName: 'rules.json', format: 'json', size: RULES.length, hash: sha256(RULES) },
    ],
  );
  assert.equal(pdf.journey.states.stage, 'succeeded');
  assert.equal(pdf.journey.states.extract, 'pending');
  assert.deepEqual(pdf.provenance, {
    sourceHash: sha256(PDF),
    fileName: 'core.pdf',
    format: 'pdf',
    locator: UNKNOWN_LOCATOR,
    quality: 'unknown',
  });

  assert.match(pdf.sourceId, /^source-[0-9a-f]{64}$/);
  assert.notEqual(pdf.sourceId, notes.sourceId);
  const [again] = stageDocuments([{ fileName: 'core.pdf', bytes: PDF }]);
  assert.ok(again?.ok);
  assert.equal(again.sourceId, pdf.sourceId);
  const [renamed] = stageDocuments([{ fileName: 'other.pdf', bytes: PDF }]);
  assert.ok(renamed?.ok);
  assert.notEqual(renamed.sourceId, pdf.sourceId);

  assert.ok(copy && !copy.ok);
  assert.equal(copy.failure, 'duplicate');
  assert.equal(copy.fileName, 'copy.md');
  assert.equal(copy.journey?.states.stage, 'failed');
  assert.equal(copy.journey?.failure, 'duplicate');
});

test('path traversal, oversized payload and unsupported file types produce safe errors', () => {
  const oversized = new Uint8Array(MAX_IMPORT_BYTES + 1);
  oversized.set(PDF);
  const results = stageDocuments([
    { fileName: TRAVERSAL_NAME, bytes: NOTES },
    { fileName: 'huge.pdf', bytes: oversized },
    { fileName: 'art.png', bytes: NOTES },
    { fileName: 'fake.pdf', bytes: NOTES },
    { fileName: 'ok.txt', bytes: NOTES },
  ]);

  assert.deepEqual(
    results.map((result) => (result.ok ? 'staged' : result.failure)),
    ['unsafe_path', 'size_cap_exceeded', 'unsupported_format', 'mime_mismatch', 'staged'],
  );
  const [traversal, huge] = results;
  assert.ok(traversal && !traversal.ok);
  assert.equal(traversal.fileName, undefined);
  assert.ok(!JSON.stringify(traversal).includes('passwd'));
  assert.ok(!JSON.stringify(results).includes('# notes'));
  assert.ok(huge && !huge.ok);
  assert.equal('sha256' in huge, false);
});
