import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { F5_MODEL_FILES, F5_SERVICE_SOURCE, F5_WAIT_NOTE, f5Manifest, f5Paths } from './f5-tts-engine.ts';
import { createF5Installer, F5_OFFER, F5_SPECS } from './f5-tts-install.ts';
import { FLEURS_ARCHIVE_READ_LIMIT_BYTES } from './f5-voices.ts';
import type { ModelConsent, ModelFile } from './kokoro-model.ts';
import type { StepRunner } from './mlx-audio-install.ts';

const ACCEPTED: ModelConsent = { ...F5_OFFER, accepted: true };
const SECRET_ENV = 'RPG_VOICE_CLOUD_API_KEY';
const BYTES_PER_MIB = 1024 * 1024;
const GOOD = 'good model bytes';
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
const TINY_FILES: readonly ModelFile[] = [
  { path: 'acoustic/model.safetensors', sha256: sha256(GOOD), bytes: GOOD.length },
  { path: 'voices/f5-pt-f1.wav', sha256: sha256(GOOD), bytes: GOOD.length },
];

const withDir = async (run: (dir: string) => Promise<void>): Promise<void> => {
  const dir = mkdtempSync(join(tmpdir(), 'rpg-f5-install-'));
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
  readonly manifest: string | undefined;
}

const fakeRunner = (dir: string, content = GOOD, fail?: (step: Step) => Error | undefined) => {
  const steps: Step[] = [];
  const paths = f5Paths(dir, 'linux');
  const run: StepRunner = async (command, args, options) => {
    const step = {
      command,
      args,
      env: options.env,
      serviceCopied: existsSync(paths.service),
      manifest: existsSync(paths.manifest) ? readFileSync(paths.manifest, 'utf8') : undefined,
    };
    steps.push(step);
    const error = fail?.(step);
    if (error) throw error;
    if (args.at(-1) === 'download') {
      mkdirSync(dirname(paths.python), { recursive: true });
      writeFileSync(paths.python, '');
      for (const file of TINY_FILES) {
        mkdirSync(dirname(join(paths.modelDir, file.path)), { recursive: true });
        writeFileSync(join(paths.modelDir, file.path), content);
      }
    }
  };
  return { steps, run };
};

const installer = (dir: string, run: StepRunner, platform = 'linux') =>
  createF5Installer({ dir, run, platform, files: TINY_FILES });

test('offers the pinned package, model sources, licence and the size of every file plus the venv and clip archives', () => {
  assert.match(F5_OFFER.source, /f5-tts==/);
  assert.match(F5_OFFER.source, /CC-BY-NC-4\.0/);
  assert.match(F5_OFFER.source, /firstpixel\/F5-TTS-pt-br@5ebc6913f2d92e4c0cb5396a9867aa1c0c1c4281/);
  assert.match(F5_OFFER.source, /charactr\/vocos-mel-24khz@0feb3fdd929bcd6649e0e7c5a688cf7dd012ef21/);
  assert.match(F5_OFFER.source, /google\/fleurs@70bb2e84b976b7e960aa89f1c648e09c59f894dd/);
  assert.match(F5_OFFER.source, /CC-BY-4\.0/);
  assert.ok(F5_OFFER.source.includes(F5_WAIT_NOTE));
  assert.match(
    F5_OFFER.source,
    /Size measured on macOS only\. Linux and Windows downloads are larger, several GB more with CUDA\./,
  );
  assert.match(F5_OFFER.source, /charactr\/vocos-mel-24khz@[0-9a-f]{40} \(MIT\)/);
  const filesBytes = F5_MODEL_FILES.reduce((sum, file) => sum + file.bytes, 0);
  const archiveBytes = Object.values(FLEURS_ARCHIVE_READ_LIMIT_BYTES).reduce((sum, bytes) => sum + bytes, 0);
  assert.ok(F5_OFFER.bytes > filesBytes + archiveBytes);
  assert.equal(F5_OFFER.sizeMiB, Math.round(F5_OFFER.bytes / BYTES_PER_MIB));
});

test('the manifest lists each pinned download, each archive with a read limit and each voice', () => {
  const manifest = f5Manifest();
  assert.equal(manifest.downloads.length, 4);
  for (const item of manifest.downloads) assert.match(item.revision, /^[0-9a-f]{40}$/);
  assert.equal(manifest.archives.length, Object.keys(FLEURS_ARCHIVE_READ_LIMIT_BYTES).length);
  for (const archive of manifest.archives) {
    assert.match(archive.url, /^https:\/\/huggingface\.co\/datasets\/google\/fleurs\/resolve\/[0-9a-f]{40}\//);
    assert.ok(archive.maxBytes > 0 && archive.members.length > 0);
  }
  assert.equal(manifest.voices.length, 4);
});

test('installs nothing without consent for this exact offer or on an unknown platform', async () => {
  await withDir(async (dir) => {
    const { steps, run } = fakeRunner(dir);
    await assert.rejects(installer(dir, run).install(undefined), /consent/);
    await assert.rejects(installer(dir, run).install({ ...ACCEPTED, bytes: 1 }), /consent/);
    const plan9 = installer(dir, run, 'plan9');
    assert.deepEqual(await plan9.status(), { supported: false, installed: false });
    await assert.rejects(plan9.install(ACCEPTED), /macOS, Windows or Linux/);
    assert.deepEqual(steps, []);
  });
});

test('creates the venv, installs the pins, writes the manifest, downloads and verifies every checksum', async () => {
  await withDir(async (dir) => {
    process.env[SECRET_ENV] = 'secret';
    try {
      const { steps, run } = fakeRunner(dir);
      const install = installer(dir, run);
      assert.deepEqual(await install.status(), { supported: true, installed: false });
      await install.install(ACCEPTED);
      const paths = f5Paths(dir, 'linux');
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
            ...F5_SPECS,
          ],
          [paths.python, '-I', paths.service, 'download'],
        ],
      );
      const download = steps[2] ?? assert.fail('no download step');
      assert.equal(download.serviceCopied, true);
      assert.deepEqual(JSON.parse(download.manifest ?? 'null'), JSON.parse(JSON.stringify(f5Manifest())));
      assert.equal(download.env.HF_HOME, paths.hfHome);
      assert.equal(download.env.RPG_F5_MODEL_DIR, paths.modelDir);
      assert.equal(download.env.RPG_F5_MANIFEST, paths.manifest);
      for (const step of steps) assert.equal(step.env[SECRET_ENV], undefined);
      assert.equal(readFileSync(paths.service, 'utf8'), readFileSync(F5_SERVICE_SOURCE, 'utf8'));
      assert.deepEqual(await install.status(), { supported: true, installed: true });
    } finally {
      delete process.env[SECRET_ENV];
    }
  });
});

test('a file with the wrong checksum is deleted, the install fails and the voice is not installed', async () => {
  await withDir(async (dir) => {
    const { run } = fakeRunner(dir, 'tampered model!');
    const install = installer(dir, run);
    await assert.rejects(install.install(ACCEPTED), /checksum mismatch: acoustic\/model\.safetensors/);
    assert.equal(existsSync(join(f5Paths(dir, 'linux').modelDir, 'acoustic/model.safetensors')), false);
    assert.equal((await install.status()).installed, false);
  });
});

test('tells the player plainly when uv is missing and stops on a failed step', async () => {
  await withDir(async (dir) => {
    const missing = Object.assign(new Error('spawn uv ENOENT'), { code: 'ENOENT' });
    await assert.rejects(installer(dir, fakeRunner(dir, GOOD, () => missing).run).install(ACCEPTED), /needs uv/);
    const { steps, run } = fakeRunner(dir, GOOD, (step) =>
      step.args.includes('pip') ? new Error('No solution found') : undefined,
    );
    await assert.rejects(installer(dir, run).install(ACCEPTED), /No solution found/);
    assert.equal(steps.length, 2);
  });
});

test('remove deletes the venv, the models and the clips', async () => {
  await withDir(async (dir) => {
    const { run } = fakeRunner(dir);
    const install = installer(dir, run);
    await install.install(ACCEPTED);
    await install.remove();
    assert.equal(existsSync(dir), false);
    assert.equal((await install.status()).installed, false);
  });
});
