import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyFile, INGEST_FORMATS, isSafeFileName, MAX_IMPORT_BYTES } from './formats.ts';
import {
  FAILURE_KINDS,
  failureStage,
  failuresFor,
  INGEST_STAGES,
  newJourney,
  STAGE_STATES,
  withFailure,
  withSuccess,
} from './journey.ts';
import { makeProvenance, UNKNOWN_LOCATOR } from './provenance.ts';

const PDF_HEAD = new TextEncoder().encode('%PDF-1.7');
const ZIP_HEAD = Uint8Array.from([0x50, 0x4b, 0x03, 0x04]);
const TEXT_HEAD = new TextEncoder().encode('hello');
const BINARY_HEAD = Uint8Array.from([0x00, 0x01, 0x02]);
const SMALL = 10;
const HASH = 'a'.repeat(64);

const classify = (fileName: string, head: Uint8Array, size = SMALL) => classifyFile({ fileName, size, head });

test('define pdf, docx, text, markdown, yaml and json ingest journey with failure states', () => {
  assert.deepEqual([...INGEST_FORMATS], ['pdf', 'docx', 'text', 'markdown', 'yaml', 'json']);
  assert.deepEqual([...INGEST_STAGES], ['stage', 'extract', 'interpret', 'compile', 'validate', 'review', 'activate']);
  assert.deepEqual([...STAGE_STATES], ['pending', 'running', 'succeeded', 'failed']);

  assert.deepEqual(classify('book.pdf', PDF_HEAD), { ok: true, format: 'pdf' });
  assert.deepEqual(classify('book.DOCX', ZIP_HEAD), { ok: true, format: 'docx' });
  assert.deepEqual(classify('notes.txt', TEXT_HEAD), { ok: true, format: 'text' });
  assert.deepEqual(classify('notes.md', TEXT_HEAD), { ok: true, format: 'markdown' });
  assert.deepEqual(classify('rules.yml', TEXT_HEAD), { ok: true, format: 'yaml' });
  assert.deepEqual(classify('rules.json', TEXT_HEAD), { ok: true, format: 'json' });

  assert.deepEqual(classify('art.png', PDF_HEAD), { ok: false, failure: 'unsupported_format' });
  assert.deepEqual(classify('book.pdf', TEXT_HEAD), { ok: false, failure: 'mime_mismatch' });
  assert.deepEqual(classify('book.docx', PDF_HEAD), { ok: false, failure: 'mime_mismatch' });
  assert.deepEqual(classify('notes.txt', BINARY_HEAD), { ok: false, failure: 'mime_mismatch' });
  assert.deepEqual(classify('book.pdf', PDF_HEAD, MAX_IMPORT_BYTES + 1), { ok: false, failure: 'size_cap_exceeded' });
  assert.deepEqual(classify('../etc/passwd.txt', TEXT_HEAD), { ok: false, failure: 'unsafe_path' });
  assert.deepEqual(classify('/abs/notes.txt', TEXT_HEAD), { ok: false, failure: 'unsafe_path' });
  assert.deepEqual(classify('a\\b.txt', TEXT_HEAD), { ok: false, failure: 'unsafe_path' });

  for (const failure of FAILURE_KINDS) assert.ok(INGEST_STAGES.includes(failureStage(failure)));
  for (const format of INGEST_FORMATS) {
    const failures = failuresFor(format);
    for (const common of [
      'unsupported_format',
      'mime_mismatch',
      'size_cap_exceeded',
      'unsafe_path',
      'duplicate',
    ] as const) {
      assert.ok(failures.includes(common), `${format} ${common}`);
    }
  }
  assert.ok(failuresFor('pdf').includes('encrypted'));
  assert.ok(failuresFor('pdf').includes('scanned_needs_vision'));
  assert.ok(failuresFor('docx').includes('encrypted'));
  assert.ok(failuresFor('json').includes('malformed_structure'));
  assert.ok(failuresFor('yaml').includes('malformed_structure'));
  assert.ok(!failuresFor('text').includes('encrypted'));
  assert.ok(!failuresFor('markdown').includes('scanned_needs_vision'));

  assert.deepEqual(classify('book.pdf', PDF_HEAD, Number.NaN), { ok: false, failure: 'size_cap_exceeded' });
  assert.deepEqual(classify('book.pdf', PDF_HEAD, -1), { ok: false, failure: 'size_cap_exceeded' });
  assert.deepEqual(classify('book.pdf', PDF_HEAD, Number.POSITIVE_INFINITY), {
    ok: false,
    failure: 'size_cap_exceeded',
  });
  for (const name of ['json', 'pdf', '.json', 'noextension']) {
    assert.deepEqual(classify(name, TEXT_HEAD), { ok: false, failure: 'unsupported_format' }, name);
  }
  assert.deepEqual(classify('my..notes.txt', TEXT_HEAD), { ok: true, format: 'text' });
  for (const name of ['..', 'C:notes.txt', 'a\u0001b.txt', 'a\u007fb.txt', 'a\nb.txt']) {
    assert.deepEqual(classify(name, TEXT_HEAD), { ok: false, failure: 'unsafe_path' }, name);
  }
  assert.ok(isSafeFileName('my..notes.txt'));
  assert.ok(!isSafeFileName('a/b.txt'));
  assert.ok(failuresFor('docx').includes('unsafe_archive_entry'));
  assert.ok(failuresFor('docx').includes('archive_size_exceeded'));
  assert.ok(!failuresFor('pdf').includes('unsafe_archive_entry'));
  assert.equal(failureStage('unsafe_archive_entry'), 'extract');
  assert.equal(failureStage('archive_size_exceeded'), 'extract');

  const journey = newJourney('pdf');
  assert.ok(INGEST_STAGES.every((stage) => journey.states[stage] === 'pending'));
  assert.equal(withFailure(journey, 'duplicate').states.stage, 'failed');
  assert.throws(() => withFailure(journey, 'encrypted'));
  const staged = withSuccess(journey, 'stage');
  const failed = withFailure(staged, 'encrypted');
  assert.equal(failed.states.extract, 'failed');
  assert.equal(failed.failure, 'encrypted');
  assert.equal(staged.states.extract, 'pending');
  assert.throws(() => withFailure(withSuccess(newJourney('text'), 'stage'), 'encrypted'));
});

test('provenance records hash, locator and quality and never fabricates a missing locator', () => {
  const known = makeProvenance({
    sourceHash: HASH,
    fileName: 'book.pdf',
    format: 'pdf',
    locator: { kind: 'known', page: 12, title: 'Combat' },
    quality: 'high',
  });
  assert.equal(known.locator.kind, 'known');
  const unknown = makeProvenance({
    sourceHash: HASH,
    fileName: 'notes.txt',
    format: 'text',
    locator: UNKNOWN_LOCATOR,
    quality: 'unknown',
  });
  assert.deepEqual(unknown.locator, { kind: 'unknown' });
  assert.throws(() =>
    makeProvenance({ sourceHash: 'nope', fileName: 'a.txt', format: 'text', locator: UNKNOWN_LOCATOR, quality: 'low' }),
  );
  assert.throws(() =>
    makeProvenance({ sourceHash: HASH, fileName: 'a.txt', format: 'text', locator: { kind: 'known' }, quality: 'low' }),
  );
});

test('provenance file name must be a safe base name', () => {
  for (const fileName of ['../a.txt', 'dir/a.txt', '..', '']) {
    assert.throws(() =>
      makeProvenance({ sourceHash: HASH, fileName, format: 'text', locator: UNKNOWN_LOCATOR, quality: 'low' }),
    );
  }
});
