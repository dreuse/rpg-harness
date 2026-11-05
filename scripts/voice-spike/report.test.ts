import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type BenchOutput,
  benchFailure,
  CANDIDATES,
  type CandidateRun,
  median,
  parseBenchOutput,
  parseCliArgs,
  parsePeakMemory,
  realTimeFactor,
  renderResults,
} from './report.ts';

const TIME_STDERR = `        2.10 real         1.50 user         0.30 sys
           524288000  maximum resident set size
                   0  average shared memory size
           734003200  peak memory footprint
`;

const BENCH: BenchOutput = {
  candidate: 'kokoro-js-q8',
  versions: { 'kokoro-js': '1.2.1' },
  device: 'cpu',
  loadMs: 1200,
  warmupMs: 300,
  unloadMs: 15,
  results: [
    { passageId: 'en-npc-warning', ok: true, firstAudioMs: 100, totalMs: 200, audioSeconds: 2 },
    { passageId: 'en-narration', ok: true, firstAudioMs: 300, totalMs: 1000, audioSeconds: 4 },
    { passageId: 'pt-BR-npc-warning', ok: false, error: 'unsupported voice' },
  ],
};

test('real-time factor is synthesis time over audio duration', () => {
  assert.equal(realTimeFactor(500, 2), 0.25);
  assert.equal(realTimeFactor(500, 0), Number.POSITIVE_INFINITY);
});

test('median handles odd, even and empty lists', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(median([]), undefined);
});

test('peak memory is read from macOS time -l output', () => {
  assert.deepEqual(parsePeakMemory(TIME_STDERR), { maxRssBytes: 524288000, peakFootprintBytes: 734003200 });
  assert.deepEqual(parsePeakMemory('nothing here'), {});
});

test('bench output is the last tagged JSON line on stdout', () => {
  const stdout = `noise\nBENCH_RESULT {"candidate":"old"}\nmore noise\nBENCH_RESULT ${JSON.stringify(BENCH)}\n`;
  assert.deepEqual(parseBenchOutput(stdout), BENCH);
  assert.equal(parseBenchOutput('no result'), undefined);
});

test('cli selects all candidates by default and installs unless told not to', () => {
  assert.deepEqual(parseCliArgs([]), { candidates: [...CANDIDATES], install: true });
  assert.deepEqual(parseCliArgs(['--candidates', 'mlx-audio,kokoro-js-q8', '--skip-install']), {
    candidates: ['mlx-audio', 'kokoro-js-q8'],
    install: false,
  });
});

test('cli rejects unknown candidates and flags', () => {
  assert.throws(() => parseCliArgs(['--candidates', 'piper']), /unknown candidate: piper/);
  assert.throws(() => parseCliArgs(['--cloud']));
});

test('results markdown shows summary, per-passage rows and unmeasured candidates', () => {
  const runs: CandidateRun[] = [
    {
      candidate: 'kokoro-js-q8',
      status: 'measured',
      bench: BENCH,
      memory: { maxRssBytes: 524288000, peakFootprintBytes: 734003200 },
      modelBytes: 92 * 1024 * 1024,
      installBytes: 300 * 1024 * 1024,
    },
    { candidate: 'chatterbox', status: 'not measured', reason: 'torch wheel missing' },
  ];
  const markdown = renderResults(runs);
  assert.match(
    markdown,
    /\| kokoro-js-q8 \| kokoro-js 1\.2\.1 \| cpu \| 1200 \| 300 \| 15 \| 200 \| 0\.175 \| 500 \| 700 \| 92 \| 300 \| 2\/3 \|/,
  );
  assert.match(markdown, /\| kokoro-js-q8 \| en-narration \| 300 \| 1000 \| 4\.00 \| 0\.250 \|/);
  assert.match(markdown, /\| kokoro-js-q8 \| pt-BR-npc-warning \| failed: unsupported voice \|/);
  assert.match(markdown, /chatterbox: not measured \(torch wheel missing\)/);
});

test('bench failure reason is the last error line before the time -l report', () => {
  const stderr = `Traceback (most recent call last):\n  File "x.py", line 1\nImportError: misaki missing\n${TIME_STDERR}`;
  assert.equal(benchFailure(stderr), 'ImportError: misaki missing');
  assert.equal(benchFailure(TIME_STDERR), 'no output');
});
