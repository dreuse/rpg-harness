import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import {
  createKokoroModelManager,
  KOKORO_MODEL_FILES,
  KOKORO_PT_BR_MODEL_OFFER,
  kokoroModelRoot,
  type ModelFile,
} from '../../../packages/voice/src/kokoro-model.ts';
import {
  createKokoroProvider,
  KOKORO_MODEL_MISSING_MESSAGE,
  KOKORO_ONNX_PROVIDER_ID,
  MLX_KOKORO_CAPABILITIES,
} from '../../../packages/voice/src/kokoro-provider.ts';
import { createVoiceHost, type HostedProvider, onnxProviders, type VoiceHost, voiceProviders } from './voice-host.ts';
import { createVoiceSetup, DEFAULT_SPEECH, type VoiceBridge } from './voice-setup.ts';

const PT_BR = 'pt-BR';
const NARRATOR = 'pf_dora';
const VOICE_PATH = `voices/${NARRATOR}.bin`;
const VOICE_BODY = new Uint8Array([7, 7, 7]);
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const SMALL_PACK: readonly ModelFile[] = [
  { path: 'config.json', sha256: sha(new Uint8Array([1])), bytes: 1 },
  { path: VOICE_PATH, sha256: sha(VOICE_BODY), bytes: VOICE_BODY.byteLength },
];
const WAV = new Uint8Array([1, 2, 3]);

const bridgeOf = (host: VoiceHost): VoiceBridge => ({
  check: () => host.check(),
  download: (providerId, consent) => host.download(providerId, consent, () => {}),
  remove: (providerId) => host.remove(providerId),
  preview: (request) => host.preview(request),
  clearCache: async () => host.clearCache(),
  playback: async () => true,
  diagnostics: async () => undefined,
  onProgress: () => {},
});

const controllerOf = (host: VoiceHost) =>
  createVoiceSetup({
    bridge: bridgeOf(host),
    audio: { play: async () => ({ decodeMs: 0 }) } as never,
    speech: DEFAULT_SPEECH,
    language: () => PT_BR,
    campaign: () => 'campaign',
    saveSpeech: () => {},
    setOutput: () => {},
    changed: () => {},
  });

const withDir = async (run: (dir: string) => Promise<void>) => {
  const dir = await mkdtemp(join(tmpdir(), 'rpg-base-pack-'));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

const installBasePack = async (dir: string) => {
  for (const file of KOKORO_MODEL_FILES) {
    const target = join(kokoroModelRoot(dir), file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, '');
    await truncate(target, file.bytes);
  }
};

const smallPackProvider = (dir: string, fetchFile?: typeof fetch): HostedProvider => {
  const model = createKokoroModelManager({
    dir,
    files: SMALL_PACK,
    ...(fetchFile === undefined ? {} : { fetch: fetchFile }),
  });
  const root = kokoroModelRoot(dir);
  return {
    id: KOKORO_ONNX_PROVIDER_ID,
    capabilities: MLX_KOKORO_CAPABILITIES,
    narrator: NARRATOR,
    model,
    provider: createKokoroProvider({
      id: KOKORO_ONNX_PROVIDER_ID,
      capabilities: MLX_KOKORO_CAPABILITIES,
      engine: {
        ready: () => SMALL_PACK.every((file) => existsSync(join(root, file.path))),
        load: async () => {},
        synthesize: async () => {
          if (!existsSync(join(root, VOICE_PATH))) throw new Error(`ENOENT ${VOICE_PATH}`);
          return WAV;
        },
        unload: async () => {},
      },
    }),
  };
};

const fakeFetch: typeof fetch = async (url) => {
  const path = String(url).split('/resolve/main/')[1] ?? String(url).split('/').slice(-2).join('/');
  const body = path.endsWith('.bin') ? VOICE_BODY : new Uint8Array([1]);
  return new Response(body);
};

test('rpg-cm63.74 a data dir with only the base pack offers the full pt-BR download, not a provider error', async () => {
  await withDir(async (dir) => {
    await installBasePack(dir);
    const host = createVoiceHost({ providers: onnxProviders(dir), cacheDir: join(dir, 'cache') });
    const [status] = (await host.check()).providers;
    assert.equal(status?.installed, false);
    assert.deepEqual(status?.offer, KOKORO_PT_BR_MODEL_OFFER);
    const controller = controllerOf(host);
    await controller.turnOn();
    const view = controller.view();
    assert.equal(view.step, 'consent');
    assert.equal(view.error, undefined);
    assert.equal(view.provider?.offer.bytes, KOKORO_PT_BR_MODEL_OFFER.bytes);
  });
});

test('rpg-cm63.74 after the missing voice files download the pt-BR narrator speaks', async () => {
  await withDir(async (dir) => {
    await mkdir(join(kokoroModelRoot(dir)), { recursive: true });
    await writeFile(join(kokoroModelRoot(dir), 'config.json'), new Uint8Array([1]));
    const host = createVoiceHost({
      providers: [smallPackProvider(dir, fakeFetch)],
      cacheDir: join(dir, 'cache'),
    });
    const controller = controllerOf(host);
    await controller.turnOn();
    assert.equal(controller.view().step, 'consent');
    await controller.accept();
    assert.equal(controller.view().step, 'ready');
    const audio = await host.preview({
      providerId: KOKORO_ONNX_PROVIDER_ID,
      voiceId: NARRATOR,
      language: PT_BR,
      speed: 1,
    });
    assert.ok(audio.chunks.length > 0);
  });
});

test('rpg-cm63.74 a missing voice file at speech time offers the download, never a voice engine error', async () => {
  await withDir(async (dir) => {
    const provider = smallPackProvider(dir);
    let status = true;
    const host = createVoiceHost({ providers: [provider], cacheDir: join(dir, 'cache') });
    const bridge: VoiceBridge = {
      ...bridgeOf(host),
      check: async () => {
        const checked = await host.check();
        return {
          ...checked,
          providers: checked.providers.map((entry) => ({ ...entry, installed: status })),
        };
      },
      preview: async (request) => {
        status = false;
        return host.preview(request);
      },
    };
    const controller = createVoiceSetup({
      bridge,
      audio: { play: async () => ({ decodeMs: 0 }) } as never,
      speech: DEFAULT_SPEECH,
      language: () => PT_BR,
      campaign: () => 'campaign',
      saveSpeech: () => {},
      setOutput: () => {},
      changed: () => {},
    });
    await mkdir(kokoroModelRoot(dir), { recursive: true });
    await writeFile(join(kokoroModelRoot(dir), 'config.json'), new Uint8Array([1]));
    await controller.turnOn();
    assert.equal(controller.view().step, 'consent');
    assert.equal(controller.view().error, undefined);
  });
});

test('rpg-cm63.74 the apple silicon route with a base-pack-only dir offers the mlx download', async () => {
  await withDir(async (dir) => {
    await installBasePack(join(dir, 'voice-models'));
    const host = createVoiceHost({ providers: voiceProviders({}, dir, true), cacheDir: join(dir, 'cache') });
    const controller = controllerOf(host);
    await controller.turnOn();
    assert.equal(controller.view().step, 'consent');
    assert.equal(controller.view().error, undefined);
  });
});

test('rpg-cm63.74 the onnx engine on a base-pack-only dir reports the model missing, not ENOENT', async () => {
  await withDir(async (dir) => {
    await installBasePack(dir);
    const host = createVoiceHost({ providers: voiceProviders({}, dir, false), cacheDir: join(dir, 'cache') });
    await assert.rejects(
      host.preview({ providerId: KOKORO_ONNX_PROVIDER_ID, voiceId: NARRATOR, language: PT_BR, speed: 1 }),
      { message: KOKORO_MODEL_MISSING_MESSAGE },
    );
  });
});

test('rpg-cm63.74 a download that leaves the model not installed fails instead of re-offering consent', async () => {
  await withDir(async (dir) => {
    await mkdir(kokoroModelRoot(dir), { recursive: true });
    const host = createVoiceHost({
      providers: [smallPackProvider(dir, (async () => new Response(new Uint8Array([9]))) as typeof fetch)],
      cacheDir: join(dir, 'cache'),
    });
    const controller = controllerOf(host);
    await controller.turnOn();
    await controller.accept();
    assert.equal(controller.view().step, 'failed');
    assert.equal(controller.view().error, 'provider-error');
  });
});

test('rpg-cm63.74 a failing status re-read keeps its error instead of going back to consent', async () => {
  await withDir(async (dir) => {
    const host = createVoiceHost({ providers: [smallPackProvider(dir)], cacheDir: join(dir, 'cache') });
    let checks = 0;
    const bridge: VoiceBridge = {
      ...bridgeOf(host),
      check: async () => {
        checks += 1;
        if (checks > 1) throw new Error('check failed');
        const checked = await host.check();
        return { ...checked, providers: checked.providers.map((entry) => ({ ...entry, installed: true })) };
      },
      preview: async () => {
        throw new Error('preview failed');
      },
    };
    const controller = createVoiceSetup({
      bridge,
      audio: { play: async () => ({ decodeMs: 0 }) } as never,
      speech: DEFAULT_SPEECH,
      language: () => PT_BR,
      campaign: () => 'campaign',
      saveSpeech: () => {},
      setOutput: () => {},
      changed: () => {},
    });
    await controller.turnOn();
    assert.equal(controller.view().step, 'failed');
    assert.equal(controller.view().error, 'provider-error');
  });
});
