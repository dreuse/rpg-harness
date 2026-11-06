import { join } from 'node:path';
import { KOKORO_MODEL_DIR_ENV } from '../../../packages/voice/src/kokoro-js-engine.ts';
import type { ModelFile } from '../../../packages/voice/src/kokoro-model.ts';
import { createKokoroModelManager, KOKORO_PT_BR_MODEL_FILES } from '../../../packages/voice/src/kokoro-model.ts';
import { DEFAULT_LOCALE, say } from './messages.ts';
import { VOICE_MODELS_DIR } from './speech-runtime.ts';

export interface VoiceModelRequest {
  readonly accept: boolean;
}

export interface VoiceModelDeps {
  readonly fetch?: typeof fetch;
  readonly files?: readonly ModelFile[];
  readonly locale?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export async function* voiceModelCommand(
  dataDir: string,
  request: VoiceModelRequest,
  {
    fetch: fetchFile,
    files = KOKORO_PT_BR_MODEL_FILES,
    locale = DEFAULT_LOCALE,
    env = process.env,
  }: VoiceModelDeps = {},
): AsyncGenerator<string> {
  const manager = createKokoroModelManager({
    dir: env[KOKORO_MODEL_DIR_ENV] || join(dataDir, VOICE_MODELS_DIR),
    files,
    ...(fetchFile === undefined ? {} : { fetch: fetchFile }),
  });
  if (request.accept) {
    await manager.download({ ...manager.offer, accepted: true });
    yield say(locale, 'voiceModel.downloaded');
  } else {
    const { sizeMiB, source } = manager.offer;
    yield say(locale, 'voiceModel.offer', { size: sizeMiB, source });
  }
  yield say(locale, (await manager.status()).installed ? 'voiceModel.installed' : 'voiceModel.missing');
}
