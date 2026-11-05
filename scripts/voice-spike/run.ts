import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PASSAGES } from './passages.ts';
import {
  benchFailure,
  type Candidate,
  type CandidateRun,
  parseBenchOutput,
  parseCliArgs,
  parsePeakMemory,
  renderResults,
} from './report.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const SPIKE_DIR = join(ROOT, '.voice-spike');
const KOKORO_JS_DIR = join(SPIKE_DIR, 'kokoro-js');
const MLX_AUDIO_DIR = join(SPIKE_DIR, 'mlx-audio');
const CHATTERBOX_DIR = join(SPIKE_DIR, 'chatterbox');
const PASSAGES_FILE = join(SPIKE_DIR, 'passages.json');
const RESULTS_FILE = join(SPIKE_DIR, 'results.md');
const TIME_BINARY = '/usr/bin/time';
const KOKORO_JS_SPEC = 'kokoro-js@1.2.1';
const SPACY_EN_MODEL =
  'en-core-web-sm @ https://github.com/explosion/spacy-models/releases/download/en_core_web_sm-3.8.0/en_core_web_sm-3.8.0-py3-none-any.whl';
const MLX_AUDIO_SPECS = ['mlx-audio==0.6.4', 'misaki[en]==0.9.4', SPACY_EN_MODEL];
const CHATTERBOX_SPECS = ['chatterbox-tts==0.1.7', 'setuptools<81'];
const PYTHON_VERSION = '3.12';
const PUBLIC_PYPI = 'https://pypi.org/simple';
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const HF_XET_DISABLED = '1';
const ISOLATED_PACKAGE_JSON = '{"private":true,"type":"module"}\n';

type Setup = { install: () => void; command: string[]; modelDir: string; installDir: string };

const runStep = (command: string, args: string[]): void => {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.status !== 0)
    throw new Error(`${command} ${args.join(' ')} exited with ${result.status ?? result.signal}`);
};

const installKokoroJs = (): void => {
  mkdirSync(KOKORO_JS_DIR, { recursive: true });
  const manifest = join(KOKORO_JS_DIR, 'package.json');
  if (!existsSync(manifest)) writeFileSync(manifest, ISOLATED_PACKAGE_JSON);
  runStep('npm', ['install', '--prefix', KOKORO_JS_DIR, '--no-audit', '--no-fund', KOKORO_JS_SPEC]);
};

const venvPython = (dir: string): string => join(dir, 'venv', 'bin', 'python');

const installPython = (dir: string, specs: string[]) => (): void => {
  runStep('uv', ['venv', '--no-config', '--allow-existing', '--python', PYTHON_VERSION, join(dir, 'venv')]);
  runStep('uv', [
    'pip',
    'install',
    '--no-config',
    '--default-index',
    PUBLIC_PYPI,
    '--python',
    venvPython(dir),
    ...specs,
  ]);
};

const kokoroJs = (dtype: string, name: Candidate): Setup => ({
  install: installKokoroJs,
  command: [
    process.execPath,
    '--expose-gc',
    join(import.meta.dirname, 'kokoro-js-bench.ts'),
    '--dir',
    KOKORO_JS_DIR,
    '--dtype',
    dtype,
    '--out',
    join(KOKORO_JS_DIR, 'out', name),
    '--name',
    name,
  ],
  modelDir: join(KOKORO_JS_DIR, 'models', name),
  installDir: join(KOKORO_JS_DIR, 'node_modules'),
});

const python = (dir: string, specs: string[], name: Candidate): Setup => ({
  install: installPython(dir, specs),
  command: [venvPython(dir), '-I', join(import.meta.dirname, 'python_bench.py'), name, PASSAGES_FILE, join(dir, 'out')],
  modelDir: join(dir, 'hf'),
  installDir: join(dir, 'venv'),
});

const SETUPS: Record<Candidate, Setup> = {
  'kokoro-js-q8': kokoroJs('q8', 'kokoro-js-q8'),
  'kokoro-js-fp32': kokoroJs('fp32', 'kokoro-js-fp32'),
  'mlx-audio': python(MLX_AUDIO_DIR, MLX_AUDIO_SPECS, 'mlx-audio'),
  chatterbox: python(CHATTERBOX_DIR, CHATTERBOX_SPECS, 'chatterbox'),
};

const dirBytes = (dir: string): number =>
  existsSync(dir)
    ? readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .reduce((total, entry) => total + lstatSync(join(entry.parentPath, entry.name)).size, 0)
    : 0;

const measure = (candidate: Candidate, install: boolean): CandidateRun => {
  const setup = SETUPS[candidate];
  try {
    if (install) setup.install();
  } catch (error) {
    return { candidate, status: 'not measured', reason: `install failed: ${(error as Error).message}` };
  }
  const [command = '', ...args] = setup.command;
  const result = spawnSync(TIME_BINARY, ['-l', command, ...args], {
    encoding: 'utf8',
    maxBuffer: MAX_OUTPUT_BYTES,
    env: { ...process.env, HF_HOME: setup.modelDir, HF_HUB_DISABLE_XET: HF_XET_DISABLED },
  });
  process.stderr.write(result.stderr);
  const bench = parseBenchOutput(result.stdout);
  if (!bench) return { candidate, status: 'not measured', reason: `bench failed: ${benchFailure(result.stderr)}` };
  return {
    candidate,
    status: 'measured',
    bench,
    memory: parsePeakMemory(result.stderr),
    modelBytes: dirBytes(setup.modelDir),
    installBytes: dirBytes(setup.installDir),
  };
};

const options = parseCliArgs(process.argv.slice(2));
mkdirSync(SPIKE_DIR, { recursive: true });
writeFileSync(PASSAGES_FILE, JSON.stringify(PASSAGES));
const markdown = renderResults(options.candidates.map((candidate) => measure(candidate, options.install)));
writeFileSync(RESULTS_FILE, markdown);
console.log(markdown);
