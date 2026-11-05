import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import type { ModelConsent } from './kokoro-model.ts';
import { MLX_AUDIO_SERVICE_SOURCE, mlxAudioPaths } from './mlx-audio-engine.ts';
import { createMlxAudioInstaller, MLX_AUDIO_OFFER, MLX_AUDIO_SPECS, type StepRunner } from './mlx-audio-install.ts';

const SECRET_ENV = 'RPG_VOICE_CLOUD_API_KEY';
const ACCEPTED: ModelConsent = { ...MLX_AUDIO_OFFER, accepted: true };

interface Step {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly serviceCopied: boolean;
}

const withDir = async (run: (dir: string) => Promise<void>): Promise<void> => {
  const dir = mkdtempSync(join(tmpdir(), 'rpg-mlx-install-'));
  try {
    await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const fakeRunner = (dir: string, fail?: (step: Step) => Error | undefined) => {
  const steps: Step[] = [];
  const run: StepRunner = async (command, args, options) => {
    const step = { command, args, env: options.env, serviceCopied: existsSync(mlxAudioPaths(dir).service) };
    steps.push(step);
    const error = fail?.(step);
    if (error) throw error;
    if (args.at(-1) === 'download') {
      const { python, weights } = mlxAudioPaths(dir);
      for (const file of [python, weights]) {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, '');
      }
    }
  };
  return { steps, run };
};

const installer = (dir: string, run: StepRunner, platform = 'darwin', arch = 'arm64') =>
  createMlxAudioInstaller({ dir, run, platform, arch });

test('offers the pinned packages and model with the measured install size', () => {
  assert.match(MLX_AUDIO_OFFER.source, /mlx-audio==0\.6\.4/);
  assert.match(MLX_AUDIO_OFFER.source, /mlx-community\/Kokoro-82M-bf16@a71e4d38b236d968966a2002c4c895dbd12b1c3c/);
  assert.equal(MLX_AUDIO_OFFER.sizeMiB, 1499);
});

test('installs nothing without consent for this exact offer', async () => {
  await withDir(async (dir) => {
    const { steps, run } = fakeRunner(dir);
    const install = installer(dir, run);
    await assert.rejects(install.install(undefined), /consent/);
    await assert.rejects(install.install({ ...ACCEPTED, bytes: 1 }), /consent/);
    assert.deepEqual(steps, []);
  });
});

test('installs nothing outside Apple Silicon Macs', async () => {
  await withDir(async (dir) => {
    const { steps, run } = fakeRunner(dir);
    const install = installer(dir, run, 'linux', 'x64');
    assert.deepEqual(await install.status(), { supported: false, installed: false });
    await assert.rejects(install.install(ACCEPTED), /Apple Silicon/);
    assert.deepEqual(steps, []);
  });
});

test('creates the venv, installs the pinned packages and downloads the pinned model with a minimal env', async () => {
  await withDir(async (dir) => {
    process.env[SECRET_ENV] = 'secret';
    try {
      const { steps, run } = fakeRunner(dir);
      const install = installer(dir, run);
      assert.deepEqual(await install.status(), { supported: true, installed: false });
      await install.install(ACCEPTED);
      const paths = mlxAudioPaths(dir);
      assert.deepEqual(
        steps.map(({ command, args }) => [command, ...args]),
        [
          ['uv', 'venv', '--no-config', '--allow-existing', '--python', '3.12', join(dir, 'venv')],
          [
            'uv',
            'pip',
            'install',
            '--no-config',
            '--default-index',
            'https://pypi.org/simple',
            '--python',
            paths.python,
            ...MLX_AUDIO_SPECS,
          ],
          [paths.python, '-I', paths.service, 'download'],
        ],
      );
      const download = steps[2] ?? assert.fail('no download step');
      assert.equal(download.serviceCopied, true);
      assert.equal(download.env.HF_HOME, paths.hfHome);
      for (const step of steps) assert.equal(step.env[SECRET_ENV], undefined);
      assert.equal(readFileSync(paths.service, 'utf8'), readFileSync(MLX_AUDIO_SERVICE_SOURCE, 'utf8'));
      assert.deepEqual(await install.status(), { supported: true, installed: true });
    } finally {
      delete process.env[SECRET_ENV];
    }
  });
});

test('tells the player plainly when uv is missing', async () => {
  await withDir(async (dir) => {
    const missing = Object.assign(new Error('spawn uv ENOENT'), { code: 'ENOENT' });
    const { run } = fakeRunner(dir, () => missing);
    await assert.rejects(installer(dir, run).install(ACCEPTED), /need uv/);
  });
});

test('a failed step stops the install and reports it', async () => {
  await withDir(async (dir) => {
    const { steps, run } = fakeRunner(dir, (step) =>
      step.args.includes('pip') ? new Error('No solution found') : undefined,
    );
    const install = installer(dir, run);
    await assert.rejects(install.install(ACCEPTED), /No solution found/);
    assert.equal(steps.length, 2);
    assert.equal((await install.status()).installed, false);
  });
});

test('remove deletes the venv and the model', async () => {
  await withDir(async (dir) => {
    const { run } = fakeRunner(dir);
    const install = installer(dir, run);
    await install.install(ACCEPTED);
    await install.remove();
    assert.equal(existsSync(dir), false);
    assert.equal((await install.status()).installed, false);
  });
});
