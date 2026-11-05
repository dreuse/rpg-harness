import { parseArgs } from 'node:util';

export const CANDIDATES = ['kokoro-js-q8', 'kokoro-js-fp32', 'mlx-audio', 'chatterbox'] as const;
export type Candidate = (typeof CANDIDATES)[number];

export const RESULT_TAG = 'BENCH_RESULT ';
const MEBIBYTE = 1024 * 1024;
const MAX_RSS = /(\d+)\s+maximum resident set size/;
const PEAK_FOOTPRINT = /(\d+)\s+peak memory footprint/;
const RTF_DIGITS = 3;
const SECONDS_DIGITS = 2;
const LIST_SEPARATOR = ',';
const TIME_REPORT_START = /^\s+[\d.]+ real\s/m;
const NO_OUTPUT = 'no output';

export type PassageResult =
  | { passageId: string; ok: true; firstAudioMs: number; totalMs: number; audioSeconds: number }
  | { passageId: string; ok: false; error: string };

export type BenchOutput = {
  candidate: string;
  versions: Record<string, string>;
  device: string;
  loadMs: number;
  warmupMs: number;
  unloadMs: number;
  results: PassageResult[];
};

export type PeakMemory = { maxRssBytes?: number; peakFootprintBytes?: number };

export type CandidateRun =
  | {
      candidate: Candidate;
      status: 'measured';
      bench: BenchOutput;
      memory: PeakMemory;
      modelBytes: number;
      installBytes: number;
    }
  | { candidate: Candidate; status: 'not measured'; reason: string };

export type CliOptions = { candidates: Candidate[]; install: boolean };

const MS_PER_SECOND = 1000;

export const realTimeFactor = (totalMs: number, audioSeconds: number): number =>
  audioSeconds > 0 ? totalMs / MS_PER_SECOND / audioSeconds : Number.POSITIVE_INFINITY;

export const median = (values: readonly number[]): number | undefined => {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
};

const matchNumber = (text: string, pattern: RegExp): number | undefined => {
  const found = pattern.exec(text)?.[1];
  return found === undefined ? undefined : Number(found);
};

export const parsePeakMemory = (timeStderr: string): PeakMemory => {
  const maxRssBytes = matchNumber(timeStderr, MAX_RSS);
  const peakFootprintBytes = matchNumber(timeStderr, PEAK_FOOTPRINT);
  return {
    ...(maxRssBytes === undefined ? {} : { maxRssBytes }),
    ...(peakFootprintBytes === undefined ? {} : { peakFootprintBytes }),
  };
};

export const parseBenchOutput = (stdout: string): BenchOutput | undefined => {
  const line = stdout
    .split('\n')
    .filter((entry) => entry.startsWith(RESULT_TAG))
    .at(-1);
  return line === undefined ? undefined : (JSON.parse(line.slice(RESULT_TAG.length)) as BenchOutput);
};

export const benchFailure = (stderr: string): string => {
  const start = stderr.search(TIME_REPORT_START);
  const lines = (start < 0 ? stderr : stderr.slice(0, start))
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.at(-1) ?? NO_OUTPUT;
};

const isCandidate = (value: string): value is Candidate => (CANDIDATES as readonly string[]).includes(value);

export const parseCliArgs = (argv: readonly string[]): CliOptions => {
  const { values } = parseArgs({
    args: [...argv],
    options: { candidates: { type: 'string' }, 'skip-install': { type: 'boolean', default: false } },
    strict: true,
  });
  const requested = values.candidates?.split(LIST_SEPARATOR).map((name) => name.trim()) ?? [...CANDIDATES];
  const unknown = requested.find((name) => !isCandidate(name));
  if (unknown !== undefined) throw new Error(`unknown candidate: ${unknown}`);
  return { candidates: requested.filter(isCandidate), install: !values['skip-install'] };
};

const mebibytes = (bytes: number | undefined): string =>
  bytes === undefined ? 'n/a' : String(Math.round(bytes / MEBIBYTE));
const fixed = (value: number | undefined, digits: number): string =>
  value === undefined ? 'n/a' : value.toFixed(digits);
const whole = (value: number | undefined): string => (value === undefined ? 'n/a' : String(Math.round(value)));

const summaryRow = (run: Extract<CandidateRun, { status: 'measured' }>): string => {
  const { bench, memory } = run;
  const passed = bench.results.filter((result) => result.ok);
  const versions = Object.entries(bench.versions)
    .map(([name, version]) => `${name} ${version}`)
    .join(', ');
  return `| ${[
    run.candidate,
    versions,
    bench.device,
    whole(bench.loadMs),
    whole(bench.warmupMs),
    whole(bench.unloadMs),
    whole(median(passed.map((result) => result.firstAudioMs))),
    fixed(median(passed.map((result) => realTimeFactor(result.totalMs, result.audioSeconds))), RTF_DIGITS),
    mebibytes(memory.maxRssBytes),
    mebibytes(memory.peakFootprintBytes),
    mebibytes(run.modelBytes),
    mebibytes(run.installBytes),
    `${passed.length}/${bench.results.length}`,
  ].join(' | ')} |`;
};

const passageRow = (candidate: Candidate, result: PassageResult): string =>
  result.ok
    ? `| ${candidate} | ${result.passageId} | ${whole(result.firstAudioMs)} | ${whole(result.totalMs)} | ${fixed(result.audioSeconds, SECONDS_DIGITS)} | ${fixed(realTimeFactor(result.totalMs, result.audioSeconds), RTF_DIGITS)} |`
    : `| ${candidate} | ${result.passageId} | failed: ${result.error.replaceAll('|', '/').replaceAll('\n', ' ')} | | | |`;

export const renderResults = (runs: readonly CandidateRun[]): string => {
  const measured = runs.filter((run) => run.status === 'measured');
  const skipped = runs.filter((run) => run.status === 'not measured');
  return [
    '| Candidate | Versions | Device | Load ms | Warm-up ms | Unload ms | Median first audio ms | Median RTF | Peak RSS MiB | Peak footprint MiB | Model MiB | Install MiB | Passages ok |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|',
    ...measured.map(summaryRow),
    '',
    '| Candidate | Passage | First audio ms | Total ms | Audio s | RTF |',
    '|---|---|---|---|---|---|',
    ...measured.flatMap((run) => run.bench.results.map((result) => passageRow(run.candidate, result))),
    '',
    ...skipped.map((run) => `- ${run.candidate}: not measured (${run.reason})`),
    '',
  ].join('\n');
};
