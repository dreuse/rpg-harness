import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { CHATTERBOX_MODEL_FILES, CHATTERBOX_SERVICE_SOURCE, chatterboxPaths } from './chatterbox-engine.ts';
import { CHATTERBOX_OFFER, CHATTERBOX_SPECS, createChatterboxInstaller } from './chatterbox-install.ts';
import type { ModelConsent, ModelFile } from './kokoro-model.ts';
import type { StepRunner } from './mlx-audio-install.ts';

const ACCEPTED: ModelConsent = { ...CHATTERBOX_OFFER, accepted: true };
const SECRET_ENV = 'RPG_VOICE_CLOUD_API_KEY';
const BYTES_PER_MIB = 1024 * 1024;
const GOOD = 'good model bytes';
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
const TINY_FILES: readonly ModelFile[] = [
  { path: 've.pt', sha256: sha256(GOOD), bytes: GOOD.length },
  { path: 'conds.pt', sha256: sha256(GOOD), bytes: GOOD.length },
];

const withDir = async (run: (dir: string) => Promise<void>): Promise<void> => {
  const dir = mkdtempSync(join(tmpdir(), 'rpg-chatterbox-install-'));
  try {
    await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

interface Step {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly serviceCopied: boolean;
}

const fakeRunner = (dir: string, content = GOOD, fail?: (step: Step) => Error | undefined) => {
  const steps: Step[] = [];
  const paths = chatterboxPaths(dir);
  const run: StepRunner = async (command, args, options) => {
    const step = { command, args, env: options.env, serviceCopied: existsSync(paths.service) };
    steps.push(step);
    const error = fail?.(step);
    if (error) throw error;
    if (args.at(-1) === 'download') {
      mkdirSync(dirname(paths.python), { recursive: true });
      writeFileSync(paths.python, '');
      mkdirSync(paths.modelDir, { recursive: true });
      for (const file of TINY_FILES) writeFileSync(join(paths.modelDir, file.path), content);
    }
  };
  return { steps, run };
};

const installer = (dir: string, run: StepRunner, platform = 'darwin', arch = 'arm64') =>
  createChatterboxInstaller({ dir, run, platform, arch, files: TINY_FILES });

test('offers the pinned package, model source and revision with the size of the real files plus the venv', () => {
  assert.match(CHATTERBOX_OFFER.source, /chatterbox-tts==0\.1\.7/);
  assert.match(CHATTERBOX_OFFER.source, /ResembleAI\/chatterbox@5bb1f6ee58e50c3b8d408bc82a6d3740c2db6e18/);
  const modelBytes = CHATTERBOX_MODEL_FILES.reduce((sum, file) => sum + file.bytes, 0);
  assert.ok(CHATTERBOX_OFFER.bytes > modelBytes);
  assert.equal(CHATTERBOX_OFFER.sizeMiB, Math.round(CHATTERBOX_OFFER.bytes / BYTES_PER_MIB));
});

test('installs nothing without consent for this exact offer or off Apple Silicon', async () => {
  await withDir(async (dir) => {
    const { steps, run } = fakeRunner(dir);
    await assert.rejects(installer(dir, run).install(undefined), /consent/);
    await assert.rejects(installer(dir, run).install({ ...ACCEPTED, bytes: 1 }), /consent/);
    const linux = installer(dir, run, 'linux', 'x64');
    assert.deepEqual(await linux.status(), { supported: false, installed: false });
    await assert.rejects(linux.install(ACCEPTED), /Apple Silicon/);
    assert.deepEqual(steps, []);
  });
});

test('creates the venv, installs the pins, downloads the pinned model and verifies every checksum', async () => {
  await withDir(async (dir) => {
    process.env[SECRET_ENV] = 'secret';
    try {
      const { steps, run } = fakeRunner(dir);
      const install = installer(dir, run);
      assert.deepEqual(await install.status(), { supported: true, installed: false });
      await install.install(ACCEPTED);
      const paths = chatterboxPaths(dir);
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
            ...CHATTERBOX_SPECS,
          ],
          [paths.python, '-I', paths.service, 'download'],
        ],
      );
      const download = steps[2] ?? assert.fail('no download step');
      assert.equal(download.serviceCopied, true);
      assert.equal(download.env.HF_HOME, paths.hfHome);
      assert.equal(download.env.RPG_CHATTERBOX_MODEL_DIR, paths.modelDir);
      for (const step of steps) assert.equal(step.env[SECRET_ENV], undefined);
      assert.equal(readFileSync(paths.service, 'utf8'), readFileSync(CHATTERBOX_SERVICE_SOURCE, 'utf8'));
      assert.deepEqual(await install.status(), { supported: true, installed: true });
    } finally {
      delete process.env[SECRET_ENV];
    }
  });
});

test('a model file with the wrong checksum is deleted, the install fails and the voice is not installed', async () => {
  await withDir(async (dir) => {
    const { run } = fakeRunner(dir, 'tampered model!');
    const install = installer(dir, run);
    await assert.rejects(install.install(ACCEPTED), /checksum mismatch: ve\.pt/);
    assert.equal(existsSync(join(chatterboxPaths(dir).modelDir, 've.pt')), false);
    assert.equal((await install.status()).installed, false);
  });
});

test('tells the player plainly when uv is missing and stops on a failed step', async () => {
  await withDir(async (dir) => {
    const missing = Object.assign(new Error('spawn uv ENOENT'), { code: 'ENOENT' });
    await assert.rejects(installer(dir, fakeRunner(dir, GOOD, () => missing).run).install(ACCEPTED), /need uv/);
    const { steps, run } = fakeRunner(dir, GOOD, (step) =>
      step.args.includes('pip') ? new Error('No solution found') : undefined,
    );
    await assert.rejects(installer(dir, run).install(ACCEPTED), /No solution found/);
    assert.equal(steps.length, 2);
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
